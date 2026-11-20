// The Turbo model in a browser (WebAssembly, on the browser's WebGPU): a whole
// recording's transcript as ivrit.ai's server makes it, the same code as the apps'
// (transcript, stablets, whisperwords, speakers over whisper.cpp with the app's
// patches), for the web app's on-device transcription (web/turbo, built by
// scripts/build-web-turbo.sh).
//
// The page decodes the file to 16 kHz mono itself and hands over its samples. As on
// Android (LocalTranscribeWorker), the recording goes through ten minutes at a time,
// silence found against the whole file's loudness, the prompt and the last speech
// carried from piece to piece; each segment gets its voice print, and the prints are
// clustered at the end. The result is the app's transcript JSON: [{start, end, text,
// speakers, words: [{word, start, end}]}].
//
// ggml waits for the GPU synchronously, which the browser allows through JSPI: the
// calls that run the model are exported as promising (CMakeLists.txt, JSPI_EXPORTS).

#include <emscripten.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <vector>

#include "speakers.h"
#include "stablets.h"
#include "transcript.h"
#include "whisper.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"

namespace {

constexpr int RATE = WHISPER_SAMPLE_RATE;
constexpr double PIECE_SECONDS = 600;  // Turbo.CHUNK_SECONDS
constexpr int BEAMS = 5;               // Turbo.GPU_BEAMS: the server's beam size, by default

whisper_context *g_ctx = nullptr;
sp_model *g_speakers = nullptr;
std::string g_error;
std::string g_result;
volatile bool g_stop = false;

EM_JS(void, tw_told, (const char *phase, double fraction), {
    if (Module.onProgress) Module.onProgress(UTF8ToString(phase), fraction);
});

struct Progress {
    double from;     // where the piece starts, seconds
    double seconds;  // the piece's length
    double total;    // the recording's
};

void on_progress(whisper_context *, whisper_state *, int percent, void *user) {
    const Progress *p = static_cast<const Progress *>(user);
    double done = p->total > 0 ? (p->from + p->seconds * percent / 100.0) / p->total : 0;
    tw_told("transcribing", done < 1 ? done : 1);
}

bool on_abort(void *) {
    return g_stop;
}

void on_cluster(double fraction, void *) {
    tw_told("speakers", fraction);
}

void json_string(std::string &out, const char *s) {
    out += '"';
    for (; *s; s++) {
        unsigned char c = static_cast<unsigned char>(*s);
        if (c == '"' || c == '\\') {
            out += '\\';
            out += static_cast<char>(c);
        } else if (c < 0x20) {
            char buf[8];
            snprintf(buf, sizeof buf, "\\u%04x", c);
            out += buf;
        } else {
            out += static_cast<char>(c);
        }
    }
    out += '"';
}

std::string seconds(double t) {
    char buf[32];
    snprintf(buf, sizeof buf, "%.3f", std::round(t * 1000) / 1000);
    return buf;
}

struct Word {
    std::string text;  // as whisper writes it: " word," with its leading space
    double start, end;
};

struct Segment {
    std::vector<Word> words;
    bool printed = false;
    float print[SP_DIM];
};

}  // namespace

