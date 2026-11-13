// Whisper.java's native half: whisper.cpp on the phone's CPU, or its GPU through
// Vulkan, one recording's sound at a time, back as its text tokens with their
// times. Kept thin: grouping tokens into words and sentences happens in Java
// (TurboWords), and choosing the GPU too (TurboGpu), where they are tested.

#include <android/log.h>
#include <fcntl.h>
#include <jni.h>
#include <stdio.h>
#include <unistd.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "ggml-backend.h"
#include "whisper.h"

#define TAG "IvritTurbo"

// guard.cpp: the same calls, with what they throw caught.
struct whisper_context *guarded_init(const char *path, struct whisper_context_params params, char *error, size_t size);
int guarded_full(struct whisper_context *ctx, struct whisper_full_params params, const float *samples, int n, char *error, size_t size);
const char *guarded_gpu(char *error, size_t size);

static void throw_state(JNIEnv *env, const char *message) {
    (*env)->ThrowNew(env, (*env)->FindClass(env, "java/lang/IllegalStateException"), message);
}

typedef struct {
    struct whisper_context *ctx;
    atomic_bool stop;  // set by Whisper.stop from another thread
} turbo;

typedef struct {
    JNIEnv *env;
    jobject listener;
    jmethodID progress;
} progress_sink;

static bool logging = false;  // everything to stderr, once Whisper.logTo pointed it at a file

static void on_log(enum ggml_log_level level, const char *text, void *user) {
    (void) user;
    if (logging) fputs(text, stderr);
    if (level == GGML_LOG_LEVEL_ERROR) __android_log_write(ANDROID_LOG_ERROR, TAG, text);
    else if (level == GGML_LOG_LEVEL_WARN) __android_log_write(ANDROID_LOG_WARN, TAG, text);
}

