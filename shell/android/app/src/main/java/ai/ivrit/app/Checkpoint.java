package ai.ivrit.app;

import android.content.Context;
import com.k2fsa.sherpa.onnx.OnlineRecognizerResult;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * How far an on-device transcription got (LocalTranscribeWorker), kept on disk every
 * minute of audio: the word pieces so far, with their times in the file, and where
 * to go on from. A run the phone stopped resumes there with a fresh stream, cut at
 * the start of the last word so no word is split or lost.
 *
 * The Turbo model (Turbo) keeps its words here too, whole and each with its end,
 * after every few minutes it hears. A checkpoint is its engine's only: a run with
 * another model starts over.
 */
final class Checkpoint {
    static final double EVERY_SECONDS = 60;
    private static final double BACK = 0.2; // resume a little before the last word

    final List<String> pieceList = new ArrayList<>();
    final List<Float> timeList = new ArrayList<>();
    final List<Float> endList = new ArrayList<>(); // the Turbo model's words' ends
    double offset; // seconds into the file where the next stream starts
    String engine = LocalModel.ENGINE; // what made the pieces

    /** The Turbo model's words so far. */
    List<Segments.Word> words() {
        List<Segments.Word> words = new ArrayList<>();
        for (int i = 0; i < pieceList.size() && i < endList.size(); i++) {
            Segments.Word w = new Segments.Word();
            w.text = pieceList.get(i);
            w.start = timeList.get(i);
            w.end = endList.get(i);
            w.last = w.end;
            words.add(w);
        }
        return words;
    }

    String[] pieces() {
        return pieceList.toArray(new String[0]);
    }

    float[] times() {
        float[] out = new float[timeList.size()];
        for (int i = 0; i < out.length; i++) out[i] = timeList.get(i);
        return out;
    }

    /** These pieces and a stream's (its times from `from` in the file). */
    Checkpoint plus(OnlineRecognizerResult result, double from) {
        Checkpoint out = new Checkpoint();
        out.pieceList.addAll(pieceList);
        out.timeList.addAll(timeList);
        String[] tokens = result.getTokens();
        float[] times = result.getTimestamps();
        for (int i = 0; i < tokens.length; i++) {
            out.pieceList.add(tokens[i]);
            out.timeList.add((float) (from + (i < times.length ? times[i] : 0)));
        }
        out.offset = from;
        return out;
    }

    private static File file(Context context, String key) {
        File dir = new File(context.getFilesDir(), "local-progress");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, key.replaceAll("[^A-Za-z0-9_-]", "_") + ".json");
    }

    static Checkpoint load(Context context, String key) {
        Checkpoint cp = new Checkpoint();
        File f = file(context, key);
        if (!f.isFile()) return cp;
        try {
            byte[] bytes = java.nio.file.Files.readAllBytes(f.toPath());
            JSONObject o = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            JSONArray pieces = o.getJSONArray("pieces");
            JSONArray times = o.getJSONArray("times");
            for (int i = 0; i < pieces.length() && i < times.length(); i++) {
                cp.pieceList.add(pieces.getString(i));
                cp.timeList.add((float) times.getDouble(i));
            }
            JSONArray ends = o.optJSONArray("ends");
            for (int i = 0; ends != null && i < ends.length(); i++) cp.endList.add((float) ends.getDouble(i));
            cp.offset = o.optDouble("offset", 0);
            cp.engine = o.optString("engine", LocalModel.ENGINE);
        } catch (Exception e) {
            return new Checkpoint(); // damaged: start over
        }
        return cp;
    }

    /** Saves done + the stream's pieces so far, less the last (maybe unfinished) word. */
    static void save(Context context, String key, Checkpoint done, OnlineRecognizerResult result, double from, double at) {
        Checkpoint all = done.plus(result, from);
        int cut = all.pieceList.size();
        for (int i = all.pieceList.size() - 1; i >= 0; i--) {
            if (all.pieceList.get(i).startsWith("▁")) {
                cut = i;
                break;
            }
        }
        double resumeAt = cut < all.timeList.size() ? Math.max(from, all.timeList.get(cut) - BACK) : at;
        // Nothing heard yet in this stream: go on from where the audio is.
        if (cut <= done.pieceList.size()) resumeAt = Math.max(from, at - 2);
        try {
            JSONArray pieces = new JSONArray();
            JSONArray times = new JSONArray();
            for (int i = 0; i < cut; i++) {
                pieces.put(all.pieceList.get(i));
                times.put(all.timeList.get(i));
            }
            write(context, key, new JSONObject().put("pieces", pieces).put("times", times).put("offset", resumeAt)
                .put("engine", LocalModel.ENGINE));
        } catch (Exception ignored) {
            // Only a faster restart is lost.
        }
    }

    /** The Turbo model's words so far, and where in the file it goes on from. */
    static void saveWords(Context context, String key, String engine, List<Segments.Word> words, double resumeAt) {
        try {
            JSONArray pieces = new JSONArray();
            JSONArray times = new JSONArray();
            JSONArray ends = new JSONArray();
            for (Segments.Word w : words) {
                pieces.put(w.text);
                times.put(w.start);
                ends.put(w.end);
            }
            write(context, key, new JSONObject().put("pieces", pieces).put("times", times).put("ends", ends)
                .put("offset", resumeAt).put("engine", engine));
        } catch (Exception ignored) {
            // Only a faster restart is lost.
        }
    }

    private static void write(Context context, String key, JSONObject o) throws Exception {
        File f = file(context, key);
        File part = new File(f.getPath() + ".part");
        try (FileOutputStream out = new FileOutputStream(part)) {
            out.write(o.toString().getBytes(StandardCharsets.UTF_8));
        }
        //noinspection ResultOfMethodCallIgnored
        part.renameTo(f);
    }

    static void forget(Context context, String key) {
        //noinspection ResultOfMethodCallIgnored
        file(context, key).delete();
    }
}
