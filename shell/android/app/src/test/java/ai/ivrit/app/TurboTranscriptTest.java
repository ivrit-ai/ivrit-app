package ai.ivrit.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class TurboTranscriptTest {
    /** Whisper.transcribe's arrays for segments of {word, start, end} triples. */
    private static Object[] heard(Object[][]... segments) {
        ByteArrayOutputStream text = new ByteArrayOutputStream();
        List<Integer> ends = new ArrayList<>();
        List<Double> times = new ArrayList<>();
        int[] counts = new int[segments.length];
        for (int s = 0; s < segments.length; s++) {
            for (Object[] w : segments[s]) {
                byte[] bytes = ((String) w[0]).getBytes(StandardCharsets.UTF_8);
                text.write(bytes, 0, bytes.length);
                ends.add(text.size());
                times.add((Double) w[1]);
                times.add((Double) w[2]);
            }
            counts[s] = segments[s].length;
        }
        int[] e = new int[ends.size()];
        for (int i = 0; i < e.length; i++) e[i] = ends.get(i);
        double[] t = new double[times.size()];
        for (int i = 0; i < t.length; i++) t[i] = times.get(i);
        return new Object[] {text.toByteArray(), e, t, counts};
    }

    @Test
    public void aPieceIsItsSegmentsWordsWhole() {
        List<TurboTranscript.Segment> piece = TurboTranscript.piece(heard(
            new Object[][] {{" שלום,", 1.26, 1.8}, {" מירה.", 1.9, 2.5}},
            new Object[][] {{" 😀", 3.0, 3.2}}));
        assertEquals(2, piece.size());
        assertEquals(" שלום,", piece.get(0).words.get(0).text);
        assertEquals(1.26, piece.get(0).start(), 0);
        assertEquals(2.5, piece.get(0).end(), 0);
        assertEquals(" 😀", piece.get(1).words.get(0).text);
    }

    @Test
    public void aSegmentsTextIsItsWordsAsWritten() throws Exception {
        // faster-whisper keeps "-98" a word of its own, without a space before it.
        List<TurboTranscript.Segment> piece = TurboTranscript.piece(heard(
            new Object[][] {{" שפרסמה", 87.6, 88.3}, {" ב", 88.4, 88.5}, {"-98.", 88.5, 90.4}}));
        JSONObject s = TurboTranscript.json(piece, new int[] {1}).getJSONObject(0);
        assertEquals("שפרסמה ב-98.", s.getString("text"));
        assertEquals("ב", s.getJSONArray("words").getJSONObject(1).getString("word"));
        assertEquals("SPEAKER_01", s.getJSONArray("speakers").getString(0));
        assertEquals(87.6, s.getDouble("start"), 0);
        assertEquals(90.4, s.getDouble("end"), 0);
    }

    @Test
    public void speakersOnlyWhereTold() throws Exception {
        List<TurboTranscript.Segment> piece = TurboTranscript.piece(heard(
            new Object[][] {{" אחת", 0.0, 0.5}}, new Object[][] {{" שתיים", 1.0, 1.5}}));
        JSONArray some = TurboTranscript.json(piece, new int[] {-1, 12});
        assertEquals(0, some.getJSONObject(0).getJSONArray("speakers").length());
        assertEquals("SPEAKER_12", some.getJSONObject(1).getJSONArray("speakers").getString(0));
        JSONArray none = TurboTranscript.json(piece, null);
        assertEquals(0, none.getJSONObject(1).getJSONArray("speakers").length());
    }

    @Test
    public void theCheckpointKeepsWordsAndPrints() throws Exception {
        List<TurboTranscript.Segment> piece = TurboTranscript.piece(heard(
            new Object[][] {{" שלום", 600.25, 600.5}, {" לך", 600.6, 601.0}}, new Object[][] {{" כן", 602.0, 602.1}}));
        piece.get(0).print = new float[192];
        piece.get(0).print[7] = -1.5f;
        List<TurboTranscript.Segment> back = TurboTranscript.load(new JSONArray(TurboTranscript.save(piece).toString()));
        assertEquals(2, back.size());
        assertEquals(" לך", back.get(0).words.get(1).text);
        assertEquals(600.25, back.get(0).start(), 0);
        assertEquals(-1.5f, back.get(0).print[7], 0);
        assertNull(back.get(1).print);
        assertEquals(0, TurboTranscript.load(null).size());
    }
}
