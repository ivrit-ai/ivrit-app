"""scripts/turbo_model.py: its blocks are ggml's, byte for byte, and a whole file
converts into what whisper.cpp reads (a tiny model built here, so nothing is
downloaded). Given a model it made (TURBO_MODEL=<out dir>), also reads that back.

    python tests/test_turbo_model.py
"""

import io
import json
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "scripts"))

import turbo_model  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  [{detail}]"))


# ggml-quants.c's reference loops, transcribed one weight at a time.
def f16(x):
    return np.float32(x).astype("<f2").tobytes()


def ref_q5_1(x):
    out = b""
    for b in range(0, len(x), 32):
        v = x[b:b + 32].astype(np.float32)
        lo, hi = v.min(), v.max()
        d = np.float32((hi - lo) / np.float32(31))
        inv = np.float32(1) / d if d else np.float32(0)
        qh, qs = 0, bytearray(16)
        for j in range(16):
            x0 = int(np.float32((v[j] - lo) * inv) + np.float32(0.5))
            x1 = int(np.float32((v[j + 16] - lo) * inv) + np.float32(0.5))
            qs[j] = (x0 & 0x0F) | ((x1 & 0x0F) << 4)
            qh |= ((x0 & 0x10) >> 4) << j
            qh |= ((x1 & 0x10) >> 4) << (j + 16)
        out += f16(d) + f16(lo) + struct.pack("<I", qh) + bytes(qs)
    return out


def ref_q8_0(x):
    out = b""
    for b in range(0, len(x), 32):
        v = x[b:b + 32].astype(np.float32)
        d = np.float32(np.abs(v).max() / np.float32(127))
        inv = np.float32(1) / d if d else np.float32(0)
        q = [int(np.copysign(np.floor(abs(float(np.float32(e * inv))) + 0.5), e)) for e in v]
        out += f16(d) + struct.pack("<32b", *q)
    return out


rng = np.random.default_rng(7)
x = np.concatenate([
    rng.normal(0, 0.05, 32 * 40),
    np.zeros(32),  # a block of zeros: scale 0
    np.full(32, 0.25),  # all equal
    np.linspace(-1, 1, 32),
    np.array([0.5, -0.5] * 16) * 127 / 127,  # halves, for roundf
]).astype(np.float16).astype(np.float32)
check("q5_1 blocks are ggml's", turbo_model.quantize_q5_1(x) == ref_q5_1(x))
check("q8_0 blocks are ggml's", turbo_model.quantize_q8_0(x) == ref_q8_0(x))
halves = np.array([2.5, -2.5, 0.5, -0.5, 127.0] + [0.0] * 27, dtype=np.float32)
check("q8_0 rounds halves away from zero", turbo_model.quantize_q8_0(halves) == ref_q8_0(halves))


def dequant_q5_1(raw, n):
    blocks = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 24)
    d = blocks[:, 0:2].copy().view("<f2").astype(np.float32)
    m = blocks[:, 2:4].copy().view("<f2").astype(np.float32)
    qh = blocks[:, 4:8].copy().view("<u4")[:, 0]
    qs = blocks[:, 8:]
    low = np.concatenate([qs & 0x0F, qs >> 4], axis=1).astype(np.uint32)
    high = (qh[:, None] >> np.arange(32, dtype=np.uint32)) & 1
    return ((low | (high << 4)) * d + m).reshape(-1)[:n]


check("q5_1 decodes to within half a step", np.all(np.abs(dequant_q5_1(turbo_model.quantize_q5_1(x), len(x)) - x)
                                                   <= np.repeat((np.ptp(x.reshape(-1, 32), axis=1) / 31), 32) * 0.51 + 1e-3))


# A tiny ggml model: header, mel filters, vocab, then tensors of each kind.
def tensor(name, shape, ttype, values):
    head = struct.pack("<3i", len(shape), len(name), ttype) + struct.pack(f"<{len(shape)}i", *shape) + name.encode()
    return head + values.astype("<f4" if ttype == 0 else "<f2").tobytes()


