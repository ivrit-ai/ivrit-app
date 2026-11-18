// stablets.h's port of stable-ts 2.19. Each function says which of stable-ts's it
// is (result.py, stabilization/); the arithmetic follows theirs step by step, in
// the same precision (torch's float32 where stable-ts uses torch, Python's double
// elsewhere), so the same input gives the same times. Lengths are Python's: code
// points, not bytes.

#define _POSIX_C_SOURCE 200809L

#include "stablets.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct st_result {
    st_word *words;
    size_t n_words;
    size_t cap_words;
    size_t *first;  // each segment's first word; a segment ends where the next begins
    size_t n_segments;
    size_t cap_segments;
    bool ignore_special_periods;  // isp, kept for the splits after it
};

// default.py
static const char APPEND_PUNCTUATIONS[] = "\"'.。,，!！?？:：”)]}、";
#define TOKENS_PER_SECOND 50
#define SAMPLES_PER_TOKEN 320

st_result *st_new(void) {
    return calloc(1, sizeof(st_result));
}

void st_free(st_result *r) {
    if (!r) return;
    for (size_t i = 0; i < r->n_words; i++) free(r->words[i].text);
    free(r->words);
    free(r->first);
    free(r);
}

double st_round(double x, int digits) {
    // numpy's round (np.around): times reach stable-ts as numpy floats
    // (faster-whisper's), and round() on those multiplies, rounds to an integer
    // (ties to even) and divides back.
    double f = 1;
    for (int i = 0; i < digits; i++) f *= 10;
    return nearbyint(x * f) / f;
}

static double round3(double x) {
    return st_round(x, 3);
}

static size_t seg_begin(const st_result *r, size_t i) {
    return r->first[i];
}

static size_t seg_end(const st_result *r, size_t i) {
    return i + 1 < r->n_segments ? r->first[i + 1] : r->n_words;
}

size_t st_segments(const st_result *r) {
    return r->n_segments;
}

const st_word *st_segment(const st_result *r, size_t i, size_t *n) {
    *n = seg_end(r, i) - seg_begin(r, i);
    return r->words + seg_begin(r, i);
}

bool st_add_segment(st_result *r, const char *const *texts, const double *starts, const double *ends, size_t n) {
    if (r->n_segments == r->cap_segments) {
        size_t cap = r->cap_segments ? 2 * r->cap_segments : 64;
        size_t *first = realloc(r->first, cap * sizeof *first);
        if (!first) return false;
        r->first = first;
        r->cap_segments = cap;
    }
    if (r->n_words + n > r->cap_words) {
        size_t cap = r->cap_words ? 2 * r->cap_words : 256;
        while (cap < r->n_words + n) cap *= 2;
        st_word *words = realloc(r->words, cap * sizeof *words);
        if (!words) return false;
        r->words = words;
        r->cap_words = cap;
    }
    for (size_t i = 0; i < n; i++) {
        char *text = strdup(texts[i]);
        if (!text) {
            for (size_t j = 0; j < i; j++) free(r->words[r->n_words + j].text);
            return false;
        }
        // WordTiming.__init__ rounds both.
        r->words[r->n_words + i] = (st_word) {text, round3(starts[i]), round3(ends[i])};
    }
    r->first[r->n_segments++] = r->n_words;
    r->n_words += n;
    return true;
}

// WhisperResult.force_order, over all words (all_words_or_segments: the words, when
// every segment has some; otherwise the segments' own times, which the words do
// not follow, so nothing here changes).
static void force_order(st_result *r, double prev_end) {
    for (size_t s = 0; s < r->n_segments; s++) {
        if (seg_begin(r, s) == seg_end(r, s)) return;
    }
    st_word *t = r->words;
    size_t n = r->n_words;
    for (size_t i = 1; i <= n; i++) {
        st_word *ts = &t[i - 1];
        if (ts->start < prev_end) ts->start = round3(prev_end);
        if (ts->start > ts->end) {
            if (prev_end > ts->end) {
                ts->start = ts->end;
                for (size_t j = i - 1; j-- > 0;) {
                    if (t[j].end > ts->end) t[j].end = ts->end;
                    if (t[j].start > ts->end) t[j].start = ts->end;
                }
            } else if (ts->start != prev_end) {
                ts->start = round3(prev_end);
            } else {
                ts->end = i == n ? ts->start : t[i].start;
            }
        }
        prev_end = ts->end;
    }
}

// remove_no_word_segments(ignore_ori=True): segments sharing a first word with the
// next one have none.
static void remove_empty_segments(st_result *r) {
    size_t kept = 0;
    for (size_t s = 0; s < r->n_segments; s++) {
        if (seg_begin(r, s) != seg_end(r, s)) r->first[kept++] = r->first[s];
    }
    r->n_segments = kept;
}

void st_finish(st_result *r, double after) {
    force_order(r, after);
    remove_empty_segments(r);
}

// ---- silence (stabilization/nonvad.py, stabilization/utils.py) ----------------

