package ai.ivrit.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
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
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    private ActivityResultLauncher<IntentSenderRequest> driveConsent;
    private PluginCall pendingDrive;

    @Override
    public void load() {
        current = this;
        // Registered now: an activity takes these only before it has started.
        driveConsent = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(), this::driveConsented);
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

    // --- the Google account ------------------------------------------------

    /** A Google ID token for clientId (the app's web OAuth client): silent if possible, the account picker if interactive. */
    @PluginMethod
    public void googleIdToken(PluginCall call) {
        String clientId = call.getString("clientId");
        if (clientId == null || clientId.isEmpty()) {
            call.reject("no client id", "no_client_id");
            return;
        }
        GoogleAccount.idToken(getActivity(), clientId, Boolean.TRUE.equals(call.getBoolean("interactive", false)), new GoogleAccount.Result() {
            @Override
            public void ok(String idToken, String email, String name) {
                call.resolve(new JSObject().put("idToken", idToken).put("email", email).put("name", name));
            }

            @Override
            public void error(String code, String message) {
                call.reject(message, code);
            }
        });
    }

    // --- Google Drive, for transcripts ---------------------------------------

    /**
     * Access to the user's Drive (DriveAccess): Google's screen if not granted yet,
     * otherwise at once. Resolves with {code}, for the server (POST /auth/drive).
     */
    @PluginMethod
    public void authorizeDrive(PluginCall call) {
        String clientId = call.getString("clientId");
        if (clientId == null || clientId.isEmpty()) {
            call.reject("no client id", "no_client_id");
            return;
        }
        if (pendingDrive != null) pendingDrive.reject("superseded", "cancelled");
        pendingDrive = call;
        Identity.getAuthorizationClient(getActivity())
            .authorize(DriveAccess.request(clientId))
            .addOnSuccessListener(result -> {
                if (result.hasResolution() && result.getPendingIntent() != null) {
                    driveConsent.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
                } else {
                    driveAuthorized(result);
                }
            })
            .addOnFailureListener(e -> {
                PluginCall pending = pendingDrive;
                pendingDrive = null;
                if (pending != null) pending.reject(String.valueOf(e.getMessage()), "failed");
            });
    }

    private void driveConsented(ActivityResult consent) {
        if (pendingDrive == null) return;
        if (consent.getResultCode() != Activity.RESULT_OK) {
            PluginCall pending = pendingDrive;
            pendingDrive = null;
            pending.reject("cancelled", "cancelled");
            return;
        }
        try {
            driveAuthorized(Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(consent.getData()));
        } catch (Exception e) {
            PluginCall pending = pendingDrive;
            pendingDrive = null;
            pending.reject(String.valueOf(e.getMessage()), "failed");
        }
    }

    private void driveAuthorized(AuthorizationResult result) {
        PluginCall pending = pendingDrive;
        pendingDrive = null;
        if (pending == null) return;
        String code = result.getServerAuthCode();
        if (code == null || code.isEmpty()) pending.reject("no code", "failed");
        else pending.resolve(new JSObject().put("code", code));
    }

    @PluginMethod
    public void forgetGoogle(PluginCall call) {
        GoogleAccount.forget(getActivity());
        call.resolve();
    }

    // --- transcription in the background -----------------------------------

    /**
     * Hands a shared file to a TranscribeWorker: uploaded to Eliezer (base) with
     * the Google token, then watched until its transcript is ready. uploadId is the
     * page's id for it, which makes a re-enqueue (say, with a fresher token) the
     * same upload.
     */
    @PluginMethod
    public void enqueueTranscription(PluginCall call) {
        String id = call.getString("id", "");
        String uploadId = call.getString("uploadId", "");
        String base = call.getString("base", "");
        String token = call.getString("token", "");
        if (Shares.find(getContext(), id) == null || uploadId.isEmpty() || !base.startsWith("https://") || token.isEmpty()) {
            call.reject("cannot enqueue", "bad_request");
            return;
        }
        Shares.markUpload(getContext(), id, uploadId);
        TranscribeWorker.enqueue(getContext(), id, base, token, uploadId, call.getString("origin", ""), call.getString("title", ""));
        call.resolve();
    }

    /**
     * A shared recording too long for a clip, into the app's own transcription
     * (FileUploadWorker): uploaded in the background to base (this site), signed in by
     * the web view's cookie, into My files.
     */
    @PluginMethod
    public void uploadToTranscribe(PluginCall call) {
        String id = call.getString("id", "");
        String base = call.getString("base", "");
        if (Shares.find(getContext(), id) == null || !base.startsWith("https://")) {
            call.reject("cannot upload", "bad_request");
            return;
        }
        // The web view's cookie, on disk before a worker in another moment reads it.
        android.webkit.CookieManager.getInstance().flush();
        FileUploadWorker.enqueue(getContext(), id, base, call.getString("language", "he"), Boolean.TRUE.equals(call.getBoolean("saveAudio", true)));
        call.resolve();
    }

    /** From FileUploadWorker: queued, failed (with the server's reason), or signin. */
    static void fileUpload(String shareId, String state, String error) {
        IvritNativePlugin plugin = current;
        if (plugin == null) return;
        JSObject data = new JSObject().put("id", shareId).put("state", state);
        if (error != null) data.put("error", error);
        plugin.notifyListeners("fileUpload", data, true);
    }

    /** From TranscribeWorker: queued, done, failed (with error), or signin (token ran out). */
    static void transcription(String uploadId, String state, String error) {
        IvritNativePlugin plugin = current;
        if (plugin == null) return;
        JSObject data = new JSObject().put("uploadId", uploadId).put("state", state);
        if (error != null) data.put("error", error);
        plugin.notifyListeners("transcription", data, true);
    }

    // --- shared files ------------------------------------------------------

    private static final ExecutorService UPLOADS = Executors.newSingleThreadExecutor();

    /**
     * Sends a shared file to url as the request body, with its type, its name in
     * X-Filename and the given bearer token: Eliezer's POST /app/v1/jobs. Native, so
     * the file never crosses into the page. Resolves with the HTTP status and body.
     */
    @PluginMethod
    public void uploadShared(PluginCall call) {
        Shares.Entry entry = Shares.find(getContext(), call.getString("id", ""));
        String url = call.getString("url");
        if (entry == null || url == null || !url.startsWith("https://")) {
            call.reject("nothing to upload", "not_found");
            return;
        }
        String token = call.getString("token", "");
        UPLOADS.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(60000);
                connection.setFixedLengthStreamingMode(entry.file.length());
                connection.setRequestProperty("Content-Type", entry.type);
                connection.setRequestProperty("X-Filename", URLEncoder.encode(entry.name, "UTF-8").replace("+", "%20"));
                connection.setRequestProperty("Authorization", "Bearer " + token);
                try (InputStream in = new FileInputStream(entry.file); OutputStream out = connection.getOutputStream()) {
                    byte[] buffer = new byte[64 * 1024];
                    for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                }
                int status = connection.getResponseCode();
                InputStream body = status < 400 ? connection.getInputStream() : connection.getErrorStream();
                String text = "";
                if (body != null) {
                    try (InputStream in = body) {
                        text = new String(readAll(in), StandardCharsets.UTF_8);
                    }
                }
                call.resolve(new JSObject().put("status", status).put("body", text));
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "network");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
        return out.toByteArray();
    }

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
