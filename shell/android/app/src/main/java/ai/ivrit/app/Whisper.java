package ai.ivrit.app;

/**
 * whisper.cpp, for the Turbo model (Turbo): built with the app for arm64 phones
 * (src/main/cpp, turbo.c), on the CPU, or on the GPU through Vulkan where TurboGpu
 * finds that works. One recording at a time per loaded model.
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

    /** A model file loaded on GPU device `device` (of gpus(); -1: the CPU), with flash attention or not; 0 when it would not load. */
    static native long load(String path, int device, boolean flash);

    /** stderr and whisper.cpp's whole log into this file from now on (TurboGpu reads it after a crash). */
    static native void logTo(String path);

    static native void free(long handle);

    /** Ends a transcribe call under way on another thread: it returns null. */
    static native void stop(long handle);

    /** What whisper.cpp was built to use (NEON, dot products…), for reports. */
    static native String system();

    /**
     * 16 kHz mono sound in the language given, as {byte[] text, int[] ends, int[]
     * times, int[] segments} (turbo.c says how they are laid out; TurboWords reads
     * them), or null once stopped.
     */
    static native Object[] transcribe(long handle, float[] pcm, String language, int threads, int beams, Listener listener);
}
