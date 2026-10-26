// The Transcribe tab: the user's transcripts, newest first, as cards like the inbox's,
// with what is on its way (uploading, preparing, queued, transcribing) at the top;
// "Upload a file" and "Record" start a new one, in a sheet. A transcript opens as a
// screen of its own (reader.js). Everything is kept in the user's Google Drive by the
// server (api.js); this is only how it looks.
//
// My files has folders (real Drive folders, each with its own transcripts): the list
// shows one folder at a time, its subfolders first, under a path back to the top
// (#f/<folder> in the address; the top folder has none).

import * as api from "./api.js";
import * as reader from "./reader.js";
import * as recorder from "./recorder.js";
import * as local from "./local/local.js";
import { language, serverError, setLanguage, tr } from "./strings.js";
import { clock } from "./transcript.js";

const MAX_FILE_SIZE = 3 * 1024 ** 3;
const POLL_MS = 5000;
const LANGUAGE_NAMES = { he: "עברית", en: "English", fr: "Français", es: "Español", de: "Deutsch", zh: "中文", yi: "ייִדיש" };
const ACTIVE = new Set(["Queued", "Being processed", "Transcoding..."]);

let host = null;
let root = null;
let boot = null;
let config = null; // /languages
let entries = [];
let folder = null; // the folder shown (null: the top folder)
let tree = null; // {top, folders: [{id, name, parent}]}
let drawn = "";
let dealt = undefined; // the folder whose cards have come in (they animate once)
let loaded = false; // the shown folder's list has come from the server
let pollTimer = null;
const pending = new Map(); // uploads in progress, by a local id: {name, stage, percent}

// ------------------------------------------------------------------ mounting

export async function mount(container, hostApi, bootData) {
  host = hostApi;
  boot = bootData;
  setLanguage(host.locale());
  api.whenSignedOut(() => host.signedOut());
  reader.init(host, { refresh: () => refresh(), back: (from) => showList(from) });
  recorder.init(host, { take: (file) => chooseFiles([file]) });
  root = host.el("div", { class: "tr" });
  container.replaceChildren(root);
  renderShell();
  addEventListener("hashchange", route);
  // Leaving while a file is on its way loses it: the server never gets the rest.
  addEventListener("beforeunload", (e) => {
    if (pending.size) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  folder = folderInHash();
  // What was last seen here, drawn at once while the server is asked again
  // (Drive takes a moment); placeholders the first time.
  const seen = remembered();
  tree = seen?.tree ?? null;
  entries = seen?.tocs?.[folder ?? ""] ?? [];
  loaded = false;
  draw(true);
  if (seen?.quota) showQuota(seen.quota);
  // Languages are for the new-file sheet: not waited for.
  api.languages().then((c) => {
    config = c;
    const input = $("tr-input");
    if (input) input.multiple = batchLimit() > 1;
  }, () => {});
  await Promise.all([loadTree(), refresh(), renderQuota(), recorder.renderRecovered($("tr-recovered"))]);
  route();
}

// ------------------------------------------------------------------ last seen

// The list as this browser last saw it, per account: the folder tree, the lists
// of the folders opened lately, and the quota line. Only a quicker first look:
// the server's answer always replaces it. Gone at sign-out (forgetSeen).
const SEEN_KEY = "tr_seen";
const SEEN_FOLDERS = 8;

function remembered() {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
    return seen && seen.email === boot?.email ? seen : null;
  } catch {
    return null;
  }
}

function remember(change) {
  if (!boot?.email) return;
  try {
    const seen = remembered() || { email: boot.email, tocs: {} };
    if (change.toc) {
      const [key, list] = change.toc;
      delete seen.tocs[key];
      seen.tocs[key] = list;
      const keys = Object.keys(seen.tocs);
      for (const old of keys.slice(0, Math.max(0, keys.length - SEEN_FOLDERS))) delete seen.tocs[old];
    }
    if ("tree" in change) seen.tree = change.tree;
    if ("quota" in change) seen.quota = change.quota;
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {}
}

export function forgetSeen() {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {}
}

export function relocalize(locale) {
  setLanguage(locale);
  if (!root) return;
  renderShell();
  draw(true);
  renderQuota();
  recorder.renderRecovered($("tr-recovered"));
  reader.relocalize();
}

const $ = (id) => document.getElementById(id);

function renderShell() {
  const { el, icon } = host;
  const input = el("input", { id: "tr-input", type: "file", accept: "audio/*,video/*", hidden: true, multiple: batchLimit() > 1, onchange: (e) => {
    chooseFiles([...e.target.files]);
    e.target.value = "";
  } });
  const list = el("section", { id: "tr-list", class: "tr-list" }, [
    el("div", { class: "tr-head" }, [
      el("div", { class: "grow" }, [
        el("h2", { class: "title", text: tr("viewTitle") }),
        el("p", { id: "tr-quota", class: "lede tr-quota" }),
      ]),
      el("button", { class: "icon-btn", type: "button", "aria-label": tr("searchFiles"), title: tr("searchFiles"), onclick: () => host.openSearch() }, [icon("search")]),
      el("button", { class: "icon-btn", type: "button", "aria-label": tr("settings"), title: tr("settings"), onclick: () => host.openSettings() }, [icon("settings")]),
    ]),
    el("div", { class: "row tr-actions" }, [
      el("button", { class: "btn primary", type: "button", onclick: () => input.click() }, [icon("plus"), el("span", { text: tr("uploadFile") })]),
      recorder.supported() ? el("button", { class: "btn", type: "button", onclick: () => record() }, [icon("mic"), el("span", { text: tr("record") })]) : null,
      el("button", { class: "btn quiet", type: "button", onclick: () => newFolder() }, [icon("folder-plus"), el("span", { text: tr("newFolder") })]),
      input,
    ]),
    el("div", { id: "tr-recovered" }),
    el("nav", { id: "tr-path", class: "tr-path", "aria-label": tr("foldersPath") }),
    el("div", { id: "tr-feed", class: "feed" }),
  ]);
  const screen = el("section", { id: "tr-screen", class: "tr-screen", hidden: true });
  root.replaceChildren(list, screen);
  // Files dropped anywhere on the list.
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    list.classList.add("dropping");
  });
  list.addEventListener("dragleave", (e) => e.target === list && list.classList.remove("dropping"));
  list.addEventListener("drop", async (e) => {
    e.preventDefault();
    list.classList.remove("dropping");
    chooseFiles(await droppedFiles(e.dataTransfer));
  });
}

