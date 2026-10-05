# ivrit.ai app

ivrit.ai's app: transcripts and other messages from ivrit.ai services as
notifications, and Hebrew transcription. On the web at https://app.ivrit.ai;
on Android as `ai.ivrit.app`, a Chrome shell around the same web app.

- `web/` — the app itself: plain JS, no build step. Hebrew and English, light
  and dark.
- `server.js` — serves `web/`, `/config.js` (where the services are),
  `/privacy`, and `/.well-known/assetlinks.json` for Android.
- `shared/` — what the web app and the shells share: `app.json` (name,
  package, origins) and `brand/` (the mark, traced; see its README).
- `scripts/` — `sync-client.sh` and `build-icons.sh`.
- `android/` — the Android shell (to come).

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

**transcribe.ivrit.ai** does transcription. The Transcribe tab links to it,
and audio shared into the app is handed to its share target
(`/share-target`, field `media`) by a form post.

## Running

    npm install
    COMMUNICATOR_URL=http://localhost:3000 PORT=8080 npm start

Communicator must list the app's origin in `APP_ORIGINS`.

## Deploying

xhost app `ivritai/ivrit-app` (template "app"), deployed from this repo on
GitHub. `COMMUNICATOR_URL` and `TRANSCRIBE_URL` default to the public
addresses.
