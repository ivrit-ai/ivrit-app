package ai.ivrit.app;

import android.content.Context;
import android.util.Log;
import android.webkit.CookieManager;
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
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * A shared recording too long for a clip, uploaded in the background to the app's own
 * server as the Transcribe view would (POST /upload, with this app's sign-in cookie):
 * it is transcribed there like any file, with speakers, into My files in the user's
 * Drive. Android runs it when there is a network and keeps it across the app closing.
 * The page hears how it went through the plugin's "fileUpload" events.
 */
public class FileUploadWorker extends Worker {
    private static final String TAG = "IvritFileUpload";
    private static final int MAX_ATTEMPTS = 8;

    public FileUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void enqueue(Context context, String shareId, String base, String language, boolean saveAudio) {
        Data input = new Data.Builder()
            .putString("shareId", shareId)
            .putString("base", base)
            .putString("language", language)
            .putBoolean("saveAudio", saveAudio)
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(FileUploadWorker.class)
            .setInputData(input)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork("file-" + shareId, ExistingWorkPolicy.KEEP, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        Data input = getInputData();
        String shareId = input.getString("shareId");
        String base = input.getString("base");
        Shares.Entry entry = Shares.find(context, shareId);
        if (entry == null || base == null) return Result.success(); // discarded meanwhile
        String cookie = CookieManager.getInstance().getCookie(base);
        if (cookie == null || cookie.isEmpty()) {
            IvritNativePlugin.fileUpload(shareId, "signin", null);
            return Result.failure();
        }
        String boundary = "----ivrit" + UUID.randomUUID().toString().replace("-", "");
        byte[] head = (field(boundary, "language", input.getString("language"))
            + field(boundary, "save_audio", input.getBoolean("saveAudio", true) ? "true" : "false")
            + "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\""
            + entry.name.replace("\"", "'") + "\"\r\nContent-Type: " + entry.type + "\r\n\r\n").getBytes(StandardCharsets.UTF_8);
        byte[] tail = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base + "/upload").openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(10 * 60 * 1000);
            connection.setFixedLengthStreamingMode(head.length + entry.file.length() + tail.length);
            connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("Origin", base);
            try (OutputStream out = connection.getOutputStream(); InputStream in = new FileInputStream(entry.file)) {
                out.write(head);
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                out.write(tail);
            }
            int status = connection.getResponseCode();
            if (status == 401) {
                IvritNativePlugin.fileUpload(shareId, "signin", null);
                return Result.failure();
            }
            if (status >= 500 || status == 429) return retry();
            if (status != 200) {
                Shares.discard(context, shareId);
                IvritNativePlugin.fileUpload(shareId, "failed", read(connection.getErrorStream()));
                return Result.failure();
            }
            // The server answers as it goes: transcoding, then queued (or why not).
            String error = null;
            boolean queued = false;
            try (BufferedReader lines = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = lines.readLine()) != null; ) {
                    if (line.trim().isEmpty()) continue;
                    JSONObject event = new JSONObject(line);
                    String type = event.optString("type");
                    if ("transcoding_complete".equals(type)) queued = true;
                    if ("error".equals(type)) error = event.optString("i18n_key", event.optString("error", "failed"));
                    if (queued || error != null) break;
                }
            }
            Shares.discard(context, shareId);
            IvritNativePlugin.fileUpload(shareId, queued ? "queued" : "failed", error);
            return queued ? Result.success() : Result.failure();
        } catch (Exception e) {
            Log.w(TAG, "upload failed, will retry", e);
            return retry();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private Result retry() {
        return getRunAttemptCount() < MAX_ATTEMPTS ? Result.retry() : Result.failure();
    }

    private static String field(String boundary, String name, String value) {
        return "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n";
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return null;
        try (InputStream stream = in) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = stream.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }
}
