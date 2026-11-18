// transcript.h: faster-whisper's generate_segments and generate_with_fallback
// (transcribe.py) with its defaults (as ivrit.ai's server runs it, through stable-ts's
// faster_transcribe), each window decoded by whisper.cpp; the words through
// whisperwords, the kept segments through stablets.

#include "transcript.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#include "whisperwords.h"

// faster-whisper's: a window is 3000 mel frames (100 a second), a timestamp 2.
#define WINDOW 3000
#define HOP 160
static const float TEMPERATURES[] = {0.0f, 0.2f, 0.4f, 0.6f, 0.8f, 1.0f};
#define N_TEMPERATURES (sizeof TEMPERATURES / sizeof TEMPERATURES[0])
#define BEST_OF 5
#define COMPRESSION_RATIO_THRESHOLD 2.4
#define LOG_PROB_THRESHOLD -1.0
#define NO_SPEECH_THRESHOLD 0.6
#define PROMPT_RESET_ON_TEMPERATURE 0.5

void tr_context_params(struct whisper_context_params *params) {
    // ivrit.ai's Turbo keeps large-v3-turbo's alignment heads (its config.json).
    params->dtw_token_timestamps = true;
    params->dtw_aheads_preset = WHISPER_AHEADS_LARGE_V3_TURBO;
}

// One decoding of a window: its tokens without end-of-text, and how it scored.
typedef struct {
    whisper_token *tokens;
    int n;
    double avg_logprob;
    double compression_ratio;
    float no_speech_prob;
    float temperature;
} decoded;

// get_compression_ratio: the text's UTF-8 over zlib's (level 6, as Python's).
static bool compression_ratio(struct whisper_context *ctx, const whisper_token *tokens, int n, double *out) {
    const whisper_token eot = whisper_token_eot(ctx);
    size_t bytes = 0;
    for (int i = 0; i < n; i++) {
        if (tokens[i] < eot) bytes += strlen(whisper_token_to_str(ctx, tokens[i]));
    }
    char *joined = malloc(bytes + 1);
    if (!joined) return false;
    size_t at = 0;
    for (int i = 0; i < n; i++) {
        if (tokens[i] >= eot) continue;
        const char *s = whisper_token_to_str(ctx, tokens[i]);
        memcpy(joined + at, s, strlen(s));
        at += strlen(s);
    }
    char *text = ww_stripped(joined, bytes);
    free(joined);
    if (!text) return false;
    uLong len = (uLong) strlen(text);
    uLongf size = compressBound(len);
    Bytef *z = malloc(size);
    bool ok = z && compress(z, &size, (const Bytef *) text, len) == Z_OK;
    if (ok) *out = (double) len / (double) size;
    free(z);
    free(text);
    return ok;
}

// generate_with_fallback: decoded at each temperature in turn until neither too
// repetitive nor too improbable (or silent); failing all, the most probable of those
// not too repetitive (or of all). `out` is the one chosen.
static int decode_window(struct whisper_context *ctx, struct whisper_full_params base, int seek, int frames,
                         const tr_state *state, decoded *out) {
    decoded tried[N_TEMPERATURES];
    size_t n_tried = 0;
    int rc = 0;
    size_t chosen = 0;
    bool done = false;
    for (size_t k = 0; k < N_TEMPERATURES && !done; k++) {
        struct whisper_full_params p = base;
        p.ivrit_window = true;
        p.offset_ms = seek * 10;
        p.duration_ms = frames * 10;
        p.no_context = true;
        p.prompt_tokens = state->n_prompt > 0 ? state->prompt : NULL;
        p.prompt_n_tokens = state->n_prompt;
        p.temperature = TEMPERATURES[k];
        p.temperature_inc = 0.0f;  // one temperature a call: the fallback is here
        p.greedy.best_of = BEST_OF;
        p.entropy_thold = 0.0f;  // never fails a decoder: the compression ratio decides
        p.no_timestamps = false;
        p.single_segment = false;
        p.token_timestamps = false;
        p.progress_callback = NULL;
        p.print_progress = false;
        rc = whisper_full(ctx, p, NULL, 0);  // the piece's mel, computed once
        if (rc != 0) break;

        const whisper_token_data *seq;
        int n = whisper_full_ivrit_sequence(ctx, &seq);
        decoded *d = &tried[n_tried];
        d->tokens = malloc((n ? (size_t) n : 1) * sizeof *d->tokens);
        if (!d->tokens) {
            rc = TR_NO_MEMORY;
            break;
        }
        n_tried++;
        // The tokens without end-of-text; the average log probability over them and
        // it (faster-whisper's cumulative log probability over its length plus one).
        double sum = 0;
        d->n = 0;
        for (int i = 0; i < n; i++) {
            sum += seq[i].plog;
            if (seq[i].id != whisper_token_eot(ctx)) d->tokens[d->n++] = seq[i].id;
        }
        d->avg_logprob = sum / (d->n + 1);
        d->no_speech_prob = whisper_full_ivrit_no_speech_prob(ctx);
        d->temperature = TEMPERATURES[k];
        if (!compression_ratio(ctx, d->tokens, d->n, &d->compression_ratio)) {
            rc = TR_NO_MEMORY;
            break;
        }
        bool fallback = d->compression_ratio > COMPRESSION_RATIO_THRESHOLD || d->avg_logprob < LOG_PROB_THRESHOLD;
        if (d->no_speech_prob > NO_SPEECH_THRESHOLD && d->avg_logprob < LOG_PROB_THRESHOLD) fallback = false;  // silence
        if (!fallback) {
            chosen = n_tried - 1;
            done = true;
        }
    }
    if (rc == 0 && !done) {
        bool any_below = false;
        for (size_t k = 0; k < n_tried; k++) any_below |= tried[k].compression_ratio <= COMPRESSION_RATIO_THRESHOLD;
        bool first = true;
        for (size_t k = 0; k < n_tried; k++) {
            if (any_below && tried[k].compression_ratio > COMPRESSION_RATIO_THRESHOLD) continue;
            if (first || tried[k].avg_logprob > tried[chosen].avg_logprob) chosen = k;
            first = false;
        }
        tried[chosen].temperature = TEMPERATURES[N_TEMPERATURES - 1];  // for the prompt's reset
    }
    for (size_t k = 0; k < n_tried; k++) {
        if (rc == 0 && k == chosen) *out = tried[k];
        else free(tried[k].tokens);
    }
    return rc;
}