// What was dropped: files, and the audio and video inside dropped folders (at any
// depth), as transcribe.ivrit.ai took them. The entries are taken at once: the
// drop's items are gone once the event is over.
const MEDIA = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|wma|amr|webm|mp4|m4v|mov|mkv|avi|3gp)$/i;
const isMedia = (file) => /^(audio|video)\//.test(file.type) || MEDIA.test(file.name);

async function droppedFiles(transfer) {
  const entries = [...(transfer?.items || [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((entry) => entry.isDirectory)) return [...(transfer?.files || [])];
  const files = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (file && isMedia(file)) files.push(file);
      return;
    }
    const reader = entry.createReader();
    // readEntries answers in batches, until an empty one.
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (!batch.length) break;
      for (const child of batch) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  if (!files.length) host.toast(tr("noMediaInFolder"));
  return files;
}

// ------------------------------------------------------------------ the list

export async function refresh() {
  if (!host) return;
  clearTimeout(pollTimer);
  const shown = folder;
  try {
    const toc = await api.toc(shown);
    if (shown !== folder) return; // moved on meanwhile
    entries = toc.entries || [];
    loaded = true;
    remember({ toc: [shown ?? "", entries] });
  } catch (err) {
    if (shown === folder) loaded = true;
    // A folder deleted or renamed elsewhere: back to the top.
    if (err.status === 404 && shown) return openFolder(null);
    if (err.status !== 401) host.toast(serverError(err.data, "filesLoadError"));
  }
  draw();
  // While anything is on its way, look again.
  if (pending.size || entries.some((e) => ACTIVE.has(e.status))) pollTimer = setTimeout(refresh, POLL_MS);
}

function sorted() {
  const order = { "Transcoding...": 0, Queued: 1, "Being processed": 2 };
  return [...entries].sort((a, b) => {
    const rank = (order[a.status] ?? 3) - (order[b.status] ?? 3);
    if (rank) return rank;
    return new Date(b.completed_at || b.submitted_at || 0) - new Date(a.completed_at || a.submitted_at || 0);
  });
}

function draw(force = false) {
  const feed = $("tr-feed");
  if (!feed) return;
  const list = sorted();
  const subfolders = childrenOf(folder);
  const signature = JSON.stringify([folder, loaded, tree, list, [...pending.values()].filter((p) => p.folder === folder), language()]);
  if (!force && signature === drawn) return;
  drawn = signature;
  drawPath();
  const cards = [
    ...[...pending.entries()].filter(([, p]) => p.folder === folder).map(([id, p]) => pendingCard(id, p)),
    ...subfolders.map(folderCard),
    ...list.map((entry, i) => entryCard(entry, i + subfolders.length)),
  ];
  // A folder's cards come in once; redrawn with the server's answer, or as a
  // job moves on, they stay put.
  feed.classList.toggle("still", dealt === folder);
  if (!cards.length && !loaded) return feed.replaceChildren(...placeholders());
  dealt = folder;
  if (!cards.length) return feed.replaceChildren(folder ? emptyFolder() : empty());
  feed.replaceChildren(...cards);
}

// Where the list will be, until it comes.
function placeholders() {
  const { el } = host;
  return [0, 1, 2].map((i) => el("div", { class: "msg tr-file tr-placeholder", style: `--i:${i}`, "aria-hidden": "true" }, [
    el("span", { class: "tr-bar wide" }),
    el("span", { class: "tr-bar" }),
  ]));
}

// ------------------------------------------------------------------ folders

async function loadTree() {
  try {
    tree = await api.folders();
    remember({ tree });
  } catch (err) {
    if (err.status !== 401) tree = tree || { top: null, folders: [] };
  }
  draw(true);
}

const folderById = (id) => tree?.folders.find((f) => f.id === id) || null;
const childrenOf = (id) =>
  (tree?.folders || []).filter((f) => f.parent === (id || tree.top)).sort((a, b) => a.name.localeCompare(b.name, language()));

// The folders from the top down to `id`: [{id, name}], the top first (id null).
function pathTo(id) {
  const path = [];
  for (let f = folderById(id); f; f = folderById(f.parent)) path.unshift({ id: f.id, name: f.name });
  return [{ id: null, name: tr("back") }, ...path];
}

// Every folder, as a flat list under its parents, for pickers: [{id, name, depth}].
function folderChoices() {
  const out = [{ id: null, name: tr("back"), depth: 0 }];
  const walk = (parent, depth) => childrenOf(parent).forEach((f) => {
    out.push({ id: f.id, name: f.name, depth });
    walk(f.id, depth + 1);
  });
  walk(null, 1);
  return out;
}

function folderInHash() {
  const match = location.hash.match(/^#f\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function openFolder(id) {
  const next = id || null;
  const hash = next ? `#f/${encodeURIComponent(next)}` : "";
  if (location.hash !== hash) history.pushState(null, "", hash || location.pathname + location.search);
  showFolder(next);
}

function showFolder(id) {
  $("tr-screen").hidden = true;
  $("tr-list").hidden = false;
  if (id !== folder) {
    folder = id;
    entries = remembered()?.tocs?.[id ?? ""] ?? [];
    loaded = false;
    drawn = "";
    draw(true);
  }
  refresh();
}

function drawPath() {
  const nav = $("tr-path");
  if (!nav) return;
  const { el, icon } = host;
  if (!folder) return nav.replaceChildren();
  const path = pathTo(folder);
  const crumbs = path.flatMap((step, i) => {
    const last = i === path.length - 1;
    const node = last
      ? el("span", { class: "tr-crumb current", dir: "auto", "aria-current": "page", text: step.name })
      : el("button", { class: "tr-crumb", type: "button", dir: "auto", text: step.name, onclick: () => openFolder(step.id) });
    return i ? [el("span", { class: "tr-crumb-sep", "aria-hidden": "true", text: "›" }), node] : [node];
  });
  nav.replaceChildren(
    el("div", { class: "tr-crumbs" }, crumbs),
    el("button", { class: "icon-btn", type: "button", "aria-label": tr("renameFolder"), title: tr("renameFolder"), onclick: () => renameFolder(folder) }, [icon("edit")]),
    el("button", { class: "icon-btn", type: "button", "aria-label": tr("deleteFolder"), title: tr("deleteFolder"), onclick: () => deleteFolder(folder) }, [icon("trash")])
  );
}

function folderCard(f, index) {
  const { el, icon } = host;
  const inside = childrenOf(f.id).length;
  return el("article", { class: "msg tr-file tr-folder openable", style: `--i:${Math.min(index, 12)}`, onclick: () => openFolder(f.id) }, [
    el("span", { class: "avatar tr-glyph", "aria-hidden": "true" }, [icon("folder")]),
    el("div", { class: "msg-main" }, [
      inside ? el("div", { class: "msg-head" }, [el("span", { text: tr("subfoldersCount", { count: inside }) })]) : null,
      el("h3", { class: "msg-title", dir: "auto", text: f.name }),
    ]),
  ]);
}

function emptyFolder() {
  const { el } = host;
  return el("div", { class: "empty" }, [el("h3", { text: tr("folderEmptyTitle") }), el("p", { text: tr("folderEmptyBody") })]);
}

function nameSheet(title, value, onSave) {
  const { el } = host;
  const input = el("input", { class: "tr-input", value, dir: "auto", maxlength: 100, "aria-label": tr("folderName") });
  const save = el("button", { class: "btn primary", type: "submit", text: tr("save") });
  const form = el("form", { class: "stack" }, [input, el("div", { class: "row end" }, [save])]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name || name === value) return host.sheet.close();
    save.disabled = true;
    try {
      await onSave(name);
      host.sheet.close();
    } catch (err) {
      host.toast(serverError(err.data, "folderError"));
      save.disabled = false;
    }
  });
  host.sheet.open(title, form);
  setTimeout(() => input.select(), 50);
}

