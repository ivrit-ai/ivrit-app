import assert from "node:assert/strict";
import { test } from "node:test";
import { createSearch } from "../engine.js";

const NOW = Date.UTC(2026, 9, 14);
const DAY = 86_400_000;

const transcript = (id, segments, extra = {}) => ({
  id,
  collection: "transcript",
  folder: "top",
  folderPath: [],
  origin: "upload",
  title: id,
  created: NOW - DAY,
  language: "he",
  segments,
  ...extra,
});

const ids = (out) => out.results.map((r) => r.doc.id);
const marked = (hit) => hit.snippet.filter((p) => p.mark).map((p) => p.text);
const plain = (hit) => hit.snippet.map((p) => p.text).join("");

function engine() {
  const s = createSearch({ sourceName: (id) => ({ eliezer: "אליעזר" })[id] ?? id });
  s.setFolders({ calls: "top", y2026: "calls", top: null });
  return s;
}

test("a word is found after one or two prefix letters, not inside another word", () => {
  const s = engine();
  s.setShard("top", [
    transcript("a", [[0, null, "הלכנו ובבית היה חם"]]),
    transcript("b", [[0, null, "שבית המשפט"]]),
    transcript("c", [[0, null, "תבית אינה מילה"]]),
    transcript("d", [[0, null, "בבית"]]),
  ]);
  assert.deepEqual(ids(s.search("בית", {}, { now: NOW })).sort(), ["a", "b", "d"]);
});

test("a word runs on to the end of the word it starts", () => {
  const s = engine();
  s.setShard("top", [transcript("a", [[0, null, "קראנו ספרים רבים"]]), transcript("b", [[0, null, "מספרה"]])]);
  // "ספר" starts "ספרים"; in "מספרה" it follows מ, a prefix letter, so it is found there too.
  assert.deepEqual(ids(s.search("ספר", {}, { now: NOW })).sort(), ["a", "b"]);
  const [hit] = s.search("ספר", {}, { now: NOW }).results.find((r) => r.doc.id === "a").hits;
  assert.deepEqual(marked(hit), ["ספרים"]);
});

test("final letters and points do not stand between a query and the text", () => {
  const s = engine();
  s.setShard("top", [transcript("a", [[0, null, "שָׁלוֹם לכולם"]])]);
  assert.deepEqual(ids(s.search("שלום", {}, { now: NOW })), ["a"]);
  assert.deepEqual(ids(s.search("שלומ", {}, { now: NOW })), ["a"]);
});

test("every word must be found; a quoted phrase must be found as written", () => {
  const s = engine();
  s.setShard("top", [
    transcript("together", [[0, null, "הוא הלך לבית ספר חדש"]]),
    transcript("apart", [[0, null, "ספר על בית"]]),
    transcript("one", [[0, null, "רק בית"]]),
  ]);
  assert.deepEqual(ids(s.search("בית ספר", {}, { now: NOW })).sort(), ["apart", "together"]);
  assert.deepEqual(ids(s.search('"בית ספר"', {}, { now: NOW })), ["together"]);
});

test("ranking: phrase, then all words in a segment, then a passage, then the title alone", () => {
  const s = engine();
  s.setShard("top", [
    transcript("title-only", [[0, null, "שום דבר"]], { title: "בית ספר" }),
    transcript("passage", [[0, null, "בית"], [1, null, "משהו"], [2, null, "ספר"]]),
    transcript("segment", [[0, null, "ספר בתוך בית"]]),
    transcript("phrase", [[0, null, "בית ספר"]]),
    transcript("far", [[0, null, "בית"], [1, null, "א"], [2, null, "ב"], [3, null, "ג"], [4, null, "ד"], [5, null, "ספר"]]),
  ]);
  const out = s.search("בית ספר", {}, { now: NOW });
  assert.deepEqual(ids(out), ["phrase", "segment", "passage", "title-only"]);
  assert.deepEqual(out.results[2].hits.map((h) => h.segment), [0, 2]);
});

test("more matching segments rank higher; then newer", () => {
  const s = engine();
  s.setShard("top", [
    transcript("once-new", [[0, null, "מכונית"]], { created: NOW - DAY }),
    transcript("twice", [[0, null, "מכונית"], [1, null, "עוד מכונית"]], { created: NOW - 9 * DAY }),
    transcript("once-old", [[0, null, "מכונית"]], { created: NOW - 5 * DAY }),
  ]);
  assert.deepEqual(ids(s.search("מכונית", {}, { now: NOW })), ["twice", "once-new", "once-old"]);
});

