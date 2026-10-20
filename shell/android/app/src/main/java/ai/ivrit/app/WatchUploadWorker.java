package ai.ivrit.app;

import android.content.Context;
import android.net.Uri;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * One new file from a watched folder, uploaded to the app's server as the
 * Transcribe view would send it (POST /upload) into the watch's My files folder,
 * marked as from a watched folder. Signed in with the app's own session (which
 * lasts and renews, unlike the web view's cookie), and with an upload id made from
 * the file, so a retry after a lost answer is the same job, not a second one.
 *
 * When the free weekly quota runs out, the watch waits (Watches.quotaUntil), and
 * the file is looked at again once it may go.
 */
public class WatchUploadWorker extends Worker {
    private static final String TAG = "IvritWatchUpload";
    private static final int MAX_ATTEMPTS = 8;
    private static final long QUOTA_WAIT_MS = 60 * 60 * 1000;

    public WatchUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void enqueue(Context context, Watches.Watch watch, String docId, Uri doc, String name, String type, long size, long modified) {
        Data input = new Data.Builder()
            .putString("watch", watch.id)
            .putString("docId", docId)
            .putString("uri", doc.toString())
            .putString("name", name)
            .putString("type", type)
            .putLong("size", size)
            .putString("uploadId", "watch-" + hash(watch.id + "\n" + docId + "\n" + size + "\n" + modified))
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(WatchUploadWorker.class)
            .setInputData(input)
            .setConstraints(new Constraints.Builder()
                .setRequiredNetworkType(watch.wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED)
                .build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork("watch-up-" + input.getString("uploadId"), ExistingWorkPolicy.KEEP, request);
    }

    /** The file transcribed on the phone instead (LocalTranscribeWorker), into the watch's folder. */
    static void onPhone(Context context, Watches.Watch watch, String docId, Uri doc, String name, String type) {
        LocalTranscribeWorker.enqueue(context, LocalTranscribeWorker
            .input("watch", "watch-" + hash(watch.id + "\n" + docId), doc.toString(), name, type, watch.folder, true, "watch")
            .putString("watchId", watch.id)
            .putString("docId", docId)
            .build());
    }

    private static String hash(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 20; i++) out.append(String.format("%02x", digest[i]));
            return out.toString();
        } catch (Exception e) {
            return UUID.randomUUID().toString().replace("-", "");
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        Data input = getInputData();
        String watchId = input.getString("watch");
        String docId = input.getString("docId");
        Watches.Watch watch = Watches.find(context, watchId);
        if (watch == null || docId == null) return Result.success(); // removed meanwhile
        // Chosen meanwhile: on the phone.
        if (Watches.onPhone(context, watch)) {
            onPhone(context, watch, docId, Uri.parse(input.getString("uri")), input.getString("name"), input.getString("type"));
            return Result.success();
        }
        String token = Store.appToken(context);
        if (token.isEmpty()) return lookAgainLater(context, watchId, docId, "signin");
        if (watch.quotaUntil > System.currentTimeMillis()) {
            if (Watches.AUTO.equals(watch.where) && "he".equals(watch.language)) {
                onPhone(context, watch, docId, Uri.parse(input.getString("uri")), input.getString("name"), input.getString("type"));
                return Result.success();
            }
            return lookAgainLater(context, watchId, docId, "quota");
        }

        String site = Store.site(context);
        String name = input.getString("name");
        String type = input.getString("type");
        long size = input.getLong("size", -1);
        String boundary = "----ivrit" + UUID.randomUUID().toString().replace("-", "");
        StringBuilder head = new StringBuilder()
            .append(field(boundary, "language", watch.language))
            .append(field(boundary, "save_audio", "true"))
            .append(field(boundary, "origin", "watch"))
            .append(field(boundary, "upload_id", input.getString("uploadId")));
        if (!watch.folder.isEmpty()) head.append(field(boundary, "folder", watch.folder));
        head.append("--").append(boundary).append("\r\nContent-Disposition: form-data; name=\"file\"; filename=\"")
            .append(name.replace("\"", "'")).append("\"\r\nContent-Type: ").append(type).append("\r\n\r\n");
        byte[] headBytes = head.toString().getBytes(StandardCharsets.UTF_8);
        byte[] tail = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(site + "/upload").openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(10 * 60 * 1000);
            if (size > 0) connection.setFixedLengthStreamingMode(headBytes.length + size + tail.length);
            else connection.setChunkedStreamingMode(64 * 1024);
            connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Origin", site);
            try (OutputStream out = connection.getOutputStream();
                 InputStream in = context.getContentResolver().openInputStream(Uri.parse(input.getString("uri")))) {
                if (in == null) throw new java.io.FileNotFoundException("gone");
                out.write(headBytes);
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                out.write(tail);
            }
            int status = connection.getResponseCode();
            if (status == 401) return lookAgainLater(context, watchId, docId, "signin");
            if (status == 429 || status >= 500) return retry(context, watchId, docId);
            if (status != 200) return refused(context, watchId, docId, readError(connection.getErrorStream()));
            // The server answers as it goes: transcoding, then queued (or why not).
            String error = null;
            boolean queued = false;
            try (BufferedReader lines = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = lines.readLine()) != null; ) {
                    if (line.trim().isEmpty()) continue;
                    JSONObject event = new JSONObject(line);
                    String kind = event.optString("type");
                    if ("transcoding_complete".equals(kind)) queued = true;
                    if ("error".equals(kind)) error = event.optString("i18n_key", event.optString("error", "failed"));
                    if (queued || error != null) break;
                }
            }
            if (queued) {
                Watches.mark(context, watchId, docId, "sent");
                Watches.update(context, watchId, w -> {
                    w.sent++;
                    w.lastError = "";
                });
                IvritNativePlugin.watchChanged(watchId);
                return Result.success();
            }
            return refused(context, watchId, docId, error);
        } catch (java.io.FileNotFoundException e) {
            // The file was deleted before it went.
            Watches.mark(context, watchId, docId, "skipped");
            return Result.success();
        } catch (Exception e) {
            Log.w(TAG, "upload failed, will retry", e);
            return retry(context, watchId, docId);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private Result retry(Context context, String watchId, String docId) {
        if (getRunAttemptCount() < MAX_ATTEMPTS) return Result.retry();
        return lookAgainLater(context, watchId, docId, "failed");
    }

    /** Not now: the next check offers the file again (when signed in, when the quota allows). */
    private Result lookAgainLater(Context context, String watchId, String docId, String why) {
        Watches.mark(context, watchId, docId, "new");
        Watches.update(context, watchId, w -> w.lastError = why);
        IvritNativePlugin.watchChanged(watchId);
        return Result.success();
    }

    /** The server said no: busy (again soon), the quota (wait, then again), or this file (skip it). */
    private Result refused(Context context, String watchId, String docId, String error) {
        // Too many of this account's files on their way at once, or the service busy.
        if (error != null && (error.contains("BatchLimit") || error.contains("QueueFull") || error.contains("ServerBusy"))) {
            return retry(context, watchId, docId);
        }
        boolean quota = error != null && (error.contains("RateLimit") || error.contains("Quota") || error.contains("TooLargeForFreeService"));
        Watches.Watch watch = Watches.find(context, watchId);
        if (quota && watch != null && Watches.AUTO.equals(watch.where) && "he".equals(watch.language)) {
            // Out of free time: this one, and the next until the quota is back, on the phone.
            Data input = getInputData();
            onPhone(context, watch, docId, Uri.parse(input.getString("uri")), input.getString("name"), input.getString("type"));
            Watches.update(context, watchId, w -> w.quotaUntil = System.currentTimeMillis() + QUOTA_WAIT_MS);
            return Result.success();
        }
        if (quota) {
            Watches.update(context, watchId, w -> w.quotaUntil = System.currentTimeMillis() + QUOTA_WAIT_MS);
            return lookAgainLater(context, watchId, docId, "quota");
        }
        Watches.mark(context, watchId, docId, "skipped");
        String why = error == null ? "failed" : error;
        Watches.update(context, watchId, w -> w.lastError = why);
        IvritNativePlugin.watchChanged(watchId);
        return Result.success();
    }

    private static String field(String boundary, String name, String value) {
        return "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n";
    }

    private static String readError(InputStream in) {
        if (in == null) return null;
        try (InputStream stream = in) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = stream.read(buffer)) > 0; ) out.write(buffer, 0, n);
            JSONObject body = new JSONObject(out.toString("UTF-8"));
            return body.optString("i18n_key", body.optString("error", null));
        } catch (Exception e) {
            return null;
        }
    }
}
