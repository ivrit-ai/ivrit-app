// A transcript, as a screen of its own: its audio, the text by speaker (a sentence
// plays from where it is), and what can be done with it - edit, copy, export, change
// how it reads, its statistics, donate it, delete it.
//
// Editing is in place: each sentence (segment) is edited where it stands, a speaker's
// name or a passage's speaker through a sheet. Saved as transcribe.ivrit.ai saves it
// (transcript.js), so the two read each other's edits; an unsaved draft is kept on the
// device (editDraft:<id>, as transcribe.ivrit.ai keeps it) and offered back.

import * as api from "./api.js";
import { language, serverError, tr } from "./strings.js";
import { showScreen } from "./view.js";
import {
  RTL, clock, docxHtml, effective, emptyEdits, hasEdits, json, layout, normalizeEdits, plainText,
  speakerId, speakerLabel, speakerNumber, speakerOf, speakersIn, srt, statistics, vtt,
} from "./transcript.js";

const DISPLAY_KEY = "displaySettings";
const DEFAULT_DISPLAY = { textFormat: "continuous", timestampFormat: "none", diarizationDisplay: "enabled" };
const LANGUAGE_NAMES = { he: "עברית", en: "English", fr: "Français", es: "Español", de: "Deutsch", zh: "中文", yi: "ייִדיש" };

let host = null;
let hooks = null;
let doc = null; // {id, entry, results, language, saved, audio}
let working = null; // the edits as they stand in edit mode
let mode = "new"; // new | original | compared
let editing = false;

