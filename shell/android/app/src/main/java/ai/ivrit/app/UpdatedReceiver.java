package ai.ivrit.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The app was just updated (Google Play does it in the background). Once, ever:
 * where the phone already lets the app notify, a notification that
 * notifications work now. Builds before 234 could neither ask for them nor see
 * that they were allowed (R8 had broken Capacitor's permission lookup).
 */
public class UpdatedReceiver extends BroadcastReceiver {
    private static final String PREFS = "updates";
    private static final String ANNOUNCED = "notifications_work_announced";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(ANNOUNCED, false)) return;
        prefs.edit().putBoolean(ANNOUNCED, true).apply();
        Notifications.showNotificationsWork(context);
    }
}
