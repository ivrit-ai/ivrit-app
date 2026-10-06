package ai.ivrit.app;

import android.os.Bundle;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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
