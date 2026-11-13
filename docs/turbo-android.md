# ivrit.ai's Turbo model on Android phones

The Android app transcribes recordings in the background, with the app closed
too (`LocalTranscribeWorker`): shared recordings, watched folders, and files
handed over from the app. It does so with the zipformer (sherpa-onnx, bundled),
or, where the user chooses it in Settings, with ivrit.ai's Turbo model
(whisper-large-v3-turbo trained further on Hebrew): whisper.cpp, on the CPU, or
on the GPU through Vulkan where the phone's GPU passes a check. Live and the
page's own transcription (without Drive) keep the zipformer.

Target: Android phones from 2023 on, mid-range and up.

## How it fits together

| Part | Where |
|---|---|
| The model, quantized from ivrit-ai's f16 ggml file when the server starts, served at `/models/turbo/` | `scripts/turbo_model.py`, `launch.sh`, `server/app_site.py` |
| whisper.cpp 1.9.5 and the Vulkan and SPIR-V headers, fetched pinned | `scripts/fetch-whisper.sh` |
| The native library: whisper.cpp with ggml's CPU and Vulkan backends, and the JNI bridge | `shell/android/app/src/main/cpp/` |
| Which phones, the download, threads | `Turbo.java` |
| GPU or CPU: the check, crash guard, the user's choice | `TurboGpu.java` |
| Tokens into words; sound to 16 kHz | `TurboWords.java`, `Resampler.java` |
| A recording through it, a few minutes at a time, with checkpoints | `LocalTranscribeWorker.transcribeTurbo` |
| Settings: model, and where it runs | `web/transcription/settings.js`, `onDeviceModel` in `shell/native-api.json` |

Each Turbo transcription posts its timing to `/lab/report?kind=local-turbo`
(device, threads, CPU or GPU, speed against real time, load time), and each GPU
check posts its result under `kind=local-turbo-gpu`: the numbers from phones
come from these `lab_report` lines in the server's log.

## Decisions

Open to comment; each with what it rests on.

1. **whisper.cpp in the native worker, not WebGPU in the page.** The phone
   transcribes in the background with the app closed; a WebView cannot. The
   web engine (whisper-gpu, the lab) stays for the browser.

2. **q8_0 by default, q5_1 offered.** Measured with whisper-gpu on the laptop's
   Iris Xe (its q8/q5 blocks are ggml's q8_0/q5_1 layouts): on 5 minutes of
   Hebrew with a reference transcript, f16 3.31% WER, q8 3.31% (the same text),
   q5 4.23%, q4 5.15%; on another 4.4 minutes, words differing from f16: q8
   0.17%, q5 7.4%, q4 4.5%. ggml also repacks q8_0 for ARM's dot-product
   instructions (a fast matrix path q5_1 lacks), so q8_0 should be faster on
   phones' CPUs as well. Cost: 874 MB to download against 624 MB.

3. **Greedy decoding.** Beam search (5) made 3 fewer mistakes in 544 words
   (3.68% against 4.23%, q5) and took 29% longer. Speed matters more on a
   phone. `Turbo.BEAMS` changes it.

4. **Who is offered Turbo:** arm64, CPU with dot products and half floats
   (`asimddp`, `asimdhp`), about 6 GB of memory (5 GiB reported). The
   library is built for `armv8.2-a+dotprod+fp16`: a phone without them would
   crash, so the check is a must, not a nicety.

5. **Threads:** the cores at least half as capable as the best, by the
   kernel's own measure (`cpu_capacity`), at most eight: all eight on a Galaxy
   S25, whose cores are all big (build 249 used four there, and still ran
   1.2× real time on the CPU); where that is missing, the cores faster than the
   slowest kind, at least four. ggml shares matrix work out in small pieces,
   so a small core helps more than it holds back. Reported with each run, to
   tune from phones' numbers.

6. **The model downloads the first time it is used**, after the user chose it
   in Settings (which says how large it is and suggests Wi-Fi); resumed where
   it broke off, checked against the server's hash. Only the chosen model is
   kept; choosing another lets go of it.

7. **The server makes the quantized files** from ivrit-ai's f16, pinned by hash,
   on start-up (about a minute), as the lab's models are made. Better: publish
   them on ivrit-ai's Hugging Face and point `Turbo.ensure` there. Not done:
   publishing under ivrit-ai's name is for you to decide.

8. **Ten-minute pieces.** whisper.cpp hears a piece whole (its 30-second
   windows carry context within it); each piece's last sentence, which may be
   cut off, is heard again at the start of the next, and a checkpoint is kept
   after each, so a stopped run resumes there. On the laptop, 120-second pieces
   took 29% longer than one pass (4.6% WER against 3.3%: the windows fall
   differently after a cut, so a few words change anywhere, not only at the
   cuts); ten minutes keeps that to a few percent. Memory: about 70 MB of sound
   and spectrogram a piece.

9. **Vulkan for the GPU,** in the same library as the CPU (ggml-vulkan): it
   covers both Adreno (Qualcomm) and Mali (MediaTek, Exynos, Tensor), and needs
   no other model file. OpenCL (Adreno only) and Qualcomm's NPU (Hexagon) are
   later options, if phones' numbers call for them.

10. **The GPU is used only after it passed a check on this phone**, per system
    build (drivers come with it) and model: the 12-second Hebrew fixture
    (`res/raw/turbo_check.ogg`, the repo's `store/fixtures/hebrew-12s.ogg`, from
    ivrit.ai's eval set) on the CPU, then twice on the GPU (the first run builds
    its shaders). It passes when the GPU's words agree with the CPU's (85% of
    words in order; half floats move a word or two, a broken driver far more)
    and its second run is faster. About a minute, once.

11. **Safer settings before giving up.** On a Galaxy S25 (Adreno 830, Android
    17) build 249's check crashed while ggml was starting the GPU, before the
    first transcription. ggml takes its newest path on Adreno 8xx (cooperative
    matrices) and builds every shader when the device starts, the likeliest
    place. A check that crashes now runs again with safer switches for ggml's
    Vulkan backend: first without cooperative matrices, then also without
    integer dot products, half floats and fusion; only when the last crashes
    is the GPU given up. Each crash is reported (`kind=local-turbo-gpu-crash`)
    with the check's step and, from Android 11, the phone's own record of it,
    the native tombstone included, for symbols from the build's unstripped
    library (kept outside the repo, by build number).

12. **Crash guard instead of a separate process.** A GPU driver crash kills
    the process. A check under way is saved before it starts; if it is still
    there next time, the GPU is marked crashed. A GPU run likewise; two dying in
    a row put the phone back on the CPU (until its next system update). A run
    the phone killed for another reason (the app swiped away on some phones, low
    memory) counts too: two such in a row cost the GPU, never the transcript.
    A GPU that hangs rather than crashes is not caught. A separate process would spare the app
    the one crash, but it would mean passing minutes of sound and the progress
    the page shows across processes; worth it only if phones' reports show
    crashes.

13. **The user's choice of processor:** automatic (the GPU when it passed and is
    faster; the default), the CPU, or the GPU whenever its words are right,
    faster or not (to compare on a phone). Settings shows what the check found:
    the GPU's name, and its time against the CPU's.

