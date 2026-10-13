// The search screen: one field over everything the user has (transcripts in every
// My files folder, clips, inbox messages), results as they type, grouped by
// document, each with the passages that matched (their time and speaker, the words
// marked); filters by where, folder, source, date and language, each with its
// count. Opening a result opens the transcript at that moment, the message, or the
// clip. The searching is engine.js's; the indexes come through library.js.

const DEBOUNCE_MS = 150;
const DAY = 86_400_000;
const SHOWN = 60;

let host = null;
let library = null;
let root = null;
let state = { query: "", where: [], folder: null, source: [], since: null, language: [] };
let timer = null;

export function init(hostApi, lib) {
  host = hostApi;
  library = lib;
}

// Opens the screen into `container`, with a query and filters to start from.
export function open(container, { query = "", where = [] } = {}) {
  root = container;
  state = { query, where, folder: null, source: [], since: null, language: [] };
  render();
  const input = root.querySelector("#search-q");
  input.focus();
  input.setSelectionRange(query.length, query.length);
  library.refresh();
}

// The indexes changed (a shard arrived, a message came in): search again.
export function changed() {
  if (root?.isConnected) results();
}

function render() {
  const { el, icon, t } = host;
  const input = el("input", {
    id: "search-q", type: "search", autocomplete: "off", value: state.query, placeholder: t("searchEverything"),
    "aria-label": t("searchEverything"),
    oninput: (e) => {
      state.query = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(results, DEBOUNCE_MS);
    },
  });
  root.replaceChildren(
    el("div", { class: "search-top" }, [
      el("button", { class: "icon-btn", type: "button", "aria-label": t("back"), onclick: () => host.back() }, [icon("back")]),
      el("label", { class: "search grow" }, [icon("search"), input]),
    ]),
    el("div", { id: "search-filters", class: "search-filters" }),
    el("p", { id: "search-status", class: "muted search-status", "aria-live": "polite" }),
    el("div", { id: "search-results", class: "feed search-results" })
  );
  results();
}

const toggle = (list, value) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

function filters() {
  const f = {};
  if (state.where.length) f.where = state.where;
  if (state.folder) f.folder = state.folder;
  if (state.source.length) f.source = state.source;
  if (state.language.length) f.language = state.language;
  if (state.since) f.since = Date.now() - state.since;
  return f;
}

// What a source key is called: a transcript's or clip's origin, or an inbox source.
function sourceLabel(key) {
  const named = { upload: "originUpload", record: "originUpload", watch: "originWatch", whatsapp: "originWhatsapp", app: "originApp" };
  if (named[key]) return host.t(named[key]);
  return host.sourceName(key) || key;
}

function chip(label, count, on, onclick) {
  return host.el("button", { class: `chip${on ? " active" : ""}`, type: "button", "aria-pressed": String(on), onclick }, [
    host.el("span", { text: label }),
    count != null ? host.el("b", { class: "count", text: String(count) }) : null,
  ]);
}