static int cmp_desc(const void *a, const void *b) {
    float x = *(const float *) a, y = *(const float *) b;
    return (x < y) - (x > y);
}

// The k-th largest (torch.topk(…)[-1]), or the 0.999 quantile when k is 0.
static bool loudness_threshold(const float *a, size_t n, float *out) {
    float *copy = malloc((n ? n : 1) * sizeof *copy);
    if (!copy) return false;
    memcpy(copy, a, n * sizeof *copy);
    size_t k = (size_t) ((double) n * 0.001);
    qsort(copy, n, sizeof *copy, cmp_desc);
    if (k) {
        *out = copy[k - 1];
    } else {
        // torch.quantile, linear: ascending order, position q * (n - 1).
        double pos = 0.999 * (double) (n - 1);
        size_t lo = (size_t) floor(pos);
        size_t hi = lo + 1 < n ? lo + 1 : lo;
        float a_lo = copy[n - 1 - lo], a_hi = copy[n - 1 - hi];
        *out = (float) (a_lo + (float) (pos - (double) lo) * (a_hi - a_lo));
    }
    free(copy);
    return true;
}

// F.interpolate(mode='linear', align_corners=False) from `total` samples to
// `count`, as torch computes it: output i from samples *i0 and *i1, weighted.
static void source(size_t i, size_t total, size_t count, size_t *i0, size_t *i1, float *l0, float *l1) {
    float scale = (float) total / (float) count;
    float src = scale * ((float) i + 0.5f) - 0.5f;
    if (src < 0) src = 0;
    *i0 = (size_t) src;
    if (*i0 > total - 1) *i0 = total - 1;
    *l1 = src - (float) *i0;
    if (*l1 < 0) *l1 = 0;
    if (*l1 > 1) *l1 = 1;
    *l0 = 1.0f - *l1;
    *i1 = *i0 + (*i0 < total - 1 ? 1 : 0);
}

// audio2loudness: |x| scaled by the file's loudest thousandth (`threshold`),
// linearly resampled to one value per 320 samples (+1), for the file's samples
// [first, first + n) of `total` in pcm: the values whose samples are all there,
// *lo the first's index. NULL with *size 0 when the file has two values or fewer.
static float *loudness_in(const float *pcm, size_t n, size_t first, size_t total, float threshold, size_t *lo,
                          size_t *size, bool *oom) {
    *size = 0;
    *lo = 0;
    *oom = false;
    double tokens = nearbyint((double) total / SAMPLES_PER_TOKEN) + 1;
    if (tokens <= 2 || n == 0) return NULL;
    size_t count = (size_t) tokens;
    size_t i0, i1;
    float l0, l1;
    // The values whose two samples are in the piece.
    float scale = (float) total / (float) count;
    size_t a = (size_t) ((double) first / scale);
    a = a > 2 ? a - 2 : 0;
    for (source(a, total, count, &i0, &i1, &l0, &l1); a < count && i0 < first;) {
        a++;
        if (a < count) source(a, total, count, &i0, &i1, &l0, &l1);
    }
    size_t b = a;
    while (b < count) {
        source(b, total, count, &i0, &i1, &l0, &l1);
        if (i1 >= first + n) break;
        b++;
    }
    if (b <= a) return NULL;
    float *out = calloc(b - a, sizeof *out);
    if (!out) {
        *oom = true;
        return NULL;
    }
    *lo = a;
    *size = b - a;
    if (threshold < 1e-5f) return out;
    float scaled = threshold * 1.75f;
    float divisor = 1.0f < scaled ? 1.0f : scaled;
    for (size_t i = a; i < b; i++) {
        source(i, total, count, &i0, &i1, &l0, &l1);
        out[i - a] = l0 * (fabsf(pcm[i0 - first]) / divisor) + l1 * (fabsf(pcm[i1 - first]) / divisor);
    }
    return out;
}

// audio2loudness over the whole of pcm.
static float *audio2loudness(const float *pcm, size_t n, size_t *size, bool *oom) {
    *size = 0;
    *oom = false;
    if (nearbyint((double) n / SAMPLES_PER_TOKEN) + 1 <= 2) return NULL;
    float *a = malloc((n ? n : 1) * sizeof *a);
    float threshold;
    if (!a) {
        *oom = true;
        return NULL;
    }
    for (size_t i = 0; i < n; i++) a[i] = fabsf(pcm[i]);
    bool ok = loudness_threshold(a, n, &threshold);
    free(a);
    if (!ok) {
        *oom = true;
        return NULL;
    }
    size_t lo;
    return loudness_in(pcm, n, 0, n, threshold, &lo, size, oom);
}

// mask2timing: each run of true values, start and end, in seconds (/50 as numpy does).
static size_t runs(const bool *mask, size_t size, size_t *from, size_t *to) {
    size_t count = 0;
    for (size_t i = 0; i < size; i++) {
        if (mask[i] && (i == 0 || !mask[i - 1])) from[count] = i;
        if (mask[i] && (i + 1 == size || !mask[i + 1])) to[count++] = i + 1;
    }
    return count;
}