function newFolder(parent = folder, then) {
  nameSheet(tr("newFolder"), "", async (name) => {
    const made = await api.createFolder(name, parent);
    await loadTree();
    if (then) then(made);
    else openFolder(made.id);
  });
}

function renameFolder(id) {
  const f = folderById(id);
  if (!f) return;
  nameSheet(tr("renameFolder"), f.name, async (name) => {
    const renamed = await api.renameFolder(id, name);
    await loadTree();
    // On a phone's disk a folder's id is its path, and changes with its name.
    if (renamed.id !== id) openFolder(renamed.id);
    else draw(true);
  });
}

async function deleteFolder(id) {
  const f = folderById(id);
  if (!f) return;
  if (!(await host.ask(tr("deleteFolderConfirm", { name: f.name }), { ok: tr("deleteFolder"), danger: true }))) return;
  try {
    await api.deleteFolder(id);
    await loadTree();
    openFolder(f.parent === tree?.top ? null : f.parent);
  } catch (err) {
    host.toast(serverError(err.data, "folderError"));
  }
}

// A picker of every folder, for "Move to…" and an upload's destination.
export function folderPicker(selected, { exclude } = {}) {
  const { el } = host;
  const select = el("select", { class: "tr-select", "aria-label": tr("saveTo") },
    folderChoices()
      .filter((c) => c.id !== exclude)
      .map((c) => el("option", { value: c.id || "", text: `${"\u00a0\u00a0".repeat(c.depth > 0 ? c.depth - 1 : 0)}${c.depth > 1 ? "› " : ""}${c.name}` })));
  select.value = selected || "";
  return select;
}

