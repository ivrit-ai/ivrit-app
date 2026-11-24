# ivrit.ai's Turbo model on Android phones

The Android app transcribes recordings in the background, with the app closed
too (`LocalTranscribeWorker`): shared recordings, watched folders, and files
handed over from the app. It does so with the zipformer (sherpa-onnx, bundled),
or, where the user chooses it in Settings, with ivrit.ai's Turbo model
(whisper-large-v3-turbo trained further on Hebrew): whisper.cpp, on the GPU
through OpenCL (Snapdragon) or WebGPU with the app's own programs, where the
phone's GPU passes a check, or on the CPU. Live and the page's own transcription
(without Drive) keep the zipformer.

Offered on Galaxy S23s and later (decisions 24-26).

## How it fits together

| Part | Where |
|---|---|
| The model, quantized from ivrit-ai's f16 ggml file when the server starts, served at `/models/turbo/` | `scripts/turbo_model.py`, `launch.sh`, `server/app_site.py` |
| whisper.cpp 1.9.5 and the Vulkan and SPIR-V headers, fetched pinned | `scripts/fetch-whisper.sh` |
| The native library: whisper.cpp with ggml's CPU, OpenCL and WebGPU (Google's Dawn) backends, and the JNI bridge | `shell/android/app/src/main/cpp/` |
| Which phones, the download, threads | `Turbo.java` |
| GPU or CPU: the check, crash guard, the user's choice | `TurboGpu.java` |
| Words, segments and speakers as the server makes them (ports of faster-whisper, stable-ts and ivrit's diarization); sound to 16 kHz | `shell/native/` (its README), `TurboTranscript.java`, `Speakers.java`, `Resampler.java` |
| The speaker model, converted from SpeechBrain's, on Hugging Face (`ivrit-ai/spkrec-ecapa-voxceleb-ggml`), downloaded pinned to its revision and hash | `scripts/speaker_model.py`, `Speakers.java` |
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

2. **q8_0 only. q5_1 is dropped for good; do not bring it back.** Measured with
   whisper-gpu on the laptop's Iris Xe (its q8/q5 blocks are ggml's q8_0/q5_1
   layouts): on 5 minutes of Hebrew with a reference transcript, f16 3.31% WER,
   q8 3.31% (the same text), q5 4.23%, q4 5.15%; on another 4.4 minutes, words
   differing from f16: q8 0.17%, q5 7.4%, q4 4.5%. Then on the Galaxy S25
   (2026-11-18, build 260's chain, 5 beams, decoder on the CPU beside the
   OpenCL encoder): q5_1 took 378 s on a 4-minute recording against q8_0's 107
   s, and 573 s on a 10-minute podcast against 152 s; on the CPU alone, 614 s
   against 192 s. ggml has no fast ARM or Adreno path for q5_1 (it repacks q8_0
   and q4_0 for ARM's dot-product instructions), so it is 3-4 times slower,
   and less accurate, for 250 MB less to download. A phone that had chosen it
   falls back to q8_0 (Store.onDeviceModel) and lets its file go
   (Turbo.RETIRED); Settings shows the one size instead of a choice.
   A smaller size, if one is ever wanted, is q4_0 (118-135 s on that podcast,
   faster than q8_0), only after its words are scored against q8_0's and the
   server's.

3. **Beam search (5) on the GPU, greedy on the CPU** (`Turbo.beams`), as the
   server decodes with beam 5. On the Galaxy S25's GPU (OpenCL) beam 5 took
   0.6 of the recording's length; greedy 0.3-0.5, and on one recording 6% of
   its words differed from the server's more (decision 15). On the CPU beam 5
   took three times the recording's length, greedy about 1.1.

4. **Who is offered Turbo:** Galaxy S23s and later (decisions 24-26), Android
   13 on, 8 GB, arm64 with dot products and half floats
   (`asimddp`, `asimdhp`). The library is built for `armv8.2-a+dotprod+fp16`:
   a phone without them would crash, so that check is a must, not a nicety.
   Up to build 272: any such phone with about 6 GB.

5. **Threads:** the cores at least half as capable as the best, by the
   kernel's own measure (`cpu_capacity`), at most eight: all eight on a Galaxy
   S25, whose cores are all big (build 249 used four there, and still ran
   1.2× real time on the CPU); where that is missing, the cores faster than the
   slowest kind, at least four. ggml shares matrix work out in small pieces,
   so a small core helps more than it holds back. Reported with each run, to
   tune from phones' numbers.

6. **Turbo transcribes every recording, the zipformer only live.** On phones that
   can run Turbo it is the model for recordings (shared, watched, handed over),
   with no choice of the zipformer any more (builds up to 259 offered it, and had
   it by default: the site moves those to Turbo); the zipformer transcribes live,
   and recordings only on phones that cannot run Turbo. Where the phone
   transcribes recordings (on-device only, a folder watched for it, no account,
   or once it has), Turbo is made ready ahead (`PrepareWorker`, queued at the
   app's start and when those settings change): the model and the speaker model
   downloaded, the decoder's threads tuned (on the CPU), on Wi-Fi and while
   charging only, in a quiet notification that says what it downloads and how
   large; so a recording starts at full speed. What it has not done, a recording
   still does first (its first download waiting for Wi-Fi). Downloads resume
   where they broke off and are checked against the server's hash. Only the
   chosen size is kept; choosing another lets go of it.

7. **The server makes the quantized files** from ivrit-ai's f16, pinned by hash,
   on start-up (about a minute), as the lab's models are made. Better: publish
   them on ivrit-ai's Hugging Face and point `Turbo.ensure` there. Not done:
   publishing under ivrit-ai's name is for you to decide.

8. **Ten-minute pieces.** The sound comes in ten-minute pieces, a checkpoint
   after each, so a stopped run resumes there. The 30-second windows go on
   across pieces as if there were none (decision 15): a piece stops where less
   than a window is left, the next starts there, and what carries over (the
   previous text, the last speech) is in the checkpoint. stable-ts finds silence
   against the whole file's loudness and length, so a file longer than a piece
   is decoded once first for those (a minute's work for an hour, shown as
   preparing; a shorter one is all one piece, which finds them itself); they go
   into the checkpoint too. What still differs is the spectrogram's floor, set
   from each piece's loudest moment as Whisper sets it from the whole file's: a
   comma here and there. Memory: about 70 MB of sound and spectrogram a
   piece.

9. **Two GPU backends: WebGPU first, then Vulkan** (since decision 26: OpenCL, then WebGPU with our programs). Both in the same library,
   with the same model file. WebGPU is ggml's WebGPU backend on Google's Dawn
   (its Android release, built into the app; Dawn runs on the phone's Vulkan
   driver but writes its own, conservative shaders, and carries workarounds for
   drivers' bugs, Qualcomm's among them). Vulkan is ggml-vulkan, ggml's own
   shaders straight on the driver: it covers Mali well, and failed every way on
   the Galaxy S25's Adreno 830 (decision 11). OpenCL (Adreno only) and
   Qualcomm's NPU (Hexagon) remain options.

10. **The GPU is used only after it passed a check on this phone**, per system
    build (drivers come with it) and model: the 12-second Hebrew fixture
    (`res/raw/turbo_check.ogg`, the repo's `store/fixtures/hebrew-12s.ogg`, from
    ivrit.ai's eval set) on the CPU, then twice on the GPU (the first run builds
    its shaders). It passes when the GPU's words agree with the CPU's (85% of
    words in order; half floats move a word or two, a broken driver far more)
    and its second run is faster. About a minute, once.

11. **Safer settings before giving up, and the Galaxy S25.** On a Galaxy S25
    (Adreno 830, Android 17) the GPU first failed to start (ggml's cooperative
    matrix path, the newest, taken on Adreno 8xx); without it, the GPU started,
    but its driver refused to build ggml's q8_0 matrix-vector shader
    (`createComputePipeline: ErrorUnknown`), and the C++ exception ended the app.
    That shader differs from the f16 ones the driver built in leaving bounds
    checks off (pipeline robustness) and requiring whole subgroups of a fixed
    size. So:
    - `patches/ggml-vulkan-switches.patch` (applied by `fetch-whisper.sh`) adds
      two switches to ggml-vulkan: keep robustness on everywhere
      (`GGML_VK_KEEP_ROBUSTNESS`), reduce through shared memory instead of
      subgroups (`GGML_VK_DISABLE_SUBGROUP_ARITHMETIC`).
    - The levels, each tried once, safest last: as is; no cooperative matrices;
      also robustness kept; also no subgroup reductions; also no integer dot
      products, half floats, fusion or flash attention. Only after the last is
      the GPU given up.
    - `guard.cpp` catches what whisper.cpp and ggml throw, so a refused shader
      fails the check (next level next time; this recording on the CPU) instead
      of ending the app.
    - During the check and GPU runs, stderr and the whole ggml/whisper.cpp log go
      to a file; every failure or crash is reported
      (`kind=local-turbo-gpu-crash`) with its end, the step, and from Android 11
      the phone's exit records with native tombstones (symbols: the build's
      unstripped library, kept outside the repo by build number).
    - Then WebGPU, tried first since build 253, and a watchdog: a GPU step
      running far past its time (the check's: ten times the CPU's, at least two
      minutes; a run's piece: twice its length plus two minutes) fails its level
      and ends the process, as a hung GPU cannot be interrupted; WorkManager
      starts the work again. Build 252's no-subgroups level hung the S25 for
      three hours.
    - Build 254 on the S25: Dawn started the Adreno, the model loaded onto it,
      and the first work sent lost the device (`vkQueueSubmit` →
      `VK_ERROR_DEVICE_LOST`; ggml-webgpu then aborts), with flash attention
      and without. ggml-webgpu turns off Dawn's bounds checks
      (`disable_robustness`) and uses cooperative matrices (Dawn's subgroup
      matrix, on Adreno's `VK_KHR_cooperative_matrix`, the path that also
      crashed ggml-vulkan). Build 255 patches in switches
      (`patches/ggml-webgpu-phones.patch`) and tries WebGPU with the bounds
      checks kept and no cooperative matrices; then with subgroups and packed
      dot products off too, without flash attention; then Vulkan as before.
      ggml-webgpu reads its switches once, when ggml first starts in the
      process, so a WebGPU level after another failed without a crash restarts
      the process. ggml's log now leaves out the CPU's line per repacked
      weight, which filled the report's tail; it states the adapter and the
      features used.
    - Then over adb on the S25 (whisper-cli built with the app's whisper.cpp,
      the q8_0 model, 2026-11-14): Dawn reports no subgroup matrix there, so
      that was not it. ggml-webgpu ran but gave wrong words ("inappropriate"
      for the 12-second sample), with bounds checks or without, and its encoder
      took 22 s to the CPU's 10; with subgroups and dot products off, it lost
      the device. WebGPU on Adreno is out for now.
    - **OpenCL (ggml-opencl, Qualcomm's kernels for Adreno) works**, after two
      fixes (`patches/ggml-opencl-early-buffers.patch`: it crashed reading its
      context before whisper.cpp had started it; `whisper-gpu-get-rows.patch`:
      it has no q8_0 GET_ROWS, so the token embedding left on the GPU was copied
      back whole, 70 MB a token, 112 ms; whisper.cpp now asks, and keeps it on
      the CPU). On the 5-minute reference: the CPU's very words (540 of 540),
      82 s against 166 s on the CPU (encoder 4.5 s a window against 13.7;
      decoder 13 ms a token against 6). Build 256 tries OpenCL first. The
      library does not link the phone's `libOpenCL.so` (most phones have none,
      and the library would not load): `cpp/opencl.c` opens it on first use,
      and the manifest asks for it (`uses-native-library`, needed from Android
      12). ggml-opencl takes Adreno (and Intel) only; Mali phones go on to
      WebGPU and Vulkan. Its built kernels are kept in the app's cache.
    - Still to try: the decoder on the CPU and the encoder on the GPU (the CPU
      decodes twice as fast over long recordings).

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
15. **Transcripts as the server's, speakers and all.** The server's are the ivrit
    package's: faster-whisper's words, stable-ts's silence snapping and
    regrouping, ivrit's diarization (SpeechBrain's ECAPA voice prints, clustered).
    Turbo's on the phone are now made the same way, by ports of exactly those
    steps (`shell/native`, each tested against the Python it ports; its README
    has the numbers), not by the app's own sentence rules (`Segments`, still the
    zipformer's). In C, not Java, so the iPhone's app can use them, and outside
    whisper.cpp, which they only call: whisper.cpp keeps a pinned release and
    one more patch (DTW word times with flash attention, and each segment's
    window start), not a fork.
    - **Word times from DTW**, whisper.cpp's version of the cross-attention
      alignment faster-whisper uses, with large-v3-turbo's alignment heads (ivrit's
      Turbo keeps them: its config.json). The DTW pass is one more decoder pass a
      window; with flash attention on, its alignment heads' weights are computed
      beside the flash attention, in that pass only.
    - **ECAPA runs on ggml**, already in the library, not ONNX Runtime: sherpa-onnx
      links ONNX Runtime statically and exports none of it, and making an ONNX
      file needs PyTorch, which the server has not. `scripts/speaker_model.py`
      reads SpeechBrain's checkpoint with numpy and writes it with q8_0 matrices
      (23 MB; its prints at cosine 0.9998 to SpeechBrain's), uploaded to Hugging
      Face (`ivrit-ai/spkrec-ecapa-voxceleb-ggml`, Apache-2.0 as SpeechBrain's),
      where the app downloads it, pinned to a revision and its hash.
    - **A voice print a segment, after each piece**, while its sound is in memory,
      all of a piece's at once, each core taking whole segments (the model is a
      chain of small steps that threads only wait on; on the S25 3.2 s for 213 s
      of speech, 107 s before);
      the prints go into the checkpoint, and the speakers are found once, at the
      end, as ivrit does over the whole file. No speaker model (a failed
      download): the transcript comes without speakers.
    - The server keeps speakers in on-device transcripts (`checked_local_results`),
      ivrit's labels only (`SPEAKER_00`, …).
    - The GPU check's ladder is 7: its run includes the DTW pass now.
    - **faster-whisper's decoding loop, over whisper.cpp's model a window at a
      time** (`shell/native/transcript`; patches/whisper-dtw-flash.patch's
      `ivrit_window`). With whisper.cpp's own loop, transcripts drifted from the
      server's after the first window (93-96% of words the same, whatever the
      model's precision: f32 no better than q8_0), because whisper.cpp moves to
      the next window at the last timestamp token and faster-whisper, with word
      times on, at the last word's end; and retries on token entropy where
      faster-whisper retries on the compression ratio, drops the prompt near the
      end and at high temperatures, ranks beams on the text before the last
      timestamp, and aligns over a different span. Now the window's start, the
      prompt, the fallback, the no-speech skip, the segments and the alignment
      are faster-whisper's; whisper.cpp decodes (its beam search) and aligns. On
      the Galaxy S25 (q8_0, beam 5): 97.6-98.1% of the words the same as the
      production server's (RunPod, fp16), 97-98% of their starts within 20 ms;
      at the same speed. faster-whisper itself at int8 gets 94-99% against it.

16. **Below whatever the phone is doing.** On the Galaxy S25 a transcription at
    normal priority, all eight cores and the GPU, made the phone sluggish. The
    transcribing thread (and ggml's, which take its priority) runs at nice 9,
    just short of background priority, from which Android may keep threads to
    the slow cores; and on Adreno the OpenCL context asks for low priority
    (`cl_qcom_priority_hint`, patches/ggml-opencl-priority.patch), so the
    phone's own drawing goes first. Idle, the phone still gives it all it has.

17. **The encoder on the GPU, the decoder on the CPU, its threads tuned per
    phone.** On the Galaxy S25's GPU (OpenCL) a beam-5 decoder step took 65 ms,
    on its CPU 17-22 ms with 4-6 threads (and 55 ms with all 8: its steps are
    too small to share eight ways); the encoder was four times faster on the
    GPU. With the decoder's weights and caches on the CPU
    (patches/whisper-dtw-flash.patch's `ivrit_decoder_cpu`) a 4.4-minute
    recording took 93 s instead of 172 s, the same words. Phones differ, so the
    GPU check times its run both ways and keeps the faster (`decoderCpu`, ladder
    9), and the decoder's thread count is timed on each phone
    (`tr_tune_decoder`, a second, once per system build, kept with the verdict);
    the encoder keeps `Turbo.threads()`.
18. **A benchmark anyone can run**, from the Lab page in the app: ivrit.ai's
    benchmark recording (five minutes, two speakers, from the eval-d1 set,
    published as `ivrit-ai/turbo-benchmark` with its reference) through Turbo as a
    recording goes (`Benchmark.java`, LocalTranscribeWorker's "benchmark" kind),
    timed stage by stage and not saved. The site scores the transcript against
    the reference, keeps the run (`server/bench.py`) and gives it a page to share
    (`/bench/?id=…`); `/bench/` ranks each phone's fastest run, with the model and
    the app's version beside it, as both will change. Only runs Google Play vouches
    for rank (Play Integrity: the genuine app from Play, on a phone passing Google's
    device check, bound to the very result by its hash); a key in the app could be
    pulled out of it, Play's word cannot. iPhone, once it has Turbo: App Attest.

19. **Watched folders transcribe on the phone only while it charges**, by default
    (a watch's `chargingOnly`, which its settings show where it may go to the
    phone): a folder's files can wait, and a transcription takes the phone a
    while. Unplugged, it pauses and goes on when plugged in again. What the user
    asked for (shared, handed over, picked in the app) starts at once; only the
    model's first download waits, for Wi-Fi.

20. **The GPU's check never runs with the app on the screen.** It runs in the
    app's own process, and a GPU driver that crashes takes that down (a Pixel 7,
    Android 17, crashed at its shaders, the app open: builds 261-262 started the
    check with the app). The background preparation leaves the check alone; a
    recording made with the app open goes on the CPU, unchecked, and the next one
    in the background checks.

21. **WebGPU with programs of our own for phone GPUs, on trial** (the Lab's switch,
    processor `webgpu`; `TurboGpu.trial`; `patches/ggml-webgpu-phones.patch`, which
    replaces the switches patch). ggml-webgpu's matrix multiply ran at 90 GFLOPS on
    the Galaxy S25's Adreno 830 (its CPU: 360), and slower still with subgroups,
    so slow that the driver stopped the work and the device was lost (the S25 and
    a Pixel 7's Mali-G710 alike: the Pixel's crash after launch in 261-262). The
    patch adds, behind `GGML_WEBGPU_MOBILE`, a q8_0/f16 x f32 matrix multiply (64 x
    64 per workgroup, 8 x 8 per thread, vec4 math: 740-790 GFLOPS on the S25) and a
    flash attention (one query per thread, keys 8 at a time; the query held in f16,
    or registers spill: 12 times slower), neither using subgroups; and throws where
    ggml-webgpu ended the process (a lost device, a failed or timed-out wait), so
    guard.cpp takes it and the run goes on on the CPU. A minute of Hebrew on the
    S25, the decoder on the CPU: 33.0 s against OpenCL's 37.7 s in the same state
    (the encoder 11.6 s against 11.2 s), the CPU alone 54 s; the CPU's very words
    each time. Dawn's bounds checks cost 25% of the encoder, so the trial goes
    without them. It runs without the check, and the benchmark's words judge it; if
    it holds on Mali (a Pixel), WebGPU can be the one GPU path (OpenCL and Vulkan
    gone), on iPhones and desktops too, and the patch belongs upstream.
22. **Which program, by the GPU's maker** (2026-11-21; `mul_mat_mobile_columns_for`
    in the patch). Build 270 lost the S25's device on its first encoder work: the
    flash attention written out (loops unrolled, 3-4 times faster on Intel's GPUs)
    is too much for Adreno's compiler. So Intel's GPUs take the written-out one,
    the 8-bit multiply (10-25% faster there; 2.7 times slower on the S25) and 4
    columns a thread; all others the attention as loops, the f32 multiply and 8
    columns. A minute of Hebrew on the S25, beam 5, the decoder on the CPU: WebGPU
    20.8 and 24.8 s against OpenCL's 20.7 and 22.9 s, the same 126 words. A trial
    that failed is tried again when the app is updated.
23. **Phones we don't have, on Firebase Test Lab; Mali; accuracy or speed**
    (2026-11-21). `scripts/test-lab.sh` runs the benchmark as a user would
    (androidTest TrialOnPhones, kind lab-phones) or only the encoder's GPU programs,
    each version of them (ProgramsOnPhones, kind lab-programs), on Test Lab's
    phones: one (the Pixel 8a) unless others are named, capped at 20 minutes ($5 an
    hour). Ten phones, one of each GPU in Samsungs and Pixels, the trial at 271:
    Galaxy S24 (Exynos, Xclipse 940) 136 s, S25 143 s, A56 (Xclipse 540) 302 s,
    Pixel 10 (PowerVR) 751 s, Pixel 8a (Mali-G715) 679 s; the Pixel 6, 7 and A54
    (Mali) timed out; the S23 (Adreno 740) stalled; the A16 cannot run Turbo. On the
    8a the attention as loops took 375 ms where the written-out one took 39: so
    Mali (vendor "arm") takes the written-out attention, 4 columns a thread (8 x 4:
    a quarter faster than 8 x 8; 4 x 4 no faster) and the f32 multiply. The 8a then:
    392 s, of which the encoder 231 (17 windows at 13.6 s; the S25's: 3.4 s) and the
    decoder on its CPU 170. Greedy there: 206 s (fewer windows too), 3 words of 536
    different. So Settings offers accuracy (beam 5 where the GPU runs, the default)
    or speed (greedy everywhere: `Store.decoding`, onDeviceModel's `decoding`). The
    multiply's sums in f16 a block at a time (GGML_WEBGPU_MOBILE_HALF) were 8-20%
    faster on the 8a and as accurate against the CPU, but greedy with them took 372
    s, re-decoding far more (4624 batched steps against 299; the phone hot from the
    run before): off until a cool run tells the two apart.

24. **OpenCL on Galaxy S23s and later, no other phones** (2026-11-24, never
    released: decision 25 replaced it the same day;
    `Turbo.supported`, `TurboGpu.LEVELS`). Turbo is worth it where the GPU runs
    it: on the S25's Adreno 830 through OpenCL, 0.6 of the recording's length with
    beam search, against about 1.1 on its CPU greedily (and mid-range CPUs are
    slower). OpenCL is efficient there and already done; ggml-opencl takes Adreno
    GPUs alone. So Turbo is offered on Samsung's S series from the S23 (model
    numbers SM-S91x, S92x, S93x and on, and the FEs S711, S721, S731), Android 13
    on, 8 GB, where the SoC is Qualcomm's (`Build.SOC_MANUFACTURER` QTI) and
    ggml finds an Adreno through OpenCL. Every S23 is Snapdragon (Adreno 740; the
    S23 FE: 730 or Exynos), the S25s too (Adreno 830; not the S25 FE); the S24 and
    S24+ are Exynos (Xclipse 940) in many countries, Europe's among them, and
    Snapdragon in others; the S24 Ultra is Snapdragon everywhere. Exynos phones and all others keep the zipformer, and a phone that
    had Turbo before lets its downloads go (about 900 MB). The check stays, OpenCL
    its one level (ladder 10, so earlier verdicts are checked again); WebGPU and
    Vulkan are out of the build (gradle `-PturboWebgpu=ON`, `-PturboVulkan=ON`
    bring them back), with the Lab's WebGPU trial and its programs' test
    (decisions 21-23); their code and patches stay, and the browser's Turbo
    (`/lab/turbo`) keeps WebGPU. The S23 never ran Turbo on OpenCL: its WebGPU
    trial stalled on Test Lab, which says nothing of OpenCL.

25. **WebGPU with our programs, the one GPU path; OpenCL deprecated** (2026-11-24,
    build 274 on internal testing only; decision 26 replaced it the next day;
    `TurboGpu.LEVELS`, `Turbo.supported`). The Lab's WebGPU trial (decisions
    21-23) becomes Turbo's GPU path: the same switches (`GGML_WEBGPU_MOBILE`, no
    subgroups or subgroup matrices, no dot product, 8 programs a submission), now
    behind the check (decision 10), its one level (ladder 11). On the Galaxy S25,
    the benchmark (297 s of Hebrew) greedily: WebGPU 98.1 s (2.57% WER; the
    user's run from the Lab, app on the screen), OpenCL 88.8 s (screen off, over
    adb); with beam search OpenCL 107.5 s; a minute over adb, beam 5, WebGPU 20.8
    and 24.8 s against OpenCL's 20.7 and 22.9 s, the same words. About even on
    Adreno; WebGPU also runs Exynos' Xclipse (an S24 on Test Lab: 136 s) and Mali,
    and is the path the browser and iPhones can share. So Turbo is offered on
    every Galaxy S23 and later, Exynos ones too (decision 24's rule without the
    Snapdragon test); the GPU itself is the check's to judge, in the background,
    and a phone whose GPU fails it transcribes on the CPU. OpenCL and Vulkan are
    out of the build (gradle `-PturboOpencl=ON`, `-PturboVulkan=ON` bring them
    back); their code and patches stay. Open: the S23 (Adreno 740), whose trial
    stalled on Test Lab at build 271, with decision 22's programs; the check, its
    watchdog included, is what stands between an S23 and a stalled recording (on
    the CPU then).

26. **OpenCL first, WebGPU where it is not** (2026-11-25; `TurboGpu.LEVELS`,
    ladder 12). Measured on the Galaxy S25 over adb, the benchmark with beam
    search, phone cool (33 °C) and screen off: OpenCL 107.5 s (98.6 s
    transcribing), WebGPU 155.1 s (145.2 s); straight after each one's check,
    OpenCL 144.6 s (from 32.6 °C) and WebGPU 128.0 s (from 25.5 °C); greedy, OpenCL
    88.8 s, WebGPU 98.1 s (the Lab, screen on). The same words each time, and no
    progress event going back within its phase. A minute's audio had them even;
    over five, OpenCL is about a third faster. So OpenCL where ggml has it (Adreno),
    WebGPU with our programs for the rest (Exynos' Xclipse) and for a Snapdragon
    whose OpenCL fails its check. The phone's libOpenCL.so is not opened at all
    (opencl.c, `IVRIT_NO_OPENCL`, set by `TurboGpu.early`) on phones without a
    Snapdragon, or once this system build's check is past OpenCL, so a driver that
    fails as ggml first looks cannot keep a phone from WebGPU. Both backends in the
    library (Vulkan out); Turbo offered on Galaxy S23s and later, as in 25.

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
