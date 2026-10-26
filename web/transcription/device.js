// My files without Google Drive: the same answers as the server's (api.js), from
// this device's own storage (IndexedDB "ivrit-device-files"). Used when there is
// no Drive to keep transcripts in: signed out, or signed in without Drive. What is
// here is made on the device (local/, live), so there is no queue, no quota and no
// server: every entry is Ready.
//
// Each entry belongs to the account it was made under (owner: its id, or null when
// signed out): an account sees its own and those made signed out on this device,
// and never another account's. Once Drive is connected, they can be moved there
// (view.js, moveToDrive).

const DB_NAME = "ivrit-device-files";
const TOP = "device"; // the top folder's id, as folders' parent
const STORES = ["entries", "results", "edits", "audio", "folders"];

let owner = null;
export const setOwner = (sub) => (owner = sub || null);
const mine = (row) => row.owner == null || row.owner === owner;

export const supported = () => Boolean(self.indexedDB);

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("entries", { keyPath: "results_id" });
      db.createObjectStore("results");
      db.createObjectStore("edits");
      db.createObjectStore("audio");
      db.createObjectStore("folders", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// One transaction over the stores named; fn(stores) returns a request (or an array
// of them) whose result(s) it resolves with.
async function run(names, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
      const out = fn(stores);
      tx.oncomplete = () => resolve(Array.isArray(out) ? out.map((r) => r?.result) : out?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("aborted"));
    });
  } finally {
    db.close();
  }
}

// A refusal shaped like the server's (api.ApiRefusal), for the same handling.
function refuse(status, i18n_key) {
  return Object.assign(new Error(i18n_key), { status, data: { i18n_key } });
}

async function entry(id) {
  const row = await run(["entries"], "readonly", (s) => s.entries.get(id));
  if (!row || !mine(row)) throw refuse(404, "gone");
  return row;
}

// ------------------------------------------------------------------ as api.js

export const boot = async () => ({ device: true, signedIn: false, localOnly: true, email: null });
export const languages = async () => ({ languages: { he: { enabled: true } }, batch: { max_batch_default: 10, max_batch_private: 10 } });

export async function toc(folder) {
  const rows = await run(["entries"], "readonly", (s) => s.entries.getAll());
  const where = folder || null;
  if (where && !(await folderRow(where))) throw refuse(404, "gone");
  return { entries: rows.filter((r) => mine(r) && (r.folder || null) === where).map(listed) };
}

// An entry as the list knows it (its owner stays here).
const listed = ({ owner: _owner, ...rest }) => rest;

export async function results(id) {
  await entry(id);
  return run(["results"], "readonly", (s) => s.results.get(id));
}

export async function edits(id) {
  await entry(id);
  return (await run(["edits"], "readonly", (s) => s.edits.get(id))) ?? null;
}

export async function saveEdits(id, state) {
  await entry(id);
  await run(["edits"], "readwrite", (s) => s.edits.put(state, id));
  return { ok: true };
}

// The recording, as a URL the reader's player can take at once (hasAudio first).
const audioUrls = new Map();
export async function hasAudio(id) {
  const blob = await run(["audio"], "readonly", (s) => s.audio.get(id)).catch(() => null);
  if (!blob) return false;
  if (!audioUrls.has(id)) audioUrls.set(id, URL.createObjectURL(blob));
  return true;
}
export const audioUrl = (id) => audioUrls.get(id) || "";
export const audioBlob = (id) => run(["audio"], "readonly", (s) => s.audio.get(id));

export async function rename(id, name) {
  const row = await entry(id);
  await run(["entries", "results"], "readwrite", (s) => {
    s.entries.put({ ...row, source_filename: name });
    const read = s.results.get(id);
    read.onsuccess = () => read.result && s.results.put({ ...read.result, source_filename: name }, id);
    return read;
  });
  return { ok: true };
}

export async function remove(id) {
  await entry(id);
  await run(STORES.slice(0, 4), "readwrite", (s) => ["entries", "results", "edits", "audio"].map((n) => s[n].delete(id)));
  const url = audioUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  audioUrls.delete(id);
  return { ok: true };
}

export async function move(id, _from, to) {
  const row = await entry(id);
  if (to && !(await folderRow(to))) throw refuse(404, "gone");
  await run(["entries"], "readwrite", (s) => s.entries.put({ ...row, folder: to || null }));
  return { ok: true };
}

// A transcript made here: {results_id}. The recording is kept only if given.
export async function save(meta, segments, audio) {
  const id = `device-${crypto.randomUUID()}`;
  const at = new Date().toISOString();
  const row = {
    results_id: id,
    source_filename: meta.filename || "",
    status: "Ready",
    submitted_at: at,
    completed_at: at,
    duration_seconds: meta.duration_seconds ?? null,
    language: meta.language || "he",
    engine: meta.engine || null,
    origin: meta.origin || null,
    folder: meta.folder || null,
    owner,
  };
  const doc = {
    results: segments,
    source_filename: row.source_filename,
    language: row.language,
    duration_seconds: row.duration_seconds,
    completed_at: at,
    engine: row.engine,
  };
  await run(["entries", "results", "audio"], "readwrite", (s) => {
    s.entries.put(row);
    s.results.put(doc, id);
    if (audio) s.audio.put(audio, id);
  });
  return { results_id: id, withoutAudio: false };
}

