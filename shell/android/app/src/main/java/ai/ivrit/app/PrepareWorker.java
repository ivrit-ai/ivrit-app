package ai.ivrit.app;

import android.content.Context;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.ForegroundInfo;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Turbo made ready before the first recording needs it: the model and the speaker
 * model downloaded, the decoder's threads tuned on the CPU (TurboGpu.prepare). Not
 * the GPU's check, which a recording does: a driver that crashes would take the app
 * down with it, open as it often is when this runs. In the background, on Wi-Fi and while
 * charging, told in a quiet notification (the download's size among it); only where
 * transcribing on the phone is in use (relevant). Whatever it has not done, the
 * first recording still does on its way.
 */
public class PrepareWorker extends Worker {
    private static final String TAG = "IvritPrepare";
    private static final String WORK = "turbo-prepare";
    private static final int NOTIFICATION = "turbo-prepare".hashCode();
    private long told;

    public PrepareWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** Queued where it is wanted and not done yet (the app's start, a setting changed): it waits for Wi-Fi and a charger. */
    static void schedule(Context context) {
        String variant = Turbo.chosen(context);
        if (variant == null || !relevant(context) || ready(context, variant)) return;
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .setRequiresCharging(true)
            .setRequiresBatteryNotLow(true)
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(PrepareWorker.class)
            .setConstraints(constraints)
            // Another recording has the model: tried again a minute on.
            .setBackoffCriteria(androidx.work.BackoffPolicy.LINEAR, 60, java.util.concurrent.TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.KEEP, request);
    }

    /**
     * This phone transcribes recordings itself: on-device only, a folder watched for
     * it (or for when the free time runs out), no account (its files are its own), or
     * it has done so before.
     */
    static boolean relevant(Context context) {
        if (Store.localOnly(context) || Store.usedOnDevice(context)) return true;
        String token = Store.appToken(context);
        if (token == null || token.isEmpty()) return true;
        for (Watches.Watch w : Watches.all(context)) {
            if (!Watches.SERVER.equals(w.where)) return true;
        }
        return false;
    }

    static boolean ready(Context context, String variant) {
        return Turbo.ready(context, variant) && Turbo.downloaded(context, Speakers.MODEL) && TurboGpu.prepared(context, variant);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String variant = Turbo.chosen(context);
        if (variant == null) return Result.success();
        // A recording has the model now: later, when it is done.
        if (!LocalTranscribeWorker.TURN.tryAcquire()) return Result.retry();
        try {
            tell("downloading", 0, variant);
            Turbo.ensure(context, variant, (done, total) -> tell("downloading", done / (double) Math.max(1, total), variant));
            Speakers.ensure(context, (done, total) -> {});
            TurboGpu.prepare(context, variant);
            Notifications.showPrepared(context);
            return Result.success();
        } catch (Exception | LinkageError e) {
            if (isStopped()) return Result.success(); // Wi-Fi or the charger went: queued again at the app's next start
            Log.w(TAG, "preparing Turbo failed", e);
            return Result.retry();
        } finally {
            LocalTranscribeWorker.TURN.release();
        }
    }

    private void tell(String phase, double fraction, String variant) {
        long now = System.currentTimeMillis();
        if (now - told < 1000 && fraction > 0 && fraction < 1) return;
        told = now;
        android.app.Notification n = Notifications.prepareProgress(getApplicationContext(), phase, (int) Math.round(fraction * 100),
            Turbo.megabytes(variant), WorkManager.getInstance(getApplicationContext()).createCancelPendingIntent(getId()));
        try {
            if (Build.VERSION.SDK_INT >= 29) setForegroundAsync(new ForegroundInfo(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC));
            else setForegroundAsync(new ForegroundInfo(NOTIFICATION, n));
        } catch (Exception ignored) {
            // The notification is only a view of the work.
        }
    }
}