// wav2mask and mask2timing over loudness values, the first value number `lo`
// (times from lo / 50, plus `offset`). Frees loud.
static bool silences(float *loud, size_t size, size_t lo, int q_levels, int k_size, double offset,
                     double **starts, double **ends, size_t *count) {
    bool *mask = malloc(size * sizeof *mask);
    size_t *from = malloc(size * sizeof *from);
    size_t *to = malloc(size * sizeof *to);
    float *padded = malloc((size + 2 * (size_t) (k_size / 2) + 1) * sizeof *padded);
    bool ok = mask && from && to && padded;
    if (!ok) goto done;
    // wav2mask: average over k_size (reflect-padded), quantized into q_levels.
    size_t p = k_size ? (size_t) (k_size / 2) : 0;
    float *pooled = loud;
    if (p && p < size) {
        for (size_t i = 0; i < size; i++) padded[p + i] = loud[i];
        for (size_t i = 1; i <= p; i++) {
            padded[p - i] = loud[i];
            padded[p + size - 1 + i] = loud[size - 1 - i];
        }
        for (size_t i = 0; i < size; i++) {
            float sum = 0;
            for (size_t j = 0; j < (size_t) k_size; j++) sum += padded[i + j];
            loud[i] = sum / (float) k_size;
        }
    }
    bool any = false;
    for (size_t i = 0; i < size; i++) {
        float v = q_levels ? nearbyintf(pooled[i] * (float) q_levels) : pooled[i];
        mask[i] = v != 0;
        any = any || mask[i];
    }
    if (!any) {
        // Entirely silent: all of it.
        for (size_t i = 0; i < size; i++) mask[i] = true;
    } else {
        // Sound lasting over 0.1 s stays sound (timing2mask marks each run's end
        // too); the rest is silence.
        size_t sounds = runs(mask, size, from, to);
        for (size_t i = 0; i < size; i++) mask[i] = false;
        for (size_t k = 0; k < sounds; k++) {
            // In the file's seconds, as stable-ts has them: the length test rounds
            // differently far into the file.
            double s = (double) (lo + from[k]) / TOKENS_PER_SECOND, e = (double) (lo + to[k]) / TOKENS_PER_SECOND;
            if (!(e - s > 0.1)) continue;
            size_t mi = (size_t) nearbyint(s * TOKENS_PER_SECOND) - lo, me = (size_t) nearbyint(e * TOKENS_PER_SECOND) - lo;
            for (size_t i = mi; i <= me && i < size; i++) mask[i] = true;
        }
        bool silent = false;
        for (size_t i = 0; i < size; i++) {
            mask[i] = !mask[i];
            silent = silent || mask[i];
        }
        if (!silent) goto done;
    }
    size_t silences = runs(mask, size, from, to);
    *starts = malloc(silences * sizeof **starts);
    *ends = malloc(silences * sizeof **ends);
    if (!*starts || !*ends) {
        free(*starts);
        free(*ends);
        *starts = *ends = NULL;
        ok = false;
        goto done;
    }
    for (size_t k = 0; k < silences; k++) {
        (*starts)[k] = (double) (lo + from[k]) / TOKENS_PER_SECOND;
        (*ends)[k] = (double) (lo + to[k]) / TOKENS_PER_SECOND;
        if (offset) {
            (*starts)[k] += offset;
            (*ends)[k] += offset;
        }
    }
    *count = silences;
done:
    free(loud);
    free(mask);
    free(from);
    free(to);
    free(padded);
    return ok;
}

bool st_silence(const float *pcm, size_t n, int q_levels, int k_size, double offset,
                double **starts, double **ends, size_t *count) {
    *starts = *ends = NULL;
    *count = 0;
    size_t size;
    bool oom;
    float *loud = audio2loudness(pcm, n, &size, &oom);
    if (!loud) return !oom;
    return silences(loud, size, 0, q_levels, k_size, offset, starts, ends, count);
}

bool st_silence_in(const float *pcm, size_t n, size_t first, size_t total, float level, int q_levels, int k_size,
                   double offset, double **starts, double **ends, size_t *count) {
    *starts = *ends = NULL;
    *count = 0;
    size_t size, lo;
    bool oom;
    float *loud = loudness_in(pcm, n, first, total, level, &lo, &size, &oom);
    if (!loud) return !oom;
    return silences(loud, size, lo, q_levels, k_size, offset, starts, ends, count);
}

// ---- the file's level, piece by piece --------------------------------------------

// The largest |sample|s so far, a min-heap of at most `cap`.
struct st_level {
    float *heap;
    size_t n, cap;
    size_t total;
};

st_level *st_level_new(size_t expected) {
    st_level *l = calloc(1, sizeof *l);
    if (!l) return NULL;
    l->cap = (size_t) ((double) expected * 1.5 * 0.001) + 16;
    l->heap = malloc(l->cap * sizeof *l->heap);
    if (!l->heap) {
        free(l);
        return NULL;
    }
    return l;
}

