package ai.ivrit.app;

import android.content.Context;
import android.os.Build;
import java.io.File;
import org.json.JSONObject;

/**
 * The on-device benchmark (the site's Lab page): ivrit.ai's benchmark recording
 * (five minutes of Hebrew, two speakers; ivrit-ai/turbo-benchmark on Hugging Face,
 * from the eval-d1 set, pinned to a revision and checked by its hash) transcribed
 * with Turbo exactly as a recording is (LocalTranscribeWorker, kind "benchmark"),
 * timed stage by stage, not saved; the page posts the result to the site, which
 * scores it against the recording's reference (POST /bench/results).
 */
final class Benchmark {
    private Benchmark() {}

    static final String NAME = "benchmark-he";
    private static final String URL = "https://huggingface.co/datasets/ivrit-ai/turbo-benchmark/resolve/"
        + "bff424b6022e859d5e67bb9009268b3611fdcaa5/benchmark-he.flac";
    private static final long BYTES = 5503554;
    private static final String SHA256 = "701f69e97ef87fd245a9b9309bcddbfa2eed9aeb55d083600095ac533fb1ffc7";

    /** The recording, downloaded the first time (kept with the Turbo model). */
    static File ensure(Context context, Turbo.Progress progress) throws Exception {
        Turbo.download(context, NAME, URL, new JSONObject().put("bytes", BYTES).put("sha256", SHA256), progress);
        return Turbo.model(context, NAME);
    }

    /** The phone, as the results tell it apart. */
    static JSONObject device(Context context) throws Exception {
        JSONObject o = new JSONObject()
            .put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL)
            .put("android", Build.VERSION.RELEASE)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("cores", Runtime.getRuntime().availableProcessors())
            .put("memory", Turbo.memory(context));
        if (Build.VERSION.SDK_INT >= 31) o.put("soc", (Build.SOC_MANUFACTURER + " " + Build.SOC_MODEL).trim());
        return o;
    }
}
