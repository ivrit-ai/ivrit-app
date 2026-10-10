# The ivrit.ai app on iPhone (App Store)

How the app comes to iPhone: the same web app (app.ivrit.ai) in a native shell,
as on Android, with the native parts iOS needs, built and shipped through the App
Store.

## What already carries over

The app is a web app loaded by a thin native shell (Capacitor, `shell/`). On
iPhone, the same shell project gets an `ios/` platform: a WKWebView loading
https://app.ivrit.ai, the same `server.url` as Android. Everything in `web/` runs
there unchanged:
- the inbox, sources, settings;
- transcribing (My files, the editor, exports, recording via getUserMedia);
- sign-in sessions (`server/app_sessions.py`), Eliezer and Communicator.

UI changes keep shipping without App Store releases, as they do on Android. Only
native code needs a release.

## What is native, and how each Android part maps

The web app talks to the shell through one plugin, `IvritNative`, called through
Capacitor's bridge (`web/app.js` `nativePlugin`). iOS gets the same plugin in
Swift with the same method names and answers, so the web app needs only small
platform checks.

| Method | Android today | iOS |
|---|---|---|
| `notificationStatus`, `requestPermission`, `openNotificationSettings` | channel importance, POST_NOTIFICATIONS | `UNUserNotificationCenter` authorization (alert, banner); settings deep link |
| `pushRegistration` | Firebase token | APNs device token, registered with Communicator as `transport: "apns"` |
| incoming push | `PushService` decrypts the sealed message and shows it | a **Notification Service Extension** decrypts the sealed message before iOS shows it (see Push) |
| `takeOpened` | notification intent extra | `UNUserNotificationCenterDelegate` response |
| `googleIdToken`, `forgetGoogle` | Credential Manager | GoogleSignIn-iOS SDK, an iOS OAuth client, same server client id |
| `authorizeDrive` | `AuthorizationClient` with offline access | GoogleSignIn `addScopes([drive.file])` with server auth code; same `/auth/drive` |
| `sharedFiles`, `discardShared`, `shareOn` | share intents into the app | a **Share Extension** target writing into an App Group folder; the app reads it there |
| `enqueueTranscription` (clips to Eliezer), `uploadToTranscribe` (files to My files) | WorkManager | background `URLSession` uploads, which iOS finishes even with the app suspended |
| `configure` | native notification text, sources | the same, kept in the App Group for the extension |

## Push

Communicator seals each message per device (AES-256-GCM, a key per device) and,
for Android, sends it through Firebase. iOS cannot run app code for a data-only
push when the app is not running, so:
- **Communicator sends straight to Apple (APNs, HTTP/2 with a .p8 token key)**: an
  alert payload with `mutable-content: 1`, a placeholder title, and the sealed
  message. A new transport beside `webpush` and `fcm` (`src/sender.js`); Firebase
  is not needed on iOS.
- **A Notification Service Extension** in the app decrypts it with the device's
  key (kept in a Keychain group shared with the app), and shows the real
  source, title and text. If it cannot, iOS shows the placeholder.
- Notifications pop up by default on iOS (banners); there is no channel to
  manage. The self-test in Settings checks authorization and banner style.

## Signing in

- **Google, natively:** GoogleSignIn-iOS, with an iOS OAuth client (bundle id
  `ai.ivrit.app`) in the same Google Cloud project. It returns an ID token for the
  server's client, which `/auth/google` exchanges for the app's session, as on
  Android.
- **Drive:** the same SDK adds the `drive.file` scope and returns a server auth
  code for `/auth/drive`.
- **Sign in with Apple (App Store rule 4.8):** an app offering a third-party sign-in
  must also offer an equivalent private one, unless the account exists to reach the
  user's content on that service. Transcripts live in the user's Google Drive,
  which is the case for the exception. Whether to rely on it is a decision (below).

## Shares

A Share Extension (audio and video types) copies the file into the App Group
container with its name and a guess at its origin (WhatsApp voice notes are named
`PTT-*.opus`; iOS does not tell an extension which app shared). It opens nothing.
The next time the app is active, it takes the file as on Android: a clip goes to
Eliezer, a longer recording to My files.

## Building and shipping

- **Needs a Mac:** Xcode builds and signs iOS apps; this repo is developed on
  Linux. Either a Mac (local builds, Xcode signing), or CI on macOS (GitHub
  Actions' macOS runners, or Xcode Cloud) with fastlane and an App Store Connect
  API key, building on each tag and uploading to TestFlight.
- **Accounts:** an Apple Developer Program membership ($99 a year): as an
  organization (needs a D-U-N-S number for ivrit.ai, a few days to weeks), or
  as an individual (faster; the store shows the person's name).
- **TestFlight first:** internal testers (up to 100, no review), then external
  ones (a light review), then the App Store.
- **The store:** screenshots (6.9" and 6.5" iPhone, plus iPad only if iPad is
  supported - suggested: iPhone only at first), the privacy "nutrition" labels
  (the same data as Google Play's safety form), the privacy policy
  (app.ivrit.ai/privacy), and in-app account deletion (Settings, already there).
- **App Review:** reviewers must sign in, so the review notes give a Google test
  account. Rule 4.2 (more than a website) is met by native notifications,
  sharing into the app, background uploads and native sign-in.
- **Universal Links:** app.ivrit.ai serves `/.well-known/apple-app-site-association`,
  so transcript and message links open in the app.

## Order of work

1. **Prerequisites (you):** Apple Developer account, App Store Connect record
   (`ai.ivrit.app`), APNs key (.p8), iOS OAuth client in Google Cloud, and the
   Mac or CI decision.
2. **The shell:** `shell/ios` (Capacitor 8), the `IvritNative` plugin in Swift
   (status, permissions, Google sign-in and Drive, opened notifications), app-bound
   domains for app.ivrit.ai, microphone permission text.
3. **Push:** Communicator's APNs transport (with tests against a fake APNs), the
   Notification Service Extension, device registration as `apns`.
4. **Shares and background uploads:** the Share Extension and the App Group;
   `URLSession` background uploads for clips and files.
5. **Web app:** the few platform checks (iOS settings wording, no Android
   channel help), and Universal Links.
6. **Release:** CI to TestFlight, internal testing, store listing, review.

Later: on-device transcription on iPhone (WebGPU in WKWebView from iOS 26, or
WhisperKit on the Neural Engine), from what the Android lab shows.
