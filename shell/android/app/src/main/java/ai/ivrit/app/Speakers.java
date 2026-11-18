package ai.ivrit.app;

import android.content.Context;

/**
 * Who speaks when in a Turbo transcript, as ivrit.ai's server tells (its
 * diarization's "ivrit" engine): each segment's voice print with SpeechBrain's
 * ECAPA model, then the prints clustered as it clusters them (shell/native/speakers,
 * through speakers.c, in the Turbo library). The model is the site's
 * (scripts/speaker_model.py), downloaded with the Turbo model (Turbo.download).
 */
final class Speakers {
    private Speakers() {}

    static final String MODEL = "speakers-ecapa-q8_0";
    /** Seconds: shorter segments get the speaker they sound closest to, but do not shape the speakers. */
    static final double MIN_CLUSTERED = 1.0;

    static void ensure(Context context, Turbo.Progress progress) throws Exception {
        Turbo.download(context, MODEL, progress);
    }

    static String path(Context context) {
        return Turbo.model(context, MODEL).getPath();
    }

    /** The model loaded, to print on `threads` threads; 0 when it would not load. */
    static native long load(String path, int threads);

    static native void free(long handle);

    /**
     * The voice print of the segment from `start` to `end` (seconds into the file) of
     * the first `length` samples of 16 kHz sound that starts `offset` seconds into
     * it; null when the segment is too short to print.
     */
    static native float[] print(long handle, float[] pcm, int length, double offset, double start, double end);

    /**
     * The prints of the segments starts[i]..ends[i] all at once, as print would make
     * them one by one (the threads each taking whole segments): 192 floats each, one
     * after another, the first NaN where a segment is too short to print.
     */
    static native float[] prints(long handle, float[] pcm, int length, double offset, double[] starts, double[] ends);

    /** Each print's speaker, 0, 1, …, or -1 where missing: prints are 192 floats each, one after another. */
    static native int[] cluster(float[] prints, boolean[] clustered, boolean[] missing);
}
