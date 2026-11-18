"""whisperwords (shell/native/whisperwords) against faster-whisper's add_word_timestamps:
the same tokens and alignment times in, the same words, times and segment edges out.

    python3 shell/native/tests/test_whisperwords.py

Needs faster-whisper (1.1.1) with ivrit.ai's Turbo tokenizer in the Hugging Face
cache (ivrit-ai/whisper-large-v3-turbo-ct2), numpy and a C compiler. The alignment
itself (CTranslate2's) is stood in for by one giving each token the time whisper.cpp
would have: whisperwords' part is everything after it.
"""

import ctypes
import os
import random
import subprocess
import sys
import tempfile
from types import SimpleNamespace

import numpy as np
import tokenizers
from faster_whisper.tokenizer import Tokenizer
from faster_whisper.transcribe import WhisperModel
from faster_whisper.utils import get_end
from huggingface_hub import snapshot_download

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "whisperwords", "whisperwords.c")


class Token(ctypes.Structure):
    _fields_ = [("text", ctypes.c_char_p), ("t_dtw", ctypes.c_long)]


class Segment(ctypes.Structure):
    _fields_ = [("t0", ctypes.c_long), ("t1", ctypes.c_long), ("n_tokens", ctypes.c_size_t)]


class Word(ctypes.Structure):
    _fields_ = [("text", ctypes.c_char_p), ("start", ctypes.c_double), ("end", ctypes.c_double)]


class Result(ctypes.Structure):
    _fields_ = [("start", ctypes.c_double), ("end", ctypes.c_double), ("words", ctypes.POINTER(Word)),
                ("n_words", ctypes.c_size_t), ("keep", ctypes.c_bool)]


out = os.path.join(tempfile.mkdtemp(), "libwhisperwords.so")
subprocess.check_call(["cc", "-std=c11", "-O2", "-ffp-contract=off", "-shared", "-fPIC", "-o", out, SRC, "-lm"])
lib = ctypes.CDLL(out)
lib.ww_window.argtypes = [ctypes.POINTER(Token), ctypes.POINTER(Segment), ctypes.c_size_t, ctypes.c_long,
                          ctypes.POINTER(ctypes.c_double), ctypes.POINTER(Result)]
lib.ww_window.restype = ctypes.c_bool
lib.ww_free.argtypes = [ctypes.POINTER(Result), ctypes.c_size_t]

path = snapshot_download("ivrit-ai/whisper-large-v3-turbo-ct2", local_files_only=True)
hf = tokenizers.Tokenizer.from_file(os.path.join(path, "tokenizer.json"))
tok = Tokenizer(hf, True, task="transcribe", language="he")


def byte_decoder():
    # GPT-2's bytes_to_unicode, inverted: a byte-level token's characters to its bytes.
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {chr(c): b for b, c in zip(bs, cs)}


BYTES = byte_decoder()


def token_bytes(i):
    return bytes(BYTES[c] for c in hf.id_to_token(i))


