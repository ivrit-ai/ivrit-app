package ai.ivrit.app;

import android.app.Activity;
import android.os.CancellationSignal;
import androidx.annotation.NonNull;
import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * The phone's own "Sign in with Google" (Android's Credential Manager): a Google ID
 * token, signed by Google, that services can verify without asking anyone else. The
 * app sends it to Eliezer with shared clips. Silent when the user already chose an
 * account; otherwise, only if asked to be interactive, Google's account picker.
 */
final class GoogleAccount {
    private GoogleAccount() {}

    interface Result {
        void ok(String idToken, String email, String name);

        /** code: "cancelled", "no_account" (silent and none chosen yet), or "failed". */
        void error(String code, String message);
    }

    private static final Executor EXECUTOR = Executors.newSingleThreadExecutor();

    static void idToken(Activity activity, String clientId, boolean interactive, Result result) {
        // Silent first: an account this app was already allowed to use, picked automatically.
        GetGoogleIdOption silent = new GetGoogleIdOption.Builder()
            .setServerClientId(clientId)
            .setFilterByAuthorizedAccounts(true)
            .setAutoSelectEnabled(true)
            .build();
        request(activity, new GetCredentialRequest.Builder().addCredentialOption(silent).build(), result, error -> {
            if (error instanceof NoCredentialException && interactive) {
                GetSignInWithGoogleOption pick = new GetSignInWithGoogleOption.Builder(clientId).build();
                request(activity, new GetCredentialRequest.Builder().addCredentialOption(pick).build(), result, null);
                return true;
            }
            return false;
        });
    }

    interface Fallback {
        boolean handle(GetCredentialException error);
    }

    private static void request(Activity activity, GetCredentialRequest request, Result result, Fallback fallback) {
        CredentialManager.create(activity).getCredentialAsync(
            activity,
            request,
            new CancellationSignal(),
            EXECUTOR,
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (credential instanceof CustomCredential
                        && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        try {
                            GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(credential.getData());
                            result.ok(google.getIdToken(), google.getId(), google.getDisplayName());
                        } catch (Exception e) {
                            result.error("failed", String.valueOf(e.getMessage()));
                        }
                    } else {
                        result.error("failed", "unexpected credential " + credential.getType());
                    }
                }

                @Override
                public void onError(@NonNull GetCredentialException e) {
                    if (fallback != null && fallback.handle(e)) return;
                    String code = e instanceof GetCredentialCancellationException
                        ? "cancelled"
                        : e instanceof NoCredentialException ? "no_account" : "failed";
                    result.error(code, String.valueOf(e.getMessage()));
                }
            }
        );
    }

    /** Forgets the chosen account, so the next sign-in asks again (on signing out). */
    static void forget(Activity activity) {
        CredentialManager.create(activity).clearCredentialStateAsync(
            new ClearCredentialStateRequest(),
            new CancellationSignal(),
            EXECUTOR,
            new CredentialManagerCallback<Void, ClearCredentialException>() {
                @Override
                public void onResult(Void unused) {}

                @Override
                public void onError(@NonNull ClearCredentialException e) {}
            }
        );
    }
}
