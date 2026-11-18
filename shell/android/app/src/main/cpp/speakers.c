// Speakers.java's native half: shell/native/speakers (ECAPA on ggml, ivrit's
// clustering), a piece's voice prints at a time, and the speakers at the end.

#include <jni.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>

#include "speakers.h"

JNIEXPORT jlong JNICALL Java_ai_ivrit_app_Speakers_load(JNIEnv *env, jclass cls, jstring path, jint threads) {
    (void) cls;
    const char *file = (*env)->GetStringUTFChars(env, path, NULL);
    sp_model *m = sp_load(file, threads);
    (*env)->ReleaseStringUTFChars(env, path, file);
    return (jlong) (intptr_t) m;
}

JNIEXPORT void JNICALL Java_ai_ivrit_app_Speakers_free(JNIEnv *env, jclass cls, jlong handle) {
    (void) env;
    (void) cls;
    sp_free((sp_model *) (intptr_t) handle);
}

// The print of the segment start..end (seconds into the file) of `length` samples
// that start `offset` seconds into it; null when the segment is too short.
JNIEXPORT jfloatArray JNICALL Java_ai_ivrit_app_Speakers_print(JNIEnv *env, jclass cls, jlong handle, jfloatArray pcm,
                                                               jint length, jdouble offset, jdouble start, jdouble end) {
    (void) cls;
    size_t from, to;
    if (!sp_segment_sound(start, end, offset, (size_t) length, &from, &to)) return NULL;
    jfloat *samples = (*env)->GetFloatArrayElements(env, pcm, NULL);
    float print[SP_DIM];
    bool ok = sp_embed((sp_model *) (intptr_t) handle, samples + from, to - from, print);
    (*env)->ReleaseFloatArrayElements(env, pcm, samples, JNI_ABORT);
    if (!ok) return NULL;
    jfloatArray out = (*env)->NewFloatArray(env, SP_DIM);
    if (out) (*env)->SetFloatArrayRegion(env, out, 0, SP_DIM, print);
    return out;
}

// The prints of the segments starts[i]..ends[i] (seconds into the file) of `length`
// samples that start `offset` seconds into it, all at once (sp_embed_many): 192
// floats each, the first NaN where a segment is too short to print.
JNIEXPORT jfloatArray JNICALL Java_ai_ivrit_app_Speakers_prints(JNIEnv *env, jclass cls, jlong handle, jfloatArray pcm,
                                                                jint length, jdouble offset, jdoubleArray starts,
                                                                jdoubleArray ends) {
    (void) cls;
    jsize n = (*env)->GetArrayLength(env, starts);
    jfloatArray out = (*env)->NewFloatArray(env, n * SP_DIM);
    if (!out || n == 0) return out;
    jdouble *s = (*env)->GetDoubleArrayElements(env, starts, NULL);
    jdouble *e = (*env)->GetDoubleArrayElements(env, ends, NULL);
    jfloat *samples = (*env)->GetFloatArrayElements(env, pcm, NULL);
    const float **sounds = calloc((size_t) n, sizeof *sounds);
    size_t *lengths = calloc((size_t) n, sizeof *lengths);
    bool *sound = calloc((size_t) n, sizeof *sound), *ok = calloc((size_t) n, sizeof *ok);
    float *prints = calloc((size_t) n * SP_DIM, sizeof *prints);
    if (sounds && lengths && sound && ok && prints) {
        for (jsize i = 0; i < n; i++) {
            size_t from = 0, to = 0;
            sound[i] = sp_segment_sound(s[i], e[i], offset, (size_t) length, &from, &to);
            sounds[i] = samples + from;
            lengths[i] = sound[i] ? to - from : 0;
        }
        sp_embed_many((sp_model *) (intptr_t) handle, sounds, lengths, (size_t) n, prints, ok);
        for (jsize i = 0; i < n; i++) {
            if (!sound[i] || !ok[i]) prints[i * SP_DIM] = NAN;
        }
        (*env)->SetFloatArrayRegion(env, out, 0, n * SP_DIM, prints);
    } else {
        out = NULL;
        (*env)->ThrowNew(env, (*env)->FindClass(env, "java/lang/OutOfMemoryError"), "speakers");
    }
    (*env)->ReleaseFloatArrayElements(env, pcm, samples, JNI_ABORT);
    (*env)->ReleaseDoubleArrayElements(env, starts, s, JNI_ABORT);
    (*env)->ReleaseDoubleArrayElements(env, ends, e, JNI_ABORT);
    free(sounds);
    free(lengths);
    free(sound);
    free(ok);
    free(prints);
    return out;
}

// Each print's speaker (0, 1, …; -1 for a missing one): `prints` n * 192 long.
JNIEXPORT jintArray JNICALL Java_ai_ivrit_app_Speakers_cluster(JNIEnv *env, jclass cls, jfloatArray prints,
                                                               jbooleanArray clustered, jbooleanArray missing) {
    (void) cls;
    jsize n = (*env)->GetArrayLength(env, clustered);
    jfloat *p = (*env)->GetFloatArrayElements(env, prints, NULL);
    jboolean *c = (*env)->GetBooleanArrayElements(env, clustered, NULL);
    jboolean *m = (*env)->GetBooleanArrayElements(env, missing, NULL);
    bool *cb = malloc((n ? (size_t) n : 1) * sizeof *cb), *mb = malloc((n ? (size_t) n : 1) * sizeof *mb);
    int *labels = malloc((n ? (size_t) n : 1) * sizeof *labels);
    int found = -1;
    if (cb && mb && labels) {
        for (jsize i = 0; i < n; i++) {
            cb[i] = c[i] == JNI_TRUE;
            mb[i] = m[i] == JNI_TRUE;
        }
        found = sp_cluster(p, cb, mb, (size_t) n, labels);
    }
    (*env)->ReleaseFloatArrayElements(env, prints, p, JNI_ABORT);
    (*env)->ReleaseBooleanArrayElements(env, clustered, c, JNI_ABORT);
    (*env)->ReleaseBooleanArrayElements(env, missing, m, JNI_ABORT);
    jintArray out = NULL;
    if (found >= 0) {
        out = (*env)->NewIntArray(env, n);
        if (out) (*env)->SetIntArrayRegion(env, out, 0, n, labels);
    } else {
        (*env)->ThrowNew(env, (*env)->FindClass(env, "java/lang/OutOfMemoryError"), "speakers");
    }
    free(cb);
    free(mb);
    free(labels);
    return out;
}
