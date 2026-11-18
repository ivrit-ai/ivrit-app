"""stablets (shell/native/stablets) against stable-ts itself: the same words and sound
in, the same segments, words and times out, to the millisecond stable-ts rounds to.

    python3 shell/native/tests/test_stablets.py [faster-whisper.json audio.wav ...]

Needs stable-ts (2.19), numpy, soundfile and a C compiler. With pairs of a
faster-whisper transcript ({"segments": [{"words": [...]}]}) and its 16 kHz sound,
those are checked too.
"""

import ctypes
import json
import os
import random
import subprocess
import sys
import tempfile
import warnings

import numpy as np

warnings.filterwarnings("ignore")
import stable_whisper  # noqa: E402
from stable_whisper.stabilization.nonvad import audio2timings  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "stablets", "stablets.c")


class Word(ctypes.Structure):
    _fields_ = [("text", ctypes.c_char_p), ("start", ctypes.c_double), ("end", ctypes.c_double)]


def build():
    out = os.path.join(tempfile.mkdtemp(), "libstablets.so")
    subprocess.check_call(["cc", "-std=c11", "-O2", "-ffp-contract=off", "-shared", "-fPIC", "-o", out, SRC, "-lm"])
    lib = ctypes.CDLL(out)
    lib.st_new.restype = ctypes.c_void_p
    lib.st_free.argtypes = [ctypes.c_void_p]
    lib.st_add_segment.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p), ctypes.POINTER(ctypes.c_double),
                                   ctypes.POINTER(ctypes.c_double), ctypes.c_size_t]
    lib.st_add_segment.restype = ctypes.c_bool
    lib.st_finish.argtypes = [ctypes.c_void_p, ctypes.c_double]
    lib.st_segments.argtypes = [ctypes.c_void_p]
    lib.st_segments.restype = ctypes.c_size_t
    lib.st_segment.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    lib.st_segment.restype = ctypes.POINTER(Word)
    lib.st_silence.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_double,
                               ctypes.POINTER(ctypes.POINTER(ctypes.c_double)), ctypes.POINTER(ctypes.POINTER(ctypes.c_double)),
                               ctypes.POINTER(ctypes.c_size_t)]
    lib.st_silence.restype = ctypes.c_bool
    lib.st_suppress_silence.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double),
                                        ctypes.c_size_t, ctypes.c_double, ctypes.c_double, ctypes.c_bool]
    lib.st_regroup.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    lib.st_regroup.restype = ctypes.c_bool
    lib.st_round.argtypes = [ctypes.c_double, ctypes.c_int]
    lib.st_round.restype = ctypes.c_double
    return lib


lib = build()
failures = 0


