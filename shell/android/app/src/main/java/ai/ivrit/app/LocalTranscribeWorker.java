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
 * It runs in the foreground, one recording at a time (the model is large), with a
 * notification showing how far it got and a way to stop it, and tells the page as
 * it goes ("localTranscription" events) so My files shows it too.
 *
 * Where a recording comes from: a file shared into the app ("share"), a new file in
 * a watched folder ("watch"), or one picked in the app and handed over ("staged").
 */
public class LocalTranscribeWorker extends Worker {
    private static final String TAG = "IvritLocal";
    static final String UNIQUE = "local-transcription";
    private static final double BLOCK_SECONDS = 4;

    public LocalTranscribeWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** One more recording, after those already waiting. */
    static void enqueue(Context context, Data input) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(LocalTranscribeWorker.class)
            .setInputData(input)
            .addTag("local:" + input.getString("key"))
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE, ExistingWorkPolicy.APPEND_OR_REPLACE, request);
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
        try {
            setForegroundAsync(foreground(-1, null, null));
        } catch (Exception e) {
            Log.w(TAG, "could not run in the foreground", e);
        }
        try {
            LocalModel.ensure(context, (done, total) -> progress("model", done / (double) Math.max(1, total), null));
            double duration = AudioDecoder.duration(context, source);
            JSONArray segments = transcribe(context, source, duration);
            if (isStopped()) return Result.success();
            progress("saving", 1, null);
            String resultsId = save(context, input, source, segments, duration);
            Notifications.showLocalReady(context, key, name, resultsId, folder);
            return done(kind, input, resultsId, null);
        } catch (AudioDecoder.NoAudio e) {
            return done(kind, input, null, "unsupported");
        } catch (Refused e) {
            return done(kind, input, null, e.getMessage());
        } catch (Exception e) {
            if (isStopped()) return Result.success();
            Log.w(TAG, "transcribing on the phone failed", e);
            if (getRunAttemptCount() < 2) return Result.retry();
            return done(kind, input, null, "failed");
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
        Checkpoint done = Checkpoint.load(context, key);
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

    /** The server's refusal, worth showing as is. */
    private static final class Refused extends Exception {
        Refused(String why) {
            super(why);
        }
    }

    private String save(Context context, Data input, Uri source, JSONArray segments, double duration) throws Exception {
        String token = Store.appToken(context);
        if (token.isEmpty()) throw new Refused("signin");
        String site = Store.site(context);
        JSONObject meta = new JSONObject()
            .put("filename", name)
            .put("language", "he")
            .put("duration_seconds", duration)
            .put("folder", folder == null ? "" : folder)
            .put("origin", input.getString("origin"))
            .put("engine", LocalModel.ENGINE);
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
                if (input.getBoolean("saveAudio", true)) {
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
            if (status >= 500) throw new java.io.IOException("server " + status);
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
        if (resultsId == null && why != null && !"gone".equals(why)) Notifications.showLocalFailed(context, key, name);
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