function moveEntry(entry) {
  const { el, icon } = host;
  const select = folderPicker(folder);
  const go = el("button", { class: "btn primary", type: "submit", text: tr("moveHere") });
  const form = el("form", { class: "stack" }, [
    el("label", { class: "tr-field" }, [el("span", { class: "muted", text: tr("moveToLabel") }), select]),
    el("button", { class: "btn quiet small", type: "button", onclick: () => {
      host.sheet.close();
      newFolder(folder, () => moveEntry(entry));
    } }, [icon("folder-plus"), el("span", { text: tr("newFolder") })]),
    el("div", { class: "row end" }, [go]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const to = select.value || null;
    if (to === folder) return host.sheet.close();
    go.disabled = true;
    try {
      await api.move(entry.results_id, folder, to);
      host.sheet.close();
      entries = entries.filter((x) => x !== entry);
      draw();
      host.toast(tr("movedTo", { name: to ? folderById(to)?.name || "" : tr("back") }));
    } catch (err) {
      host.toast(serverError(err.data, "moveError"));
      go.disabled = false;
    }
  });
  host.sheet.open(tr("moveTo"), form);
}

function empty() {
  const { el } = host;
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-art", "aria-hidden": "true" }, [el("span"), el("span")]),
    el("h3", { text: tr("emptyTitle") }),
    el("p", { text: tr("emptyBody") }),
  ]);
}

