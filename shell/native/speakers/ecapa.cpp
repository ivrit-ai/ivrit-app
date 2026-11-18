// SpeechBrain's ECAPA_TDNN (lobes/models/ECAPA_TDNN.py) on ggml, with the weights
// scripts/speaker_model.py writes, for one segment's features at a time. Tensors
// are [channels, frames] (channels fastest). A convolution is a matrix product per
// tap, over the frames padded by reflection (SpeechBrain's Conv1d pads "same" that
// way); batch norm is the scale and shift it folds into.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"
#include "speakers.h"

struct sp_model {
    ggml_context *weights = nullptr;
    ggml_backend_t backend = nullptr;
    ggml_backend_buffer_t buffer = nullptr;
    ggml_gallocr_t alloc = nullptr;
    std::map<std::string, ggml_tensor *> tensors;
    int threads = 1;
};

static const int CHANNELS = 1024, SCALE = 8, MFA = 3072, ATTENTION = 128;
static const float STAT_EPS = 1e-12f;

void sp_free(sp_model *m) {
    if (!m) return;
    if (m->alloc) ggml_gallocr_free(m->alloc);
    if (m->buffer) ggml_backend_buffer_free(m->buffer);
    if (m->weights) ggml_free(m->weights);
    if (m->backend) ggml_backend_free(m->backend);
    delete m;
}

sp_model *sp_load(const char *path, int threads) {
    FILE *f = fopen(path, "rb");
    if (!f) return nullptr;
    struct entry {
        std::string name;
        uint32_t type;
        std::vector<int64_t> ne;
        long at;
        size_t bytes;
    };
    std::vector<entry> entries;
    char magic[4];
    uint32_t version = 0, count = 0;
    bool ok = fread(magic, 1, 4, f) == 4 && memcmp(magic, "IVSP", 4) == 0 && fread(&version, 4, 1, f) == 1 && version == 1
        && fread(&count, 4, 1, f) == 1;
    for (uint32_t i = 0; ok && i < count; i++) {
        entry e;
        uint32_t len = 0, dims = 0;
        ok = fread(&len, 4, 1, f) == 1 && len < 256;
        if (!ok) break;
        e.name.resize(len);
        ok = fread(&e.name[0], 1, len, f) == len && fread(&e.type, 4, 1, f) == 1 && fread(&dims, 4, 1, f) == 1 && dims <= 4;
        for (uint32_t d = 0; ok && d < dims; d++) {
            uint32_t v = 0;
            ok = fread(&v, 4, 1, f) == 1;
            e.ne.push_back(v);
        }
        if (!ok || (e.type != GGML_TYPE_F32 && e.type != GGML_TYPE_F16 && e.type != GGML_TYPE_Q8_0)) {
            ok = false;
            break;
        }
        int64_t elements = 1;
        for (int64_t v : e.ne) elements *= v;
        e.bytes = ggml_row_size((ggml_type) e.type, elements);
        e.at = ftell(f);
        ok = fseek(f, (long) e.bytes, SEEK_CUR) == 0;
        entries.push_back(e);
    }
    if (!ok) {
        fclose(f);
        return nullptr;
    }
    sp_model *m = new sp_model();
    m->threads = threads > 0 ? threads : 1;
    ggml_init_params params = {ggml_tensor_overhead() * (entries.size() + 1), nullptr, true};
    m->weights = ggml_init(params);
    m->backend = ggml_backend_cpu_init();
    if (!m->weights || !m->backend) {
        fclose(f);
        sp_free(m);
        return nullptr;
    }
    ggml_backend_cpu_set_n_threads(m->backend, m->threads);
    for (const entry &e : entries) {
        ggml_tensor *t = ggml_new_tensor(m->weights, (ggml_type) e.type, (int) e.ne.size(), e.ne.data());
        ggml_set_name(t, e.name.c_str());
        m->tensors[e.name] = t;
    }
    m->buffer = ggml_backend_alloc_ctx_tensors(m->weights, m->backend);
    std::vector<char> data;
    for (const entry &e : entries) {
        data.resize(e.bytes);
        if (!m->buffer || fseek(f, e.at, SEEK_SET) != 0 || fread(data.data(), 1, e.bytes, f) != e.bytes) {
            fclose(f);
            sp_free(m);
            return nullptr;
        }
        ggml_backend_tensor_set(m->tensors[e.name], data.data(), 0, e.bytes);
    }
    fclose(f);
    m->alloc = ggml_gallocr_new(ggml_backend_get_default_buffer_type(m->backend));
    return m;
}

namespace {

// One forward pass's graph, and the reflection indices it pads with.
struct builder {
    sp_model *m;
    ggml_context *ctx;
    int frames;
    std::map<int, ggml_tensor *> reflect;  // pad -> indices, set once allocated