def model_stub(t_dtw, seek):
    def align(encoder_output, sot, text_tokens, num_frames, median_filter_width=7):
        out = []
        for tokens in text_tokens:
            times = [0] + [(t - seek) // 2 for t in t_dtw[:len(tokens)]]
            out.append(SimpleNamespace(alignments=[(r, times[r]) for r in range(len(tokens) + 1)],
                                       text_token_probs=[0.5] * len(tokens)))
        return out
    stub = SimpleNamespace(model=SimpleNamespace(align=align), frames_per_second=100, tokens_per_second=50)
    stub.find_alignment = lambda *a, **k: WhisperModel.find_alignment(stub, *a, **k)
    return stub


def python_window(windows_tokens, segs, t_dtw, seek, last_speech):
    stub = model_stub(t_dtw, seek)
    current = []
    at = 0
    for t0, t1, n in segs:
        current.append({"seek": seek, "start": seek / 100 + ((t0 - seek) // 2) * 0.02,
                        "end": seek / 100 + ((t1 - seek) // 2) * 0.02, "tokens": windows_tokens[at:at + n]})
        at += n
    WhisperModel.add_word_timestamps(stub, [current], tok, None, 3000, "\"'“¿([{-", "\"'.。,，!！?？:：”)]}、",
                                     last_speech_timestamp=last_speech)
    end = get_end(current)
    keep = [not (s["start"] == s["end"] or not tok.decode(s["tokens"]).strip()) for s in current]
    return current, keep, last_speech if end is None else end


def c_window(window_tokens, segs, t_dtw, seek, last_speech):
    tokens = (Token * max(1, len(window_tokens)))(*[Token(token_bytes(t), d) for t, d in zip(window_tokens, t_dtw)])
    segments = (Segment * len(segs))(*[Segment(t0, t1, n) for t0, t1, n in segs])
    results = (Result * len(segs))()
    last = ctypes.c_double(last_speech)
    assert lib.ww_window(tokens, segments, len(segs), seek, ctypes.byref(last), results)
    out = []
    for r in results:
        words = [(r.words[i].text.decode("utf-8"), r.words[i].start, r.words[i].end) for i in range(r.n_words)]
        out.append((r.start, r.end, words, r.keep))
    lib.ww_free(results, len(segs))
    return out, last.value


PIECES = ["שלום", "מה נשמע", "אנחנו לא חיים בעולם מתוקן", "ב-2018", "98.", "\"מיינדסט\"", "(כן)", "ד״ר", "צה״ל",
          "OK", "Dr. Smith", "...", "?", "!", ",", "-", "😀", "שֶׁלֹּא", "1,000", "—", "“ציטוט”", "'", "וכו'", "50%"]

rng = random.Random(3)
failures = 0
cases = 0
for case in range(3000):
    text = "".join((" " if rng.random() < 0.8 else "") + rng.choice(PIECES) for _ in range(rng.randint(0, 40)))
    ids = [i for i in hf.encode(text, add_special_tokens=False).ids if i < tok.eot]
    seek = rng.choice([0, 3000, 2468 * 2, 100000])
    n_frames = 3000
    # Monotone alignment times, some words of no length, some long.
    times = sorted(rng.choice([rng.randint(0, n_frames // 2 - 1), rng.randint(0, 40)]) for _ in ids)
    if rng.random() < 0.3:
        times = sorted(rng.randint(0, n_frames // 2 - 1) for _ in ids)
    t_dtw = [seek + 2 * t for t in times]
    # Split the tokens into 1-4 segments, their timestamps roughly around them.
    n_segs = rng.randint(1, 4)
    cuts = sorted(rng.sample(range(len(ids) + 1), min(len(ids) + 1, n_segs - 1))) if ids else []
    bounds = [0] + cuts + [len(ids)]
    segs = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        lo = times[a] if a < len(times) else n_frames // 2 - 1
        hi = times[b - 1] if 0 < b <= len(times) and b > a else lo
        t0 = seek + 2 * max(0, lo - rng.randint(0, 60))
        t1 = seek + 2 * min(n_frames // 2, hi + rng.randint(0, 60))
        segs.append((t0, t1, b - a))
    last_speech = rng.choice([0.0, seek / 100 - rng.uniform(0, 5), seek / 100 + rng.uniform(0, 2)])
    cases += 1
    want, keep, want_last = python_window(ids, segs, t_dtw, seek, last_speech)
    got, got_last = c_window(ids, segs, t_dtw, seek, last_speech)
    problem = None
    for k, (s, (start, end, words, kept)) in enumerate(zip(want, got)):
        ww = [(w["word"], w["start"], w["end"]) for w in s.get("words", [])]
        if len(ww) != len(words):
            problem = f"segment {k}: {len(ww)} words vs {len(words)}\n     {ww}\n     {words}"
        else:
            for p, q in zip(ww, words):
                if p[0] != q[0] or p[1] != q[1] or p[2] != q[2]:
                    problem = f"segment {k}: {p} vs {q}"
                    break
        if problem is None and (s["start"] != start or s["end"] != end):
            problem = f"segment {k} edges: {s['start']}, {s['end']} vs {start}, {end}"
        if problem is None and keep[k] != kept:
            problem = f"segment {k} kept: {keep[k]} vs {kept}"
        if problem:
            break
    if problem is None and want_last != got_last:
        problem = f"last speech {want_last} vs {got_last}"
    if problem:
        failures += 1
        if failures <= 5:
            print(f"FAIL case {case}: {text!r}\n     {problem}")

print(f"{cases - failures}/{cases} windows the same as faster-whisper's")
sys.exit(1 if failures else 0)
