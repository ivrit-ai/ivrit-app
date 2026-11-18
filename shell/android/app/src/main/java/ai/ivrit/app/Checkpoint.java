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
 * The Turbo model (Turbo) keeps its segments here too, each with its voice print
 * (TurboTranscript), after every few minutes it hears, and where its speech and its
 * transcript end. A checkpoint is its engine's only: a run with another model
 * starts over.
 */
final class Checkpoint {
    static final double EVERY_SECONDS = 60;
    private static final double BACK = 0.2; // resume a little before the last word

    final List<String> pieceList = new ArrayList<>();
    final List<Float> timeList = new ArrayList<>();
    JSONArray turbo; // the Turbo model's segments (TurboTranscript.save); null for none
    double lastSpeech; // the Turbo model's: where its speech, and its transcript, end
    double after;
    int[] prompt = Whisper.prompt(); // the Turbo model's previous text (Whisper.transcribe)
    double offset; // seconds into the file where the next stream starts
    String engine = LocalModel.ENGINE; // what made the pieces

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
            JSONArray pieces = o.optJSONArray("pieces");
            JSONArray times = o.optJSONArray("times");
            for (int i = 0; pieces != null && times != null && i < pieces.length() && i < times.length(); i++) {
                cp.pieceList.add(pieces.getString(i));
                cp.timeList.add((float) times.getDouble(i));
            }
            cp.turbo = o.optJSONArray("segments");
            cp.lastSpeech = o.optDouble("lastSpeech", 0);
            cp.after = o.optDouble("after", 0);
            JSONArray prompt = o.optJSONArray("prompt");
            for (int i = 0; prompt != null && i < prompt.length() && i < cp.prompt.length; i++) cp.prompt[i] = prompt.getInt(i);
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

    /** The Turbo model's segments so far (TurboTranscript.save), and where in the file it goes on from. */
    static void saveTurbo(Context context, String key, String engine, JSONArray segments, double resumeAt,
                          double lastSpeech, double after, int[] prompt) {
        try {
            JSONArray tokens = new JSONArray();
            for (int i = 0; i <= prompt[0]; i++) tokens.put(prompt[i]);
            write(context, key, new JSONObject().put("segments", segments).put("offset", resumeAt)
                .put("lastSpeech", lastSpeech).put("after", after).put("prompt", tokens).put("engine", engine));
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
