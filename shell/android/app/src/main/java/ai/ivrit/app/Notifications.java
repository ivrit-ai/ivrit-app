package ai.ivrit.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/**
 * The app's notifications. Its one channel is created at high importance, so
 * messages pop up on screen; that is the reason this app is native at all, as
 * no web page can choose a channel's importance.
 */
final class Notifications {
    private Notifications() {}

    static final String CHANNEL = "messages";
    static final String EXTRA_MESSAGE = "ai.ivrit.app.MESSAGE_ID";

    /** Creates the channel, or renames it into the current language. Importance is set only once: after that it is the user's. */
    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(context.getString(R.string.channel_messages_description));
        channel.enableVibration(true);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    /** The channel's importance, or HIGH where channels do not exist. */
    static int importance(Context context) {
        if (Build.VERSION.SDK_INT < 26) return NotificationManager.IMPORTANCE_HIGH;
        NotificationChannel channel = context.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL);
        return channel == null ? NotificationManager.IMPORTANCE_HIGH : channel.getImportance();
    }

    static boolean allowed(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        return Build.VERSION.SDK_INT < 33
            || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    /** Shows one message, given the payload Communicator sent (see payload.js there). */
    static void show(Context context, JSONObject p) {
        if (!allowed(context)) return;
        ensureChannel(context);
        String id = p.optString("i", "");
        String sourceId = p.has("sid") ? p.optString("sid") : null;
        String name = Store.sourceName(context, sourceId, p.optString("s", "ivrit.ai"));
        String title = p.optString("t", "");
        String body = p.optString("b", "");

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ivrit)
            // The source leads: on a locked phone the title is often all that shows.
            .setContentTitle(title.isEmpty() ? name : name + " · " + title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setWhen(p.optLong("ts", System.currentTimeMillis()))
            .setShowWhen(true)
            .setContentIntent(openIntent(context, id));
        if (p.has("st")) builder.setSubText(p.optString("st"));
        if (sourceId != null) {
            builder.setGroup("source:" + sourceId);
            Bitmap logo = sourceLogo(context, sourceId);
            if (logo != null) builder.setLargeIcon(logo);
        }
        try {
            NotificationManagerCompat.from(context).notify(id.hashCode(), builder.build());
        } catch (SecurityException ignored) {
            // Permission withdrawn between the check and here.
        }
    }

    /**
     * A transcript of a recording shared into the app, ready while the app was
     * closed (see TranscribeWorker). It opens on that message, whose id the page
     * keeps as "app-" plus the upload id.
     */
    static void showTranscript(Context context, String uploadId, String title, String text, String origin) {
        if (!allowed(context)) return;
        ensureChannel(context);
        String messageId = "app-" + uploadId;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ivrit)
            .setContentTitle(title == null || title.isEmpty() ? context.getString(R.string.app_name) : title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setLargeIcon(BitmapFactory.decodeResource(
                context.getResources(), "whatsapp".equals(origin) ? R.drawable.whatsapp_mark : R.mipmap.ic_launcher))
            .setContentIntent(openIntent(context, messageId));
        try {
            NotificationManagerCompat.from(context).notify(messageId.hashCode(), builder.build());
        } catch (SecurityException ignored) {
            // Permission withdrawn between the check and here.
        }
    }

    /** Once, after the update that made asking for notifications work (UpdatedReceiver): opens the app. */
    static void showNotificationsWork(Context context) {
        if (!allowed(context)) return;
        ensureChannel(context);
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        String text = context.getString(R.string.notifications_work_text);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ivrit)
            .setContentTitle(context.getString(R.string.notifications_work_title))
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(
                context, "notifications-work".hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        try {
            NotificationManagerCompat.from(context).notify("notifications-work".hashCode(), builder.build());
        } catch (SecurityException ignored) {
            // Permission withdrawn between the check and here.
        }
    }

    // --- transcribing on the phone (LocalTranscribeWorker) -----------------------

    static final String WORK_CHANNEL = "work";
    static final String EXTRA_LINK = "ai.ivrit.app.LINK";

    /** A quiet channel for work in progress: it never pops up or makes a sound. */
    private static void ensureWorkChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(
            WORK_CHANNEL, context.getString(R.string.channel_work), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(context.getString(R.string.channel_work_description));
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static int localProgressId(String key) {
        return ("local:" + key).hashCode();
    }

    /** "Transcribing on this phone": the file, how far, and a way to stop. */
    static android.app.Notification localProgress(Context context, String name, String phase, int percent, Double secondsLeft, PendingIntent cancel) {
        ensureWorkChannel(context);
        String text;
        if ("model".equals(phase)) text = context.getString(R.string.local_model, Math.max(0, percent));
        else if ("saving".equals(phase)) text = context.getString(R.string.local_saving);
        else if ("transcribing".equals(phase)) {
            text = secondsLeft == null
                ? context.getString(R.string.local_percent, Math.max(0, percent))
                : context.getString(R.string.local_percent_left, Math.max(0, percent), Math.max(1, (int) Math.round(secondsLeft / 60)));
        } else text = context.getString(R.string.local_preparing);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, WORK_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ivrit)
            .setContentTitle(context.getString(R.string.local_title, name))
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setProgress(100, Math.max(0, percent), percent < 0 || "saving".equals(phase))
            .addAction(0, context.getString(R.string.local_stop), cancel)
            .setContentIntent(linkIntent(context, "#transcribe"));
        return builder.build();
    }

    static void cancelLocalProgress(Context context, String key) {
        NotificationManagerCompat.from(context).cancel(localProgressId(key));
    }

    /** Done: the transcript, a tap away. */
    static void showLocalReady(Context context, String key, String name, String resultsId, String folder) {
        if (!allowed(context)) return;
        ensureChannel(context);
        String link = "#t/" + android.net.Uri.encode(resultsId) + (folder == null || folder.isEmpty() ? "" : "?f=" + android.net.Uri.encode(folder));
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ivrit)
            .setContentTitle(context.getString(R.string.local_ready))
            .setContentText(name)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(linkIntent(context, link));
        try {
            NotificationManagerCompat.from(context).notify(("ready:" + key).hashCode(), builder.build());
        } catch (SecurityException ignored) {
            // Permission withdrawn between the check and here.
        }
    }

    static void showLocalFailed(Context context, String key, String name, String why) {
        if (!allowed(context)) return;
        ensureChannel(context);
        // A full Drive is the user's to fix, and says so (the text may be in Downloads).
        String text = LocalTranscribeWorker.DRIVE_FULL_KEPT.equals(why)
            ? context.getString(R.string.local_drive_full_kept)
            : LocalTranscribeWorker.DRIVE_FULL.equals(why) ? context.getString(R.string.local_drive_full) : null;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ivrit)
            .setContentTitle(text != null ? name : context.getString(R.string.local_failed))
            .setContentText(text != null ? text : name)
            .setStyle(text != null ? new NotificationCompat.BigTextStyle().bigText(text) : null)
            .setAutoCancel(true)
            .setContentIntent(linkIntent(context, "#transcribe"));
        try {
            NotificationManagerCompat.from(context).notify(("failed:" + key).hashCode(), builder.build());
        } catch (SecurityException ignored) {
            // Permission withdrawn between the check and here.
        }
    }

    /** Opens the app at a place in it (a transcript, My files). */
    private static PendingIntent linkIntent(Context context, String link) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(EXTRA_LINK, link)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            context, link.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent openIntent(Context context, String id) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(EXTRA_MESSAGE, id)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            context, id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The source's logo from Communicator, or null: a message never waits long on its picture. */
    private static Bitmap sourceLogo(Context context, String sourceId) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(Store.communicator(context) + "/api/sources/" + android.net.Uri.encode(sourceId) + "/icon.png");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(4000);
            if (connection.getResponseCode() != 200) return null;
            try (InputStream in = connection.getInputStream()) {
                return BitmapFactory.decodeStream(in);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
