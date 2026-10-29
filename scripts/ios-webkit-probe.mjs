// Does on-device transcription work in the iPhone's WebKit? On a Mac, in the iOS
// Simulator's Safari (the engine the app's WKWebView runs): the web app's own
// local/ code transcribes the Hebrew fixture as AAC (Voice Memos) and as Ogg
// Opus (WhatsApp's voice notes), and says whether Live has what it needs.
//
//   node scripts/ios-webkit-probe.mjs      (CI: .github/workflows/ios-webkit.yml)
//
// Prints the page's findings as JSON; fails when no file was transcribed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WEB = path.join(ROOT, "web");
const FIXTURES = path.join(ROOT, "store/fixtures");
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".json": "application/json", ".css": "text/css" };

// The page: the same modules the app loads, run on the fixtures, the answer posted back.
const PROBE = `<!doctype html><meta charset="utf-8"><title>probe</title><body>probe<script type="module">
const out = { ua: navigator.userAgent, isolated: self.crossOriginIsolated, threads: navigator.hardwareConcurrency };
const post = () => fetch("/result", { method: "POST", body: JSON.stringify(out) });
try {
  const local = await import("/transcription/local/local.js");
  const live = await import("/transcription/local/live.js");
  Object.assign(out, { local: local.supported(), live: live.supported(), audioWorklet: Boolean(self.AudioWorkletNode),
    mediaRecorder: Boolean(self.MediaRecorder), getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
    recorderTypes: ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"].filter((t) => self.MediaRecorder?.isTypeSupported?.(t)) });
  for (const name of ["hebrew-12s.m4a", "hebrew-12s.ogg"]) {
    const started = Date.now();
    try {
      const blob = await (await fetch("/fixtures/" + name)).blob();
      const result = await local.transcribe(new File([blob], name, { type: blob.type }), {
        onProgress: ({ stage }) => (out[name] = { stage }),
      });
      out[name] = { ms: Date.now() - started, seconds: result.duration, text: result.segments.map((s) => s.text).join(" ").slice(0, 120) };
    } catch (err) {
      out[name] = { ...out[name], error: String(err?.message || err).slice(0, 300) };
    }
    await post();
  }
} catch (err) {
  out.error = String(err?.stack || err).slice(0, 500);
}
out.done = true;
await post();
</script>`;

let result = null;
let finished;
const done = new Promise((resolve) => (finished = resolve));
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (req.method === "POST" && pathname === "/result") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      result = JSON.parse(body);
      console.log(new Date().toISOString(), JSON.stringify(result));
      if (result.done) finished();
      res.writeHead(204).end();
    });
    return;
  }
  if (pathname === "/probe.html") return res.writeHead(200, { "content-type": "text/html" }).end(PROBE);
  const file = pathname.startsWith("/fixtures/") ? path.join(FIXTURES, pathname.slice(10)) : path.join(WEB, pathname);
  try {
    if (!file.startsWith(WEB) && !file.startsWith(FIXTURES)) throw new Error("outside");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(8123, "127.0.0.1", resolve));

// The newest iPhone simulator there is, booted, with Safari on the page.
const { devices } = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "available", "-j"], { encoding: "utf8" }));
const [runtime, phones] = Object.entries(devices).filter(([r, list]) => /iOS/.test(r) && list.some((d) => /iPhone/.test(d.name))).sort().at(-1);
const phone = phones.filter((d) => /iPhone/.test(d.name)).at(-1);
console.log("simulator:", phone.name, runtime.split(".").at(-1));
if (phone.state !== "Booted") execFileSync("xcrun", ["simctl", "boot", phone.udid]);
execFileSync("xcrun", ["simctl", "bootstatus", phone.udid, "-b"], { stdio: "inherit" });
execFileSync("xcrun", ["simctl", "openurl", phone.udid, "http://localhost:8123/probe.html"]);

const timeout = setTimeout(finished, 15 * 60_000);
await done;
clearTimeout(timeout);
server.close();
const ok = ["hebrew-12s.m4a", "hebrew-12s.ogg"].some((name) => result?.[name]?.text);
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
