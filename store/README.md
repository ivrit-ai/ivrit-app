# Google Play listing graphics

- `feature-graphic.png` — 1024×500.
- `phone/*.png` — 1080×1920 screenshots, in order, each the real app with a
  one-line caption, in Hebrew (the listing's language).

They are generated, not drawn: `capture.mjs` runs the app (as it runs in the
Android shell) against a local Communicator with invented sample transcripts
and screenshots it; `compose.mjs` frames those and renders the feature
graphic from `screen.html` and `feature.html`. To regenerate after a UI change:

    cd store && npm install && npm run build

(Needs the Communicator checkout next to this repo, Docker for its test
database, and Chromium; see the top of `capture.mjs`.) Then
`node scripts/play.mjs graphics` replaces them on the listing.
