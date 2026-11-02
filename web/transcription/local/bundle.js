// The on-device model, when the phone app carries it (the shell's "bundledModel",
// scripts/fetch-model.sh): read from the app in pieces for the worker (worker.js),
// which then downloads nothing and keeps no second copy.
//   worker → page: {type: "bundle-read", name}
//   page → worker: {type: "bundle-piece", name, bytes, end}, or {…, error}

// Each file under its own name, and its size (for the progress shown while loading).
const SIZES = {
  "config.json": 10365,
  "tokens.txt": 17086,
  "encoder.int8.onnx": 70478964,
  "decoder.int8.onnx": 1049105,
  "joiner.int8.onnx": 771805,
};
const PIECE = 4 << 20; // the most the shell reads at a time

let source = null; // {available(), read(name, offset, length) → base64}

export function useBundledModel(s) {
  source = s;
}

// The bundled files' sizes, for the worker's start message; null without them.
export const bundled = () => (source?.available() ? SIZES : null);

const fromBase64 = (data) => (Uint8Array.fromBase64 ? Uint8Array.fromBase64(data) : Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));

// Answers the worker's requests for the bundled files.
export function serve(worker) {
  if (!bundled()) return;
  worker.addEventListener("message", async ({ data }) => {
    if (data?.type !== "bundle-read") return;
    const { name } = data;
    try {
      for (let offset = 0; ; offset += PIECE) {
        const bytes = fromBase64(await source.read(name, offset, PIECE));
        const end = bytes.length < PIECE;
        worker.postMessage({ type: "bundle-piece", name, bytes, end }, [bytes.buffer]);
        if (end) break;
      }
    } catch (err) {
      worker.postMessage({ type: "bundle-piece", name, error: err?.message || "model read failed" });
    }
  });
}
