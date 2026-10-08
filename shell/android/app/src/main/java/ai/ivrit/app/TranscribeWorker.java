package ai.ivrit.app;

import android.content.Context;
import android.content.SharedPreferences;
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
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * One shared recording on its way through Eliezer, in the background: Android runs
 * it when there is a network, retries it with backoff, and keeps it across the app
 * closing. First the upload (with the app's upload id, so a re-send is the same
 * job at Eliezer), then a few minutes of waiting for the transcript, which is
 * posted as a notification when the app is not open. The page follows along
 * through the plugin's "transcription" events and, regardless, asks Eliezer for
 * its jobs whenever it opens.
 */
public class TranscribeWorker extends Worker {
    private static final String TAG = "IvritTranscribe";
    private static final long WATCH_MS = 4 * 60 * 1000;
    private static final long POLL_MS = 3000;
    // Follow-up checks after the first watch, each a little later: ~20 minutes in all.
    private static final int MAX_FOLLOW_UPS = 6;
    private static final int MAX_UPLOAD_ATTEMPTS = 8;

    public TranscribeWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void enqueue(Context context, String shareId, String base, String token, String uploadId, String origin, String title) {
        Data input = new Data.Builder()
            .putString("shareId", shareId)
            .putString("base", base)
            .putString("token", token)
            .putString("uploadId", uploadId)
            .putString("origin", origin)
            .putString("title", title)
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(TranscribeWorker.class)
            .setInputData(input)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();
        // Replace: a re-enqueue carries a fresher token, and the upload id keeps it one job.
        WorkManager.getInstance(context).enqueueUniqueWork("transcribe-" + uploadId, ExistingWorkPolicy.REPLACE, request);
    }

    private static void followUp(Context context, Data input, int round) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(TranscribeWorker.class)
            .setInputData(new Data.Builder().putAll(input).putInt("round", round).build())
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInitialDelay(2L * round, TimeUnit.MINUTES)
            .build();
        // Its own name: replacing "transcribe-" would cancel the worker scheduling this.
        WorkManager.getInstance(context)
            .enqueueUniqueWork("watch-" + input.getString("uploadId"), ExistingWorkPolicy.REPLACE, request);
    }

    private SharedPreferences jobs() {
        return getApplicationContext().getSharedPreferences("ivrit_jobs", Context.MODE_PRIVATE);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        Data input = getInputData();
        String uploadId = input.getString("uploadId");
        String base = input.getString("base");
        String token = input.getString("token");
        if (uploadId == null || base == null || token == null) return Result.failure();

        String jobId = jobs().getString(uploadId, null);
        if (jobId == null) {
            Shares.Entry entry = Shares.find(context, input.getString("shareId"));
            if (entry == null) return Result.success(); // discarded meanwhile
            int status;
            String body;
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(base + "/app/v1/jobs").openConnection();
                try {
                    connection.setRequestMethod("POST");
                    connection.setDoOutput(true);
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(60000);
                    connection.setFixedLengthStreamingMode(entry.file.length());
                    connection.setRequestProperty("Content-Type", entry.type);
                    connection.setRequestProperty("X-Filename", URLEncoder.encode(entry.name, "UTF-8").replace("+", "%20"));
                    connection.setRequestProperty("X-Upload-Id", uploadId);
                    if (!entry.origin.isEmpty()) connection.setRequestProperty("X-Origin", entry.origin);
                    connection.setRequestProperty("Authorization", "Bearer " + token);
                    try (InputStream in = new FileInputStream(entry.file); OutputStream out = connection.getOutputStream()) {
                        byte[] buffer = new byte[64 * 1024];
                        for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                    }
                    status = connection.getResponseCode();
                    body = read(status < 400 ? connection.getInputStream() : connection.getErrorStream());
                } finally {
                    connection.disconnect();
                }
            } catch (IOException e) {
                Log.w(TAG, "upload failed, will retry", e);
                return getRunAttemptCount() < MAX_UPLOAD_ATTEMPTS ? Result.retry() : Result.failure();
            }
            if (status == 200 || status == 202) {
                try {
                    jobId = new JSONObject(body).getString("job_id");
                } catch (Exception e) {
                    return Result.retry();
                }
                jobs().edit().putString(uploadId, jobId).apply();
                Shares.discard(context, entry.id);
                IvritNativePlugin.transcription(uploadId, "queued", null);
            } else if (status == 401) {
                // The token ran out before the network came back; the page sends a
                // fresh one the next time the app opens. The file stays.
                IvritNativePlugin.transcription(uploadId, "signin", null);
                return Result.failure();
            } else if (status == 429 || status >= 500) {
                return getRunAttemptCount() < MAX_UPLOAD_ATTEMPTS ? Result.retry() : Result.failure();
            } else {
                // Refused for good (too large, not audio): nothing to retry.
                String code = status == 413 ? "too_large" : "unsupported";
                Shares.discard(context, entry.id);
                IvritNativePlugin.transcription(uploadId, "failed", code);
                return Result.failure();
            }
        }

        // Waiting for the transcript: usually seconds, sometimes minutes in a queue.
        long until = System.currentTimeMillis() + WATCH_MS;
        while (System.currentTimeMillis() < until && !isStopped()) {
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(base + "/app/v1/jobs/" + jobId).openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("Authorization", "Bearer " + token);
                int status = connection.getResponseCode();
                String body = read(status < 400 ? connection.getInputStream() : connection.getErrorStream());
                connection.disconnect();
                if (status == 401 || status == 404) return Result.success(); // the app picks it up on open
                if (status == 200) {
                    JSONObject job = new JSONObject(body);
                    String state = job.optString("status");
                    if (!"queued".equals(state)) {
                        if ("done".equals(state) && !MainActivity.visible) {
                            Notifications.showTranscript(context, uploadId, input.getString("title"), job.optString("text"), input.getString("origin"));
                        }
                        IvritNativePlugin.transcription(uploadId, state, job.optString("error", null));
                        jobs().edit().remove(uploadId).apply();
                        return Result.success();
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "checking a job failed", e);
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                return Result.success();
            }
        }
        int round = input.getInt("round", 0) + 1;
        if (round <= MAX_FOLLOW_UPS) followUp(context, input, round);
        return Result.success();
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int n; (n = stream.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }
}