extern "C" {

// The last failure's message.
EMSCRIPTEN_KEEPALIVE const char *tw_error() {
    return g_error.c_str();
}

// The model file (in the module's file system), on WebGPU (`gpu`) or the CPU, the
// decoder with it. 0 when it loaded.
EMSCRIPTEN_KEEPALIVE int tw_load(const char *path, int gpu) {
    try {
        // The app's own WebGPU programs (patches/ggml-webgpu-phones.patch): built for
        // phones' GPUs, and faster than ggml's on GPUs without subgroup matrices, as
        // browsers' are. Read once, as ggml first starts.
        // (TW_NO_MOBILE, for finding what goes wrong on a GPU: ggml's own programs only.)
        if (!getenv("TW_NO_MOBILE")) setenv("GGML_WEBGPU_MOBILE", "1", 1);
        // A wait for the GPU may take long in a browser (its first run compiles every
        // program); a GPU that hangs is the browser's to reset, which fails the wait.
        setenv("GGML_WEBGPU_WAIT_MS", "600000", 0);
        // Short submissions: Windows resets a GPU whose work runs over two seconds at once.
        setenv("GGML_WEBGPU_SUBMIT_BATCH", "8", 0);
        if (g_ctx) whisper_free(g_ctx);
        whisper_context_params cp = whisper_context_default_params();
        cp.use_gpu = gpu != 0;
        cp.gpu_device = 0;
        cp.flash_attn = true;
        tr_context_params(&cp);
        g_ctx = whisper_init_from_file_with_params(path, cp);
        if (!g_ctx) {
            g_error = "the model did not load";
            return -1;
        }
        return 0;
    } catch (const std::exception &e) {
        g_error = e.what();
    } catch (...) {
        g_error = "unknown exception";
    }
    g_ctx = nullptr;
    return -1;
}

// One kernel timed on the GPU, for tuning: what 0 (q8_0 matrix multiply: K x M
// weights times K x N; N up to 8 is the matrix-vector program, as beam search's
// decoder steps) or 1 (flash attention: head size 64, n_q = n_kv = N, M heads),
// `reps` times after one to build it; milliseconds per run, -1 when it failed. The
// GPU's result against the CPU's: tw_error() says how far apart (max |difference| /
// max |value|).
EMSCRIPTEN_KEEPALIVE double tw_bench(int what, int K, int M, int N, int reps) {
    try {
        setenv("GGML_WEBGPU_MOBILE", "1", 1);
        setenv("GGML_WEBGPU_SUBMIT_BATCH", "8", 0);
        auto run = [&](ggml_backend_t be, int times, double *ms) {
            ggml_init_params ip = {ggml_tensor_overhead() * 8 + ggml_graph_overhead(), nullptr, true};
            ggml_context *ctx = ggml_init(ip);
            ggml_tensor *out;
            std::vector<ggml_tensor *> inputs;
            if (what == 0) {
                ggml_tensor *a = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, K, M);
                ggml_tensor *b = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, K, N);
                out = ggml_mul_mat(ctx, a, b);
                inputs = {a, b};
            } else {
                ggml_tensor *q = ggml_new_tensor_3d(ctx, GGML_TYPE_F32, 64, N, M);
                ggml_tensor *k = ggml_new_tensor_3d(ctx, GGML_TYPE_F16, 64, N, M);
                ggml_tensor *v = ggml_new_tensor_3d(ctx, GGML_TYPE_F16, 64, N, M);
                out = ggml_flash_attn_ext(ctx, q, k, v, nullptr, 0.125f, 0.0f, 0.0f);
                inputs = {q, k, v};
            }
            ggml_cgraph *gf = ggml_new_graph(ctx);
            ggml_build_forward_expand(gf, out);
            ggml_backend_buffer_t buf = ggml_backend_alloc_ctx_tensors(ctx, be);
            uint32_t seed = 7;
            for (ggml_tensor *t : inputs) {
                const int64_t n = ggml_nelements(t);
                std::vector<float> values(n);
                for (int64_t i = 0; i < n; i++) {
                    seed = seed * 1664525u + 1013904223u;
                    values[i] = ((seed >> 9) / 8388608.0f - 0.5f) * (t->type == GGML_TYPE_Q8_0 ? 0.1f : 1.0f);
                }
                std::vector<uint8_t> raw(ggml_nbytes(t));
                if (t->type == GGML_TYPE_F32) memcpy(raw.data(), values.data(), raw.size());
                else if (t->type == GGML_TYPE_F16) for (int64_t i = 0; i < n; i++) ((ggml_fp16_t *) raw.data())[i] = ggml_fp32_to_fp16(values[i]);
                else ggml_quantize_chunk(t->type, values.data(), raw.data(), 0, t->ne[1], t->ne[0], nullptr);
                ggml_backend_tensor_set(t, raw.data(), 0, raw.size());
            }
            ggml_backend_graph_compute(be, gf);
            std::vector<float> result(ggml_nelements(out));
            ggml_backend_tensor_get(out, result.data(), 0, result.size() * sizeof(float));
            if (ms) {
                double t0 = emscripten_get_now();
                for (int i = 0; i < times; i++) ggml_backend_graph_compute(be, gf);
                ggml_backend_tensor_get(out, result.data(), 0, result.size() * sizeof(float));
                *ms = (emscripten_get_now() - t0) / (times > 0 ? times : 1);
            }
            ggml_backend_buffer_free(buf);
            ggml_free(ctx);
            return result;
        };
        ggml_backend_dev_t dev = ggml_backend_dev_by_name("WebGPU");
        if (!dev) {
            g_error = "no WebGPU device";
            return -1;
        }
        ggml_backend_t gpu = ggml_backend_dev_init(dev, nullptr);
        double ms = 0;
        std::vector<float> got = run(gpu, reps, &ms);
        ggml_backend_free(gpu);
        ggml_backend_t cpu = ggml_backend_cpu_init();
        std::vector<float> want = run(cpu, 0, nullptr);
        ggml_backend_free(cpu);
        double err = 0, top = 0;
        for (size_t i = 0; i < want.size(); i++) {
            err = std::max(err, (double) std::fabs(got[i] - want[i]));
            top = std::max(top, (double) std::fabs(want[i]));
        }
        char buf[64];
        snprintf(buf, sizeof buf, "error %.2g", top > 0 ? err / top : err);
        g_error = buf;
        return ms;
    } catch (const std::exception &e) {
        g_error = e.what();
    } catch (...) {
        g_error = "unknown exception";
    }
    return -1;
}

