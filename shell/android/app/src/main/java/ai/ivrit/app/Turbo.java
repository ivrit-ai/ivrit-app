package ai.ivrit.app;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import org.json.JSONObject;

/**
 * ivrit.ai's Turbo model (whisper-large-v3-turbo, trained further on Hebrew) on the
 * phone, with whisper.cpp (Whisper): far more accurate than the zipformer
 * (LocalModel), with speakers, and far larger and slower. It transcribes every
 * recording on the phones it is offered on (supported), on the GPU where it passes
 * its check (TurboGpu: OpenCL or WebGPU), else on the CPU. The zipformer transcribes
 * live, and recordings on other phones, and wherever Turbo turns out too slow or
 * keeps failing (chosen, off): a recording is never left waiting on Turbo.
 *
 * The model is ggml's q8_0, or q4_0 on phones with less than 8 GB (variant;
 * scripts/turbo_model.py), served by the site at /models/turbo/ and downloaded the
 * first time it is used, resumed where a download broke off, and checked against the
 * site's hash. Only the phone's one is kept. Its
 * transcripts have speakers, with the speaker model (Speakers) from there too.
 */
final class Turbo {
    private Turbo() {}

    /**
     * The sizes, chosen by the phone's memory (variant), not by its user: q8_0, as
     * accurate as the full model and fastest on ARM (ggml repacks it); q4_0, half its
     * memory and download, as fast and as accurate on a Galaxy S25 (106.5 s against
     * 107.5 for the benchmark, 2.39% of words wrong against 2.76%; docs/turbo-android.md,
     * decision 27). q5_1 is gone for good (decision 2): its download is let go (RETIRED).
     */
    static final String[] VARIANTS = {"q8_0", "q4_0"};
    private static final String[] RETIRED = {"q5_1"};

    /** A variant's download, as Settings tells it (scripts/turbo_model.py's files). */
    static int megabytes(String variant) {
        return "q4_0".equals(variant) ? 474 : 874;
    }

    /** This phone's size: q8_0 with 8 GB of memory or more, q4_0 with less. */
    static String variant(Context context) {
        if (testVariant != null) return testVariant;
        return memory(context) >= Q8_MEMORY ? "q8_0" : "q4_0";
    }

    /** Another size, for a test on the phone (TrialOnPhones' "variant"); null in use. */
    static String testVariant;
    static final String LANGUAGE = "he";
    /**
     * Beam search (5), as the server: on the GPU (OpenCL, Galaxy S25) it took about
     * as long as greedy decoding (0.6-0.7 of the recording's length either way); on
     * the CPU three times as long as greedy (3.0 against about 1.1), so the CPU
     * decodes greedily, which made 3 more mistakes in 544 words. The user may ask
     * for speed (Store.FAST): greedy on the GPU too, where the decoder dominates (a
     * Pixel 8a's Mali, the decoder on its CPU: 206 s against 392 for the benchmark,
     * 3 words of 536 different).
     */
    static final int GPU_BEAMS = 5;
    static final int CPU_BEAMS = 1;

    static int beams(Context context, boolean gpu) {
        return gpu && !Store.FAST.equals(Store.decoding(context)) ? GPU_BEAMS : CPU_BEAMS;
    }
    /**
     * Heard ten minutes at a time, with a checkpoint after each. Each cut hears a
     * sentence again (shell/native/transcript): 120-second pieces took 29% longer than one.
     */
    static final double CHUNK_SECONDS = 600;
    private static final long Q8_MEMORY = 6L << 30; // an 8 GB phone reports about 7.3 GB (6.8 GiB)
    private static final long MIN_MEMORY = 3L << 30; // a 4 GB phone reports about 3.6 GB (3.4 GiB)

    interface Progress {
        void downloaded(long done, long total);
    }

    static String engine(String variant) {
        return "whisper-turbo-he-" + variant;
    }

    /** The Turbo model to transcribe recordings with, or null for the zipformer where this phone cannot run it, or gave it up (off). */
    static String chosen(Context context) {
        String model = offered(context);
        return model != null && off(context) == null ? model : null;
    }

    /** The Turbo model this phone could run, given up on or not: what the benchmark measures. */
    static String offered(Context context) {
        String model = Store.onDeviceModel(context);
        return Arrays.asList(VARIANTS).contains(model) && supported(context) ? model : null;
    }

    private static String unsupported;

