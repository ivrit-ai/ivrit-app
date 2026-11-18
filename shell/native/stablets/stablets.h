// stablets: the part of stable-ts (https://github.com/jianfch/stable-ts, 2.19) that
// ivrit.ai's transcription runs after Whisper: timestamps snapped out of silence
// (adjust_by_silence, without a VAD) and segments regrouped (regroup). Only that,
// ported faithfully, so a transcript made on the phone is cut and timed as the
// server's is. README.md says what is ported and where it knowingly differs.
//
// A result is stable-ts's WhisperResult: segments of words, each word as Whisper
// writes it (" word," with its leading space), its times in seconds.

#ifndef STABLETS_H
#define STABLETS_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char *text;
    double start;
    double end;
} st_word;

typedef struct st_result st_result;

st_result *st_new(void);
void st_free(st_result *r);

// One segment of Whisper's, its words in order. A segment may have none.
// Returns false when out of memory.
bool st_add_segment(st_result *r, const char *const *texts, const double *starts, const double *ends, size_t n);

// What WhisperResult(…, force_order=True) does once the segments are in: every
// timestamp after the one before (from `after` seconds on: 0 for a whole file),
// and the segments without words dropped.
void st_finish(st_result *r, double after);

size_t st_segments(const st_result *r);
// Segment i's words: *n of them.
const st_word *st_segment(const st_result *r, size_t i, size_t *n);

// stable-ts's non-VAD silence (audio2timings: wav2mask, then mask2timing) in 16 kHz
// mono sound, `offset` seconds added to every time. *starts and *ends are
// malloc'd, *count long, both NULL when nothing is silent. False when out of memory.
bool st_silence(const float *pcm, size_t n, int q_levels, int k_size, double offset,
                double **starts, double **ends, size_t *count);

// WhisperResult.suppress_silence, word level (as adjust_by_silence calls it).
void st_suppress_silence(st_result *r, const double *starts, const double *ends, size_t count,
                         double min_word_dur, double nonspeech_error, bool use_word_position);

// WhisperResult.regroup with an algorithm string ("da" or True: the default), for
// the methods "da" uses: isp, cm, sp, sg, sl. False when the string asks for
// anything else (nothing is changed then) or memory ran out.
bool st_regroup(st_result *r, const char *algo);

// round(x, digits) as stable-ts does it on faster-whisper's numpy floats: numpy's
// (x * 10^digits rounded to an integer, ties to even, divided back).
double st_round(double x, int digits);

// stable-ts's defaults (default.py, faster_transcribe).
#define ST_Q_LEVELS 20
#define ST_K_SIZE 5
#define ST_MIN_WORD_DUR 0.1
#define ST_NONSPEECH_ERROR 0.1

#ifdef __cplusplus
}
#endif

#endif
