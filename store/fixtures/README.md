`hebrew-12s.ogg`: the first 12 seconds of the first recording in ivrit.ai's
eval-d1 test set (huggingface.co/datasets/ivrit-ai/eval-d1), for the browser test of
on-device transcription. It begins "בפרק של היום מתארחת ד"ר מירה חניק, יועצת ארגונית".

`hebrew-12s.m4a`: the same 12 seconds as AAC, the iPhone's own format (Voice
Memos), for the iPhone engine's probe (scripts/ios-webkit-probe.mjs).

`hebrew-12s.mp4`: the same AAC sound with a black H.264 picture, as a phone video
is, for the probe (does the iPhone engine decode the sound of a video?) and the
Android test of SoundTrack. Made with `ffmpeg -f lavfi -i color=black:s=320x240:r=15
-i hebrew-12s.m4a -shortest -c:v libx264 -crf 40 -pix_fmt yuv420p -c:a copy
hebrew-12s.mp4`.
