// speakers (shell/native/speakers) from the command line, for test_speakers.py:
// a recording's segments in, each one's voice print and speaker out, as JSON.
//   speakers_cli MODEL WAV SEGMENTS.json THREADS
// WAV: 16 kHz mono, 16-bit. SEGMENTS.json: [{"start": s, "end": e}, ...] (other
// fields ignored), read with a scanner that only knows those two keys.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "speakers.h"

static float *read_wav(const char *path, size_t *n) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    unsigned char *file = malloc((size_t) size);
    fseek(f, 0, SEEK_SET);
    if (fread(file, 1, (size_t) size, f) != (size_t) size) return NULL;
    fclose(f);
    for (long at = 12; at + 8 <= size;) {
        unsigned len = file[at + 4] | file[at + 5] << 8 | file[at + 6] << 16 | (unsigned) file[at + 7] << 24;
        if (memcmp(file + at, "data", 4) == 0) {
            *n = len / 2;
            float *pcm = malloc(*n * sizeof *pcm);
            for (size_t i = 0; i < *n; i++) pcm[i] = (short) (file[at + 8 + 2 * i] | file[at + 9 + 2 * i] << 8) / 32768.0f;
            free(file);
            return pcm;
        }
        at += 8 + len + (len & 1);
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 5) return 2;
    // GPU=n: on ggml's GPU device n instead.
    sp_model *m = getenv("GPU") ? sp_load_gpu(argv[1], atoi(getenv("GPU"))) : sp_load(argv[1], atoi(argv[4]));
    if (!m) {
        fprintf(stderr, "no model\n");
        return 1;
    }
    size_t n = 0;
    float *pcm = read_wav(argv[2], &n);
    FILE *f = fopen(argv[3], "rb");
    if (!pcm || !f) return 1;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    char *json = malloc((size_t) size + 1);
    fseek(f, 0, SEEK_SET);
    json[fread(json, 1, (size_t) size, f)] = 0;
    fclose(f);
    // Each segment: the first "start" and "end" after its opening brace at depth 1.
    size_t cap = 1024, count = 0;
    double *starts = malloc(cap * sizeof *starts), *ends = malloc(cap * sizeof *ends);
    int depth = 0;
    for (char *p = json; *p; p++) {
        if (*p == '{' && ++depth == 1) {
            if (count == cap) {
                cap *= 2;
                starts = realloc(starts, cap * sizeof *starts);
                ends = realloc(ends, cap * sizeof *ends);
            }
            starts[count] = strtod(strstr(p, "\"start\":") + 8, NULL);
            ends[count] = strtod(strstr(p, "\"end\":") + 6, NULL);
            count++;
        } else if (*p == '}') {
            depth--;
        }
    }
    float *prints = calloc(count * SP_DIM, sizeof *prints);
    bool *clustered = calloc(count, sizeof *clustered), *missing = calloc(count, sizeof *missing);
    int *labels = malloc(count * sizeof *labels);
    // All at once, as the app prints a piece's segments (sp_embed_many).
    const float **sounds = calloc(count, sizeof *sounds);
    size_t *lengths = calloc(count, sizeof *lengths);
    bool *printed = calloc(count, sizeof *printed), *sound = calloc(count, sizeof *sound);
    for (size_t i = 0; i < count; i++) {
        size_t a, b;
        sound[i] = sp_segment_sound(starts[i], ends[i], 0, n, &a, &b);
        sounds[i] = pcm + a;
        lengths[i] = sound[i] ? b - a : 0;
    }
    sp_embed_many(m, sounds, lengths, count, prints, printed);
    for (size_t i = 0; i < count; i++) {
        missing[i] = !sound[i] || !printed[i];
        clustered[i] = !missing[i] && ends[i] - starts[i] >= SP_MIN_CLUSTERED;
    }
    int speakers = sp_cluster(prints, clustered, missing, count, labels, NULL, NULL);
    printf("{\"speakers\": %d, \"segments\": [", speakers);
    for (size_t i = 0; i < count; i++) {
        printf("%s\n{\"label\": %d, \"print\": ", i ? "," : "", labels[i]);
        if (missing[i]) {
            printf("null}");
            continue;
        }
        for (int j = 0; j < SP_DIM; j++) printf("%s%.7g", j ? ", " : "[", prints[i * SP_DIM + j]);
        printf("]}");
    }
    printf("\n]}\n");
    sp_free(m);
    return 0;
}