// _split_segments_by_timestamps: a window's segments ([from, to) of its tokens, and
// their times in centiseconds), and where the next window starts.
typedef struct {
    int from, to;
    long t0, t1;
} span;

static size_t split(const whisper_token *tokens, int n, whisper_token beg, int seek, int frames, span *spans,
                    int *next_seek, bool *single_ending) {
    *single_ending = n >= 2 && tokens[n - 2] < beg && tokens[n - 1] >= beg;
    size_t count = 0;
    int last_slice = 0;
    bool consecutive = false;
    for (int i = 1; i <= n; i++) {
        bool cut = i < n ? tokens[i] >= beg && tokens[i - 1] >= beg : *single_ending && consecutive;
        if (!cut) continue;
        consecutive = true;
        spans[count++] = (span) {last_slice, i, seek + 2L * (tokens[last_slice] - beg), seek + 2L * (tokens[i - 1] - beg)};
        last_slice = i;
    }
    if (consecutive) {
        *next_seek = *single_ending ? seek + frames : seek + 2 * (tokens[last_slice - 1] - beg);
        return count;
    }
    long duration = frames;
    for (int i = n; i-- > 0;) {
        if (tokens[i] >= beg) {
            if (tokens[i] != beg) duration = 2L * (tokens[i] - beg);
            break;
        }
    }
    spans[0] = (span) {0, n, seek, seek + duration};
    *next_seek = seek + frames;
    return 1;
}

// The window's segments through whisperwords (the DTW over their text tokens and the
// window's frames, as add_word_timestamps aligns), into results[count].
static int window_words(struct whisper_context *ctx, int threads, const whisper_token *tokens, const span *spans,
                        size_t count, int seek, int frames, double *last_speech, ww_result *results) {
    const whisper_token eot = whisper_token_eot(ctx);
    int n_text = 0;
    for (size_t s = 0; s < count; s++) {
        for (int i = spans[s].from; i < spans[s].to; i++) n_text += tokens[i] < eot;
    }
    whisper_token *text = malloc((n_text ? (size_t) n_text : 1) * sizeof *text);
    int64_t *t_dtw = malloc((n_text ? (size_t) n_text : 1) * sizeof *t_dtw);
    ww_token *words = malloc((n_text ? (size_t) n_text : 1) * sizeof *words);
    ww_segment *segments = malloc(count * sizeof *segments);
    int rc = TR_NO_MEMORY;
    if (!text || !t_dtw || !words || !segments) goto done;
    int k = 0;
    for (size_t s = 0; s < count; s++) {
        int first = k;
        for (int i = spans[s].from; i < spans[s].to; i++) {
            if (tokens[i] < eot) text[k++] = tokens[i];
        }
        segments[s] = (ww_segment) {spans[s].t0, spans[s].t1, (size_t) (k - first)};
    }
    if (n_text > 0 && whisper_full_ivrit_dtw(ctx, text, n_text, seek, frames, t_dtw, threads) != 0) {
        rc = -1;
        goto done;
    }
    for (int i = 0; i < n_text; i++) words[i] = (ww_token) {whisper_token_to_str(ctx, text[i]), (long) t_dtw[i]};
    rc = ww_window(words, segments, count, seek, last_speech, results) ? 0 : TR_NO_MEMORY;
done:
    free(text);
    free(t_dtw);
    free(words);
    free(segments);
    return rc;
}

