// The calls into whisper.cpp and ggml that can throw, for turbo.c (which is C, so
// an exception through it would end the app): ggml-vulkan throws vk::SystemError
// when the phone's driver fails, as the Galaxy S25's did building a shader.
// Each returns as failing instead, with what was thrown in `error`.

#include <cstdio>
#include <exception>

#include "ggml-backend.h"
#include "transcript.h"
#include "whisper.h"

static void say(char *error, size_t size, const char *what) {
    snprintf(error, size, "%s", what);
}

extern "C" struct whisper_context *guarded_init(const char *path, struct whisper_context_params params, char *error, size_t size) {
    try {
        return whisper_init_from_file_with_params(path, params);
    } catch (const std::exception &e) {
        say(error, size, e.what());
    } catch (...) {
        say(error, size, "unknown exception");
    }
    return nullptr;
}

// tr_piece_make's result (its windows through whisper_full), or -100 when it threw.
extern "C" int guarded_piece(struct whisper_context *ctx, struct whisper_full_params params, const float *pcm, size_t n,
                             double offset, bool last, tr_state *state, tr_piece *out, char *error, size_t size) {
    try {
        return tr_piece_make(ctx, params, pcm, n, offset, last, state, out);
    } catch (const std::exception &e) {
        say(error, size, e.what());
    } catch (...) {
        say(error, size, "unknown exception");
    }
    return -100;
}

// ggml's GPU devices, in whisper.cpp's order (its gpu_device): at most `max` names
// ("Vulkan0", "WebGPU"…) and descriptions; how many there are. Starts none of them.
extern "C" size_t guarded_gpus(const char **names, const char **descriptions, size_t max, char *error, size_t size) {
    size_t n = 0;
    try {
        for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
            ggml_backend_dev_t dev = ggml_backend_dev_get(i);
            enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
            if (type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU) continue;
            if (n < max) {
                names[n] = ggml_backend_dev_name(dev);
                descriptions[n] = ggml_backend_dev_description(dev);
            }
            n++;
        }
    } catch (const std::exception &e) {
        say(error, size, e.what());
    } catch (...) {
        say(error, size, "unknown exception");
    }
    return n;
}

// GPU device `index` (of guarded_gpus) started, as whisper.cpp starts it, and let go:
// false when it would not (with `error` set if starting it threw).
extern "C" bool guarded_probe(int index, char *error, size_t size) {
    try {
        int n = 0;
        for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
            ggml_backend_dev_t dev = ggml_backend_dev_get(i);
            enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
            if (type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU) continue;
            if (n++ != index) continue;
            ggml_backend_t backend = ggml_backend_dev_init(dev, nullptr);
            if (!backend) return false;
            ggml_backend_free(backend);
            return true;
        }
    } catch (const std::exception &e) {
        say(error, size, e.what());
    } catch (...) {
        say(error, size, "unknown exception");
    }
    return false;
}
