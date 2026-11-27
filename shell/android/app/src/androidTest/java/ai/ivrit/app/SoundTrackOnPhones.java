package ai.ivrit.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * A video's sound copied out (SoundTrack), on a phone's own MediaExtractor and
 * MediaMuxer: store/fixtures/hebrew-12s.mp4 (12 seconds of AAC with a black
 * picture) gives an .m4a with that sound alone, as long, and plain audio is not
 * taken for a video.
 */
@RunWith(AndroidJUnit4.class)
public class SoundTrackOnPhones {
    private static File fixture(Context context, String name) throws Exception {
        File out = new File(context.getCacheDir(), "fixture-" + name);
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name)) {
            Files.copy(in, out.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
        return out;
    }

    @Test
    public void keepsTheSoundAlone() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Uri video = Uri.fromFile(fixture(context, "hebrew-12s.mp4"));
        assertTrue(SoundTrack.hasVideo(context, video));
        File sound = new File(context.getCacheDir(), "sound" + SoundTrack.EXTENSION);
        assertTrue(SoundTrack.extract(context, video, sound));
        assertFalse(SoundTrack.hasVideo(context, Uri.fromFile(sound)));

        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(sound.getPath());
            assertEquals(1, extractor.getTrackCount());
            MediaFormat format = extractor.getTrackFormat(0);
            assertEquals("audio/mp4a-latm", format.getString(MediaFormat.KEY_MIME));
            assertEquals(12.0, format.getLong(MediaFormat.KEY_DURATION) / 1e6, 0.1);
        } finally {
            extractor.release();
        }
        assertEquals(12.0, AudioDecoder.duration(context, Uri.fromFile(sound)), 0.1);
    }

    @Test
    public void audioIsNotAVideo() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertFalse(SoundTrack.hasVideo(context, Uri.fromFile(fixture(context, "hebrew-12s.m4a"))));
    }

    @Test
    public void names() {
        assertEquals("clip.m4a", SoundTrack.renamed("clip.mp4"));
        assertEquals("VID-20261127-WA0001.m4a", SoundTrack.renamed("VID-20261127-WA0001.mp4"));
        assertEquals("clip.m4a", SoundTrack.renamed("clip"));
        assertEquals("recording.m4a", SoundTrack.renamed(""));
    }
}
