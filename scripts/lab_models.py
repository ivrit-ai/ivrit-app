#!/usr/bin/env python3
"""The on-device lab's quantized Whisper models, made when the server starts.

The lab (web/lab/) compares q8, q5 and q4 versions of ivrit-ai's
whisper-large-v3-turbo transcribing on the phone itself, with whisper-gpu (see
scripts/build-lab.sh). Until they are published on ivrit-ai's Hugging Face, the
app serves them: this re-quantizes the public f16 model (already in whisper-gpu's
format) into each, under <out>/<dtype>/, in the background as the server starts
(launch.sh; a build making them took longer than xhost allows), so the files
come from Hugging Face rather than from git. A model's manifest.json is written
last: while it is missing, the model is not ready.

Only f16 matrices are re-quantized, by the same rules and block layouts as
whisper-gpu's tools/convert.py (which quantizes from f32; from f16 differs by
far less than a quantization step); everything else is copied as it is.

    python3 scripts/lab_models.py [--source URL-or-dir] [--out web/lab/models] [q8 q5 q4]

Needs numpy. Skipped (exit 0) unless web/lab/models.json lists the models to
make, so it can be turned off by deleting that file.
"""

import argparse
import json
import os
import sys
import time
import urllib.request

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = "https://huggingface.co/benderrodriguez/whisper-large-v3-turbo-webgpu/resolve/main"
EXTRAS = ("tokenizer.json", "sample_he_30s.wav")

SHARD_LIMIT = 96 * 1024 * 1024
ALIGN = 256
BLOCK = 32
KEEP_F16 = ("encoder.conv1.weight", "encoder.conv2.weight")


def quantize_q8(a: np.ndarray) -> bytes:
    a = np.ascontiguousarray(a, dtype=np.float32).reshape(-1, BLOCK)
    d = (np.abs(a).max(axis=1) / 127.0).astype(np.float16)
    scale = d.astype(np.float32)
    inv = np.where(scale > 0, 1.0 / np.where(scale > 0, scale, 1.0), 0.0)
    q = np.clip(np.rint(a * inv[:, None]), -127, 127).astype(np.int8)
    out = np.zeros((a.shape[0], 36), dtype=np.uint8)
    out[:, 0:2] = np.ascontiguousarray(d, dtype="<f2").view(np.uint8).reshape(-1, 2)
    out[:, 4:] = q.view(np.uint8)
    return out.tobytes()


def quantize_q45(a: np.ndarray, dtype: str) -> bytes:
    top = 31 if dtype == "q5" else 15
    a = np.ascontiguousarray(a, dtype=np.float32).reshape(-1, BLOCK)
    lo_h = a.min(axis=1).astype(np.float16)
    lo = lo_h.astype(np.float32)
    d_h = (np.maximum(a.max(axis=1) - lo, 0) / top).astype(np.float16)
    d = d_h.astype(np.float32)
    inv = np.where(d > 0, 1.0 / np.where(d > 0, d, 1.0), 0.0)
    q = np.clip(np.rint((a - lo[:, None]) * inv[:, None]), 0, top).astype(np.uint64)
    head = d_h.view(np.uint16).astype(np.uint64) | (lo_h.view(np.uint16).astype(np.uint64) << 16)
    words = [head[:, None], ((q & 15).reshape(-1, 4, 8) << (np.arange(8, dtype=np.uint64) * 4)).sum(axis=2)]
    if dtype == "q5":
        words.append((((q >> 4) & 1) << np.arange(32, dtype=np.uint64)).sum(axis=1)[:, None])
    return np.concatenate(words, axis=1).astype("<u4").tobytes()


_QUANTIZE = {"q8": quantize_q8, "q5": lambda a: quantize_q45(a, "q5"), "q4": lambda a: quantize_q45(a, "q4")}
# About a million weights at a time, converted from f16 chunk by chunk, so even
# the 66M-weight token embedding stays small in memory beside the server.
CHUNK = BLOCK << 15
QUANTIZE = {
    d: (lambda f: lambda h: b"".join(f(h[i:i + CHUNK].astype(np.float32)) for i in range(0, h.size, CHUNK)))(f)
    for d, f in _QUANTIZE.items()
}


