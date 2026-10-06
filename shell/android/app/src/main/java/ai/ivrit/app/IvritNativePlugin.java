package ai.ivrit.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.io.File;
import org.json.JSONArray;

/**
 * What the web app asks of the native shell: push through Firebase, the
 * state of this app's notification settings (including whether messages pop
 * up, which no web page can know), and files shared into the app.
 */
@CapacitorPlugin(
    name = "IvritNative",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class IvritNativePlugin extends Plugin {
    private static volatile IvritNativePlugin current;
    private String pendingOpen;

    @Override
    public void load() {
        current = this;
        Notifications.ensureChannel(getContext());
        handleOnNewIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        String id = intent.getStringExtra(Notifications.EXTRA_MESSAGE);
        if (id != null) {
            intent.removeExtra(Notifications.EXTRA_MESSAGE);
            pendingOpen = id;
            notifyListeners("opened", new JSObject().put("id", id), true);
        }
        if (Shares.receive(getContext(), intent, () -> notifyListeners("shared", new JSObject(), true))) {
            intent.setAction(Intent.ACTION_MAIN);
        }
    }

    // --- notifications -----------------------------------------------------

    private JSObject status() {
        boolean available = !FirebaseApp.getApps(getContext()).isEmpty();
        String permission;
        if (Build.VERSION.SDK_INT >= 33) {
            PermissionState state = getPermissionState("notifications");
            permission = state == PermissionState.GRANTED ? "granted" : state == PermissionState.DENIED ? "denied" : "default";
        } else {
            permission = "granted";
        }
        int importance = Notifications.importance(getContext());
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        // Off for the whole app, or for this one channel: either way nothing shows.
        if ("granted".equals(permission) && (!enabled || importance == NotificationManager.IMPORTANCE_NONE)) permission = "denied";
        return new JSObject()
            .put("available", available)
            .put("permission", permission)
            .put("popup", importance >= NotificationManager.IMPORTANCE_HIGH)
            .put("importance", importance);
    }

    @PluginMethod
    public void notificationStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(status());
            return;
        }
        requestPermissionForAlias("notifications", call, "permissionAnswered");
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        call.resolve(status());
    }

    /** The settings screen that fixes what is wrong: this channel's when the app's notifications are on, the app's otherwise. */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        String pkg = getContext().getPackageName();
        Intent intent;
        if (Build.VERSION.SDK_INT >= 26 && NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                .putExtra(Settings.EXTRA_CHANNEL_ID, Notifications.CHANNEL);
        } else if (Build.VERSION.SDK_INT >= 26) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
        }
        getActivity().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    /** This device's Firebase token and message key, for registering with Communicator. */
    @PluginMethod
    public void pushRegistration(PluginCall call) {
        if (FirebaseApp.getApps(getContext()).isEmpty()) {
            call.reject("push unavailable", "unavailable");
            return;
        }
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                call.reject("no push token", "no_token", task.getException());
                return;
            }
            String token = task.getResult();
            JSObject result = new JSObject().put("token", token).put("key", Store.pushKeyText(getContext()));
            String previous = Store.swapToken(getContext(), token);
            if (previous != null) result.put("previousToken", previous);
            call.resolve(result);
        });
    }

    /** What notifications need while the app is closed: the language, Communicator's address and the sources' names. */
    @PluginMethod
    public void configure(PluginCall call) {
        JSArray sources = call.getArray("sources");
        Store.configure(getContext(), call.getString("locale"), call.getString("communicator"), sources == null ? null : (JSONArray) sources);
        call.resolve();
    }

    /** The message a notification tap opened the app on, once. */
    @PluginMethod
    public void takeOpened(PluginCall call) {
        JSObject result = new JSObject();
        if (pendingOpen != null) result.put("id", pendingOpen);
        pendingOpen = null;
        call.resolve(result);
    }

    static void pushed() {
        IvritNativePlugin plugin = current;
        if (plugin != null) plugin.notifyListeners("push", new JSObject());
    }

    static void tokenChanged() {
        IvritNativePlugin plugin = current;
        if (plugin != null) plugin.notifyListeners("pushToken", new JSObject(), true);
    }

    // --- shared files ------------------------------------------------------

    @PluginMethod
    public void sharedFiles(PluginCall call) {
        call.resolve(new JSObject().put("files", Shares.list(getContext())));
    }

    @PluginMethod
    public void discardShared(PluginCall call) {
        Shares.discard(getContext(), call.getString("id", ""));
        call.resolve();
    }

    /** Offers a shared file to other apps (transcribe.ivrit.ai's, typically), leaving this one out. */
    @PluginMethod
    public void shareOn(PluginCall call) {
        Shares.Entry entry = Shares.find(getContext(), call.getString("id", ""));
        if (entry == null) {
            call.reject("not found", "not_found");
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", entry.file);
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType(entry.type)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, call.getString("title", null));
        chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, new ComponentName[] { new ComponentName(getContext(), MainActivity.class) });
        getActivity().startActivity(chooser);
        call.resolve();
    }
}