// ------------------------------------------------------------------ folders

const folderRow = async (id) => {
  const row = await run(["folders"], "readonly", (s) => s.folders.get(id));
  return row && mine(row) ? row : null;
};

export async function folders() {
  const rows = (await run(["folders"], "readonly", (s) => s.folders.getAll())).filter(mine);
  return { top: TOP, folders: rows.map(({ id, name, parent }) => ({ id, name, parent })) };
}

async function siblingNamed(name, parent, except) {
  const { folders: all } = await folders();
  return all.some((f) => f.parent === parent && f.id !== except && f.name === name);
}

export async function createFolder(name, parent) {
  const under = parent || TOP;
  if (!name || /[/\\]/.test(name)) throw refuse(400, "folderNameInvalid");
  if (parent && !(await folderRow(parent))) throw refuse(404, "gone");
  if (await siblingNamed(name, under)) throw refuse(409, "folderExists");
  const made = { id: `device-folder-${crypto.randomUUID()}`, name, parent: under, owner };
  await run(["folders"], "readwrite", (s) => s.folders.put(made));
  return { id: made.id, name, parent: under };
}

export async function renameFolder(id, name) {
  const row = await folderRow(id);
  if (!row) throw refuse(404, "gone");
  if (!name || /[/\\]/.test(name)) throw refuse(400, "folderNameInvalid");
  if (await siblingNamed(name, row.parent, id)) throw refuse(409, "folderExists");
  await run(["folders"], "readwrite", (s) => s.folders.put({ ...row, name }));
  return { id, name, parent: row.parent };
}

// A folder and everything under it: its folders and their transcripts.
export async function deleteFolder(id) {
  if (!(await folderRow(id))) throw refuse(404, "gone");
  const { folders: all } = await folders();
  const gone = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of all) {
      if (gone.has(f.id) || !gone.has(f.parent)) continue;
      gone.add(f.id);
      grew = true;
    }
  }
  const rows = await run(["entries"], "readonly", (s) => s.entries.getAll());
  for (const row of rows) if (mine(row) && gone.has(row.folder)) await remove(row.results_id);
  await run(["folders"], "readwrite", (s) => [...gone].map((f) => s.folders.delete(f)));
  return { ok: true };
}

// ------------------------------------------------------------------ moving to Drive

// Everything this account sees here, for moving to Drive: [{entry, folderPath}],
// folderPath being the folders' names from the top down.
export async function everything() {
  const { folders: all } = await folders();
  const byId = new Map(all.map((f) => [f.id, f]));
  const pathOf = (id) => {
    const path = [];
    for (let f = byId.get(id); f; f = byId.get(f.parent)) path.unshift(f.name);
    return path;
  };
  const rows = (await run(["entries"], "readonly", (s) => s.entries.getAll())).filter(mine);
  return rows.map((row) => ({ entry: listed(row), folderPath: row.folder ? pathOf(row.folder) : [] }));
}

export async function count() {
  if (!supported()) return 0;
  const rows = await run(["entries"], "readonly", (s) => s.entries.getAll()).catch(() => []);
  return rows.filter(mine).length;
}

// Folders left empty once their transcripts moved to Drive go too.
export async function dropEmptyFolders() {
  const { folders: all } = await folders();
  const rows = (await run(["entries"], "readonly", (s) => s.entries.getAll())).filter(mine);
  const used = new Set(rows.map((r) => r.folder));
  const keep = new Set();
  for (const id of used) for (let f = all.find((x) => x.id === id); f; f = all.find((x) => x.id === f.parent)) keep.add(f.id);
  const empty = all.filter((f) => !keep.has(f.id)).map((f) => f.id);
  if (empty.length) await run(["folders"], "readwrite", (s) => empty.map((id) => s.folders.delete(id)));
}

// ------------------------------------------------------------------ search

// This account's transcripts here, as search documents (search/engine.js), with
// edits applied by the caller's `effective` (the reader's own rules).
export async function searchDocs(effective) {
  const { folders: all } = await folders();
  const byId = new Map(all.map((f) => [f.id, f]));
  const pathOf = (id) => {
    const path = [];
    for (let f = byId.get(id); f; f = byId.get(f.parent)) path.unshift(f.name);
    return path;
  };
  const rows = (await run(["entries"], "readonly", (s) => s.entries.getAll())).filter(mine);
  const docs = [];
  for (const row of rows) {
    const [doc, state] = await run(["results", "edits"], "readonly", (s) => [s.results.get(row.results_id), s.edits.get(row.results_id)]);
    const segments = effective ? effective(doc?.results || [], state) : doc?.results || [];
    docs.push({
      id: row.results_id,
      title: row.source_filename,
      created: Date.parse(row.completed_at) || 0,
      duration: row.duration_seconds,
      language: row.language,
      origin: row.origin,
      segments: segments.map((s) => [s.start || 0, s.speakers?.[0] ?? null, s.text || ""]),
      collection: "transcript",
      folder: row.folder || null,
      folderPath: row.folder ? pathOf(row.folder) : [],
    });
  }
  return docs;
}