test("a speaker's name finds what they said; titles and sources count too", () => {
  const s = engine();
  s.setShard("top", [transcript("a", [[0, "דנה", "אני מסכימה"], [3, "יוסי", "ואני לא"]])]);
  s.setMessages([{ id: "m1", created_at: NOW, source_id: "eliezer", source: "Eliezer", title: "תמלול", body: "שלום מאליעזר", lang: "he" }]);
  const dana = s.search("דנה מסכימה", {}, { now: NOW });
  assert.deepEqual(ids(dana), ["a"]);
  assert.equal(dana.results[0].hits[0].speaker, "דנה");
  assert.deepEqual(dana.results[0].hits.map((h) => h.segment), [0]);
  assert.deepEqual(ids(s.search("אליעזר", {}, { now: NOW })), ["m1"]);
});

test("up to three hits per document, and how many more", () => {
  const s = engine();
  s.setShard("top", [transcript("a", Array.from({ length: 7 }, (_, i) => [i, null, `שורה ${i} עם חתול`]))]);
  const [r] = s.search("חתול", {}, { now: NOW }).results;
  assert.equal(r.hits.length, 3);
  assert.equal(r.more, 4);
});

test("snippets: the marks fall on the original text, points and all", () => {
  const s = engine();
  const text = "בַּבֹּקֶר הָלַכְנוּ לְבֵית הַסֵּפֶר, ואחר כך הביתה";
  s.setShard("top", [transcript("a", [[12.5, "דנה", text]])]);
  const [hit] = s.search("בית", {}, { now: NOW }).results[0].hits;
  assert.equal(plain(hit), text);
  assert.deepEqual(marked(hit), ["בֵית", "ביתה"]);
  assert.equal(hit.start, 12.5);
});

test("long segments are cut around the first match, at whole words", () => {
  const s = engine();
  const words = Array.from({ length: 80 }, (_, i) => `מילה${i}`);
  words[50] = "יהלום";
  s.setShard("top", [transcript("a", [[0, null, words.join(" ")]])]);
  const [hit] = s.search("יהלום", {}, { now: NOW }).results[0].hits;
  const text = plain(hit);
  assert.ok(text.startsWith("…") && text.endsWith("…"));
  assert.ok(text.length <= 125, text.length);
  assert.deepEqual(marked(hit), ["יהלום"]);
  for (const piece of text.slice(1, -1).split(" ")) assert.ok(piece === "יהלום" || /^מילה\d+$/.test(piece), piece);
});

test("a clip and its message are one result: the message, marked as saved too", () => {
  const s = engine();
  s.setShard("clips", [
    { id: "app-1", collection: "clip", origin: "whatsapp", title: "הקלטה", created: NOW, language: "he", segments: [[0, null, "פגישה מחר בעשר"]] },
    { id: "app-2", collection: "clip", origin: "eliezer", title: "קול", created: NOW, language: "he", segments: [[0, null, "פגישה ביום שני"]] },
  ]);
  s.setMessages([{ id: "app-1", created_at: NOW, source_id: "ivrit-app:whatsapp", title: "הקלטה", body: "פגישה מחר בעשר", lang: "he" }]);
  const out = s.search("פגישה", {}, { now: NOW });
  const byId = Object.fromEntries(out.results.map((r) => [r.doc.id, r.doc]));
  assert.equal(out.results.length, 2);
  assert.equal(byId["app-1"].collection, "message");
  assert.equal(byId["app-1"].alsoClip, true);
  assert.equal(byId["app-2"].collection, "clip");
  // Without the message (a new phone), the clip itself.
  s.setMessages([]);
  assert.equal(s.search("פגישה", {}, { now: NOW }).results.find((r) => r.doc.id === "app-1").doc.collection, "clip");
});

