// Recording to transcribe: the microphone, the screen's sound, or both mixed. A take
// is written to the device as it goes (IndexedDB "ivrit-recordings", every five
// seconds, as transcribe.ivrit.ai keeps it), so a closed tab or a crash loses
// nothing: the next visit offers it back. It is deleted once sent.

import { tr } from "./strings.js";

const DB = "ivrit-recordings";
const FLUSH_MS = 5000;
const KEEP_MS = 7 * 24 * 3600 * 1000;
// Quiet for this long: no recorder (here or in another tab) is writing it any more.
const STALE_MS = 15000;

let host = null;
let hooks = null;
let dbPromise = null;
let session = null; // the take being recorded
const taken = new Map(); // File -> recording id, until it is sent

export function init(hostApi, viewHooks) {
  host = hostApi;
  hooks = viewHooks;
}

export const supported = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
const screenSupported = () => Boolean(navigator.mediaDevices?.getDisplayMedia);

// ------------------------------------------------------------------ the device's copy

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains("recordings")) d.createObjectStore("recordings", { keyPath: "id" });
      if (!d.objectStoreNames.contains("chunks")) d.createObjectStore("chunks", { keyPath: ["recordingId", "seq"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
  return dbPromise;
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});
const ask = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const range = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);

async function putMeta(meta) {
  const tx = (await db()).transaction("recordings", "readwrite");
  tx.objectStore("recordings").put(meta);
  await done(tx);
}

// The chunk and the meta in one transaction: the meta never claims audio that did not land.
async function putChunk(meta, seq, blob) {
  const tx = (await db()).transaction(["chunks", "recordings"], "readwrite");
  tx.objectStore("chunks").put({ recordingId: meta.id, seq, blob });
  tx.objectStore("recordings").put(meta);
  await done(tx);
}

async function parts(id) {
  const tx = (await db()).transaction("chunks", "readonly");
  return (await ask(tx.objectStore("chunks").getAll(range(id)))).map((row) => row.blob);
}

async function forget(id) {
  const tx = (await db()).transaction(["chunks", "recordings"], "readwrite");
  tx.objectStore("chunks").delete(range(id));
  tx.objectStore("recordings").delete(id);
  await done(tx);
}

async function all() {
  const tx = (await db()).transaction("recordings", "readonly");
  return ask(tx.objectStore("recordings").getAll());
}

// ------------------------------------------------------------------ recording

export function choose() {
  const { el, icon } = host;
  const option = (mode, name, label) => el("button", { class: "list-row tr-choice", type: "button", onclick: () => start(mode) }, [
    icon(name), el("div", { class: "grow", text: label }),
  ]);
  host.sheet.open(tr("record"), el("div", { class: "list" }, [
    option("mic", "mic", tr("recordMicOnly")),
    screenSupported() ? option("both", "screen", tr("recordMicAndScreen")) : null,
    screenSupported() ? option("screen", "screen", tr("recordScreenOnly")) : null,
  ]));
}

async function capture(mode) {
  const mic = () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true } });
  const screen = async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, preferCurrentTab: false, surfaceSwitching: "include", systemAudio: "include" });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) throw Object.assign(new Error("no audio"), { name: "NoScreenAudio" });
    return stream;
  };
  if (mode === "mic") return { stream: await mic(), sources: [] };
  if (mode === "screen") return { stream: await screen(), sources: [] };
  const voice = await mic();
  let shared;
  try {
    shared = await screen();
  } catch {
    host.toast(tr("recordingMicOnlyWarning"));
    return { stream: voice, sources: [] };
  }
  // Both, mixed into one track.
  const context = new AudioContext();
  const out = context.createMediaStreamDestination();
  for (const s of [voice, shared]) {
    const gain = context.createGain();
    gain.gain.value = 1;
    context.createMediaStreamSource(s).connect(gain).connect(out);
  }
  return { stream: out.stream, sources: [voice, shared], context };
}

async function start(mode) {
  let input;
  try {
    input = await capture(mode);
  } catch (err) {
    host.sheet.close();
    if (err.name === "NoScreenAudio") return host.toast(tr("screenAudioNotSelected"));
    return host.toast(err.name === "NotAllowedError" ? tr("micPermissionDenied") : tr(mode === "mic" ? "micError" : "screenAudioError"));
  }
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const recorder = new MediaRecorder(input.stream, { mimeType });
  const meta = {
    id: crypto.randomUUID(),
    filename: `recording_${new Date().toISOString().replace(/[:.]/g, "-")}.webm`,
    mimeType: "audio/webm",
    startedAt: Date.now(),
    lastFlushAt: Date.now(),
    status: "recording",
  };
  session = { meta, recorder, input, chunks: [], seq: 0, durable: true, chain: Promise.resolve(), started: Date.now() };
  navigator.storage?.persist?.().catch(() => {});
  await putMeta(meta).catch(lost);
  recorder.ondataavailable = (e) => e.data.size > 0 && session?.chunks.push(e.data);
  recorder.onstop = () => finish();
  session.flusher = setInterval(flush, FLUSH_MS);
  recorder.start(100);
  showRecording();
}

