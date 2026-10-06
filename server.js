import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

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
};
const CONFIG_JS = `self.IVRIT_CONFIG = ${JSON.stringify(CONFIG)};\n`;

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

app.get("/privacy", (req, res) => res.sendFile(path.join(WEB_DIR, "privacy.html")));
// Google Play's account deletion page: how to delete, with or without the app.
app.get("/delete-account", (req, res) => res.sendFile(path.join(WEB_DIR, "delete-account.html")));

// A share the service worker did not catch (it was not installed yet). The
// file cannot be recovered; landing in the app beats a 404.
app.post("/share-target", (req, res) => res.redirect(303, "/"));

app.use(express.static(WEB_DIR, { etag: true, index: ["index.html"], maxAge: "1h" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "listening", port: PORT, ...CONFIG }));
  const readyFile = process.env.XHOST_READY_FILE;
  if (readyFile && !existsSync(readyFile)) writeFileSync(readyFile, "");
});
