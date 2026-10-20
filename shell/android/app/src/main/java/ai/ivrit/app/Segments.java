package ai.ivrit.app;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The on-device model's tokens (each a piece of a word and the time it came out)
 * as the app's transcript: sentences {start, end, text, speakers: [], words}. The
 * same rules as the web app's web/transcription/local/segments.js, so a transcript
 * made on the phone and one made in the browser read alike:
 *
 * A piece starting with "▁" starts a word; one that is only punctuation joins the
 * word before it. A word starts at its first piece's time and ends where the next
 * one starts, but no later than shortly after its last piece. A sentence ends after
 * a word with . ? ! or …, at a pause, or, past MAX_SENTENCE seconds, at the next
 * comma or word. The model writes its own punctuation; nothing is added.
 */
final class Segments {
    private Segments() {}

    static final double PAUSE = 1.0;
    static final double MAX_SENTENCE = 20;
    static final double LONG_SENTENCE = 12;
    static final double TAIL = 0.4;
    static final double MIN_WORD = 0.04;
    private static final Pattern PUNCTUATION = Pattern.compile("^[.,?!:;…\"'()\\[\\]\\-–—]+$");
    private static final Pattern ENDS_SENTENCE = Pattern.compile("[.?!…][\"')\\]]*$");

    static final class Word {
        String text;
        double start;
        double end;
        double last;
    }

    static List<Word> words(String[] pieces, float[] times) {
        List<Word> words = new ArrayList<>();
        Word current = null;
        for (int i = 0; i < pieces.length; i++) {
            String piece = pieces[i];
            boolean starts = piece.startsWith("▁");
            String text = piece.replace("▁", "");
            if (text.isEmpty()) continue;
            double at = i < times.length ? times[i] : (current == null ? 0 : current.last);
            if (current != null && (!starts || PUNCTUATION.matcher(text).matches())) {
                current.text += text;
                current.last = at;
                continue;
            }
            current = new Word();
            current.text = text;
            current.start = at;
            current.last = at;
            words.add(current);
        }
        for (int i = 0; i < words.size(); i++) {
            Word w = words.get(i);
            Word next = i + 1 < words.size() ? words.get(i + 1) : null;
            double latest = w.last + TAIL;
            w.end = round(Math.max(w.start + MIN_WORD, next != null ? Math.min(next.start, latest) : latest));
            w.start = round(w.start);
        }
        return words;
    }

    static JSONArray segments(String[] pieces, float[] times) throws Exception {
        List<Word> words = words(pieces, times);
        JSONArray out = new JSONArray();
        List<Word> current = new ArrayList<>();
        for (int i = 0; i < words.size(); i++) {
            Word w = words.get(i);
            current.add(w);
            Word next = i + 1 < words.size() ? words.get(i + 1) : null;
            if (next == null) break;
            double length = w.end - current.get(0).start;
            double pause = next.start - w.end;
            if (ENDS_SENTENCE.matcher(w.text).find() || pause >= PAUSE || length >= MAX_SENTENCE
                || (length >= LONG_SENTENCE && w.text.endsWith(","))) {
                out.put(segment(current));
                current = new ArrayList<>();
            }
        }
        if (!current.isEmpty()) out.put(segment(current));
        return out;
    }

    private static JSONObject segment(List<Word> words) throws Exception {
        StringBuilder text = new StringBuilder();
        JSONArray list = new JSONArray();
        for (Word w : words) {
            if (text.length() > 0) text.append(' ');
            text.append(w.text);
            list.put(new JSONObject().put("word", w.text).put("start", w.start).put("end", w.end));
        }
        return new JSONObject()
            .put("start", words.get(0).start)
            .put("end", words.get(words.size() - 1).end)
            .put("text", text.toString())
            .put("speakers", new JSONArray())
            .put("words", list);
    }

    private static double round(double seconds) {
        return Math.round(seconds * 1000) / 1000.0;
    }
}