    ggml_tensor *w(const std::string &name) {
        auto it = m->tensors.find(name);
        if (it == m->tensors.end()) {
            fprintf(stderr, "speakers: no %s in the model\n", name.c_str());
            abort();
        }
        return it->second;
    }

    // Conv1d, stride 1, dilation d, "same" with reflection: [in, T] -> [out, T].
    ggml_tensor *conv(ggml_tensor *x, const std::string &name, int dilation) {
        ggml_tensor *weight = w(name + ".w");  // [in, out, taps]
        const int64_t in = weight->ne[0], out = weight->ne[1], taps = weight->ne[2];
        ggml_tensor *y = nullptr;
        if (taps == 1) {
            y = ggml_mul_mat(ctx, ggml_view_2d(ctx, weight, in, out, weight->nb[1], 0), x);
        } else {
            const int pad = dilation * (int) (taps - 1) / 2;
            ggml_tensor *&idx = reflect[pad];
            if (!idx) {
                idx = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, frames + 2 * pad);
                ggml_set_input(idx);
            }
            ggml_tensor *padded = ggml_get_rows(ctx, x, idx);  // [in, T + 2 pad]
            for (int64_t k = 0; k < taps; k++) {
                ggml_tensor *tap = ggml_view_2d(ctx, weight, in, out, weight->nb[1], k * weight->nb[2]);
                ggml_tensor *shifted = ggml_view_2d(ctx, padded, in, frames, padded->nb[1], k * dilation * padded->nb[1]);
                ggml_tensor *part = ggml_mul_mat(ctx, tap, shifted);
                y = y ? ggml_add(ctx, y, part) : part;
            }
        }
        return ggml_add(ctx, y, w(name + ".b"));
    }

    ggml_tensor *norm(ggml_tensor *x, const std::string &name) {
        return ggml_add(ctx, ggml_mul(ctx, x, w(name + ".scale")), w(name + ".shift"));
    }

    // TDNNBlock: conv, ReLU, batch norm.
    ggml_tensor *tdnn(ggml_tensor *x, const std::string &name, int dilation) {
        return norm(ggml_relu(ctx, conv(x, name + ".conv", dilation)), name + ".norm");
    }

    // [C, T] -> [T, C], each channel's frames together.
    ggml_tensor *by_channel(ggml_tensor *x) {
        return ggml_cont(ctx, ggml_transpose(ctx, x));
    }

    // Res2NetBlock: eight slices, each after the first through a TDNN with the
    // previous one's output added.
    ggml_tensor *res2net(ggml_tensor *x, const std::string &name, int dilation) {
        const int64_t width = CHANNELS / SCALE;
        ggml_tensor *out = nullptr, *prev = nullptr;
        for (int i = 0; i < SCALE; i++) {
            ggml_tensor *xi = ggml_cont(ctx, ggml_view_2d(ctx, x, width, frames, x->nb[1], i * width * ggml_element_size(x)));
            ggml_tensor *yi = i == 0 ? xi : tdnn(i == 1 ? xi : ggml_add(ctx, xi, prev), name + "." + std::to_string(i - 1), dilation);
            out = out ? ggml_concat(ctx, out, yi, 0) : yi;
            prev = yi;
        }
        return out;
    }

    // SEBlock: the channels' means through two 1x1 convolutions, a gate on each.
    ggml_tensor *se(ggml_tensor *x, const std::string &name) {
        ggml_tensor *s = ggml_reshape_2d(ctx, ggml_mean(ctx, by_channel(x)), x->ne[0], 1);
        s = ggml_relu(ctx, conv(s, name + ".se1", 1));
        s = ggml_sigmoid(ctx, conv(s, name + ".se2", 1));
        return ggml_mul(ctx, x, s);
    }

    ggml_tensor *block(ggml_tensor *x, const std::string &name, int dilation) {
        ggml_tensor *y = tdnn(x, name + ".tdnn1", 1);
        y = res2net(y, name + ".res2net", dilation);
        y = tdnn(y, name + ".tdnn2", 1);
        y = se(y, name);
        return ggml_add(ctx, y, x);
    }

