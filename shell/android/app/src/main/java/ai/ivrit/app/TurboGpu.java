package ai.ivrit.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Whether the Turbo model runs on the phone's GPU (Vulkan) or its CPU.
 *
 * Phones' GPU drivers vary, and a bad one can give wrong text or bring the app down,
 * so the GPU is used only once it has passed a check on this phone, for this build
 * of its system (drivers come with it) and this model: a 12-second Hebrew recording
 * (res/raw/turbo_check, store/fixtures/hebrew-12s.ogg) on the CPU, then on the GPU,
 * twice (the first run also builds its shaders). It passes when the GPU's words
 * agree with the CPU's (AGREEMENT) and its second run is faster. What it found is
 * reported to the site (POST /lab/report?kind=local-turbo-gpu).
 *
 * A check or a GPU run that never finished (the process died in it) is found the next
 * time: a check, at once, and GPU runs, twice in a row, put the phone on the CPU.
 *
 * The user can choose (the web app's Settings): automatic (the GPU when it passed and
 * is faster), the CPU, or the GPU whenever it gives the right words, faster or not.
 */
final class TurboGpu {
    private TurboGpu() {}

    static final String AUTO = "auto";
    static final String CPU = "cpu";
    static final String GPU = "gpu";
    static final String[] PROCESSORS = {AUTO, CPU, GPU};
    /** The GPU's words against the CPU's: a little apart is half floats, more is a broken driver. */
    static final double AGREEMENT = 0.85;
    /** GPU runs that died in a row before the GPU is given up. */
    static final int DEATHS = 2;

    /** What was found on this phone: kept between runs, one at a time. */
    static final class Verdict {
        String key; // the system build and the model it holds for
        String state; // null (not checked), "testing", "faster", "slower", "wrong", "failed", "crashed", "none"
        String gpu = "";
        double cpuSeconds;
        double gpuSeconds;
        double agreement;
        String error = "";
        int deaths; // GPU runs that died since the last one that finished
        boolean running; // a GPU run under way (or one that died)

        Verdict(String key) {
            this.key = key;
        }

        JSONObject json() throws Exception {
            return new JSONObject().put("key", key).put("state", state == null ? JSONObject.NULL : state).put("gpu", gpu)
                .put("cpuSeconds", cpuSeconds).put("gpuSeconds", gpuSeconds).put("agreement", agreement)
                .put("error", error).put("deaths", deaths).put("running", running);
        }

        static Verdict of(JSONObject o) {
            Verdict v = new Verdict(o.optString("key"));
            v.state = o.isNull("state") ? null : o.optString("state", null);
            v.gpu = o.optString("gpu");
            v.cpuSeconds = o.optDouble("cpuSeconds", 0);
            v.gpuSeconds = o.optDouble("gpuSeconds", 0);
            v.agreement = o.optDouble("agreement", 0);
            v.error = o.optString("error");
            v.deaths = o.optInt("deaths", 0);
            v.running = o.optBoolean("running", false);
            return v;
        }

        /** Gives the right words on the GPU. */
        boolean works() {
            return "faster".equals(state) || "slower".equals(state);
        }
    }

    /**
     * The verdict as it stands for `key`, with what an earlier run left unfinished
     * counted: a check that never ended is a crash; so are DEATHS GPU runs in a row.
     */
    static Verdict settle(Verdict saved, String key) {
        Verdict v = saved == null || !key.equals(saved.key) ? new Verdict(key) : saved;
        if ("testing".equals(v.state)) v.state = "crashed";
        if (v.running) {
            v.running = false;
            v.deaths++;
            if (v.deaths >= DEATHS && v.works()) v.state = "crashed";
        }
        return v;
    }

    /** On the GPU, for the processor the user chose, by the verdict. */
    static boolean onGpu(Verdict v, String processor) {
        if (AUTO.equals(processor)) return "faster".equals(v.state);
        return GPU.equals(processor) && v.works();
    }

    /** The share of words two transcripts have in common, in order (0 to 1). */
    static double agreement(String a, String b) {
        String[] x = words(a);
        String[] y = words(b);
        if (x.length + y.length == 0) return 1;
        int[][] common = new int[x.length + 1][y.length + 1];
        for (int i = 1; i <= x.length; i++) {
            for (int j = 1; j <= y.length; j++) {
                common[i][j] = x[i - 1].equals(y[j - 1]) ? common[i - 1][j - 1] + 1 : Math.max(common[i - 1][j], common[i][j - 1]);
            }
        }
        return 2.0 * common[x.length][y.length] / (x.length + y.length);
    }

    private static String[] words(String text) {
        String plain = text.replaceAll("[^\\p{L}\\p{N}\\s]", " ").trim();
        return plain.isEmpty() ? new String[0] : plain.split("\\s+");
    }

