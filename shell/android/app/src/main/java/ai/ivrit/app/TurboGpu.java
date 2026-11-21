package ai.ivrit.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import java.io.File;
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
 * OpenCL first (Adreno's alone), then WebGPU, then ggml-vulkan with ever safer
 * switches. A level fails when ggml
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
    static final String TRIAL = "webgpu"; // the Lab's WebGPU trial (trial())
    static final String[] PROCESSORS = {AUTO, CPU, GPU, TRIAL};
    /** The GPU's words against the CPU's: a little apart is half floats, more is a broken driver. */
    static final double AGREEMENT = 0.85;
    /** GPU runs that died in a row before the level is given up. */
    static final int DEATHS = 2;

    /** How far a check got, 0 to 1, for the notification and the page. */
    interface Progress {
        void at(double fraction);
    }

    /** A way to run on the GPU: one of ggml's backends, with switches. */
    static final class Level {
        final String backend; // in ggml's device name: "OpenCL" (GPUOpenCL), "WebGPU", "Vulkan" (Vulkan0)
        final String[] env; // the backend's switches ("NAME", or "NAME=VALUE"), set before ggml starts it
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
    // patches/ggml-webgpu-phones.patch: Dawn's bounds checks kept, features left unused, the phone programs.
    private static final String WEBGPU = "GGML_WEBGPU_";
    private static final String WEBGPU_ROBUSTNESS = "GGML_WEBGPU_KEEP_ROBUSTNESS";
    private static final String WEBGPU_NO_MATRIX = "GGML_WEBGPU_DISABLE_SUBGROUP_MATRIX";

    /**
     * Safest last. On the Galaxy S25 (Adreno 830), ggml-vulkan: with cooperative
     * matrices the GPU did not start; without, the driver refused the q8_0
     * matrix-vector shader (also with robustness kept); without subgroup reductions
     * it hung; with everything off its words were wrong. Hence WebGPU first. As
     * ggml-webgpu has it (no bounds checks, cooperative matrices), the S25 lost the
     * device on the first work sent, with flash attention and without (build 254):
     * so it is not tried so. OpenCL (ggml-opencl, which takes Adreno GPUs alone)
     * gave the CPU's very words there, twice as fast (over adb).
     */
    static final Level[] LEVELS = {
        new Level("OpenCL", true),
        new Level("WebGPU", true, WEBGPU_ROBUSTNESS, WEBGPU_NO_MATRIX),
        new Level("WebGPU", false, WEBGPU_ROBUSTNESS, WEBGPU_NO_MATRIX,
            "GGML_WEBGPU_DISABLE_SUBGROUPS", "GGML_WEBGPU_DISABLE_DOT_PRODUCT"),
        new Level("Vulkan", true),
        new Level("Vulkan", true, NO_COOPMAT, NO_COOPMAT2),
        new Level("Vulkan", true, NO_COOPMAT, NO_COOPMAT2, KEEP_ROBUSTNESS),
        new Level("Vulkan", true, NO_COOPMAT, NO_COOPMAT2, KEEP_ROBUSTNESS, NO_SUBGROUPS),
        new Level("Vulkan", false, NO_COOPMAT, NO_COOPMAT2, KEEP_ROBUSTNESS, NO_SUBGROUPS,
            "GGML_VK_DISABLE_INTEGER_DOT_PRODUCT", "GGML_VK_DISABLE_F16", "GGML_VK_DISABLE_FUSION"),
    };
    /**
     * These levels' version: a verdict from an earlier one starts over (Verdict.of).
     * 7: the check's run includes DTW's pass for word times (shell/native/transcript).
     * 8: the GPU's run with beam search (Turbo.beams), the CPU's greedy.
     * 9: the decoder's threads tuned, and a run with the decoder on the CPU.
     */
    static final int LADDER = 9;

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
        int decodeThreads; // the decoder's fastest thread count here (Whisper.tuneDecoder); 0: not yet tuned
        boolean decoderCpu; // the decoder faster on the CPU, the encoder on the GPU (Whisper.load)
        Level forced; // the trial's level (trial()), not one of LEVELS; never saved
        double splitSeconds; // the timed GPU run with the decoder on the CPU

        Verdict(String key) {
            this.key = key;
        }

        JSONObject json() throws Exception {
            return new JSONObject().put("key", key).put("state", state == null ? JSONObject.NULL : state).put("gpu", gpu)
                .put("cpuSeconds", cpuSeconds).put("gpuSeconds", gpuSeconds).put("agreement", agreement)
                .put("error", error).put("deaths", deaths).put("running", running).put("level", level).put("step", step)
                .put("since", since).put("crashes", crashes).put("ladder", LADDER)
                .put("decodeThreads", decodeThreads).put("decoderCpu", decoderCpu).put("splitSeconds", splitSeconds)
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
            v.decodeThreads = o.optInt("decodeThreads", 0);
            v.decoderCpu = o.optBoolean("decoderCpu", false);
            v.splitSeconds = o.optDouble("splitSeconds", 0);
            return v;
        }

        Level level() {
            return forced != null ? forced : LEVELS[level];
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
        if ("testing".equals(v.state) && "gpu-split".equals(v.step)) {
            // The GPU passed; only the decoder on the CPU beside it died: not that, then.
            v.crashes += v.level + ":gpu-split ";
            v.decoderCpu = false;
            v.state = v.gpuSeconds < v.cpuSeconds ? "faster" : "slower";
        }
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
        for (int i = 0; i < gpus.length; i++) {
            String name = gpus[i].split(":", 2)[0];
            if (name.contains(backend)) return i;
        }
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

    /**
     * Ready ahead (PrepareWorker): the decoder's threads tuned, on the CPU, on the
     * check's own recording. Not the GPU's check: a driver that crashes takes the app's
     * process with it, and the app is often open then (the work starts with it); a
     * recording checks it, in the background, as before.
     */
    static void prepare(Context context, String variant) throws Exception {
        Verdict v = load(context);
        if (v == null || !key(variant).equals(v.key)) v = new Verdict(key(variant));
        if (v.decodeThreads > 0) return;
        long handle = Whisper.load(Turbo.file(context, variant).getPath(), -1, true, false);
        if (handle == 0) throw new IllegalStateException("the Turbo model did not load");
        try {
            float[] sound = sample(context);
            int threads = Whisper.tuneDecoder(handle, sound, sound.length, Turbo.threads());
            if (threads > 0) {
                v.decodeThreads = threads;
                save(context, v);
            }
        } finally {
            Whisper.free(handle);
        }
    }

    /** What PrepareWorker can do is done: the decoder tuned (the GPU's check is a recording's). */
    static boolean prepared(Context context, String variant) {
        Verdict v = load(context);
        return v != null && key(variant).equals(v.key) && v.decodeThreads > 0;
    }

    /**
     * The decoder's threads tuned on this phone where the check did not (no GPU, or
     * the CPU chosen): kept with the verdict, for its system build.
     */
    static void tuned(Context context, String variant, int threads) {
        Verdict v = load(context);
        if (v == null || !key(variant).equals(v.key)) return;
        v.decodeThreads = threads;
        save(context, v);
    }

    /** What ggml and whisper.cpp say while the GPU works, kept for a failure's report. */
    static void log(Context context) {
        Whisper.logTo(new java.io.File(context.getFilesDir(), "turbo-gpu.log").getPath());
    }

    /**
     * ggml-opencl keeps its built kernels (seconds' work) where it is told, before
     * it starts: else in a temporary directory an app may not have.
     */
    private static void caches(Context context) {
        try {
            File dir = new File(context.getCacheDir(), "opencl");
            dir.mkdirs();
            android.system.Os.setenv("GGML_OPENCL_KERNEL_CACHE_DIR", dir.getPath(), false);
        } catch (Exception ignored) {
            // Built again each time.
        }
    }

    /** ggml-webgpu's switches as the process set them first, or null before any. */
    private static String webgpuSet;

    /** The switches of a level as one string, those of ggml-webgpu alone. */
    static String webgpu(Level level) {
        StringBuilder set = new StringBuilder();
        for (String name : level.env) if (name.startsWith(WEBGPU)) set.append(name).append(' ');
        return set.toString();
    }

    /**
     * Whether the level's switches can be had in this process: ggml-webgpu reads
     * its own once, as ggml first starts (which the first apply() comes before), so a
     * WebGPU level after another in one process needs a new one.
     */
    private static boolean applicable(Level level) {
        return !"WebGPU".equals(level.backend) || webgpuSet == null || webgpuSet.equals(webgpu(level));
    }

    /** The level's switches, set before ggml first starts that GPU backend in this process. */
    private static void apply(Level level) {
        if (webgpuSet == null) webgpuSet = webgpu(level);
        for (String name : level.env) {
            try {
                int eq = name.indexOf('=');
                android.system.Os.setenv(eq < 0 ? name : name.substring(0, eq), eq < 0 ? "1" : name.substring(eq + 1), true);
            } catch (Exception ignored) {
                // Not set: the GPU runs as at the level before.
            }
        }
    }

    /**
     * The verdict for the chosen model on this phone, checking the GPU first where it
     * has not been (`checking` follows it, as it takes a minute). Not while the app is
     * on the screen: a driver that crashes takes the app with it, so that recording
     * goes on the CPU, and a later one, in the background, checks.
     */
    static Verdict decide(Context context, String variant, String processor, Progress checking) throws Exception {
        caches(context);
        Verdict v = settle(load(context), key(variant));
        save(context, v);
        if (v.crashed != null) report(context, variant, v);
        if (v.state == null && !CPU.equals(processor) && !onScreen()) {
            checking.at(0);
            check(context, variant, v, checking);
        }
        apply(v.level());
        return v;
    }

    /** The app is in front of the user (an activity showing), not only working in the background. */
    private static boolean onScreen() {
        android.app.ActivityManager.RunningAppProcessInfo me = new android.app.ActivityManager.RunningAppProcessInfo();
        android.app.ActivityManager.getMyMemoryState(me);
        return me.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }

    /**
     * The Lab's trial of WebGPU with the app's own programs for phone GPUs
     * (patches/ggml-webgpu-phones.patch, GGML_WEBGPU_MOBILE: a matrix multiply and a
     * flash attention that need no subgroups; with subgroups, Adreno's and Mali's
     * drivers stop the work as too slow and lose the device): the encoder on WebGPU,
     * the decoder on the CPU, without the check (the benchmark's words judge it).
     * Its switches are set as the library loads (early()), as ggml reads them once;
     * chosen with the app running, it needs the app started again. A failure, or the
     * process dying in it, puts it back on the CPU until it is chosen again or the
     * app is updated (a new build may have fixed it), and is reported
     * (kind=local-turbo-gpu-crash, crashed "trial:...").
     */
    // GPU work 8 kernels a submission: a phone's driver stops a long one (as Windows' does).
    static final Level TRIAL_LEVEL = new Level("WebGPU", true, "GGML_WEBGPU_MOBILE", WEBGPU_NO_MATRIX,
        "GGML_WEBGPU_DISABLE_SUBGROUPS", "GGML_WEBGPU_DISABLE_DOT_PRODUCT", "GGML_WEBGPU_SUBMIT_BATCH=8");

    /** Before the library loads (Turbo.supported): the trial's switches, where it is chosen. */
    static void early(Context context) {
        if (TRIAL.equals(Store.turboProcessor(context)) && trialFailure(context) == null) {
            apply(TRIAL_LEVEL);
        }
    }

    /** The trial as it stands here: "ready", "restart" (the app must start again), or "failed: ..." */
    static String trialState(Context context) {
        String failed = trialFailure(context);
        if (failed != null) return "failed: " + failed;
        return webgpu(TRIAL_LEVEL).equals(webgpuSet) ? "ready" : "restart";
    }

    /** Why the trial failed in this build, or null (none, or in an earlier build). */
    static String trialFailure(Context context) {
        android.content.SharedPreferences p = prefs(context);
        return p.getLong("trial_failed_build", 0) == build(context) ? p.getString("trial_failed", null) : null;
    }

    /** The app's build number (versionCode), or 0. */
    @SuppressWarnings("deprecation") // getLongVersionCode: Android 9 on
    static long build(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    /** Chosen (again): an earlier failure forgotten. */
    static void trialReset(Context context) {
        prefs(context).edit().remove("trial_failed").remove("trial_running").commit();
    }

    /**
     * A verdict for one run with the trial: state "trial" when it is to run on
     * WebGPU, else why not (the run goes on the CPU). A run that died in it is
     * found here, the next time.
     */
    static Verdict trial(Context context, String variant) {
        caches(context);
        android.content.SharedPreferences p = prefs(context);
        Verdict v = new Verdict(key(variant));
        Verdict saved = load(context);
        if (saved != null && v.key.equals(saved.key)) v.decodeThreads = saved.decodeThreads;
        v.forced = TRIAL_LEVEL;
        v.decoderCpu = true;
        if (p.getBoolean("trial_running", false)) {
            v.since = p.getLong("trial_since", 0);
            v.crashed = "trial:run";
            v.step = "trial";
            p.edit().putBoolean("trial_running", false).putString("trial_failed", "crashed")
                .putLong("trial_failed_build", build(context)).commit();
            report(context, variant, v);
            v.crashed = null;
        }
        String state = trialState(context);
        v.state = "ready".equals(state) ? "trial" : state;
        if ("trial".equals(v.state)) {
            for (String g : Whisper.gpus()) if (g.startsWith(TRIAL_LEVEL.backend)) v.gpu = g;
        }
        return v;
    }

    static void trialStarted(Context context) {
        prefs(context).edit().putBoolean("trial_running", true).putLong("trial_since", System.currentTimeMillis()).commit();
    }

    static void trialFinished(Context context) {
        prefs(context).edit().putBoolean("trial_running", false).commit();
    }

    /** ggml failed on WebGPU (guard.cpp; the patch throws where ggml-webgpu ended the process): reported, then the CPU. */
    static void trialFailed(Context context, String variant, String why) {
        android.content.SharedPreferences p = prefs(context);
        Verdict v = new Verdict(key(variant));
        v.since = p.getLong("trial_since", 0);
        v.crashed = "trial:failed";
        v.step = "trial";
        v.error = why == null ? "" : why;
        p.edit().putBoolean("trial_running", false).putString("trial_failed", v.error.isEmpty() ? "failed" : v.error)
            .putLong("trial_failed_build", build(context)).commit();
        report(context, variant, v);
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

    /**
     * Each step's share of the check: starting the GPU, the CPU, the GPU's first run,
     * its timed one, and one more with the decoder on the CPU.
     */
    private static final double[] STEPS = {0, 0.05, 0.30, 0.55, 0.78, 1};

    /** Whisper's percent within step `i`, as the check's progress. */
    private static Whisper.Listener within(Progress progress, int i) {
        progress.at(STEPS[i]);
        return percent -> progress.at(STEPS[i] + (STEPS[i + 1] - STEPS[i]) * percent / 100.0);
    }

    private static void check(Context context, String variant, Verdict v, Progress progress) throws Exception {
        if (!applicable(v.level())) {
            // A WebGPU level after another failed in this process (not by crashing): in a
            // new one, as a crash would have it (WorkManager starts the work again).
            android.os.Process.killProcess(android.os.Process.myPid());
        }
        apply(v.level());
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
            // Each as it would transcribe: the CPU greedily, the GPU with beam search; the
            // decoder's threads tuned first (the CPU's run), for the CPU and the split.
            int[] tuned = {v.decodeThreads};
            String cpu = hear(path, -1, true, false, tuned, sound, took, within(progress, 1));
            v.decodeThreads = tuned[0];
            v.cpuSeconds = took[0] / 1000.0;
            // Shaders take a while to build the first time; past these, the GPU has hung.
            long limit = Math.max(120_000, 10 * took[0]);
            step(context, v, "gpu-shaders");
            try (Watchdog ignored = new Watchdog(context, variant, v, v.step, limit)) {
                hear(path, device, level.flash, false, tuned, sound, took, within(progress, 2));
            }
            step(context, v, "gpu-run");
            String onGpu;
            try (Watchdog ignored = new Watchdog(context, variant, v, v.step, limit)) {
                onGpu = hear(path, device, level.flash, false, tuned, sound, took, within(progress, 3));
            }
            v.gpuSeconds = took[0] / 1000.0;
            v.agreement = agreement(cpu, onGpu);
            if (v.agreement < AGREEMENT) {
                fail(v, "wrong", "wrong");
                save(context, v);
                report(context, variant, v);
                return;
            }
            // The decoder on the CPU, the encoder on the GPU: on the Galaxy S25 40%
            // faster, as its CPU takes the decoder's small steps faster than its GPU.
            step(context, v, "gpu-split");
            String split = "";
            try (Watchdog ignored = new Watchdog(context, variant, v, v.step, limit)) {
                split = hear(path, device, level.flash, true, tuned, sound, took, within(progress, 4));
                v.splitSeconds = took[0] / 1000.0;
            } catch (Exception e) {
                v.error = "split: " + e.getMessage(); // the GPU passed: only not split, then
            }
            v.decoderCpu = !split.isEmpty() && agreement(cpu, split) >= AGREEMENT && v.splitSeconds < v.gpuSeconds;
            double onGpuSeconds = v.decoderCpu ? v.splitSeconds : v.gpuSeconds;
            v.state = onGpuSeconds < v.cpuSeconds ? "faster" : "slower";
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

    /**
     * The sample's words on a GPU device (-1: the CPU), the decoder on the CPU or not;
     * took[0]: how long, in milliseconds. tuned[0]: the decoder's threads, tuned first
     * (and set) when 0.
     */
    private static String hear(String path, int device, boolean flash, boolean decoderCpu, int[] tuned, float[] sound,
                               long[] took, Whisper.Listener progress) {
        long handle = Whisper.load(path, device, flash, decoderCpu);
        if (handle == 0) throw new IllegalStateException("the Turbo model did not load" + (device >= 0 ? " on the GPU" : ""));
        try {
            if (tuned[0] <= 0) tuned[0] = Whisper.tuneDecoder(handle, sound, sound.length, Turbo.threads());
            long started = System.currentTimeMillis();
            Object[] heard = Whisper.transcribe(handle, sound, Turbo.LANGUAGE, Turbo.threads(), tuned[0], Turbo.beams(device >= 0),
                progress, 0, true, new double[6], Whisper.prompt());
            took[0] = System.currentTimeMillis() - started;
            if (heard == null) throw new IllegalStateException("stopped");
            StringBuilder text = new StringBuilder();
            for (TurboTranscript.Segment s : TurboTranscript.piece(heard)) {
                for (Segments.Word w : s.words) text.append(w.text.trim()).append(' ');
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