function when(entry) {
  const at = entry.completed_at || entry.submitted_at;
  if (!at) return "";
  const date = new Date(at);
  return date.toLocaleString(language() === "en" ? undefined : "he-IL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function eta(seconds) {
  if (seconds == null || seconds < 0) return "";
  return tr("etaIn", { eta: clock(seconds) });
}

function glyph() {
  return host.el("span", { class: "avatar tr-glyph", "aria-hidden": "true" }, [host.icon("wave")]);
}

function entryCard(entry, index) {
  const { el, icon } = host;
  const ready = entry.status === "Ready";
  const failed = entry.status === "Failed";
  let tag = null;
  let note = null;
  let progress = null;
  if (entry.status === "Queued") {
    tag = el("span", { class: "tag", text: entry.queue_position ? tr("statusQueuedAt", { position: entry.queue_position }) : tr("statusQueued") });
    note = eta(entry.eta_seconds);
  } else if (entry.status === "Being processed" || entry.status === "Transcoding...") {
    const percent = entry.progress_percent;
    tag = el("span", { class: "tag accent", text: percent != null ? tr("statusTranscribingAt", { progress: Math.round(percent) }) : tr("statusTranscribing") });
    progress = percent != null ? percent : null;
    note = eta(entry.eta_seconds);
  } else if (failed) {
    tag = el("span", { class: "tag danger", text: tr("statusFailed") });
    note = [entry.failure_reason ? tr(entry.failure_reason) : tr("statusError"), entry.quota_refunded ? tr("quotaRefunded") : null].filter(Boolean).join(" · ");
  } else if (ready && entry.engine) {
    // Made on the user's device: no speakers.
    tag = el("span", { class: "tag", text: tr("madeOnDevice") });
  }
  const open = () => ready && reader.navigate(entry.results_id, folder);
  const actions = el("div", { class: "msg-actions" }, [
    el("span", { class: "spacer" }),
    ready ? el("button", { class: "act", type: "button", onclick: (e) => { e.stopPropagation(); open(); } }, [icon("chevron"), el("span", { text: tr("open") })]) : null,
    ready ? el("button", { class: "act", type: "button", "aria-label": tr("renameFile"), title: tr("renameFile"), onclick: (e) => { e.stopPropagation(); renameEntry(entry); } }, [icon("edit")]) : null,
    ready ? el("button", { class: "act", type: "button", "aria-label": tr("moveTo"), title: tr("moveTo"), onclick: (e) => { e.stopPropagation(); moveEntry(entry); } }, [icon("folder")]) : null,
    ready || failed ? el("button", { class: "act", type: "button", "aria-label": tr("delete"), title: tr("delete"), onclick: (e) => { e.stopPropagation(); deleteEntry(entry); } }, [icon("trash")]) : null,
  ]);
  return el("article", { class: `msg tr-file${ready ? " openable" : ""}`, style: `--i:${Math.min(index, 12)}`, onclick: open }, [
    glyph(),
    el("div", { class: "msg-main" }, [
      el("div", { class: "msg-head" }, [
        tag,
        entry.duration_seconds ? el("span", { text: clock(entry.duration_seconds) }) : null,
        LANGUAGE_NAMES[entry.language] && entry.language !== "he" ? el("span", { text: LANGUAGE_NAMES[entry.language] }) : null,
        el("time", { text: when(entry) }),
      ]),
      el("h3", { class: "msg-title", dir: "auto", text: entry.source_filename || tr("untitled") }),
      progress != null ? el("div", { class: "tr-progress" }, [el("span", { style: `width:${Math.max(2, progress)}%` })]) : null,
      note ? el("div", { class: "tr-note", text: note }) : null,
      actions,
    ]),
  ]);
}

function pendingCard(id, p) {
  const { el } = host;
  const percent = p.percent == null ? null : Math.round(p.percent);
  const text = p.stage === "local" ? localStatus(p, percent)
    : p.stage === "uploading"
      ? tr("statusUploading", { progress: percent ?? 0 })
      : percent ? tr("statusPreparing", { progress: percent }) : tr("statusPreparingStart");
  return el("article", { class: "msg tr-file" }, [
    glyph(),
    el("div", { class: "msg-main" }, [
      el("div", { class: "msg-head" }, [el("span", { class: "tag accent", text }), p.size ? el("span", { dir: "ltr", text: size(p.size) }) : null]),
      el("h3", { class: "msg-title", dir: "auto", text: p.name }),
      el("div", { class: "tr-progress" }, [el("span", { style: `width:${Math.max(2, percent ?? 0)}%` })]),
    ]),
  ]);
}

// On this device: the recording read, the model fetched (once), transcribed, saved.
function localStatus(p, percent) {
  if (p.phase === "handing") return tr("statusLocalHanding", { progress: percent ?? 0 });
  if (p.phase === "queued") return tr("statusLocalQueued");
  if (p.phase === "model") return tr("statusLocalModel", { progress: percent ?? 0 });
  if (p.phase === "transcribing") {
    const status = tr("statusLocalTranscribing", { progress: percent ?? 0 });
    return p.left == null ? status : `${status} · ${eta(p.left)}`;
  }
  if (p.phase === "saving") return tr("statusLocalSaving");
  return tr("statusLocalPreparing");
}

async function renameEntry(entry) {
  const { el } = host;
  const input = el("input", { class: "tr-input", value: entry.source_filename || "", dir: "auto", "aria-label": tr("renameFile") });
  const save = el("button", { class: "btn primary", type: "submit", text: tr("save") });
  const form = el("form", { class: "stack" }, [input, el("div", { class: "row end" }, [save])]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name || name === entry.source_filename) return host.sheet.close();
    save.disabled = true;
    try {
      await api.rename(entry.results_id, name, folder);
      entry.source_filename = name;
      host.sheet.close();
      draw(true);
    } catch (err) {
      host.toast(serverError(err.data, "renameError"));
      save.disabled = false;
    }
  });
  host.sheet.open(tr("renameFile"), form);
  setTimeout(() => input.select(), 50);
}

async function deleteEntry(entry) {
  if (!(await host.ask(tr("deleteConfirm", { filename: entry.source_filename || "" }), { ok: tr("delete"), danger: true }))) return;
  try {
    await api.remove(entry.results_id, folder);
    entries = entries.filter((e) => e !== entry);
    draw();
  } catch (err) {
    host.toast(serverError(err.data, "deleteError"));
  }
}

// ------------------------------------------------------------------ the quota

async function renderQuota() {
  const line = $("tr-quota");
  if (!line) return;
  try {
    if (boot?.runpodKeyStatus?.has_key) {
      const b = await api.balance();
      line.textContent = typeof b.clientBalance === "number" ? tr("balanceLine", { amount: `$${b.clientBalance.toFixed(2)}` }) : "";
      return;
    }
    const q = await api.quota();
    remember({ quota: { remainingMinutes: q.remainingMinutes } });
    showQuota(q);
  } catch {
    line.textContent = "";
  }
}

