package ai.ivrit.app;

/**
 * whisper.cpp, for the Turbo model (Turbo): built with the app for arm64 phones
 * (src/main/cpp, turbo.c, and shell/native), on the CPU, or on the GPU where
 * TurboGpu finds that works. One recording at a time per loaded model.
 */
final class Whisper {
    private Whisper() {}

    interface Listener {
        /** How far into the sound given, 0 to 100. */
        void progress(int percent);
    }

    private static Boolean available;

    /** The library is in this build, for this phone's processor. */
    static synchronized boolean available() {
        if (available == null) {
            try {
                System.loadLibrary("ivritturbo");
                available = true;
            } catch (UnsatisfiedLinkError e) {
                available = false;
            }
        }
        return available;
    }

    /** ggml's GPU devices, "<backend><n>: <description>" ("Vulkan0: Adreno (TM) 830"), not started. */
    static native String[] gpus();

    /** Starts GPU device `index` (of gpus()) and lets it go: its description; throws when ggml failed. */
    static native String probe(int index);

    /**
     * A model file loaded on GPU device `device` (of gpus(); -1: the CPU), with flash
     * attention or not, and on a GPU with the decoder on the CPU all the same or not
     * (decoderCpu: a phone's GPU encodes faster, its CPU may take the decoder's small
     * steps faster); 0 when it would not load.
     */
    static native long load(String path, int device, boolean flash, boolean decoderCpu);

    /**
     * The decoder's fastest thread count on this phone, at most `threads`, timed on
     * the first window of `n` samples of 16 kHz sound; 0 when it could not tell.
     * Throws when whisper.cpp failed.
     */
    static native int tuneDecoder(long handle, float[] pcm, int n, int threads);

    /** stderr and whisper.cpp's whole log into this file from now on (TurboGpu reads it after a crash). */
    static native void logTo(String path);

    static native void free(long handle);

    /** Ends a transcribe call under way on another thread: it returns null. */
    static native void stop(long handle);

    /** What whisper.cpp was built to use (NEON, dot products…), for reports. */
    static native String system();

    /**
     * 16 kHz mono sound in the language given, from `offset` seconds into the file
     * (`last`: nothing comes after it), as the server would transcribe it, as
     * {byte[] text, int[] ends, double[] times, int[] segments} (turbo.c says how
     * they are laid out; TurboTranscript reads them), or null once stopped. state:
     * {the speech's end so far, the transcript's end so far, where the next piece
     * starts, the file's sample count and level (levelEnd; 0 when not known), where
     * its sound starts}: the first three written, all but the third read. prompt: {how many, then the
     * tokens} of the previous text it goes on from (PROMPT at most, as faster-whisper
     * prompts), PROMPT + 1 long, read and written.
     * decodeThreads: the decoder's threads (tuneDecoder; 0: threads).
     */
    static native Object[] transcribe(long handle, float[] pcm, String language, int threads, int decodeThreads, int beams,
                                      Listener listener, double offset, boolean last, double[] state, int[] prompt);

    /**
     * The whole file's loudness, for silence found as over the whole file: levelNew
     * (about how many samples it has), its 16 kHz sound in order through levelAdd,
     * then levelEnd: {the sample count, the level}, or null where it cannot be told
     * (it frees the handle either way).
     */
    static native long levelNew(long expected);

    static native void levelAdd(long handle, float[] pcm, int n);

    static native double[] levelEnd(long handle);

    /** transcript.h's TR_PROMPT. */
    static final int PROMPT = 223;

    /** An empty prompt, for transcribe. */
    static int[] prompt() {
        return new int[PROMPT + 1];
    }
}
