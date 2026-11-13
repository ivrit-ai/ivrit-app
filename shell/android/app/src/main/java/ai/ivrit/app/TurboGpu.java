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
 * time, and reported with the step it died in and, from Android 11, the phone's own
 * record of the crash (kind=local-turbo-gpu-crash). The check then runs again with
 * safer settings for ggml's Vulkan backend (LEVELS: first without cooperative
 * matrices, which only newer GPUs have, as Adreno 8xx), and only after the last one
 * also dies is the GPU given up. GPU runs dying twice in a row count as a crash too.
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
    /** ggml-vulkan's switches (environment variables) for each try, safest last. */
    static final String[][] LEVELS = {
        {},
        {"GGML_VK_DISABLE_COOPMAT", "GGML_VK_DISABLE_COOPMAT2"},
        {"GGML_VK_DISABLE_COOPMAT", "GGML_VK_DISABLE_COOPMAT2"},
        {"GGML_VK_DISABLE_COOPMAT", "GGML_VK_DISABLE_COOPMAT2", "GGML_VK_DISABLE_INTEGER_DOT_PRODUCT", "GGML_VK_DISABLE_F16", "GGML_VK_DISABLE_FUSION"},
    };
    /** From this level on, whisper.cpp runs without flash attention (its shaders are a usual suspect). */
    static final int NO_FLASH = 2;
    /** These levels' version: verdicts from an earlier one are carried over (Verdict.of). */
    static final int LADDER = 2;

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
        int level; // the LEVELS settings it holds for
        String step = ""; // how far the check got: "probe", "cpu", "gpu-load", "gpu-shaders", "gpu-run"
        long since; // when the check or GPU run started (milliseconds)
        String crashes = ""; // what died so far: "level:step " each
        String crashed; // set by settle when it found one just now (not kept)

        Verdict(String key) {
            this.key = key;
        }

        JSONObject json() throws Exception {
            return new JSONObject().put("key", key).put("state", state == null ? JSONObject.NULL : state).put("gpu", gpu)
                .put("cpuSeconds", cpuSeconds).put("gpuSeconds", gpuSeconds).put("agreement", agreement)
                .put("error", error).put("deaths", deaths).put("running", running).put("level", level).put("step", step)
                .put("since", since).put("crashes", crashes).put("ladder", LADDER);
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
            v.level = o.optInt("level", 0);
            v.step = o.optString("step");
            v.since = o.optLong("since", 0);
            v.crashes = o.optString("crashes");
            // Kept before there were levels (build 249): a crash there was at the first.
            if (!o.has("level") && "crashed".equals(v.state)) {
                v.crashed = "0:" + (v.gpu.isEmpty() ? "probe" : "?");
                v.crashes = v.crashed + " ";
                v.level = 1;
                v.state = null;
            }
            // Build 250's levels were 0 and 1 as now, and 2 became 3: having crashed
            // there, go on from the level put in between (no flash attention).
            if (o.optInt("ladder", 1) < LADDER && "crashed".equals(v.state) && v.level >= 2) {
                v.level = NO_FLASH;
                v.state = null;
            }
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
     * After a crash the check runs again at the next, safer LEVELS, and the GPU is
     * given up ("crashed") only when the last has crashed too.
     */
    static Verdict settle(Verdict saved, String key) {
        Verdict v = saved == null || !key.equals(saved.key) ? new Verdict(key) : saved;
        if ("testing".equals(v.state)) crash(v, v.step);
        if (v.running) {
            v.running = false;
            v.deaths++;
            if (v.deaths >= DEATHS && v.works()) crash(v, "run");
        }
        return v;
    }

    private static void crash(Verdict v, String where) {
        v.crashed = v.level + ":" + where;
        v.crashes += v.crashed + " ";
        v.deaths = 0;
        if (v.level + 1 < LEVELS.length) {
            v.level++;
            v.state = null; // checked again, more carefully
        } else {
            v.state = "crashed";
        }
    }

    /** Flash attention at the verdict's level. */
    static boolean flash(Verdict v) {
        return v.level < NO_FLASH;
    }

    /** What ggml and whisper.cpp say while the GPU works, kept for a crash's report. */
    static void log(Context context) {
        Whisper.logTo(new java.io.File(context.getFilesDir(), "turbo-gpu.log").getPath());
    }

    /** The settings for the verdict's level, set before ggml first starts the GPU in this process. */
    static void apply(Verdict v) {
        for (String name : LEVELS[Math.min(v.level, LEVELS.length - 1)]) {
            try {
                android.system.Os.setenv(name, "1", true);
            } catch (Exception ignored) {
                // Not set: the GPU runs as at the level before.
            }
        }
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
        Verdict saved = load(context);
        Verdict v = settle(saved, key(variant));
        save(context, v);
        if (v.crashed != null) reportCrash(context, variant, v);
        apply(v);
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
        v.since = System.currentTimeMillis();
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
        v.since = System.currentTimeMillis();
        log(context);
        step(context, v, "probe");
        try {
            String gpu = Whisper.gpu();
            if (gpu == null) {
                v.state = "none";
            } else {
                v.gpu = gpu;
                step(context, v, "cpu");
                float[] sound = sample(context);
                String path = Turbo.file(context, variant).getPath();
                long[] took = new long[1];
                String cpu = hear(path, false, true, sound, took);
                v.cpuSeconds = took[0] / 1000.0;
                step(context, v, "gpu-shaders");
                hear(path, true, flash(v), sound, took); // builds the shaders
                step(context, v, "gpu-run");
                String onGpu = hear(path, true, flash(v), sound, took);
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

    // Kept at once, so a crash in it says where.
    private static void step(Context context, Verdict v, String step) {
        v.step = step;
        save(context, v);
    }

    /**
     * A check or GPU run that died, to the site's log: where, at which level, and the
     * phone's own record of it (Android 11 on: the crash's description and, for a
     * native crash, its tombstone, for symbols from the build's unstripped library).
     */
    private static void reportCrash(Context context, String variant, Verdict v) {
        try {
            JSONObject body = new JSONObject().put("engine", Turbo.engine(variant)).put("crashed", v.crashed)
                .put("verdict", v.json());
            if (Build.VERSION.SDK_INT >= 30) {
                android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                org.json.JSONArray exits = new org.json.JSONArray();
                for (android.app.ApplicationExitInfo exit : am.getHistoricalProcessExitReasons(null, 0, 10)) {
                    if (exit.getTimestamp() < v.since - 1000) continue;
                    JSONObject e = new JSONObject().put("process", exit.getProcessName()).put("pid", exit.getPid())
                        .put("reason", exit.getReason()).put("description", String.valueOf(exit.getDescription()))
                        .put("status", exit.getStatus()).put("pss", exit.getPss()).put("rss", exit.getRss()).put("at", exit.getTimestamp());
                    if (exit.getReason() == android.app.ApplicationExitInfo.REASON_CRASH_NATIVE) {
                        try (java.io.InputStream trace = exit.getTraceInputStream()) {
                            if (trace != null) e.put("tombstone", android.util.Base64.encodeToString(head(trace, 512 << 10), android.util.Base64.NO_WRAP));
                        }
                    }
                    exits.put(e);
                }
                body.put("exits", exits);
            }
            java.io.File log = new java.io.File(context.getFilesDir(), "turbo-gpu.log");
            if (log.isFile()) {
                try (java.io.RandomAccessFile f = new java.io.RandomAccessFile(log, "r")) {
                    long from = Math.max(0, f.length() - (48 << 10));
                    byte[] tail = new byte[(int) (f.length() - from)];
                    f.seek(from);
                    f.readFully(tail);
                    body.put("log", new String(tail, java.nio.charset.StandardCharsets.UTF_8));
                }
            }
            LocalTranscribeWorker.post(context, "local-turbo-gpu-crash", body);
        } catch (Exception ignored) {
            // Only the report is lost.
        }
    }

    private static byte[] head(java.io.InputStream in, int most) throws java.io.IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        for (int n; out.size() < most && (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
        return out.toByteArray();
    }

    /** The sample's words, on the GPU or not; took[0]: how long, in milliseconds. */
    private static String hear(String path, boolean gpu, boolean flash, float[] sound, long[] took) {
        long handle = Whisper.load(path, gpu, flash);
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
