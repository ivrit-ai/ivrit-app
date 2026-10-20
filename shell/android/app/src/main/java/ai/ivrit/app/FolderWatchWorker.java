package ai.ivrit.app;

import android.content.Context;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * Looks through the watched folders (Watches) for new audio, every 15 minutes (the
 * least Android allows) and whenever the app opens. A file is taken once it has
 * stopped changing - a recording still being made is not cut short - and only once:
 * then it goes to WatchUploadWorker. Only files that appeared after the folder was
 * chosen; subfolders a few levels down too (WhatsApp keeps voice notes by week).
 */
public class FolderWatchWorker extends Worker {
    private static final String TAG = "IvritWatch";
    private static final String PERIODIC = "folder-watch";
    private static final String NOW = "folder-watch-now";
    private static final int DEPTH = 3;
    // A file unchanged this long when first seen is not being written any more.
    private static final long SETTLED_MS = 2 * 60 * 1000;
    private static final String[] AUDIO = { ".opus", ".ogg", ".oga", ".m4a", ".mp3", ".wav", ".aac", ".amr", ".flac", ".3gp", ".weba", ".webm" };

    public FolderWatchWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** The periodic check, while there is anything to watch. */
    static void schedule(Context context) {
        WorkManager work = WorkManager.getInstance(context);
        if (Watches.all(context).isEmpty()) {
            work.cancelUniqueWork(PERIODIC);
            return;
        }
        work.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(FolderWatchWorker.class, 15, TimeUnit.MINUTES).build());
    }

    /** A check now (the app opened, a watch was added or resumed). */
    static void checkNow(Context context) {
        if (Watches.all(context).isEmpty()) return;
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE,
            new OneTimeWorkRequest.Builder(FolderWatchWorker.class).build());
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        boolean signedIn = !Store.appToken(context).isEmpty();
        for (Watches.Watch watch : Watches.all(context)) {
            if (isStopped()) break;
            if (watch.paused) continue;
            String error = "";
            if (watch.quotaUntil > System.currentTimeMillis()) {
                error = "quota";
            } else {
                try {
                    Uri tree = Uri.parse(watch.tree);
                    JSONObject seen = Watches.seen(context, watch.id);
                    walk(context, watch, tree, DocumentsContract.getTreeDocumentId(tree), 0, seen, signedIn);
                    Watches.mergeSeen(context, watch.id, seen);
                    if (!signedIn) error = "signin";
                } catch (SecurityException e) {
                    // The folder's access was taken back (in Android's settings) or it is gone.
                    error = "access";
                } catch (Exception e) {
                    Log.w(TAG, "watching " + watch.label + " failed", e);
                    error = "failed";
                }
            }
            String lastError = error;
            Watches.update(context, watch.id, w -> {
                w.lastChecked = System.currentTimeMillis();
                if (w.quotaUntil <= System.currentTimeMillis()) w.quotaUntil = 0;
                w.lastError = lastError;
            });
            IvritNativePlugin.watchChanged(watch.id);
        }
        return Result.success();
    }

    private void walk(Context context, Watches.Watch watch, Uri tree, String parentId, int depth, JSONObject seen, boolean signedIn) throws Exception {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] columns = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };
        try (Cursor c = context.getContentResolver().query(children, columns, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext() && !isStopped()) {
                String id = c.getString(0);
                String name = c.getString(1) == null ? "" : c.getString(1);
                String mime = c.getString(2) == null ? "" : c.getString(2);
                long size = c.isNull(3) ? 0 : c.getLong(3);
                long modified = c.isNull(4) ? 0 : c.getLong(4);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    if (depth < DEPTH && !name.startsWith(".")) walk(context, watch, tree, id, depth + 1, seen, signedIn);
                    continue;
                }
                if (!isAudio(name, mime) || modified < watch.since || size <= 0) continue;
                consider(context, watch, tree, id, name, mime, size, modified, seen, signedIn);
            }
        }
    }

    private static boolean isAudio(String name, String mime) {
        if (mime.startsWith("audio/")) return true;
        String lower = name.toLowerCase(Locale.ROOT);
        for (String ext : AUDIO) if (lower.endsWith(ext)) return true;
        return false;
    }

    private void consider(Context context, Watches.Watch watch, Uri tree, String id, String name, String mime, long size, long modified,
                          JSONObject seen, boolean signedIn) throws Exception {
        JSONObject file = seen.optJSONObject(id);
        long now = System.currentTimeMillis();
        if (file == null) {
            file = new JSONObject().put("size", size).put("modified", modified).put("state", "new");
            seen.put(id, file);
            // Changed only just now: maybe still being written; look again next time.
            // An older file has settled already, and goes at once.
            if (now - modified < SETTLED_MS) return;
        } else if (!"new".equals(file.optString("state"))) {
            return;
        } else if (file.optLong("size") != size || file.optLong("modified") != modified) {
            // Still growing: look again next time.
            file.put("size", size).put("modified", modified);
            return;
        }
        if (!signedIn) return;
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
        long seconds = durationSeconds(context, doc);
        if (seconds >= 0 && (seconds < watch.minSeconds || (watch.maxSeconds > 0 && seconds > watch.maxSeconds))) {
            file.put("state", "skipped");
            return;
        }
        file.put("state", "queued");
        String type = mime.isEmpty() ? "application/octet-stream" : mime;
        if (Watches.onPhone(context, watch)) WatchUploadWorker.onPhone(context, watch, id, doc, name, type);
        else WatchUploadWorker.enqueue(context, watch, id, doc, name, type, size, modified);
    }

    private static long durationSeconds(Context context, Uri doc) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(context, doc);
            String ms = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            return ms == null ? -1 : Long.parseLong(ms) / 1000;
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
}
