package ai.ivrit.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.security.SecureRandom;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What the native side keeps between runs: this device's message key and push
 * token, and what the web app last told it (language, Communicator's address,
 * the sources' names), so a notification can be shown while the app is
 * closed.
 */
final class Store {
    private Store() {}

    static final String DEFAULT_COMMUNICATOR = "https://communicator.ivrit.ai";
    private static final int B64URL = Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP;

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("ivrit", Context.MODE_PRIVATE);
    }

    /** The AES-256 key messages to this device are sealed with, made once. */
    static synchronized byte[] pushKey(Context context) {
        String saved = prefs(context).getString("push_key", null);
        if (saved != null) return Base64.decode(saved, B64URL);
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        prefs(context).edit().putString("push_key", Base64.encodeToString(key, B64URL)).apply();
        return key;
    }

    static String pushKeyText(Context context) {
        return Base64.encodeToString(pushKey(context), B64URL);
    }

    /** Remembers the current push token; returns the one it replaces, if any. */
    static synchronized String swapToken(Context context, String token) {
        String previous = prefs(context).getString("push_token", null);
        prefs(context).edit().putString("push_token", token).apply();
        return previous == null || previous.equals(token) ? null : previous;
    }

    static void configure(Context context, String locale, String communicator, JSONArray sources) {
        SharedPreferences.Editor edit = prefs(context).edit();
        if (locale != null) edit.putString("locale", locale);
        if (communicator != null) edit.putString("communicator", communicator);
        if (sources != null) edit.putString("sources", sources.toString());
        edit.apply();
    }

    static String communicator(Context context) {
        return prefs(context).getString("communicator", DEFAULT_COMMUNICATOR);
    }

    /** A source's name in the app's language, as the web app shows it. */
    static String sourceName(Context context, String sourceId, String fallback) {
        if (sourceId == null) return fallback;
        try {
            JSONArray sources = new JSONArray(prefs(context).getString("sources", "[]"));
            boolean hebrew = "he".equals(prefs(context).getString("locale", "he"));
            for (int i = 0; i < sources.length(); i++) {
                JSONObject source = sources.getJSONObject(i);
                if (!sourceId.equals(source.optString("id"))) continue;
                String he = source.optString("name_he", "");
                return hebrew && !he.isEmpty() ? he : source.optString("name", fallback);
            }
        } catch (Exception ignored) {
            // A damaged list only costs the localized name.
        }
        return fallback;
    }
}
