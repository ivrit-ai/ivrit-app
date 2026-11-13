package ai.ivrit.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ResamplerTest {
    private static float[] tone(int rate, double hz, double seconds) {
        float[] out = new float[(int) (rate * seconds)];
        for (int i = 0; i < out.length; i++) out[i] = (float) (0.5 * Math.sin(2 * Math.PI * hz * i / rate));
        return out;
    }

    private static float[] all(Resampler r, float[] in, int block) {
        float[] out = new float[0];
        for (int at = 0; at < in.length; at += block) {
            out = concat(out, r.push(java.util.Arrays.copyOfRange(in, at, Math.min(in.length, at + block))));
        }
        return concat(out, r.flush());
    }

    private static float[] concat(float[] a, float[] b) {
        float[] out = java.util.Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private static double rms(float[] x, int from, int to) {
        double sum = 0;
        for (int i = from; i < to; i++) sum += x[i] * x[i];
        return Math.sqrt(sum / (to - from));
    }

    @Test
    public void oneSecondIs16000Samples() {
        for (int rate : new int[] {8000, 22050, 44100, 48000}) {
            assertEquals(16000, all(new Resampler(rate), tone(rate, 440, 1), 4096).length);
        }
    }

    @Test
    public void aToneKeepsItsPitchAndLoudness() {
        float[] out = all(new Resampler(44100), tone(44100, 1000, 1), 1152);
        float[] expected = tone(16000, 1000, 1);
        double error = 0;
        for (int i = 1000; i < 15000; i++) error = Math.max(error, Math.abs(out[i] - expected[i]));
        assertTrue("off by " + error, error < 0.01);
    }

    @Test
    public void whatIsTooHighIsDropped() {
        // 10 kHz is above 16 kHz's Nyquist: it must not fold back in as 6 kHz.
        float[] out = all(new Resampler(48000), tone(48000, 10000, 1), 1024);
        assertTrue(rms(out, 1000, 15000) < 0.005);
    }

    @Test
    public void blocksMakeNoDifference() {
        float[] in = tone(48000, 300, 0.5);
        float[] once = all(new Resampler(48000), in, in.length);
        float[] pieces = all(new Resampler(48000), in, 333);
        assertArrayEquals(once, pieces, 1e-6f);
    }

    @Test
    public void sixteenKilohertzPassesThrough() {
        float[] in = tone(16000, 440, 0.1);
        assertArrayEquals(in, all(new Resampler(16000), in, 100), 0f);
    }
}
