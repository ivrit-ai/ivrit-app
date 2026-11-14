package ai.ivrit.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Whether the Turbo model runs on the phone's GPU or its CPU, and through which of
 * ggml's GPU backends: WebGPU (Google's Dawn, built into the app, on the phone's
 * Vulkan driver, with Dawn's own shaders and its workarounds for drivers' bugs) or
 * Vulkan directly (ggml-vulkan).
 *
 * Phones' GPU drivers vary, and a bad one can give wrong text, hang, or bring the app
 * down, so the GPU is used only once it has passed a check on this phone, for this
 * build of its system (drivers come with it) and this model: a 12-second Hebrew
 * recording (res/raw/turbo_check, store/fixtures/hebrew-12s.ogg) on the CPU, then on
 * the GPU, twice (the first run also builds its shaders). It passes when the GPU's
 * words agree with the CPU's (AGREEMENT) and its second run is faster. What it found
 * is reported to the site (POST /lab/report?kind=local-turbo-gpu).
 *
 * The check tries LEVELS one at a time, a level per transcription, until one passes:
 * WebGPU first, then ggml-vulkan with ever safer switches. A level fails when ggml
 * says so (the driver refusing a shader: guard.cpp), when the process dies in it
 * (found the next time), when a GPU step runs far past its time (Watchdog: the
 * process is ended, as a hung GPU cannot be interrupted), or, for GPU runs after a
 * pass, when two die in a row. Each failure is reported (kind=local-turbo-gpu-crash)
 * with the step, ggml's log, and from Android 11 the phone's exit records with native
 * tombstones; the recording goes on on the CPU. After the last level, the GPU is
 * given up.
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
    /** GPU runs that died in a row before the level is given up. */
    static final int DEATHS = 2;

    /** A way to run on the GPU: one of ggml's backends, with switches. */
    static final class Level {
        final String backend; // ggml's device name starts so: "WebGPU", "Vulkan"
        final String[] env; // ggml-vulkan's switches, set before it starts the GPU
        final boolean flash; // whisper.cpp's flash attention

        Level(String backend, boolean flash, String... env) {
            this.backend = backend;
            this.flash = flash;
            this.env = env;
        }
    }

    private static final String NO_COOPMAT = "GGML_VK_DISABLE_COOPMAT";
    private static final String NO_COOPMAT2 = "GGML_VK_DISABLE_COOPMAT2";
    // The app's own (patches/ggml-vulkan-switches.patch).
    private static final String KEEP_ROBUSTNESS = "GGML_VK_KEEP_ROBUSTNESS";
    private static final String NO_SUBGROUPS = "GGML_VK_DISABLE_SUBGROUP_ARITHMETIC";

    /**
     * Safest last. On the Galaxy S25 (Adreno 830), ggml-vulkan: with cooperative
     * matrices the GPU did not start; without, the driver refused the q8_0
     * matrix-vector shader (also with robustness kept); without subgroup reductions
     * it hung; with everything off its words were wrong. Hence WebGPU first.
     */
    static final Level[] LEVELS = {
        new Level("WebGPU", true),
        new Level("WebGPU", false),
        new Level("Vulkan", true),
        new Level("Vulkan", true, NO_COOPMAT, NO_COOPMAT2),
        new Level("Vulkan", true, NO_COOPMAT, NO_COOPMAT2, KEEP_ROBUSTNESS),
        new Level("Vulkan", true, NO_COOPMAT, NO_COOPMAT2, KEEP_ROBUSTNESS, NO_SUBGROUPS),
        new Level("Vulkan", false, NO_COOPMAT, NO_COOPMAT2, KEEP_ROBUSTNESS, NO_SUBGROUPS,
            "GGML_VK_DISABLE_INTEGER_DOT_PRODUCT", "GGML_VK_DISABLE_F16", "GGML_VK_DISABLE_FUSION"),
    };
    /** These levels' version: a verdict from an earlier one starts over (Verdict.of). */
    static final int LADDER = 4;

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
        int level; // the LEVELS entry it holds for
        String step = ""; // how far the check got: "probe", "cpu", "gpu-shaders", "gpu-run"
        long since; // when the check or GPU run started (milliseconds)
        String crashes = ""; // what failed so far: "level:step " each
        String crashed; // set when one failed just now (not kept)

        Verdict(String key) {
            this.key = key;
        }

        JSONObject json() throws Exception {
            return new JSONObject().put("key", key).put("state", state == null ? JSONObject.NULL : state).put("gpu", gpu)
                .put("cpuSeconds", cpuSeconds).put("gpuSeconds", gpuSeconds).put("agreement", agreement)
                .put("error", error).put("deaths", deaths).put("running", running).put("level", level).put("step", step)
                .put("since", since).put("crashes", crashes).put("ladder", LADDER)
                .put("backend", level().backend).put("flash", level().flash);
        }

        static Verdict of(JSONObject o) {
            Verdict v = new Verdict(o.optString("key"));
            // An earlier ladder's levels mean something else: start over, keeping what failed.
            if (o.optInt("ladder", 1) < LADDER) {
                v.crashes = "ladder" + o.optInt("ladder", 1) + ":" + o.optString("crashes") + o.optString("state") + " ";
                return v;
            }
            v.state = o.isNull("state") ? null : o.optString("state", null);
            v.gpu = o.optString("gpu");
            v.cpuSeconds = o.optDouble("cpuSeconds", 0);
            v.gpuSeconds = o.optDouble("gpuSeconds", 0);
            v.agreement = o.optDouble("agreement", 0);
            v.error = o.optString("error");
            v.deaths = o.optInt("deaths", 0);
            v.running = o.optBoolean("running", false);
            v.level = Math.max(0, Math.min(LEVELS.length - 1, o.optInt("level", 0)));
            v.step = o.optString("step");
            v.since = o.optLong("since", 0);
            v.crashes = o.optString("crashes");
            return v;
        }

        Level level() {
            return LEVELS[level];
        }

        /** Gives the right words on the GPU. */
        boolean works() {
            return "faster".equals(state) || "slower".equals(state);
        }
    }

    /**
     * The verdict as it stands for `key`, with what an earlier run left unfinished
     * counted: a check that never ended failed its level; so did DEATHS GPU runs in
     * a row.
     */
    static Verdict settle(Verdict saved, String key) {
        Verdict v = saved == null || !key.equals(saved.key) ? new Verdict(key) : saved;
        if ("testing".equals(v.state)) fail(v, v.step, "crashed");
        if (v.running) {
            v.running = false;
            v.deaths++;
            if (v.deaths >= DEATHS && v.works()) fail(v, "run", "crashed");
        }
        return v;
    }

    /** Failed at this level: the next is checked next time, or, after the last, `last`. */
    static void fail(Verdict v, String where, String last) {
        v.crashed = v.level + ":" + where;
        v.crashes += v.crashed + " ";
        v.deaths = 0;
        if (v.level + 1 < LEVELS.length) {
            v.level++;
            v.state = null; // checked again, another way
        } else {
            v.state = last;
        }
    }

    /** On the GPU, for the processor the user chose, by the verdict. */
    static boolean onGpu(Verdict v, String processor) {
        if (AUTO.equals(processor)) return "faster".equals(v.state);
        return GPU.equals(processor) && v.works();
    }

    /** ggml's GPU device for a backend, among Whisper.gpus() (whisper.cpp's gpu_device), or -1. */
    static int device(String[] gpus, String backend) {
        for (int i = 0; i < gpus.length; i++) if (gpus[i].startsWith(backend)) return i;
        return -1;
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

    /** What ggml and whisper.cpp say while the GPU works, kept for a failure's report. */
    static void log(Context context) {
        Whisper.logTo(new java.io.File(context.getFilesDir(), "turbo-gpu.log").getPath());
    }

    /** The level's switches, set before ggml first starts that GPU backend in this process. */
    private static void apply(Level level) {
        for (String name : level.env) {
            try {
                android.system.Os.setenv(name, "1", true);
            } catch (Exception ignored) {
                // Not set: the GPU runs as at the level before.
            }
        }
    }

    /**
     * The verdict for the chosen model on this phone, checking the GPU first where it
     * has not been (`checking` says so, as it takes a minute).
     */
    static Verdict decide(Context context, String variant, String processor, Runnable checking) throws Exception {
        Verdict v = settle(load(context), key(variant));
        save(context, v);
        if (v.crashed != null) report(context, variant, v);
        if (v.state == null && !CPU.equals(processor)) {
            checking.run();
            check(context, variant, v);
        }
        apply(v.level());
        return v;
    }

    /** ggml's device index for the verdict's backend, for Whisper.load, or -1 where it has none. */
    static int device(Verdict v) {
        return device(Whisper.gpus(), v.level().backend);
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
        // Levels whose backend this phone has no device for are passed over at once.
        String[] gpus = Whisper.gpus();
        while (device(gpus, v.level().backend) < 0) {
            if (v.level + 1 >= LEVELS.length) {
                v.state = "none";
                save(context, v);
                return;
            }
            v.level++;
        }
        Level level = v.level();
        apply(level);
        int device = device(gpus, level.backend);
        try {
            v.gpu = Whisper.probe(device) + " · " + level.backend;
            step(context, v, "cpu");
            float[] sound = sample(context);
            String path = Turbo.file(context, variant).getPath();
            long[] took = new long[1];
            String cpu = hear(path, -1, true, sound, took);
            v.cpuSeconds = took[0] / 1000.0;
            // Shaders take a while to build the first time; past these, the GPU has hung.
            long limit = Math.max(120_000, 10 * took[0]);
            step(context, v, "gpu-shaders");
            try (Watchdog ignored = new Watchdog(context, variant, v, v.step, limit)) {
                hear(path, device, level.flash, sound, took);
            }
            step(context, v, "gpu-run");
            String onGpu;
            try (Watchdog ignored = new Watchdog(context, variant, v, v.step, limit)) {
                onGpu = hear(path, device, level.flash, sound, took);
            }
            v.gpuSeconds = took[0] / 1000.0;
            v.agreement = agreement(cpu, onGpu);
            if (v.agreement < AGREEMENT) {
                fail(v, "wrong", "wrong");
                save(context, v);
                report(context, variant, v);
                return;
            }
            v.state = v.gpuSeconds < v.cpuSeconds ? "faster" : "slower";
        } catch (Exception e) {
            v.error = String.valueOf(e.getMessage());
            if ("cpu".equals(v.step)) {
                v.state = "failed"; // the sample or the CPU, not the GPU
            } else {
                // ggml said what failed (the driver refusing a shader, say): the next
                // level next time, and this recording on the CPU.
                fail(v, v.step, "failed");
                save(context, v);
                report(context, variant, v);
                return;
            }
        }
        save(context, v);
        LocalTranscribeWorker.post(context, "local-turbo-gpu", v.json().put("engine", Turbo.engine(variant))
            .put("threads", Turbo.threads()).put("system", Whisper.system()));
    }

    /** A GPU run failed with ggml saying why (not a crash): its level failed. */
    static void failed(Context context, String variant, String why) {
        Verdict v = load(context);
        if (v == null) return;
        v.running = false;
        v.error = String.valueOf(why);
        fail(v, "run", "failed");
        save(context, v);
        report(context, variant, v);
    }

    // Kept at once, so a crash in it says where.
    private static void step(Context context, Verdict v, String step) {
        v.step = step;
        save(context, v);
    }

    /**
     * A GPU step that runs past `millis` has hung, and a GPU cannot be interrupted:
     * its level failed, it is reported, and the process ends (WorkManager starts the
     * work again, on the CPU or the next level). Closed in time, it does nothing.
     */
    static final class Watchdog implements AutoCloseable {
        private final Thread thread;
        private volatile boolean done;

        Watchdog(Context context, String variant, Verdict v, String where, long millis) {
            thread = new Thread(() -> {
                try {
                    Thread.sleep(millis);
                } catch (InterruptedException e) {
                    return;
                }
                if (done) return;
                Verdict now = load(context);
                if (now == null) now = v;
                now.running = false;
                now.error = where + " still running after " + millis / 1000 + " s";
                fail(now, where + "-hung", "failed");
                save(context, now);
                report(context, variant, now);
                android.os.Process.killProcess(android.os.Process.myPid());
            }, "turbo-watchdog");
            thread.setDaemon(true);
            thread.start();
        }

        @Override
        public void close() {
            done = true;
            thread.interrupt();
        }
    }

    /**
     * A failed level, to the site's log: where, which, what ggml said last, and the
     * phone's own record of a process that died (Android 11 on: its description and,
     * for a native crash, its tombstone, for symbols from the build's unstripped
     * library).
     */
    private static void report(Context context, String variant, Verdict v) {
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

    /** The sample's words on a GPU device (-1: the CPU); took[0]: how long, in milliseconds. */
    private static String hear(String path, int device, boolean flash, float[] sound, long[] took) {
        long handle = Whisper.load(path, device, flash);
        if (handle == 0) throw new IllegalStateException("the Turbo model did not load" + (device >= 0 ? " on the GPU" : ""));
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