function drawFilters(facets) {
  const { el, t } = host;
  const box = document.getElementById("search-filters");
  if (!box) return;
  const where = [
    ["transcript", t("whereFiles")],
    ["clip", t("whereClips")],
    ["message", t("whereInbox")],
  ].filter(([key]) => facets.where[key] || state.where.includes(key));
  const rows = [
    el("div", { class: "chips" }, [
      chip(t("whereAll"), null, !state.where.length, () => update({ where: [], folder: null })),
      ...where.map(([key, label]) => chip(label, facets.where[key], state.where.includes(key), () => update({ where: toggle(state.where, key) }))),
    ]),
  ];
  // Folders, when there are any and My files is in view.
  const tree = library.tree();
  if (tree.folders.length && (!state.where.length || state.where.includes("transcript"))) {
    const choices = [{ id: "", name: t("allFolders"), depth: 0 }];
    const walk = (parent, depth) => tree.folders
      .filter((f) => f.parent === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((f) => {
        choices.push({ id: f.id, name: f.name, depth });
        walk(f.id, depth + 1);
      });
    walk(tree.top, 1);
    const select = el("select", { class: "tr-select search-folder", "aria-label": t("whereFolder"), onchange: (e) => update({ folder: e.target.value || null }) },
      choices.map((c) => el("option", { value: c.id, text: `${"  ".repeat(Math.max(0, c.depth - 1))}${c.name}${c.id && facets.folder[c.id] ? ` (${facets.folder[c.id]})` : ""}` })));
    select.value = state.folder || "";
    rows.push(el("div", { class: "row" }, [select]));
  }
  const sources = Object.entries(facets.source).sort((a, b) => b[1] - a[1]);
  if (sources.length > 1 || state.source.length) {
    rows.push(el("div", { class: "chips" }, sources.map(([key, n]) => chip(sourceLabel(key), n, state.source.includes(key), () => update({ source: toggle(state.source, key) })))));
  }
  const dates = [[7, "pastWeek", facets.date.week], [30, "pastMonth", facets.date.month], [365, "pastYear", facets.date.year]];
  rows.push(el("div", { class: "chips" }, [
    chip(t("anyTime"), null, !state.since, () => update({ since: null })),
    ...dates.map(([days, key, n]) => chip(t(key), n, state.since === days * DAY, () => update({ since: state.since === days * DAY ? null : days * DAY }))),
  ]));
  const languages = Object.entries(facets.language);
  if (languages.length > 1) {
    rows.push(el("div", { class: "chips" }, languages.map(([key, n]) =>
      chip(LANGUAGE_NAMES[key] || key, n, state.language.includes(key), () => update({ language: toggle(state.language, key) })))));
  }
  box.replaceChildren(...rows);
}

const LANGUAGE_NAMES = { he: "עברית", en: "English", fr: "Français", es: "Español", de: "Deutsch", zh: "中文", yi: "ייִדיש" };

function update(change) {
  Object.assign(state, change);
  results();
}

function results() {
  const list = document.getElementById("search-results");
  if (!list) return;
  const { el, t } = host;
  const { results, facets, ms } = library.engine.search(state.query, filters());
  drawFilters(facets);
  const pending = library.pending();
  const status = [
    state.query.trim() ? t("resultsCount", results.length) : "",
    library.loading() ? (pending ? t("indexingCount", pending) : t("indexing")) : "",
    !library.available() ? t("searchInboxOnly") : "",
  ].filter(Boolean).join(" · ");
  document.getElementById("search-status").textContent = status;
  if (!results.length) {
    list.replaceChildren(el("div", { class: "empty" }, [el("h3", { text: state.query.trim() ? t("noResults") : t("searchHint") })]));
    return;
  }
  list.replaceChildren(...results.slice(0, SHOWN).map(card));
  list.dataset.ms = String(Math.round(ms));
}

function where(doc) {
  if (doc.collection === "message") return doc.sourceName || host.sourceName(doc.source) || "";
  if (doc.collection === "clip") return host.t("whereClips");
  return [host.t("whereFiles"), ...(doc.folderPath || [])].join(" › ");
}

function date(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(host.locale() === "en" ? undefined : "he-IL", { day: "numeric", month: "short", year: "numeric" });
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function openResult(doc, hit) {
  if (doc.collection === "message") return host.openMessage(doc.id);
  if (doc.collection === "clip") return host.openClip(doc.id, doc.title);
  host.openTranscript(doc.id, doc.folder === library.tree().top ? null : doc.folder, hit ? hit.start : null);
}

function card({ doc, hits, more }, index) {
  const { el, icon, t } = host;
  const glyph = { transcript: "wave", clip: "mic", message: "inbox" }[doc.collection];
  return el("article", { class: "msg search-result openable", style: `--i:${Math.min(index, 12)}`, onclick: () => openResult(doc, hits[0]) }, [
    el("span", { class: "avatar tr-glyph", "aria-hidden": "true" }, [icon(glyph)]),
    el("div", { class: "msg-main" }, [
      el("div", { class: "msg-head" }, [el("span", { dir: "auto", text: where(doc) }), el("time", { text: date(doc.created) })]),
      el("h3", { class: "msg-title", dir: "auto", text: doc.title || t("untitled") }),
      ...hits.map((hit) => el("button", { class: "search-hit", type: "button", dir: "auto", onclick: (e) => {
        e.stopPropagation();
        openResult(doc, hit);
      } }, [
        doc.collection === "transcript" ? el("span", { class: "search-time", text: clock(hit.start) }) : null,
        hit.speaker ? el("b", { class: "search-who", text: `${hit.speaker}: ` }) : null,
        ...hit.snippet.map((piece) => (piece.mark ? el("mark", { text: piece.text }) : document.createTextNode(piece.text))),
      ])),
      more ? el("div", { class: "muted search-more", text: t("moreHits", more) }) : null,
    ]),
  ]);
}
