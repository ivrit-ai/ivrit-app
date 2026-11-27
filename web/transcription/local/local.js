// Transcribing on the user's device, in Hebrew: the file is decoded here and
// transcribed by the on-device model in a worker (worker.js), with progress. The
// audio never leaves the device for this; only the finished transcript (and the
// audio, if the user keeps it) goes to their Drive, through api.saveLocal.
//
// Used when the user chose to transcribe on their devices only, and to carry on
// when the free transcription time is used up. No speakers: the model does not
// tell voices apart.

import { bundled, serve } from "./bundle.js";

export const ENGINE = "zipformer2-66m-he";
export const LANGUAGE = "he";
// The decoded audio is held in memory (16 kHz, 4 bytes a sample: ~230 MB an
// hour); past this the page would struggle, so longer files are refused.
export const MAX_SECONDS = 2 * 3600;
// The browser decodes from the whole file, held in memory alongside the sound. A
// video is many times its sound's size (the phone apps keep only the sound of
// what is shared to them, but a video picked here comes whole), so past this it
// is refused before it is read.
export const MAX_BYTES = 1024 * 1024 * 1024;

export function supported() {
  return typeof WebAssembly === "object" && typeof Worker === "function" && Boolean(self.AudioContext || self.webkitAudioContext);
}

export class TooLong extends Error {
  constructor(seconds) {
    super("too long");
    this.seconds = seconds;
  }
}

export class TooLarge extends Error {
  constructor(bytes) {
    super("too large");
    this.bytes = bytes;
  }
}

// The file's length in seconds from its header alone, without reading it all, or
// null when the browser cannot tell (soon).
function probeDuration(file) {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const url = URL.createObjectURL(file);
    const done = (seconds) => {
      clearTimeout(timer);
      media.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    };
    const timer = setTimeout(() => done(null), 5000);
    media.preload = "metadata";
    media.muted = true;
    media.onloadedmetadata = () => done(media.duration);
    media.onerror = () => done(null);
    media.src = url;
  });
}

// The file's sound, mono, at 16 kHz where the browser can resample while decoding
// (else at its own rate, resampled in the worker). Too long or too large is told
// before the file is read where the browser can tell, and after decoding otherwise.
async function decode(file) {
  if (file.size > MAX_BYTES) throw new TooLarge(file.size);
  const seconds = await probeDuration(file);
  if (seconds > MAX_SECONDS) throw new TooLong(seconds);
  const Context = self.AudioContext || self.webkitAudioContext;
  let context;
  try {
    context = new Context({ sampleRate: 16000 });
  } catch {
    context = new Context();
  }
  try {
    const audio = await context.decodeAudioData(await file.arrayBuffer());
    if (audio.duration > MAX_SECONDS) throw new TooLong(audio.duration);
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const channel = audio.getChannelData(c);
      for (let i = 0; i < channel.length; i++) mono[i] += channel[i] / audio.numberOfChannels;
    }
    return { pcm: mono, sampleRate: audio.sampleRate, duration: audio.duration };
  } finally {
    context.close?.().catch(() => {});
  }
}

// One file at a time through the model (each would load its own copy, ~220 MB):
// the others wait their turn, shown as waiting.
let turn = Promise.resolve();

// {segments, duration}. onProgress({stage: "queued" | "decoding" | "model" |
// "transcribing", fraction}) as it goes; abort with the signal.
export function transcribe(file, options = {}) {
  const waiting = turn;
  options.onProgress?.({ stage: "queued", fraction: 0 });
  const mine = waiting.then(() => transcribeNow(file, options));
  turn = mine.catch(() => {});
  return mine;
}

async function transcribeNow(file, { onProgress = () => {}, signal } = {}) {
  onProgress({ stage: "decoding", fraction: 0 });
  const { pcm, sampleRate, duration } = await decode(file);
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const worker = new Worker(new URL("./worker.js", import.meta.url));
  serve(worker);
  try {
    return await new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      worker.onerror = (e) => reject(new Error(e.message || "worker failed"));
      worker.onmessage = ({ data }) => {
        if (data.type === "model") onProgress({ stage: "model", fraction: data.total ? data.loaded / data.total : 0 });
        else if (data.type === "progress") onProgress({ stage: "transcribing", fraction: data.total ? data.done / data.total : 0 });
        else if (data.type === "done") resolve({ segments: data.segments, duration, seconds: data.seconds });
        else if (data.type === "error") reject(new Error(data.message));
      };
      worker.postMessage({ type: "run", pcm, sampleRate, bundle: bundled() }, [pcm.buffer]);
    });
  } finally {
    worker.terminate();
  }
}
