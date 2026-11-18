// whisperwords.h: faster-whisper's add_word_timestamps (transcribe.py), its
// find_alignment's words, the tokenizer's split_to_word_tokens (tokenizer.py) and
// merge_punctuations, step by step. Text is handled as Python does it: decoded
// from UTF-8 with each bad sequence one U+FFFD (as the tokenizer's decode does),
// lengths and tests in code points. Times are numpy floats there, so round() is
// numpy's.

#define _POSIX_C_SOURCE 200809L

#include "whisperwords.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// faster-whisper's defaults (WhisperModel.transcribe), and Python's.
static const char PREPENDED[] = "\"'“¿([{-";
static const char APPENDED[] = "\"'.。,，!！?？:：”)]}、";
static const char SENTENCE_END[] = ".。!！?？";
static const char PUNCTUATION[] = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";  // string.punctuation
#define TOKENS_PER_SECOND 50.0
#define FRAMES_PER_SECOND 100.0
#define TIME_PRECISION 0.02
#define REPLACEMENT 0xFFFD

static double np_round2(double x) {
    return nearbyint(x * 100) / 100;
}

// ---- text ---------------------------------------------------------------------

typedef struct {
    uint32_t *c;
    size_t n;
    size_t cap;
} text;

static bool push(text *t, uint32_t c) {
    if (t->n == t->cap) {
        size_t cap = t->cap ? 2 * t->cap : 32;
        uint32_t *more = realloc(t->c, cap * sizeof *more);
        if (!more) return false;
        t->c = more;
        t->cap = cap;
    }
    t->c[t->n++] = c;
    return true;
}

static bool append(text *t, const text *u) {
    for (size_t i = 0; i < u->n; i++) {
        if (!push(t, u->c[i])) return false;
    }
    return true;
}

// UTF-8 decoded as Python and Rust's from_utf8_lossy do: each maximal bad
// subsequence one U+FFFD.
static bool decode(const char *bytes, size_t len, text *out) {
    const unsigned char *s = (const unsigned char *) bytes;
    size_t i = 0;
    while (i < len) {
        unsigned char b = s[i];
        if (b < 0x80) {
            if (!push(out, b)) return false;
            i++;
            continue;
        }
        size_t need;
        unsigned char lo = 0x80, hi = 0xBF;
        uint32_t c;
        if (b >= 0xC2 && b <= 0xDF) {
            need = 1;
            c = b & 0x1F;
        } else if (b >= 0xE0 && b <= 0xEF) {
            need = 2;
            c = b & 0x0F;
            if (b == 0xE0) lo = 0xA0;
            if (b == 0xED) hi = 0x9F;
        } else if (b >= 0xF0 && b <= 0xF4) {
            need = 3;
            c = b & 0x07;
            if (b == 0xF0) lo = 0x90;
            if (b == 0xF4) hi = 0x8F;
        } else {
            if (!push(out, REPLACEMENT)) return false;
            i++;
            continue;
        }
        size_t k = 1;
        for (; k <= need && i + k < len; k++) {
            unsigned char x = s[i + k];
            if (x < lo || x > hi) break;
            c = (c << 6) | (x & 0x3F);
            lo = 0x80;
            hi = 0xBF;
        }
        if (k <= need) {
            if (!push(out, REPLACEMENT)) return false;
            i += k;
            continue;
        }
        if (!push(out, c)) return false;
        i += k;
    }
    return true;
}

