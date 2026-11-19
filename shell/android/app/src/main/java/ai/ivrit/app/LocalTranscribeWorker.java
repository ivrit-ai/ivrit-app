package ai.ivrit.app;

import android.content.Context;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.ForegroundInfo;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineRecognizerResult;
import com.k2fsa.sherpa.onnx.OnlineStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.zip.GZIPOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A recording transcribed on the phone, in Hebrew, with the app closed if need be:
 * the on-device model (LocalModel, downloaded the first time) over the recording
 * decoded by the phone (AudioDecoder), into sentences with word times (Segments),
 * then saved to the user's My files like any other transcript (POST /appdata/local,
 * signed in with the app's own session). The recording itself leaves the phone only
 * if the user keeps the audio, for playback in their Drive.
 *
 * Each recording is its own work (stopping one leaves the others), and they take
 * turns (TURN): one at a time, as the model is large. It runs in the foreground with a
 * notification showing how far it got and a way to stop it, and tells the page as
 * it goes ("localTranscription" events) so My files shows it too.
 *
 * Where a recording comes from: a file shared into the app ("share"), a new file in
 * a watched folder ("watch"), or one picked in the app and handed over ("staged").
 *
 * With ivrit.ai's Turbo model, when the user chose it (Turbo), the recording goes
 * through whisper.cpp a few minutes at a time instead, on the GPU where it passed
 * its check on this phone (TurboGpu), and comes out cut, timed and with speakers as
 * the server's transcripts are (TurboTranscript, Speakers); how long it took is
 * reported to the site (POST /lab/report?kind=local-turbo), to see how phones fare.
 */
public class LocalTranscribeWorker extends Worker {
    private static final String TAG = "IvritLocal";
    private static final double BLOCK_SECONDS = 4;
    // One recording through the model at a time; the others wait their turn.
    // (PrepareWorker takes it too: the model is one recording's, or getting ready, at a time.)
    static final java.util.concurrent.Semaphore TURN = new java.util.concurrent.Semaphore(1, true);

    public LocalTranscribeWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /**
     * One more recording, after those already waiting. While the Turbo model is not
     * downloaded yet (874 MB), it waits for Wi-Fi (an unmetered network) to fetch it,
     * and pauses there if Wi-Fi goes, to resume the download where it stopped. A
     * watched folder's file ("charging": its watch's chargingOnly) waits for the
     * charger, and pauses if it is unplugged; what the user asked for starts at once.
     */
    static void enqueue(Context context, Data input) {
        String variant = Turbo.chosen(context);
        boolean benchmark = "benchmark".equals(input.getString("kind"));
        boolean download = !benchmark && variant != null && !Turbo.ready(context, variant);
        if (!benchmark) {
            // This phone transcribes recordings: from now on Turbo is made ready ahead (PrepareWorker).
            Store.setUsedOnDevice(context);
            PrepareWorker.schedule(context);
        }
        OneTimeWorkRequest.Builder builder = new OneTimeWorkRequest.Builder(LocalTranscribeWorker.class)
            .setInputData(input)
            .addTag("local:" + input.getString("key"))
            .addTag("watch:" + (input.getString("watchId") == null ? "" : input.getString("watchId")))
            // Waiting its turn is a retry: looked at again every 20 seconds.
            .setBackoffCriteria(androidx.work.BackoffPolicy.LINEAR, 20, java.util.concurrent.TimeUnit.SECONDS);
        boolean charging = input.getBoolean("charging", false);
        if (download || charging) {
            androidx.work.Constraints.Builder constraints = new androidx.work.Constraints.Builder();
            if (download) constraints.setRequiredNetworkType(androidx.work.NetworkType.UNMETERED);
            if (charging) constraints.setRequiresCharging(true);
            builder.setConstraints(constraints.build());
        }
        WorkManager.getInstance(context).enqueueUniqueWork("local-" + input.getString("key"), ExistingWorkPolicy.KEEP, builder.build());
        if (benchmark) IvritNativePlugin.benchmark(input.getString("key"), "queued", 0, null, null);
        else IvritNativePlugin.localTranscription(input.getString("key"), input.getString("name"), input.getString("folder"),
            charging && !Store.charging(context) ? "charging" : download && !Store.unmetered(context) ? "wifi" : "queued", 0, null, null);
    }

    static Data.Builder input(String kind, String key, String source, String name, String type, String folder, boolean saveAudio, String origin) {
        return new Data.Builder()
            .putString("kind", kind)
            .putString("key", key)
            .putString("source", source)
            .putString("name", name)
            .putString("type", type == null ? "application/octet-stream" : type)
            .putString("folder", folder == null ? "" : folder)
            .putBoolean("saveAudio", saveAudio)
            .putString("origin", origin == null ? "" : origin);
    }

