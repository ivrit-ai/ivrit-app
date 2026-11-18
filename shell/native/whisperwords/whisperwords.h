// whisperwords: Whisper's words and their times as faster-whisper (1.1.1) makes them
// (WhisperModel.add_word_timestamps), from whisper.cpp's tokens and its DTW times,
// for one 30-second window at a time. faster-whisper is what ivrit.ai's server
// transcribes with (through stable-ts, stablets), so a transcript made with
// whisper.cpp starts from the same words as the server's: tokens grouped into words
// the same way, each word from where the alignment reaches its first token to
// where it reaches the next word's, punctuation merged into words, and the same
// corrections at sentence and segment edges.
//
// whisper.cpp's DTW (whisper_exp_compute_token_level_timestamps_dtw) is OpenAI's,
// as faster-whisper's alignment is, but it gives each token the time the path
// reaches the token after it: token k's t_dtw is faster-whisper's jump time k + 1,
// and jump time 0 is the window's start.

#ifndef WHISPERWORDS_H
#define WHISPERWORDS_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// A text token (below end-of-text): its bytes as the vocabulary has them (a token
// may end inside a letter), and whisper.cpp's DTW time, centiseconds into the file.
typedef struct {
    const char *text;
    long t_dtw;
} ww_token;

// One of the window's segments: its times as whisper.cpp gives them (centiseconds)
// and how many of the tokens, in order, are its.
typedef struct {
    long t0;
    long t1;
    size_t n_tokens;
} ww_segment;

typedef struct {
    char *text;  // " word," with its leading space, as Whisper writes it
    double start;
    double end;
} ww_word;

typedef struct {
    double start;
    double end;
    ww_word *words;
    size_t n_words;
    bool keep;  // false: faster-whisper drops it (no text, or no length)
} ww_result;

// The words of one window starting `seek` centiseconds into the file; `out` has
// n_segments results, filled in. *last_speech is the end of the speech before (0
// for the first window) and becomes this window's (faster-whisper's get_end).
// False when out of memory.
bool ww_window(const ww_token *tokens, const ww_segment *segments, size_t n_segments, long seek,
               double *last_speech, ww_result *out);

void ww_free(ww_result *results, size_t n);

// `len` bytes as Python has them decoded (each bad sequence one U+FFFD) and
// stripped, in UTF-8: the tokenizer's decode(...).strip(). NULL when out of memory.
char *ww_stripped(const char *bytes, size_t len);

#ifdef __cplusplus
}
#endif

#endif