// whisper.cpp's timings so far (encode, decode, batched…) to the log.
EMSCRIPTEN_KEEPALIVE void tw_timings() {
    if (g_ctx) whisper_print_timings(g_ctx);
}

// The models let go (the GPU's memory with them).
EMSCRIPTEN_KEEPALIVE void tw_free() {
    if (g_ctx) whisper_free(g_ctx);
    g_ctx = nullptr;
    if (g_speakers) sp_free(g_speakers);
    g_speakers = nullptr;
}

// The speaker model; without it, the transcript has no speakers. On the GPU when the
// model is (`gpu`) and a print there is the CPU's (one second of sound, cosine 0.999):
// the page has one thread, on which the prints of an hour take minutes. 0 when it
// loaded.
EMSCRIPTEN_KEEPALIVE int tw_load_speakers(const char *path, int gpu) {
    if (g_speakers) sp_free(g_speakers);
    g_speakers = sp_load(path, 1);
    if (!g_speakers) {
        g_error = "the speaker model did not load";
        return -1;
    }
    if (gpu) {
        sp_model *on_gpu = sp_load_gpu(path, 0);
        if (on_gpu) {
            std::vector<float> sound(SP_SAMPLE_RATE);
            uint32_t seed = 11;
            for (float &v : sound) {
                seed = seed * 1664525u + 1013904223u;
                v = ((seed >> 9) / 8388608.0f - 0.5f) * 0.2f;
            }
            float a[SP_DIM], b[SP_DIM];
            bool ok = false;
            try {
                ok = sp_embed(g_speakers, sound.data(), sound.size(), a) && sp_embed(on_gpu, sound.data(), sound.size(), b);
            } catch (...) {
                ok = false;
            }
            double dot = 0, na = 0, nb = 0;
            for (int i = 0; ok && i < SP_DIM; i++) {
                dot += a[i] * b[i];
                na += a[i] * a[i];
                nb += b[i] * b[i];
            }
            const double cosine = ok && na > 0 && nb > 0 ? dot / std::sqrt(na * nb) : 0;
            fprintf(stderr, "speakers: GPU print %s (cosine %.5f)\n", cosine >= 0.999 ? "used" : "not used", cosine);
            if (cosine >= 0.999) {
                sp_free(g_speakers);
                g_speakers = on_gpu;
            } else {
                sp_free(on_gpu);
            }
        }
    }
    return 0;
}

// Stops a transcription under way (tw_transcribe returns -2).
EMSCRIPTEN_KEEPALIVE void tw_stop() {
    g_stop = true;
}

