// Transcribing a whole file on the device (local.js starts it): the model, downloaded
// once and kept in Cache Storage, then the audio through it, with progress.
//   in:  {type: "run", pcm: Float32Array, sampleRate}
//   out: {type: "model", loaded, total} while downloading,
//        {type: "progress", done, total} (seconds of audio),
//        {type: "done", segments, seconds}, or {type: "error", message}.
// The model loads as live-transcribe.ivrit.ai loads it (public/zipformer/worker.js),
// from the ivrit-ai mirror at a pinned revision. A classic worker that imports its
// modules dynamically: a failed static import kills a worker silently on WebKit.

const ORT_VERSION = "1.30.0";
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.wasm.min.mjs`;
const REPO = "ivrit-ai/zipformer2-66m-streaming-he";
const REVISION = "3d01a65d00e45cbb238996795be87e8e800a3226";
const BASE = `https://huggingface.co/${REPO}/resolve/${REVISION}/`;
// Kept by the site's service worker (sw.js keeps caches named "zipformer2-he-…").
const CACHE_NAME = `zipformer2-he-${REVISION}`;
const FILES = {
  config: "onnx/config.json",
  tokens: "onnx/tokens.txt",
  encoder: "sherpa-onnx/encoder.int8.onnx",
  decoder: "sherpa-onnx/decoder.int8.onnx",
  joiner: "sherpa-onnx/joiner.int8.onnx",
};
const BLOCK_SECONDS = 8; // fed to the model at a time (progress moves this often)
const SAMPLE_RATE = 16000;

let ort = null;
let asr = null; // asr.js
let segments = null; // segments.js
let model = null; // {sessions, config, symbols}

const post = (message) => self.postMessage(message);

self.addEventListener("error", (e) => {
  e.preventDefault();
  post({ type: "error", message: e.message || "worker error" });
});
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  post({ type: "error", message: e.reason?.message || String(e.reason) });
});

async function download(paths) {
  const cache = self.caches ? await caches.open(CACHE_NAME).catch(() => null) : null;
  const found = [];
  for (const path of paths) {
    const hit = cache && (await cache.match(BASE + path));
    if (hit) {
      found.push({ path, res: hit, cached: true });
      continue;
    }
    const res = await fetch(BASE + path);
    if (!res.ok) throw new Error(`model download failed (${res.status})`);
    found.push({ path, res, cached: false });
  }
  const total = found.reduce((sum, f) => sum + Number(f.res.headers.get("content-length") || 0), 0);
  let loaded = 0;
  let told = 0;
  const bytes = await Promise.all(
    found.map(async (f) => {
      const reader = f.res.body.getReader();
      const parts = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.length;
        loaded += value.length;
        if (Date.now() - told > 200) {
          told = Date.now();
          post({ type: "model", loaded, total });
        }
      }
      const buf = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        buf.set(part, at);
        at += part.length;
      }
      if (!f.cached && cache) {
        cache.put(BASE + f.path, new Response(buf, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
      }
      return buf;
    })
  );
  post({ type: "model", loaded: total, total });
  return Object.fromEntries(paths.map((p, i) => [p, bytes[i]]));
}

async function load() {
  if (model) return model;
  [ort, asr, segments] = await Promise.all([import(ORT_URL), import("./asr.js"), import("./segments.js")]);
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  // Several threads only where the page is cross-origin isolated (it is not, yet).
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  const data = await download(Object.values(FILES));
  const text = new TextDecoder();
  const config = JSON.parse(text.decode(data[FILES.config]));
  const symbols = asr.parseTokens(text.decode(data[FILES.tokens]));
  const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const sessions = {
    encoder: await ort.InferenceSession.create(data[FILES.encoder], options),
    decoder: await ort.InferenceSession.create(data[FILES.decoder], options),
    joiner: await ort.InferenceSession.create(data[FILES.joiner], options),
  };
  model = { sessions, config, symbols };
  return model;
}

async function run({ pcm, sampleRate }) {
  const { sessions, config, symbols } = await load();
  const transducer = new asr.FileTransducer(ort, sessions, config, symbols);
  const resampler = sampleRate === SAMPLE_RATE ? null : new asr.Resampler(sampleRate, SAMPLE_RATE);
  const total = pcm.length / sampleRate;
  const block = Math.round(BLOCK_SECONDS * sampleRate);
  const started = performance.now();
  let told = 0;
  for (let at = 0; at < pcm.length; at += block) {
    const piece = pcm.subarray(at, Math.min(pcm.length, at + block));
    await transducer.accept(resampler ? resampler.process(piece) : piece);
    if (performance.now() - told > 250) {
      told = performance.now();
      post({ type: "progress", done: Math.min(total, transducer.doneSeconds), total });
    }
  }
  const tokens = await transducer.finish();
  post({ type: "progress", done: total, total });
  post({ type: "done", segments: segments.toSegments(tokens), seconds: (performance.now() - started) / 1000 });
}

let busy = Promise.resolve();
self.onmessage = (e) => {
  if (e.data?.type !== "run") return;
  busy = busy.then(() => run(e.data)).catch((err) => post({ type: "error", message: err?.message || String(err) }));
};