static void sift_down(float *h, size_t n, size_t i) {
    for (;;) {
        size_t m = i, a = 2 * i + 1, b = a + 1;
        if (a < n && h[a] < h[m]) m = a;
        if (b < n && h[b] < h[m]) m = b;
        if (m == i) return;
        float t = h[i];
        h[i] = h[m];
        h[m] = t;
        i = m;
    }
}

bool st_level_add(st_level *l, const float *pcm, size_t n) {
    for (size_t i = 0; i < n; i++) {
        float v = fabsf(pcm[i]);
        if (l->n < l->cap) {
            size_t k = l->n++;
            l->heap[k] = v;
            while (k > 0 && l->heap[(k - 1) / 2] > l->heap[k]) {
                float t = l->heap[k];
                l->heap[k] = l->heap[(k - 1) / 2];
                l->heap[(k - 1) / 2] = t;
                k = (k - 1) / 2;
            }
        } else if (v > l->heap[0]) {
            l->heap[0] = v;
            sift_down(l->heap, l->n, 0);
        }
    }
    l->total += n;
    return true;
}

bool st_level_end(st_level *l, size_t *total, float *level) {
    size_t k = (size_t) ((double) l->total * 0.001);
    bool ok = k > 0 && k <= l->n;
    if (ok) {
        // The k-th largest: sorted largest first, as loudness_threshold has it.
        qsort(l->heap, l->n, sizeof *l->heap, cmp_desc);
        *total = l->total;
        *level = l->heap[k - 1];
    }
    free(l->heap);
    free(l);
    return ok;
}

// ---- suppress_silence (stabilization/__init__.py) -------------------------------

// keep_end: 1, 0, or -1 for None.
static void suppress_word(st_word *w, const double *ss, const double *se, size_t count,
                          double min_word_dur, double nonspeech_error, int keep_end) {
    if (count == 0 || (w->end - w->start) <= min_word_dur) return;
    if (keep_end != 0) {
        for (size_t i = 0; i < count; i++) {
            if (ss[i] <= w->start && w->start < se[i] && se[i] <= w->end) {
                double cap = round3(w->end - min_word_dur);
                w->start = round3(se[i] < cap ? se[i] : cap);
                if ((w->end - w->start) <= min_word_dur) return;
                break;
            }
        }
    }
    if (keep_end != 1) {
        for (size_t i = 0; i < count; i++) {
            if (w->start <= ss[i] && ss[i] < w->end && w->end <= se[i]) {
                double floor_ = round3(w->start + min_word_dur);
                w->end = round3(ss[i] > floor_ ? ss[i] : floor_);
                if ((w->end - w->start) <= min_word_dur) return;
                break;
            }
        }
    }
    if (nonspeech_error) {
        // Exactly one silence inside the word: cut it at whichever side is
        // within the error, as keep_end says.
        size_t match = 0, matches = 0;
        for (size_t i = 0; i < count; i++) {
            if (w->start <= ss[i] && w->end >= se[i]) {
                if (matches++ == 0) match = i;
            }
        }
        if (matches != 1) return;
        double s = ss[match], e = se[match];
        double duration = e - s;
        double start_error = (s - w->start) / duration;
        double end_error = (w->end - e) / duration;
        bool keep = keep_end < 0 ? start_error <= end_error : keep_end == 1;
        if (!(start_error <= nonspeech_error || end_error <= nonspeech_error)) return;
        if (keep) {
            double cap = round3(w->end - min_word_dur);
            w->start = round3(e < cap ? e : cap);
        } else {
            double floor_ = round3(w->start + min_word_dur);
            w->end = round3(s > floor_ ? s : floor_);
        }
    }
}

// The last code point of a word, as bytes (it is a whole one: the text is UTF-8).
static const char *last_char(const char *text, size_t *len) {
    size_t n = strlen(text);
    if (n == 0) {
        *len = 0;
        return text;
    }
    size_t i = n - 1;
    while (i > 0 && ((unsigned char) text[i] & 0xC0) == 0x80) i--;
    *len = n - i;
    return text + i;
}

static bool in_set(const char *set, const char *c, size_t len) {
    if (len == 0) return false;
    for (const char *p = set; *p; p++) {
        if (strncmp(p, c, len) == 0) return true;
    }
    return false;
}

void st_suppress_silence(st_result *r, const double *starts, const double *ends, size_t count,
                         double min_word_dur, double nonspeech_error, bool use_word_position) {
    // Segment.suppress_silence, word_level: a word keeps its end unless it ends in
    // punctuation or ends the segment.
    for (size_t s = 0; s < r->n_segments; s++) {
        size_t b = seg_begin(r, s), e = seg_end(r, s);
        for (size_t i = b; i < e; i++) {
            int keep_end = -1;
            if (use_word_position) {
                size_t len;
                const char *c = last_char(r->words[i].text, &len);
                keep_end = !(in_set(APPEND_PUNCTUATIONS, c, len) || i + 1 == e);
            }
            suppress_word(&r->words[i], starts, ends, count, min_word_dur, nonspeech_error, keep_end);
        }
    }
}

