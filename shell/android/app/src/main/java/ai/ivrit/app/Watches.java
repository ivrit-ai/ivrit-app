package ai.ivrit.app;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The phone folders the user asked the app to watch: each a folder chosen with
 * Android's folder picker (the app keeps access to that folder only), the My files
 * folder its transcripts go to, and its filters. New audio in a watched folder is
 * uploaded and transcribed by itself (FolderWatchWorker, WatchUploadWorker).
 *
 * Kept as JSON in the app's own preferences, with each watch's record of the files
 * it has seen (by document id: size, modified time, and how far it got), so a file
 * goes once, and only when it has stopped changing.
 */
final class Watches {
    private Watches() {}

    static final String SERVER = "server";
    static final String DEVICE = "device";
    static final String AUTO = "auto";

    static String where(String value) {
        return SERVER.equals(value) || DEVICE.equals(value) ? value : AUTO;
    }

    /** On the phone: chosen for this watch, or for everything (local only); Hebrew only. */
    static boolean onPhone(Context context, Watch w) {
        return "he".equals(w.language) && (Store.localOnly(context) || DEVICE.equals(w.where));
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("ivrit_watches", Context.MODE_PRIVATE);
    }

    static final class Watch {
        String id;
        String tree; // the folder's tree URI (persisted permission)
        String label; // what the phone calls the folder
        String folder; // the My files folder id ("" for the top folder)
        String folderName;
        String language = "he";
        int minSeconds = 5;
        int maxSeconds = 0; // 0: no limit
        boolean wifiOnly;
        boolean paused;
        long since; // only files modified after this (ms): never the folder's old files
        long lastChecked;
        long quotaUntil; // the free quota ran out: waiting until then (ms)
        String lastError = "";
        int sent;
        // Where its files are transcribed: on the server (with speakers), on the phone
        // (Hebrew, no speakers), or on the server until the free time runs out.
        String where = AUTO;

        JSONObject toJson() throws Exception {
            return new JSONObject()
                .put("id", id).put("tree", tree).put("label", label).put("folder", folder).put("folderName", folderName)
                .put("language", language).put("minSeconds", minSeconds).put("maxSeconds", maxSeconds)
                .put("wifiOnly", wifiOnly).put("paused", paused).put("since", since).put("lastChecked", lastChecked)
                .put("quotaUntil", quotaUntil).put("lastError", lastError).put("sent", sent).put("where", where);
        }

        static Watch fromJson(JSONObject o) {
            Watch w = new Watch();
            w.id = o.optString("id");
            w.tree = o.optString("tree");
            w.label = o.optString("label");
            w.folder = o.optString("folder", "");
            w.folderName = o.optString("folderName", "");
            w.language = o.optString("language", "he");
            w.minSeconds = o.optInt("minSeconds", 5);
            w.maxSeconds = o.optInt("maxSeconds", 0);
            w.wifiOnly = o.optBoolean("wifiOnly", false);
            w.paused = o.optBoolean("paused", false);
            w.since = o.optLong("since", 0);
            w.lastChecked = o.optLong("lastChecked", 0);
            w.quotaUntil = o.optLong("quotaUntil", 0);
            w.lastError = o.optString("lastError", "");
            w.sent = o.optInt("sent", 0);
            w.where = where(o.optString("where", AUTO));
            return w;
        }

        /** What the page shows of it (native-api.json, "watches"). */
        JSObject forPage(Context context) {
            JSObject o = new JSObject();
            o.put("id", id);
            o.put("label", label);
            o.put("folder", folder);
            o.put("folderName", folderName);
            o.put("language", language);
            o.put("minSeconds", minSeconds);
            o.put("maxSeconds", maxSeconds);
            o.put("wifiOnly", wifiOnly);
            o.put("paused", paused);
            o.put("since", since);
            o.put("lastChecked", lastChecked);
            o.put("quotaUntil", quotaUntil);
            o.put("lastError", lastError);
            o.put("sent", sent);
            o.put("where", where);
            o.put("waiting", waiting(context, id));
            return o;
        }
    }

