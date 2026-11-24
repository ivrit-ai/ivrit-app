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
 * recording on the phones it is offered on (supported): Galaxy S23 and on, whose
 * GPUs run it through WebGPU (TurboGpu). The zipformer transcribes live, and
 * recordings on all other phones.
 *
 * The model is ggml's q8_0 or q5_1 (scripts/turbo_model.py), served by the site at
 * /models/turbo/ and downloaded the first time it is used, resumed where a download
 * broke off, and checked against the site's hash. Only the chosen one is kept. Its
 * transcripts have speakers, with the speaker model (Speakers) from there too.
 */
final class Turbo {
    private Turbo() {}

    /**
     * The one size: as accurate as the full model, and fastest on ARM (ggml repacks it).
     * q5_1 is gone for good (docs/turbo-android.md, decision 2): a choice of it falls
     * back to this one (Store.onDeviceModel), and its download is let go (RETIRED).
     */
    static final String[] VARIANTS = {"q8_0"};
    private static final String[] RETIRED = {"q5_1"};

    /** A variant's download, as Settings tells it (scripts/turbo_model.py's files). */
    static int megabytes(String variant) {
        return 874;
    }
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
    private static final long MIN_MEMORY = 6L << 30; // an 8 GB phone reports about 7.3 GB (6.8 GiB)

    interface Progress {
        void downloaded(long done, long total);
    }

    static String engine(String variant) {
        return "whisper-turbo-he-" + variant;
    }

    /** The Turbo model to transcribe recordings with, or null for the zipformer where this phone cannot run it. */
    static String chosen(Context context) {
        String model = Store.onDeviceModel(context);
        return Arrays.asList(VARIANTS).contains(model) && supported(context) ? model : null;
    }

    private static Boolean supported;

    /**
     * Galaxy S23 and on, Snapdragon and Exynos alike: the GPU runs Turbo through WebGPU
     * with the app's own programs (TurboGpu), about a third of the recording's length
     * on an S25, greedily. Other phones keep the zipformer: on a CPU Turbo takes longer than the
     * recording, and other phones' GPUs are not known well enough (docs/turbo-android.md,
     * decisions 24-25). Android 13 (the S23's first) on, 8 GB, dot products and half
     * floats (the library is built for them). The GPU itself is the check's to judge,
     * in the background (never here: a driver that crashes takes the app with it).
     */
    static synchronized boolean supported(Context context) {
        if (supported == null) {
            supported = Build.VERSION.SDK_INT >= 33
                && galaxy(Build.MANUFACTURER, Build.MODEL)
                && Build.SUPPORTED_ABIS.length > 0 && "arm64-v8a".equals(Build.SUPPORTED_ABIS[0])
                && memory(context) >= MIN_MEMORY && cpuFeatures().containsAll(Arrays.asList("asimddp", "asimdhp"))
                && early() && Whisper.available();
        }
        return supported;
    }

    /** WebGPU's switches, before ggml can read them (TurboGpu.early). */
    private static boolean early() {
        TurboGpu.early();
        return true;
    }

    /**
     * A Galaxy S23 or later, FE editions too, by Samsung's model number: SM-S91x the S23s,
     * S92x the S24s, S93x the S25s and on; S711, S721, S731 the FEs. (Phones of a decade
     * ago had SM-S9xx numbers too, and fail the other tests.)
     */
    static boolean galaxy(String manufacturer, String model) {
        return "samsung".equalsIgnoreCase(manufacturer) && model != null && model.matches("SM-S(9[1-9]|7[1-9])\\d.*");
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
