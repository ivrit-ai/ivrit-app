// Speakers.java's native half: shell/native/speakers (ECAPA on ggml, ivrit's
// clustering), a segment's voice print at a time, and the speakers at the end.

#include <jni.h>
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