    // --- on the phone ----------------------------------------------------------------

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("ivrit_turbo_gpu", Context.MODE_PRIVATE);
    }

    private static String key(String variant) {
        return Build.FINGERPRINT + " " + variant;
    }

    static Verdict load(Context context) {
        try {
            String saved = prefs(context).getString("verdict", null);
            return saved == null ? null : Verdict.of(new JSONObject(saved));
        } catch (Exception e) {
            return null;
        }
    }

    // Written at once (commit): a crash right after must find it.
    private static void save(Context context, Verdict v) {
        try {
            prefs(context).edit().putString("verdict", v.json().toString()).commit();
        } catch (Exception ignored) {
            // Only what was learnt is lost: the check runs again.
        }
    }

    /**
     * The verdict for the chosen model on this phone, checking the GPU first where it
     * has not been (`checking` says so, as it takes a minute).
     */
    static Verdict decide(Context context, String variant, String processor, Runnable checking) throws Exception {
        Verdict v = settle(load(context), key(variant));
        save(context, v);
        if (v.state == null && !CPU.equals(processor)) {
            checking.run();
            check(context, variant, v);
        }
        return v;
    }

    /** A GPU run starts: if it never finishes, the next decide() counts it. */
    static void started(Context context) {
        Verdict v = load(context);
        if (v == null) return;
        v.running = true;
        save(context, v);
    }

    /** A GPU run finished. */
    static void finished(Context context) {
        Verdict v = load(context);
        if (v == null) return;
        v.running = false;
        v.deaths = 0;
        save(context, v);
    }

    private static void check(Context context, String variant, Verdict v) throws Exception {
        v.state = "testing";
        save(context, v);
        try {
            String gpu = Whisper.gpu();
            if (gpu == null) {
                v.state = "none";
            } else {
                v.gpu = gpu;
                float[] sound = sample(context);
                String path = Turbo.file(context, variant).getPath();
                long[] took = new long[1];
                String cpu = hear(path, false, sound, took);
                v.cpuSeconds = took[0] / 1000.0;
                hear(path, true, sound, took); // builds the shaders
                String onGpu = hear(path, true, sound, took);
                v.gpuSeconds = took[0] / 1000.0;
                v.agreement = agreement(cpu, onGpu);
                v.state = v.agreement < AGREEMENT ? "wrong" : v.gpuSeconds < v.cpuSeconds ? "faster" : "slower";
            }
        } catch (Exception e) {
            // Out of memory on the GPU, say: the CPU, then.
            v.state = "failed";
            v.error = String.valueOf(e.getMessage());
        }
        save(context, v);
        LocalTranscribeWorker.post(context, "local-turbo-gpu", v.json().put("engine", Turbo.engine(variant))
            .put("threads", Turbo.threads()).put("system", Whisper.system()));
    }

    /** The sample's words, on the GPU or not; took[0]: how long, in milliseconds. */
    private static String hear(String path, boolean gpu, float[] sound, long[] took) {
        long handle = Whisper.load(path, gpu);
        if (handle == 0) throw new IllegalStateException("the Turbo model did not load" + (gpu ? " on the GPU" : ""));
        try {
            long started = System.currentTimeMillis();
            Object[] heard = Whisper.transcribe(handle, sound, Turbo.LANGUAGE, Turbo.threads(), Turbo.BEAMS, null);
            took[0] = System.currentTimeMillis() - started;
            if (heard == null) throw new IllegalStateException("stopped");
            StringBuilder text = new StringBuilder();
            for (Segments.Word w : TurboWords.words((byte[]) heard[0], (int[]) heard[1], (int[]) heard[2], ((int[]) heard[1]).length, 0)) {
                text.append(w.text).append(' ');
            }
            return text.toString();
        } finally {
            Whisper.free(handle);
        }
    }

    /** The check's recording, 16 kHz mono. */
    private static float[] sample(Context context) throws Exception {
        Uri uri = Uri.parse("android.resource://" + context.getPackageName() + "/" + R.raw.turbo_check);
        List<float[]> parts = new ArrayList<>();
        Resampler[] resampler = {null};
        AudioDecoder.decode(context, uri, 0, (samples, sampleRate, at) -> {
            if (resampler[0] == null) resampler[0] = new Resampler(sampleRate);
            parts.add(resampler[0].push(samples));
        });
        if (resampler[0] != null) parts.add(resampler[0].flush());
        int length = 0;
        for (float[] p : parts) length += p.length;
        float[] out = new float[length];
        int at = 0;
        for (float[] p : parts) {
            System.arraycopy(p, 0, out, at, p.length);
            at += p.length;
        }
        return out;
    }
}
