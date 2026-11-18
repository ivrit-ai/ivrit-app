#!/usr/bin/env python3
"""The speaker model for the apps' on-device speakers: SpeechBrain's ECAPA-TDNN
(speechbrain/spkrec-ecapa-voxceleb), the model ivrit.ai's diarization tells voices
apart with, in the file shell/native/speakers reads and runs on ggml.

SpeechBrain publishes it as a PyTorch checkpoint. This reads it without PyTorch
(the checkpoint is a zip: a pickle naming each tensor's raw bytes), pinned and
checked against its hash, and writes it as the phone runs it: each convolution as
one matrix per tap, each batch norm folded into a scale and a shift (its running
statistics, as in evaluation), and the large matrices quantized (q8_0, as
turbo_model.py does whisper.cpp's).

The files are on Hugging Face, ivrit-ai/spkrec-ecapa-voxceleb-ggml (ecapa-q8_0.bin,
ecapa-f16.bin, with a model card), where the apps download them from, pinned to a
revision and checked by hash (Speakers.java): a new version made here is uploaded
there, and the apps pointed at its revision.

<out>/speakers-ecapa-<dtype>.bin, then <out>/speakers-ecapa-<dtype>.json ({bytes,
sha256}) last.

    python3 scripts/speaker_model.py [--source URL-or-file] [--out /tmp/turbo-models] [q8_0 f16]

The file: "IVSP", version 1, the number of tensors (u32 each), then each tensor:
its name's length and name, its ggml type (0 f32, 1 f16, 8 q8_0), its number of
dimensions and each (ggml's order: the fastest first), its data. Little-endian.

Needs numpy.
"""

import argparse
import collections
import hashlib
import io
import json
import os
import pickle
import struct
import sys
import time
import urllib.request
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from turbo_model import BLOCK, quantize_q8_0  # noqa: E402

REVISION = "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286"
SOURCE = f"https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb/resolve/{REVISION}/embedding_model.ckpt"
SOURCE_SHA256 = "0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2"

MAGIC, VERSION = b"IVSP", 1
F32, F16, Q8_0 = 0, 1, 8
EPS = 1e-5  # SpeechBrain's BatchNorm1d


def load_checkpoint(data: bytes) -> dict:
    """torch.save's zip, read with numpy: {name: array}."""
    z = zipfile.ZipFile(io.BytesIO(data))
    pkl = next(n for n in z.namelist() if n.endswith("/data.pkl"))
    root = pkl[: -len("data.pkl")]
    dtypes = {"FloatStorage": np.float32, "LongStorage": np.int64, "HalfStorage": np.float16, "DoubleStorage": np.float64}

    def rebuild(storage, offset, size, stride, *rest):
        a = storage[offset:]
        if not size:
            return a[:1].reshape(()).copy()
        return np.lib.stride_tricks.as_strided(a, size, [s * a.itemsize for s in stride]).copy()

    class Unpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if (module, name) == ("torch._utils", "_rebuild_tensor_v2"):
                return rebuild
            if module == "torch" and name in dtypes:
                return dtypes[name]
            if (module, name) == ("collections", "OrderedDict"):
                return collections.OrderedDict
            raise pickle.UnpicklingError(f"unexpected {module}.{name} in the checkpoint")

        def persistent_load(self, pid):
            _, dtype, key, _, _ = pid
            return np.frombuffer(z.read(f"{root}data/{key}"), dtype=dtype)

    return dict(Unpickler(io.BytesIO(z.read(pkl))).load())