test("filters combine, and a folder takes in its subfolders", () => {
  const s = engine();
  s.setShard("top", [transcript("top-doc", [[0, null, "דוח"]])]);
  s.setShard("calls", [transcript("call", [[0, null, "דוח שיחה"]], { folder: "calls", origin: "watch" })]);
  s.setShard("y2026", [transcript("call-2026", [[0, null, "דוח"]], { folder: "y2026", origin: "watch", language: "en", created: NOW - 40 * DAY })]);
  s.setShard("clips", [{ id: "c", collection: "clip", origin: "eliezer", title: "", created: NOW, language: "he", segments: [[0, null, "דוח קצר"]] }]);
  s.setMessages([{ id: "m", created_at: NOW - 2 * DAY, source_id: "eliezer", title: "", body: "דוח מהבוט", lang: "he" }]);

  const q = (filters) => ids(s.search("דוח", filters, { now: NOW })).sort();
  assert.deepEqual(q({}), ["c", "call", "call-2026", "m", "top-doc"]);
  assert.deepEqual(q({ folder: "calls" }), ["call", "call-2026"]);
  assert.deepEqual(q({ folder: "top" }), ["call", "call-2026", "top-doc"]);
  assert.deepEqual(q({ where: ["clip", "message"] }), ["c", "m"]);
  assert.deepEqual(q({ source: ["eliezer"] }), ["c", "m"]);
  assert.deepEqual(q({ source: ["watch"], language: ["he"] }), ["call"]);
  assert.deepEqual(q({ since: NOW - 30 * DAY }), ["c", "call", "m", "top-doc"]);
});

test("facet counts follow the query, each with the other filters applied", () => {
  const s = engine();
  s.setShard("top", [transcript("top-doc", [[0, null, "דוח"]])]);
  s.setShard("calls", [transcript("call", [[0, null, "דוח"]], { folder: "calls", origin: "watch" })]);
  s.setShard("y2026", [transcript("call-2026", [[0, null, "דוח"]], { folder: "y2026", origin: "watch", created: NOW - 40 * DAY })]);
  s.setShard("clips", [{ id: "c", collection: "clip", origin: "eliezer", title: "", created: NOW, language: "he", segments: [[0, null, "דוח"]] }]);
  s.setMessages([{ id: "m", created_at: NOW - 2 * DAY, source_id: "eliezer", title: "", body: "דוח", lang: "he" }]);

  const { facets } = s.search("דוח", { where: ["transcript"] }, { now: NOW });
  // Where ignores its own filter: every collection still counted.
  assert.deepEqual(facets.where, { transcript: 3, clip: 1, message: 1 });
  // The others count only transcripts; a folder counts its subfolders' too.
  assert.deepEqual(facets.folder, { top: 3, calls: 2, y2026: 1 });
  assert.deepEqual(facets.source, { upload: 1, watch: 2 });
  assert.deepEqual(facets.date, { week: 2, month: 2, year: 3 });

  const narrowed = s.search("דוח", { folder: "calls", where: ["transcript"] }, { now: NOW }).facets;
  assert.deepEqual(narrowed.source, { watch: 2 });
  // The folder facet ignores the folder filter, so other folders stay visible.
  assert.deepEqual(narrowed.folder, { top: 3, calls: 2, y2026: 1 });
});

test("an empty query lists everything, newest first", () => {
  const s = engine();
  s.setShard("top", [transcript("old", [[0, null, "א"]], { created: NOW - 9 * DAY }), transcript("new", [[0, null, "ב"]], { created: NOW - DAY })]);
  s.setMessages([{ id: "m", created_at: NOW, title: "x", body: "y" }]);
  assert.deepEqual(ids(s.search("", {}, { now: NOW })), ["m", "new", "old"]);
});

test("shards and messages are replaced and removed", () => {
  const s = engine();
  s.setShard("top", [transcript("a", [[0, null, "תפוח"]])]);
  s.setShard("top", [transcript("b", [[0, null, "תפוח"]])]);
  assert.deepEqual(ids(s.search("תפוח", {}, { now: NOW })), ["b"]);
  s.removeShard("top");
  assert.equal(s.size(), 0);
  s.addMessages([{ id: "m1", created_at: NOW, body: "תפוח" }]);
  s.addMessages([{ id: "m2", created_at: NOW, body: "תפוח" }]);
  s.removeMessages(["m1"]);
  assert.deepEqual(ids(s.search("תפוח", {}, { now: NOW })), ["m2"]);
});