14. **Building:** NDK 27.0.12077973 (AGP 8.13's default) and CMake 3.22.1.
    ggml-vulkan needs newer Vulkan headers than the NDK's (it has 275; these are
    1.4.350, May 2026) and SPIR-V's headers, fetched pinned with whisper.cpp.
    Its shaders compile with the NDK's `glslc` (shaderc 2022.3; NDK r30 has the
    same one); extensions that compiler lacks are left out by ggml's own tests.
    `-PturboVulkan=OFF` builds the CPU-only library, should the Vulkan build
    fail.

## Verified, and not yet

Built: `scripts/build-android.sh` makes the signed AAB and APK with the native
library (22 MB stripped for arm64, most of it ggml's Vulkan shaders). The first
link failed on `vkGetPhysicalDeviceFeatures2`: Vulkan 1.1, which Android's loader
exports from API 28, while the app's minSdk is 24. The library now links
against API 28's loader; on older phones it does not load and Turbo is not
offered (`Turbo.supported` also checks Android 9+).

On the laptop (x86, whisper.cpp built for it; not a phone):

- The quantized files load in whisper.cpp and transcribe. Through the app's own
  path (turbo.c over JNI, TurboWords, Segments, the same settings), q8_0 scores
  3.31% WER on the 5-minute reference, the same as whisper-gpu at f16; word
  times only rise.
- `whisper-cli` with its defaults scores about 10% on every quantization: it
  conditions each window on the last one's text, and drops phrases. The app's
  settings (no carried context, non-speech suppressed) avoid that.
- Speed on the CPU: 304 s for 297 s of audio, 8 threads; 4 threads, 43 s of
  encoder per 30-second window. A mid-range phone's CPU is likely slower than
  that, so expect under real time on the CPU: the GPU and the phones' own
  numbers decide how usable Turbo is there. Ways to cut the encoder's work if
  it is too slow: skip silence (whisper.cpp's VAD, a 1 MB model), then
  OpenCL/NPU.

Not verified: anything on a phone (the GPU check, Vulkan's speed and
correctness on Adreno and Mali, memory, heat, battery).

To try on a phone: install `dist/ivrit-app-<version>-<n>.apk` (or the AAB via
Play's internal track); deploy the server (the models appear about a minute
after start); on the phone, Settings → the model for transcribing on the phone
→ Turbo; share or hand over a recording. Then read the `local-turbo` and
`local-turbo-gpu` lines in the log.
