package ai.ivrit.app;

import android.content.Context;
import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * A recording's sound, decoded by the phone's own codecs (MediaExtractor and
 * MediaCodec) and handed on in blocks, mono, at the file's own sample rate:
 * sherpa-onnx resamples to 16 kHz itself. Nothing is held whole, so an hours-long
 * file costs no more memory than a short one.
 */
final class AudioDecoder {
    private AudioDecoder() {}

    interface Sink {
        /** Mono samples in [-1, 1], at sampleRate; atSeconds is where they end, in the file. */
        void accept(float[] samples, int sampleRate, double atSeconds) throws Exception;
    }

    static final class NoAudio extends Exception {
        NoAudio() {
            super("no audio track");
        }
    }

    /** The file's length in seconds, or 0 when it does not say. */
    static double duration(Context context, Uri uri) {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(context, uri, null);
            int track = audioTrack(extractor);
            if (track < 0) return 0;
            MediaFormat format = extractor.getTrackFormat(track);
            return format.containsKey(MediaFormat.KEY_DURATION) ? format.getLong(MediaFormat.KEY_DURATION) / 1e6 : 0;
        } catch (Exception e) {
            return 0;
        } finally {
            extractor.release();
        }
    }

    private static int audioTrack(MediaExtractor extractor) {
        for (int i = 0; i < extractor.getTrackCount(); i++) {
            String mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("audio/")) return i;
        }
        return -1;
    }

    /** From startSeconds on (0 for the whole file), as a resumed transcription asks. */
    static void decode(Context context, Uri uri, double startSeconds, Sink sink) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        try {
            extractor.setDataSource(context, uri, null);
            int track = audioTrack(extractor);
            if (track < 0) throw new NoAudio();
            extractor.selectTrack(track);
            if (startSeconds > 0) extractor.seekTo((long) (startSeconds * 1e6), MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            double offset = startSeconds > 0 ? Math.max(0, extractor.getSampleTime() / 1e6) : 0;
            MediaFormat format = extractor.getTrackFormat(track);
            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
            codec.configure(format, null, null, 0);
            codec.start();
            int sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            int encoding = AudioFormat.ENCODING_PCM_16BIT;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            long samplesOut = 0;
            for (;;) {
                if (!inputDone) {
                    int in = codec.dequeueInputBuffer(10000);
                    if (in >= 0) {
                        ByteBuffer buffer = codec.getInputBuffer(in);
                        int size = buffer == null ? -1 : extractor.readSampleData(buffer, 0);
                        if (size < 0) {
                            codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(in, 0, size, extractor.getSampleTime(), 0);
                            extractor.advance();
                        }
                    }
                }
                int out = codec.dequeueOutputBuffer(info, 10000);
                if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat now = codec.getOutputFormat();
                    sampleRate = now.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = now.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (now.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = now.getInteger(MediaFormat.KEY_PCM_ENCODING);
                    continue;
                }
                if (out < 0) continue;
                ByteBuffer data = codec.getOutputBuffer(out);
                if (data != null && info.size > 0) {
                    data.position(info.offset).limit(info.offset + info.size);
                    float[] mono = toMono(data.slice().order(ByteOrder.nativeOrder()), channels, encoding);
                    samplesOut += mono.length;
                    if (mono.length > 0) sink.accept(mono, sampleRate, offset + samplesOut / (double) sampleRate);
                }
                codec.releaseOutputBuffer(out, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
            }
        } finally {
            if (codec != null) {
                try {
                    codec.stop();
                } catch (Exception ignored) {
                    // Already stopped by a failure.
                }
                codec.release();
            }
            extractor.release();
        }
    }

    private static float[] toMono(ByteBuffer pcm, int channels, int encoding) {
        channels = Math.max(1, channels);
        if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
            java.nio.FloatBuffer f = pcm.asFloatBuffer();
            float[] mono = new float[f.remaining() / channels];
            for (int i = 0; i < mono.length; i++) {
                float sum = 0;
                for (int c = 0; c < channels; c++) sum += f.get();
                mono[i] = sum / channels;
            }
            return mono;
        }
        java.nio.ShortBuffer s = pcm.asShortBuffer();
        float[] mono = new float[s.remaining() / channels];
        for (int i = 0; i < mono.length; i++) {
            float sum = 0;
            for (int c = 0; c < channels; c++) sum += s.get() / 32768f;
            mono[i] = sum / channels;
        }
        return mono;
    }
}
