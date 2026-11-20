# The Turbo model in the browser

The apps' whole on-device chain, in a desktop browser: whisper.cpp with the app's
patches (`shell/android/app/src/main/cpp/patches`), faster-whisper's decoding,
stable-ts's timing and the speakers (`shell/native`), compiled to WebAssembly and
run on the browser's WebGPU. Same code as the phones, so the same transcript as
the server.

| What | Where |
|---|---|
| The C++ entry points (load, transcribe a whole recording, the app's JSON out) | `shell/native/wasm/turbo.cpp` |
| The build (Emscripten, Dawn's emdawnwebgpu of the Android app's Dawn release) | `shell/native/wasm/CMakeLists.txt`, `scripts/build-web-turbo.sh` |
| The module, built and committed | `web/turbo/turbo.mjs`, `web/turbo/turbo.wasm` |
| The worker: models downloaded once into Cache Storage, read as files (WORKERFS) | `web/turbo/worker.mjs` |
| The test page: the benchmark to `/bench/`, or a file of one's own | `web/lab/turbo/` |

## Decisions

1. **WebAssembly of the same C++, not another engine.** The browser runs exactly
   what the phones run; only the GPU underneath differs (the browser's WebGPU for
   Dawn's).
2. **JSPI, so Chrome and Edge for now.** ggml waits for the GPU synchronously;
   in a browser that needs JSPI (`-sJSPI`, the calls that run the model exported
   as promising). Safari and Firefox keep the zipformer until they have it.
3. **One thread.** Threads need the page cross-origin isolated, which would break
   Google's sign-in and pickers; `patches/whisper-wasm-threads.patch` makes
   whisper.cpp's `-pthread` an option, off here. The encoder and decoder run on
   the GPU; what is left on the CPU (stable-ts, the voice prints, clustering) is
   small.
4. **The app's own WebGPU programs** (`GGML_WEBGPU_MOBILE`, set by `tw_load`):
   browsers expose no subgroup matrices, so ggml's own matrix multiply would be
   its slow generic one there too.
5. **Verified on the CPU** (Deno, 2026-11-19): the module transcribes, prints and
   clusters as the native code does (voice prints at cosine 0.9999 to native, the
   same speakers).
6. **On an Iris Xe in Edge** (headless, driven from WSL, 2026-11-19): first the
   wait timed out at 30 s, then with a longer wait Windows reset the GPU
   (DXGI_ERROR_DEVICE_HUNG: its watchdog ends GPU work running over ~2 s). The
   phone programs ran at 12-32 GFLOPS there. Rewritten (patches/ggml-webgpu-phones.patch)
   with no private array indexed by a loop and loads in which neighbouring threads
   read neighbouring memory, they run at 410-450 GFLOPS (the matrix multiply) and
   3-4 times faster (flash attention), the S25 a little faster too (760-800); and
   Intel's GPUs take 4 columns a thread (fewer registers), others 8. Beam search's
   5 columns go to the matrix-vector program (up to 8 with GGML_WEBGPU_MOBILE),
   halving the decoder's steps. The module sends 8 kernels a submission and waits
   up to 10 minutes. A minute of Hebrew then takes 157 s on that laptop (the
   decoder's steps, ~18 ms of matrix-vector each, and the voice prints on one
   thread are most of it): correct, still slow.
7. **Then the decoder and the voice prints** (same laptop, hot, 2026-11-19): a
   matrix-vector program of our own for a decoder step (a row a thread, the
   beams' values in shared memory: the vocabulary's 1280 x 51866 in 19.8 ms, not
   65.5); our flash attention for the encoder's many queries only (a step's five
   go to ggml's vector path, which splits the keys); and the speaker model on the
   GPU (sp_load_gpu, used when its print of a test sound is the CPU's at cosine
   0.999: ggml-webgpu has no MEAN and skipped it, so ecapa.cpp means as sum and
   scale, the native prints unchanged). A minute of Hebrew: 97 s, from 185-194.
8. **The models download to disk** (OPFS, a piece at a time as it arrives) and an
   interrupted download goes on from where it stopped (an HTTP range); the page
   asks for persistent storage and keeps the screen on while it runs (a phone
   could not hold 900 MB in memory first, nor keep a page alive with the screen
   off).
9. **Beam search 5, the default** (a fast greedy mode may come as an option; the
   user's call, 2026-11-20). In the browser a beam step cost twice a greedy one,
   where on the phone (the decoder on its CPU) they cost the same. Closed most of
   the gap: the step's five rows of probabilities read in one call
   (patches/whisper-logits-once.patch: each read is a wait, a round trip to the
   browser's GPU process); the matrix-vector program compiled for the step's
   column count (C1..C7: 5 columns cost 5, 1 costs 1) and four threads a row, 64
   rows a workgroup (the columns' tile shared by more weights). A minute: 94 s to
   68 s on the Iris Xe, its words the CPU's; greedy 65 s. The rest of a beam step:
   self-attention over the shared cache (whisper.cpp's beams share one, each step
   attends up to its highest cell), ~13 ms.
10. **The encoder's multiply in 8-bit integers** where the GPU has the 4 x 8-bit dot
    product (mul_mat_mobile_dot.wgsl; GGML_WEBGPU_MOBILE_NO_INT8 for f32): the
    activations made 8-bit a block at a time, as ggml's CPU does, so its numbers
    are the CPU's (error 0.0002 against 0.004 for f32), and 10-25% faster on the
    Iris Xe. Phones' trial keeps f32 (it leaves the dot product off).
11. **A laptop's own state moves its times by up to twice** (heat, its charger):
    compare versions back to back, alternating, never across hours.
