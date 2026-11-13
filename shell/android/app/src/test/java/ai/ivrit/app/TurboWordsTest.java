package ai.ivrit.app;

import static org.junit.Assert.assertEquals;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.Test;

public class TurboWordsTest {
    /** Tokens as Whisper.transcribe gives them: each a byte string with its start and end (centiseconds). */
    private static final class Tokens {
        final ByteArrayOutputStream text = new ByteArrayOutputStream();
        final java.util.List<Integer> ends = new java.util.ArrayList<>();
        final java.util.List<Integer> times = new java.util.ArrayList<>();

        Tokens add(byte[] bytes, int t0, int t1) {
            text.write(bytes, 0, bytes.length);
            ends.add(text.size());
            times.add(t0);
            times.add(t1);
            return this;
        }

        Tokens add(String piece, int t0, int t1) {
            return add(piece.getBytes(StandardCharsets.UTF_8), t0, t1);
        }

        int[] ends() {
            return ends.stream().mapToInt(Integer::intValue).toArray();
        }

        int[] times() {
            return times.stream().mapToInt(Integer::intValue).toArray();
        }

        List<Segments.Word> words(double offset) {
            return TurboWords.words(text.toByteArray(), ends(), times(), ends.size(), offset);
        }
    }

    @Test
    public void aSpaceStartsAWord() {
        List<Segments.Word> words = new Tokens()
            .add(" שלום", 0, 40).add(" לכ", 40, 60).add("ולם", 60, 90).add(".", 90, 95)
            .words(0);
        assertEquals(2, words.size());
        assertEquals("שלום", words.get(0).text);
        assertEquals("לכולם.", words.get(1).text);
        assertEquals(0.4, words.get(1).start, 0.001);
        assertEquals(0.95, words.get(1).end, 0.001);
    }

    @Test
    public void aLetterSplitBetweenTokensIsWholeAgain() {
        byte[] shalom = " שלום".getBytes(StandardCharsets.UTF_8); // a space, then four two-byte letters
        Tokens tokens = new Tokens()
            .add(java.util.Arrays.copyOfRange(shalom, 0, 4), 100, 120)
            .add(java.util.Arrays.copyOfRange(shalom, 4, shalom.length), 120, 150);
        List<Segments.Word> words = tokens.words(0);
        assertEquals(1, words.size());
        assertEquals("שלום", words.get(0).text);
    }

    @Test
    public void punctuationAfterASpaceJoinsTheWordBefore() {
        List<Segments.Word> words = new Tokens().add(" כן", 0, 30).add(" -", 30, 35).add(" לא", 40, 70).words(0);
        assertEquals(2, words.size());
        assertEquals("כן-", words.get(0).text);
        assertEquals("לא", words.get(1).text);
    }

    @Test
    public void timesAreInTheFile() {
        List<Segments.Word> words = new Tokens().add(" אחת", 150, 200).words(300);
        assertEquals(301.5, words.get(0).start, 0.001);
        assertEquals(302.0, words.get(0).end, 0.001);
    }

    @Test
    public void aPieceLeavesItsLastSentenceToTheNext() {
        Tokens tokens = new Tokens().add(" אחת", 0, 100).add(" שתיים", 100, 200).add(" שלוש", 25000, 25500);
        int[] segments = {0, 200, 2, 25000, 29000, 3};
        TurboWords.Chunk chunk = TurboWords.chunk(tokens.text.toByteArray(), tokens.ends(), tokens.times(), segments, 600, 300, false);
        assertEquals(2, chunk.words.size());
        assertEquals(850.0, chunk.next, 0.001);
        TurboWords.Chunk last = TurboWords.chunk(tokens.text.toByteArray(), tokens.ends(), tokens.times(), segments, 600, 300, true);
        assertEquals(3, last.words.size());
        assertEquals(900.0, last.next, 0.001);
    }

    @Test
    public void aSingleSentenceIsNeverLeftForever() {
        Tokens tokens = new Tokens().add(" אחת", 0, 100);
        TurboWords.Chunk only = TurboWords.chunk(tokens.text.toByteArray(), tokens.ends(), tokens.times(), new int[] {0, 100, 1}, 0, 300, false);
        assertEquals(1, only.words.size());
        assertEquals(300.0, only.next, 0.001);
        // Two sentences, the last starting at once: kept too, rather than heard again from 0.
        Tokens two = new Tokens().add(" אחת", 0, 50).add(" שתיים", 50, 100);
        TurboWords.Chunk early = TurboWords.chunk(two.text.toByteArray(), two.ends(), two.times(), new int[] {0, 50, 1, 50, 100, 2}, 0, 300, false);
        assertEquals(2, early.words.size());
        assertEquals(300.0, early.next, 0.001);
    }

    @Test
    public void wordsBecomeSentences() throws Exception {
        List<Segments.Word> words = new Tokens().add(" שלום.", 0, 50).add(" מה", 60, 80).add(" שלומך?", 80, 120).words(0);
        org.json.JSONArray sentences = Segments.segments(words);
        assertEquals(2, sentences.length());
        assertEquals("מה שלומך?", sentences.getJSONObject(1).getString("text"));
        assertEquals(1.2, sentences.getJSONObject(1).getDouble("end"), 0.001);
    }
}