hparams = [16, 1500, 64, 1, 1, 448, 64, 1, 1, 4, 1]
tensors = [
    ("encoder.positional_embedding", [64, 3], 0),
    ("encoder.conv1.weight", [3, 4, 64], 1),
    ("encoder.conv1.bias", [1, 64], 1),
    ("encoder.blocks.0.attn.query.weight", [64, 64], 1),
    ("encoder.blocks.0.attn.query.bias", [64], 0),
    ("decoder.token_embedding.weight", [64, 16], 1),
]
src = io.BytesIO()
src.write(struct.pack("<I", turbo_model.GGML_MAGIC) + struct.pack("<11i", *hparams))
src.write(struct.pack("<2i", 4, 3) + np.arange(12, dtype="<f4").tobytes())
src.write(struct.pack("<i", 2) + struct.pack("<I", 1) + b"!" + struct.pack("<I", 3) + "\xd7\x90".encode("latin-1") + b" ")
values = {}
for name, shape, ttype in tensors:
    values[name] = rng.normal(0, 0.1, int(np.prod(shape))).astype(np.float16).astype(np.float32)
    src.write(tensor(name, shape, ttype, values[name]))
src.seek(0)


class Kept(io.BytesIO):
    def close(self):
        pass


outs = {"q5_1": Kept(), "q8_0": Kept()}
turbo_model.convert(turbo_model.Reader(src), outs)


def read_model(data):
    """The file as whisper.cpp's loader walks it: what it would find, tensor by tensor."""
    r = io.BytesIO(data)
    ints = lambda n: struct.unpack(f"<{n}i", r.read(4 * n))
    assert struct.unpack("<I", r.read(4))[0] == turbo_model.GGML_MAGIC
    hp = ints(11)
    n_mel, n_fft = ints(2)
    r.read(4 * n_mel * n_fft)
    (n_vocab,) = ints(1)
    vocab = [r.read(struct.unpack("<I", r.read(4))[0]) for _ in range(n_vocab)]
    found = {}
    while True:
        head = r.read(12)
        if not head:
            break
        n_dims, length, ttype = struct.unpack("<3i", head)
        shape = ints(n_dims)
        name = r.read(length).decode()
        count = int(np.prod(shape))
        size = {0: 4 * count, 1: 2 * count, 7: count // 32 * 24, 8: count // 32 * 34}[ttype]
        found[name] = (ttype, shape, r.read(size))
        assert len(found[name][2]) == size, name
    return hp, vocab, found


for dtype, (qtype, ftype) in turbo_model.DTYPES.items():
    hp, vocab, found = read_model(outs[dtype].getvalue())
    check(f"{dtype}: file type {2000 + ftype}, the rest of the header as it was", list(hp) == hparams[:10] + [2000 + ftype], hp)
    check(f"{dtype}: vocab copied", vocab == [b"!", "\xd7\x90".encode("latin-1") + b" "], vocab)
    kinds = {name: t for name, (t, _, _) in found.items()}
    check(f"{dtype}: 2-D weights quantized, embeddings and 1-D/3-D tensors kept", kinds == {
        "encoder.positional_embedding": 0, "encoder.conv1.weight": 1, "encoder.conv1.bias": 1,
        "encoder.blocks.0.attn.query.weight": qtype, "encoder.blocks.0.attn.query.bias": 0,
        "decoder.token_embedding.weight": qtype}, kinds)
    kept = found["encoder.conv1.weight"][2]
    check(f"{dtype}: kept tensors byte for byte", kept == values["encoder.conv1.weight"].astype("<f2").tobytes())
    q = turbo_model.QUANTIZE[dtype](values["decoder.token_embedding.weight"])
    check(f"{dtype}: a quantized tensor is its blocks", found["decoder.token_embedding.weight"][2] == q)

# A model turbo_model.py made, read back whole.
made = os.environ.get("TURBO_MODEL")
if made:
    for dtype, (qtype, ftype) in turbo_model.DTYPES.items():
        path = os.path.join(made, f"ggml-turbo-{dtype}.bin")
        if not os.path.exists(path):
            continue
        meta = json.load(open(path[:-4] + ".json"))
        with open(path, "rb") as f:
            hp, vocab, found = read_model(f.read())
        kinds = {}
        for t, _, _ in found.values():
            kinds[t] = kinds.get(t, 0) + 1
        check(f"{dtype} model: {len(found)} tensors, {kinds}, {len(vocab)} tokens",
              # The file keeps the 50257 text tokens; whisper.cpp adds the special ones.
              hp[10] == 2000 + ftype and len(vocab) == 50257 and kinds.get(qtype, 0) > 100
              and os.path.getsize(path) == meta["bytes"])

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
