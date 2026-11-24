package ai.ivrit.app;

import android.accounts.Account;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.common.api.Scope;
import java.util.Collections;

/**
 * Access to the user's Google Drive, for transcripts: only the files the app itself
 * makes (drive.file). Asked on the phone with Google's own authorization screen,
 * which answers with a code for the app's server; the server exchanges it (with its
 * client secret) for lasting access, and keeps the transcripts there.
 */
final class DriveAccess {
    private DriveAccess() {}

    static final String DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

    /**
     * clientId: the server's (web) OAuth client, which the code is for. email: the
     * account signed in to the app, whose Drive it must be (else Google may pick
     * another of the phone's accounts); empty when not known.
     */
    static AuthorizationRequest request(String clientId, String email) {
        AuthorizationRequest.Builder builder = AuthorizationRequest.builder()
            .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_FILE)))
            // A refresh token every time, so a reconnect after the server lost it works.
            .requestOfflineAccess(clientId, true);
        if (!email.isEmpty()) builder.setAccount(new Account(email, "com.google"));
        return builder.build();
    }
}
