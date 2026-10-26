package ai.ivrit.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import androidx.annotation.RequiresApi;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** A file into the phone's Downloads, where the user finds what they saved (Android 10 and later). */
final class Downloads {
    private Downloads() {}

    @androidx.annotation.ChecksSdkIntAtLeast(api = 29)
    static boolean available() {
        return Build.VERSION.SDK_INT >= 29;
    }

    @RequiresApi(29)
    static void save(Context context, String name, String type, InputStream in) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName(name));
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (item == null) throw new IOException("no room in Downloads");
        try (OutputStream out = resolver.openOutputStream(item)) {
            if (out == null) throw new IOException("no stream");
            byte[] buffer = new byte[64 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
        } catch (IOException | RuntimeException e) {
            resolver.delete(item, null, null);
            throw e;
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(item, values, null, null);
    }

    static String safeName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        return clean.isEmpty() ? "file" : clean.length() > 120 ? clean.substring(clean.length() - 120) : clean;
    }
}
