package ai.ivrit.app;

import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.util.Log;
import java.io.File;
import java.nio.ByteBuffer;

/**
 * A video's sound on its own, as an .m4a: the audio track copied out as it is
 * (MediaExtractor into MediaMuxer, nothing re-encoded), so it takes seconds even
 * for a long video. Only the sound is ever transcribed, and a phone video is many
 * times its sound's size: a minute of camera video is often over Eliezer's 20 MB,
 * its sound 1-2 MB. Where the sound cannot be copied into an .m4a (a codec
 * MP4 does not take, such as AC-3 in a .mov), the caller keeps the video.
 */
final class SoundTrack {
    private SoundTrack() {}

    private static final String TAG = "IvritSoundTrack";

    /** The type and extension of what extract writes. */
    static final String TYPE = "audio/mp4";
    static final String EXTENSION = ".m4a";

    /** Whether the file has a picture as well as sound (false when it cannot be read). */
    static boolean hasVideo(Context context, Uri uri) {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(context, uri, null);
            return track(extractor, "video/") >= 0;
        } catch (Exception e) {
            return false;
        } finally {
            extractor.release();
        }
    }

    /** The name a file gets once only its sound is kept: "clip.mp4" is "clip.m4a". */
    static String renamed(String name) {
        int dot = name.lastIndexOf('.');
        return (dot > 0 ? name.substring(0, dot) : name.isEmpty() ? "recording" : name) + EXTENSION;
    }

    /** The audio track of uri into target, as an .m4a. False (and target removed) when it could not be done. */
    static boolean extract(Context context, Uri uri, File target) {
        MediaExtractor extractor = new MediaExtractor();
        MediaMuxer muxer = null;
        boolean started = false;
        try {
            extractor.setDataSource(context, uri, null);
            int track = track(extractor, "audio/");
            if (track < 0) return fail(target, null);
            extractor.selectTrack(track);
            MediaFormat format = extractor.getTrackFormat(track);
            muxer = new MediaMuxer(target.getPath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            // Throws for a codec MP4 does not take.
            int out = muxer.addTrack(format);
            muxer.start();
            started = true;
            int capacity = format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) ? format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) : 0;
            ByteBuffer buffer = ByteBuffer.allocate(Math.max(capacity, 1 << 20));
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long samples = 0;
            for (int n; (n = extractor.readSampleData(buffer, 0)) >= 0; extractor.advance()) {
                boolean sync = (extractor.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0;
                info.set(0, n, Math.max(0, extractor.getSampleTime()), sync ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0);
                muxer.writeSampleData(out, buffer, info);
                samples++;
            }
            if (samples == 0) return fail(target, null);
            muxer.stop();
            started = false;
            return true;
        } catch (Exception e) {
            return fail(target, e);
        } finally {
            if (muxer != null) {
                try {
                    if (started) muxer.stop();
                } catch (Exception ignored) {
                    // Failed already; the file is removed.
                }
                try {
                    muxer.release();
                } catch (Exception ignored) {
                    // Nothing held.
                }
            }
            extractor.release();
        }
    }

    private static boolean fail(File target, Exception e) {
        if (e != null) Log.w(TAG, "could not copy out the sound, keeping the file as it is", e);
        //noinspection ResultOfMethodCallIgnored
        target.delete();
        return false;
    }

    private static int track(MediaExtractor extractor, String prefix) {
        for (int i = 0; i < extractor.getTrackCount(); i++) {
            String mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith(prefix)) return i;
        }
        return -1;
    }
}