// ---- regrouping (result.py) -----------------------------------------------------

static size_t codepoints(const char *s) {
    size_t n = 0;
    for (; *s; s++) n += ((unsigned char) *s & 0xC0) != 0x80;
    return n;
}

static bool ends_with(const char *s, const char *p) {
    size_t n = strlen(s), m = strlen(p);
    return m <= n && memcmp(s + n - m, p, m) == 0;
}

static bool starts_with(const char *s, const char *p) {
    return strncmp(s, p, strlen(p)) == 0;
}

// Python's str.strip(): ASCII and the common Unicode spaces.
static void strip(const char *s, const char **from, size_t *len) {
    static const char *const spaces[] = {"\xc2\xa0", "\xe2\x80\x80", "\xe2\x80\x81", "\xe2\x80\x82", "\xe2\x80\x83",
                                         "\xe2\x80\x84", "\xe2\x80\x85", "\xe2\x80\x86", "\xe2\x80\x87", "\xe2\x80\x88",
                                         "\xe2\x80\x89", "\xe2\x80\x8a", "\xe2\x80\xa8", "\xe2\x80\xa9", "\xe2\x80\xaf",
                                         "\xe2\x81\x9f", "\xe3\x80\x80", "\xc2\x85"};
    const char *a = s, *b = s + strlen(s);
    for (bool moved = true; moved && a < b;) {
        moved = false;
        if (strchr(" \t\n\r\v\f\x1c\x1d\x1e\x1f", *a) && *a) {
            a++;
            moved = true;
            continue;
        }
        for (size_t k = 0; k < sizeof spaces / sizeof *spaces; k++) {
            size_t m = strlen(spaces[k]);
            if ((size_t) (b - a) >= m && memcmp(a, spaces[k], m) == 0) {
                a += m;
                moved = true;
                break;
            }
        }
    }
    for (bool moved = true; moved && a < b;) {
        moved = false;
        if (strchr(" \t\n\r\v\f\x1c\x1d\x1e\x1f", b[-1]) && b[-1]) {
            b--;
            moved = true;
            continue;
        }
        for (size_t k = 0; k < sizeof spaces / sizeof *spaces; k++) {
            size_t m = strlen(spaces[k]);
            if ((size_t) (b - a) >= m && memcmp(b - m, spaces[k], m) == 0) {
                b -= m;
                moved = true;
                break;
            }
        }
    }
    *from = a;
    *len = (size_t) (b - a);
}

// A word like "Dr." or "3." whose period ends no sentence (_remove_special_period_indices).
static bool special_period(const char *text) {
    if (!ends_with(text, ".")) return false;
    const char *w;
    size_t len;
    strip(text, &w, &len);
    if (len == 0) return false;
    char c = w[0];
    if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return false;
    size_t rest = 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char b = (unsigned char) w[i];
        if ((b & 0xC0) == 0x80) continue;
        if (b == '.' || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')) continue;
        rest++;
    }
    return rest < 3;
}

// A punctuation to split at: a string a word ends with (or the next begins with),
// or a pair, the end of a word and the start of the next.
typedef struct {
    char *ending;
    char *beginning;  // NULL: not a pair
} punct;

typedef struct {
    size_t *at;  // word indices within the segment, split after each
    size_t n;
} indices;

static int cmp_size(const void *a, const void *b) {
    size_t x = *(const size_t *) a, y = *(const size_t *) b;
    return (x > y) - (x < y);
}

// sorted(set(…))
static void unique(indices *ix) {
    if (ix->n == 0) return;
    qsort(ix->at, ix->n, sizeof *ix->at, cmp_size);
    size_t k = 1;
    for (size_t i = 1; i < ix->n; i++) {
        if (ix->at[i] != ix->at[k - 1]) ix->at[k++] = ix->at[i];
    }
    ix->n = k;
}

// Segment.get_punctuation_indices
static void punctuation_indices(const st_word *w, size_t n, const punct *p, size_t np, indices *ix) {
    if (n < 2) return;
    for (size_t k = 0; k < np; k++) {
        for (size_t i = 0; i + 1 < n; i++) {
            if (p[k].beginning) {
                if (ends_with(w[i].text, p[k].ending) && starts_with(w[i + 1].text, p[k].beginning)) ix->at[ix->n++] = i;
            } else if (ends_with(w[i].text, p[k].ending)) {
                ix->at[ix->n++] = i;
            } else if (i != 0 && starts_with(w[i].text, p[k].ending)) {
                ix->at[ix->n++] = i - 1;
            }
        }
    }
}

// Segment.get_gap_indices
static void gap_indices(const st_word *w, size_t n, double max_gap, indices *ix) {
    if (n < 2) return;
    for (size_t i = 0; i + 1 < n; i++) {
        if (w[i + 1].start - w[i].end > max_gap) ix->at[ix->n++] = i;
    }
}

