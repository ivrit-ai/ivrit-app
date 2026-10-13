# Folders, watched phone folders, and search

Three features over My files, which lives in the user's Google Drive:

1. **Folders** in My files: real Drive folders under the app's own Drive folder,
   browsable in the app.
2. **Watched folders** on Android: each chosen phone folder is transcribed
   automatically into a My files folder of the user's choosing.
3. **Search** across every transcript in the app's Drive folder, fast and on the
   device.

## Where things stand

- My files is one flat Drive folder, `transcribe.ivrit.ai` (the old site's too):
  per transcript `<id>.json.gz` (segments), `<id>.edits.json.gz` (the edit
  overlay), `<id>.opus` (audio); the list is `toc.json.gz`, which both sites
  rewrite whole under a per-user lock.
- Drive access is `drive.file`: the app sees only what it created. It cannot
  list the user's other folders, and nothing here needs it to.
- Every Drive operation goes through one storage class
  (`GoogleDriveStorageBackend`, and `LocalFileStorageBackend` in local mode),
  bound to a folder by name. The routes that touch Drive are `/appdata/toc`,
  `results`, `edits` (get and save), `audio` (get and stream), `rename`,
  `delete`, `donate_data`, `data-dir`, upload validation, and the job's
  completion (`reattached`) and failure (`handle_failed_job`).

## Decisions

| Question | Decision |
|---|---|
| Where destination folders live | Under the app's Drive folder, made by the app (any depth) |
| What a folder holds | Self-contained: its own `toc.json.gz`, the transcripts' `.json.gz`/`.edits.json.gz`/`.opus`, a readable Google Doc per transcript, and its own search index |
| Search scope | Transcripts in the app's Drive folder (all its folders). Clips and the inbox are not searched. The index carries the text; a result opens the transcript, and its audio loads only when played |
| Where the search index lives | The user's Drive, one file per folder; searched on the device |

The old site reads only the top folder's `toc.json.gz`, so it never sees
transcripts in subfolders, and so never shows one it cannot open. The top
folder keeps today's layout exactly.

## 1. Folders

### Drive layout

```
transcribe.ivrit.ai/                 (top folder: unchanged, shared with the old site)
  toc.json.gz   search.json.gz
  <id>.json.gz  <id>.edits.json.gz  <id>.opus  <title>.gdoc (readable)
  Calls/                             (a Drive folder the app made)
    toc.json.gz   search.json.gz
    <id>.json.gz  <id>.edits.json.gz  <id>.opus  <title>.gdoc
    2026/ …                          (folders nest)
```

- **The folder tree is Drive's**: one query lists every folder the app made
  (`drive.file` shows exactly those), with their parents. No registry to keep in
  step.
- **A folder is addressed by its Drive id.** Every route that works on a
  transcript takes an optional `folder` (the top folder when absent, so the
  current web app and the Android/iPhone builds keep working). The server checks
  the id is the app's top folder or below it (by its parents, cached), so a
  request cannot reach another folder.
- **The storage class takes the folder** per call instead of being bound to one
  name; local mode maps folders to subdirectories.
- **Locks** become per user and folder; a move takes both folders' locks, in id
  order.

### The readable document

- Each transcript gets a Google Doc beside its JSON, named by the transcript's
  title: speakers and text in turns, like the app's Word export
  (`docxHtml`), right-to-left for Hebrew and Yiddish. Uploaded as HTML and
  converted by Drive, so it is a real Doc: readable, shareable, found by Drive's
  own search, and free of the user's storage quota.
- The server renders it, with edits applied: `effective()` (substituting edited
  text and swapped speakers by segment index, `transcript.js`) is ported to
  Python, with a shared fixture checked against both.
- Made when a transcript completes; re-rendered on an edit save, a speaker
  rename and a title rename; trashed with the transcript. Its Drive id is kept in
  the toc entry (`doc_id`).
- In the top folder, only for transcripts the new app makes or edits; the
  old site's own transcripts get one when the app first touches them.

### Routes

| Route | Does |
|---|---|
| `GET /appdata/folders` | The tree: `[{id, name, parent}]`, plus the top folder's id |
| `POST /appdata/folders` `{name, parent}` | Makes a folder |
| `POST /appdata/folders/{id}/rename` `{name}` | Renames it in Drive |
| `DELETE /appdata/folders/{id}` | Moves it to Drive's trash with everything in it (recoverable for 30 days); the app asks first |
| `POST /appdata/move` `{results_id, from, to}` | Moves a transcript's files (Drive parents), its toc entry and its search entry |
| existing routes | take `folder` |
| `POST /upload`, the job spec | take `folder`: where the finished transcript is written |

The hub job spec carries the folder, so a transcript lands in the right folder
after a server restart too.

### The app

- My files shows the current folder: its subfolders first, then its
  transcripts; a breadcrumb path above (tap to go up); `#f/<folder>` in the
  address, so back works and links open there.
- New folder, rename, delete (with its count, and that Drive keeps it in the
  trash for 30 days), and "Move to…" on a transcript (a folder picker sheet).
- Upload and record ask for the destination (the current folder by default).
- The reader's address becomes `#t/<id>?f=<folder>`; links without a folder
  (notifications, old links) search the folders for the id.

## 2. Search

### The index

- One `search.json.gz` per folder, beside its `toc.json.gz`:
  `{version: 1, entries: {<id>: {title, created, duration, language, stamp,
  segments: [[start, speaker, text], …]}}}`, the text as edited, speakers by
  their given names. About 30–40 KB compressed per hour of audio.
- `stamp` names what the entry was made from (the JSON's and the edits file's
  Drive versions), so a stale entry is recognised.
- The server writes it wherever it writes the toc: completion, edit save,
  rename, move, delete.
- **Reconciliation**, when the app asks for a folder's index: entries for
  transcripts the old site made or edited (no index update there) are filled in
  or refreshed from their files, a few at a time, so the first search of an
  existing account works too.

### On the device

- `GET /appdata/folders` reports each folder's index version; the app downloads
  only indexes that changed (`GET /appdata/search-index?folder=`) and keeps them
  in IndexedDB.
- Searching is in memory: each segment's text normalised once at load, then
  plain substring matching, which is milliseconds over hundreds of hours.
- Hebrew normalisation: niqqud and cantillation dropped, final letters (ך ם ן ף
  ץ) folded to their regular forms, geresh and gershayim variants unified; a word
  also matches after a one- or two-letter prefix (ו ה ב ל מ ש כ), so "בית"
  finds "ובבית".
- Results grouped by transcript, newest first: the title, the folder path, and
  each hit as a snippet with its time and speaker. Opening one opens the reader at
  that segment, highlighted; the transcript and audio load then, as they do
  today.
- A search box in My files, over all folders, with "this folder only" as a
  filter.

## 3. Watched folders (Android)

- **Watches:** each pairs a phone folder (chosen with Android's folder picker,
  with lasting access to that folder only) with a My files folder (chosen or made
  on the spot), plus language, speakers, and filters: audio only (default),
  minimum and maximum length, Wi-Fi only, paused.
- **Finding new files:** one periodic check (WorkManager, every 15 minutes, the
  minimum) over all watches, and one whenever the app opens. A file is taken
  once its size and modified time are unchanged across two checks (a recording
  in progress is not cut). Each file is uploaded once (remembered by document
  id, size, modified time). Only files added after the watch starts; existing
  files are never backfilled.
- **Uploading:** the existing `FileUploadWorker`, with `folder`. The server
  accepts the app's own session token on `/upload` (90 days, renewable; the web
  view's cookie lasts 30), so a watch runs for months unattended, and takes an
  upload id, so a retry never makes a second job.
- **The quota:** when the free weekly minutes run out, watches pause and Settings
  says why; they resume when the quota refills. Users with their own RunPod key
  are not limited.
- **Settings:** the list of watches with their state (watching, last checked,
  waiting files, last error), add, edit, pause, remove. Turning the first one on
  shows a disclosure: files in the folder are uploaded automatically, including
  other people's voices in call recordings.
- **The contract:** new methods in `shell/native-api.json` marked
  `platforms: ["android"]` (`watches`, `addWatch`, `updateWatch`, `removeWatch`)
  and an event (`watch`). The web app shows the feature when the shell says it
  has it (a `features` list from `notificationStatus`), not by platform name;
  `check-native-api.mjs` allows a single-platform method behind that check.

## Order and size

| Phase | Work | Estimate |
|---|---|---|
| 1 | Folders: storage by folder, routes with `folder`, folder routes, moves, readable Docs (and the Python `effective`), job spec, My files browsing and moving, upload destination; tests in the hub harness | 3 days |
| 2 | Search: per-folder index written by the server, reconciliation, the device cache, Hebrew normalisation, the search screen, opening at a hit | 3 days |
| 3 | Watched folders: the Android watches and worker, `/upload` with the app token and upload id, Settings, the disclosure, real-phone tests (voice recorder, call recorder, WhatsApp), a Play release | 3–4 days + Play review |

Phase 1 helps every platform, and phase 3 needs its folders. The privacy policy
and Play's data-safety form, already due for PostHog and My files, are updated
with phase 3, which uploads files automatically.

## Risks

- **Two servers write the top folder** until the old site is retired: the old
  site does not update `search.json.gz` or make readable Docs there.
  Reconciliation covers the index; Docs for those transcripts appear when the app
  first touches them.
- **Drive's rate limits:** a move or a delete is a few calls per transcript; a
  folder delete is one call (Drive trashes the contents with it). Reconciling a
  large account is throttled to a few transcripts at a time.
- **Renames in Drive's own UI** (a folder or a Doc renamed there) are picked up
  from Drive on the next listing; a transcript's title stays the app's.
- **A very large account** (thousands of hours) means tens of megabytes of index:
  loaded per folder, on demand, rather than all at once.
