package ai.ivrit.app;

import android.util.Base64;
import android.util.Log;
import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Receives Communicator's messages from Firebase, even with the app closed:
 * opens the sealed payload, shows it, and acks it, as the service worker does
 * for web push.
 */
public class PushService extends FirebaseMessagingService {
    private static final String TAG = "IvritPush";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        String sealed = message.getData().get("p");
        if (sealed == null) return;
        JSONObject payload;
        try {
            payload = new JSONObject(Sealed.open(Store.pushKey(this), Base64.decode(sealed, Base64.DEFAULT)));
        } catch (Exception e) {
            // Sealed for a key this install no longer has (reinstalled, data
            // cleared). The next registration sends the new key.
            Log.w(TAG, "unreadable message", e);
            return;
        }
        Notifications.show(this, payload);
        IvritNativePlugin.pushed();
        ack(payload);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        IvritNativePlugin.tokenChanged();
    }

    // Settles the delivery. Best effort: the app syncs on open regardless.
    private void ack(JSONObject p) {
        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject().put("i", p.getString("i")).put("d", p.getString("d")).put("k", p.getString("k"));
            connection = (HttpURLConnection) new URL(Store.communicator(this) + "/api/ack").openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            connection.getResponseCode();
        } catch (Exception e) {
            Log.w(TAG, "ack failed", e);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
