// This site's transcription API (server/app.py), signed in by the server's cookie.
// Refusals come back as {error, i18n_key, i18n_vars, details}: ApiRefusal carries
// that, for strings.js serverError() to put into words.

export class ApiRefusal extends Error {
  constructor(status, data) {
    super(data?.i18n_key || data?.error || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

let onSignedOut = () => {};
export const whenSignedOut = (fn) => (onSignedOut = fn);

async function call(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401) onSignedOut();
  if (!res.ok) throw new ApiRefusal(res.status, await res.json().catch(() => null));
  return raw ? res : res.json();
}

// A My files folder by its id (null or undefined: the top folder), on a path.
const inFolder = (path, folder) => (folder ? `${path}${path.includes("?") ? "&" : "?"}folder=${encodeURIComponent(folder)}` : path);

// What the Transcribe view asks for first, asked as soon as the page knows it is
// signed in (web/app.js), while the rest of the page starts: each answer is
// taken once, by the view's first call within EARLY_MS, and later calls ask the
// server again.
const EARLY_MS = 30000;
const early = new Map(); // key -> {asked, at}
function once(key, ask) {
  const kept = early.get(key);
  early.delete(key);
  return kept && Date.now() - kept.at < EARLY_MS ? kept.asked : ask();
}
export function prefetch() {
  const asks = { boot: bootNow, languages: languagesNow, folders: foldersNow, quota: quotaNow, toc: () => tocNow(null) };
  for (const [key, ask] of Object.entries(asks)) {
    if (early.has(key)) continue;
    const asked = ask();
    asked.catch(() => {}); // a refusal is the view's to handle, when it takes it
    early.set(key, { asked, at: Date.now() });
  }
}

const bootNow = () => call("/transcribe/boot");
const languagesNow = () => call("/languages");
const quotaNow = () => call("/quota");
const tocNow = (folder) => call(inFolder("/appdata/toc", folder));
const foldersNow = () => call("/appdata/folders");

export const boot = () => once("boot", bootNow);
export const languages = () => once("languages", languagesNow);
export const quota = () => once("quota", quotaNow);
export const balance = () => call("/balance");
export const toc = (folder) => (folder ? tocNow(folder) : once("toc", () => tocNow(null)));
export const rename = (resultsId, name, folder) => call(inFolder("/appdata/rename", folder), { method: "POST", body: { results_id: resultsId, new_filename: name } });
export const remove = (resultsId, folder) => call(inFolder("/appdata/delete", folder), { method: "POST", body: { results_id: resultsId } });
export const donate = (resultsId, folder) => call(inFolder("/appdata/donate_data", folder), { method: "POST", body: { results_id: resultsId, checkbox_confirmed: true } });

// Folders: {top, folders: [{id, name, parent}]}; made, renamed, and moved to Drive's trash.
export const folders = () => once("folders", foldersNow);
export const createFolder = (name, parent) => call("/appdata/folders", { method: "POST", body: { name, parent } });
export const renameFolder = (id, name) => call(`/appdata/folders/${encodeURIComponent(id)}/rename`, { method: "POST", body: { name } });
export const deleteFolder = (id) => call(`/appdata/folders/${encodeURIComponent(id)}`, { method: "DELETE" });
export const move = (resultsId, from, to) => call("/appdata/move", { method: "POST", body: { results_id: resultsId, from, to } });
export const saveRunpodKey = (key) => call("/runpod_key", { method: "POST", body: { runpod_token: key } });
export const removeRunpodKey = () => call("/runpod_key", { method: "DELETE" });
export const stats = () => call("/stats");
export const audioUrl = (resultsId, folder) => inFolder(`/appdata/audio/stream/${encodeURIComponent(resultsId)}`, folder);

// The transcript itself: stored gzipped, unpacked here.
export async function results(resultsId, folder) {
  const res = await call(inFolder(`/appdata/results/${encodeURIComponent(resultsId)}`, folder), { raw: true });
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

// Its edits, or null if it has none (404).
export async function edits(resultsId, folder) {
  try {
    return await call(inFolder(`/appdata/edits/${encodeURIComponent(resultsId)}`, folder));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// A transcript made on this device (local/), into My files: the segments gzipped,
// and the audio only if the user keeps it (for playback, in their Drive).
export async function saveLocal(meta, segments, audio) {
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  const packed = await new Response(new Blob([JSON.stringify(segments)]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
  form.append("results", packed, "results.json.gz");
  if (audio) form.append("audio", audio, audio.name || "audio");
  const res = await fetch("/appdata/local", { method: "POST", credentials: "same-origin", body: form });
  if (res.status === 401) onSignedOut();
  if (!res.ok) throw new ApiRefusal(res.status, await res.json().catch(() => null));
  return res.json();
}

// Transcribing on the user's devices only (the server then refuses their audio).
export const setLocalOnly = (on) => call("/settings", { method: "POST", body: { localOnly: on } });

export const saveEdits = (resultsId, state, folder) =>
  call(inFolder(`/appdata/edits/${encodeURIComponent(resultsId)}`, folder), { method: "POST", body: state });

export async function hasAudio(resultsId, folder) {
  const res = await fetch(audioUrl(resultsId, folder), { method: "HEAD", credentials: "same-origin" }).catch(() => null);
  return Boolean(res?.ok);
}

export const precheck = ({ size, language, saveAudio }) =>
  call("/upload/precheck", { method: "POST", body: { file_size: size, language, save_audio: saveAudio ? "true" : "false" } });

// A file up to the server, which transcodes it and queues it (its transcript lands in
// `folder`, or the top folder). onProgress({stage:
// "uploading" | "transcoding", percent}). Resolves once it is queued; rejects with
// an ApiRefusal (its words in .data) if the server says no.
export function upload(file, { language, saveAudio, folder }, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("language", language);
    form.append("save_audio", saveAudio ? "true" : "false");
    if (folder) form.append("folder", folder);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");
    xhr.setRequestHeader("Accept", "application/x-ndjson, application/json");
    let seen = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    // The server answers as it goes, one JSON object per line.
    const read = () => {
      const text = xhr.responseText;
      let end;
      while ((end = text.indexOf("\n", seen)) >= 0) {
        const line = text.slice(seen, end).trim();
        seen = end + 1;
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "transcoding_progress") onProgress?.({ stage: "transcoding", percent: event.progress_percent ?? null });
        else if (event.type === "transcoding_started" || event.type === "transcoding_waiting") onProgress?.({ stage: "transcoding", percent: 0 });
        else if (event.type === "transcoding_complete") finish(resolve, event);
        else if (event.type === "error") finish(reject, new ApiRefusal(event.status_code || 400, event));
      }
    };
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.({ stage: "uploading", percent: (e.loaded / e.total) * 100 });
    xhr.upload.onload = () => onProgress?.({ stage: "transcoding", percent: 0 });
    xhr.onprogress = read;
    xhr.onload = () => {
      read();
      if (xhr.status === 401) onSignedOut();
      if (settled) return;
      // Refused before streaming: a plain JSON answer.
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      finish(reject, new ApiRefusal(xhr.status, data || { i18n_key: "errorUploadFailed" }));
    };
    xhr.onerror = () => finish(reject, new ApiRefusal(0, { i18n_key: "errorNetworkError" }));
    xhr.send(form);
  });
}
