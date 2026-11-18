package ai.ivrit.app;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A Turbo transcript as it grows: the segments Whisper.transcribe makes of each
 * piece of the recording (already as the server cuts and times them), each with
 * its voice print (Speakers), kept in the checkpoint between pieces; at the end,
 * the app's transcript, {start, end, text, speakers, words} a segment, its
 * speakers as ivrit's diarization labels them ("SPEAKER_00", …).
 */
final class TurboTranscript {
    private TurboTranscript() {}

    static final class Segment {
        /** Each word's text as Whisper writes it: " word," with its leading space. */
        final List<Segments.Word> words = new ArrayList<>();
        /** Its voice print; null when too short to print. */
        float[] print;

        double start() {
            return words.get(0).start;
        }

        double end() {
            return words.get(words.size() - 1).end;
        }
    }

    /** Whisper.transcribe's {byte[] text, int[] ends, double[] times, int[] segments} as segments. */
    static List<Segment> piece(Object[] heard) {
        byte[] text = (byte[]) heard[0];
        int[] ends = (int[]) heard[1];
        double[] times = (double[]) heard[2];
        int[] counts = (int[]) heard[3];
        List<Segment> out = new ArrayList<>();
        int k = 0;
        for (int count : counts) {
            Segment s = new Segment();
            for (int i = 0; i < count; i++, k++) {
                int from = k == 0 ? 0 : ends[k - 1];
                Segments.Word w = new Segments.Word();
                w.text = new String(text, from, ends[k] - from, StandardCharsets.UTF_8);
                w.start = times[2 * k];
                w.end = times[2 * k + 1];
                w.last = w.end;
                s.words.add(w);
            }
            if (!s.words.isEmpty()) out.add(s);
        }
        return out;
    }

    /** The segments' speakers (Speakers.cluster): who is clustered, who is missing, and the prints. */
    static int[] speakers(List<Segment> segments, Whisper.Listener progress) {
        int n = segments.size();
        float[] prints = new float[n * 192];
        boolean[] clustered = new boolean[n];
        boolean[] missing = new boolean[n];
        for (int i = 0; i < n; i++) {
            Segment s = segments.get(i);
            missing[i] = s.print == null;
            clustered[i] = !missing[i] && s.end() - s.start() >= Speakers.MIN_CLUSTERED;
            if (!missing[i]) System.arraycopy(s.print, 0, prints, i * 192, 192);
        }
        return Speakers.cluster(prints, clustered, missing, progress);
    }

    /** The app's transcript; labels: each segment's speaker (-1: none), or null for none at all. */
    static JSONArray json(List<Segment> segments, int[] labels) throws Exception {
        JSONArray out = new JSONArray();
        for (int i = 0; i < segments.size(); i++) {
            Segment s = segments.get(i);
            // The segment's text is its words as they are: a word without a
            // leading space ("-98" in "ב-98") belongs to the one before.
            StringBuilder text = new StringBuilder();
            JSONArray words = new JSONArray();
            for (Segments.Word w : s.words) {
                text.append(w.text);
                words.put(new JSONObject().put("word", w.text.trim()).put("start", Segments.round(w.start)).put("end", Segments.round(w.end)));
            }
            JSONArray speakers = new JSONArray();
            if (labels != null && labels[i] >= 0) speakers.put(String.format(java.util.Locale.ROOT, "SPEAKER_%02d", labels[i]));
            out.put(new JSONObject()
                .put("start", Segments.round(s.start()))
                .put("end", Segments.round(s.end()))
                .put("text", text.toString().trim())
                .put("speakers", speakers)
                .put("words", words));
        }
        return out;
    }

    /** The segments as the checkpoint keeps them: words (text, start, end) and print. */
    static JSONArray save(List<Segment> segments) throws Exception {
        JSONArray out = new JSONArray();
        for (Segment s : segments) {
            JSONArray words = new JSONArray();
            for (Segments.Word w : s.words) words.put(new JSONArray().put(w.text).put(w.start).put(w.end));
            JSONObject o = new JSONObject().put("words", words);
            if (s.print != null) {
                JSONArray print = new JSONArray();
                for (float v : s.print) print.put((double) v);
                o.put("print", print);
            }
            out.put(o);
        }
        return out;
    }

    static List<Segment> load(JSONArray saved) throws Exception {
        List<Segment> out = new ArrayList<>();
        for (int i = 0; saved != null && i < saved.length(); i++) {
            JSONObject o = saved.getJSONObject(i);
            Segment s = new Segment();
            JSONArray words = o.getJSONArray("words");
            for (int j = 0; j < words.length(); j++) {
                JSONArray w = words.getJSONArray(j);
                Segments.Word word = new Segments.Word();
                word.text = w.getString(0);
                word.start = w.getDouble(1);
                word.end = w.getDouble(2);
                word.last = word.end;
                s.words.add(word);
            }
            JSONArray print = o.optJSONArray("print");
            if (print != null && print.length() == 192) {
                s.print = new float[192];
                for (int j = 0; j < 192; j++) s.print[j] = (float) print.getDouble(j);
            }
            if (!s.words.isEmpty()) out.add(s);
        }
        return out;
    }
}