def tensors(sd: dict, dtype: str):
    """The checkpoint as the phone's tensors: (name, ggml type, ne, bytes)."""
    big = Q8_0 if dtype == "q8_0" else F16
    out = []

    def f32(name, a):
        a = np.ascontiguousarray(a, dtype=np.float32)
        out.append((name, F32, list(a.shape[::-1]), a.tobytes()))

    def conv(name, prefix):
        # (out, in, taps) -> per tap a matrix (in, out) in ggml's order: taps, out, in.
        w = sd[prefix + ".weight"]
        taps = np.ascontiguousarray(np.transpose(w, (2, 0, 1)), dtype=np.float32)
        cin = taps.shape[2]
        t = big if cin % BLOCK == 0 else F16
        # Blocks of near-zero weights overflow numpy on the way (to a scale of 0, as ggml's do).
        with np.errstate(over="ignore", invalid="ignore"):
            data = quantize_q8_0(taps) if t == Q8_0 else taps.astype("<f2").tobytes()
        out.append((name + ".w", t, [cin, taps.shape[1], taps.shape[0]], data))
        f32(name + ".b", sd[prefix + ".bias"])

    def norm(name, prefix):
        scale = (sd[prefix + ".weight"] / np.sqrt(sd[prefix + ".running_var"] + np.float32(EPS))).astype(np.float32)
        f32(name + ".scale", scale)
        f32(name + ".shift", sd[prefix + ".bias"] - sd[prefix + ".running_mean"] * scale)

    def tdnn(name, prefix):
        conv(name + ".conv", prefix + ".conv.conv")
        norm(name + ".norm", prefix + ".norm.norm")

    tdnn("blocks.0", "blocks.0")
    for b in (1, 2, 3):
        p = f"blocks.{b}"
        tdnn(p + ".tdnn1", p + ".tdnn1")
        for i in range(7):
            tdnn(f"{p}.res2net.{i}", f"{p}.res2net_block.blocks.{i}")
        tdnn(p + ".tdnn2", p + ".tdnn2")
        conv(p + ".se1", p + ".se_block.conv1.conv")
        conv(p + ".se2", p + ".se_block.conv2.conv")
    tdnn("mfa", "mfa")
    tdnn("asp.tdnn", "asp.tdnn")
    conv("asp.conv", "asp.conv.conv")
    norm("asp_bn", "asp_bn.norm")
    conv("fc", "fc.conv")
    return out


def write(path: str, items) -> None:
    with open(path, "wb") as f:
        f.write(MAGIC + struct.pack("<II", VERSION, len(items)))
        for name, t, ne, data in items:
            n = name.encode()
            f.write(struct.pack("<I", len(n)) + n + struct.pack("<II", t, len(ne)) + struct.pack(f"<{len(ne)}I", *ne))
            f.write(data)


def fetch(source: str) -> bytes:
    if not source.startswith("http"):
        with open(source, "rb") as f:
            return f.read()
    for attempt in range(5):
        try:
            with urllib.request.urlopen(source, timeout=120) as r:
                return r.read()
        except Exception as e:  # a dropped download starts over
            if attempt == 4:
                raise
            print(f"speaker model: {e}, starting over", flush=True)
            time.sleep(10 * (attempt + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=SOURCE)
    ap.add_argument("--out", default=os.environ.get("TURBO_MODELS_DIR", "/tmp/turbo-models"))
    ap.add_argument("dtypes", nargs="*", default=["q8_0"])
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    path = lambda d, ext: os.path.join(args.out, f"speakers-ecapa-{d}.{ext}")
    wanted = [d for d in args.dtypes if d in ("q8_0", "f16") and not os.path.exists(path(d, "json"))]
    if not wanted:
        print("speaker model: ready already")
        return
    started = time.time()
    data = fetch(args.source)
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        sys.exit("speaker model: the source's hash is not the pinned one")
    sd = load_checkpoint(data)
    for d in wanted:
        write(path(d, "part"), tensors(sd, d))
        with open(path(d, "part"), "rb") as f:
            sha = hashlib.sha256(f.read()).hexdigest()
        os.replace(path(d, "part"), path(d, "bin"))
        size = os.path.getsize(path(d, "bin"))
        with open(path(d, "json.part"), "w") as f:
            json.dump({"bytes": size, "sha256": sha, "source": REVISION}, f)
        os.replace(path(d, "json.part"), path(d, "json"))
        print(f"speaker model: {d} {size / 1e6:.0f} MB -> {path(d, 'bin')}")
    print(f"speaker model: done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