// Segment._get_even_split_indices, without excluded indices (include_lock is False).
static void even_split(const double *cumsum, size_t len, double parts_per_split, double splits, indices *ix) {
    for (long i = 1; i < (long) splits; i++) {
        double target = (double) i * parts_per_split;
        size_t best = 0;
        double best_d = INFINITY;
        for (size_t j = 0; j < len; j++) {
            double d = fabs(cumsum[j] - target);
            if (d < best_d) {
                best_d = d;
                best = j;
            }
        }
        ix->at[ix->n++] = best;
    }
}

// Segment.get_length_indices (include_lock False)
static void length_indices(const st_word *w, size_t n, long max_chars, long max_words, bool even, indices *ix) {
    if (n < 2 || (max_chars < 0 && max_words < 0)) return;
    double *cumsum = malloc(n * sizeof *cumsum);
    if (!cumsum) return;
    if (even) {
        long chars = 0;
        for (size_t i = 0; i < n; i++) chars += (long) codepoints(w[i].text);
        bool exceed_chars = max_chars >= 0 && chars > max_chars;
        bool exceed_words = max_words >= 0 && (long) n > max_words;
        if (exceed_chars) {
            double splits = ceil((double) chars / (double) max_chars);
            double per = (double) chars / splits;
            double sum = 0;
            for (size_t i = 0; i + 1 < n; i++) cumsum[i] = sum += (double) codepoints(w[i].text);
            even_split(cumsum, n - 1, per, splits, ix);
            if (max_words >= 0) {
                exceed_words = false;
                size_t prev = 0;
                for (size_t k = 0; k <= ix->n; k++) {
                    size_t j = k < ix->n ? ix->at[k] : n;
                    if ((long) (j - prev + 1) > max_words) exceed_words = true;
                    prev = j;
                }
            }
        }
        if (exceed_words) {
            ix->n = 0;
            double splits = ceil((double) n / (double) max_words);
            double per = (double) n / splits;
            for (size_t i = 0; i < n; i++) cumsum[i] = (double) (i + 1);
            even_split(cumsum, n, per, splits, ix);
        }
    } else {
        long words = 0, chars = 0;
        for (size_t i = 0; i < n; i++) {
            long len = (long) codepoints(w[i].text);
            words++;
            chars += len;
            if (i != 0 && ((max_chars >= 0 && chars > max_chars) || (max_words >= 0 && words > max_words))) {
                ix->at[ix->n++] = i - 1;
                words = 1;
                chars = len;
            }
        }
    }
    free(cumsum);
}

enum split_kind { SPLIT_PUNCTUATION, SPLIT_GAP, SPLIT_LENGTH };

typedef struct {
    enum split_kind kind;
    const punct *punct;
    size_t n_punct;
    long min_words, min_chars;  // -1: none
    double min_dur;             // < 0: none
    double max_gap;
    long max_chars, max_words;
    bool even;
    bool ignore_special_periods;
} split_args;

// WhisperResult._split_segments (lock and newline False): new segment boundaries.
static bool split_segments(st_result *r, const split_args *a) {
    size_t cap = r->n_segments + r->n_words;
    size_t *first = malloc((cap ? cap : 1) * sizeof *first);
    size_t *buf = malloc((r->n_words * (a->n_punct + 2) + 64) * sizeof *buf);
    if (!first || !buf) {
        free(first);
        free(buf);
        return false;
    }
    size_t n_first = 0;
    for (size_t s = 0; s < r->n_segments; s++) {
        size_t b = seg_begin(r, s), e = seg_end(r, s);
        const st_word *w = r->words + b;
        size_t n = e - b;
        first[n_first++] = b;
        indices ix = {buf, 0};
        if (a->kind == SPLIT_PUNCTUATION) {
            // min_words/min_chars/min_dur: only segments that long at the start.
            bool limited = a->min_words > 0 || a->min_chars > 0 || a->min_dur > 0;
            bool over = false;
            if (limited) {
                long chars = 0;
                for (size_t i = 0; i < n; i++) chars += (long) codepoints(w[i].text);
                over = (a->min_words > 0 && (long) n >= a->min_words) || (a->min_chars > 0 && chars >= a->min_chars)
                    || (a->min_dur > 0 && w[n - 1].end - w[0].start >= a->min_dur);
            }
            if (!limited || over) punctuation_indices(w, n, a->punct, a->n_punct, &ix);
        } else if (a->kind == SPLIT_GAP) {
            gap_indices(w, n, a->max_gap, &ix);
        } else {
            length_indices(w, n, a->max_chars, a->max_words, a->even, &ix);
        }
        unique(&ix);
        if (a->ignore_special_periods) {
            size_t k = 0;
            for (size_t i = 0; i < ix.n; i++) {
                if (!special_period(w[ix.at[i]].text)) ix.at[k++] = ix.at[i];
            }
            ix.n = k;
        }
        for (size_t i = 0; i < ix.n; i++) {
            if (ix.at[i] + 1 < n) first[n_first++] = b + ix.at[i] + 1;
        }
    }
    free(buf);
    if (n_first > r->cap_segments) {
        free(r->first);
        r->first = first;
        r->cap_segments = cap ? cap : 1;
    } else {
        memcpy(r->first, first, n_first * sizeof *first);
        free(first);
    }
    r->n_segments = n_first;
    return true;
}

