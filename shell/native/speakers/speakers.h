// speakers: who speaks when, as ivrit.ai's diarization does it (its "ivrit" engine,
// ivrit/diarization.py): a voice print of each transcript segment with
// SpeechBrain's ECAPA-TDNN (speechbrain/spkrec-ecapa-voxceleb), and the prints
// clustered the way it clusters them, the number of speakers chosen by the same
// scores. The model runs on ggml (as whisper.cpp does), from the file
// scripts/speaker_model.py makes; the features are SpeechBrain's Fbank.

#ifndef SPEAKERS_H
#define SPEAKERS_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SP_DIM 192            // a voice print's length
#define SP_SAMPLE_RATE 16000
#define SP_MIN_CLUSTERED 1.0  // seconds: shorter segments are matched to speakers, not clustered
#define SP_MAX_SPEAKERS 20

typedef struct sp_model sp_model;

// The model file, run on `threads` threads. NULL when it will not load.
sp_model *sp_load(const char *path, int threads);
// The same on ggml's GPU device `gpu` (counting GPUs only, as whisper.cpp's
// gpu_device does). NULL when it will not load there. On the Galaxy S25's GPU
// (OpenCL) the same speakers, no faster than its eight cores with sp_embed_many
// (4.0 s against 3.2 s for 213 s of speech), so the app prints on the CPU.
sp_model *sp_load_gpu(const char *path, int gpu);
void sp_free(sp_model *m);

// The sound ivrit's engine takes for a segment (_extract_segment_audio): samples
// [*from, *to) of a recording n samples long, `offset` seconds into the file. False
// when it is too short to print (under 50 ms, after a short one is widened).
bool sp_segment_sound(double start, double end, double offset, size_t n, size_t *from, size_t *to);

// A voice print of 16 kHz sound (encode_batch: Fbank, mean normalization, ECAPA).
bool sp_embed(sp_model *m, const float *pcm, size_t n, float out[SP_DIM]);

// Voice prints of `count` sounds (pcm[i], n[i] samples each) at once, the model's
// threads each taking whole sounds: out[i * SP_DIM...], ok[i] false where one
// could not be printed (too short, out of memory).
void sp_embed_many(sp_model *m, const float *const *pcm, const size_t *n, size_t count, float *out, bool *ok);

// SpeechBrain's Fbank features of the sound (80 a frame, frame after frame), mean
// normalized as encode_batch does; *frames of them, malloc'd. NULL when out of memory.
float *sp_features(const float *pcm, size_t n, size_t *frames);

// ivrit's clustering of `n` voice prints (n * SP_DIM floats): those with
// clustered[i] are clustered into 1..SP_MAX_SPEAKERS groups, by agglomerative
// (cosine, average; Ward) and k-means clustering, the best by its composite of
// silhouette, Davies-Bouldin and Calinski-Harabasz scores; then every print gets
// the speaker whose centroid it is closest to. labels[i]: 0, 1, … (SPEAKER_00, …),
// or -1 for missing[i]. Returns the number of speakers, 0 when none were clustered,
// -1 when out of memory.
int sp_cluster(const float *prints, const bool *clustered, const bool *missing, size_t n, int *labels);

#ifdef __cplusplus
}
#endif

#endif
