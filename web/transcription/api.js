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

export const boot = () => call("/transcribe/boot");
export const languages = () => call("/languages");
export const quota = () => call("/quota");
export const balance = () => call("/balance");
export const toc = () => call("/appdata/toc");
export const rename = (resultsId, name) => call("/appdata/rename", { method: "POST", body: { results_id: resultsId, new_filename: name } });
export const remove = (resultsId) => call("/appdata/delete", { method: "POST", body: { results_id: resultsId } });
export const donate = (resultsId) => call("/appdata/donate_data", { method: "POST", body: { results_id: resultsId, checkbox_confirmed: true } });
export const saveRunpodKey = (key) => call("/runpod_key", { method: "POST", body: { runpod_token: key } });
export const removeRunpodKey = () => call("/runpod_key", { method: "DELETE" });
export const stats = () => call("/stats");
export const audioUrl = (resultsId) => `/appdata/audio/stream/${encodeURIComponent(resultsId)}`;

// The transcript itself: stored gzipped, unpacked here.
export async function results(resultsId) {
  const res = await call(`/appdata/results/${encodeURIComponent(resultsId)}`, { raw: true });
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

// Its edits, or null if it has none (404).
export async function edits(resultsId) {
  try {
    return await call(`/appdata/edits/${encodeURIComponent(resultsId)}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

export const saveEdits = (resultsId, state) => call(`/appdata/edits/${encodeURIComponent(resultsId)}`, { method: "POST", body: state });

export async function hasAudio(resultsId) {
  const res = await fetch(audioUrl(resultsId), { method: "HEAD", credentials: "same-origin" }).catch(() => null);
  return Boolean(res?.ok);
}

export const precheck = ({ size, language, saveAudio }) =>
  call("/upload/precheck", { method: "POST", body: { file_size: size, language, save_audio: saveAudio ? "true" : "false" } });

// A file up to the server, which transcodes it and queues it. onProgress({stage:
// "uploading" | "transcoding", percent}). Resolves once it is queued; rejects with
// an ApiRefusal (its words in .data) if the server says no.
export function upload(file, { language, saveAudio }, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("language", language);
    form.append("save_audio", saveAudio ? "true" : "false");
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
