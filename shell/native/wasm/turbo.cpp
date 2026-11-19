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

namespace {

constexpr int RATE = WHISPER_SAMPLE_RATE;
constexpr double PIECE_SECONDS = 600;  // Turbo.CHUNK_SECONDS
constexpr int BEAMS = 5;               // Turbo.GPU_BEAMS: the server's beam size

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
        setenv("GGML_WEBGPU_MOBILE", "1", 1);
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

// The speaker model; without it, the transcript has no speakers. 0 when it loaded.
EMSCRIPTEN_KEEPALIVE int tw_load_speakers(const char *path) {
    if (g_speakers) sp_free(g_speakers);
    g_speakers = sp_load(path, 1);
    if (!g_speakers) g_error = "the speaker model did not load";
    return g_speakers ? 0 : -1;
}

// Stops a transcription under way (tw_transcribe returns -2).
EMSCRIPTEN_KEEPALIVE void tw_stop() {
    g_stop = true;
}

// The transcript of n samples of 16 kHz mono sound: 0, with the JSON in tw_result();
// -2 when stopped, -1 when it failed (tw_error()).
EMSCRIPTEN_KEEPALIVE int tw_transcribe(const float *pcm, size_t n) {
    if (!g_ctx) {
        g_error = "no model";
        return -1;
    }
    g_stop = false;
    g_result.clear();
    try {
        whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
        params.beam_search.beam_size = BEAMS;
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