// stderr (where ggml-vulkan writes its errors, and GGML_ABORT its last words) and
// whisper.cpp's and ggml's whole log, into a file from here on, unbuffered: what a
// crash leaves behind is read the next time (TurboGpu).
JNIEXPORT void JNICALL Java_ai_ivrit_app_Whisper_logTo(JNIEnv *env, jclass cls, jstring path) {
    (void) cls;
    const char *file = (*env)->GetStringUTFChars(env, path, NULL);
    int fd = open(file, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    (*env)->ReleaseStringUTFChars(env, path, file);
    if (fd < 0) return;
    dup2(fd, STDERR_FILENO);
    close(fd);
    setvbuf(stderr, NULL, _IONBF, 0);
    logging = true;
    whisper_log_set(on_log, NULL);
    ggml_log_set(on_log, NULL);
}

static bool aborted(void *data) {
    return atomic_load(&((turbo *) data)->stop);
}

static bool encoder_begins(struct whisper_context *ctx, struct whisper_state *state, void *data) {
    (void) ctx;
    (void) state;
    return !aborted(data);
}

// Called on the thread that runs whisper_full, which is the Java caller's.
static void progressed(struct whisper_context *ctx, struct whisper_state *state, int percent, void *data) {
    (void) ctx;
    (void) state;
    progress_sink *sink = data;
    if (!sink->listener) return;
    (*sink->env)->CallVoidMethod(sink->env, sink->listener, sink->progress, (jint) percent);
    if ((*sink->env)->ExceptionCheck(sink->env)) (*sink->env)->ExceptionClear(sink->env);
}

// The GPU whisper.cpp would use ("Adreno (TM) 720"…), once it is known to start,
// or null: no Vulkan device ggml can work with. Throws when starting it threw.
JNIEXPORT jstring JNICALL Java_ai_ivrit_app_Whisper_gpu(JNIEnv *env, jclass cls) {
    (void) cls;
    ggml_log_set(on_log, NULL);
    char error[512] = "";
    const char *name = guarded_gpu(error, sizeof error);
    if (error[0]) {
        throw_state(env, error);
        return NULL;
    }
    return name ? (*env)->NewStringUTF(env, name) : NULL;
}

JNIEXPORT jlong JNICALL Java_ai_ivrit_app_Whisper_load(JNIEnv *env, jclass cls, jstring path, jboolean gpu, jboolean flash) {
    (void) cls;
    whisper_log_set(on_log, NULL);
    struct whisper_context_params params = whisper_context_default_params();
    params.use_gpu = gpu == JNI_TRUE;
    params.flash_attn = flash == JNI_TRUE;
    const char *file = (*env)->GetStringUTFChars(env, path, NULL);
    char error[512] = "";
    struct whisper_context *ctx = guarded_init(file, params, error, sizeof error);
    (*env)->ReleaseStringUTFChars(env, path, file);
    if (error[0]) {
        throw_state(env, error);
        return 0;
    }
    if (!ctx) return 0;
    turbo *t = calloc(1, sizeof *t);
    if (!t) {
        whisper_free(ctx);
        return 0;
    }
    t->ctx = ctx;
    atomic_init(&t->stop, false);
    return (jlong) (intptr_t) t;
}

JNIEXPORT void JNICALL Java_ai_ivrit_app_Whisper_free(JNIEnv *env, jclass cls, jlong handle) {
    (void) env;
    (void) cls;
    turbo *t = (turbo *) (intptr_t) handle;
    if (!t) return;
    whisper_free(t->ctx);
    free(t);
}

JNIEXPORT void JNICALL Java_ai_ivrit_app_Whisper_stop(JNIEnv *env, jclass cls, jlong handle) {
    (void) env;
    (void) cls;
    turbo *t = (turbo *) (intptr_t) handle;
    if (t) atomic_store(&t->stop, true);
}

JNIEXPORT jstring JNICALL Java_ai_ivrit_app_Whisper_system(JNIEnv *env, jclass cls) {
    (void) cls;
    return (*env)->NewStringUTF(env, whisper_print_system_info());
}

// {byte[] text, int[] ends, int[] times, int[] segments}: the text tokens' bytes one
// after another (UTF-8, but a token may end inside a letter), where each token's
// bytes end, each token's start and end (centiseconds, two ints a token), and each
// segment's start, end and the token it ends before (three ints a segment). Null
// when stopped; throws when whisper.cpp fails, with what it threw if it did.
JNIEXPORT jobjectArray JNICALL Java_ai_ivrit_app_Whisper_transcribe(
        JNIEnv *env, jclass cls, jlong handle, jfloatArray pcm, jstring language, jint threads, jint beams, jobject listener) {
    (void) cls;
    turbo *t = (turbo *) (intptr_t) handle;
    atomic_store(&t->stop, false);

    struct whisper_full_params params =
        whisper_full_default_params(beams > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
    if (beams > 1) params.beam_search.beam_size = beams;
    params.n_threads = threads;
    params.token_timestamps = true;
    params.suppress_nst = true;
    params.print_progress = false;
    params.print_timestamps = false;
    progress_sink sink = {env, listener, NULL};
    if (listener) {
        jclass type = (*env)->GetObjectClass(env, listener);
        sink.progress = (*env)->GetMethodID(env, type, "progress", "(I)V");
        if (!sink.progress) return NULL;  // NoSuchMethodError is pending
    }
    params.progress_callback = progressed;
    params.progress_callback_user_data = &sink;
    params.encoder_begin_callback = encoder_begins;
    params.encoder_begin_callback_user_data = t;
    params.abort_callback = aborted;
    params.abort_callback_user_data = t;

    const char *lang = (*env)->GetStringUTFChars(env, language, NULL);
    params.language = lang;
    jsize n = (*env)->GetArrayLength(env, pcm);
    jfloat *samples = (*env)->GetFloatArrayElements(env, pcm, NULL);
    char error[512] = "";
    int failed = guarded_full(t->ctx, params, samples, n, error, sizeof error);
    (*env)->ReleaseFloatArrayElements(env, pcm, samples, JNI_ABORT);
    (*env)->ReleaseStringUTFChars(env, language, lang);
    if (atomic_load(&t->stop)) return NULL;
    if (failed) {
        throw_state(env, error[0] ? error : "whisper_full failed");
        return NULL;
    }

    struct whisper_context *ctx = t->ctx;
    const whisper_token eot = whisper_token_eot(ctx);
    const int n_segments = whisper_full_n_segments(ctx);
    int n_tokens = 0;
    size_t n_bytes = 0;
    for (int s = 0; s < n_segments; s++) {
        for (int j = 0; j < whisper_full_n_tokens(ctx, s); j++) {
            if (whisper_full_get_token_id(ctx, s, j) >= eot) continue;  // special and timestamp tokens
            n_tokens++;
            n_bytes += strlen(whisper_full_get_token_text(ctx, s, j));
        }
    }
    jbyte *text = malloc(n_bytes ? n_bytes : 1);
    jint *ends = malloc(sizeof(jint) * (n_tokens ? n_tokens : 1));
    jint *times = malloc(sizeof(jint) * 2 * (n_tokens ? n_tokens : 1));
    jint *segments = malloc(sizeof(jint) * 3 * (n_segments ? n_segments : 1));
    if (!text || !ends || !times || !segments) {
        free(text);
        free(ends);
        free(times);
        free(segments);
        jclass error = (*env)->FindClass(env, "java/lang/OutOfMemoryError");
        (*env)->ThrowNew(env, error, "transcript");
        return NULL;
    }
    int k = 0;
    size_t at = 0;
    for (int s = 0; s < n_segments; s++) {
        for (int j = 0; j < whisper_full_n_tokens(ctx, s); j++) {
            if (whisper_full_get_token_id(ctx, s, j) >= eot) continue;
            const char *piece = whisper_full_get_token_text(ctx, s, j);
            size_t len = strlen(piece);
            memcpy(text + at, piece, len);
            at += len;
            ends[k] = (jint) at;
            whisper_token_data data = whisper_full_get_token_data(ctx, s, j);
            times[2 * k] = (jint) data.t0;
            times[2 * k + 1] = (jint) data.t1;
            k++;
        }
        segments[3 * s] = (jint) whisper_full_get_segment_t0(ctx, s);
        segments[3 * s + 1] = (jint) whisper_full_get_segment_t1(ctx, s);
        segments[3 * s + 2] = k;
    }

    jbyteArray text_out = (*env)->NewByteArray(env, (jsize) n_bytes);
    jintArray ends_out = (*env)->NewIntArray(env, n_tokens);
    jintArray times_out = (*env)->NewIntArray(env, 2 * n_tokens);
    jintArray segments_out = (*env)->NewIntArray(env, 3 * n_segments);
    jobjectArray out = NULL;
    if (text_out && ends_out && times_out && segments_out) {
        (*env)->SetByteArrayRegion(env, text_out, 0, (jsize) n_bytes, text);
        (*env)->SetIntArrayRegion(env, ends_out, 0, n_tokens, ends);
        (*env)->SetIntArrayRegion(env, times_out, 0, 2 * n_tokens, times);
        (*env)->SetIntArrayRegion(env, segments_out, 0, 3 * n_segments, segments);
        out = (*env)->NewObjectArray(env, 4, (*env)->FindClass(env, "java/lang/Object"), NULL);
        if (out) {
            (*env)->SetObjectArrayElement(env, out, 0, text_out);
            (*env)->SetObjectArrayElement(env, out, 1, ends_out);
            (*env)->SetObjectArrayElement(env, out, 2, times_out);
            (*env)->SetObjectArrayElement(env, out, 3, segments_out);
        }
    }
    free(text);
    free(ends);
    free(times);
    free(segments);
    return out;
}
