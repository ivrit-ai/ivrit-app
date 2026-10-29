# The ivrit.ai app on iPhone (App Store)

The same web app (app.ivrit.ai) in a native shell, as on Android, with the
native parts iOS needs, built and shipped through the App Store. One codebase:
only the native shell is per platform.

## What is shared, and what is not

| Part | Where | Shared? |
|---|---|---|
| The app itself: inbox, transcription, My files, editor, settings | `web/` | One copy, loaded from app.ivrit.ai by both shells and browsers. Changes ship without a store release. |
| The server, Eliezer, Communicator | `server/`, other repos | One copy. Communicator reaches iPhones through Apple (`apns`) as it reaches Android through Firebase (`fcm`). |
| Shell settings | `shell/capacitor.config.json` | One file, a section per platform. |
| What the page may ask of the shell | `shell/native-api.json` | One contract. `scripts/check-native-api.mjs` checks that both shells implement it and that the web app asks for nothing else. CI runs it. |
| Native code | `shell/android` (Java), `shell/ios` (Swift) | Written twice, to the contract. |

The page tells the platforms apart only for wording, from
`notificationStatus().platform` (which settings screen to describe). Behaviour
comes from the shell's answers: `pushRegistration()` names its transport, for
instance, so the page never has to know which push service is behind it.

## The iPhone shell (`shell/ios`)

