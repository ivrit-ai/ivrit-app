#include "gpubench.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <vector>

#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"

double gb_time(int what, int K, int M, int N, int reps, double *error) {
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
            auto t0 = std::chrono::steady_clock::now();
            for (int i = 0; i < times; i++) ggml_backend_graph_compute(be, gf);
            ggml_backend_tensor_get(out, result.data(), 0, result.size() * sizeof(float));
            *ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / (times > 0 ? times : 1);
        }
        ggml_backend_buffer_free(buf);
        ggml_free(ctx);
        return result;
    };
    ggml_backend_dev_t dev = ggml_backend_dev_by_name("WebGPU");
    if (!dev) throw std::runtime_error("no WebGPU device");
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
    *error = top > 0 ? err / top : err;
    return ms;
}
