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
 * (LocalModel), and far larger and slower, so the user chooses it (the web app's
 * Settings, onDeviceModel), and it is offered only on phones that can run it
 * (supported): arm64 with dot products and half floats, and about 6 GB of memory,
 * as it takes about 1 GB while it works.
 *
 * The model is ggml's q8_0 or q5_1 (scripts/turbo_model.py), served by the site at
 * /models/turbo/ and downloaded the first time it is used, resumed where a download
 * broke off, and checked against the site's hash. Only the chosen one is kept.
 */
final class Turbo {
    private Turbo() {}

    static final String ZIPFORMER = "zipformer";
    /** The first is the default: as accurate as the full model, and fastest on ARM (ggml repacks it). */
    static final String[] VARIANTS = {"q8_0", "q5_1"};
    static final String LANGUAGE = "he";
    // Greedy: beam search (5) made 3 fewer mistakes in 544 words and took 29% longer.
    static final int BEAMS = 1;
    /**
     * Heard ten minutes at a time, with a checkpoint after each. Each cut hears a
     * sentence again (TurboWords.chunk): 120-second pieces took 29% longer than one.
     */
    static final double CHUNK_SECONDS = 600;
    private static final long MIN_MEMORY = 5L << 30; // a 6 GB phone reports about 5.5

    interface Progress {
        void downloaded(long done, long total);
    }

    static String engine(String variant) {
        return "whisper-turbo-he-" + variant;
    }

    /** The Turbo model chosen, or null for the zipformer (also when this phone cannot run it). */
    static String chosen(Context context) {
        String model = Store.onDeviceModel(context);
        return Arrays.asList(VARIANTS).contains(model) && supported(context) ? model : null;
    }

    private static Boolean supported;

    static synchronized boolean supported(Context context) {
        if (supported == null) {
            // Android 9 on: the library links Vulkan 1.1 (src/main/cpp/CMakeLists.txt).
            supported = Build.VERSION.SDK_INT >= 28
                && Build.SUPPORTED_ABIS.length > 0 && "arm64-v8a".equals(Build.SUPPORTED_ABIS[0])
                && memory(context) >= MIN_MEMORY && cpuFeatures().containsAll(Arrays.asList("asimddp", "asimdhp"))
                && Whisper.available();
        }
        return supported;
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
     * Threads for whisper.cpp: the cores faster than the slowest kind (the big ones),
     * at least four where there are as many: the work is shared out in small pieces,
     * so a small core helps rather than holding the others back.
     */
    static int threads() {
        int n = Runtime.getRuntime().availableProcessors();
        long[] speeds = new long[n];
        long slowest = Long.MAX_VALUE;
        for (int i = 0; i < n; i++) {
            try (java.io.BufferedReader in = new java.io.BufferedReader(
                    new java.io.FileReader("/sys/devices/system/cpu/cpu" + i + "/cpufreq/cpuinfo_max_freq"))) {
                speeds[i] = Long.parseLong(in.readLine().trim());
            } catch (Exception e) {
                return Math.max(1, Math.min(4, n));
            }
            slowest = Math.min(slowest, speeds[i]);
        }
        int big = 0;
        for (long s : speeds) if (s > slowest) big++;
        if (big == 0) big = n;
        return Math.min(6, Math.max(big, Math.min(4, n)));
    }

    private static File dir(Context context) {
        return new File(context.getFilesDir(), "turbo");
    }

    static File file(Context context, String variant) {
        return new File(dir(context), "ggml-turbo-" + variant + ".bin");
    }

    private static File manifest(Context context, String variant) {
        return new File(dir(context), "ggml-turbo-" + variant + ".json");
    }

    /** Downloaded and checked. */
    static boolean ready(Context context, String variant) {
        try {
            JSONObject saved = new JSONObject(new String(java.nio.file.Files.readAllBytes(manifest(context, variant).toPath()), StandardCharsets.UTF_8));
            return file(context, variant).length() == saved.getLong("bytes");
        } catch (Exception e) {
            return false;
        }
    }

    /** The model, downloaded where it is missing (resumed where it broke off), then checked. */
    static void ensure(Context context, String variant, Progress progress) throws Exception {
        if (ready(context, variant)) return;
        File dir = dir(context);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("no room for the Turbo model");
        String base = Store.site(context) + "/models/turbo/ggml-turbo-" + variant;
        JSONObject wanted = new JSONObject(fetch(base + ".json"));
        long total = wanted.getLong("bytes");
        File part = new File(dir, file(context, variant).getName() + ".part");
        // Only one model is kept: the others go before this one comes.
        for (String other : VARIANTS) if (!other.equals(variant)) forget(context, other);
        long have = part.length() <= total ? part.length() : 0;
        if (dir.getUsableSpace() < total - have + (100L << 20)) throw new java.io.IOException("no room for the Turbo model");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + ".bin").openConnection();
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
        if (!part.renameTo(file(context, variant))) throw new java.io.IOException("Turbo model not saved");
        try (OutputStream out = new FileOutputStream(manifest(context, variant))) {
            out.write(wanted.toString().getBytes(StandardCharsets.UTF_8));
        }
        progress.downloaded(total, total);
    }

    /** A model no longer chosen, and any download of it. */
    static void forget(Context context, String variant) {
        File model = file(context, variant);
        for (File f : new File[] {model, manifest(context, variant), new File(model.getPath() + ".part")}) {
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
