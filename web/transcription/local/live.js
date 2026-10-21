// Live transcription, in Hebrew, on the device: what the microphone hears goes
// to the on-device model (worker.js, live mode) as it is heard, and the
// sentences come back as they form, as live-transcribe.ivrit.ai does. The sound
// is recorded at the same time, so the transcript can be saved with its
// recording. Pausing stops both together: the recording and the transcript's
// times stay in step.
//
//   const session = await startLive({ onModel, onText, onState });
//   session.pause(); session.resume();
//   const { segments, audio, seconds } = await session.stop();

import { supported as canDecode } from "./local.js";

// An AudioWorklet that hands the microphone's samples on, mono, in blocks
// (live-transcribe's PcmTap).
const TAP = `
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const len = chans[0].length;
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let c = 0; c < chans.length; c++) v += chans[c][i];
        this.buf[this.n++] = v / chans.length;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;

export function supported() {
  return canDecode() && Boolean(navigator.mediaDevices?.getUserMedia && self.AudioWorkletNode && self.MediaRecorder);
}

export async function startLive({ onModel = () => {}, onText = () => {}, onState = () => {} } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const worker = new Worker(new URL("./worker.js", import.meta.url));
  const context = new AudioContext();
  let tap = null;
  let wakeLock = null;
  const segments = [];
  let paused = false;
  let ended = null; // resolves with the final segments
  let failed = null;
  let activeMs = 0;
  let since = 0;

  const cleanup = () => {
    stream.getTracks().forEach((t) => t.stop());
    tap?.disconnect();
    context.close().catch(() => {});
    wakeLock?.release().catch(() => {});
    worker.terminate();
  };

  const ready = new Promise((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(e.message || "worker failed"));
    worker.onmessage = ({ data }) => {
      if (data.type === "model") onModel(data.total ? data.loaded / data.total : 0);
      else if (data.type === "live-ready") resolve();
      else if (data.type === "live") {
        segments.splice(data.from, segments.length - data.from, ...data.segments);
        onText(segments, { behind: data.behind });
      } else if (data.type === "live-done") {
        segments.splice(0, segments.length, ...data.segments);
        ended?.(data.segments);
      } else if (data.type === "error") {
        failed = new Error(data.message);
        reject(failed);
        onState("error", failed);
      }
    };
  });
  try {
    worker.postMessage({ type: "live-start", sampleRate: context.sampleRate });
    await ready;
    const url = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    // Made after an await, so maybe outside the tap that started it: suspended.
    await context.resume().catch(() => {});
  } catch (err) {
    cleanup();
    throw err;
  }

  // The recording, beside the transcript.
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  const source = context.createMediaStreamSource(stream);
  tap = new AudioWorkletNode(context, "pcm-tap");
  tap.port.onmessage = ({ data }) => {
    if (!paused && !failed) worker.postMessage({ type: "live-audio", data }, [data.buffer]);
  };
  source.connect(tap);
  recorder.start(1000);
  since = Date.now();
  // The screen stays on while listening: a phone that locks itself would stop it.
  const keepAwake = async () => {
    try {
      wakeLock = await navigator.wakeLock?.request("screen");
    } catch {
      wakeLock = null;
    }
  };
  keepAwake();
  const onVisible = () => document.visibilityState === "visible" && !paused && keepAwake();
  document.addEventListener("visibilitychange", onVisible);
  onState("listening");

  return {
    get seconds() {
      return (activeMs + (paused ? 0 : Date.now() - since)) / 1000;
    },
    get paused() {
      return paused;
    },
    pause() {
      if (paused) return;
      paused = true;
      activeMs += Date.now() - since;
      if (recorder.state === "recording") recorder.pause();
      onState("paused");
    },
    resume() {
      if (!paused) return;
      paused = false;
      since = Date.now();
      if (recorder.state === "paused") recorder.resume();
      keepAwake();
      onState("listening");
    },
    // The transcript, and the recording as a file.
    async stop() {
      const seconds = this.seconds;
      paused = true;
      document.removeEventListener("visibilitychange", onVisible);
      const recorded = new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      });
      if (recorder.state !== "inactive") recorder.stop();
      const finished = new Promise((resolve) => (ended = resolve));
      worker.postMessage({ type: "live-stop" });
      const [blob, final] = await Promise.all([recorded, finished]);
      cleanup();
      const name = `live_${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      return { segments: final, seconds, audio: new File([blob], name, { type: blob.type }) };
    },
    // Ends it with nothing kept.
    discard() {
      paused = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (recorder.state !== "inactive") recorder.stop();
      cleanup();
    },
  };
}
