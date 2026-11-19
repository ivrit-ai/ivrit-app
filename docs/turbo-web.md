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
   thread are most of it): correct, still slow; optimizing next.
