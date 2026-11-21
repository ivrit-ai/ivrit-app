package ai.ivrit.app;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The benchmark on phones we don't have (Firebase Test Lab: scripts/test-lab.sh), as
 * a user runs it from the Lab page: Turbo on the processor asked for (argument
 * "processor": "webgpu", the trial, by default; "auto", "cpu"; "decoding": "accurate",
 * the default, or "fast", as Settings has them), the benchmark
 * recording transcribed by LocalTranscribeWorker, and what happened posted to the
 * site's log (POST /lab/report?kind=lab-phones): the phone, each phase, the result
 * with its transcript (scored against the reference afterwards, off the
 * leaderboard), or the trial's failure. The worker's own reports go as from any
 * phone (local-turbo, local-turbo-gpu-crash). A failed trial ends the run: the CPU
 * that would follow is not what is being tested.
 */
@RunWith(AndroidJUnit4.class)
public class TrialOnPhones {
    private static final String TAG = "TrialOnPhones";

    @Test
    public void benchmark() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String processor = args.getString("processor", TurboGpu.TRIAL);
        long minutes = Long.parseLong(args.getString("minutes", "25"));
        String decoding = args.getString("decoding", Store.ACCURATE);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

        // As the Lab's switch sets it, before the library loads (Turbo.supported applies the trial's switches).
        TurboGpu.trialReset(context);
        Store.setTurboProcessor(context, processor);
        Store.setDecoding(context, decoding);
        JSONObject report = new JSONObject()
            .put("processor", processor)
            .put("decoding", decoding)
            .put("device", Benchmark.device(context))
            .put("app", context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName)
            .put("build", TurboGpu.build(context));
        JSONArray phases = new JSONArray();
        report.put("phases", phases);
        long since = System.currentTimeMillis();
        if (!Turbo.supported(context)) {
            post(context, report.put("error", "unsupported"));
            return;
        }
        report.put("gpus", new JSONArray(Whisper.gpus()));

        // On the screen, as when a user runs it (the worker runs in the foreground).
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (open != null) context.startActivity(open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));

        CountDownLatch finished = new CountDownLatch(1);
        JSONObject[] last = new JSONObject[1];
        String key = "bench-lab-" + java.util.UUID.randomUUID();
        IvritNativePlugin.watcher = (JSObject event) -> {
            if (!key.equals(event.getString("key"))) return;
            String phase = event.getString("phase");
            try {
                if (phases.length() == 0 || !phase.equals(phases.getJSONObject(phases.length() - 1).getString("phase"))) {
                    phases.put(new JSONObject().put("phase", phase).put("at", (System.currentTimeMillis() - since) / 1000.0));
                    Log.i(TAG, "phase " + phase);
                }
            } catch (Exception ignored) {
                // Only the timeline is short.
            }
            if ("done".equals(phase) || "failed".equals(phase)) {
                last[0] = event;
                finished.countDown();
            }
        };
        LocalTranscribeWorker.enqueue(context, LocalTranscribeWorker
            .input("benchmark", key, "", "benchmark", "audio/flac", "", false, "benchmark").build());

        long deadline = since + TimeUnit.MINUTES.toMillis(minutes);
        String failure = null;
        while (!finished.await(5, TimeUnit.SECONDS)) {
            failure = TurboGpu.TRIAL.equals(processor) ? TurboGpu.trialFailure(context) : null;
            if (failure != null || System.currentTimeMillis() > deadline) break;
        }
        IvritNativePlugin.watcher = null;
        report.put("took", (System.currentTimeMillis() - since) / 1000.0);
        if (failure == null && TurboGpu.TRIAL.equals(processor)) failure = TurboGpu.trialFailure(context);
        if (failure != null) report.put("trialFailed", failure);
        if (last[0] == null) {
            WorkManager.getInstance(context).cancelAllWork();
            if (failure == null) report.put("error", "timed out after " + minutes + " minutes");
        } else if ("failed".equals(last[0].getString("phase"))) {
            report.put("error", last[0].optString("error", "failed"));
        } else {
            report.put("result", last[0].getJSONObject("result"));
        }
        // Where the time went: whisper.cpp's timings, in the GPU's log (TurboGpu.log) as the model was let go.
        java.io.File log = new java.io.File(context.getFilesDir(), "turbo-gpu.log");
        if (log.exists()) {
            JSONArray timings = new JSONArray();
            for (String line : new String(java.nio.file.Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8).split("\n")) {
                if (line.contains("whisper_print_timings") || line.startsWith("ggml_webgpu: adapter")) timings.put(line.trim());
            }
            report.put("timings", timings);
        }
        Log.i(TAG, "finished: " + (failure != null ? "trial failed: " + failure : report.optString("error", "done")));
        post(context, report);
    }

    private static void post(Context context, JSONObject report) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(Store.site(context) + "/lab/report?kind=lab-phones").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("content-type", "application/json");
        try (OutputStream out = c.getOutputStream()) {
            out.write(report.toString().getBytes(StandardCharsets.UTF_8));
        }
        Log.i(TAG, "reported: " + c.getResponseCode());
        c.disconnect();
    }
}