| Contract | Android | iPhone |
|---|---|---|
| `notificationStatus`, `requestPermission`, `openNotificationSettings` | channel importance, POST_NOTIFICATIONS | `UNUserNotificationCenter`: authorization, and whether banners show; the app's notification settings |
| `pushRegistration`, event `pushToken` | Firebase token | APNs token (`transport: "apns"`, with `environment`: sandbox for development builds, production for TestFlight and the App Store); a changed token is noticed at launch |
| a message arriving | `PushService` opens the sealed message and shows it | `NotificationService` (a Notification Service Extension) opens it before iOS shows it, with the device's key from a Keychain group shared with the app |
| `takeOpened`, event `opened` | notification intent | `UNUserNotificationCenterDelegate` |
| `googleIdToken`, `forgetGoogle`, `authorizeDrive` | Credential Manager, AuthorizationClient | Google's iOS SDK (GoogleSignIn 8) with the app's iOS OAuth client; the Drive code is for the server's web client, as on Android |
| `sharedFiles`, `discardShared`, `shareOn`, event `shared` | share intents | `ShareExtension`: audio and video (and WhatsApp's Opus voice notes) into an App Group folder; the app takes them when it is next open |
| `enqueueTranscription`, `uploadToTranscribe`, events `transcription`, `fileUpload` | WorkManager | a background `URLSession`, which iOS carries on with the app closed; transcripts are awaited while the app runs, then in background refreshes |
| `configure` | SharedPreferences | the App Group, which the notification extension reads |
| `openAppSettings` (feature `appSettings`) | the app's details page | the app's page in Settings (the microphone) |
| on-device transcription (Live, files) | native, sherpa-onnx, in the background (`localTranscription`) | in the page (WebAssembly), while the app is open; `readShared` (feature `readShared`) hands it shared recordings in pieces when the user transcribes on the device only |

How it differs from Android, because iOS works differently:
- **A share cannot open the app.** The share extension saves the recording,
  says so, and leaves a notification that opens the app on it.
- **Background time is short.** Android follows a clip's transcript for about
  20 minutes after the upload; iOS gives moments, then background refreshes
  when it chooses. The page catches up whenever the app opens.
- **WhatsApp is recognised by its file names** (`PTT-…`, `…-WA0001…`, `.opus`):
  iOS does not tell a share extension which app shared.

### The project

`shell/ios/App/project.yml` describes the Xcode project (XcodeGen), so the
generated `App.xcodeproj` is not kept in git: three targets (`App`,
`NotificationService`, `ShareExtension`), `Shared/` compiled into all three,
Capacitor's packages (`CapApp-SPM`, which `npx cap sync ios` manages) and
GoogleSignIn. `Config.xcconfig` holds the settings that are not secrets: the
Apple team and the iOS OAuth client.

`scripts/build-ios.sh simulator` builds it unsigned (does it compile);
`scripts/build-ios.sh testflight` archives, signs for the App Store, and uploads.
Signing is done through the App Store Connect API rather than Xcode's automatic
signing (which, in CI, failed to authenticate with the same key, and needs a
registered device besides): one Apple Distribution certificate, made once by
`scripts/ios-signing.py certificate` (its private key only in `~/keys` and CI's
secrets), and App Store profiles for the app and both extensions, made fresh by
`scripts/ios-signing.py profiles` on each build. The build number counts commits,
as Android's does. Both need a Mac; GitHub Actions provides one
(`.github/workflows/ios.yml`): every change to `shell/` is built for the
simulator, and "Run workflow" with *testflight* uploads a build.

## What has to be set up (once)

| What | Where it goes |
|---|---|
| Apple Developer Program membership (organization: needs ivrit.ai's D-U-N-S number) | — |
| The team id (Membership page) | `IVRIT_TEAM_ID` in `Config.xcconfig`, GitHub secret `IVRIT_TEAM_ID`, `APPLE_TEAM_ID` on the app server (xhost), `APNS_TEAM_ID` on Communicator |
| App Store Connect: the app (bundle id `ai.ivrit`, the iPhone app's own; Android's is `ai.ivrit.app`), the extensions `ai.ivrit.NotificationService` and `ai.ivrit.ShareExtension` (registered by `ios-signing.py`), App Group `group.ai.ivrit` | The app record and the App Group are made by hand; the group must be assigned to all three identifiers by hand too (the API cannot) |
| App Store Connect API key (.p8, key id, issuer id) | GitHub secrets `ASC_KEY` (the file's contents), `ASC_KEY_ID`, `ASC_ISSUER_ID` |
| The distribution certificate (`ios-signing.py certificate`; expires 2027-10-12) | `~/keys/ios-distribution.p12` and its `.password`; GitHub secrets `IOS_DIST_P12` (base64), `IOS_DIST_P12_PASSWORD`, `IOS_CERT_ID` |
| APNs key (.p8, key id) | Communicator secrets `APNS_KEY`, `APNS_KEY_ID` (and `APNS_TEAM_ID`) |
| Google Cloud: an iOS OAuth client for `ai.ivrit`, in the same project as the web client | `GOOGLE_IOS_CLIENT_ID` and `GOOGLE_REVERSED_CLIENT_ID` in `Config.xcconfig`; `GOOGLE_IOS_CLIENT_ID` on the app server |

Nothing secret is committed: the .p8 files go to secrets straight from their
files.

## App Store review

- **Sign-in:** reviewers need a Google account with sample transcripts; its
  details go in the review notes (`store/app-store.md`).
- **Sign in with Apple (guideline 4.8):** not offered. The account exists to
  reach the user's transcripts in their Google Drive, which is the exception
  4.8 makes; added only if review asks.
- **More than a website (4.2):** native notifications, sharing into the app,
  background uploads, native sign-in.
- **Account deletion (5.1.1(v)):** in Settings, in the app.
- **iPhone only** at first (`TARGETED_DEVICE_FAMILY = 1`).
- **Encryption:** standard only (`ITSAppUsesNonExemptEncryption = NO`).

The listing, the privacy answers and the review notes are drafted in
`store/app-store.md`.

On-device transcription in the iPhone's WebKit is checked in the iOS
Simulator's Safari by `scripts/ios-webkit-probe.mjs` (`.github/workflows/ios-webkit.yml`):
on iOS 26.2 it transcribes the Hebrew fixture as AAC and as Ogg Opus (WhatsApp's
voice notes), on one thread (the page is not cross-origin isolated), and has
what Live needs (getUserMedia, AudioWorklet, MediaRecorder).

## Releasing

`.github/workflows/app-store.yml` runs `scripts/app-store.py` with the same
App Store Connect key: `status`; `prepare` (the version from `shared/app.json`,
the texts in `store/app-store.json`, categories, age rating, price, the
screenshots in `store/iphone/`, the newest processed build, the review notes);
`submit`. App Privacy and the review contact and sign-in are filled in by hand.
The build itself comes first, from `ios.yml` run with *testflight*.

## Later

On-device transcription natively (sherpa-onnx, as on Android), or ivrit.ai's
Turbo model (whisper.cpp on Metal).
