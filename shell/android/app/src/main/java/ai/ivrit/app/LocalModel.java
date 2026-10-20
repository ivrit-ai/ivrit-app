package ai.ivrit.app;

import android.content.Context;
import com.k2fsa.sherpa.onnx.EndpointConfig;
import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The on-device model, zipformer2-66m-streaming-he (by Yakov Kolani; the ivrit-ai
 * mirror, at the revision the web app uses, web/transcription/local/worker.js):
 * downloaded once into the app's own storage, then loaded into sherpa-onnx's
 * recognizer, kept while the process lives.
 */
final class LocalModel {
    private LocalModel() {}

    static final String ENGINE = "zipformer2-66m-he";
    private static final String REVISION = "3d01a65d00e45cbb238996795be87e8e800a3226";
    private static final String BASE = "https://huggingface.co/ivrit-ai/zipformer2-66m-streaming-he/resolve/" + REVISION + "/";
    // Path in the repo, and its size in bytes (checked after download).
    private static final String[][] FILES = {
        {"sherpa-onnx/encoder.int8.onnx", "70478964"},
        {"sherpa-onnx/decoder.int8.onnx", "1049105"},
        {"sherpa-onnx/joiner.int8.onnx", "771805"},
        {"sherpa-onnx/tokens.txt", "17086"},
    };

    interface Progress {
        void downloaded(long done, long total);
    }

    private static OnlineRecognizer recognizer;

    static File dir(Context context) {
        return new File(context.getFilesDir(), "zipformer2-he-" + REVISION);
    }

    private static File file(Context context, String path) {
        return new File(dir(context), path.substring(path.lastIndexOf('/') + 1));
    }

    static boolean ready(Context context) {
        for (String[] f : FILES) {
            if (file(context, f[0]).length() != Long.parseLong(f[1])) return false;
        }
        return true;
    }

    /** The model's files, downloaded where missing (about 72 MB the first time). */
    static void ensure(Context context, Progress progress) throws Exception {
        if (ready(context)) return;
        File dir = dir(context);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("no room for the model");
        long total = 0;
        for (String[] f : FILES) total += Long.parseLong(f[1]);
        long done = 0;
        for (String[] f : FILES) {
            File target = file(context, f[0]);
            long size = Long.parseLong(f[1]);
            if (target.length() == size) {
                done += size;
                continue;
            }
            File part = new File(dir, target.getName() + ".part");
            HttpURLConnection connection = (HttpURLConnection) new URL(BASE + f[0]).openConnection();
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(true);
            try {
                if (connection.getResponseCode() != 200) throw new java.io.IOException("model download " + connection.getResponseCode());
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buffer = new byte[256 * 1024];
                    long told = 0;
                    for (int n; (n = in.read(buffer)) > 0; ) {
                        out.write(buffer, 0, n);
                        done += n;
                        if (done - told > 1024 * 1024) {
                            told = done;
                            progress.downloaded(done, total);
                        }
                    }
                }
            } finally {
                connection.disconnect();
            }
            if (part.length() != size || !part.renameTo(target)) {
                part.delete();
                throw new java.io.IOException("model download incomplete");
            }
        }
        progress.downloaded(total, total);
    }

    /** The recognizer, made once per process: two threads, no endpointing (a whole file). */
    static synchronized OnlineRecognizer recognizer(Context context) {
        if (recognizer != null) return recognizer;
        OnlineTransducerModelConfig transducer = new OnlineTransducerModelConfig();
        transducer.setEncoder(file(context, FILES[0][0]).getAbsolutePath());
        transducer.setDecoder(file(context, FILES[1][0]).getAbsolutePath());
        transducer.setJoiner(file(context, FILES[2][0]).getAbsolutePath());
        OnlineModelConfig model = new OnlineModelConfig();
        model.setTransducer(transducer);
        model.setTokens(file(context, FILES[3][0]).getAbsolutePath());
        model.setModelType("zipformer2");
        model.setNumThreads(Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2)));
        model.setProvider("cpu");
        FeatureConfig features = new FeatureConfig();
        features.setSampleRate(16000);
        features.setFeatureDim(80);
        OnlineRecognizerConfig config = new OnlineRecognizerConfig();
        config.setFeatConfig(features);
        config.setModelConfig(model);
        config.setEndpointConfig(new EndpointConfig());
        config.setEnableEndpoint(false);
        config.setDecodingMethod("greedy_search");
        // From files, not the app's assets: the model is downloaded, not bundled.
        recognizer = new OnlineRecognizer(null, config);
        return recognizer;
    }
}