static double word_duration(const st_word *w) {
    return round3(w->end - w->start);
}

static int cmp_double(const void *a, const void *b) {
    double x = *(const double *) a, y = *(const double *) b;
    return (x > y) - (x < y);
}

// WordTiming.clamp_max
static void clamp_word(st_word *w, double max_dur, bool clip_start) {
    if (word_duration(w) <= max_dur) return;
    if (clip_start) w->start = round3(w->end - max_dur);
    else w->end = round3(w->start + max_dur);
}

// WhisperResult.clamp_max: no word over medium_factor times the segment's median
// (or max_dur); clip_start -1 (None): only the first word's start and the last's end.
static bool clamp_max(st_result *r, double medium_factor, double max_dur, int clip_start) {
    double *d = malloc((r->n_words ? r->n_words : 1) * sizeof *d);
    if (!d) return false;
    for (size_t s = 0; s < r->n_segments; s++) {
        size_t b = seg_begin(r, s), e = seg_end(r, s), n = e - b;
        double cur = 0;
        if (medium_factor && n > 1) {
            for (size_t i = 0; i < n; i++) d[i] = word_duration(&r->words[b + i]);
            qsort(d, n, sizeof *d, cmp_double);
            cur = medium_factor * d[n / 2];
        }
        if (max_dur > 0 && (!cur || cur > max_dur)) cur = max_dur;
        if (!cur) continue;
        if (clip_start < 0) {
            clamp_word(&r->words[b], cur, true);
            clamp_word(&r->words[e - 1], cur, false);
        } else {
            for (size_t i = b; i < e; i++) clamp_word(&r->words[i], cur, clip_start == 1);
        }
    }
    free(d);
    return true;
}

// ---- the algorithm string (WhisperResult.parse_regroup_algo, str_to_valid_type) ---

typedef struct {
    bool none;
    bool number;
    double value;
    bool is_list;
    const char *str;  // the argument as written
} arg;

static arg parse_arg(const char *s) {
    arg a = {0};
    a.str = s;
    if (!*s) {
        a.none = true;
        return a;
    }
    if (strchr(s, '/')) {
        a.is_list = true;
        return a;
    }
    char *end;
    if (strchr(s, '.')) {
        double v = strtod(s, &end);
        if (*end == 0) {
            a.number = true;
            a.value = v;
        }
    } else {
        long v = strtol(s, &end, 10);
        if (*end == 0) {
            a.number = true;
            a.value = (double) v;
        }
    }
    return a;
}

// A number, or none (`fallback`); false when it is neither.
static bool number_or(const arg *a, double fallback, double *out) {
    if (a->none) {
        *out = fallback;
        return true;
    }
    if (!a->number) return false;
    *out = a->value;
    return true;
}

// The list (or one string) of punctuation, split at '/' and each at '*'.
static punct *parse_punctuation(const arg *a, size_t *n) {
    *n = 0;
    if (a->none || a->number) return NULL;
    char *copy = strdup(a->str);
    if (!copy) return NULL;
    size_t parts = 1;
    for (const char *c = copy; *c; c++) parts += *c == '/';
    punct *p = calloc(parts, sizeof *p);
    if (!p) {
        free(copy);
        return NULL;
    }
    char *at = copy;
    for (size_t k = 0; k < parts; k++) {
        char *slash = a->is_list ? strchr(at, '/') : NULL;
        if (slash) *slash = 0;
        char *star = a->is_list ? strchr(at, '*') : NULL;
        if (star) {
            *star = 0;
            p[k].ending = strdup(at);
            p[k].beginning = strdup(star + 1);
        } else {
            p[k].ending = strdup(at);
        }
        at = slash ? slash + 1 : at + strlen(at);
    }
    free(copy);
    *n = parts;
    return p;
}

static void free_punctuation(punct *p, size_t n) {
    for (size_t k = 0; k < n; k++) {
        free(p[k].ending);
        free(p[k].beginning);
    }
    free(p);
}

#define MAX_ARGS 8