    // AttentiveStatisticsPooling (global context): [C, T] -> [2C]. Statistics of
    // [T, C] tensors, a channel's frames being a row.
    ggml_tensor *pool(ggml_tensor *x) {
        ggml_tensor *xt = by_channel(x);
        ggml_tensor *mean = ggml_mean(ctx, xt);  // [1, C]
        ggml_tensor *std_ = ggml_sqrt(ctx, ggml_clamp(ctx, ggml_mean(ctx, ggml_sqr(ctx, ggml_sub(ctx, xt, mean))), STAT_EPS, INFINITY));
        ggml_tensor *mean_c = ggml_repeat(ctx, ggml_reshape_2d(ctx, mean, x->ne[0], 1), x);
        ggml_tensor *std_c = ggml_repeat(ctx, ggml_reshape_2d(ctx, std_, x->ne[0], 1), x);
        ggml_tensor *attn = ggml_concat(ctx, ggml_concat(ctx, x, mean_c, 0), std_c, 0);
        attn = ggml_tanh(ctx, tdnn(attn, "asp.tdnn", 1));
        attn = conv(attn, "asp.conv", 1);                        // [C, T]
        ggml_tensor *weights = ggml_soft_max(ctx, by_channel(attn));  // over the frames
        ggml_tensor *wmean = ggml_sum_rows(ctx, ggml_mul(ctx, weights, xt));
        ggml_tensor *wvar = ggml_sum_rows(ctx, ggml_mul(ctx, weights, ggml_sqr(ctx, ggml_sub(ctx, xt, wmean))));
        ggml_tensor *wstd = ggml_sqrt(ctx, ggml_clamp(ctx, wvar, STAT_EPS, INFINITY));
        ggml_tensor *pooled = ggml_concat(ctx, ggml_reshape_2d(ctx, wmean, x->ne[0], 1), ggml_reshape_2d(ctx, wstd, x->ne[0], 1), 0);
        return pooled;  // [2C, 1]
    }

    ggml_tensor *forward(ggml_tensor *feats) {
        ggml_tensor *x = tdnn(feats, "blocks.0", 1);
        ggml_tensor *x1 = block(x, "blocks.1", 2);
        ggml_tensor *x2 = block(x1, "blocks.2", 3);
        ggml_tensor *x3 = block(x2, "blocks.3", 4);
        ggml_tensor *y = tdnn(ggml_concat(ctx, ggml_concat(ctx, x1, x2, 0), x3, 0), "mfa", 1);
        y = norm(pool(y), "asp_bn");
        return conv(y, "fc", 1);  // [192, 1]
    }
};

}  // namespace

bool sp_embed(sp_model *m, const float *pcm, size_t n, float out[SP_DIM]) {
    size_t frames = 0;
    float *feats = sp_features(pcm, n, &frames);
    if (!feats) return false;
    // A tap reaches 4 frames each way (dilation 4): reflection needs more than that.
    if (frames < 5) {
        free(feats);
        return false;
    }
    size_t nodes = 2048;
    ggml_init_params params = {ggml_tensor_overhead() * nodes + ggml_graph_overhead_custom(nodes, false), nullptr, true};
    ggml_context *ctx = ggml_init(params);
    if (!ctx) {
        free(feats);
        return false;
    }
    builder b{m, ctx, (int) frames, {}};
    ggml_tensor *input = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, 80, (int64_t) frames);
    ggml_set_input(input);
    ggml_tensor *embedding = b.forward(input);
    ggml_set_output(embedding);
    ggml_cgraph *graph = ggml_new_graph_custom(ctx, nodes, false);
    ggml_build_forward_expand(graph, embedding);
    bool ok = ggml_gallocr_alloc_graph(m->alloc, graph);
    if (ok) {
        ggml_backend_tensor_set(input, feats, 0, frames * 80 * sizeof(float));
        for (auto &[pad, idx] : b.reflect) {
            std::vector<int32_t> v(frames + 2 * pad);
            for (size_t j = 0; j < v.size(); j++) {
                long t = (long) j - pad;
                if (t < 0) t = -t;
                if (t >= (long) frames) t = 2 * ((long) frames - 1) - t;
                v[j] = (int32_t) t;
            }
            ggml_backend_tensor_set(idx, v.data(), 0, v.size() * sizeof(int32_t));
        }
        ok = ggml_backend_graph_compute(m->backend, graph) == GGML_STATUS_SUCCESS;
        if (ok) ggml_backend_tensor_get(embedding, out, 0, SP_DIM * sizeof(float));
    }
    ggml_free(ctx);
    free(feats);
    return ok;
}

bool sp_segment_sound(double start, double end, double offset, size_t n, size_t *from, size_t *to) {
    // _extract_segment_audio: a segment under 0.1 s widened by 50 ms each side.
    double total = offset + (double) n / SP_SAMPLE_RATE;
    if (end - start < 0.1) {
        start = start - 0.05 > 0 ? start - 0.05 : 0;
        end = end + 0.05 < total ? end + 0.05 : total;
    }
    bool enough = end - start >= 0.05;
    long base = lround(offset * SP_SAMPLE_RATE);
    long a = (long) (start * SP_SAMPLE_RATE) - base, b = (long) (end * SP_SAMPLE_RATE) - base;
    if (a < 0) a = 0;
    if (b > (long) n) b = (long) n;
    if (b < a) b = a;
    *from = (size_t) a;
    *to = (size_t) b;
    return enough && b > a;
}