static bool add_segment(st_result *r, const ww_result *w, double offset) {
    size_t n = w->n_words ? w->n_words : 1;
    const char **texts = malloc(n * sizeof *texts);
    double *starts = malloc(n * sizeof *starts);
    double *ends = malloc(n * sizeof *ends);
    bool ok = texts && starts && ends;
    for (size_t i = 0; ok && i < w->n_words; i++) {
        texts[i] = w->words[i].text;
        starts[i] = w->words[i].start + offset;
        ends[i] = w->words[i].end + offset;
    }
    ok = ok && st_add_segment(r, texts, starts, ends, w->n_words);
    free(texts);
    free(starts);
    free(ends);
    return ok;
}

// all_tokens.extend(segment tokens), of which the prompt is the last TR_PROMPT.
static void remember(tr_state *state, const whisper_token *tokens, int n) {
    for (int i = 0; i < n; i++) {
        if (state->n_prompt == TR_PROMPT) {
            memmove(state->prompt, state->prompt + 1, (TR_PROMPT - 1) * sizeof *state->prompt);
            state->n_prompt--;
        }
        state->prompt[state->n_prompt++] = tokens[i];
    }
}

int tr_piece_make(struct whisper_context *ctx, struct whisper_full_params params, const float *pcm, size_t n,
                  double offset, bool last, tr_state *state, tr_piece *out) {
    out->result = NULL;
    out->next = offset + (double) n / WHISPER_SAMPLE_RATE;
    st_result *r = st_new();
    if (!r) return TR_NO_MEMORY;
    if (whisper_pcm_to_mel(ctx, pcm, (int) n, params.n_threads) != 0) {
        st_free(r);
        return -1;
    }
    const whisper_token beg = whisper_token_beg(ctx);
    const int content = (int) (n / HOP);
    tr_state work = *state;
    // whisperwords' times are the piece's; faster-whisper's last speech is the file's.
    double speech = work.last_speech - offset;
    int seek = 0;
    int rc = 0;
    while (seek < content) {
        if (params.progress_callback) {
            params.progress_callback(ctx, NULL, (int) (100L * seek / content), params.progress_callback_user_data);
        }
        if (params.abort_callback && params.abort_callback(params.abort_callback_user_data)) {
            rc = -1;  // stopped
            break;
        }
        // A window cut short by the piece's end is the next piece's to hear whole.
        if (!last && content - seek < WINDOW) break;
        const int frames = content - seek < WINDOW ? content - seek : WINDOW;
        decoded d;
        rc = decode_window(ctx, params, seek, frames, &work, &d);
        if (rc != 0) break;
        // No voice: on to the next window.
        if (d.no_speech_prob > NO_SPEECH_THRESHOLD && !(d.avg_logprob > LOG_PROB_THRESHOLD)) {
            free(d.tokens);
            seek += frames;
            continue;
        }
        span *spans = malloc(((size_t) d.n + 1) * sizeof *spans);
        ww_result *results = calloc((size_t) d.n + 1, sizeof *results);
        if (!spans || !results) {
            free(spans);
            free(results);
            free(d.tokens);
            rc = TR_NO_MEMORY;
            break;
        }
        int next_seek;
        bool single_ending;
        size_t count = split(d.tokens, d.n, beg, seek, frames, spans, &next_seek, &single_ending);
        rc = window_words(ctx, params.n_threads, d.tokens, spans, count, seek, frames, &speech, results);
        if (rc == 0) {
            // With word times, the next window starts at the last word's end.
            if (!single_ending && speech > seek / 100.0) next_seek = (int) llround(speech * 100);
            for (size_t s = 0; s < count && rc == 0; s++) {
                if (!results[s].keep) continue;
                if (!add_segment(r, &results[s], offset)) rc = TR_NO_MEMORY;
                remember(&work, d.tokens + spans[s].from, spans[s].to - spans[s].from);
            }
            if (d.temperature > PROMPT_RESET_ON_TEMPERATURE) work.n_prompt = 0;
        }
        ww_free(results, count);
        free(results);
        free(spans);
        free(d.tokens);
        if (rc != 0) break;
        seek = next_seek;
    }
    if (rc != 0) {
        st_free(r);
        return rc;
    }
    if (seek < content) out->next = offset + seek / 100.0;
    work.last_speech = speech + offset;

    // faster_transcribe's post-processing: in order, then out of silence, then regrouped.
    st_finish(r, work.after);
    double *starts, *ends;
    size_t silences;
    if (!st_silence(pcm, n, ST_Q_LEVELS, ST_K_SIZE, offset, &starts, &ends, &silences)) {
        st_free(r);
        return TR_NO_MEMORY;
    }
    st_suppress_silence(r, starts, ends, silences, ST_MIN_WORD_DUR, ST_NONSPEECH_ERROR, true);
    free(starts);
    free(ends);
    if (!st_regroup(r, "da")) {
        st_free(r);
        return TR_NO_MEMORY;
    }
    size_t segments = st_segments(r);
    if (segments > 0) {
        size_t nw;
        const st_word *w = st_segment(r, segments - 1, &nw);
        work.after = w[nw - 1].end;
    }
    *state = work;
    out->result = r;
    return 0;
}
