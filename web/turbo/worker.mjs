// The Turbo model in the browser (turbo.mjs, scripts/build-web-turbo.sh): the
// whole chain the apps run (shell/native/wasm/turbo.cpp) in this module worker.
//   in:  {type: "run", pcm: Float32Array (16 kHz mono), gpu: boolean}
//   out: {type: "progress", phase: "downloading" | "loading" | "transcribing" |
//        "prints" | "speakers", fraction}, then {type: "done", segments, stages:
//        {download, load, transcribe} (seconds), log} or {type: "error", message, log}.
// The models download once and stay in Cache Storage (sw.js keeps "turbo-web-…"):
// the Turbo model as the site serves it to the Android app (/models/turbo/), the
// speaker model from Hugging Face, both at the app's pinned versions. They are read
// from there as files (WORKERFS), not copied into the module's memory.
import createTurbo from "./turbo.mjs";

const CACHE = "turbo-web-q8_0-123a936e";
const MODEL = { url: "/models/turbo/ggml-turbo-q8_0.bin", bytes: 874188075, name: "turbo.bin" };
const SPEAKERS = {
  url: "https://huggingface.co/ivrit-ai/spkrec-ecapa-voxceleb-ggml/resolve/777b3401752d2a87d34fe9a9ec7b9ec5bd4537f2/ecapa-q8_0.bin",
  bytes: 22626164,
  name: "speakers.bin",
};

const log = [];
const post = (message) => self.postMessage(message);
let turbo = null;
let loaded = null; // "gpu" | "cpu" once the model is in

async function cached(file, share, before) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(file.url);
  if (hit) return hit.blob();
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`download ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    post({ type: "progress", phase: "downloading", fraction: before + share * (got / file.bytes) });
  }
  const blob = new Blob(chunks);
  if (blob.size !== file.bytes) throw new Error("download incomplete");
  await cache.put(file.url, new Response(blob));
  return blob;
}

// The models in, on the GPU or the CPU; how long their download (or reading them
// from the cache) took, seconds.
async function ready(gpu) {
  const fetching = performance.now();
  const model = await cached(MODEL, 0.97, 0);
  const speakers = await cached(SPEAKERS, 0.03, 0.97);
  const download = (performance.now() - fetching) / 1000;
  if (!turbo) {
    turbo = await createTurbo({
      onProgress: (phase, fraction) => post({ type: "progress", phase, fraction }),
      print: (line) => log.push(line),
      printErr: (line) => log.push(line),
    });
    turbo.FS.mkdir("/m");
    turbo.FS.mount(turbo.WORKERFS, { blobs: [{ name: MODEL.name, data: model }, { name: SPEAKERS.name, data: speakers }] }, "/m");
  }
  const want = gpu ? "gpu" : "cpu";
  if (loaded !== want) {
    post({ type: "progress", phase: "loading", fraction: 0 });
    if ((await turbo._tw_load(turbo.stringToNewUTF8(`/m/${MODEL.name}`), gpu ? 1 : 0)) !== 0) throw new Error(turbo.UTF8ToString(turbo._tw_error()));
    if ((await turbo._tw_load_speakers(turbo.stringToNewUTF8(`/m/${SPEAKERS.name}`))) !== 0) throw new Error(turbo.UTF8ToString(turbo._tw_error()));
    loaded = want;
  }
  return download;
}

self.onmessage = async ({ data }) => {
  if (data.type !== "run") return;
  try {
    const started = performance.now();
    const download = await ready(data.gpu !== false);
    const transcribing = performance.now();
    const pcm = data.pcm;
    const at = turbo._malloc(pcm.length * 4);
    turbo.HEAPF32.set(pcm, at / 4);
    const rc = await turbo._tw_transcribe(at, pcm.length);
    turbo._free(at);
    if (rc !== 0) throw new Error(rc === -2 ? "stopped" : turbo.UTF8ToString(turbo._tw_error()));
    const segments = JSON.parse(turbo.UTF8ToString(turbo._tw_result()));
    const done = performance.now();
    post({
      type: "done",
      segments,
      stages: { download, load: (transcribing - started) / 1000 - download, transcribe: (done - transcribing) / 1000 },
      log: log.slice(-80).join("\n"),
    });
  } catch (e) {
    post({ type: "error", message: String(e?.message || e), log: log.slice(-80).join("\n") });
  }
};