    static synchronized List<Watch> all(Context context) {
        List<Watch> out = new ArrayList<>();
        try {
            JSONArray list = new JSONArray(prefs(context).getString("watches", "[]"));
            for (int i = 0; i < list.length(); i++) out.add(Watch.fromJson(list.getJSONObject(i)));
        } catch (Exception ignored) {
            // A damaged list: no watches, rather than a crash in the background.
        }
        return out;
    }

    static synchronized void save(Context context, List<Watch> watches) {
        JSONArray list = new JSONArray();
        try {
            for (Watch w : watches) list.put(w.toJson());
        } catch (Exception ignored) {
            return;
        }
        prefs(context).edit().putString("watches", list.toString()).apply();
    }

    static Watch find(Context context, String id) {
        for (Watch w : all(context)) if (w.id.equals(id)) return w;
        return null;
    }

    /** Applies a change to one watch and saves them all. */
    interface Change {
        void apply(Watch w);
    }

    static synchronized Watch update(Context context, String id, Change change) {
        List<Watch> watches = all(context);
        for (Watch w : watches) {
            if (w.id.equals(id)) {
                change.apply(w);
                save(context, watches);
                return w;
            }
        }
        return null;
    }

    static synchronized Watch add(Context context, Watch w) {
        w.id = UUID.randomUUID().toString();
        w.since = System.currentTimeMillis();
        List<Watch> watches = all(context);
        watches.add(w);
        save(context, watches);
        return w;
    }

    static synchronized void remove(Context context, String id) {
        List<Watch> watches = all(context);
        watches.removeIf(w -> w.id.equals(id));
        save(context, watches);
        prefs(context).edit().remove("seen:" + id).apply();
    }

    static JSArray forPage(Context context) {
        JSArray out = new JSArray();
        for (Watch w : all(context)) out.put(w.forPage(context));
        return out;
    }

    // --- the files a watch has seen ---------------------------------------------
    // By document id: {size, modified, state}, state being "new" (seen once, maybe
    // still being written), "queued" (handed to WatchUploadWorker), "sent", or
    // "skipped" (too short, too long, not audio).

    static synchronized JSONObject seen(Context context, String watchId) {
        try {
            return new JSONObject(prefs(context).getString("seen:" + watchId, "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    static synchronized void saveSeen(Context context, String watchId, JSONObject seen) {
        prefs(context).edit().putString("seen:" + watchId, seen.toString()).apply();
    }

    /**
     * A scan's view of the files, saved without undoing what an upload finished
     * meanwhile (a file marked sent or skipped while the scan ran stays so).
     */
    static synchronized void mergeSeen(Context context, String watchId, JSONObject scanned) {
        JSONObject current = seen(context, watchId);
        for (java.util.Iterator<String> it = scanned.keys(); it.hasNext(); ) {
            String docId = it.next();
            JSONObject now = current.optJSONObject(docId);
            String state = now == null ? "" : now.optString("state");
            if ("sent".equals(state) || "skipped".equals(state)) continue;
            try {
                current.put(docId, scanned.get(docId));
            } catch (Exception ignored) {
                // Keep what there was.
            }
        }
        saveSeen(context, watchId, current);
    }

    static synchronized void mark(Context context, String watchId, String docId, String state) {
        JSONObject seen = seen(context, watchId);
        JSONObject file = seen.optJSONObject(docId);
        if (file == null) return;
        try {
            file.put("state", state);
            seen.put(docId, file);
        } catch (Exception ignored) {
            return;
        }
        saveSeen(context, watchId, seen);
    }

    static int waiting(Context context, String watchId) {
        JSONObject seen = seen(context, watchId);
        int n = 0;
        for (java.util.Iterator<String> it = seen.keys(); it.hasNext(); ) {
            JSONObject file = seen.optJSONObject(it.next());
            if (file != null && ("queued".equals(file.optString("state")) || "new".equals(file.optString("state")))) n++;
        }
        return n;
    }
}