class Shards:
    """Shard files as whisper-gpu's converter writes them: ~96 MiB, 256-byte aligned."""

    def __init__(self, outdir: str):
        self.outdir = outdir
        self.index = -1
        self.shards = []
        self.fh = None
        self._next()

    def _next(self):
        if self.fh:
            self.fh.close()
            self.shards.append({"file": f"weights-{self.index}.bin", "bytes": self.offset})
        self.index += 1
        self.fh = open(os.path.join(self.outdir, f"weights-{self.index}.bin"), "wb")
        self.offset = 0

    def write(self, data: bytes):
        if self.offset and self.offset + len(data) > SHARD_LIMIT:
            self._next()
        pad = (-self.offset) % ALIGN
        self.fh.write(b"\0" * pad)
        self.offset += pad
        at = (self.index, self.offset)
        self.fh.write(data)
        self.offset += len(data)
        return at

    def close(self):
        self.fh.close()
        self.shards.append({"file": f"weights-{self.index}.bin", "bytes": self.offset})


def read(source: str, name: str) -> bytes:
    if not source.startswith("http"):
        with open(os.path.join(source, name), "rb") as f:
            return f.read()
    for attempt in range(5):
        try:
            with urllib.request.urlopen(f"{source}/{name}", timeout=120) as r:
                return r.read()
        except Exception as e:  # a flaky download should not fail the build at once
            if attempt == 4:
                raise
            print(f"  {name}: {e}, retrying", flush=True)
            time.sleep(5 * (attempt + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=SOURCE)
    ap.add_argument("--out", default=os.environ.get("LAB_MODELS_DIR", "/tmp/lab-models"))
    ap.add_argument("dtypes", nargs="*")
    args = ap.parse_args()
    dtypes = args.dtypes
    if not dtypes:
        wanted = os.path.join(ROOT, "web", "lab", "models.json")
        if not os.path.exists(wanted):
            print("lab models: none wanted (no web/lab/models.json)")
            return
        with open(wanted) as f:
            dtypes = json.load(f)["quantized"]
    for d in dtypes:
        if d not in QUANTIZE:
            sys.exit(f"unknown dtype {d}")

    started = time.time()
    manifest = json.loads(read(args.source, "manifest.json"))
    if manifest.get("weights_dtype") != "f16":
        sys.exit("the source must be the f16 model")
    writers, tensors = {}, {d: {} for d in dtypes}
    for d in dtypes:
        out = os.path.join(args.out, d)
        os.makedirs(out, exist_ok=True)
        writers[d] = Shards(out)

    # Shard by shard, each tensor into every output in one pass over the source.
    order = sorted(manifest["tensors"].items(), key=lambda kv: (kv[1]["shard"], kv[1]["offset"]))
    by_shard = {}
    for name, info in order:
        by_shard.setdefault(info["shard"], []).append((name, info))
    for shard in sorted(by_shard):
        raw = read(args.source, manifest["shards"][shard]["file"])
        for name, info in by_shard[shard]:
            payload = raw[info["offset"]:info["offset"] + info["bytes"]]
            quantizable = info["dtype"] == "f16" and name not in KEEP_F16 and info["shape"][-1] % BLOCK == 0
            values = np.frombuffer(payload, dtype="<f2") if quantizable else None
            for d in dtypes:
                data, dtype = (QUANTIZE[d](values), d) if quantizable else (payload, info["dtype"])
                at_shard, at_offset = writers[d].write(data)
                tensors[d][name] = {**info, "dtype": dtype, "shard": at_shard, "offset": at_offset, "bytes": len(data)}
        print(f"  shard {shard + 1}/{len(manifest['shards'])}", flush=True)

    # The tokenizer and the sample recording; a local source may lack the sample.
    extras = {}
    for name in EXTRAS:
        try:
            extras[name] = read(args.source, name)
        except FileNotFoundError:
            extras[name] = read(SOURCE, name)
    for d in dtypes:
        writers[d].close()
        out = os.path.join(args.out, d)
        with open(os.path.join(out, "manifest.json"), "w") as f:
            json.dump({**manifest, "weights_dtype": d, "shards": writers[d].shards, "tensors": tensors[d]}, f, indent=1)
        for name, data in extras.items():
            with open(os.path.join(out, name), "wb") as f:
                f.write(data)
        total = sum(s["bytes"] for s in writers[d].shards)
        print(f"lab models: {d} {total / 1e6:.0f} MB in {len(writers[d].shards)} shards -> {out}")
    print(f"lab models: done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