function showQuota(q) {
  const line = $("tr-quota");
  if (!line || boot?.runpodKeyStatus?.has_key) return;
  const minutes = Math.max(0, Math.floor(q.remainingMinutes));
  const amount = minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} ${tr("hours")}` : `${minutes} ${tr("minutes")}`;
  line.replaceChildren(
    document.createTextNode(`${tr("quotaLine", { amount })} · `),
    host.el("a", { href: boot?.quotaIncreaseUrl || "https://youtu.be/xr8RQRFERLs", target: "_blank", rel: "noopener", text: tr("howToGetMoreQuota") })
  );
}

export function setBoot(bootData) {
  boot = bootData;
  renderQuota();
}

// ------------------------------------------------------------------ new transcriptions

function batchLimit() {
  const batch = config?.batch;
  if (!batch) return 1;
  return boot?.runpodKeyStatus?.has_key ? batch.max_batch_private : batch.max_batch_default;
}

function size(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

let chosen = [];

// Files to transcribe (picked, dropped, shared in, recorded): the sheet to send them.
export function chooseFiles(files) {
  if (!host) return;
  const fresh = [];
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      host.toast(`${tr("fileTooLarge", { size: "3GB" })}: ${file.name}`);
      continue;
    }
    fresh.push(file);
  }
  chosen = [...chosen, ...fresh];
  const limit = batchLimit();
  if (chosen.length > limit) {
    host.toast(tr("batchLimitExceeded", { limit }));
    chosen = chosen.slice(0, limit);
  }
  if (chosen.length) openNewSheet();
}

function openNewSheet() {
  const { el, icon } = host;
  // On the user's devices only: the on-device model speaks Hebrew alone.
  const onDevice = Boolean(boot?.localOnly);
  const languages = onDevice
    ? [local.LANGUAGE]
    : Object.entries(config?.languages || { he: { enabled: true } }).filter(([, c]) => c.enabled).map(([key]) => key);
  const order = ["he", "en", "fr", "es", "de", "zh", "yi"];
  languages.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const preferred = localStorage.getItem("tr_language");
  const select = el("select", { class: "tr-select", "aria-label": tr("transcribeLanguage") },
    languages.map((key) => el("option", { value: key, text: LANGUAGE_NAMES[key] || key })));
  select.value = languages.includes(preferred) ? preferred : languages.includes("he") ? "he" : languages[0];
  const keep = el("input", { type: "checkbox", checked: localStorage.getItem("tr_save_audio") !== "false" });
  const destination = folderPicker(folder);
  const list = el("div", { class: "list" });
  // A take just recorded can be heard, saved or deleted before it is sent.
  const previews = new Map(); // File -> object URL
  const preview = (file) => {
    if (!previews.has(file)) previews.set(file, URL.createObjectURL(file));
    return previews.get(file);
  };
  const drawFiles = () => list.replaceChildren(...chosen.map((file, i) => {
    const take = recorder.isTake(file);
    return el("div", { class: `list-row${take ? " tr-take" : ""}` }, [
      el("div", { class: "grow" }, [
        el("div", { dir: "auto", text: file.name }),
        el("div", { class: "sub", dir: "ltr", text: size(file.size) }),
        take ? el("audio", { class: "tr-take-audio", controls: true, preload: "metadata", src: preview(file) }) : null,
      ]),
      take ? el("button", { class: "icon-btn", type: "button", "aria-label": tr("downloadRecording"), title: tr("downloadRecording"), onclick: () => recorder.download(file, file.name) }, [icon("download")]) : null,
      take ? el("button", { class: "icon-btn", type: "button", "aria-label": tr("discardRecording"), title: tr("discardRecording"), onclick: async () => {
        if (!(await host.ask(tr("discardRecordingConfirm"), { ok: tr("discardRecording"), danger: true }))) return;
        await recorder.discard(file);
        chosen.splice(chosen.indexOf(file), 1);
        if (!chosen.length) return host.sheet.close();
        drawFiles();
      } }, [icon("trash")]) : null,
      el("button", { class: "icon-btn", type: "button", "aria-label": tr("removeFile"), onclick: () => {
        chosen.splice(i, 1);
        if (!chosen.length) return host.sheet.close();
        drawFiles();
      } }, [icon("close")]),
    ]);
  }));
  drawFiles();
  const more = batchLimit() > 1
    ? el("button", { class: "btn quiet small", type: "button", onclick: () => $("tr-input").click() }, [icon("plus"), el("span", { text: tr("addFiles") })])
    : null;
  // Where, for Hebrew: ivrit.ai's servers (with speakers) or this device (no
  // speakers, nothing uploaded to be transcribed). Not asked when the user chose
  // their devices only.
  let where = localStorage.getItem("tr_where") === "device" ? "device" : "server";
  const whereBox = el("div", { class: "tr-field" });
  const drawWhere = () => {
    const show = !onDevice && canTranscribeHere(select.value);
    whereBox.hidden = !show;
    if (!show) return;
    const option = (value, label, sub) => el("button", {
      class: "tr-choice-row", type: "button", "aria-pressed": String(where === value),
      onclick: () => {
        where = value;
        drawWhere();
      },
    }, [el("span", { text: label }), el("span", { class: "sub", text: sub })]);
    whereBox.replaceChildren(
      el("span", { class: "muted", text: tr("whereTitle") }),
      el("div", { class: "seg wide tr-where", role: "group" }, [
        option("server", tr("whereServer"), tr("whereServerSub")),
        option("device", tr("whereDevice"), tr("whereDeviceSub")),
      ]),
    );
  };
  select.addEventListener("change", drawWhere);
  drawWhere();
  const go = el("button", { class: "btn primary large", type: "submit", text: tr("transcribe") });
  const form = el("form", { class: "stack tr-new" }, [
    list,
    more,
    el("label", { class: "tr-field" }, [el("span", { class: "muted", text: tr("transcribeLanguage") }), select]),
    onDevice ? el("p", { class: "muted", text: tr("localOnlyHint") }) : whereBox,
    tree?.folders.length ? el("label", { class: "tr-field" }, [el("span", { class: "muted", text: tr("saveTo") }), destination]) : null,
    el("label", { class: "tr-check" }, [keep, el("span", {}, [
      el("span", { text: tr("saveAudioInDrive") }),
      el("span", { class: "sub", text: tr("saveAudioInfoText") }),
    ])]),
    go,
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    localStorage.setItem("tr_language", select.value);
    localStorage.setItem("tr_save_audio", String(keep.checked));
    const here = !whereBox.hidden && where === "device";
    if (!whereBox.hidden) localStorage.setItem("tr_where", where);
    const files = chosen;
    chosen = [];
    host.sheet.close();
    send(files, { language: select.value, saveAudio: keep.checked, folder: destination.value || null, where: here ? "device" : "server" });
  });
  host.sheet.open(tr("newTitle"), form, () => {
    chosen = [];
    for (const url of previews.values()) URL.revokeObjectURL(url);
  });
}

// One after another, as transcribe.ivrit.ai did: each checked, uploaded and
// prepared by the server, then queued; the list shows each on its way.
async function send(files, options) {
  // The list follows the files to where they are going.
  if (options.folder !== folder) openFolder(options.folder);
  else showList(folder);
  let queued = 0;
  let saved = 0;
  // On this device: when the user chose it for good, or for the rest of this
  // batch once the free time ran out.
  let onDevice = Boolean(boot?.localOnly) || options.where === "device";
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const id = crypto.randomUUID();
    if (onDevice) {
      if (!(await sendLocally(file, options, id))) break;
      saved++;
      continue;
    }
    pending.set(id, { name: file.name, size: file.size, stage: "uploading", percent: 0, folder: options.folder });
    draw();
    try {
      await api.precheck({ size: file.size, language: options.language, saveAudio: options.saveAudio });
      await api.upload(file, options, ({ stage, percent }) => {
        pending.set(id, { name: file.name, size: file.size, stage, percent, folder: options.folder });
        draw();
      });
      queued++;
      recorder.sent(file);
    } catch (err) {
      pending.delete(id);
      draw();
      if (outOfFreeTime(err) && canTranscribeHere(options.language)) {
        const choice = await outOfTimeChoice();
        if (choice === "device") {
          onDevice = true;
          i--; // this file again, here
          continue;
        }
        if (choice === "runpod") {
          host.openSettings();
          break;
        }
      }
      host.toast(`${file.name}: ${serverError(err.data, "uploadError")}`);
      break;
    }
    pending.delete(id);
  }
  if (queued) host.toast(queued > 1 ? tr("batchQueued", { count: queued }) : tr("fileQueued"));
  if (saved) host.toast(tr("localSaved"));
  // Something to be told about when it is done: the app may ask about notifications.
  if (queued || saved) host.sent?.();
  renderQuota();
  refresh();
}

// A recording the phone is transcribing (native, in the background): its card,
// from the phone's reports, until it is in My files.
export function deviceJob(item) {
  if (!item?.key) return;
  const id = `device:${item.key}`;
  if (item.phase === "done" || item.phase === "failed") {
    pending.delete(id);
    if (item.phase === "failed" && item.error && item.error !== "gone") {
      const why = item.error === "driveFullKept" ? tr("driveFullKept") : item.error === "errorDriveStorageFull" ? tr("errorDriveStorageFull") : tr("localFailed", { details: item.error });
      host?.toast(`${item.name}: ${why}`);
    }
    draw();
    refresh();
    return;
  }
  pending.set(id, {
    name: item.name,
    stage: "local",
    phase: item.phase,
    percent: (item.fraction ?? 0) * 100,
    left: item.secondsLeft != null ? Number(item.secondsLeft) : null,
    folder: item.folder || null,
  });
  draw();
}

const outOfFreeTime = (err) => ["errorRateLimitExceeded", "errorFileTooLargeForFreeService"].includes(err?.data?.i18n_key);
const canTranscribeHere = (lang) => lang === local.LANGUAGE && (local.supported() || Boolean(host?.canTranscribeOnPhone?.()));

// Out of free time: on this device (no speakers), with the user's own RunPod key
// (the servers, with speakers, no weekly limit), or not now.
function outOfTimeChoice() {
  const { el } = host;
  return new Promise((resolve) => {
    let chosen = null;
    const pick = (value) => () => {
      chosen = value;
      host.sheet.close();
    };
    host.sheet.open(tr("outOfTimeTitle"), el("div", { class: "stack" }, [
      el("p", { class: "muted", text: tr("outOfTimeBody") }),
      el("button", { class: "btn primary", type: "button", text: tr("transcribeOnDevice"), onclick: pick("device") }),
      el("button", { class: "btn", type: "button", text: tr("useRunpodKey"), onclick: pick("runpod") }),
      el("button", { class: "btn quiet", type: "button", text: tr("notNow"), onclick: pick(null) }),
    ]), () => resolve(chosen));
  });
}

// One file through the on-device model, with progress in its card, then into My
// files. False when it could not be done (the user was told why).
async function sendLocally(file, options, id) {
  const card = (fields) => {
    pending.set(id, { name: file.name, size: file.size, stage: "local", folder: options.folder, ...fields });
    draw();
  };
  // In the app, the phone does it, in the background (with the app closed too).
  if (host.canTranscribeOnPhone?.()) {
    try {
      card({ phase: "handing", percent: 0 });
      await host.transcribeOnPhone(file, options, (fraction) => card({ phase: "handing", percent: fraction * 100 }));
      recorder.sent(file);
      return true;
    } catch (err) {
      host.toast(`${file.name}: ${tr("localFailed", { details: err?.message || "" })}`);
      return false;
    } finally {
      pending.delete(id);
      draw();
    }
  }
  card({ phase: "decoding", percent: 0 });
  let transcribingSince = null;
  try {
    const { segments, duration } = await local.transcribe(file, {
      onProgress: ({ stage, fraction }) => {
        if (stage === "transcribing" && transcribingSince === null) transcribingSince = { at: Date.now(), fraction };
        // Time left, from the pace so far (after the first few percent).
        let left = null;
        if (stage === "transcribing" && fraction - transcribingSince.fraction > 0.03) {
          const rate = (fraction - transcribingSince.fraction) / (Date.now() - transcribingSince.at);
          left = (1 - fraction) / rate / 1000;
        }
        card({ phase: stage, percent: fraction * 100, left });
      },
    });
    card({ phase: "saving", percent: 100 });
    try {
      const saved = await api.saveLocalFitting(
        { filename: file.name, language: local.LANGUAGE, duration_seconds: duration, folder: options.folder, origin: options.origin, engine: local.ENGINE },
        segments,
        options.saveAudio ? file : null
      );
      if (saved.withoutAudio) host.toast(`${file.name}: ${tr("savedWithoutAudio")}`);
    } catch (err) {
      if (!api.driveFull(err)) throw err;
      // No room even for the words: they stay on this device, not lost.
      if (await host.saveFile(api.plainTextFile(segments), `${file.name.replace(/\.[^.]{1,5}$/, "")}.txt`)) host.toast(`${file.name}: ${tr("driveFullKeptHere")}`);
      return false;
    }
    recorder.sent(file);
    return true;
  } catch (err) {
    if (err instanceof local.TooLong) host.toast(`${file.name}: ${tr("localTooLong", { hours: local.MAX_SECONDS / 3600 })}`);
    else if (err instanceof api.ApiRefusal) host.toast(`${file.name}: ${serverError(err.data, "errorLocalSaveFailed")}`);
    else host.toast(`${file.name}: ${tr("localFailed", { details: err?.message || "" })}`);
    return false;
  } finally {
    pending.delete(id);
    draw();
  }
}

// ------------------------------------------------------------------ screens

// Back to a folder's list (the one shown, unless named), as from a transcript.
function showList(to = folder) {
  if (location.hash.startsWith("#t/")) {
    history.replaceState(null, "", to ? `#f/${encodeURIComponent(to)}` : location.pathname);
  }
  showFolder(to);
}

