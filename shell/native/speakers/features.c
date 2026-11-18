// SpeechBrain's Fbank (lobes/features.py) as spkrec-ecapa-voxceleb's encode_batch
// computes it: an STFT (400-point Hamming window, 160 apart, centered with zeros),
// its power, 80 triangular mel filters from 0 to 8 kHz, in decibels no more than
// 80 below the loudest, then each filter's mean over the frames taken off
// (InputNormalization, sentence, no std). The filter bank is computed in float32,
// in torch's order of operations; the transforms in double.

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "speakers.h"

#define N_FFT 400
#define HOP 160
#define N_BINS (N_FFT / 2 + 1)
#define N_MELS 80
#define TOP_DB 80.0f
#define AMIN 1e-10f
#define PI 3.14159265358979323846

// torch.linspace, float32: from each end towards the middle.
static void linspace(float start, float end, int steps, float *out) {
    float step = (end - start) / (float) (steps - 1);
    int halfway = steps / 2;
    for (int i = 0; i < steps; i++) out[i] = i < halfway ? start + step * (float) i : end - step * (float) (steps - i - 1);
}

// Filterbank._create_fbank_matrix, triangular: fb[bin * N_MELS + mel].
static void filter_bank(float *fb) {
    float mel[N_MELS + 2], hz[N_MELS + 2], freqs[N_BINS];
    double mel_max = 2595 * log10(1 + 8000.0 / 700);
    linspace(0.0f, (float) mel_max, N_MELS + 2, mel);
    for (int i = 0; i < N_MELS + 2; i++) hz[i] = 700.0f * (powf(10.0f, mel[i] / 2595.0f) - 1.0f);
    linspace(0.0f, 8000.0f, N_BINS, freqs);
    for (int m = 0; m < N_MELS; m++) {
        float central = hz[m + 1], band = hz[m + 1] - hz[m];
        for (int b = 0; b < N_BINS; b++) {
            float slope = (freqs[b] - central) / band;
            float left = slope + 1.0f, right = -slope + 1.0f;
            float v = left < right ? left : right;
            fb[b * N_MELS + m] = v > 0 ? v : 0;
        }
    }
}

float *sp_features(const float *pcm, size_t n, size_t *frames) {
    static float fb[N_BINS * N_MELS];
    static double window[N_FFT], cosine[N_FFT], sine[N_FFT];
    static int ready = 0;
    if (!ready) {
        filter_bank(fb);
        for (int i = 0; i < N_FFT; i++) {
            // torch.hamming_window(400), periodic: arange * (2 pi / N), cos, * -0.46, + 0.54.
            window[i] = cosf((float) i * (float) (2 * PI / N_FFT)) * -0.46f + 0.54f;
            cosine[i] = cos(2 * PI * i / N_FFT);
            sine[i] = sin(2 * PI * i / N_FFT);
        }
        ready = 1;
    }
    size_t t_count = 1 + n / HOP;
    float *out = malloc(t_count * N_MELS * sizeof *out);
    if (!out) return NULL;
    double x[N_FFT];
    float power[N_BINS];
    float loudest = -INFINITY;
    for (size_t t = 0; t < t_count; t++) {
        long first = (long) (t * HOP) - N_FFT / 2;
        for (int i = 0; i < N_FFT; i++) {
            long j = first + i;
            x[i] = j >= 0 && (size_t) j < n ? pcm[j] * window[i] : 0;
        }
        for (int k = 0; k < N_BINS; k++) {
            double re = 0, im = 0;
            for (int i = 0, at = 0; i < N_FFT; i++, at = (at + k) % N_FFT) {
                re += x[i] * cosine[at];
                im -= x[i] * sine[at];
            }
            power[k] = (float) (re * re + im * im);
        }
        float *row = out + t * N_MELS;
        for (int m = 0; m < N_MELS; m++) {
            double sum = 0;
            for (int k = 0; k < N_BINS; k++) sum += (double) power[k] * fb[k * N_MELS + m];
            float v = (float) sum;
            row[m] = 10.0f * log10f(v > AMIN ? v : AMIN);
            if (row[m] > loudest) loudest = row[m];
        }
    }
    float floor_ = loudest - TOP_DB;
    for (int m = 0; m < N_MELS; m++) {
        double sum = 0;
        for (size_t t = 0; t < t_count; t++) {
            float *v = &out[t * N_MELS + m];
            if (*v < floor_) *v = floor_;
            sum += *v;
        }
        float mean = (float) (sum / (double) t_count);
        for (size_t t = 0; t < t_count; t++) out[t * N_MELS + m] -= mean;
    }
    *frames = t_count;
    return out;
}