// The transcript of n samples of 16 kHz mono sound, with beam search of `beams` (0:
// the server's 5; 1: greedy): 0, with the JSON in tw_result(); -2 when stopped, -1
// when it failed (tw_error()).
EMSCRIPTEN_KEEPALIVE int tw_transcribe(const float *pcm, size_t n, int beams) {
    if (!g_ctx) {
        g_error = "no model";
        return -1;
    }
    g_stop = false;
    g_result.clear();
    try {
        if (beams <= 0) beams = BEAMS;
        whisper_full_params params =
            whisper_full_default_params(beams > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
        if (beams > 1) params.beam_search.beam_size = beams;
        params.n_threads = 1;
        params.language = "he";
        params.suppress_nst = true;
        params.print_progress = false;
        params.print_timestamps = false;
        params.abort_callback = on_abort;
        Progress progress = {0, 0, static_cast<double>(n) / RATE};
        params.progress_callback = on_progress;
        params.progress_callback_user_data = &progress;

        tr_state state = {};
        const size_t piece_samples = static_cast<size_t>(PIECE_SECONDS * RATE);
        // Longer than a piece: silence is found against the whole file's loudness
        // (LocalTranscribeWorker.fileLevel), as stable-ts finds it over all of it.
        if (n > piece_samples) {
            st_level *level = st_level_new(n);
            if (level) {
                st_level_add(level, pcm, n);
                size_t total;
                float loud;
                if (st_level_end(level, &total, &loud)) {
                    state.total = total;
                    state.level = loud;
                    state.origin = 0;
                }
            }
        }

        std::vector<Segment> segments;
        size_t from = 0;
        while (from < n) {
            const size_t count = std::min(piece_samples, n - from);
            const bool last = from + count >= n;
            const double offset = static_cast<double>(from) / RATE;
            progress.from = offset;
            progress.seconds = static_cast<double>(count) / RATE;
            tr_piece piece;
            int rc = tr_piece_make(g_ctx, params, pcm + from, count, offset, last, &state, &piece);
            if (g_stop) {
                if (rc == 0) st_free(piece.result);
                return -2;
            }
            if (rc != 0) {
                g_error = rc == TR_NO_MEMORY ? "out of memory" : "whisper_full failed (" + std::to_string(rc) + ")";
                return -1;
            }
            const size_t first = segments.size();
            for (size_t s = 0; s < st_segments(piece.result); s++) {
                size_t words;
                const st_word *w = st_segment(piece.result, s, &words);
                if (words == 0) continue;
                Segment seg;
                for (size_t i = 0; i < words; i++) seg.words.push_back({w[i].text, w[i].start, w[i].end});
                segments.push_back(std::move(seg));
            }
            st_free(piece.result);
            // The piece's voice prints (LocalTranscribeWorker.hearTurbo, Speakers.prints).
            if (g_speakers) {
                std::vector<const float *> sounds;
                std::vector<size_t> lengths, which;
                for (size_t i = first; i < segments.size(); i++) {
                    size_t a, b;
                    if (!sp_segment_sound(segments[i].words.front().start, segments[i].words.back().end, offset, count, &a, &b)) continue;
                    sounds.push_back(pcm + from + a);
                    lengths.push_back(b - a);
                    which.push_back(i);
                }
                if (!sounds.empty()) {
                    tw_told("prints", 0);
                    std::vector<float> out(sounds.size() * SP_DIM);
                    std::unique_ptr<bool[]> ok(new bool[sounds.size()]);
                    sp_embed_many(g_speakers, sounds.data(), lengths.data(), sounds.size(), out.data(), ok.get());
                    for (size_t k = 0; k < which.size(); k++) {
                        if (!ok[k]) continue;
                        segments[which[k]].printed = true;
                        memcpy(segments[which[k]].print, &out[k * SP_DIM], sizeof(float) * SP_DIM);
                    }
                }
            }
            if (last) break;
            size_t next = static_cast<size_t>(std::llround(piece.next * RATE));
            from = next > from ? next : from + count;  // always forward
        }

        // Who speaks when, over the whole recording at once (TurboTranscript.speakers).
        std::vector<int> labels(segments.size(), -1);
        if (g_speakers && !segments.empty()) {
            const size_t m = segments.size();
            std::vector<float> prints(m * SP_DIM, 0.0f);
            std::unique_ptr<bool[]> clustered(new bool[m]), missing(new bool[m]);
            for (size_t i = 0; i < m; i++) {
                const Segment &s = segments[i];
                missing[i] = !s.printed;
                clustered[i] = s.printed && s.words.back().end - s.words.front().start >= SP_MIN_CLUSTERED;
                if (s.printed) memcpy(&prints[i * SP_DIM], s.print, sizeof(float) * SP_DIM);
            }
            if (sp_cluster(prints.data(), clustered.get(), missing.get(), m, labels.data(), on_cluster, nullptr) < 0) {
                labels.assign(m, -1);
            }
        }

        // The app's transcript (TurboTranscript.json).
        std::string out = "[";
        for (size_t i = 0; i < segments.size(); i++) {
            const Segment &s = segments[i];
            std::string text;
            std::string words = "[";
            for (size_t k = 0; k < s.words.size(); k++) {
                const Word &w = s.words[k];
                text += w.text;
                std::string trimmed = w.text;
                trimmed.erase(0, trimmed.find_first_not_of(' '));
                trimmed.erase(trimmed.find_last_not_of(' ') + 1);
                if (k) words += ",";
                words += "{\"word\":";
                json_string(words, trimmed.c_str());
                words += ",\"start\":" + seconds(w.start) + ",\"end\":" + seconds(w.end) + "}";
            }
            words += "]";
            text.erase(0, text.find_first_not_of(' '));
            text.erase(text.find_last_not_of(' ') + 1);
            if (i) out += ",";
            out += "{\"start\":" + seconds(s.words.front().start) + ",\"end\":" + seconds(s.words.back().end) + ",\"text\":";
            json_string(out, text.c_str());
            out += ",\"speakers\":[";
            if (labels[i] >= 0) {
                char label[16];
                snprintf(label, sizeof label, "\"SPEAKER_%02d\"", labels[i]);
                out += label;
            }
            out += "],\"words\":" + words + "}";
        }
        out += "]";
        g_result = std::move(out);
        return 0;
    } catch (const std::exception &e) {
        g_error = e.what();
    } catch (...) {
        g_error = "unknown exception";
    }
    return -1;
}

// The last transcript's JSON (tw_transcribe).
EMSCRIPTEN_KEEPALIVE const char *tw_result() {
    return g_result.c_str();
}

}  // extern "C"