function lost(err) {
  if (!session || !session.durable) return;
  session.durable = false;
  console.warn("recording not backed up", err);
  host.toast(tr("recordingNotBackedUp"));
}

function flush() {
  const s = session;
  if (!s) return Promise.resolve();
  s.chain = s.chain.then(async () => {
    if (!s.durable || !s.chunks.length) return;
    const batch = s.chunks;
    s.chunks = [];
    const seq = s.seq++;
    s.meta.lastFlushAt = Date.now();
    try {
      await putChunk(s.meta, seq, new Blob(batch, { type: s.meta.mimeType }));
    } catch (err) {
      s.chunks = batch.concat(s.chunks);
      s.seq = seq;
      lost(err);
    }
  });
  return s.chain;
}

function showRecording() {
  const { el, icon } = host;
  const time = el("div", { class: "tr-timer", dir: "ltr", text: "00:00" });
  const canvas = el("canvas", { class: "tr-wave", width: 600, height: 120 });
  const stop = el("button", { class: "btn primary large", type: "button", onclick: () => session?.recorder.stop() }, [icon("stop"), el("span", { text: tr("stop") })]);
  host.sheet.open(tr("recordingTime"), el("div", { class: "stack tr-recording" }, [time, canvas, stop]), () => session?.recorder.state === "recording" && session.recorder.stop());
  const s = session;
  s.ticker = setInterval(() => {
    const seconds = Math.floor((Date.now() - s.started) / 1000);
    time.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, 250);
  // The level, drawn as it scrolls by.
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  context.createMediaStreamSource(s.input.stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const bars = [];
  const ink = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#111";
  s.drawer = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    bars.push(peak / 128);
    if (bars.length > 100) bars.shift();
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = ink;
    bars.forEach((v, i) => {
      const h = Math.max(3, v * canvas.height);
      g.fillRect(i * 6, (canvas.height - h) / 2, 4, h);
    });
  }, 80);
  s.meter = context;
}

async function finish() {
  const s = session;
  if (!s) return;
  clearInterval(s.flusher);
  clearInterval(s.ticker);
  clearInterval(s.drawer);
  s.meter?.close();
  for (const stream of [s.input.stream, ...s.input.sources]) stream.getTracks().forEach((t) => t.stop());
  s.input.context?.close();
  await flush();
  session = null;
  if (s.durable) {
    s.meta.status = "complete";
    await putMeta(s.meta).catch(() => {});
  }
  // What landed on the device, then whatever was left in memory: the whole take.
  let stored = [];
  if (s.seq > 0) {
    try {
      stored = await parts(s.meta.id);
    } catch {
      host.sheet.close();
      host.toast(tr("recordingReadFailed"));
      return;
    }
  }
  const blob = new Blob(stored.concat(s.chunks), { type: s.meta.mimeType });
  host.sheet.close();
  take(blob, s.meta);
}

function take(blob, meta) {
  const file = new File([blob], meta.filename, { type: blob.type || "audio/webm" });
  taken.set(file, meta.id);
  host.toast(tr("recordingReadyToTranscribe"));
  hooks.take(file);
}

// Sent for transcription: the device's copy can go.
export function sent(file) {
  const id = taken.get(file);
  if (!id) return;
  taken.delete(file);
  forget(id).catch(() => {});
}

// ------------------------------------------------------------------ recovering

// A take not sent (the tab closed, the device restarted): offered back.
export async function renderRecovered(box) {
  if (!box || !window.indexedDB) return;
  box.replaceChildren();
  let list;
  try {
    list = await all();
  } catch {
    return;
  }
  const now = Date.now();
  for (const old of list.filter((r) => now - r.startedAt > KEEP_MS)) await forget(old.id).catch(() => {});
  const candidate = list
    .filter((r) => now - r.startedAt <= KEEP_MS && (r.status === "complete" || now - r.lastFlushAt > STALE_MS))
    .filter((r) => ![...taken.values()].includes(r.id) && r.id !== session?.meta.id)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!candidate) return;
  const blob = new Blob(await parts(candidate.id).catch(() => []), { type: candidate.mimeType });
  if (!blob.size) return forget(candidate.id).catch(() => {});
  const { el } = host;
  const when = new Date(candidate.startedAt).toLocaleString();
  box.replaceChildren(el("div", { class: "banner tr-recovered" }, [
    el("div", {}, [
      el("strong", { text: tr(candidate.status === "complete" ? "recoveredRecordingFound" : "recoveredRecordingInterrupted") }),
      el("span", { text: `${when} · ${(blob.size / 1048576).toFixed(1)} MB` }),
    ]),
    el("div", { class: "row" }, [
      el("button", { class: "btn quiet small", type: "button", text: tr("discardRecording"), onclick: async () => {
        await forget(candidate.id).catch(() => {});
        box.replaceChildren();
        host.toast(tr("recordingDiscarded"));
      } }),
      el("button", { class: "btn quiet small", type: "button", text: tr("downloadRecording"), onclick: () => {
        const url = URL.createObjectURL(blob);
        const a = el("a", { href: url, download: candidate.filename });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } }),
      el("button", { class: "btn primary small", type: "button", text: tr("transcribeRecording"), onclick: () => {
        box.replaceChildren();
        take(blob, candidate);
      } }),
    ]),
  ]));
}
