package ai.ivrit.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The Turbo model's tokens (Whisper.transcribe) as words with times, for Segments
 * to make sentences of, the same way it does the zipformer's.
 *
 * A token starting with a space starts a word, and one that is only punctuation
 * joins the word before it. A token is bytes, not letters: one may end inside a
 * Hebrew letter, so a word's text is read only once it is whole. A word runs from
 * its first token's start to its last token's end.
 *
 * A recording goes through the model a few minutes at a time (chunk). Unless it is
 * the last, a piece's last sentence may be cut off, so it is left out and the next
 * piece starts where it did.
 */
final class TurboWords {
    private TurboWords() {}

    /** One piece's words, and where in the file the next piece starts. */
    static final class Chunk {
        final List<Segments.Word> words;
        final double next;

        Chunk(List<Segments.Word> words, double next) {
            this.words = words;
            this.next = next;
        }
    }

    /**
     * text/ends/times/segments as Whisper.transcribe returns them, for the sound from
     * `offset` seconds into the file, `seconds` long; `last`: nothing comes after it.
     */
    static Chunk chunk(byte[] text, int[] ends, int[] times, int[] segments, double offset, double seconds, boolean last) {
        int count = segments.length / 3;
        int tokens = ends.length;
        double next = offset + seconds;
        if (!last && count > 1) {
            double cut = segments[3 * (count - 1)] / 100.0;
            // A last sentence starting at the very beginning would never get done.
            if (cut > 1) {
                tokens = segments[3 * (count - 2) + 2];
                next = offset + cut;
            }
        }
        return new Chunk(words(text, ends, times, tokens, offset), next);
    }

    /** The first `tokens` tokens as words, their times from `offset` seconds into the file. */
    static List<Segments.Word> words(byte[] text, int[] ends, int[] times, int tokens, double offset) {
        List<Segments.Word> words = new ArrayList<>();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        Segments.Word current = null;
        for (int i = 0; i < tokens; i++) {
            int from = i == 0 ? 0 : ends[i - 1];
            int length = ends[i] - from;
            boolean starts = length > 0 && text[from] == ' ';
            String alone = new String(text, from, length, StandardCharsets.UTF_8).trim();
            if (alone.isEmpty() && starts) continue;
            double start = offset + times[2 * i] / 100.0;
            double end = offset + times[2 * i + 1] / 100.0;
            if (current == null || (starts && !Segments.PUNCTUATION.matcher(alone).matches())) {
                finish(current, bytes, words);
                current = new Segments.Word();
                current.start = start;
            }
            if (starts) {
                from++;
                length--;
            }
            bytes.write(text, from, length);
            current.end = Math.max(current.start, end);
        }
        finish(current, bytes, words);
        return words;
    }

    private static void finish(Segments.Word word, ByteArrayOutputStream bytes, List<Segments.Word> words) {
        if (word == null) return;
        word.text = new String(bytes.toByteArray(), StandardCharsets.UTF_8).trim();
        bytes.reset();
        if (word.text.isEmpty()) return;
        word.start = Segments.round(word.start);
        word.end = Segments.round(Math.max(word.end, word.start + Segments.MIN_WORD));
        word.last = word.end;
        words.add(word);
    }
}
