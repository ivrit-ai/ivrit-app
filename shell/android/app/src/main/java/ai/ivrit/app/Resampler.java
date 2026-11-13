package ai.ivrit.app;

import java.util.Arrays;

/**
 * Sound at a file's own rate, as the phone decodes it (AudioDecoder), to the 16 kHz
 * the Turbo model hears, block by block. A windowed sinc, cut off below the lower
 * rate's Nyquist so nothing above it folds back in; output sample k is input
 * position k * from / 16000 exactly, so times carry over unchanged.
 */
final class Resampler {
    static final int RATE = 16000;
    private static final int ZEROS = 12; // the sinc's zero crossings on each side
    private static final int STEPS = 256; // the filter's table, entries per input sample

    final int from;
    private final double step; // input samples per output sample
    private final double cutoff; // of the input's Nyquist
    private final int half; // the filter's half-width, in input samples
    private final float[] table; // the filter from 0 to `half`, STEPS entries a sample
    private float[] kept = new float[0]; // input from `base` on
    private long base;
    private long made; // output samples so far

    Resampler(int from) {
        this.from = from;
        step = from / (double) RATE;
        cutoff = Math.min(1.0, 1.0 / step) * 0.95;
        half = (int) Math.ceil(ZEROS / cutoff);
        table = new float[half * STEPS + 2];
        for (int i = 0; i < table.length; i++) table[i] = (float) filter(i / (double) STEPS);
    }

    /** The output these samples complete (the last few wait for what follows them). */
    float[] push(float[] samples) {
        if (from == RATE) return samples;
        float[] all = Arrays.copyOf(kept, kept.length + samples.length);
        System.arraycopy(samples, 0, all, kept.length, samples.length);
        kept = all;
        return make(base + kept.length - half);
    }

    /** The rest, once the sound has ended. */
    float[] flush() {
        if (from == RATE) return new float[0];
        long end = base + kept.length;
        kept = Arrays.copyOf(kept, kept.length + half + 1);
        return make(end);
    }

    // Every output sample whose position is before `until`, then drops input no
    // longer needed.
    private float[] make(long until) {
        long count = Math.max(0, (long) Math.ceil(until / step) - made);
        float[] out = new float[(int) count];
        for (int k = 0; k < out.length; k++) {
            double at = (made + k) * step;
            long first = (long) Math.ceil(at - half);
            long last = (long) Math.floor(at + half);
            double sum = 0;
            for (long j = Math.max(first, base); j <= last && j < base + kept.length; j++) {
                double x = Math.abs(at - j) * STEPS;
                int i = (int) x;
                sum += kept[(int) (j - base)] * (table[i] + (table[i + 1] - table[i]) * (x - i));
            }
            out[k] = (float) sum;
        }
        made += count;
        long needed = Math.max(base, (long) Math.ceil(made * step - half));
        kept = Arrays.copyOfRange(kept, (int) (needed - base), kept.length);
        base = needed;
        return out;
    }

    private double filter(double x) {
        if (x == 0) return cutoff;
        if (x >= half) return 0;
        double window = 0.5 * (1 + Math.cos(Math.PI * x / half));
        return Math.sin(Math.PI * cutoff * x) / (Math.PI * x) * window;
    }
}
