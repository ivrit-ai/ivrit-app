import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createSessions } from "./session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "web");
const APP = JSON.parse(readFileSync(path.join(__dirname, "shared/app.json"), "utf8"));
// Generated with the Android signing keys; absent until the first build.
const ASSET_LINKS = path.join(__dirname, "shared/assetlinks.json");

const PORT = Number(process.env.XHOSTD_HTTP_PORT || process.env.XHOST_HTTP_PORT || process.env.PORT || 8080);

// Where the app's services live. Overridable for a staging Communicator; the
// defaults are the public addresses, which are not secrets.
const CONFIG = {
  communicator: (process.env.COMMUNICATOR_URL || APP.communicator).replace(/\/+$/, ""),
  transcribe: (process.env.TRANSCRIBE_URL || APP.transcribe).replace(/\/+$/, ""),
  eliezer: (process.env.ELIEZER_URL || APP.eliezer).replace(/\/+$/, ""),
  // The app's web OAuth client: Google issues the app's ID tokens to it, and
  // Eliezer accepts tokens issued to it. Unset, transcribing in the app is off.
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
};
const CONFIG_JS = `self.IVRIT_CONFIG = ${JSON.stringify(CONFIG)};\n`;

// The app's sign-in sessions (see session.js). Their issuer is this site.
const sessions = createSessions({
  issuer: (process.env.APP_SESSION_ISSUER || `https://${APP.host}`).replace(/\/+$/, ""),
  googleClientId: CONFIG.googleClientId,
  privateKeyPem: process.env.APP_SESSION_KEY,
  googleJwksUrl: process.env.GOOGLE_JWKS_URL,
});

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// The service worker must never be cached, or a stale one keeps running
// indefinitely and users stop receiving pushes after a bad deploy.
app.use((req, res, next) => {
  if (req.path === "/sw.js") res.setHeader("Cache-Control", "no-cache");
  next();
});

app.get("/config.js", (req, res) => {
  res.type("application/javascript").setHeader("Cache-Control", "no-cache");
  res.send(CONFIG_JS);
});

// Android checks this to let the app open app.ivrit.ai without browser UI.
app.get("/.well-known/assetlinks.json", (req, res) => {
  if (!existsSync(ASSET_LINKS)) return res.status(404).json([]);
  res.type("application/json").sendFile(ASSET_LINKS);
});

// Signing in: a Google ID token in, a session out; and renewing a session.
app.get("/.well-known/jwks.json", (req, res) => {
  if (!sessions) return res.status(404).json({ keys: [] });
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json(sessions.jwks);
});

app.post("/auth/google", express.json({ limit: "8kb" }), async (req, res) => {
  if (!sessions) return res.status(503).json({ error: "sign_in_unavailable" });
  try {
    res.json(await sessions.fromGoogle(String(req.body?.idToken ?? "")));
  } catch (err) {
    console.warn(JSON.stringify({ msg: "google_sign_in_rejected", err: String(err.code ?? err.message) }));
    res.status(401).json({ error: "invalid_token" });
  }
});

app.post("/auth/renew", async (req, res) => {
  if (!sessions) return res.status(503).json({ error: "sign_in_unavailable" });
  const header = req.get("authorization") ?? "";
  try {
    res.json(await sessions.renew(header.startsWith("Bearer ") ? header.slice(7) : ""));
  } catch {
    res.status(401).json({ error: "invalid_session" });
  }
});

app.get("/privacy", (req, res) => res.sendFile(path.join(WEB_DIR, "privacy.html")));

// The on-device transcription lab (web/lab/): its probe and benchmark pages
// post their results here, and they land in the log, one JSON line each.
app.post("/lab/report", express.text({ type: "*/*", limit: "2mb" }), (req, res) => {
  let body = req.body;
  try {
    body = JSON.parse(req.body);
  } catch {}
  console.log(JSON.stringify({ msg: "lab_report", kind: String(req.query.kind ?? "").slice(0, 20), ua: req.get("user-agent"), body }));
  res.status(204).end();
});
// Google Play's account deletion page: how to delete, with or without the app.
app.get("/delete-account", (req, res) => res.sendFile(path.join(WEB_DIR, "delete-account.html")));

// A share the service worker did not catch (it was not installed yet). The
// file cannot be recovered; landing in the app beats a 404.
app.post("/share-target", (req, res) => res.redirect(303, "/"));

// The Android app runs this site, so a fix must reach it on the next open:
// code and pages are revalidated every time (cheap, by ETag); only fonts and
// icons, which never change in place, are cached for a while.
app.use(
  express.static(WEB_DIR, {
    etag: true,
    index: ["index.html"],
    setHeaders(res, file) {
      const lasting = /\.(woff2|png|svg)$/.test(file);
      res.setHeader("Cache-Control", lasting ? "public, max-age=86400" : "no-cache");
    },
  })
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "listening", port: PORT, ...CONFIG }));
  const readyFile = process.env.XHOST_READY_FILE;
  if (readyFile && !existsSync(readyFile)) writeFileSync(readyFile, "");
});