export function init(hostApi, viewHooks) {
  host = hostApi;
  hooks = viewHooks;
  addEventListener("visibilitychange", () => document.visibilityState === "hidden" && keepDraft());
  addEventListener("pagehide", keepDraft);
  addEventListener("beforeunload", (e) => {
    if (dirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

export const navigate = (id) => (location.hash = `#t/${encodeURIComponent(id)}`);
export const busy = () => dirty();

export function relocalize() {
  if (doc) render();
}

function display() {
  try {
    return { ...DEFAULT_DISPLAY, ...JSON.parse(localStorage.getItem(DISPLAY_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_DISPLAY };
  }
}

function setDisplay(change) {
  localStorage.setItem(DISPLAY_KEY, JSON.stringify({ ...display(), ...change }));
  render();
}

const dirty = () => editing && doc && JSON.stringify(working) !== JSON.stringify(doc.saved);

function keepDraft() {
  if (!doc) return;
  const key = `editDraft:${doc.id}`;
  if (dirty()) localStorage.setItem(key, JSON.stringify(working));
  else if (!editing) return;
  else localStorage.removeItem(key);
}

// ------------------------------------------------------------------ opening

export async function open(id, entry) {
  if (doc?.id === id && document.getElementById("tr-reader")) return;
  const { el } = host;
  editing = false;
  mode = "new";
  doc = null;
  showScreen(el("div", { class: "tr-reader", id: "tr-reader" }, [backButton(), el("p", { class: "muted tr-loading", text: tr("loadingFile") })]));
  try {
    const [results, edits, audio] = await Promise.all([api.results(id), api.edits(id), api.hasAudio(id)]);
    doc = {
      id,
      entry: entry || { results_id: id, source_filename: results.source_filename, duration_seconds: results.duration_seconds, completed_at: results.completed_at, language: results.language },
      results: results.results || [],
      language: results.language || entry?.language || "he",
      saved: normalizeEdits(edits || emptyEdits()),
      audio,
    };
  } catch (err) {
    if (err.status === 404) host.toast(tr("gone"));
    else if (err.status !== 401) host.toast(serverError(err.data, "fileLoadError"));
    return leave();
  }
  render();
  offerDraft();
}

async function offerDraft() {
  const key = `editDraft:${doc.id}`;
  const raw = localStorage.getItem(key);
  if (!raw) return;
  let draft;
  try {
    draft = normalizeEdits(JSON.parse(raw));
  } catch {
    return localStorage.removeItem(key);
  }
  if (JSON.stringify(draft) === JSON.stringify(doc.saved)) return localStorage.removeItem(key);
  if (await host.ask(tr("restoreEditDraftConfirm"), { ok: tr("edit") })) startEditing(draft);
  else localStorage.removeItem(key);
}

async function leave() {
  if (dirty() && !(await host.ask(tr("unsavedLeave"), { ok: tr("discardEdits"), danger: true }))) {
    // Stay: the hash already moved on; put it back.
    history.replaceState(null, "", `#t/${encodeURIComponent(doc.id)}`);
    return;
  }
  if (doc) localStorage.removeItem(`editDraft:${doc.id}`);
  editing = false;
  doc = null;
  hooks.back();
}

function backButton() {
  const { el, icon } = host;
  return el("button", { class: "btn quiet small tr-back", type: "button", onclick: () => leave() }, [icon("back"), el("span", { text: tr("back") })]);
}

// ------------------------------------------------------------------ the screen

function render() {
  if (!doc) return;
  const { el } = host;
  const entry = doc.entry;
  const lang = doc.language;
  const meta = [
    entry.duration_seconds ? clock(entry.duration_seconds) : null,
    entry.completed_at ? new Date(entry.completed_at).toLocaleDateString(language() === "en" ? undefined : "he-IL", { day: "numeric", month: "long", year: "numeric" }) : null,
    LANGUAGE_NAMES[lang] || lang,
  ].filter(Boolean).join(" · ");
  const previous = document.getElementById("tr-audio");
  const audio = doc.audio
    ? previous || el("audio", { id: "tr-audio", controls: true, preload: "metadata", src: api.audioUrl(doc.id) })
    : null;
  if (audio && !audio.dataset.wired) {
    audio.dataset.wired = "1";
    audio.addEventListener("timeupdate", follow);
  }
  const screen = el("div", { class: "tr-reader", id: "tr-reader" }, [
    backButton(),
    el("h2", { class: "title", dir: "auto", text: entry.source_filename || tr("untitled") }),
    el("p", { class: "lede" }, [
      document.createTextNode(meta),
      hasEdits(doc.saved) ? el("span", { class: "tag tr-edited", text: tr("edited") }) : null,
    ]),
    audio ? el("div", { class: "card tr-player" }, [audio]) : null,
    editing ? editBar() : toolbar(),
    !editing && hasEdits(doc.saved) ? modeSwitch() : null,
    el("article", { class: `card tr-text${editing ? " editing" : ""}`, id: "tr-text", dir: RTL(lang) ? "rtl" : "ltr", lang }, transcriptNodes()),
  ]);
  showScreen(screen);
}

function toolbar() {
  const { el, icon } = host;
  const act = (name, label, run, extra = {}) =>
    el("button", { class: "act", type: "button", title: label, "aria-label": label, onclick: run, ...extra }, [icon(name), el("span", { text: label })]);
  const canDonate = doc.audio && !doc.entry.donated;
  return el("div", { class: "msg-actions tr-toolbar" }, [
    act("edit", tr("edit"), () => startEditing(doc.saved)),
    act("copy", tr("copy"), copyText),
    act("download", tr("export"), exportSheet),
    act("display", tr("display"), displaySheet),
    act("chart", tr("statistics"), statsSheet),
    canDonate ? act("heart", tr("donate"), donateSheet) : null,
    el("span", { class: "spacer" }),
    el("button", { class: "act", type: "button", title: tr("delete"), "aria-label": tr("delete"), onclick: deleteIt }, [icon("trash")]),
  ]);
}

function modeSwitch() {
  const { el } = host;
  const button = (value, label) => el("button", { type: "button", "aria-pressed": String(mode === value), text: label, onclick: () => {
    mode = value;
    render();
  } });
  return el("div", { class: "seg tr-modes", role: "group" }, [button("new", tr("viewEdited")), button("original", tr("viewOriginal")), button("compared", tr("viewCompared"))]);
}

// The text: by speaker (and by time range, if shown), each sentence its own span.
function transcriptNodes() {
  const { el } = host;
  const settings = display();
  const edits = editing ? working : doc.saved;
  // The original shows the speakers as transcribed; names still apply.
  const segments = mode === "new" || editing ? effective(doc.results, edits) : doc.results;
  const names = edits.speakerNames;
  const nodes = [];
  for (const block of layout(segments, settings)) {
    if (block.range) nodes.push(el("div", { class: "tr-range", dir: "ltr", text: `[${block.range}]` }));
    for (const turn of block.turns) {
      const parts = [];
      if (turn.speaker !== undefined) {
        const label = speakerLabel(turn.speaker, doc.language, names);
        const tone = turn.speaker ? `speaker-${((Math.max(1, speakerNumber(turn.speaker)) - 1) % 10) + 1}` : "";
        parts.push(editing
          ? el("button", { class: `tr-who ${tone}`, type: "button", text: label, onclick: () => speakerSheet(turn) })
          : el("span", { class: `tr-who ${tone}`, text: label }));
      }
      turn.indices.forEach((i, n) => {
        if (n) parts.push(settings.textFormat === "segments" ? el("br") : document.createTextNode(" "));
        parts.push(segmentNode(segments, i));
      });
      nodes.push(el("p", { class: "tr-turn" }, parts));
    }
  }
  nodes.push(el("p", { class: "tr-footer muted", text: tr("transcriptFooter") }));
  return nodes;
}

function segmentNode(segments, i) {
  const { el } = host;
  const s = segments[i];
  if (editing) {
    const node = el("span", { class: "tr-seg", "data-i": i, contenteditable: "plaintext-only", spellcheck: "true", text: s.text.trim() });
    node.addEventListener("input", () => {
      const text = node.textContent.trim();
      if (text !== doc.results[i].text.trim()) working.edits[i] = text;
      else delete working.edits[i];
    });
    // Right-click, or a long press on a phone: whose sentence this is.
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      assignSheet([i]);
    });
    let press;
    node.addEventListener("touchstart", () => (press = setTimeout(() => assignSheet([i]), 600)), { passive: true });
    node.addEventListener("touchend", () => clearTimeout(press));
    node.addEventListener("touchmove", () => clearTimeout(press), { passive: true });
    return node;
  }
  const node = el("span", { class: "tr-seg", "data-i": i, "data-start": s.start, "data-end": s.end });
  if (mode === "compared" && Object.prototype.hasOwnProperty.call(doc.saved.edits, i)) {
    node.classList.add("changed");
    drawDiff(node, doc.results[i].text.trim(), doc.saved.edits[i]);
  } else {
    node.textContent = s.text.trim();
  }
  node.addEventListener("click", () => {
    const audio = document.getElementById("tr-audio");
    if (!audio) return;
    audio.currentTime = s.start;
    audio.play().catch(() => {});
  });
  return node;
}

let diffLib = null;
async function drawDiff(node, before, after) {
  node.textContent = after;
  diffLib ??= loadScript("https://cdn.jsdelivr.net/npm/diff@5.1.0/dist/diff.min.js").then(() => window.Diff);
  const Diff = await diffLib.catch(() => null);
  if (!Diff) return;
  node.replaceChildren(...Diff.diffWords(before, after).map((part) =>
    part.added ? host.el("ins", { text: part.value }) : part.removed ? host.el("del", { text: part.value }) : document.createTextNode(part.value)));
}

// The sentence being heard, marked and kept in view.
function follow() {
  const audio = document.getElementById("tr-audio");
  const text = document.getElementById("tr-text");
  if (!audio || !text || editing) return;
  const t = audio.currentTime;
  const index = doc.results.findIndex((s) => s.start <= t && t <= s.end);
  const current = text.querySelector(".tr-seg.playing");
  const next = index >= 0 ? text.querySelector(`.tr-seg[data-i="${index}"]`) : null;
  if (current === next) return;
  current?.classList.remove("playing");
  if (!next) return;
  next.classList.add("playing");
  const box = next.getBoundingClientRect();
  if (box.top < 120 || box.bottom > innerHeight - 90) next.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ------------------------------------------------------------------ actions

function footer() {
  return tr("transcriptFooter");
}

function baseName() {
  return (doc.entry.source_filename || "transcript").replace(/\.[^/.]+$/, "");
}

function current() {
  return effective(doc.results, doc.saved);
}

async function copyText() {
  try {
    await navigator.clipboard.writeText(plainText(current(), display(), doc.language, doc.saved.speakerNames, footer()));
    host.toast(tr("copySuccess"));
  } catch {
    host.toast(tr("copyError"));
  }
}

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = host.el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  host.toast(tr("filesDownloadSuccess"));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

let docxLib = null;
async function exportAs(format) {
  const segments = current();
  const settings = display();
  host.sheet.close();
  if (format === "docx") {
    docxLib ??= loadScript("https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js").then(() => window.htmlDocx);
    const lib = await docxLib.catch(() => null);
    if (!lib) return host.toast(tr("docxLibMissing"));
    return save(lib.asBlob(docxHtml(segments, settings, doc.language, doc.saved.speakerNames, footer())), `${baseName()}.docx`);
  }
  if (format === "srt") return save(new Blob([srt(segments)], { type: "text/plain" }), `${baseName()}.srt`);
  if (format === "vtt") return save(new Blob([vtt(segments)], { type: "text/vtt" }), `${baseName()}.vtt`);
  if (format === "json") return save(new Blob([json(segments)], { type: "application/json" }), `${baseName()}.json`);
  if (format === "txt") return save(new Blob([plainText(segments, settings, doc.language, doc.saved.speakerNames, footer())], { type: "text/plain" }), `${baseName()}.txt`);
}

function exportSheet() {
  const { el, icon } = host;
  const row = (format, title, sub) => el("button", { class: "list-row tr-choice", type: "button", onclick: () => exportAs(format) }, [
    el("div", { class: "grow" }, [el("div", { text: title }), el("div", { class: "sub", text: sub })]),
    icon("download"),
  ]);
  host.sheet.open(tr("export"), el("div", { class: "list" }, [
    row("docx", "Word", ".docx"),
    row("txt", tr("textFile"), ".txt"),
    row("srt", "SRT", tr("subtitles")),
    row("vtt", "WebVTT", tr("subtitles")),
    row("json", "JSON", tr("jsonWithTimes")),
  ]));
}

function displaySheet() {
  const { el } = host;
  const settings = display();
  const seg = (label, key, options) => el("div", { class: "tr-field" }, [
    el("span", { class: "muted", text: label }),
    el("div", { class: "seg wide", role: "group" }, options.map(([value, text]) => el("button", {
      type: "button", "aria-pressed": String(settings[key] === value), text, onclick: () => {
        setDisplay({ [key]: value });
        displaySheet();
      },
    }))),
  ]);
  host.sheet.open(tr("display"), el("div", { class: "stack" }, [
    seg(tr("layoutWords"), "textFormat", [["continuous", tr("layoutContinuous")], ["segments", tr("layoutSegments")]]),
    seg(tr("showSpeakers"), "diarizationDisplay", [["enabled", tr("diarizationEnabled")], ["disabled", tr("diarizationDisabled")]]),
    seg(tr("showTimestamps"), "timestampFormat", [["none", tr("timestampsNone")], ["segments", tr("timestampsSegments")]]),
  ]));
}

function statsSheet() {
  const { el } = host;
  const s = statistics(current());
  if (!s) return;
  const figure = (label, value) => el("div", { class: "tr-figure" }, [el("b", { text: value }), el("span", { class: "muted", text: label })]);
  const names = doc.saved.speakerNames;
  const bars = s.speakers.map(({ id, seconds, share }) => {
    const tone = id === "UNKNOWN" ? "" : `speaker-${((Math.max(1, speakerNumber(id)) - 1) % 10) + 1}`;
    return el("div", { class: "tr-share" }, [
      el("div", { class: "row spread" }, [
        el("span", { class: `tr-who ${tone}`, text: speakerLabel(id === "UNKNOWN" ? null : id, doc.language, names) }),
        el("span", { class: "muted", dir: "ltr", text: `${clock(seconds)} · ${(share * 100).toFixed(1)}%` }),
      ]),
      el("div", { class: "tr-progress" }, [el("span", { class: tone, style: `width:${Math.max(1, share * 100)}%` })]),
    ]);
  });
  host.sheet.open(tr("statistics"), el("div", { class: "stack" }, [
    el("div", { class: "tr-figures" }, [
      figure(tr("totalTime"), clock(s.total)),
      figure(tr("totalWords"), String(s.words)),
      figure(tr("totalLetters"), String(s.letters)),
      figure(tr("wordsPerMinute"), String(s.wpm)),
      figure(tr("lettersPerMinute"), String(s.lpm)),
      s.gap != null ? figure(tr("avgGap"), tr("seconds", { value: s.gap.toFixed(2) })) : null,
    ]),
    s.speakers.length > 1 || s.speakers[0]?.id !== "UNKNOWN" ? el("h3", { text: tr("speakerTime") }) : null,
    ...bars,
  ]));
}

function donateSheet() {
  const { el } = host;
  const agree = el("input", { type: "checkbox" });
  const send = el("button", { class: "btn primary", type: "button", disabled: true, text: tr("donateDataSubmit") });
  agree.addEventListener("change", () => (send.disabled = !agree.checked));
  send.addEventListener("click", async () => {
    send.disabled = true;
    try {
      await api.donate(doc.id);
      doc.entry.donated = true;
      host.sheet.close();
      host.toast(tr("donateDataSuccess"));
      render();
    } catch (err) {
      host.toast(serverError(err.data, "donateDataError"));
      send.disabled = false;
    }
  });
  host.sheet.open(tr("donateDataTitle"), el("div", { class: "stack" }, [
    el("p", { text: tr("donateDataMessage") }),
    el("a", { href: "https://huggingface.co/datasets/ivrit-ai/v2-text/blob/main/LICENSE", target: "_blank", rel: "noopener", text: tr("donateDataLicenseLink") }),
    el("label", { class: "tr-check" }, [agree, el("span", { text: tr("donateDataCheckbox") })]),
    el("div", { class: "row end" }, [send]),
  ]));
}

async function deleteIt() {
  if (!(await host.ask(tr("deleteConfirm", { filename: doc.entry.source_filename || "" }), { ok: tr("delete"), danger: true }))) return;
  try {
    await api.remove(doc.id);
    localStorage.removeItem(`editDraft:${doc.id}`);
    doc = null;
    hooks.back();
  } catch (err) {
    host.toast(serverError(err.data, "deleteError"));
  }
}

// ------------------------------------------------------------------ editing

function startEditing(from) {
  working = normalizeEdits(from);
  editing = true;
  mode = "new";
  document.getElementById("tr-audio")?.pause();
  render();
}

async function stopEditing() {
  if (dirty() && !(await host.ask(tr("discardEditsConfirm"), { ok: tr("discardEdits"), danger: true }))) return;
  editing = false;
  working = null;
  localStorage.removeItem(`editDraft:${doc.id}`);
  render();
}

async function saveEditing(button) {
  button.disabled = true;
  try {
    await api.saveEdits(doc.id, working);
    doc.saved = normalizeEdits(working);
    editing = false;
    working = null;
    localStorage.removeItem(`editDraft:${doc.id}`);
    host.toast(tr("editsSaved"));
    render();
  } catch (err) {
    button.disabled = false;
    host.toast(serverError(err.data, "editsSaveError"));
  }
}

function editBar() {
  const { el } = host;
  const save = el("button", { class: "btn primary small", type: "button", text: tr("save"), onclick: () => saveEditing(save) });
  return el("div", { class: "banner tr-editbar" }, [
    el("div", {}, [el("strong", { text: tr("editing") }), el("span", { text: tr("editHint") })]),
    el("div", { class: "row" }, [el("button", { class: "btn quiet small", type: "button", text: tr("cancel"), onclick: () => stopEditing() }), save]),
  ]);
}

// The speakers to choose from: those in the transcript, and one more.
function speakerChoices() {
  const ids = speakersIn(effective(doc.results, working));
  const next = speakerId(Math.max(0, ...ids.map(speakerNumber)) + 1);
  return [...ids, next];
}

function speakerSheet(turn) {
  const { el } = host;
  const id = turn.speaker;
  const nodes = [];
  if (id) {
    const input = el("input", { class: "tr-input", value: working.speakerNames[id] || "", placeholder: speakerLabel(id, doc.language, {}), dir: "auto" });
    const apply = el("button", { class: "btn primary small", type: "submit", text: tr("save") });
    const form = el("form", { class: "stack" }, [
      el("label", { class: "tr-field" }, [el("span", { class: "muted", text: tr("renameSpeaker") }), input]),
      el("div", { class: "row end" }, [apply]),
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      const taken = name && Object.entries(working.speakerNames).some(([other, n]) => other !== id && n === name);
      if (taken) return host.toast(tr("nameTaken"));
      if (name) working.speakerNames[id] = name;
      else delete working.speakerNames[id];
      host.sheet.close();
      render();
    });
    nodes.push(form);
  }
  nodes.push(choices(tr("assignBlock"), (to) => assign(turn.indices, to)));
  host.sheet.open(speakerLabel(id, doc.language, working.speakerNames), el("div", { class: "stack" }, nodes));
}

function assignSheet(indices) {
  host.sheet.open(tr("assignSpeaker"), choices(tr("assignSpeaker"), (to) => assign(indices, to)));
}

function choices(title, pick) {
  const { el } = host;
  return el("div", { class: "tr-field" }, [
    el("span", { class: "muted", text: title }),
    el("div", { class: "row" }, speakerChoices().map((option) => el("button", {
      class: `btn small tr-who speaker-${((Math.max(1, speakerNumber(option)) - 1) % 10) + 1}`,
      type: "button",
      text: speakerLabel(option, doc.language, working.speakerNames),
      onclick: () => {
        pick(option);
        host.sheet.close();
        render();
      },
    }))),
  ]);
}

// These sentences are now this speaker's; back to their own speaker, no swap is kept.
function assign(indices, to) {
  for (const i of indices) {
    const original = speakerOf(doc.results[i]);
    if (!original) continue;
    if (to === original) delete working.speakerSwaps[i];
    else working.speakerSwaps[i] = to;
  }
}
