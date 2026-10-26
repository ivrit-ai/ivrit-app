// What the search screen searches, kept current: the search indexes from the user's
// Drive (one per My files folder, and one for clips; server/search_index.py), kept
// on this device (IndexedDB "ivrit-search") so only those that changed are fetched
// again, and the inbox's messages, handed in by the app; without Drive, the
// transcripts kept on the device (setDeviceDocs). The searching itself is engine.js's.

import { createSearch } from "./engine.js";

const DB_NAME = "ivrit-search";
const STORE = "shards";
// An index still being made (old transcripts indexed a few at a time): ask again.
const PENDING_RETRY_MS = 1200;
const PENDING_ROUNDS = 40;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const cached = (shard) => idb("readonly", (s) => s.get(shard)).catch(() => undefined);
const keep = (shard, value) => idb("readwrite", (s) => s.put(value, shard)).catch(() => {});
const cachedShards = () => idb("readonly", (s) => s.getAllKeys()).catch(() => []);
const drop = (shard) => idb("readwrite", (s) => s.delete(shard)).catch(() => {});

// One index from the server, gunzipped; asked again while entries are still being made.
async function fetchShard(shard, onPending) {
  for (let round = 0; round < PENDING_ROUNDS; round++) {
    const res = await fetch(`/appdata/search/index?shard=${encodeURIComponent(shard)}`, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) throw Object.assign(new Error(`index ${res.status}`), { status: res.status });
    const pending = Number(res.headers.get("X-Pending") || 0);
    const index = JSON.parse(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text());
    onPending(shard, pending);
    if (!pending) return index;
    await new Promise((r) => setTimeout(r, PENDING_RETRY_MS));
  }
  throw new Error("index still being made");
}

export function createLibrary({ sourceName, onChange = () => {} } = {}) {
  const engine = createSearch({ sourceName });
  let tree = { top: null, folders: [] };
  const pending = new Map(); // shard → entries still being indexed
  let loading = null;
  let available = true; // false when this browser has no Drive (signed in to the app only)
  let onDevice = false; // My files is kept on the device, and handed in

  const folderById = (id) => tree.folders.find((f) => f.id === id);
  // A folder's names from just under the top down to it.
  function pathOf(id) {
    const path = [];
    for (let f = folderById(id); f; f = folderById(f.parent)) path.unshift(f.name);
    return path;
  }

  function docsOf(shard, index) {
    const clip = shard === "clips";
    const folder = clip ? null : shard === "top" ? tree.top : shard;
    const folderPath = clip ? [] : pathOf(folder);
    return Object.entries(index.docs || {}).map(([id, d]) => ({ ...d, id, collection: clip ? "clip" : "transcript", folder, folderPath }));
  }

  async function load() {
    const res = await fetch("/appdata/search/manifest", { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (!res || res.status === 401 || res.status === 403) {
      available = false;
      return;
    }
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    available = true;
    const manifest = await res.json();
    tree = { top: manifest.top, folders: manifest.folders || [] };
    engine.setFolders(Object.fromEntries(tree.folders.map((f) => [f.id, f.parent])));
    const wanted = new Set(manifest.shards.map((s) => s.shard));
    // Shards gone (a folder deleted): out of the search and off the device.
    for (const shard of await cachedShards()) {
      if (!wanted.has(shard)) {
        engine.removeShard(shard);
        drop(shard);
      }
    }
    for (const { shard, version } of manifest.shards) {
      const kept = await cached(shard);
      if (kept) engine.setShard(shard, docsOf(shard, kept.index));
      if (kept && version && kept.version === version) continue;
      try {
        const index = await fetchShard(shard, (s, n) => {
          pending.set(s, n);
          onChange();
        });
        engine.setShard(shard, docsOf(shard, index));
        keep(shard, { version, index });
      } catch (err) {
        console.warn("search index", shard, err);
      } finally {
        pending.delete(shard);
      }
      onChange();
    }
  }

  return {
    engine,
    tree: () => tree,
    pathOf,
    available: () => available || onDevice,
    /** My files kept on the device (transcription/device.js searchDocs). */
    setDeviceDocs(docs) {
      onDevice = true;
      engine.setShard("device", docs);
    },
    pending: () => [...pending.values()].reduce((a, b) => a + b, 0),
    /** Brings the indexes up to date (once at a time); resolves when done. */
    refresh() {
      loading ||= load()
        .catch((err) => console.warn("search", err))
        .finally(() => {
          loading = null;
          onChange();
        });
      return loading;
    },
    loading: () => Boolean(loading),
    setMessages: (list) => engine.setMessages(list),
    addMessages: (list) => engine.addMessages(list),
    removeMessages: (ids) => engine.removeMessages(ids),
    /** Off the device (signing out). */
    async clear() {
      for (const shard of await cachedShards()) {
        engine.removeShard(shard);
        await drop(shard);
      }
      engine.setMessages([]);
    },
  };
}
