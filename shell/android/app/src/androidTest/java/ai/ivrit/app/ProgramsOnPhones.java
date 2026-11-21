package ai.ivrit.app;

import android.content.Context;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The encoder's GPU programs timed on phones we don't have (Firebase Test Lab:
 * scripts/test-lab.sh programs), without the model: each version of them (a test
 * each, a process each with the orchestrator, as ggml reads its switches once) at
 * the encoder's sizes, against the CPU's answer (Whisper.bench), posted to the
 * site's log (POST /lab/report?kind=lab-programs).
 */
@RunWith(AndroidJUnit4.class)
public class ProgramsOnPhones {
    private static final String TAG = "ProgramsOnPhones";
    // The trial's switches (TurboGpu.TRIAL_LEVEL), and a wait long enough to time a slow program.
    private static final String[] TRIAL = {"GGML_WEBGPU_MOBILE", "GGML_WEBGPU_DISABLE_SUBGROUP_MATRIX",
        "GGML_WEBGPU_DISABLE_SUBGROUPS", "GGML_WEBGPU_SUBMIT_BATCH=8", "GGML_WEBGPU_WAIT_MS=120000"};
    // {what, K, M, N}: the attention's projections, the MLP's two (a 30 s window: 1500 frames), the attention.
    private static final int[][] SIZES = {{0, 1280, 1280, 1500}, {0, 1280, 5120, 1500}, {0, 5120, 1280, 1500}, {1, 64, 20, 1500}};
    private static final String[] NAMES = {"mm 1280x1280", "mm 1280->5120", "mm 5120->1280", "attention"};

    @org.junit.Ignore("8x4 beat it by a quarter on a Pixel 8a") @Test public void f32Columns8() throws Exception { run("f32 8x8", "GGML_WEBGPU_MOBILE_COLUMNS=8", "GGML_WEBGPU_MOBILE_HALF=0", "GGML_WEBGPU_MOBILE_INT8=0"); }

    @Test public void f32Columns4() throws Exception { run("f32 8x4", "GGML_WEBGPU_MOBILE_COLUMNS=4", "GGML_WEBGPU_MOBILE_HALF=0", "GGML_WEBGPU_MOBILE_INT8=0"); }

    @org.junit.Ignore("no faster than 8x4 on a Pixel 8a") @Test public void f32Rows4() throws Exception { run("f32 4x4", "GGML_WEBGPU_MOBILE_ROWS=4", "GGML_WEBGPU_MOBILE_INT8=0"); }

    @Test public void f16Columns4() throws Exception { run("f16 8x4", "GGML_WEBGPU_MOBILE_COLUMNS=4", "GGML_WEBGPU_MOBILE_HALF=1", "GGML_WEBGPU_MOBILE_INT8=0"); }

    private void run(String version, String... switches) throws Exception {
        for (String s : TRIAL) set(s);
        for (String s : switches) set(s);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        JSONObject report = new JSONObject().put("version", version).put("switches", new JSONArray(switches))
            .put("device", Benchmark.device(context)).put("build", TurboGpu.build(context));
        JSONArray results = new JSONArray();
        report.put("results", results);
        try {
            if (!Whisper.available()) throw new IllegalStateException("no library for this phone");
            report.put("gpus", new JSONArray(Whisper.gpus()));
            for (int i = 0; i < SIZES.length; i++) {
                int[] s = SIZES[i];
                JSONObject r = new JSONObject().put("name", NAMES[i]);
                try {
                    String[] got = Whisper.bench(s[0], s[1], s[2], s[3], 3).split(" ");
                    double ms = Double.parseDouble(got[0]);
                    r.put("ms", ms).put("error", Double.parseDouble(got[1]));
                    if (s[0] == 0) r.put("gflops", 2.0 * s[1] * s[2] * s[3] / ms / 1e6);
                } catch (IllegalStateException e) {
                    r.put("failed", e.getMessage());
                }
                Log.i(TAG, version + " " + r);
                results.put(r);
                if (r.has("failed")) break; // the device is lost, or the wait gave up: the rest would fail
            }
        } catch (Throwable e) {
            report.put("failed", String.valueOf(e));
        }
        post(context, report);
    }

    private static void set(String s) throws Exception {
        int eq = s.indexOf('=');
        android.system.Os.setenv(eq < 0 ? s : s.substring(0, eq), eq < 0 ? "1" : s.substring(eq + 1), true);
    }

    private static void post(Context context, JSONObject report) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(Store.site(context) + "/lab/report?kind=lab-programs").openConnection();
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