// The microphone is the Live tab's while it transcribes.
function record() {
  if (host.liveBusy?.()) return host.toast(tr("liveRunning"));
  recorder.choose();
}

export function showScreen(node) {
  $("tr-list").hidden = true;
  const screen = $("tr-screen");
  screen.replaceChildren(node);
  screen.hidden = false;
  scrollTo({ top: 0 });
}

// #t/<results id>[?f=<folder>&s=<segment>]: a transcript; #t/stats: Stats for Nerds;
// #f/<folder>: a folder's list.
async function route() {
  const inFolder = folderInHash();
  if (location.hash.startsWith("#f/")) {
    host.showTranscribe();
    if (!$("tr-screen").hidden && reader.busy()) return;
    return showFolder(inFolder);
  }
  const match = location.hash.match(/^#t\/([^?]+)(?:\?(.*))?$/);
  if (!match) {
    if (!$("tr-screen").hidden && !reader.busy()) showList(null);
    else if ($("tr-screen").hidden && folder && !location.hash) showFolder(null);
    return;
  }
  host.showTranscribe();
  const id = decodeURIComponent(match[1]);
  if (id === "stats") return import("./nerds.js").then((m) => m.open(host, showScreen));
  const query = new URLSearchParams(match[2] || "");
  let where = query.get("f") || null;
  const at = query.has("t") ? Number(query.get("t")) : null;
  // A link that names no folder (a notification, an older link): find it.
  if (!query.has("f") && !entries.some((e) => e.results_id === id)) where = await locate(id);
  const entry = where === folder ? entries.find((e) => e.results_id === id) : undefined;
  reader.open(id, entry, where, at);
}

// The folder a transcript is in: the top folder's list first, then each folder's.
async function locate(id) {
  const look = async (f) => ((await api.toc(f).catch(() => ({ entries: [] }))).entries || []).some((e) => e.results_id === id);
  if (await look(null)) return null;
  if (!tree) await loadTree();
  for (const f of tree?.folders || []) if (await look(f.id)) return f.id;
  return null;
}

export const openResults = (id, inFolder, at) => reader.navigate(id, inFolder, at);

// The folder shown in My files (null: the top folder).
export const currentFolder = () => folder;

// Recording: the app must not be left (it would cut it off).
export const capturing = () => recorder.busy();
