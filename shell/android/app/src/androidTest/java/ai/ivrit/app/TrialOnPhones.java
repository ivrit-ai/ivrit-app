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
 * The benchmark on a phone (over adb: am instrument; or Firebase Test Lab:
 * scripts/test-lab.sh), as a user runs it from the Lab page: Turbo on the processor
 * asked for (argument "processor": "auto", the default, "gpu" or "cpu"; "decoding":
 * "accurate", the default, or "fast", as Settings has them; "screen": "false" for the
 * GPU's check), the benchmark
 * recording transcribed by LocalTranscribeWorker, and what happened posted to the
 * site's log (POST /lab/report?kind=lab-phones): the phone, each phase, the result
 * with its transcript (scored against the reference afterwards, off the
 * leaderboard), and every progress event as the page got it ("events": phase,
 * fraction, seconds left, when), with "backwards": those whose share went down
 * within their phase. The worker's own reports go as from any phone (local-turbo,
 * local-turbo-gpu, local-turbo-gpu-crash).
 */
@RunWith(AndroidJUnit4.class)
public class TrialOnPhones {
    private static final String TAG = "TrialOnPhones";

    @Test
    public void benchmark() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String processor = args.getString("processor", TurboGpu.AUTO);
        long minutes = Long.parseLong(args.getString("minutes", "25"));
        String decoding = args.getString("decoding", Store.ACCURATE);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        // Another size than the phone's memory picks ("q4_0"), and the GPU's check from a
        // later level ("1": WebGPU on a Snapdragon), checked again, the decoder's threads
        // set ("decodeThreads") rather than tuned.
        if (args.getString("variant") != null) Turbo.testVariant = args.getString("variant");
        if (args.getString("level") != null) {
            context.getSharedPreferences("ivrit_turbo_gpu", Context.MODE_PRIVATE).edit().putString("verdict", new JSONObject()
                .put("key", android.os.Build.FINGERPRINT + " " + Store.onDeviceModel(context)).put("state", JSONObject.NULL)
                .put("level", Integer.parseInt(args.getString("level"))).put("ladder", TurboGpu.LADDER)
                .put("decodeThreads", Integer.parseInt(args.getString("decodeThreads", "0"))).toString()).commit();
        }

        // A recording as one handed over is ("staged"), queued and left to run: for what
        // happens when its runs die (killed from outside), with no benchmark to wait for.
        if ("staged".equals(args.getString("enqueue"))) {
            java.io.File copy = new java.io.File(context.getCacheDir(), "fallback-test.flac");
            java.nio.file.Files.copy(Turbo.model(context, Benchmark.NAME).toPath(), copy.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            LocalTranscribeWorker.enqueue(context, LocalTranscribeWorker.input("staged", "fallback-test", copy.getPath(),
                "fallback test", "audio/flac", "", false, "test").build());
            // Queued in the background: kept before this process ends with the test.
            for (int i = 0; i < 100 && WorkManager.getInstance(context).getWorkInfosForUniqueWork("local-fallback-test").get().isEmpty(); i++) {
                Thread.sleep(100);
            }
            Log.i(TAG, "queued fallback-test");
            return;
        }

        Store.setTurboProcessor(context, processor);
        Store.setDecoding(context, decoding);
        JSONObject report = new JSONObject()
            .put("processor", processor)
            .put("decoding", decoding)
            .put("device", Benchmark.device(context))
            .put("app", context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName)
            .put("build", context.getPackageManager().getPackageInfo(context.getPackageName(), 0).getLongVersionCode());
        JSONArray phases = new JSONArray();
        report.put("phases", phases);
        JSONArray events = new JSONArray();
        int[] backwards = {0};
        double[] shown = {-1};
        long since = System.currentTimeMillis();
        if (!Turbo.supported(context)) {
            post(context, report.put("error", "unsupported"));
            return;
        }
        report.put("gpus", new JSONArray(Whisper.gpus()));

        // On the screen, as when a user runs it (the worker runs in the foreground); argument
        // "screen" false leaves it off, so that the GPU's check runs (never with the app on
        // the screen: TurboGpu.decide).
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (open != null && !"false".equals(args.getString("screen"))) context.startActivity(open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));

        CountDownLatch finished = new CountDownLatch(1);
        JSONObject[] last = new JSONObject[1];
        String key = "bench-lab-" + java.util.UUID.randomUUID();
        IvritNativePlugin.watcher = (JSObject event) -> {
            if (!key.equals(event.getString("key"))) return;
            String phase = event.getString("phase");
            try {
                double fraction = event.optDouble("fraction", 0);
                if (phases.length() == 0 || !phase.equals(phases.getJSONObject(phases.length() - 1).getString("phase"))) {
                    phases.put(new JSONObject().put("phase", phase).put("at", (System.currentTimeMillis() - since) / 1000.0));
                    Log.i(TAG, "phase " + phase);
                    shown[0] = -1;
                }
                if (fraction < shown[0]) backwards[0]++;
                shown[0] = Math.max(shown[0], fraction);
                events.put(new JSONObject().put("phase", phase).put("fraction", fraction)
                    .put("left", event.optString("secondsLeft", "")).put("at", (System.currentTimeMillis() - since) / 1000.0));
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
        while (!finished.await(5, TimeUnit.SECONDS)) {
            if (System.currentTimeMillis() > deadline) break;
        }
        IvritNativePlugin.watcher = null;
        report.put("took", (System.currentTimeMillis() - since) / 1000.0).put("events", events).put("backwards", backwards[0]);
        if (last[0] == null) {
            WorkManager.getInstance(context).cancelAllWork();
            report.put("error", "timed out after " + minutes + " minutes");
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
        Log.i(TAG, "finished: " + report.optString("error", "done"));
        Log.i(TAG, "report: " + report);
        // Whole, where the log cuts it short: adb shell run-as <package> cat files/trial-report.json (a debug build).
        java.nio.file.Files.write(new java.io.File(context.getFilesDir(), "trial-report.json").toPath(),
            report.toString().getBytes(StandardCharsets.UTF_8));
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
