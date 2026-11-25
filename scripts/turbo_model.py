#!/usr/bin/env python3
"""ivrit.ai's Turbo model for the Android app's on-device transcription, quantized.

The app transcribes with whisper.cpp (shell/android/app/src/main/cpp), which needs
the model in ggml's format. ivrit-ai publishes it only in f16 (1.6 GB); until the
quantized files are published there too, the app serves them: this re-quantizes
the f16 file, pinned and checked against its hash, into q8_0 and q4_0 (phones with less than 8 GB), in the
background as the server starts (launch.sh), as whisper.cpp's own quantize tool
does (examples/quantize: every 2-D tensor but the positional embeddings; the same
block layouts and rounding, quantize_row_q4_0_ref and quantize_row_q8_0_ref).
q5_1 is not made: dropped for good (docs/turbo-android.md, decision 2).

Each model is <out>/ggml-turbo-<dtype>.bin, and <out>/ggml-turbo-<dtype>.json
({bytes, sha256}) is written last: while it is missing, the model is not ready.
The source is read once, as it downloads, and never kept.

    python3 scripts/turbo_model.py [--source URL-or-file] [--out /tmp/turbo-models] [q4_0 q8_0]

Needs numpy.
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import time
import urllib.request

import numpy as np

REVISION = "2130c78e4a9cb4914cc4df91a1c3031407789705"
SOURCE = f"https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/{REVISION}/ggml-model.bin"
SOURCE_SHA256 = "c8090411113357097bfafc2b8e228ec1639fa7f5fe4ecb5d054ac0ccef8641b1"

GGML_MAGIC = 0x67676D6C
QNT_VERSION = 2  # GGML_QNT_VERSION, written into the file type as whisper.cpp's quantize does
BLOCK = 32
F32, F16 = 0, 1
# ggml's tensor type and the file type it makes (ggml.h).
DTYPES = {"q4_0": (2, 2), "q8_0": (8, 7)}
SKIP = {"encoder.conv1.bias", "encoder.conv2.bias", "encoder.positional_embedding", "decoder.positional_embedding"}
# About a million weights at a time, so even the token embedding stays small in memory.
CHUNK = BLOCK << 15


def quantize_q4_0(a: np.ndarray) -> bytes:
    """quantize_row_q4_0_ref: per 32 weights, an f16 scale and 4-bit values (18 bytes)."""
    a = np.ascontiguousarray(a, dtype=np.float32).reshape(-1, BLOCK)
    # The scale from the weight furthest from zero, with its sign: it becomes -8.
    peak = a[np.arange(a.shape[0]), np.abs(a).argmax(axis=1)]
    d = (peak / np.float32(-8)).astype(np.float32)
    inv = np.where(d != 0, np.float32(1) / np.where(d != 0, d, np.float32(1)), np.float32(0)).astype(np.float32)
    # MIN(15, (int8_t)(x + 8.5f)): x + 8.5 is never negative, so this is floor.
    q = np.minimum(15, (a * inv[:, None] + np.float32(8.5)).astype(np.int8)).astype(np.uint8)
    out = np.empty((a.shape[0], 18), dtype=np.uint8)
    out[:, 0:2] = d.astype("<f2").view(np.uint8).reshape(-1, 2)
    out[:, 2:] = q[:, :16] | (q[:, 16:] << 4)
    return out.tobytes()


def quantize_q8_0(a: np.ndarray) -> bytes:
    """quantize_row_q8_0_ref: per 32 weights, an f16 scale and 8-bit values (34 bytes)."""
    a = np.ascontiguousarray(a, dtype=np.float32).reshape(-1, BLOCK)
    d = (np.abs(a).max(axis=1) / np.float32(127)).astype(np.float32)
    inv = np.where(d != 0, np.float32(1) / np.where(d != 0, d, np.float32(1)), np.float32(0)).astype(np.float32)
    x = a * inv[:, None]
    # roundf: halves away from zero (numpy's round goes to even).
    whole = np.trunc(x)
    q = (whole + np.sign(x) * (np.abs(x - whole) >= 0.5)).astype(np.int8)
    out = np.empty((a.shape[0], 34), dtype=np.uint8)
    out[:, 0:2] = d.astype("<f2").view(np.uint8).reshape(-1, 2)
    out[:, 2:] = q.view(np.uint8)
    return out.tobytes()


QUANTIZE = {"q4_0": quantize_q4_0, "q8_0": quantize_q8_0}


class Reader:
    """The source, read in order as it arrives, hashed on the way."""

    def __init__(self, stream):
        self.stream = stream
        self.sha = hashlib.sha256()
        self.done = 0

    def read(self, n: int, eof_ok: bool = False) -> bytes:
        parts, left = [], n
        while left:
            part = self.stream.read(left)
            if not part:
                if eof_ok and left == n:
                    return b""
                raise EOFError(f"source ended {left} bytes short")
            parts.append(part)
            left -= len(part)
        data = b"".join(parts)
        self.sha.update(data)
        self.done += len(data)
        return data

    def ints(self, n: int) -> tuple:
        return struct.unpack(f"<{n}i", self.read(4 * n))


def convert(reader: Reader, outs: dict) -> None:
    """The whole file, header to last tensor, into every output at once."""
    def write(data: bytes, per_dtype: dict = None):
        for d, f in outs.items():
            f.write(per_dtype[d] if per_dtype else data)

    magic = reader.read(4)
    if struct.unpack("<I", magic)[0] != GGML_MAGIC:
        raise ValueError("not a ggml model")
    write(magic)
    hparams = list(reader.ints(11))
    if hparams[10] % 1000 != F16:
        raise ValueError(f"the source must be f16 (file type {hparams[10]})")
    write(b"", {d: struct.pack("<10i", *hparams[:10]) + struct.pack("<i", QNT_VERSION * 1000 + DTYPES[d][1]) for d in outs})
    n_mel, n_fft = reader.ints(2)
    write(struct.pack("<2i", n_mel, n_fft) + reader.read(4 * n_mel * n_fft))
    (n_vocab,) = reader.ints(1)
    vocab = [struct.pack("<i", n_vocab)]
    for _ in range(n_vocab):
        raw = reader.read(4)
        vocab.append(raw + reader.read(struct.unpack("<I", raw)[0]))
    write(b"".join(vocab))

    while True:
        head = reader.read(12, eof_ok=True)
        if not head:
            break
        n_dims, length, ttype = struct.unpack("<3i", head)
        shape = reader.ints(n_dims)
        name_raw = reader.read(length)
        name = name_raw.decode()
        count = int(np.prod(shape))
        quantize = n_dims == 2 and name not in SKIP
        if quantize and ttype not in (F32, F16):
            raise ValueError(f"{name}: cannot quantize type {ttype}")
        if quantize and shape[0] % BLOCK:
            raise ValueError(f"{name}: rows of {shape[0]} are not whole blocks")
        dims = struct.pack(f"<{n_dims}i", *shape)
        if not quantize:
            write(head + dims + name_raw + reader.read(count * (4 if ttype == F32 else 2)))
            continue
        write(b"", {d: struct.pack("<3i", n_dims, length, DTYPES[d][0]) + dims + name_raw for d in outs})
        width, dtype = (4, "<f4") if ttype == F32 else (2, "<f2")
        for start in range(0, count, CHUNK):
            values = np.frombuffer(reader.read(min(CHUNK, count - start) * width), dtype=dtype).astype(np.float32)
            write(b"", {d: QUANTIZE[d](values) for d in outs})


def open_source(source: str):
    if not source.startswith("http"):
        return open(source, "rb")
    return urllib.request.urlopen(source, timeout=120)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=SOURCE)
    ap.add_argument("--out", default=os.environ.get("TURBO_MODELS_DIR", "/tmp/turbo-models"))
    ap.add_argument("dtypes", nargs="*", default=["q8_0", "q4_0"])  # what the app offers (Turbo.variant)
    args = ap.parse_args()
    for d in args.dtypes:
        if d not in QUANTIZE:
            sys.exit(f"unknown dtype {d}")
    os.makedirs(args.out, exist_ok=True)
    path = lambda d, ext: os.path.join(args.out, f"ggml-turbo-{d}.{ext}")
    wanted = [d for d in args.dtypes if not os.path.exists(path(d, "json"))]
    if not wanted:
        print("turbo model: ready already")
        return

    started = time.time()
    for attempt in range(5):
        outs = {d: open(path(d, "part"), "wb") for d in wanted}
        try:
            with open_source(args.source) as stream:
                reader = Reader(stream)
                convert(reader, outs)
            break
        except Exception as e:  # a dropped download starts over: nothing is kept of it
            if attempt == 4:
                raise
            print(f"turbo model: {e}, starting over", flush=True)
            time.sleep(10 * (attempt + 1))
        finally:
            for f in outs.values():
                f.close()
    if reader.sha.hexdigest() != SOURCE_SHA256:
        for d in wanted:
            os.remove(path(d, "part"))
        sys.exit(f"turbo model: the source's hash is {reader.sha.hexdigest()}, not the pinned one")

    for d in wanted:
        sha = hashlib.sha256()
        with open(path(d, "part"), "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                sha.update(block)
        os.replace(path(d, "part"), path(d, "bin"))
        size = os.path.getsize(path(d, "bin"))
        with open(path(d, "json.part"), "w") as f:
            json.dump({"bytes": size, "sha256": sha.hexdigest(), "source": REVISION}, f)
        os.replace(path(d, "json.part"), path(d, "json"))
        print(f"turbo model: {d} {size / 1e6:.0f} MB -> {path(d, 'bin')}")
    print(f"turbo model: done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
