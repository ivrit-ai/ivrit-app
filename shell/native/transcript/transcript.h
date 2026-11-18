// transcript: a piece of a recording through whisper.cpp as ivrit.ai's server would
// transcribe it: faster-whisper's (1.1.1) window by window decoding (its
// generate_segments: where each window starts, the previous text as the prompt, the
// fallback to higher temperatures, the no-speech skip), over whisper.cpp's model a
// window at a time (whisper_full with ivrit_window, patches/whisper-dtw-flash.patch);
// faster-whisper's words (whisperwords) from whisper.cpp's DTW; then stable-ts's
// silence snapping and regrouping (stablets). For the apps' on-device Turbo model,
// Android's and the iPhone's alike.
//
// A long recording goes through a piece at a time (Android: ten minutes), each
// piece's mel computed once. A window is always whole as faster-whisper's are: a
// piece that is not the last stops where less than a window is left, and the next
// starts there, with the state (the last speech, the prompt) carried over.

#ifndef TRANSCRIPT_H
#define TRANSCRIPT_H

#include <stdbool.h>
#include <stddef.h>

#include "stablets.h"
#include "whisper.h"

#ifdef __cplusplus
extern "C" {
#endif

// The context as the transcript needs it (DTW with the model's alignment heads).
void tr_context_params(struct whisper_context_params *params);

// The previous text faster-whisper prompts with: its last max_length // 2 - 1 tokens.
#define TR_PROMPT 223

// What carries over from piece to piece; all zeros at the file's start.
typedef struct {
    double last_speech;  // the end of the speech so far, seconds into the file
    double after;        // where the transcript so far ends (stable-ts keeps times after it)
    int n_prompt;
    whisper_token prompt[TR_PROMPT];
} tr_state;

typedef struct {
    st_result *result;  // the piece's segments and words, times in seconds into the file
    double next;        // where the next piece starts, seconds into the file
} tr_piece;

#define TR_NO_MEMORY (-1000)

// The transcript of `pcm`, n samples at 16 kHz, from `offset` seconds into the file;
// `last`: nothing comes after it. params: the caller's (strategy and beam size for
// temperature 0, threads, language, suppress_nst, the encoder-begin and abort
// callbacks; the progress callback is called with the share of the piece done).
// Returns 0, TR_NO_MEMORY, or what whisper.cpp returned when it failed (whisper.cpp
// may also throw: the caller catches it). The state is updated only on success.
int tr_piece_make(struct whisper_context *ctx, struct whisper_full_params params, const float *pcm, size_t n,
                  double offset, bool last, tr_state *state, tr_piece *out);

#ifdef __cplusplus
}
#endif

#endif
