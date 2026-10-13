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
  config = await api.languages().catch(() => null);
  folder = folderInHash();
  await Promise.all([loadTree(), refresh(), renderQuota(), recorder.renderRecovered($("tr-recovered"))]);
  route();
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
      recorder.supported() ? el("button", { class: "btn", type: "button", onclick: () => recorder.choose() }, [icon("mic"), el("span", { text: tr("record") })]) : null,
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
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    list.classList.remove("dropping");
    chooseFiles([...(e.dataTransfer?.files || [])]);
  });
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
  } catch (err) {
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
  const signature = JSON.stringify([folder, tree, list, [...pending.values()].filter((p) => p.folder === folder), language()]);
  if (!force && signature === drawn) return;
  drawn = signature;
  drawPath();
  const cards = [
    ...[...pending.entries()].filter(([, p]) => p.folder === folder).map(([id, p]) => pendingCard(id, p)),
    ...subfolders.map(folderCard),
    ...list.map((entry, i) => entryCard(entry, i + subfolders.length)),
  ];
  if (!cards.length) return feed.replaceChildren(folder ? emptyFolder() : empty());
  feed.replaceChildren(...cards);
}

// ------------------------------------------------------------------ folders

async function loadTree() {
  try {
    tree = await api.folders();
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
    entries = [];
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
function folderPicker(selected, { exclude } = {}) {
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
  const text = p.stage === "uploading"
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
    const minutes = Math.max(0, Math.floor(q.remainingMinutes));
    const amount = minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} ${tr("hours")}` : `${minutes} ${tr("minutes")}`;
    line.replaceChildren(
      document.createTextNode(`${tr("quotaLine", { amount })} · `),
      host.el("a", { href: boot?.quotaIncreaseUrl || "https://youtu.be/xr8RQRFERLs", target: "_blank", rel: "noopener", text: tr("howToGetMoreQuota") })
    );
  } catch {
    line.textContent = "";
  }
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
  const languages = Object.entries(config?.languages || { he: { enabled: true } }).filter(([, c]) => c.enabled).map(([key]) => key);
  const order = ["he", "en", "fr", "es", "de", "zh", "yi"];
  languages.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const preferred = localStorage.getItem("tr_language");
  const select = el("select", { class: "tr-select", "aria-label": tr("transcribeLanguage") },
    languages.map((key) => el("option", { value: key, text: LANGUAGE_NAMES[key] || key })));
  select.value = languages.includes(preferred) ? preferred : languages.includes("he") ? "he" : languages[0];
  const keep = el("input", { type: "checkbox", checked: localStorage.getItem("tr_save_audio") !== "false" });
  const destination = folderPicker(folder);
  const list = el("div", { class: "list" });
  const drawFiles = () => list.replaceChildren(...chosen.map((file, i) => el("div", { class: "list-row" }, [
    el("div", { class: "grow" }, [el("div", { dir: "auto", text: file.name }), el("div", { class: "sub", dir: "ltr", text: size(file.size) })]),
    el("button", { class: "icon-btn", type: "button", "aria-label": tr("removeFile"), onclick: () => {
      chosen.splice(i, 1);
      if (!chosen.length) return host.sheet.close();
      drawFiles();
    } }, [icon("close")]),
  ])));
  drawFiles();
  const more = batchLimit() > 1
    ? el("button", { class: "btn quiet small", type: "button", onclick: () => $("tr-input").click() }, [icon("plus"), el("span", { text: tr("addFiles") })])
    : null;
  const go = el("button", { class: "btn primary large", type: "submit", text: tr("transcribe") });
  const form = el("form", { class: "stack tr-new" }, [
    list,
    more,
    el("label", { class: "tr-field" }, [el("span", { class: "muted", text: tr("transcribeLanguage") }), select]),
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
    const files = chosen;
    chosen = [];
    host.sheet.close();
    send(files, { language: select.value, saveAudio: keep.checked, folder: destination.value || null });
  });
  host.sheet.open(tr("newTitle"), form, () => (chosen = []));
}

// One after another, as transcribe.ivrit.ai did: each checked, uploaded and
// prepared by the server, then queued; the list shows each on its way.
async function send(files, options) {
  // The list follows the files to where they are going.
  if (options.folder !== folder) openFolder(options.folder);
  else showList(folder);
  let queued = 0;
  for (const file of files) {
    const id = crypto.randomUUID();
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
      host.toast(`${file.name}: ${serverError(err.data, "uploadError")}`);
      pending.delete(id);
      draw();
      break;
    }
    pending.delete(id);
  }
  if (queued) host.toast(queued > 1 ? tr("batchQueued", { count: queued }) : tr("fileQueued"));
  renderQuota();
  refresh();
}

// ------------------------------------------------------------------ screens

// Back to a folder's list (the one shown, unless named), as from a transcript.
function showList(to = folder) {
  if (location.hash.startsWith("#t/")) {
    history.replaceState(null, "", to ? `#f/${encodeURIComponent(to)}` : location.pathname);
  }
  showFolder(to);
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