    // --- the work ----------------------------------------------------------------

    private String key;
    private String name;
    private String folder;
    private long told;
    private String engine = LocalModel.ENGINE;
    // A benchmark's (Benchmark) result as it is made, and each stage's milliseconds; null otherwise.
    private JSONObject bench;
    private long tuneMs, transcribeMs, printsMs;
    // The Turbo model while it is loaded, so stopping the work stops it (onStopped).
    private long turbo;

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        Data input = getInputData();
        key = input.getString("key");
        name = input.getString("name");
        folder = input.getString("folder");
        String kind = input.getString("kind");
        // A benchmark's recording comes with it (Benchmark), once Turbo is there.
        Uri source = "benchmark".equals(kind) ? Uri.EMPTY : sourceUri(input.getString("source"));
        if (source == null) return done(kind, input, null, "gone");
        if ("watch".equals(kind)) {
            // Its watch removed meanwhile, or its folder no longer open to the app (the
            // watch's card says so, and how to mend it): nothing to tell for each file.
            if (Watches.find(context, input.getString("watchId")) == null) return done(kind, input, null, "gone");
            if (!readable(context, source)) return done(kind, input, null, "access");
        }
        // Another recording has the model: this one waits its turn, without holding
        // one of WorkManager's few threads (uploads and folder checks need them).
        if (!TURN.tryAcquire()) {
            tell(kind, "queued", 0, null, null);
            return Result.retry();
        }
        try {
            return transcribeNow(context, kind, input, source);
        } finally {
            TURN.release();
        }
    }

    private Result transcribeNow(Context context, String kind, Data input, Uri source) {
        try {
            setForegroundAsync(foreground(-1, null, null));
        } catch (Exception e) {
            Log.w(TAG, "could not run in the foreground", e);
        }
        try {
            String variant = Turbo.chosen(context);
            boolean benchmark = "benchmark".equals(kind);
            if (benchmark && variant == null) return done(kind, input, null, "unsupported");
            if (benchmark) bench = new JSONObject();
            if (variant != null) {
                engine = Turbo.engine(variant);
                Turbo.ensure(context, variant, (done, total) -> progress("downloading", done / (double) Math.max(1, total), null));
            } else {
                LocalModel.ensure(context, (done, total) -> progress("model", done / (double) Math.max(1, total), null));
            }
            if (benchmark) source = Uri.fromFile(Benchmark.ensure(context, (done, total) -> progress("downloading", done / (double) Math.max(1, total), null)));
            double duration = AudioDecoder.duration(context, source);
            // A benchmark measures the phone, so it runs at normal priority (asked for, and
            // watched); a recording yields to whatever the phone is doing.
            if (benchmark) bench.put("conditions", new JSONObject().put("start", Benchmark.conditions(context)));
            JSONArray segments = variant == null ? transcribe(context, source, duration)
                : benchmark ? transcribeTurbo(context, kind, source, duration, variant)
                : turboYielding(context, kind, source, duration, variant);
            if (benchmark) bench.getJSONObject("conditions").put("end", Benchmark.conditions(context));
            if (isStopped()) return Result.success();
            if (benchmark) {
                StringBuilder text = new StringBuilder();
                for (int i = 0; i < segments.length(); i++) text.append(segments.getJSONObject(i).optString("text")).append(' ');
                bench.put("transcript", text.toString().trim())
                    .put("segments", segments.length())
                    .put("device", Benchmark.device(context))
                    .put("app", appVersion(context))
                    .put("engine", engine)
                    .put("audioSeconds", duration);
                return done(kind, input, "benchmark", null);
            }
            progress("saving", 1, null);
            String resultsId;
            try {
                resultsId = save(context, input, source, segments, duration, input.getBoolean("saveAudio", true));
            } catch (Refused e) {
                if (!DRIVE_FULL.equals(e.getMessage())) throw e;
                resultsId = saveWithoutRoom(context, input, source, segments, duration);
            }
            Notifications.showLocalReady(context, key, name, resultsId, folder);
            return done(kind, input, resultsId, null);
        } catch (AudioDecoder.NoAudio e) {
            return done(kind, input, null, "unsupported");
        } catch (Refused e) {
            return done(kind, input, null, e.getMessage());
        } catch (Exception | LinkageError e) {
            if (isStopped()) return Result.success();
            Log.w(TAG, "transcribing on the phone failed", e);
            report(context, kind, e);
            if (failures(context, key, 1) < 2 && e instanceof Exception) return Result.retry();
            String detail = e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage());
            return done(kind, input, null, detail.length() > 200 ? detail.substring(0, 200) : detail);
        }
    }

    /**
     * The app may still read it: MediaExtractor hides a refusal behind "Failed to
     * instantiate extractor". Anything else (gone, say) is left to the transcription.
     */
    private static boolean readable(Context context, Uri uri) {
        try (android.os.ParcelFileDescriptor ignored = context.getContentResolver().openFileDescriptor(uri, "r")) {
            return true;
        } catch (SecurityException e) {
            return false;
        } catch (Exception e) {
            return true;
        }
    }

    /** This recording's failures so far, after adding `add` (cleared when it is done). */
    private static synchronized int failures(Context context, String key, int add) {
        android.content.SharedPreferences prefs = context.getSharedPreferences("ivrit_local", Context.MODE_PRIVATE);
        int n = prefs.getInt("failures:" + key, 0) + add;
        if (add == 0 && n == 0) return 0;
        if (add < 0) prefs.edit().remove("failures:" + key).apply();
        else prefs.edit().putInt("failures:" + key, n).apply();
        return n;
    }

    /** What went wrong, to the site's log (POST /lab/report), so a failure on a phone can be seen. */
    private void report(Context context, String kind, Throwable e) {
        try {
            java.io.StringWriter trace = new java.io.StringWriter();
            e.printStackTrace(new java.io.PrintWriter(trace));
            String stack = trace.toString();
            post(context, "local-native", new JSONObject()
                .put("kind", kind)
                .put("engine", engine)
                .put("error", e.toString())
                .put("stack", stack.length() > 4000 ? stack.substring(0, 4000) : stack)
                .put("attempt", getRunAttemptCount()));
        } catch (Exception ignored) {
            // Only the report is lost.
        }
    }

    /** To the site's log (POST /lab/report?kind=…), with the phone and the app it came from. */
    static void post(Context context, String kind, JSONObject body) {
        HttpURLConnection connection = null;
        try {
            body.put("sdk", Build.VERSION.SDK_INT)
                .put("device", Build.MANUFACTURER + " " + Build.MODEL)
                .put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "")
                .put("app", appVersion(context));
            connection = (HttpURLConnection) new URL(Store.site(context) + "/lab/report?kind=" + kind).openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            connection.getResponseCode();
        } catch (Exception ignored) {
            // Only the report is lost.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String appVersion(Context context) {
        try {
            android.content.pm.PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            return info.versionName + " (" + code + ")";
        } catch (Exception e) {
            return "";
        }
    }

    private Uri sourceUri(String source) {
        if (source == null || source.isEmpty()) return null;
        if (source.startsWith("content://") || source.startsWith("file://")) return Uri.parse(source);
        File file = new File(source);
        return file.isFile() ? Uri.fromFile(file) : null;
    }

    private JSONArray transcribe(Context context, Uri source, double duration) throws Exception {
        OnlineRecognizer recognizer = LocalModel.recognizer(context);
        // Resumed where an earlier run stopped (the phone stopped it, or a background
        // run's 10 minutes ran out): its words so far, and where to go on from.
        Checkpoint kept = Checkpoint.load(context, key);
        Checkpoint done = LocalModel.ENGINE.equals(kept.engine) ? kept : new Checkpoint();
        OnlineStream stream = recognizer.createStream("");
        long started = System.currentTimeMillis();
        double from = done.offset;
        try {
            float[][] pending = {new float[0]};
            int[] rate = {16000};
            double[] saved = {from};
            AudioDecoder.decode(context, source, from, (samples, sampleRate, at) -> {
                if (isStopped()) throw new InterruptedException("stopped");
                rate[0] = sampleRate;
                // In blocks of a few seconds, so progress moves and memory stays small.
                float[] merged = new float[pending[0].length + samples.length];
                System.arraycopy(pending[0], 0, merged, 0, pending[0].length);
                System.arraycopy(samples, 0, merged, pending[0].length, samples.length);
                if (merged.length < BLOCK_SECONDS * sampleRate) {
                    pending[0] = merged;
                    return;
                }
                pending[0] = new float[0];
                stream.acceptWaveform(merged, sampleRate);
                while (recognizer.isReady(stream)) recognizer.decode(stream);
                if (at - saved[0] >= Checkpoint.EVERY_SECONDS) {
                    saved[0] = at;
                    Checkpoint.save(context, key, done, recognizer.getResult(stream), from, at);
                }
                if (duration > 0) {
                    double fraction = Math.min(1, at / duration);
                    double spent = (System.currentTimeMillis() - started) / 1000.0;
                    double share = fraction - from / duration;
                    Double left = share > 0.03 ? spent * (1 - fraction) / share : null;
                    progress("transcribing", fraction, left);
                }
            });
            if (pending[0].length > 0) stream.acceptWaveform(pending[0], rate[0]);
            // The tail, padded with silence (at the same rate) so its last words are decoded.
            stream.acceptWaveform(new float[rate[0] * 3 / 2], rate[0]);
            stream.inputFinished();
            while (recognizer.isReady(stream)) recognizer.decode(stream);
            OnlineRecognizerResult result = recognizer.getResult(stream);
            Checkpoint all = done.plus(result, from);
            return Segments.segments(all.pieces(), all.times());
        } finally {
            stream.release();
        }
    }

    @Override
    public void onStopped() {
        synchronized (this) {
            if (turbo != 0) Whisper.stop(turbo);
        }
    }

    /** Sound waiting for the Turbo model: 16 kHz, from `start` seconds into the file. */
    private static final class Sound {
        float[] samples = new float[Resampler.RATE * 60];
        int length;
        double start = -1;
        Resampler resampler;

        void add(float[] more) {
            if (length + more.length > samples.length) samples = java.util.Arrays.copyOf(samples, Math.max(2 * samples.length, length + more.length));
            System.arraycopy(more, 0, samples, length, more.length);
            length += more.length;
        }

        double seconds() {
            return length / (double) Resampler.RATE;
        }

        /** Lets go of the sound before `at` seconds into the file. */
        void keepFrom(double at) {
            int drop = (int) Math.max(0, Math.min(length, Math.round((at - start) * Resampler.RATE)));
            System.arraycopy(samples, drop, samples, 0, length - drop);
            length -= drop;
            start += drop / (double) Resampler.RATE;
        }
    }

    /**
     * The whole file's 16 kHz sample count, loudness level (Whisper.levelEnd) and
     * where its sound starts (seconds), decoded once before transcribing: stable-ts
     * finds silence against the whole file's loudest moment and over its length,
     * which the pieces alone cannot tell. {0, 0, 0} where it fits in one piece (no
     * need) or they cannot be told (the duration unknown, the file far longer than it
     * said).
     */
    private double[] fileLevel(Context context, Uri source, double duration) throws Exception {
        double[] none = {0, 0, 0};
        // A recording heard in one piece finds silence over all of it anyway: the same
        // as this read would give (stablets' tests), without reading it twice.
        if (duration <= 0 || duration < Turbo.CHUNK_SECONDS - 30) return none;
        long handle = Whisper.levelNew((long) (duration * Resampler.RATE));
        if (handle == 0) return none;
        double[] origin = {-1};
        Resampler[] resampler = {null};
        double[] level;
        try {
            AudioDecoder.decode(context, source, 0, (samples, sampleRate, at) -> {
                if (isStopped()) throw new InterruptedException("stopped");
                if (origin[0] < 0) origin[0] = at - samples.length / (double) sampleRate;
                if (resampler[0] == null || resampler[0].from != sampleRate) {
                    if (resampler[0] != null) addLevel(handle, resampler[0].flush());
                    resampler[0] = new Resampler(sampleRate);
                }
                addLevel(handle, resampler[0].push(samples));
                progress("preparing", Math.min(0.99, at / duration), null);
            });
            if (resampler[0] != null) addLevel(handle, resampler[0].flush());
        } finally {
            level = Whisper.levelEnd(handle); // frees it, read through or not
        }
        return level == null ? none : new double[] {level[0], level[1], origin[0]};
    }

    private static void addLevel(long handle, float[] samples) {
        if (samples.length > 0) Whisper.levelAdd(handle, samples, samples.length);
    }

    /**
     * transcribeTurbo below whatever the phone is doing: this thread, and the ones
     * whisper.cpp starts from it (which take its priority), just short of background
     * priority, from which Android may keep them to the slow cores. Idle, the
     * phone gives them all it has; in use, it stays responsive.
     */
    private JSONArray turboYielding(Context context, String kind, Uri source, double duration, String variant) throws Exception {
        int priority = Process.getThreadPriority(Process.myTid());
        Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND + Process.THREAD_PRIORITY_MORE_FAVORABLE);
        try {
            return transcribeTurbo(context, kind, source, duration, variant);
        } finally {
            Process.setThreadPriority(priority);
        }
    }

    private JSONArray transcribeTurbo(Context context, String kind, Uri source, double duration, String variant) throws Exception {
        // Resumed where an earlier run's last checkpoint left off, as transcribe() is.
        Checkpoint kept = Checkpoint.load(context, key);
        Checkpoint done = engine.equals(kept.engine) && kept.turbo != null ? kept : new Checkpoint();
        List<TurboTranscript.Segment> segments = TurboTranscript.load(done.turbo);
        double from = done.offset;
        int[] prompt = done.turbo != null ? done.prompt : Whisper.prompt();
        // The whole file's length and loudness, read once (and kept in the checkpoint).
        long preparing = System.currentTimeMillis();
        double[] file = done.turbo != null && done.samples > 0 ? new double[] {done.samples, done.level, done.origin}
            : fileLevel(context, source, duration);
        long prepareMs = System.currentTimeMillis() - preparing;
        long checking = System.currentTimeMillis();
        double[] state = {done.turbo != null ? done.lastSpeech : from, done.after, from, file[0], file[1], file[2]};
        // On the GPU where it passed its check on this phone (TurboGpu), once checked.
        String processor = Store.turboProcessor(context);
        // The Lab's WebGPU trial: no check, the encoder on WebGPU where it can run (TurboGpu.trial).
        boolean trial = TurboGpu.TRIAL.equals(processor);
        TurboGpu.Verdict verdict = trial ? TurboGpu.trial(context, variant)
            : TurboGpu.decide(context, variant, processor, fraction -> progress("checking", fraction, null));
        long checkMs = System.currentTimeMillis() - checking;
        boolean gpu = trial ? "trial".equals(verdict.state) : TurboGpu.onGpu(verdict, processor);
        long loading = System.currentTimeMillis();
        String path = Turbo.file(context, variant).getPath();
        int device = gpu ? TurboGpu.device(verdict) : -1;
        if (device < 0) gpu = false;
        if (gpu) TurboGpu.log(context);
        long loaded = Whisper.load(path, device, !gpu || verdict.level().flash, gpu && verdict.decoderCpu);
        if (loaded == 0 && gpu) {
            gpu = false; // no room on the GPU: the CPU, then
            loaded = Whisper.load(path, -1, true, false);
        }
        // The decoder's threads as tuned on this phone; tuned on the first piece if not yet.
        int[] decodeThreads = {verdict.decodeThreads};
        // A GPU run's pieces are watched for a hang (TurboGpu.Watchdog); the trial's
        // waits end in a failure of their own (ggml-webgpu-phones.patch).
        TurboGpu.Verdict watch = gpu && !trial ? verdict : null;
        // Checked when it downloaded: not loading is the phone short of memory.
        if (loaded == 0) throw new IllegalStateException("the Turbo model did not load");
        long handle = loaded;
        synchronized (this) {
            turbo = handle;
        }
        if (gpu && trial) TurboGpu.trialStarted(context);
        else if (gpu) TurboGpu.started(context);
        // Speakers too, as the server tells them, where the speaker model came.
        final long speakers = speakerModel(context);
        long started = System.currentTimeMillis();
        int threads = Turbo.threads();
        try {
            Sound sound = new Sound();
            AudioDecoder.decode(context, source, from, (samples, sampleRate, at) -> {
                if (isStopped()) throw new InterruptedException("stopped");
                // A resumed run's decoding starts a little before where it left off.
                double blockStart = at - samples.length / (double) sampleRate;
                if (blockStart < from) {
                    int skip = (int) Math.min(samples.length, Math.round((from - blockStart) * sampleRate));
                    samples = java.util.Arrays.copyOfRange(samples, skip, samples.length);
                    blockStart = at - samples.length / (double) sampleRate;
                    if (samples.length == 0) return;
                }
                if (sound.start < 0) sound.start = blockStart;
                if (sound.resampler == null || sound.resampler.from != sampleRate) {
                    if (sound.resampler != null) sound.add(sound.resampler.flush());
                    sound.resampler = new Resampler(sampleRate);
                }
                sound.add(sound.resampler.push(samples));
                if (sound.seconds() >= Turbo.CHUNK_SECONDS) hearTurbo(context, handle, speakers, threads, decodeThreads, sound, segments, state, prompt, false, duration, from, started, variant, watch);
            });
            if (sound.resampler != null) sound.add(sound.resampler.flush());
            if (sound.start < 0) sound.start = from;
            hearTurbo(context, handle, speakers, threads, decodeThreads, sound, segments, state, prompt, true, duration, from, started, variant, watch);
        } catch (IllegalStateException e) {
            // ggml failing on the GPU (guard.cpp): the next level next time; this
            // recording again, from its last checkpoint, on the CPU (retried).
            if (gpu && !isStopped()) {
                if (trial) TurboGpu.trialFailed(context, variant, e.getMessage());
                else TurboGpu.failed(context, variant, e.getMessage());
                gpu = false;
            }
            throw e;
        } finally {
            synchronized (this) {
                turbo = 0;
                Whisper.free(handle);
            }
            Speakers.free(speakers);
            if (gpu && trial) TurboGpu.trialFinished(context);
            else if (gpu) TurboGpu.finished(context);
        }
        double heard = duration > 0 ? duration - from : 0;
        double took = (System.currentTimeMillis() - started) / 1000.0;
        JSONObject run = new JSONObject()
            .put("kind", kind)
            .put("engine", engine)
            .put("seconds", heard)
            .put("took", took)
            .put("realtime", took > 0 ? heard / took : null)
            .put("load", (started - loading) / 1000.0)
            .put("resumedAt", from)
            .put("processor", gpu ? "gpu" : "cpu")
            .put("backend", gpu ? verdict.level().backend : "")
            .put("level", verdict.level)
            .put("chose", processor)
            .put("gpu", verdict.gpu)
            .put("gpuCheck", verdict.state == null ? JSONObject.NULL : verdict.state)
            .put("threads", threads)
            .put("cores", Runtime.getRuntime().availableProcessors())
            .put("memory", Turbo.memory(context))
            .put("beams", Turbo.beams(gpu))
            .put("decodeThreads", decodeThreads[0])
            .put("decoderCpu", gpu && verdict.decoderCpu)
            .put("speakers", speakers != 0)
            .put("system", Whisper.system());
        post(context, "local-turbo", run);
        // Who speaks when, over the whole recording at once: the last step, told as its own.
        int[] labels = null;
        long clustering = System.currentTimeMillis();
        if (speakers != 0 && !segments.isEmpty()) {
            progress("speakers", 0, null);
            labels = TurboTranscript.speakers(segments, percent -> progress("speakers", percent / 100.0, null));
        }
        long clusterMs = System.currentTimeMillis() - clustering;
        if (bench != null) {
            java.util.Set<Integer> found = new java.util.HashSet<>();
            if (labels != null) for (int label : labels) if (label >= 0) found.add(label);
            // The stages, seconds: the run itself (prepare to speakers), and what only a
            // phone's first run pays (the GPU check, tuning the decoder's threads).
            bench.put("run", run)
                .put("speakersFound", found.size())
                .put("stages", new JSONObject()
                    .put("prepare", prepareMs / 1000.0)
                    .put("load", (started - loading) / 1000.0)
                    .put("transcribe", (transcribeMs - tuneMs) / 1000.0)
                    .put("prints", printsMs / 1000.0)
                    .put("cluster", clusterMs / 1000.0)
                    .put("check", checkMs / 1000.0)
                    .put("tune", tuneMs / 1000.0))
                .put("seconds", (prepareMs + (started - loading) + transcribeMs - tuneMs + printsMs + clusterMs) / 1000.0);
        }
        return TurboTranscript.json(segments, labels);
    }

    /** The speaker model loaded (Speakers), downloaded first if need be; 0 when it is not to be had. */
    private long speakerModel(Context context) {
        try {
            Speakers.ensure(context, (got, total) -> progress("downloading", got / (double) Math.max(1, total), null));
            return Speakers.load(Speakers.path(context), Turbo.threads());
        } catch (Exception e) {
            Log.w(TAG, "no speaker model: transcribing without speakers", e);
            return 0;
        }
    }

    /**
     * The sound so far through the Turbo model, keeping what may be cut off for next
     * time; each new segment's voice print taken while its sound is here.
     */
    private void hearTurbo(Context context, long handle, long speakers, int threads, int[] decodeThreads, Sound sound,
                           List<TurboTranscript.Segment> segments,
                           double[] state, int[] prompt, boolean last, double duration, double from, long started, String variant,
                           TurboGpu.Verdict watch) throws Exception {
        if (isStopped()) throw new InterruptedException("stopped");
        if (sound.length < Resampler.RATE / 10) return; // nothing to speak of
        double start = sound.start;
        double seconds = sound.seconds();
        if (decodeThreads[0] <= 0) {
            long tuning = System.currentTimeMillis();
            decodeThreads[0] = Whisper.tuneDecoder(handle, sound.samples, sound.length, threads);
            tuneMs += System.currentTimeMillis() - tuning;
            if (decodeThreads[0] > 0) TurboGpu.tuned(context, variant, decodeThreads[0]);
        }
        Object[] heard;
        long transcribing = System.currentTimeMillis();
        // On the GPU: a piece taking over twice its length (plus two minutes) has hung.
        try (TurboGpu.Watchdog ignored = watch == null ? null
                : new TurboGpu.Watchdog(context, variant, watch, "run", (long) (2000 * seconds) + 120_000)) {
            heard = Whisper.transcribe(handle, java.util.Arrays.copyOf(sound.samples, sound.length), Turbo.LANGUAGE, threads, decodeThreads[0], Turbo.beams(watch != null), percent -> {
                if (duration <= 0) return;
                double fraction = Math.min(1, (start + seconds * percent / 100.0) / duration);
                double spent = (System.currentTimeMillis() - started) / 1000.0;
                double share = fraction - from / duration;
                progress("transcribing", fraction, share > 0.03 ? spent * (1 - fraction) / share : null);
            }, start, last, state, prompt);
        }
        transcribeMs += System.currentTimeMillis() - transcribing;
        if (heard == null) throw new InterruptedException("stopped");
        List<TurboTranscript.Segment> piece = TurboTranscript.piece(heard);
        long printing = System.currentTimeMillis();
        if (speakers != 0 && !piece.isEmpty()) {
            if (isStopped()) throw new InterruptedException("stopped");
            double[] starts = new double[piece.size()], ends = new double[piece.size()];
            for (int i = 0; i < starts.length; i++) {
                starts[i] = piece.get(i).start();
                ends[i] = piece.get(i).end();
            }
            float[] prints = Speakers.prints(speakers, sound.samples, sound.length, sound.start, starts, ends);
            for (int i = 0; i < starts.length; i++) {
                if (!Float.isNaN(prints[i * 192])) piece.get(i).print = java.util.Arrays.copyOfRange(prints, i * 192, (i + 1) * 192);
            }
        }
        printsMs += System.currentTimeMillis() - printing;
        segments.addAll(piece);
        sound.keepFrom(state[2]);
        if (!last) Checkpoint.saveTurbo(context, key, engine, TurboTranscript.save(segments), state[2], state[0], state[1], prompt,
            new double[] {state[3], state[4], state[5]});
    }

    /** The server's refusal, worth showing as is. */
    private static final class Refused extends Exception {
        Refused(String why) {
            super(why);
        }
    }

    static final String DRIVE_FULL = "errorDriveStorageFull";
    /** Drive was full even for the text, which waits in the phone's Downloads instead. */
    static final String DRIVE_FULL_KEPT = "driveFullKept";

    /**
     * The user's Drive is full. The words matter more than the recording and take
     * almost no room: without the recording, then, failing that, the text into the
     * phone's Downloads, so the work is never lost.
     */
    private String saveWithoutRoom(Context context, Data input, Uri source, JSONArray segments, double duration) throws Exception {
        if (input.getBoolean("saveAudio", true)) {
            try {
                return save(context, input, source, segments, duration, false);
            } catch (Refused e) {
                if (!DRIVE_FULL.equals(e.getMessage())) throw e;
            }
        }
        if (!Downloads.available()) throw new Refused(DRIVE_FULL);
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < segments.length(); i++) {
            String line = segments.getJSONObject(i).optString("text").trim();
            if (!line.isEmpty()) text.append(line).append('\n');
        }
        String base = name.replaceFirst("\\.[^.]{1,5}$", "");
        Downloads.save(context, base + ".txt", "text/plain", new java.io.ByteArrayInputStream(text.toString().getBytes(StandardCharsets.UTF_8)));
        throw new Refused(DRIVE_FULL_KEPT);
    }

    private String save(Context context, Data input, Uri source, JSONArray segments, double duration, boolean withAudio) throws Exception {
        String token = Store.appToken(context);
        if (token.isEmpty()) throw new Refused("signin");
        String site = Store.site(context);
        JSONObject meta = new JSONObject()
            .put("filename", name)
            .put("language", "he")
            .put("duration_seconds", duration)
            .put("folder", folder == null ? "" : folder)
            .put("origin", input.getString("origin"))
            .put("engine", engine);
        ByteArrayOutputStream packed = new ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new GZIPOutputStream(packed)) {
            gzip.write(segments.toString().getBytes(StandardCharsets.UTF_8));
        }
        String boundary = "----ivrit" + UUID.randomUUID().toString().replace("-", "");
        HttpURLConnection connection = (HttpURLConnection) new URL(site + "/appdata/local").openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(10 * 60 * 1000);
            connection.setChunkedStreamingMode(64 * 1024);
            connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Origin", site);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"meta\"\r\n\r\n" + meta + "\r\n")
                    .getBytes(StandardCharsets.UTF_8));
                out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"results\"; filename=\"results.json.gz\"\r\n"
                    + "Content-Type: application/gzip\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                packed.writeTo(out);
                out.write("\r\n".getBytes(StandardCharsets.UTF_8));
                if (withAudio) {
                    out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"audio\"; filename=\""
                        + name.replace("\"", "'") + "\"\r\nContent-Type: " + input.getString("type") + "\r\n\r\n")
                        .getBytes(StandardCharsets.UTF_8));
                    try (InputStream in = context.getContentResolver().openInputStream(source)) {
                        if (in != null) {
                            byte[] buffer = new byte[64 * 1024];
                            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                        }
                    }
                    out.write("\r\n".getBytes(StandardCharsets.UTF_8));
                }
                out.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status == 401) throw new Refused("signin");
            // 507: the user's Drive is full, which trying again will not fix.
            if (status >= 500 && status != 507) throw new java.io.IOException("server " + status);
            String body = read(status == 200 ? connection.getInputStream() : connection.getErrorStream());
            JSONObject answer = body.isEmpty() ? new JSONObject() : new JSONObject(body);
            if (status != 200) throw new Refused(answer.optString("i18n_key", "failed"));
            return answer.optString("results_id");
        } finally {
            connection.disconnect();
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        if (in == null) return "";
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int n; (n = stream.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }

    /** Finished (resultsId) or given up (why): the source is let go, and the page told. */
    private Result done(String kind, Data input, String resultsId, String why) {
        Context context = getApplicationContext();
        Notifications.cancelLocalProgress(context, key);
        Checkpoint.forget(context, key);
        failures(context, key, -1);
        if ("share".equals(kind)) {
            Shares.discard(context, input.getString("shareId"));
        } else if ("staged".equals(kind)) {
            //noinspection ResultOfMethodCallIgnored
            new File(input.getString("source")).delete();
        } else if ("watch".equals(kind)) {
            String watchId = input.getString("watchId");
            Watches.mark(context, watchId, input.getString("docId"), resultsId != null ? "sent" : "skipped");
            Watches.update(context, watchId, w -> {
                if (resultsId != null) {
                    w.sent++;
                    w.lastError = "";
                } else {
                    w.lastError = why;
                }
            });
            IvritNativePlugin.watchChanged(watchId);
        }
        if ("benchmark".equals(kind)) {
            tell(kind, resultsId != null ? "done" : "failed", 1, null, why);
            return Result.success();
        }
        if (resultsId == null && why != null && !"gone".equals(why) && !"access".equals(why)) Notifications.showLocalFailed(context, key, name, why);
        IvritNativePlugin.localTranscription(key, name, folder, resultsId != null ? "done" : "failed", 1, resultsId, why);
        return Result.success();
    }

    private void progress(String phase, double fraction, Double secondsLeft) {
        long now = System.currentTimeMillis();
        if (now - told < 1000 && fraction < 1) return;
        told = now;
        try {
            setForegroundAsync(foreground((int) Math.round(fraction * 100), phase, secondsLeft));
        } catch (Exception ignored) {
            // The notification is only a view of the work.
        }
        tell(getInputData().getString("kind"), phase, fraction, null, secondsLeft == null ? null : String.valueOf(Math.round(secondsLeft)));
    }

    /** To the page: a recording's progress (localTranscription), or a benchmark's (benchmark). */
    private void tell(String kind, String phase, double fraction, String resultsId, String extra) {
        if ("benchmark".equals(kind)) IvritNativePlugin.benchmark(key, phase, fraction, "done".equals(phase) ? bench : null, extra);
        else IvritNativePlugin.localTranscription(key, name, folder, phase, fraction, resultsId, extra);
    }

    private ForegroundInfo foreground(int percent, String phase, Double secondsLeft) {
        Context context = getApplicationContext();
        android.app.Notification notification = Notifications.localProgress(
            context, name, phase, percent, secondsLeft, WorkManager.getInstance(context).createCancelPendingIntent(getId()));
        int id = Notifications.localProgressId(key);
        if (Build.VERSION.SDK_INT >= 35) return new ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING);
        if (Build.VERSION.SDK_INT >= 29) return new ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        return new ForegroundInfo(id, notification);
    }
}