    /**
     * Any arm64 phone with dot products and half floats (the library is built for
     * them), Android 9 on, 4 GB (q4_0 below 8; variant): the GPU runs Turbo where it
     * passes its check (TurboGpu: OpenCL on Snapdragon, a third of the recording's
     * length on a Galaxy S25 with beam search; WebGPU with the app's own programs
     * elsewhere), else the CPU. Where that is too slow (SLOW), or Turbo keeps failing
     * (TRIES, GIVE_UP), the zipformer transcribes (docs/turbo-android.md, decision 28).
     * The GPU itself is the check's to judge, in the background (never here: a driver
     * that crashes takes the app with it).
     */
    static boolean supported(Context context) {
        return unsupported(context) == null;
    }

    /**
     * Why this phone cannot run Turbo (supported), for the page to tell the user once:
     * "android" (before 9), "processor" (not arm64, or without dot products and half
     * floats), "memory" (under 4 GB), "library" (the library would not load); null where it can.
     */
    static synchronized String unsupported(Context context) {
        if (unsupported == null) {
            unsupported = Build.VERSION.SDK_INT < 28 ? "android"
                : Build.SUPPORTED_ABIS.length == 0 || !"arm64-v8a".equals(Build.SUPPORTED_ABIS[0]) ? "processor"
                : memory(context) < MIN_MEMORY ? "memory"
                : !cpuFeatures().containsAll(Arrays.asList("asimddp", "asimdhp")) ? "processor"
                : !(early(context) && Whisper.available()) ? "library"
                : "";
        }
        return unsupported.isEmpty() ? null : unsupported;
    }

    /** The GPU backends' switches, before ggml can read them (TurboGpu.early). */
    private static boolean early(Context context) {
        TurboGpu.early(context);
        return true;
    }

    /**
     * Slower than this on the GPU check's recording (TurboGpu.pace: seconds per second of
     * sound, the way it would run), Turbo is not worth it here and the zipformer
     * transcribes. The 12-second recording costs a whole 30-second window, so it reads
     * slower than a long one: the Galaxy S25's CPU 1.2-1.35 there against 1.1 over five
     * minutes; a Galaxy S24's Xclipse 2.2 there.
     */
    static final double SLOW = 3.0;
    /** Turbo runs a recording may start without finishing (a crash, the process ended, ggml failing): then the zipformer. */
    static final int TRIES = 3; // two GPU levels may each fail their check, and the CPU still have its turn
    /** Recordings in a row that Turbo could not finish before it is given up on this phone (off). */
    static final int GIVE_UP = 2;

    /** Turbo too slow here for this recording (SLOW): the zipformer has it. */
    static final class TooSlow extends Exception {
        TooSlow(double pace) {
            super("Turbo too slow here: " + pace + " s a second");
        }
    }

