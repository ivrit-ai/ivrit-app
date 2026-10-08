package ai.ivrit.app;

import android.os.Bundle;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Whether the app is on screen: a transcript then shows in it, not as a notification. */
    static volatile boolean visible;

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        visible = false;
        super.onPause();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IvritNativePlugin.class);
        super.onCreate(savedInstanceState);
        // The app (app.ivrit.ai) calls Communicator (communicator.ivrit.ai) with
        // its session cookie. Same site, so first-party in a browser; allowed
        // explicitly here so no WebView version's stricter reading breaks
        // sign-in.
        CookieManager.getInstance().setAcceptThirdPartyCookies(getBridge().getWebView(), true);
    }
}
