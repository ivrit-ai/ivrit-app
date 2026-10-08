# ivrit.ai app

ivrit.ai's app: transcripts and other messages from ivrit.ai services as
notifications, and Hebrew transcription. On the web at https://app.ivrit.ai;
on Android as `ai.ivrit.app`, a native shell (Capacitor) that loads the same
web app, adding Firebase push, Android's notification settings and shares.

- `web/` — the app itself: plain JS, no build step. Hebrew and English, light
  and dark.
- `server/` — the app's server (Python, FastAPI), which began as a copy of
  transcribe.ivrit.ai's (`git subtree`, history kept): transcription (uploads,
  Drive, quota, users' own RunPod keys) scheduled through Eliezer's hub
  (`server/hub.py`), and the app's own site (`server/app_site.py`): `web/`,
  `/config.js`, sign-in sessions (`server/app_sessions.py`), `/privacy`.
  Tests: `server/tests/test_hub_mode.py` (end to end, with the hub).
- `web/transcription/` — the Transcribe tab: everything transcribe.ivrit.ai does
  (files, recording, transcripts with speakers, editing in its format, exports,
  own RunPod keys, Stats for Nerds), in the app's own parts. Its words in
  Hebrew, Yiddish and English are in `strings.js`. Test in a browser:
  `store/test-transcribe.mjs`.
- `shell/` — the native shells: `shell/android/` now, `shell/ios/` later. The
  web app is loaded from app.ivrit.ai, so UI changes ship without a store
  release; only native code needs one. Native code is in
  `shell/android/app/src/main/java/ai/ivrit/app/`.
- `shared/` — what the web app and the shells share: `app.json` (name,
  package, version, services) and `brand/` (the mark, traced; see its README).
- `scripts/` — `sync-client.sh`, `build-icons.sh`, `build-android.sh`.

## Services

**Communicator** (communicator.ivrit.ai, repo ivrit-ai/communicator) holds
accounts, devices, sources and messages. The app calls its API cross-origin;
Communicator allows that for the origins in its `APP_ORIGINS`, and the
session cookie travels because both are on ivrit.ai. Signing in goes through
Communicator's login and comes back here (`/auth/complete?next=`). The app's
devices register as `client: "app"`.

Communicator's client code (device store, API client, push handler) is
vendored in `web/client/`, pinned to a commit recorded in
`web/client/SOURCE`. To update it:

    scripts/sync-client.sh ../notifier

**Transcribing** is the app's own (the Transcribe tab, served by `server/`),
with the files in each user's Google Drive, the same folder transcribe.ivrit.ai
uses, so both see the same files while transcribe.ivrit.ai still runs. Jobs are
scheduled by Eliezer's hub (credits), which also runs Eliezer's voice messages.
Audio shared into the app: a short clip goes to Eliezer (its inbox message), a
longer recording is transcribed into My files (in the Android app, uploaded in
the background).

## Inside the app

`web/app.js` checks for the shell (`window.Capacitor`) and then:

- **Push** comes through Firebase, not web push. The native side
  (`IvritNativePlugin`) hands the page a Firebase token and an AES-256 key it
  generated; the page registers them with Communicator (`transport: "fcm"`).
  Communicator seals each message with the key, so Firebase cannot read it,
  and `PushService` opens, shows and acks it, with the app closed too.
- **Notifications pop up**: the app's "Messages" channel is created at high
  importance, and the app can see when the user turned it down, saying so and
  opening that exact settings screen.
- **Sign-in** opens the browser (Google refuses web views). Communicator
  hands a one-time code back to `ai.ivrit.app://auth`, which the page
  redeems with a verifier only it holds (`/auth/handoff`, PKCE-style).

## Building Android

    scripts/build-android.sh

Produces `dist/ivrit-app-<version>-<n>.aab` (for Play) and `.apk` (to install
directly), signed with the upload key. Needs, outside the repo:
`~/keys/ivrit-app-upload.jks` with its password in
`~/keys/ivrit-app-upload.password` (back both up: Play needs this key for
every update), and Firebase's `~/keys/ivrit-app-google-services.json`.
The toolchain (Node 22, JDK 21, Android SDK) is found under `~/.local/opt`;
see `scripts/android-env.sh`.

    scripts/publish-android.sh "release notes"

Builds and releases to Google Play's internal testing track, through the
publishing API as the `play-publisher` service account
(`~/keys/ivrit-app-play-publisher.json`). `node scripts/play.mjs status`
lists the tracks and their releases.

## Running

    npm install
    COMMUNICATOR_URL=http://localhost:3000 PORT=8080 npm start

Communicator must list the app's origin in `APP_ORIGINS`, and, for the
Android app, `APP_HANDOFF_URLS=ai.ivrit.app://auth` and
`FCM_SERVICE_ACCOUNT` (Firebase's service-account key).

## Deploying

xhost app `ivritai/ivrit-app` (template "app"), deployed from this repo on
GitHub. `COMMUNICATOR_URL` and `TRANSCRIBE_URL` default to the public
addresses.

## Lab

`app.ivrit.ai/lab/` (linked from Settings → Diagnostics) tests transcription on
the device itself: whether WebGPU is there (in Chrome, and in the app's
WebView), a kernel benchmark, and a 30-second Hebrew sample through ivrit.ai's
turbo model. It runs the whisper-gpu engine, built into `web/lab/whisper/` by
`scripts/build-lab.sh`. Every result is posted to `/lab/report` and logged as
a `lab_report` line.

`web/icons/whatsapp-glyph-2026.svg` is WhatsApp's official glyph (Digital_Glyph_Green_RGB_2026,
from the logo pack at meta.com/brand/resources/whatsapp/whatsapp-brand), used
unmodified, as their terms require, to mark recordings shared from WhatsApp.
Images are cached as never changing: replace one under a new name.