static char *encode(const text *t) {
    char *out = malloc(4 * t->n + 1);
    if (!out) return NULL;
    size_t k = 0;
    for (size_t i = 0; i < t->n; i++) {
        uint32_t c = t->c[i];
        if (c < 0x80) {
            out[k++] = (char) c;
        } else if (c < 0x800) {
            out[k++] = (char) (0xC0 | (c >> 6));
            out[k++] = (char) (0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            out[k++] = (char) (0xE0 | (c >> 12));
            out[k++] = (char) (0x80 | ((c >> 6) & 0x3F));
            out[k++] = (char) (0x80 | (c & 0x3F));
        } else {
            out[k++] = (char) (0xF0 | (c >> 18));
            out[k++] = (char) (0x80 | ((c >> 12) & 0x3F));
            out[k++] = (char) (0x80 | ((c >> 6) & 0x3F));
            out[k++] = (char) (0x80 | (c & 0x3F));
        }
    }
    out[k] = 0;
    return out;
}

static bool space(uint32_t c) {
    // str.isspace()
    return c == ' ' || (c >= 0x09 && c <= 0x0D) || (c >= 0x1C && c <= 0x1F) || c == 0x85 || c == 0xA0 || c == 0x1680
        || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000;
}

// Python's `t.strip() in s` (a substring test: the empty string is in every string).
static bool stripped_in(const text *t, const char *s) {
    size_t a = 0, b = t->n;
    while (a < b && space(t->c[a])) a++;
    while (b > a && space(t->c[b - 1])) b--;
    text part = {t->c + a, b - a, 0};
    char *u = encode(&part);
    if (!u) return false;
    bool in = strstr(s, u) != NULL;
    free(u);
    return in;
}

// Python's `t in s`.
static bool in(const text *t, const char *s) {
    char *u = encode(t);
    if (!u) return false;
    bool found = strstr(s, u) != NULL;
    free(u);
    return found;
}

static bool blank(const text *t) {
    for (size_t i = 0; i < t->n; i++) {
        if (!space(t->c[i])) return false;
    }
    return true;
}

// ---- words ----------------------------------------------------------------------

typedef struct {
    text word;
    size_t first;     // its first token
    size_t n_tokens;  // after merge_punctuations, how many it counts as
    double start;
    double end;
} timing;

static void free_timings(timing *t, size_t n) {
    for (size_t i = 0; i < n; i++) free(t[i].word.c);
    free(t);
}

// Tokenizer.split_tokens_on_unicode, then split_tokens_on_spaces: tokens (the
// text ones, then end-of-text, which decodes to nothing) into words.
static timing *split_to_words(const ww_token *tokens, size_t n_text, size_t *n_words) {
    *n_words = 0;
    size_t n = n_text + 1;
    size_t total = 0;
    for (size_t i = 0; i < n_text; i++) total += strlen(tokens[i].text);
    char *all = malloc(total + 1);
    timing *words = calloc(n, sizeof *words);
    text full = {0}, decoded = {0};
    if (!all || !words) goto oom;
    size_t at = 0;
    for (size_t i = 0; i < n_text; i++) {
        size_t len = strlen(tokens[i].text);
        memcpy(all + at, tokens[i].text, len);
        at += len;
    }
    if (!decode(all, total, &full)) goto oom;
    size_t offset = 0;  // code points accepted so far
    size_t from = 0;    // the current group's first token, and its first byte
    size_t byte_from = 0, byte_at = 0;
    for (size_t i = 0; i < n; i++) {
        if (i < n_text) byte_at += strlen(tokens[i].text);
        decoded.n = 0;
        if (!decode(all + byte_from, byte_at - byte_from, &decoded)) goto oom;
        size_t bad = SIZE_MAX;
        for (size_t k = 0; k < decoded.n; k++) {
            if (decoded.c[k] == REPLACEMENT) {
                bad = k + offset;
                break;
            }
        }
        if (bad != SIZE_MAX && !(bad < full.n && full.c[bad] == REPLACEMENT)) continue;
        // A whole subword: tokens from..i.
        bool special = from >= n_text;
        bool with_space = decoded.n > 0 && decoded.c[0] == ' ';
        bool punctuation = stripped_in(&decoded, PUNCTUATION);
        if (special || with_space || punctuation || *n_words == 0) {
            timing *w = &words[(*n_words)++];
            if (!append(&w->word, &decoded)) goto oom;
            w->first = from;
            w->n_tokens = i + 1 - from;
        } else {
            timing *w = &words[*n_words - 1];
            if (!append(&w->word, &decoded)) goto oom;
            w->n_tokens += i + 1 - from;
        }
        offset += decoded.n;
        from = i + 1;
        byte_from = byte_at;
    }
    free(all);
    free(full.c);
    free(decoded.c);
    return words;
oom:
    free(all);
    free(full.c);
    free(decoded.c);
    if (words) free_timings(words, n);
    *n_words = SIZE_MAX;
    return NULL;
}

static int cmp_double(const void *a, const void *b) {
    double x = *(const double *) a, y = *(const double *) b;
    return (x > y) - (x < y);
}

// merge_punctuations
static bool merge_punctuations(timing *a, size_t n) {
    if (n >= 2) {
        for (size_t j = n - 1, i = n - 1; i-- > 0;) {
            timing *previous = &a[i], *following = &a[j];
            if (previous->word.n > 0 && previous->word.c[0] == ' ' && stripped_in(&previous->word, PREPENDED)) {
                text joined = {0};
                if (!append(&joined, &previous->word) || !append(&joined, &following->word)) {
                    free(joined.c);
                    return false;
                }
                free(following->word.c);
                following->word = joined;
                following->n_tokens += previous->n_tokens;
                previous->word.n = 0;
                previous->n_tokens = 0;
            } else {
                j = i;
            }
        }
    }
    for (size_t i = 0, j = 1; j < n; j++) {
        timing *previous = &a[i], *following = &a[j];
        bool ends_space = previous->word.n > 0 && previous->word.c[previous->word.n - 1] == ' ';
        if (!ends_space && in(&following->word, APPENDED)) {
            if (!append(&previous->word, &following->word)) return false;
            previous->n_tokens += following->n_tokens;
            following->word.n = 0;
            following->n_tokens = 0;
        } else {
            i = j;
        }
    }
    return true;
}

bool ww_window(const ww_token *tokens, const ww_segment *segments, size_t n_segments, long seek,
               double *last_speech, ww_result *out) {
    memset(out, 0, n_segments * sizeof *out);
    size_t n_text = 0;
    for (size_t s = 0; s < n_segments; s++) n_text += segments[s].n_tokens;
    double time_offset = (double) seek / FRAMES_PER_SECOND;

    // find_alignment: the words, each from its first token's jump time to the next's.
    size_t n_words = 0;
    timing *a = NULL;
    if (n_text > 0) {
        a = split_to_words(tokens, n_text, &n_words);
        if (!a) return false;
    }
    size_t n_align = n_words > 1 ? n_words - 1 : 0;  // the last is end-of-text
    size_t boundary = 0;
    for (size_t w = 0; w < n_align; w++) {
        size_t next = boundary + a[w].n_tokens;
        // jump time k: 0 for the window's start, else token k - 1's t_dtw.
        a[w].start = boundary == 0 ? 0 : (double) ((tokens[boundary - 1].t_dtw - seek) / 2) / TOKENS_PER_SECOND;
        a[w].end = next == 0 ? 0 : (double) ((tokens[next - 1].t_dtw - seek) / 2) / TOKENS_PER_SECOND;
        boundary = next;
    }

    // add_word_timestamps: the median word, and sentence ends kept within twice it.
    double median = 0, max_duration = 0;
    double *d = malloc((n_align ? n_align : 1) * sizeof *d);
    if (!d) goto oom;
    size_t nz = 0;
    for (size_t w = 0; w < n_align; w++) {
        double x = a[w].end - a[w].start;
        if (x != 0) d[nz++] = x;
    }
    if (nz > 0) {
        qsort(d, nz, sizeof *d, cmp_double);
        median = nz % 2 ? d[nz / 2] : (d[nz / 2 - 1] + d[nz / 2]) / 2;
    }
    free(d);
    median = 0.7 < median ? 0.7 : median;
    max_duration = median * 2;
    if (nz > 0) {
        for (size_t i = 1; i < n_align; i++) {
            if (a[i].end - a[i].start > max_duration) {
                if (in(&a[i].word, SENTENCE_END)) a[i].end = a[i].start + max_duration;
                else if (in(&a[i - 1].word, SENTENCE_END)) a[i].start = a[i].end - max_duration;
            }
        }
    }
    if (!merge_punctuations(a, n_align)) goto oom;

    // Each segment its words, by token count, and its edges corrected.
    size_t word_index = 0, token_at = 0;
    for (size_t s = 0; s < n_segments; s++) {
        ww_result *r = &out[s];
        r->start = time_offset + (double) ((segments[s].t0 - seek) / 2) * TIME_PRECISION;
        r->end = time_offset + (double) ((segments[s].t1 - seek) / 2) * TIME_PRECISION;
        r->words = calloc(n_align ? n_align : 1, sizeof *r->words);
        if (!r->words) goto oom;
        size_t saved = 0;
        while (word_index < n_align && saved < segments[s].n_tokens) {
            timing *t = &a[word_index];
            if (t->word.n > 0) {
                ww_word *w = &r->words[r->n_words];
                w->text = encode(&t->word);
                if (!w->text) goto oom;
                w->start = np_round2(time_offset + t->start);
                w->end = np_round2(time_offset + t->end);
                r->n_words++;
            }
            saved += t->n_tokens;
            word_index++;
        }
        ww_word *w = r->words;
        size_t nw = r->n_words;
        if (nw > 0) {
            // The first and second word after a pause not over twice the median.
            if (w[0].end - *last_speech > median * 4
                && (w[0].end - w[0].start > max_duration || (nw > 1 && w[1].end - w[0].start > max_duration * 2))) {
                if (nw > 1 && w[1].end - w[1].start > max_duration) {
                    double half = w[1].end / 2, back = w[1].end - max_duration;
                    double boundary_ = half >= back ? half : back;
                    w[0].end = w[1].start = boundary_;
                }
                double start = w[0].end - max_duration;
                w[0].start = 0 >= start ? 0 : start;
            }
            // The segment's own start, where the first word is too long.
            if (r->start < w[0].end && r->start - 0.5 > w[0].start) {
                double start = w[0].end - median < r->start ? w[0].end - median : r->start;
                w[0].start = 0 >= start ? 0 : start;
            } else {
                r->start = w[0].start;
            }
            // And its end, where the last is.
            if (r->end > w[nw - 1].start && r->end + 0.5 < w[nw - 1].end) {
                double end = w[nw - 1].start + median;
                w[nw - 1].end = end >= r->end ? end : r->end;
            } else {
                r->end = w[nw - 1].end;
            }
            *last_speech = r->end;
        }
        // generate_segments drops a segment with no text or no length.
        text body = {0};
        size_t bytes = 0;
        for (size_t k = 0; k < segments[s].n_tokens; k++) bytes += strlen(tokens[token_at + k].text);
        char *joined = malloc(bytes + 1);
        if (!joined) goto oom;
        size_t at = 0;
        for (size_t k = 0; k < segments[s].n_tokens; k++) {
            size_t len = strlen(tokens[token_at + k].text);
            memcpy(joined + at, tokens[token_at + k].text, len);
            at += len;
        }
        bool ok = decode(joined, bytes, &body);
        free(joined);
        if (!ok) {
            free(body.c);
            goto oom;
        }
        r->keep = r->start != r->end && !blank(&body);
        free(body.c);
        token_at += segments[s].n_tokens;
    }

    // get_end: the window's last word's end, or its last segment's.
    for (size_t s = n_segments; s-- > 0;) {
        if (out[s].n_words > 0) {
            *last_speech = out[s].words[out[s].n_words - 1].end;
            goto found;
        }
    }
    if (n_segments > 0) *last_speech = out[n_segments - 1].end;
found:
    if (a) free_timings(a, n_text + 1);
    return true;
oom:
    if (a) free_timings(a, n_text + 1);
    ww_free(out, n_segments);
    return false;
}

void ww_free(ww_result *results, size_t n) {
    for (size_t s = 0; s < n; s++) {
        for (size_t i = 0; i < results[s].n_words; i++) free(results[s].words[i].text);
        free(results[s].words);
        results[s].words = NULL;
        results[s].n_words = 0;
    }
}

char *ww_stripped(const char *bytes, size_t len) {
    text t = {0};
    if (!decode(bytes, len, &t)) {
        free(t.c);
        return NULL;
    }
    size_t a = 0, b = t.n;
    while (a < b && space(t.c[a])) a++;
    while (b > a && space(t.c[b - 1])) b--;
    text part = {t.c + a, b - a, 0};
    char *out = encode(&part);
    free(t.c);
    return out;
}
