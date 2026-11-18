# On-device transcripts as the server makes them

The apps transcribe with ivrit.ai's Turbo model on the device through whisper.cpp
(Android now, `shell/android/app/src/main/cpp`; the iPhone later). The server
transcribes with the ivrit package: faster-whisper, then stable-ts, then ivrit's
diarization. This directory is what the device needs to make the same transcript
out of whisper.cpp's result: the same words with the same times, cut into the same
segments, with the same speakers. Plain C (and C++ for the speaker model on ggml),
no platform code: Android and the iPhone build the same files (`CMakeLists.txt`:
one static library, `ivritnative`, over whisper.cpp's and ggml's targets).

| Package | Ports | Of |
|---|---|---|
| `whisperwords/` | words and their times from the alignment: tokens into words, punctuation merged, the edge corrections | faster-whisper 1.1.1, `add_word_timestamps` |
| `stablets/` | timestamps out of silence (no VAD) and regrouping (`da`) | stable-ts 2.19, `adjust_by_silence`, `regroup` |
| `speakers/` | SpeechBrain's Fbank and ECAPA-TDNN (on ggml), ivrit's clustering and the scikit-learn and SciPy it calls | ivrit's "ivrit" diarization engine, `speechbrain/spkrec-ecapa-voxceleb` |
| `transcript/` | the decoding loop over whisper.cpp's model a window at a time (where each window starts, the previous text as the prompt, the fallback to higher temperatures, the no-speech skip, the segments), each window's words through `whisperwords`, then `stablets` | faster-whisper 1.1.1, `generate_segments` and `generate_with_fallback`; stable-ts's `faster_transcribe` |

The speaker model is SpeechBrain's checkpoint converted (numpy only, no PyTorch)
by `scripts/speaker_model.py`, its large matrices q8_0: 23 MB.

whisper.cpp needs changes (`shell/android/app/src/main/cpp/patches/whisper-dtw-flash.patch`):

- `ivrit_window`: `whisper_full` decodes one window, as faster-whisper has
  CTranslate2 decode one, and `transcript` does the rest. The window's mel past its
  end is zeros (faster-whisper's padding); beams are ranked on all their tokens
  with end-of-text, and the best is kept whole (`whisper_full_ivrit_sequence`);
  the prompt stays at every temperature; no failing a decoder for a missing
  timestamp or the token limit, no stop at the window's end.
- `whisper_full_ivrit_dtw`: DTW word times for given tokens over the window just
  encoded and its frames, as faster-whisper aligns, with flash attention on. Its
  prompt has the task token (`<|transcribe|>`) as faster-whisper's has: given
  faster-whisper's own windows and tokens, whisper.cpp's word edges then fall on
  its 20 ms frame for 93% (86% without), 98% within one frame. A window too short
  for the median filter is left unfiltered, as OpenAI's is, not an abort.

## How close

Tests in `tests/` run each port against the Python it ports, on the laptop:

- `test_stablets.py`: stable-ts itself. The same segments, words and times, to
  the millisecond, on 450 random transcripts with silences, for each regrouping
  method `da` uses, and on a real one.
- `test_whisperwords.py`: faster-whisper's `add_word_timestamps` (its alignment
  stood in for). The same words, times and segment edges in 3000 of 3000 windows.
- `test_speakers.py`: SpeechBrain and ivrit. Features within 0.001 dB; voice
  prints at cosine 0.9998 on average (0.9993 the worst, from the q8_0 file);
  clustering the same prints, ivrit's speakers; end to end, ivrit's speakers for
  100% of two recordings (a podcast, 2 speakers; a news piece, 7).

The whole chain against the production server (RunPod: faster-whisper fp16 on a
GPU, beam 5, through stable-ts and ivrit), on the same two recordings (a podcast,
5 minutes; a news piece, 4.4), on a Galaxy S25's GPU (OpenCL, q8_0, beam 5):
97.6-98.1% of the server's words the same; of those, 97-98.5% start and 99.3-99.8%
end within 20 ms of the server's; 95-96% of segment ends within 0.1 s. For
scale, faster-whisper itself on the laptop: float32 99.2-99.6%, int8 94.4-99.4%.
With whisper.cpp's own decoding loop it was 93.9-95.6%, at any precision (f32 no
better than q8_0): the loop, not the arithmetic, made most of the difference.
Speakers: the same as the server's for 97.5-98.6% of its speech (the rest falling
between the device's segments). On the Galaxy S25 the voice prints of a 4.4-minute
recording (213 s of speech) take 3.2 s: a piece's segments at once, each of the
eight cores taking whole segments (`sp_embed_many`), the features with an FFT; one
segment at a time over all the cores took 107 s.

## Where it knowingly differs

- A long recording goes through whisper.cpp ten minutes at a time, its windows
  falling as they would in one pass (the prompt and the speech so far carried
  over). stable-ts finds silence against the whole file's loudest thousandth and
  on a grid over its whole length: the app reads the file once first for both
  (`st_level`, `st_silence_in`), so each piece's silences are the whole file's.
  On a 14-minute recording, against one pass: 98.9% of words the same, 97.6% of
  starts within 20 ms (85.5% without the first read). What is left: Whisper's
  spectrogram floor, 80 dB under the loudest moment of the piece rather than the
  file, which turns a comma here and there.
- scikit-learn computes in float32 where this computes in double; when two methods
  find the same speakers, which one's numbering wins comes down to float32 noise
  there, so speakers may be numbered differently (SPEAKER_00 for SPEAKER_02).
- Each window is decoded by whisper.cpp on q8_0 (its beam search), not by
  CTranslate2 on fp16: about a word in fifty comes out differently, and the times
  next to it with it. The app decodes with beam search (5) on the GPU and greedily
  on the CPU (`Turbo.beams`); greedy is further off (92-98%).
- faster-whisper's spectrogram is scaled to the whole file's loudest moment; here,
  each piece's.

## Running the tests

    python3 shell/native/tests/test_stablets.py [faster-whisper.json audio.wav ...]
    python3 shell/native/tests/test_whisperwords.py
    python3 shell/native/tests/test_speakers.py GGML_BUILD MODEL WAV SEGMENTS.json [...]

They need the Python they compare against (stable-ts, faster-whisper with ivrit's
Turbo tokenizer cached, ivrit, SpeechBrain with its ECAPA cached, scikit-learn) and
a C compiler; `test_speakers.py` a CMake build of whisper.cpp (for ggml) and the
model file (`scripts/speaker_model.py`).