static bool run_method(st_result *r, const char *method, arg *args, size_t n_args) {
    arg none = {.none = true};
    for (size_t i = n_args; i < MAX_ARGS; i++) args[i] = none;
    double v;
    if (strcmp(method, "isp") == 0) {
        // ignore_special_periods(enable=True)
        if (!number_or(&args[0], 1, &v)) return false;
        r->ignore_special_periods = v != 0;
        return true;
    }
    if (strcmp(method, "cm") == 0) {
        // clamp_max(medium_factor=2.5, max_dur=None, clip_start=None, verbose=False)
        double factor, max_dur, clip;
        if (!number_or(&args[0], 2.5, &factor) || !number_or(&args[1], 0, &max_dur) || !number_or(&args[2], -1, &clip))
            return false;
        if (!(factor || max_dur)) return false;
        return clamp_max(r, factor, max_dur, clip < 0 ? -1 : clip != 0);
    }
    if (strcmp(method, "sg") == 0) {
        // split_by_gap(max_gap=0.1, lock=False, newline=False, ignore_special_periods=False)
        double gap, lock, newline, isp;
        if (!number_or(&args[0], 0.1, &gap) || !number_or(&args[1], 0, &lock) || !number_or(&args[2], 0, &newline)
            || !number_or(&args[3], 0, &isp) || lock || newline)
            return false;
        split_args sa = {.kind = SPLIT_GAP, .max_gap = gap, .ignore_special_periods = r->ignore_special_periods || isp};
        return split_segments(r, &sa);
    }
    if (strcmp(method, "sp") == 0) {
        // split_by_punctuation(punctuation, lock, newline, min_words, min_chars, min_dur, ignore_special_periods)
        double lock, newline, min_words, min_chars, min_dur, isp;
        if (!number_or(&args[1], 0, &lock) || !number_or(&args[2], 0, &newline) || !number_or(&args[3], -1, &min_words)
            || !number_or(&args[4], -1, &min_chars) || !number_or(&args[5], -1, &min_dur) || !number_or(&args[6], 0, &isp)
            || lock || newline)
            return false;
        size_t n;
        punct *p = parse_punctuation(&args[0], &n);
        if (!p) return false;
        split_args sa = {.kind = SPLIT_PUNCTUATION, .punct = p, .n_punct = n, .min_words = (long) min_words,
                         .min_chars = (long) min_chars, .min_dur = min_dur,
                         .ignore_special_periods = r->ignore_special_periods || isp};
        bool ok = split_segments(r, &sa);
        free_punctuation(p, n);
        return ok;
    }
    if (strcmp(method, "sl") == 0) {
        // split_by_length(max_chars, max_words, even_split=True, force_len, lock, include_lock, newline, ignore_special_periods)
        double max_chars, max_words, even, force_len, lock, include_lock, newline, isp;
        if (!number_or(&args[0], -1, &max_chars) || !number_or(&args[1], -1, &max_words) || !number_or(&args[2], 1, &even)
            || !number_or(&args[3], 0, &force_len) || !number_or(&args[4], 0, &lock) || !number_or(&args[5], 0, &include_lock)
            || !number_or(&args[6], 0, &newline) || !number_or(&args[7], 0, &isp) || force_len || lock || include_lock
            || newline || max_chars == 0 || max_words == 0)
            return false;
        split_args sa = {.kind = SPLIT_LENGTH, .max_chars = (long) max_chars, .max_words = (long) max_words,
                         .even = even != 0, .ignore_special_periods = r->ignore_special_periods || isp};
        return split_segments(r, &sa);
    }
    return false;
}

bool st_regroup(st_result *r, const char *algo) {
    static const char DEFAULT[] = "isp_cm_sp=.* /。/?/？_sg=.5_sp=,* /，++++50_sl=70_cm";
    if (!algo || strcmp(algo, "True") == 0) algo = "da";
    // "da" anywhere stands for the default calls.
    size_t cap = strlen(algo) * (sizeof DEFAULT) + 1;
    char *calls = malloc(cap);
    if (!calls) return false;
    calls[0] = 0;
    char *copy = strdup(algo);
    if (!copy) {
        free(calls);
        return false;
    }
    char *save = NULL;
    for (char *m = strtok_r(copy, "_", &save); m; m = strtok_r(NULL, "_", &save)) {
        if (*calls) strcat(calls, "_");
        strcat(calls, strcmp(m, "da") == 0 ? DEFAULT : m);
    }
    free(copy);
    // Each call checked before any runs: an unknown one changes nothing.
    bool ok = true;
    for (int pass = 0; pass < 2 && ok; pass++) {
        char *list = strdup(calls);
        if (!list) {
            ok = false;
            break;
        }
        char *outer = NULL;
        for (char *m = strtok_r(list, "_", &outer); m && ok; m = strtok_r(NULL, "_", &outer)) {
            char *eq = strchr(m, '=');
            arg args[MAX_ARGS];
            size_t n_args = 0;
            if (eq) {
                *eq = 0;
                // args.split('+'): empty pieces count.
                char *at = eq + 1;
                for (;;) {
                    char *plus = strchr(at, '+');
                    if (plus) *plus = 0;
                    if (n_args == MAX_ARGS) {
                        ok = false;
                        break;
                    }
                    args[n_args++] = parse_arg(at);
                    if (!plus) break;
                    at = plus + 1;
                }
            }
            if (!ok) break;
            bool known = strcmp(m, "isp") == 0 || strcmp(m, "cm") == 0 || strcmp(m, "sg") == 0 || strcmp(m, "sp") == 0
                || strcmp(m, "sl") == 0;
            if (pass == 0) ok = known;
            else ok = run_method(r, m, args, n_args);
        }
        free(list);
    }
    free(calls);
    return ok;
}