    private static android.content.SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("ivrit_turbo", Context.MODE_PRIVATE);
    }

    /** What a give-up holds for: this system build (drivers come with it), this build of the app, this size. */
    private static String offKey(Context context, String variant) {
        return Build.FINGERPRINT + " " + LocalTranscribeWorker.appVersion(context) + " " + variant;
    }

    /** Why Turbo is given up on this phone ("slow", "failing"), or null. A new system or app build tries again. */
    static String off(Context context) {
        String saved = prefs(context).getString("off", null);
        if (saved == null) return null;
        int space = saved.indexOf(' ');
        return space > 0 && saved.substring(space + 1).equals(offKey(context, Store.onDeviceModel(context))) ? saved.substring(0, space) : null;
    }

    /** Turbo given up on here (off): its model let go (874 or 474 MB back), and the site told. */
    static void giveUp(Context context, String variant, String why, JSONObject details) {
        prefs(context).edit().putString("off", why + " " + offKey(context, variant)).commit();
        forget(context, variant);
        try {
            LocalTranscribeWorker.post(context, "local-turbo-off", details.put("why", why).put("engine", engine(variant))
                .put("memory", memory(context)).put("threads", threads()));
        } catch (Exception ignored) {
            // Only the report is lost.
        }
    }

    /** Turbo tried again (the user chose another processor): given up no more, till it is again. */
    static void tryAgain(Context context) {
        prefs(context).edit().remove("off").apply();
    }

    /** A recording Turbo could not finish (TRIES): after GIVE_UP in a row, given up on here. */
    static void couldNotFinish(Context context, String variant, JSONObject details) {
        String key = "unfinished " + offKey(context, variant);
        int n = prefs(context).getInt(key, 0) + 1;
        prefs(context).edit().putInt(key, n).commit();
        if (n >= GIVE_UP) giveUp(context, variant, "failing", details);
    }

    /** A recording Turbo finished: the count of those it could not starts again. */
    static void finished(Context context, String variant) {
        prefs(context).edit().remove("unfinished " + offKey(context, variant)).apply();
    }

    static long memory(Context context) {
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        ((ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE)).getMemoryInfo(info);
        return info.totalMem;
    }

    private static java.util.Set<String> cpuFeatures() {
        java.util.Set<String> features = new java.util.HashSet<>();
        try (java.io.BufferedReader in = new java.io.BufferedReader(new java.io.FileReader("/proc/cpuinfo"))) {
            for (String line; (line = in.readLine()) != null; ) {
                if (line.startsWith("Features")) features.addAll(Arrays.asList(line.substring(line.indexOf(':') + 1).trim().split("\\s+")));
            }
        } catch (java.io.IOException ignored) {
            // Unknown: treated as lacking them.
        }
        return features;
    }

    /**
     * `wanted` threads for whisper.cpp, fitted to the cores this process may run on now
     * (its cpuset: on the Galaxy S25 all 8 with the app on the screen, 6 as a foreground
     * service, 4 in the background), two left free where it has them all, 6 or more
     * (the rest of the phone, the screen and the GPU's driver, has the others where it
     * has fewer: the S25 kept 6 threads on its 6 at full speed). ggml's threads wait for one another spinning, so a
     * thread more than the cores, or one whose core is taken, holds them all up: on the
     * S25 the decoder's 8 threads on 6 cores made the GPU's check ten times slower and
     * the run hang, and a CPU run took 68 minutes for 5 minutes of sound (decision 30).
     * Read again for each piece, as the app comes and goes from the screen. 0 (not
     * set) stays 0.
     */
    static int fit(int wanted) {
        if (wanted <= 0) return wanted;
        int all = Runtime.getRuntime().availableProcessors(), cores = allowedCores();
        return Math.max(1, Math.min(wanted, cores >= all && all >= 6 ? all - 2 : cores));
    }

    /** The cores this process may run on now (Cpus_allowed_list), or every core where that cannot be read. */
    static int allowedCores() {
        int all = Runtime.getRuntime().availableProcessors();
        try (java.io.BufferedReader in = new java.io.BufferedReader(new java.io.FileReader("/proc/self/status"))) {
            for (String line; (line = in.readLine()) != null; ) {
                if (line.startsWith("Cpus_allowed_list:")) {
                    int n = countCores(line.substring(line.indexOf(':') + 1));
                    return n > 0 ? n : all;
                }
            }
        } catch (Exception ignored) {
            // every core, then
        }
        return all;
    }

    /** The cores in a list such as "0-1,4-5"; 0 where it does not read. */
    static int countCores(String list) {
        int n = 0;
        try {
            for (String part : list.trim().split(",")) {
                if (part.isEmpty()) continue;
                int dash = part.indexOf('-');
                String first = dash < 0 ? part : part.substring(0, dash), last = dash < 0 ? part : part.substring(dash + 1);
                n += Integer.parseInt(last.trim()) - Integer.parseInt(first.trim()) + 1;
            }
        } catch (NumberFormatException e) {
            return 0;
        }
        return n;
    }

    /**
     * Threads for whisper.cpp: the cores at least half as capable as the best (the
     * kernel's own measure, cpu_capacity, out of 1024), at most eight: all eight on
     * a phone whose cores are all big (the Galaxy S25's), four on four big and four
     * small. Where the kernel does not say, the cores faster than the slowest kind,
     * at least four. ggml shares matrix work out in small pieces, so a slower core
     * still helps.
     */
    static int threads() {
        int n = Runtime.getRuntime().availableProcessors();
        long[] capacity = cores(n, "cpu_capacity");
        if (capacity != null) {
            long best = 0;
            for (long c : capacity) best = Math.max(best, c);
            int able = 0;
            for (long c : capacity) if (c * 2 >= best) able++;
            return Math.max(2, Math.min(8, able));
        }
        long[] speeds = cores(n, "cpufreq/cpuinfo_max_freq");
        if (speeds == null) return Math.max(1, Math.min(4, n));
        long slowest = Long.MAX_VALUE;
        for (long s : speeds) slowest = Math.min(slowest, s);
        int big = 0;
        for (long s : speeds) if (s > slowest) big++;
        if (big == 0) big = n;
        return Math.min(8, Math.max(big, Math.min(4, n)));
    }

    /** /sys/devices/system/cpu/cpu<i>/<file> for every core, or null where one is missing. */
    private static long[] cores(int n, String file) {
        long[] out = new long[n];
        for (int i = 0; i < n; i++) {
            try (java.io.BufferedReader in = new java.io.BufferedReader(new java.io.FileReader("/sys/devices/system/cpu/cpu" + i + "/" + file))) {
                out[i] = Long.parseLong(in.readLine().trim());
            } catch (Exception e) {
                return null;
            }
        }
        return out;
    }

    private static File dir(Context context) {
        return new File(context.getFilesDir(), "turbo");
    }

    static File file(Context context, String variant) {
        return model(context, "ggml-turbo-" + variant);
    }

    /** A file the site serves at /models/turbo/<name>.bin (with <name>.json, its size and hash), once here. */
    static File model(Context context, String name) {
        return new File(dir(context), name + ".bin");
    }

    private static File manifest(Context context, String name) {
        return new File(dir(context), name + ".json");
    }

    /** Downloaded and checked. */
    static boolean ready(Context context, String variant) {
        return downloaded(context, "ggml-turbo-" + variant);
    }

    static boolean downloaded(Context context, String name) {
        try {
            JSONObject saved = new JSONObject(new String(java.nio.file.Files.readAllBytes(manifest(context, name).toPath()), StandardCharsets.UTF_8));
            return model(context, name).length() == saved.getLong("bytes");
        } catch (Exception e) {
            return false;
        }
    }

    /** The model, downloaded where it is missing (resumed where it broke off), then checked. */
    static void ensure(Context context, String variant, Progress progress) throws Exception {
        if (ready(context, variant)) return;
        // Only one model is kept: the others go before this one comes.
        for (String other : VARIANTS) if (!other.equals(variant)) forget(context, other);
        for (String other : RETIRED) forget(context, other);
        download(context, "ggml-turbo-" + variant, progress);
    }

    /** One of the site's models (model), downloaded where it is missing, resumed where it broke off, checked. */
    static void download(Context context, String name, Progress progress) throws Exception {
        if (downloaded(context, name)) return;
        String base = Store.site(context) + "/models/turbo/" + name;
        download(context, name, base + ".bin", new JSONObject(fetch(base + ".json")), progress);
    }

    /**
     * A model from `url` (pinned: Hugging Face's at a revision), kept as `name` (model),
     * downloaded where it is missing, resumed where it broke off, checked against
     * wanted's {bytes, sha256}.
     */
    static void download(Context context, String name, String url, JSONObject wanted, Progress progress) throws Exception {
        if (downloaded(context, name)) return;
        File dir = dir(context);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("no room for the Turbo model");
        long total = wanted.getLong("bytes");
        File part = new File(dir, model(context, name).getName() + ".part");
        long have = part.length() <= total ? part.length() : 0;
        if (dir.getUsableSpace() < total - have + (100L << 20)) throw new java.io.IOException("no room for the Turbo model");
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(true); // Hugging Face's files come from its CDN
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(60000);
        if (have > 0) connection.setRequestProperty("Range", "bytes=" + have + "-");
        try {
            int status = connection.getResponseCode();
            if (status == 200) have = 0; // the whole file again: the server does not resume
            else if (status != 206) throw new java.io.IOException("Turbo model download " + status);
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part, have > 0)) {
                byte[] buffer = new byte[256 * 1024];
                long done = have;
                long told = 0;
                for (int n; (n = in.read(buffer)) > 0; ) {
                    out.write(buffer, 0, n);
                    done += n;
                    if (done - told > 4 << 20) {
                        told = done;
                        progress.downloaded(done, total);
                    }
                }
            }
        } finally {
            connection.disconnect();
        }
        if (part.length() != total) throw new java.io.IOException("Turbo model download incomplete");
        if (!sha256(part).equals(wanted.getString("sha256"))) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            throw new java.io.IOException("Turbo model download damaged");
        }
        if (!part.renameTo(model(context, name))) throw new java.io.IOException("Turbo model not saved");
        try (OutputStream out = new FileOutputStream(manifest(context, name))) {
            out.write(wanted.toString().getBytes(StandardCharsets.UTF_8));
        }
        progress.downloaded(total, total);
    }

    /** A model no longer chosen, and any download of it. */
    static void forget(Context context, String variant) {
        String name = "ggml-turbo-" + variant;
        File model = model(context, name);
        for (File f : new File[] {model, manifest(context, name), new File(model.getPath() + ".part")}) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    /**
     * Every model kept, and any download: on a phone Turbo is no longer offered on
     * (earlier builds offered it to any arm64 phone with 6 GB), about 900 MB back.
     */
    static void forgetAll(Context context) {
        File[] files = dir(context).listFiles();
        if (files == null) return;
        for (File f : files) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    private static String fetch(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(20000);
        try {
            int status = connection.getResponseCode();
            // 404: the site is still making it (scripts/turbo_model.py, after a deploy).
            if (status != 200) throw new java.io.IOException("Turbo model not available (" + status + ")");
            try (InputStream in = connection.getInputStream(); java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                return out.toString("UTF-8");
            }
        } finally {
            connection.disconnect();
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[1 << 20];
            for (int n; (n = in.read(buffer)) > 0; ) digest.update(buffer, 0, n);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
