// Whisper.java's native half: whisper.cpp on the phone's CPU, or its GPU, a piece
// of a recording at a time, back as the server would make its transcript:
// faster-whisper's words from whisper.cpp's DTW times, then stable-ts's silence
// snapping and regrouping (shell/native/transcript, tested against both there).
// Choosing the GPU happens in Java (TurboGpu), where it is tested.

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
#include "transcript.h"
#include "whisper.h"

#define TAG "IvritTurbo"

// guard.cpp: the same calls, with what they throw caught.
struct whisper_context *guarded_init(const char *path, struct whisper_context_params params, char *error, size_t size);
int guarded_tune(struct whisper_context *ctx, const float *pcm, size_t n, int threads, char *error, size_t size);
int guarded_piece(struct whisper_context *ctx, struct whisper_full_params params, const float *pcm, size_t n, double offset,
                  bool last, tr_state *state, tr_piece *out, char *error, size_t size);
size_t guarded_gpus(const char **names, const char **descriptions, size_t max, char *error, size_t size);
bool guarded_probe(int index, char *error, size_t size);
double guarded_bench(int what, int k, int m, int n, int reps, double *diff, char *error, size_t size);

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
    // Not the CPU's line per weight repacked: they would fill the report's tail.
    if (logging && strncmp(text, "repack: ", 8) != 0) fputs(text, stderr);
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

#define MAX_GPUS 8

// ggml's GPU devices as "<name>: <description>" ("Vulkan0: Adreno (TM) 830"), in
// whisper.cpp's order, none started. Throws when listing them threw.
JNIEXPORT jobjectArray JNICALL Java_ai_ivrit_app_Whisper_gpus(JNIEnv *env, jclass cls) {
    (void) cls;
    ggml_log_set(on_log, NULL);
    const char *names[MAX_GPUS];
    const char *descriptions[MAX_GPUS];
    char error[512] = "";
    size_t n = guarded_gpus(names, descriptions, MAX_GPUS, error, sizeof error);
    if (error[0]) {
        throw_state(env, error);
        return NULL;
    }
    if (n > MAX_GPUS) n = MAX_GPUS;
    jobjectArray out = (*env)->NewObjectArray(env, (jsize) n, (*env)->FindClass(env, "java/lang/String"), NULL);
    for (size_t i = 0; out && i < n; i++) {
        char line[512];
        snprintf(line, sizeof line, "%s: %s", names[i], descriptions[i]);
        (*env)->SetObjectArrayElement(env, out, (jsize) i, (*env)->NewStringUTF(env, line));
    }
    return out;
}

// One GPU program timed against the CPU (shell/native/gpubench): "<ms> <error>". Throws where the GPU failed.
JNIEXPORT jstring JNICALL Java_ai_ivrit_app_Whisper_bench(JNIEnv *env, jclass cls, jint what, jint k, jint m, jint n, jint reps) {
    (void) cls;
    ggml_log_set(on_log, NULL);
    char error[512] = "";
    double diff = 0;
    double ms = guarded_bench(what, k, m, n, reps, &diff, error, sizeof error);
    if (ms < 0) {
        throw_state(env, error[0] ? error : "failed");
        return NULL;
    }
    char line[64];
    snprintf(line, sizeof line, "%.3f %.3g", ms, diff);
    return (*env)->NewStringUTF(env, line);
}

// GPU device `index` started and let go: its description. Throws when it would not start.
JNIEXPORT jstring JNICALL Java_ai_ivrit_app_Whisper_probe(JNIEnv *env, jclass cls, jint index) {
    (void) cls;
    ggml_log_set(on_log, NULL);
    char error[512] = "";
    if (!guarded_probe(index, error, sizeof error)) {
        throw_state(env, error[0] ? error : "the GPU did not start");
        return NULL;
    }
    const char *names[MAX_GPUS];
    const char *descriptions[MAX_GPUS];
    size_t n = guarded_gpus(names, descriptions, MAX_GPUS, error, sizeof error);
    return (*env)->NewStringUTF(env, index >= 0 && (size_t) index < n && index < MAX_GPUS ? descriptions[index] : "");
}

