// One GPU program timed at the model's sizes on ggml's WebGPU device, against the
// CPU's answer (the browser's Lab page and the app's test on phones we don't have).
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// what 0: a q8_0 x f32 matrix multiply, M rows of K by N columns; 1: flash attention,
// head size 64, N queries and keys, M heads. Milliseconds a run (of `reps`, after a
// first), and in *error the largest difference from the CPU's answer over its largest
// value. Throws (C++) where the GPU fails; "no WebGPU device" where it has none.
double gb_time(int what, int K, int M, int N, int reps, double *error);

#ifdef __cplusplus
}
#endif
