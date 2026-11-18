"""speakers (shell/native/speakers) against SpeechBrain and ivrit.ai's diarization:
the same features, nearly the same voice prints, the same clustering of the same
prints, and the same speakers in the end.

    python3 shell/native/tests/test_speakers.py GGML_BUILD MODEL WAV SEGMENTS.json [...]

GGML_BUILD: a CMake build of whisper.cpp (its ggml/src/libggml*.a); MODEL: the file
scripts/speaker_model.py makes; WAV (16 kHz mono, 16-bit) and SEGMENTS.json
([{"start", "end"}, ...]: a transcript's segments, as stable-ts cuts them) in pairs.
Needs ivrit (its diarization), SpeechBrain with spkrec-ecapa-voxceleb cached,
scikit-learn, numpy, soundfile and a C compiler.
"""

import ctypes
import json
import os
import subprocess
import sys
import tempfile
import warnings

import numpy as np

warnings.filterwarnings("ignore")
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from ivrit.diarization import IvritDiarizationEngine  # noqa: E402
from speechbrain.inference.speaker import EncoderClassifier  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
NATIVE = os.path.join(HERE, "..")
GGML_SRC = os.path.join(NATIVE, "..", "android", "app", "src", "main", "cpp", "whisper.cpp", "ggml", "include")
build, model, pairs = sys.argv[1], sys.argv[2], list(zip(sys.argv[3::2], sys.argv[4::2]))
tmp = tempfile.mkdtemp()

# The C parts without ggml through ctypes; the whole of it through speakers_cli.
lib_path = os.path.join(tmp, "libspeakers.so")
subprocess.check_call(["cc", "-std=c11", "-O2", "-shared", "-fPIC", "-o", lib_path, os.path.join(NATIVE, "speakers", "features.c"),
                       os.path.join(NATIVE, "speakers", "cluster.c"), "-lm"])
lib = ctypes.CDLL(lib_path)
lib.sp_features.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
lib.sp_features.restype = ctypes.POINTER(ctypes.c_float)
lib.sp_cluster.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.POINTER(ctypes.c_bool), ctypes.POINTER(ctypes.c_bool),
                           ctypes.c_size_t, ctypes.POINTER(ctypes.c_int), ctypes.c_void_p, ctypes.c_void_p]
cli = os.path.join(tmp, "speakers_cli")
objs = []
for src in ("speakers/features.c", "speakers/cluster.c", "tests/speakers_cli.c"):
    o = os.path.join(tmp, os.path.basename(src) + ".o")
    subprocess.check_call(["cc", "-std=c11", "-O2", "-I", os.path.join(NATIVE, "speakers"), "-c", os.path.join(NATIVE, src), "-o", o])
    objs.append(o)
o = os.path.join(tmp, "ecapa.o")
subprocess.check_call(["c++", "-std=c++17", "-O2", "-I", GGML_SRC, "-c", os.path.join(NATIVE, "speakers", "ecapa.cpp"), "-o", o])
objs.append(o)
libs = [os.path.join(build, "ggml", "src", f) for f in ("libggml.a", "libggml-cpu.a", "libggml-base.a")]
subprocess.check_call(["c++", "-o", cli] + objs + libs + ["-lpthread", "-lm"])

clf = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir=os.path.join(tmp, "ecapa"),
                                     run_opts={"device": "cpu"})
clf.mods.eval()
eng = object.__new__(IvritDiarizationEngine)  # its methods; its audio loading needs ffmpeg
failures = 0


def check(name, ok, detail=""):
    global failures
    failures += not ok
    print(("ok   " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))


def ivrit_labels(prints, clustered, missing):
    """IvritDiarizationEngine's clustering of these prints, as _identify_speakers_with_optimization does it."""
    emb = np.array([p for p, c, m in zip(prints, clustered, missing) if c and not m], dtype=np.float32)
    best, best_score = None, -1
    for k in range(1, min(20, len(emb)) + 1):
        for _, r in eng._try_clustering_methods(emb, k).items():
            if r["composite_score"] > best_score:
                best_score, best = r["composite_score"], r["labels"]
    items = [(i, None, None if m else np.asarray(p, dtype=np.float32)) for i, (p, m) in enumerate(zip(prints, missing))]
    return eng._assign_speakers_to_all_segments(items, best, emb)


def c_labels(prints, clustered, missing):
    n = len(prints)
    flat = np.ascontiguousarray(np.array([np.zeros(192) if p is None else p for p in prints]), dtype=np.float32)
    labels = (ctypes.c_int * n)()
    lib.sp_cluster(flat.ctypes.data_as(ctypes.POINTER(ctypes.c_float)), (ctypes.c_bool * n)(*clustered),
                   (ctypes.c_bool * n)(*missing), n, labels, None, None)
    return list(labels)


