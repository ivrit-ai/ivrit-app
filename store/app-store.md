# App Store listing

What App Store Connect asks for. Hebrew is the primary language, as on Google
Play; English is the second localization. `scripts/app-store.py` sets the
texts and screenshots from `store/app-store.json` (this file's texts, as
data); App Privacy and the review contact and sign-in are set by hand in App
Store Connect, which has no API for the first and must not hold the second in
git.

## App information

- **Name:** ivrit.ai
- **Subtitle** (30 characters):
  - he: תמלול עברית, גם במכשיר
  - en: Hebrew transcription
- **Bundle id:** ai.ivrit
- **Primary category:** Productivity. **Secondary:** Utilities.
- **Age rating:** 4+ (no objectionable content; users' own recordings only).
- **Privacy policy URL:** https://app.ivrit.ai/privacy
- **Support URL:** https://app.ivrit.ai/ (contact: info@ivrit.ai)
- **Copyright:** © 2026 ivrit.ai

## Description

**he**

> ivrit.ai מתמללת עברית: הקלטות, הודעות קוליות מוואטסאפ, הרצאות, פגישות וראיונות.
>
> • תמלול חי, תוך כדי דיבור, על הטלפון עצמו – גם בלי חשבון.
> • העלו או הקליטו קבצים ארוכים: תמלול מדויק עם זיהוי דוברים, או בטלפון עצמו, בלי שהשמע יוצא ממנו.
> • הכול נשמר ב-Google Drive שלכם, בתיקיות, עם חיפוש בכל מילה שנאמרה.
> • עריכה, האזנה וייצוא ל-Word, ‏SRT, ‏VTT ו-JSON.
> • שתפו הודעה קולית מוואטסאפ ל-ivrit.ai, וקבלו את התמלול.
> • התראות מהשירותים של ivrit.ai, כמו אליעזר – בוט התמלול בוואטסאפ ובטלגרם – מוצפנות עד המכשיר.
>
> ivrit.ai הוא מיזם ללא מטרות רווח לקידום טכנולוגיית דיבור בעברית. בלי פרסומות.

**en**

> ivrit.ai transcribes Hebrew: recordings, WhatsApp voice messages, lectures, meetings and interviews.
>
> • Live transcription as you speak, on the phone itself – even without an account.
> • Upload or record long files: accurate transcripts with speakers told apart, or on the phone itself, without the audio leaving it.
> • Everything is kept in your own Google Drive, in folders, with search across every word said.
> • Edit, listen, and export to Word, SRT, VTT and JSON.
> • Share a WhatsApp voice message to ivrit.ai and get the transcript.
> • Notifications from ivrit.ai's services, such as Eliezer – the transcription bot on WhatsApp and Telegram – encrypted all the way to your phone.
>
> ivrit.ai is a non-profit project advancing Hebrew speech technology. No ads.

- **Keywords** (100 characters):
  - he: תמלול,עברית,הקלטה,וואטסאפ,הודעה קולית,כתוביות,דיבור לטקסט,תמלול חי,אליעזר
  - en: transcription,hebrew,whatsapp,voice message,speech to text,subtitles,srt,recording,live
- **Promotional text** (170 characters, changeable any time):
  - he: תמלול עברית מדויק – חי, מקבצים ומהודעות קוליות בוואטסאפ. נשמר ב-Drive שלכם, עם חיפוש בכל מילה.
  - en: Accurate Hebrew transcription – live, from files and from WhatsApp voice messages. Kept in your Drive, with search across every word.

## Screenshots

6.7" iPhone (1290×2796), which App Store Connect takes for the 6.9" display
too: `store/capture.mjs` and `compose.mjs` make them from the real app, as for
Google Play, in `store/iphone/`. Six: Play's set without the lock-screen
notification, which is drawn as Android shows it.

## App privacy ("nutrition labels"), set by hand

Data **linked to the user**, not used for tracking:

| Type | Collected because | Used for |
|---|---|---|
| Contact info: name, email address | Google sign-in | App functionality |
| User content: audio data | Recordings sent for transcription | App functionality |
| User content: other (transcripts, messages) | Transcripts and notifications | App functionality |
| Identifiers: user id | The account | App functionality |
| Usage data: product interaction | Transcription events (sent, started, finished, length, language) to PostHog, with the email address | Analytics, App functionality |

Not collected: location, contacts, browsing history, purchases, financial
info, health, diagnostics. No tracking (no data shared with data brokers or
used for advertising), so no App Tracking Transparency prompt. Audio
transcribed on the device does not leave it. Google Analytics counts visits to
the website only; the app sends it nothing.

## Review notes

> ivrit.ai transcribes Hebrew audio. To try it:
> 1. Without signing in: the "Live" tab transcribes speech as it is spoken, on the phone itself.
> 2. Sign in with Google: [the test account, in the sign-in fields above].
> 3. "Transcribe" tab: upload a file or record a few seconds. The transcript appears in My files (kept in the account's Google Drive).
> 4. Share an audio file from Files or Voice Memos to "ivrit.ai": it is transcribed and appears in My files.
> 5. Settings → "Send a test notification".
>
> Sign in with Apple is not offered: the account exists to reach the user's transcripts in their own Google Drive (guideline 4.8's exception for an account that accesses content on that service).
> Account deletion: Settings → Delete account.

The test account needs a few sample transcripts in its Drive; its password
goes only into App Store Connect, never into git.