// decoderCpu: on a GPU device, the decoder on the CPU all the same (its weights and
// caches there), the encoder on the GPU.
JNIEXPORT jlong JNICALL Java_ai_ivrit_app_Whisper_load(JNIEnv *env, jclass cls, jstring path, jint device, jboolean flash,
                                                       jboolean decoderCpu) {
    (void) cls;
    whisper_log_set(on_log, NULL);
    struct whisper_context_params params = whisper_context_default_params();
    params.use_gpu = device >= 0;
    params.gpu_device = device >= 0 ? device : 0;
    params.flash_attn = flash == JNI_TRUE;
    params.ivrit_decoder_cpu = device >= 0 && decoderCpu == JNI_TRUE;
    tr_context_params(&params);
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
    whisper_print_timings(t->ctx); // to the log (logTo): where the run's time went
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

// {byte[] text, int[] ends, double[] times, int[] segments}: the piece's words, as
// the transcript (transcript.h) has them: their bytes one after another (UTF-8,
// each word whole, " word," with its leading space), where each word's bytes end,
// each word's start and end (seconds into the file, two a word), and how many words
// each segment has. `offset`: where in the file the sound starts; `last`: nothing
// comes after it. state: {the speech's end so far, the transcript's end so far,
// where the next piece starts, the file's sample count and level (levelEnd; 0: not
// known), where its sound starts}, all but the third read and the first three
// written; prompt:
// {how many, then the tokens} of the previous text faster-whisper prompts with
// (TR_PROMPT at most), read and written. Null when stopped; throws when whisper.cpp
// fails, with what it threw if it did.
JNIEXPORT jobjectArray JNICALL Java_ai_ivrit_app_Whisper_transcribe(
        JNIEnv *env, jclass cls, jlong handle, jfloatArray pcm, jstring language, jint threads, jint decodeThreads, jint beams,
        jobject listener, jdouble offset, jboolean last, jdoubleArray state, jintArray prompt) {
    (void) cls;
    turbo *t = (turbo *) (intptr_t) handle;
    atomic_store(&t->stop, false);

    struct whisper_full_params params =
        whisper_full_default_params(beams > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
    if (beams > 1) params.beam_search.beam_size = beams;
    params.n_threads = threads;
    params.ivrit_decode_threads = decodeThreads > 0 ? decodeThreads : 0;
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

    tr_state kept = {0};
    jdouble times[6];
    (*env)->GetDoubleArrayRegion(env, state, 0, 6, times);
    kept.last_speech = times[0];
    kept.after = times[1];
    kept.total = times[3] > 0 ? (size_t) times[3] : 0;
    kept.level = (float) times[4];
    kept.origin = times[5];
    jint saved[TR_PROMPT + 1];
    (*env)->GetIntArrayRegion(env, prompt, 0, TR_PROMPT + 1, saved);
    kept.n_prompt = saved[0] < 0 ? 0 : saved[0] > TR_PROMPT ? TR_PROMPT : saved[0];
    for (int i = 0; i < kept.n_prompt; i++) kept.prompt[i] = saved[i + 1];

    const char *lang = (*env)->GetStringUTFChars(env, language, NULL);
    params.language = lang;
    jsize n = (*env)->GetArrayLength(env, pcm);
    jfloat *samples = (*env)->GetFloatArrayElements(env, pcm, NULL);
    char error[512] = "";
    tr_piece piece;
    int failed = guarded_piece(t->ctx, params, samples, (size_t) n, offset, last == JNI_TRUE, &kept, &piece, error, sizeof error);
    (*env)->ReleaseStringUTFChars(env, language, lang);
    (*env)->ReleaseFloatArrayElements(env, pcm, samples, JNI_ABORT);
    if (atomic_load(&t->stop) || failed) {
        if (!failed) st_free(piece.result);
        if (failed == TR_NO_MEMORY) (*env)->ThrowNew(env, (*env)->FindClass(env, "java/lang/OutOfMemoryError"), "transcript");
        else if (!atomic_load(&t->stop)) throw_state(env, error[0] ? error : "whisper_full failed");
        return NULL;
    }
    times[0] = kept.last_speech;
    times[1] = kept.after;
    times[2] = piece.next;
    (*env)->SetDoubleArrayRegion(env, state, 0, 3, times);
    saved[0] = kept.n_prompt;
    for (int i = 0; i < kept.n_prompt; i++) saved[i + 1] = kept.prompt[i];
    (*env)->SetIntArrayRegion(env, prompt, 0, TR_PROMPT + 1, saved);

    const size_t n_segments = st_segments(piece.result);
    size_t n_words = 0, n_bytes = 0;
    for (size_t s = 0; s < n_segments; s++) {
        size_t count;
        const st_word *w = st_segment(piece.result, s, &count);
        n_words += count;
        for (size_t i = 0; i < count; i++) n_bytes += strlen(w[i].text);
    }
    jbyteArray text_out = (*env)->NewByteArray(env, (jsize) n_bytes);
    jintArray ends_out = (*env)->NewIntArray(env, (jsize) n_words);
    jdoubleArray times_out = (*env)->NewDoubleArray(env, (jsize) (2 * n_words));
    jintArray segments_out = (*env)->NewIntArray(env, (jsize) n_segments);
    jobjectArray out = NULL;
    if (text_out && ends_out && times_out && segments_out) {
        jsize at = 0, k = 0;
        for (size_t s = 0; s < n_segments; s++) {
            size_t count;
            const st_word *w = st_segment(piece.result, s, &count);
            jint c = (jint) count;
            (*env)->SetIntArrayRegion(env, segments_out, (jsize) s, 1, &c);
            for (size_t i = 0; i < count; i++, k++) {
                jsize len = (jsize) strlen(w[i].text);
                (*env)->SetByteArrayRegion(env, text_out, at, len, (const jbyte *) w[i].text);
                at += len;
                jdouble times[2] = {w[i].start, w[i].end};
                (*env)->SetIntArrayRegion(env, ends_out, k, 1, &at);
                (*env)->SetDoubleArrayRegion(env, times_out, 2 * k, 2, times);
            }
        }
        out = (*env)->NewObjectArray(env, 4, (*env)->FindClass(env, "java/lang/Object"), NULL);
        if (out) {
            (*env)->SetObjectArrayElement(env, out, 0, text_out);
            (*env)->SetObjectArrayElement(env, out, 1, ends_out);
            (*env)->SetObjectArrayElement(env, out, 2, times_out);
            (*env)->SetObjectArrayElement(env, out, 3, segments_out);
        }
    }
    st_free(piece.result);
    return out;
}

// The whole file's loudness level, its sound added piece by piece (st_level):
// levelNew(about how many samples), levelAdd for each piece in order, then
// levelEnd: {the sample count, the level}, or null where it cannot be told; it frees.
JNIEXPORT jlong JNICALL Java_ai_ivrit_app_Whisper_levelNew(JNIEnv *env, jclass cls, jlong expected) {
    (void) env;
    (void) cls;
    return (jlong) (intptr_t) st_level_new(expected > 0 ? (size_t) expected : 0);
}

JNIEXPORT void JNICALL Java_ai_ivrit_app_Whisper_levelAdd(JNIEnv *env, jclass cls, jlong handle, jfloatArray pcm, jint n) {
    (void) cls;
    jfloat *samples = (*env)->GetFloatArrayElements(env, pcm, NULL);
    st_level_add((st_level *) (intptr_t) handle, samples, (size_t) n);
    (*env)->ReleaseFloatArrayElements(env, pcm, samples, JNI_ABORT);
}

JNIEXPORT jdoubleArray JNICALL Java_ai_ivrit_app_Whisper_levelEnd(JNIEnv *env, jclass cls, jlong handle) {
    (void) cls;
    size_t total;
    float level;
    if (!st_level_end((st_level *) (intptr_t) handle, &total, &level)) return NULL;
    jdoubleArray out = (*env)->NewDoubleArray(env, 2);
    if (!out) return NULL;
    jdouble values[2] = {(jdouble) total, (jdouble) level};
    (*env)->SetDoubleArrayRegion(env, out, 0, 2, values);
    return out;
}

// The decoder's fastest thread count here (tr_tune_decoder), from the sound's first
// window: 0 when it could not tell; throws when whisper.cpp threw.
JNIEXPORT jint JNICALL Java_ai_ivrit_app_Whisper_tuneDecoder(JNIEnv *env, jclass cls, jlong handle, jfloatArray pcm, jint n,
                                                            jint threads) {
    (void) cls;
    turbo *t = (turbo *) (intptr_t) handle;
    jfloat *samples = (*env)->GetFloatArrayElements(env, pcm, NULL);
    char error[512] = "";
    int best = guarded_tune(t->ctx, samples, (size_t) n, threads, error, sizeof error);
    (*env)->ReleaseFloatArrayElements(env, pcm, samples, JNI_ABORT);
    if (best < 0) {
        throw_state(env, error[0] ? error : "tuning failed");
        return 0;
    }
    return best;
}