def agreement(a, b, weights):
    """The share (weighted) of segments the two labelings put together alike, speakers matched best."""
    from scipy.optimize import linear_sum_assignment
    ka, kb = max(a) + 2, max(b) + 2
    c = np.zeros((ka, kb))
    for x, y, w in zip(a, b, weights):
        c[x + 1, y + 1] += w
    r, s = linear_sum_assignment(-c)
    return c[r, s].sum() / c.sum()


def same_partition(a, b):
    return len(set(zip(a, b))) == len(set(a)) == len(set(b))


# Clustering on the same prints, synthetic: speakers as clouds of prints. The same
# speakers, always; numbered the same unless two methods found the same partition,
# where float32 noise in scikit-learn's scores picks which one's numbering wins.
rng = np.random.default_rng(5)
partitions = numbering = 0
trials = 60
for t in range(trials):
    k = rng.integers(1, 7)
    centers = rng.normal(0, 10, (k, 192))
    n = int(rng.integers(3, 120))
    prints = [centers[rng.integers(k)] + rng.normal(0, rng.uniform(1, 12), 192) for _ in range(n)]
    clustered = [bool(rng.random() < 0.8) for _ in range(n)]
    clustered[0] = True
    missing = [False] * n
    want, got = ivrit_labels(prints, clustered, missing), c_labels(prints, clustered, missing)
    partitions += same_partition(want, got)
    numbering += want == got
check(f"clustering synthetic prints: ivrit's speakers in {partitions}/{trials} (numbered alike in {numbering})",
      partitions == trials)

for wav, segments_path in pairs:
    name = os.path.basename(wav)
    pcm, sr = sf.read(wav, dtype="int16")
    assert sr == 16000 and pcm.ndim == 1
    wave = torch.from_numpy(pcm.astype(np.float32) / 32768.0)[None]
    segs = json.load(open(segments_path))
    # SpeechBrain's prints, the way ivrit takes each segment's sound.
    ref, missing, clustered = [], [], []
    feat_err = 0.0
    for i, s in enumerate(segs):
        x, ok = eng._extract_segment_audio(wave, sr, s["start"], s["end"])
        if x.shape[1] == 0 or not ok:
            ref.append(None), missing.append(True), clustered.append(False)
            continue
        with torch.no_grad():
            ref.append(clf.encode_batch(x).squeeze().numpy())
            if i % 7 == 0:
                want = clf.mods.mean_var_norm(clf.mods.compute_features(x), torch.ones(1)).squeeze(0).numpy()
                xs = np.ascontiguousarray(x[0].numpy())
                frames = ctypes.c_size_t()
                got = lib.sp_features(xs.ctypes.data_as(ctypes.POINTER(ctypes.c_float)), len(xs), ctypes.byref(frames))
                got = np.ctypeslib.as_array(got, shape=(frames.value, 80)).copy()
                feat_err = max(feat_err, float(np.abs(got - want).max()) if got.shape == want.shape else np.inf)
        missing.append(False)
        clustered.append(s["end"] - s["start"] >= 1.0)
    check(f"{name}: features are SpeechBrain's", feat_err < 2e-3, f"largest difference {feat_err:.2g} dB")
    # The C prints, from the model file.
    out = json.loads(subprocess.check_output([cli, model, wav, segments_path, "8"]))
    mine = [None if s["print"] is None else np.array(s["print"]) for s in out["segments"]]
    cos = [float(a @ b / np.linalg.norm(a) / np.linalg.norm(b)) for a, b in zip(ref, mine) if a is not None and b is not None]
    check(f"{name}: voice prints close to SpeechBrain's ({os.path.basename(model)})", min(cos) > 0.98,
          f"cosine mean {np.mean(cos):.5f}, worst {min(cos):.5f}, {len(cos)} segments")
    # Clustering SpeechBrain's prints: C against ivrit's code.
    want = ivrit_labels(ref, clustered, missing)
    got = c_labels(ref, clustered, missing)
    check(f"{name}: clustering SpeechBrain's prints gives ivrit's speakers", same_partition(want, got),
          f"{len(set(want) - {-1})} speakers vs {len(set(got) - {-1})}, {sum(a == b for a, b in zip(want, got))}/{len(want)} alike")
    # And the whole of it: the C prints, clustered in C, against ivrit end to end.
    dur = [s["end"] - s["start"] for s in segs]
    a = agreement(want, [s["label"] for s in out["segments"]], dur)
    check(f"{name}: speakers as ivrit's ({out['speakers']} found, ivrit {len(set(want) - {-1})})", a >= 0.97,
          f"{a * 100:.1f}% of segment time alike")

print("all passed" if failures == 0 else f"{failures} failed")
sys.exit(1 if failures else 0)
