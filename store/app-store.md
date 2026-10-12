# App Store listing (draft)

What App Store Connect asks for, ready to paste. Hebrew is the primary
language, as on Google Play; English is the second localization.

## Before submitting: the privacy policy

The policy at app.ivrit.ai/privacy predates transcription moving into the app.
It says files go to transcribe.ivrit.ai, and that the app has "no analytics or
tracking tools". Today:
- files and recordings go to app.ivrit.ai's own server, are transcribed on
  RunPod, and the transcripts are kept in the user's Google Drive;
- the server sends transcription events to PostHog (`capture_event` in
  `server/app.py`), with the user's email address.

Either the policy and the answers below say so, or the email leaves the events
(or PostHog is turned off on app.ivrit.ai). The answers below assume the
email is removed from the events, which then describe usage without
identifying anyone. Google Play's data safety form needs the same correction.

## App information

- **Name:** ivrit.ai
- **Subtitle** (30 characters):
  - he: תמלול עברית והתראות
  - en: Hebrew transcription & alerts
- **Bundle id:** ai.ivrit
- **Primary category:** Productivity. **Secondary:** Utilities.
- **Age rating:** 4+ (no objectionable content; users' own messages only).
- **Privacy policy URL:** https://app.ivrit.ai/privacy
- **Support URL:** https://app.ivrit.ai/ (contact: info@ivrit.ai)
- **Copyright:** © 2026 ivrit.ai

## Description

**he**

> ivrit.ai מתמללת עברית – הקלטות, הודעות קוליות מוואטסאפ וקבצים ארוכים – ומביאה אליכם את התמלולים.
>
> • שתפו הודעה קולית מוואטסאפ או הקלטה מכל אפליקציה ל-ivrit.ai, וקבלו את התמלול בהתראה.
> • העלו או הקליטו קבצים ארוכים, עם זיהוי דוברים, וערכו את התמלול: הכול נשמר ב-Google Drive שלכם.
> • ייצוא ל-Word, ‏SRT, ‏VTT ו-JSON.
> • התראות מהשירותים של ivrit.ai, כמו אליעזר – בוט התמלול בוואטסאפ ובטלגרם – מוצפנות עד המכשיר.
>
> ivrit.ai הוא מיזם ללא מטרות רווח לקידום טכנולוגיית דיבור בעברית. בלי פרסומות.

**en**

> ivrit.ai transcribes Hebrew – recordings, WhatsApp voice messages and long files – and brings the transcripts to you.
>
> • Share a WhatsApp voice message or a recording from any app to ivrit.ai, and get the transcript as a notification.
> • Upload or record long files, with speakers told apart, and edit the transcript: everything is kept in your own Google Drive.
> • Export to Word, SRT, VTT and JSON.
> • Notifications from ivrit.ai's services, such as Eliezer – the transcription bot on WhatsApp and Telegram – encrypted all the way to your phone.
>
> ivrit.ai is a non-profit project advancing Hebrew speech technology. No ads.

- **Keywords** (100 characters):
  - he: תמלול,עברית,הקלטה,וואטסאפ,הודעה קולית,כתוביות,דיבור לטקסט,אליעזר
  - en: transcription,hebrew,whatsapp,voice message,speech to text,subtitles,srt,recording
- **Promotional text** (170 characters, changeable any time):
  - he: שתפו הודעה קולית מוואטסאפ ל-ivrit.ai וקבלו אותה כטקסט תוך שניות.
  - en: Share a WhatsApp voice message to ivrit.ai and get it as text in seconds.

## Screenshots

6.9" (1320×2868) and 6.5" (1284×2778) iPhone sizes. `store/capture.mjs`
makes Play's from the real app; the same captures at those sizes, with an
iPhone frame in `compose.mjs`, serve here.

## App privacy ("nutrition labels")

Data **linked to the user**, not used for tracking:

| Type | Collected because | Used for |
|---|---|---|
| Contact info: name, email address | Google sign-in | App functionality |
| User content: audio data | Recordings sent for transcription | App functionality |
| User content: other (transcripts, messages) | Transcripts and notifications | App functionality |
| Identifiers: user id | The account | App functionality |

Not collected: location, contacts, browsing history, purchases, financial
info, health, diagnostics. No tracking (no data shared with data brokers or
used for advertising), so no App Tracking Transparency prompt.

If the PostHog events keep the email address: add **Usage data: product
interaction**, linked to the user, used for **Analytics**.

## Review notes

> ivrit.ai transcribes Hebrew audio. To try it:
> 1. Sign in with Google: [test account and password].
> 2. "Transcribe" tab: upload the sample file, or record a few seconds. The transcript appears in My files (it is kept in the account's Google Drive).
> 3. Share an audio file from Files or Voice Memos to "ivrit.ai": it is transcribed in the background and arrives as a notification.
> 4. Settings → "Send a test notification".
>
> Sign in with Apple is not offered: the account exists to reach the user's transcripts in their own Google Drive (guideline 4.8's exception for an account that accesses content on that service).
> Account deletion: Settings → Delete account.

The test account needs a few sample transcripts in its Drive, and its
password goes only into App Store Connect, never into this file.
