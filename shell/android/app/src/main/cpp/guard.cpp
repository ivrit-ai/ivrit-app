// The calls into whisper.cpp and ggml that can throw, for turbo.c (which is C, so
// an exception through it would end the app): ggml-vulkan throws vk::SystemError
// when the phone's driver fails, as the Galaxy S25's did building a shader.
// Each returns as failing instead, with what was thrown in `error`.

#include <cstdio>
#include <exception>

#include "ggml-backend.h"
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

// whisper_full's result, or -100 when it threw.
extern "C" int guarded_full(struct whisper_context *ctx, struct whisper_full_params params, const float *samples, int n,
                            char *error, size_t size) {
    try {
        return whisper_full(ctx, params, samples, n);
    } catch (const std::exception &e) {
        say(error, size, e.what());
    } catch (...) {
        say(error, size, "unknown exception");
    }
    return -100;
}

// The first GPU ggml can start, as whisper.cpp starts it (whisper_backend_init_gpu),
// or null: none, or (with `error` set) starting it threw.
extern "C" const char *guarded_gpu(char *error, size_t size) {
    try {
        for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
            ggml_backend_dev_t dev = ggml_backend_dev_get(i);
            enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
            if (type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU) continue;
            ggml_backend_t backend = ggml_backend_dev_init(dev, nullptr);
            if (!backend) return nullptr;
            ggml_backend_free(backend);
            return ggml_backend_dev_description(dev);
        }
    } catch (const std::exception &e) {
        say(error, size, e.what());
    } catch (...) {
        say(error, size, "unknown exception");
    }
    return nullptr;
}
