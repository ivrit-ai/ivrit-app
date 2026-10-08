package ai.ivrit.app;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Audio and video shared into the app from WhatsApp or anywhere else. Each is
 * copied into the app's own cache, since the sender's permission to read it
 * ends with the share, and waits there, with its name and type, until the
 * user sends it on or discards it.
 */
final class Shares {
    private Shares() {}

    private static final String TAG = "IvritShares";
    private static final ExecutorService COPIER = Executors.newSingleThreadExecutor();

    static final class Entry {
        final String id;
        final File file;
        final String name;
        final String type;
        final long durationMs;
        final String origin;

        Entry(String id, File file, String name, String type, long durationMs, String origin) {
            this.id = id;
            this.file = file;
            this.name = name;
            this.type = type;
            this.durationMs = durationMs;
            this.origin = origin;
        }
    }

    private static File dir(Context context) {
        File dir = new File(context.getCacheDir(), "shared");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /** Takes in the files of a share intent, off the main thread; false when the intent is not a share. */
    static boolean receive(Context context, Intent intent, Runnable done) {
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return false;
        String fallbackType = intent.getType();
        String sender = senderOf(intent);
        Context app = context.getApplicationContext();
        COPIER.execute(() -> {
            long stamp = System.currentTimeMillis();
            for (int i = 0; i < uris.size(); i++) copy(app, uris.get(i), stamp + "-" + i, fallbackType, sender);
            done.run();
        });
        return true;
    }

    /** The app a share came from, when Android says (not every sender is named). */
    private static String senderOf(Intent intent) {
        Uri referrer = intent.getParcelableExtra(Intent.EXTRA_REFERRER);
        if (referrer != null && referrer.getHost() != null) return referrer.getHost();
        String name = intent.getStringExtra(Intent.EXTRA_REFERRER_NAME);
        return name != null ? Uri.parse(name).getHost() : null;
    }

    /**
     * Where a shared recording came from, for the app to show: "whatsapp", or ""
     * when unknown. WhatsApp hands its files over through its own provider
     * (content://com.whatsapp.provider.media/..., and com.whatsapp.w4b for
     * WhatsApp Business), which identifies it even when Android names no sender.
     */
    private static String originOf(Uri uri, String sender) {
        String authority = uri.getAuthority() != null ? uri.getAuthority() : "";
        String from = sender != null ? sender : "";
        if (authority.startsWith("com.whatsapp") || from.startsWith("com.whatsapp")) return "whatsapp";
        return "";
    }

    private static void copy(Context context, Uri uri, String id, String fallbackType, String sender) {
        String type = context.getContentResolver().getType(uri);
        if (type == null) type = fallbackType != null ? fallbackType : "application/octet-stream";
        String name = displayName(context, uri);
        File file = new File(dir(context), id);
        try (InputStream in = context.getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(file)) {
            if (in == null) return;
            byte[] buffer = new byte[64 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            JSONObject meta = new JSONObject()
                .put("name", name)
                .put("type", type)
                .put("durationMs", durationOf(file))
                .put("origin", originOf(uri, sender));
            try (OutputStream m = new FileOutputStream(new File(dir(context), id + ".json"))) {
                m.write(meta.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            Log.w(TAG, "could not keep a shared file", e);
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    /** How long the recording is, or -1 if it cannot be read: the app sends short ones to Eliezer. */
    private static long durationOf(File file) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(file.getPath());
            String ms = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            return ms == null ? -1 : Long.parseLong(ms);
        } catch (Exception e) {
            return -1;
        } finally {
            try {
                retriever.release();
            } catch (Exception ignored) {
                // Nothing held.
            }
        }
    }

    private static String displayName(Context context, Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (Exception ignored) {
            // Fall back to the path's last part.
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "";
    }

    static Entry find(Context context, String id) {
        if (!id.matches("\\d+-\\d+")) return null;
        File file = new File(dir(context), id);
        File meta = new File(dir(context), id + ".json");
        if (!file.isFile() || !meta.isFile()) return null;
        try {
            JSONObject m = new JSONObject(read(meta));
            return new Entry(
                id, file, m.optString("name"), m.optString("type", "application/octet-stream"), m.optLong("durationMs", -1), m.optString("origin", "")
            );
        } catch (Exception e) {
            return null;
        }
    }

    private static String read(File file) throws java.io.IOException {
        try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }

    static JSArray list(Context context) {
        JSArray out = new JSArray();
        String[] names = dir(context).list();
        if (names == null) return out;
        Arrays.sort(names);
        for (String name : names) {
            if (name.endsWith(".json")) continue;
            Entry entry = find(context, name);
            if (entry == null) continue;
            out.put(
                new JSObject()
                    .put("id", entry.id)
                    .put("name", entry.name)
                    .put("type", entry.type)
                    .put("size", entry.file.length())
                    .put("durationMs", entry.durationMs)
                    .put("origin", entry.origin)
            );
        }
        return out;
    }

    static void discard(Context context, String id) {
        if (!id.matches("\\d+-\\d+")) return;
        //noinspection ResultOfMethodCallIgnored
        new File(dir(context), id).delete();
        //noinspection ResultOfMethodCallIgnored
        new File(dir(context), id + ".json").delete();
    }
}
