package ai.ivrit.app;

import android.content.Context;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
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
 * its check on this phone (TurboGpu), and how long it took is reported to the site
 * (POST /lab/report?kind=local-turbo), to see how phones fare.
 */
public class LocalTranscribeWorker extends Worker {
    private static final String TAG = "IvritLocal";
    private static final double BLOCK_SECONDS = 4;
    // One recording through the model at a time; the others wait their turn.
    private static final java.util.concurrent.Semaphore TURN = new java.util.concurrent.Semaphore(1, true);

    public LocalTranscribeWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** One more recording, after those already waiting. */
    static void enqueue(Context context, Data input) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(LocalTranscribeWorker.class)
            .setInputData(input)
            .addTag("local:" + input.getString("key"))
            // Waiting its turn is a retry: looked at again every 20 seconds.
            .setBackoffCriteria(androidx.work.BackoffPolicy.LINEAR, 20, java.util.concurrent.TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork("local-" + input.getString("key"), ExistingWorkPolicy.KEEP, request);
        IvritNativePlugin.localTranscription(input.getString("key"), input.getString("name"), input.getString("folder"), "queued", 0, null, null);
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
        Uri source = sourceUri(input.getString("source"));
        if (source == null) return done(kind, input, null, "gone");
        // Another recording has the model: this one waits its turn, without holding
        // one of WorkManager's few threads (uploads and folder checks need them).
        if (!TURN.tryAcquire()) {
            IvritNativePlugin.localTranscription(key, name, folder, "queued", 0, null, null);
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
            if (variant != null) {
                engine = Turbo.engine(variant);
                Turbo.ensure(context, variant, (done, total) -> progress("downloading", done / (double) Math.max(1, total), null));
            } else {
                LocalModel.ensure(context, (done, total) -> progress("model", done / (double) Math.max(1, total), null));
            }
            double duration = AudioDecoder.duration(context, source);
            JSONArray segments = variant != null ? transcribeTurbo(context, kind, source, duration, variant) : transcribe(context, source, duration);
            if (isStopped()) return Result.success();
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

    private JSONArray transcribeTurbo(Context context, String kind, Uri source, double duration, String variant) throws Exception {
        // Resumed where an earlier run's last checkpoint left off, as transcribe() is.
        Checkpoint kept = Checkpoint.load(context, key);
        Checkpoint done = engine.equals(kept.engine) ? kept : new Checkpoint();
        List<Segments.Word> words = done.words();
        double from = done.offset;
        // On the GPU where it passed its check on this phone (TurboGpu), once checked.
        String processor = Store.turboProcessor(context);
        TurboGpu.Verdict verdict = TurboGpu.decide(context, variant, processor, () -> progress("checking", 0, null));
        boolean gpu = TurboGpu.onGpu(verdict, processor);
        long loading = System.currentTimeMillis();
        String path = Turbo.file(context, variant).getPath();
        if (gpu) TurboGpu.log(context);
        long loaded = Whisper.load(path, gpu, !gpu || TurboGpu.flash(verdict));
        if (loaded == 0 && gpu) {
            gpu = false; // no room on the GPU: the CPU, then
            loaded = Whisper.load(path, false, true);
        }
        // Checked when it downloaded: not loading is the phone short of memory.
        if (loaded == 0) throw new IllegalStateException("the Turbo model did not load");
        long handle = loaded;
        synchronized (this) {
            turbo = handle;
        }
        if (gpu) TurboGpu.started(context);
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
                if (sound.seconds() >= Turbo.CHUNK_SECONDS) hearTurbo(context, handle, threads, sound, words, false, duration, from, started);
            });
            if (sound.resampler != null) sound.add(sound.resampler.flush());
            if (sound.start < 0) sound.start = from;
            hearTurbo(context, handle, threads, sound, words, true, duration, from, started);
        } catch (IllegalStateException e) {
            // ggml failing on the GPU (guard.cpp): the next level next time; this
            // recording again, from its last checkpoint, on the CPU (retried).
            if (gpu && !isStopped()) {
                TurboGpu.failed(context, variant, e.getMessage());
                gpu = false;
            }
            throw e;
        } finally {
            synchronized (this) {
                turbo = 0;
                Whisper.free(handle);
            }
            if (gpu) TurboGpu.finished(context);
        }
        double heard = duration > 0 ? duration - from : 0;
        double took = (System.currentTimeMillis() - started) / 1000.0;
        post(context, "local-turbo", new JSONObject()
            .put("kind", kind)
            .put("engine", engine)
            .put("seconds", heard)
            .put("took", took)
            .put("realtime", took > 0 ? heard / took : null)
            .put("load", (started - loading) / 1000.0)
            .put("resumedAt", from)
            .put("processor", gpu ? "gpu" : "cpu")
            .put("chose", processor)
            .put("gpu", verdict.gpu)
            .put("gpuCheck", verdict.state == null ? JSONObject.NULL : verdict.state)
            .put("threads", threads)
            .put("cores", Runtime.getRuntime().availableProcessors())
            .put("memory", Turbo.memory(context))
            .put("beams", Turbo.BEAMS)
            .put("system", Whisper.system()));
        return Segments.segments(words);
    }

    /** The sound so far through the Turbo model, keeping what may be cut off for next time. */
    private void hearTurbo(Context context, long handle, int threads, Sound sound, List<Segments.Word> words, boolean last,
                           double duration, double from, long started) throws Exception {
        if (isStopped()) throw new InterruptedException("stopped");
        if (sound.length < Resampler.RATE / 10) return; // nothing to speak of
        double start = sound.start;
        double seconds = sound.seconds();
        Object[] heard = Whisper.transcribe(handle, java.util.Arrays.copyOf(sound.samples, sound.length), Turbo.LANGUAGE, threads, Turbo.BEAMS, percent -> {
            if (duration <= 0) return;
            double fraction = Math.min(1, (start + seconds * percent / 100.0) / duration);
            double spent = (System.currentTimeMillis() - started) / 1000.0;
            double share = fraction - from / duration;
            progress("transcribing", fraction, share > 0.03 ? spent * (1 - fraction) / share : null);
        });
        if (heard == null) throw new InterruptedException("stopped");
        TurboWords.Chunk chunk = TurboWords.chunk((byte[]) heard[0], (int[]) heard[1], (int[]) heard[2], (int[]) heard[3], start, seconds, last);
        words.addAll(chunk.words);
        sound.keepFrom(chunk.next);
        if (!last) Checkpoint.saveWords(context, key, engine, words, chunk.next);
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
        if (resultsId == null && why != null && !"gone".equals(why)) Notifications.showLocalFailed(context, key, name, why);
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
        IvritNativePlugin.localTranscription(key, name, folder, phase, fraction, null, secondsLeft == null ? null : String.valueOf(Math.round(secondsLeft)));
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
