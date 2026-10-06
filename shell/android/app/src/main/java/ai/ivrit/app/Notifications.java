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
