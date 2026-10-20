package ai.ivrit.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** The same cases as the web app's web/transcription/test/local-segments.test.mjs. */
public class SegmentsTest {
    private static String[] p(String... pieces) {
        return pieces;
    }

    private static float[] t(double... times) {
        float[] out = new float[times.length];
        for (int i = 0; i < times.length; i++) out[i] = (float) times[i];
        return out;
    }

    @Test
    public void piecesJoinIntoWords() {
        List<Segments.Word> words = Segments.words(p("▁ב", "פר", "ק", "▁של", "▁שלום", "."), t(1.44, 1.6, 1.76, 1.92, 2.4, 2.6));
        assertEquals("בפרק", words.get(0).text);
        assertEquals("של", words.get(1).text);
        assertEquals("שלום.", words.get(2).text);
        assertEquals(1.44, words.get(0).start, 0.001);
        assertEquals(1.92, words.get(1).start, 0.001);
    }

    @Test
    public void aWordEndsAtTheNextButNotPastAPause() {
        List<Segments.Word> words = Segments.words(p("▁אחת", "▁שתיים", "▁שלוש"), t(1.0, 1.3, 5.0));
        assertEquals(1.3, words.get(0).end, 0.001);
        assertEquals(1.7, words.get(1).end, 0.001);
        assertEquals(5.4, words.get(2).end, 0.001);
    }

    @Test
    public void punctuationJoinsTheWordBefore() {
        List<Segments.Word> words = Segments.words(p("▁כן", "▁,", "▁לא"), t(1.0, 1.1, 1.4));
        assertEquals("כן,", words.get(0).text);
        assertEquals("לא", words.get(1).text);
    }

    @Test
    public void sentencesEndAtPunctuationAndPauses() throws Exception {
        JSONArray segments = Segments.segments(
            p("▁שלום", ".", "▁מה", "▁שלומך", "?", "▁טוב", "▁תודה", "▁ואתה"),
            t(0.5, 0.7, 1.0, 1.3, 1.5, 4.0, 4.3, 7.0));
        String[] texts = new String[segments.length()];
        for (int i = 0; i < texts.length; i++) texts[i] = segments.getJSONObject(i).getString("text");
        org.junit.Assert.assertArrayEquals(new String[] {"שלום.", "מה שלומך?", "טוב תודה", "ואתה"}, texts);
        JSONObject second = segments.getJSONObject(1);
        assertEquals(1.0, second.getDouble("start"), 0.001);
        assertEquals(2, second.getJSONArray("words").length());
        assertEquals(0, second.getJSONArray("speakers").length());
        assertEquals(4.7, segments.getJSONObject(2).getDouble("end"), 0.001);
    }

    @Test
    public void longRunsAreCutEveryTwentySeconds() throws Exception {
        List<String> pieces = new ArrayList<>();
        List<Double> times = new ArrayList<>();
        for (double x = 0; x < 60; x += 0.5) {
            pieces.add("▁מילה");
            times.add(x);
        }
        double[] ts = new double[times.size()];
        for (int i = 0; i < ts.length; i++) ts[i] = times.get(i);
        JSONArray segments = Segments.segments(pieces.toArray(new String[0]), t(ts));
        assertTrue(segments.length() >= 3);
        for (int i = 0; i < segments.length(); i++) {
            JSONObject s = segments.getJSONObject(i);
            assertTrue(s.getDouble("end") - s.getDouble("start") <= 20.5);
        }
    }

    @Test
    public void nothingHeardIsNoSentences() throws Exception {
        assertEquals(0, Segments.segments(new String[0], new float[0]).length());
    }
}