def check(name, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     {detail}"))


def silence_c(pcm):
    pcm = np.ascontiguousarray(pcm, dtype=np.float32)
    starts, ends, count = ctypes.POINTER(ctypes.c_double)(), ctypes.POINTER(ctypes.c_double)(), ctypes.c_size_t()
    assert lib.st_silence(pcm.ctypes.data_as(ctypes.POINTER(ctypes.c_float)), len(pcm), 20, 5, 0.0,
                          ctypes.byref(starts), ctypes.byref(ends), ctypes.byref(count))
    if count.value == 0:
        return None
    return np.array(starts[:count.value]), np.array(ends[:count.value])


def silence_py(pcm):
    import torch
    return audio2timings(torch.from_numpy(np.ascontiguousarray(pcm, dtype=np.float32)), q_levels=20, k_size=5, sr=16000)


def run_c(segments, pcm, algo):
    r = lib.st_new()
    for s in segments:
        words = s["words"]
        texts = (ctypes.c_char_p * max(1, len(words)))(*[w["word"].encode() for w in words])
        starts = (ctypes.c_double * max(1, len(words)))(*[w["start"] for w in words])
        ends = (ctypes.c_double * max(1, len(words)))(*[w["end"] for w in words])
        assert lib.st_add_segment(r, texts, starts, ends, len(words))
    lib.st_finish(r, 0.0)
    if pcm is not None:
        t = silence_c(pcm)
        if t is not None:
            s, e = (np.ascontiguousarray(x, dtype=np.float64) for x in t)
            lib.st_suppress_silence(r, s.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
                                    e.ctypes.data_as(ctypes.POINTER(ctypes.c_double)), len(s), 0.1, 0.1, True)
    if algo is not None:
        assert lib.st_regroup(r, algo.encode())
    out = []
    for i in range(lib.st_segments(r)):
        n = ctypes.c_size_t()
        w = lib.st_segment(r, i, ctypes.byref(n))
        out.append([(w[j].text.decode(), w[j].start, w[j].end) for j in range(n.value)])
    lib.st_free(r)
    return out


def run_py(segments, pcm, algo):
    import copy
    result = stable_whisper.WhisperResult({"segments": copy.deepcopy(segments)}, force_order=True)
    if pcm is not None:
        import torch
        result.adjust_by_silence(torch.from_numpy(np.ascontiguousarray(pcm, dtype=np.float32)), False, q_levels=20, k_size=5,
                                 sample_rate=16000, min_word_dur=None, word_level=True, nonspeech_error=0.1,
                                 use_word_position=True, verbose=None)
    if algo is not None:
        result.regroup(algo)
    return [[(w.word, w.start, w.end) for w in s.words] for s in result.segments]


def same(a, b):
    if len(a) != len(b):
        return False, f"{len(a)} segments vs {len(b)}"
    for i, (x, y) in enumerate(zip(a, b)):
        if len(x) != len(y):
            return False, f"segment {i}: {len(x)} words vs {len(y)}: {x} / {y}"
        for p, q in zip(x, y):
            if p[0] != q[0] or abs(p[1] - q[1]) > 1e-9 or abs(p[2] - q[2]) > 1e-9:
                return False, f"segment {i}: {p} vs {q}"
    return True, ""


# numpy's round, ties and all: faster-whisper's times are numpy floats.
rng = random.Random(7)
values = [0.0005, 0.0015, 0.0025, 1.2345, 2.675, 0.1 + 0.2, 1e-4, 123.4565] + [rng.uniform(0, 3000) for _ in range(5000)]
check("st_round is numpy's round(x, 3)", all(lib.st_round(v, 3) == round(np.float64(v), 3) for v in values))
check("st_round is numpy's round(x, 2)", all(lib.st_round(v, 2) == round(np.float64(v), 2) for v in values))


def noise_with_gaps(rng, seconds):
    n = int(seconds * 16000)
    pcm = (np.random.default_rng(rng.randrange(1 << 30)).standard_normal(n) * rng.uniform(0.01, 0.3)).astype(np.float32)
    t = 0
    while t < n:
        t += int(rng.uniform(0.2, 3) * 16000)
        gap = int(rng.uniform(0.02, 1.2) * 16000)
        pcm[t:t + gap] *= rng.choice([0, 1e-4, 1e-3, 0.02])
        t += gap
    return pcm


# The silence found in sound: synthetic, then real.
ok = True
for k in range(40):
    pcm = noise_with_gaps(rng, rng.uniform(0.01, 40))
    a, b = silence_c(pcm), silence_py(pcm)
    if (a is None) != (b is None) or (a is not None and not (np.array_equal(a[0], b[0]) and np.array_equal(a[1], b[1]))):
        ok = False
        print("  differs:", k, None if a is None else len(a[0]), None if b is None else len(b[0]))
check("silence: synthetic sound", ok)
check("silence: none in pure silence", (silence_c(np.zeros(16000)) is None) == (silence_py(np.zeros(16000)) is None))

HEBREW = ["שלום", "מה", "נשמע", "בסדר", "תודה", "אני", "חושבת", "ש", "זה", "עדיין", "מאוד", "רלוונטי", "ב-2018", "Dr.", "3.",
          "A.B.", "ok", "ה-", "\"מיינדסט\"", "(כן)", "יפה"]
ENDINGS = ["", "", "", "", ",", ".", "?", "!", "...", "。", "，", ":", "\""]


def random_result(rng, seconds):
    segments, t = [], rng.uniform(0, 1)
    while t < seconds:
        words = []
        for _ in range(rng.randint(0 if rng.random() < 0.03 else 1, 30)):
            start = t + rng.choice([0, 0, rng.uniform(-0.3, 0), rng.uniform(0, 1.5)])
            end = start + rng.choice([0, rng.uniform(0, 0.1), rng.uniform(0.05, 1.2), rng.uniform(1, 4)])
            if rng.random() < 0.02:
                end = start - rng.uniform(0, 0.5)
            text = " " + rng.choice(HEBREW) + rng.choice(ENDINGS)
            # numpy floats, as faster-whisper's are (round() on them is numpy's).
            words.append({"word": text, "start": round(np.float64(start), 2), "end": round(np.float64(end), 2),
                          "probability": 0.9})
            t = max(t, end)
        segments.append({"start": words[0]["start"] if words else t, "end": t, "text": "".join(w["word"] for w in words),
                         "words": words})
        t += rng.uniform(0, 2)
    return segments


ALGOS = ["da", "sg=.5", "sp=.* /。/?/？", "sp=,* /，++++50", "sl=70", "cm", "isp_sp=.* /。/?/？", "sl=20", "sl=+5",
         "sl=30+4", "sl=40++0", "sp=.", "cm=2+1.5", "cm=2.5++0", "cm=3++1", "isp_sg=.1_sl=10", "sp=,+++3", "sp=?+++++2.5"]
for algo in ALGOS:
    ok, why = True, ""
    for k in range(25):
        res = random_result(rng, rng.uniform(1, 120))
        pcm = noise_with_gaps(rng, (res[-1]["end"] if res else 1) + 2) if k % 2 == 0 else None
        try:
            want = run_py(res, pcm, algo)
        except Exception as e:  # stable-ts refusing an input (unsorted after force_order) is not ours
            if "Unsorted" in type(e).__name__:
                continue
            raise
        good, why = same(run_c(res, pcm, algo), want)
        if not good:
            ok = False
            break
    check(f"regroup {algo!r} with silence (random results)", ok, why)

# Real transcripts.
for path, audio in zip(sys.argv[1::2], sys.argv[2::2]):
    import soundfile as sf
    pcm, sr = sf.read(audio, dtype="float32")
    assert sr == 16000
    segs = json.load(open(path))["segments"]
    for s in segs:
        for w in s["words"]:
            w["start"], w["end"] = np.float64(w["start"]), np.float64(w["end"])
    good, why = same(run_c(segs, pcm, "da"), run_py(segs, pcm, "da"))
    check(f"{os.path.basename(path)}: adjust_by_silence + regroup('da')", good, why)

print("all passed" if failures == 0 else f"{failures} failed")
sys.exit(1 if failures else 0)
