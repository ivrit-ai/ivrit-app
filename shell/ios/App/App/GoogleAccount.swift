import GoogleSignIn
import UIKit

/// The phone's own "Sign in with Google" (Google's iOS SDK): a Google ID token
/// for the app's server, which exchanges it for the app's session (/auth/google),
/// and, when transcripts need it, a code granting the server access to the
/// user's Drive (/auth/drive). The iPhone side of Android's GoogleAccount and
/// DriveAccess.
///
/// The SDK signs in as the app's iOS OAuth client (GIDClientID in Info.plist);
/// serverClientID is the server's web client, which the Drive code is for. The
/// server accepts ID tokens for both (GOOGLE_IOS_CLIENT_ID there).
enum GoogleAccount {
    static let driveFile = "https://www.googleapis.com/auth/drive.file"

    enum Failure: Error {
        case cancelled, noAccount, failed(String), notConfigured

        var code: String {
            switch self {
            case .cancelled: return "cancelled"
            case .noAccount: return "no_account"
            case .failed: return "failed"
            case .notConfigured: return "no_client_id"
            }
        }

        var message: String {
            if case .failed(let message) = self { return message }
            return code
        }
    }

    struct Account {
        let idToken: String
        let email: String
        let name: String
    }

    private static func configure(server: String) -> Bool {
        guard let ios = Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String,
              ios.hasSuffix(".apps.googleusercontent.com"), !server.isEmpty else { return false }
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: ios, serverClientID: server)
        return true
    }

    private static func failure(_ error: Error) -> Failure {
        let code = (error as NSError).code
        if code == GIDSignInError.canceled.rawValue { return .cancelled }
        if code == GIDSignInError.hasNoAuthInKeychain.rawValue { return .noAccount }
        return .failed(error.localizedDescription)
    }

    private static func account(_ user: GIDGoogleUser) -> Account? {
        guard let token = user.idToken?.tokenString else { return nil }
        return Account(idToken: token, email: user.profile?.email ?? "", name: user.profile?.name ?? "")
    }

    /// Silent when an account was chosen before; otherwise, only if interactive, Google's sign-in.
    @MainActor
    static func idToken(server: String, interactive: Bool, presenting: UIViewController?, done: @escaping (Result<Account, Failure>) -> Void) {
        guard configure(server: server) else { return done(.failure(.notConfigured)) }
        let interactively = {
            guard interactive, let presenting else { return done(.failure(.noAccount)) }
            GIDSignIn.sharedInstance.signIn(withPresenting: presenting) { result, error in
                if let error { return done(.failure(failure(error))) }
                guard let user = result?.user, let account = account(user) else { return done(.failure(.failed("no token"))) }
                done(.success(account))
            }
        }
        guard GIDSignIn.sharedInstance.hasPreviousSignIn() else { return interactively() }
        GIDSignIn.sharedInstance.restorePreviousSignIn { user, error in
            guard let user, error == nil else { return interactively() }
            // A fresh ID token: they last an hour.
            user.refreshTokensIfNeeded { user, error in
                if let user, let account = account(user) { return done(.success(account)) }
                interactively()
            }
        }
    }

    /// Access to the user's Drive, for transcripts: only the files the app makes.
    /// Google's screen, then a code for the server, which exchanges it (with its
    /// client secret) for lasting access.
    @MainActor
    static func authorizeDrive(server: String, presenting: UIViewController?, done: @escaping (Result<String, Failure>) -> Void) {
        guard configure(server: server) else { return done(.failure(.notConfigured)) }
        guard let presenting else { return done(.failure(.failed("no screen"))) }
        let hint = GIDSignIn.sharedInstance.currentUser?.profile?.email
        // A full sign-in, not addScopes: that refuses once the scope is granted,
        // and a reconnect after the server lost its access needs a new code.
        GIDSignIn.sharedInstance.signIn(withPresenting: presenting, hint: hint, additionalScopes: [driveFile]) { result, error in
            if let error { return done(.failure(failure(error))) }
            guard let result, result.user.grantedScopes?.contains(driveFile) == true else { return done(.failure(.cancelled)) }
            guard let code = result.serverAuthCode, !code.isEmpty else { return done(.failure(.failed("no code"))) }
            done(.success(code))
        }
    }

    /// Forgets the chosen account, so the next sign-in asks again (on signing out).
    static func forget() {
        GIDSignIn.sharedInstance.signOut()
    }

    static func handle(_ url: URL) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
    }
}
