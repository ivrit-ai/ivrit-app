// Search across everything the user has: transcripts in every My files folder
// and clips (from the index files kept in their Drive, a "shard" per folder and
// one for clips), and the inbox's messages (from the device's store). All of it
// is held in memory, normalised once (normalize.js), and a search scans it: a
// few milliseconds over hundreds of hours of transcripts. Nothing here touches
// the network or storage; the caller loads shards and messages and hands them in.
//
// Tests: node --test web/search/test/

import { normalize, queryTerms } from "./normalize.js";

// Letters Hebrew attaches to the front of a word: and, the, in, to, from, that, as.
const PREFIXES = new Set(["ו", "ה", "ב", "ל", "מ", "ש", "כ"]);

// How far apart (in segments) a query's words may be found and still count as
// one passage.
const NEARBY = 3;
const HITS_SHOWN = 3;
const SNIPPET = 120;
const DAY = 86_400_000;

// Ranks, best first.
const PHRASE = 4;
const SEGMENT = 3;
const PASSAGE = 2;
const TITLE = 1;

// Where `word` may start at position p of normalised text s: at the start of a
// word, or after one or two prefix letters there ("בית" in "ובבית", not "תבית").
function startsWordAt(s, p) {
  if (p === 0 || s[p - 1] === " ") return true;
  if (!PREFIXES.has(s[p - 1])) return false;
  if (p === 1 || s[p - 2] === " ") return true;
  return PREFIXES.has(s[p - 2]) && (p === 2 || s[p - 3] === " ");
}

/** Whether s contains needle where a word may start. */
function contains(s, needle) {
  if (!s) return false;
  for (let p = s.indexOf(needle); p !== -1; p = s.indexOf(needle, p + 1)) {
    if (startsWordAt(s, p)) return true;
  }
  return false;
}

/** Every place needle is found in s, as [start, end) running on to the end of its word. */
function occurrences(s, needle) {
  const found = [];
  for (let p = s.indexOf(needle); p !== -1; p = s.indexOf(needle, p + 1)) {
    if (!startsWordAt(s, p)) continue;
    let end = p + needle.length;
    while (end < s.length && s[end] !== " ") end++;
    found.push([p, end]);
  }
  return found;
}

const termText = (term) => term.words.join(" ");

/** The values of a sorted list between lo and hi, inclusive. */
function within(list, lo, hi) {
  let a = 0;
  let b = list.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (list[mid] < lo) a = mid + 1;
    else b = mid;
  }
  const out = [];
  for (let k = a; k < list.length && list[k] <= hi; k++) out.push(list[k]);
  return out;
}

/** A message's or a document's normalised text, with its map back. */
function prepared(text) {
  const { norm, map } = normalize(text);
  return { text: String(text ?? ""), norm, map };
}

export function createSearch({ sourceName = (sourceId, source) => source || sourceId || "" } = {}) {
  const shards = new Map(); // shard id → [doc key]
  const docs = new Map(); // key → doc
  const messages = new Map(); // message id → doc
  let parents = {}; // folder id → parent folder id
  let ancestry = new Map(); // folder id → Set of it and its ancestors

  function ancestorsOf(folder) {
    if (!folder) return new Set();
    let found = ancestry.get(folder);
    if (!found) {
      found = new Set();
      for (let f = folder; f && !found.has(f); f = parents[f]) found.add(f);
      ancestry.set(folder, found);
    }
    return found;
  }

  function documentOf(raw) {
    const collection = raw.collection === "clip" ? "clip" : "transcript";
    return {
      key: `${collection}:${raw.id}`,
      id: raw.id,
      collection,
      folder: raw.folder ?? null,
      folderPath: raw.folderPath ?? [],
      source: raw.origin ?? "",
      title: raw.title ?? "",
      created: Number(raw.created) || 0,
      language: raw.language ?? "",
      // The title (and for messages, the source's name) can satisfy a word too.
      meta: normalize(raw.title ?? "").norm,
      segments: (raw.segments ?? []).map(([start, speaker, text]) => ({
        start: Number(start) || 0,
        speaker: speaker ?? null,
        speakerNorm: speaker ? normalize(speaker).norm : "",
        ...prepared(text),
      })),
      raw,
    };
  }

  function messageOf(m) {
    const name = sourceName(m.source_id, m.source);
    return {
      key: `message:${m.id}`,
      id: m.id,
      collection: "message",
      folder: null,
      folderPath: [],
      source: m.source_id || m.source || "",
      sourceName: name,
      title: m.title ?? "",
      created: Number(m.created_at) || 0,
      language: m.lang ?? "",
      meta: normalize([m.title, m.subtitle, name].filter(Boolean).join(" ")).norm,
      segments: [{ start: 0, speaker: null, speakerNorm: "", ...prepared(m.body) }],
      raw: m,
    };
  }

  /** The documents a search sees: a clip whose message is on the device is that message. */
  function* everything() {
    for (const doc of docs.values()) {
      if (doc.collection === "clip" && messages.has(doc.id)) continue;
      yield doc;
    }
    for (const doc of messages.values()) {
      doc.alsoClip = docs.has(`clip:${doc.id}`);
      yield doc;
    }
  }

  /**
   * How a document answers the query, or null: its rank, how many segments
   * match, and which segments to show.
   */
  function judge(doc, terms) {
    // Words the title (or source name) already answers need not be in the text.
    const open = terms.filter((t) => !contains(doc.meta, termText(t)));
    if (!open.length) return { rank: TITLE, count: 0, segments: [] };

    const inSegment = (seg, t) => contains(seg.norm, termText(t)) || (!t.phrase && contains(seg.speakerNorm, termText(t)));
    const full = [];
    const phrase = [];
    // Where each open word was found, for passages that span segments.
    const where = open.map(() => []);
    doc.segments.forEach((seg, index) => {
      let all = true;
      open.forEach((t, k) => {
        if (inSegment(seg, t)) where[k].push(index);
        else all = false;
      });
      if (!all) return;
      full.push(index);
      // The whole query, in order and together, in this segment's text.
      const words = terms.flatMap((t) => t.words);
      if (words.length > 1 && contains(seg.norm, words.join(" "))) phrase.push(index);
    });

    if (full.length) {
      const quoted = terms.some((t) => t.phrase);
      const rank = phrase.length || (quoted && full.length) ? PHRASE : SEGMENT;
      const order = [...phrase, ...full.filter((i) => !phrase.includes(i))];
      return { rank, count: full.length, segments: order };
    }

    // A passage: every open word within NEARBY segments of one another (a window
    // of NEARBY + 1 segments holding each of them).
    if (where.some((list) => !list.length)) return null;
    for (const i of where[0]) {
      for (let w = i - NEARBY; w <= i; w++) {
        const near = where.map((list) => within(list, w, w + NEARBY));
        if (near.every((list) => list.length)) {
          const span = [...new Set(near.flat())].sort((a, b) => a - b);
          return { rank: PASSAGE, count: span.length, segments: span };
        }
      }
    }
    return null;
  }

  /** ~SNIPPET characters of a segment around its first match, the matches marked. */
  function snippet(seg, terms) {
    const ranges = [];
    for (const t of terms) ranges.push(...occurrences(seg.norm, termText(t)));
    const text = seg.text;
    if (!ranges.length || !seg.map.length) {
      const cut = text.length > SNIPPET ? text.slice(0, SNIPPET).replace(/\s+\S*$/, "") + "…" : text;
      return [{ text: cut, mark: false }];
    }
    ranges.sort((a, b) => a[0] - b[0]);
    // Back to the original text: from the first character of a match to the last.
    const marks = ranges.map(([a, b]) => [seg.map[a], endOf(text, seg.map[b - 1])]);

    let start = Math.max(0, marks[0][0] - Math.floor(SNIPPET / 3));
    let end = Math.min(text.length, start + SNIPPET);
    start = Math.max(0, Math.min(start, end - SNIPPET));
    // Whole words at both ends.
    if (start > 0) {
      const space = text.indexOf(" ", start);
      if (space !== -1 && space < marks[0][0]) start = space + 1;
    }
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > marks[0][1]) end = space;
    }

    const pieces = [];
    if (start > 0) pieces.push({ text: "…", mark: false });
    let at = start;
    for (const [a, b] of marks) {
      if (b <= at || a >= end) continue;
      const from = Math.max(a, at);
      if (from > at) pieces.push({ text: text.slice(at, from), mark: false });
      const to = Math.min(b, end);
      pieces.push({ text: text.slice(from, to), mark: true });
      at = to;
    }
    if (at < end) pieces.push({ text: text.slice(at, end), mark: false });
    if (end < text.length) pieces.push({ text: "…", mark: false });
    return pieces;
  }

  // Filters, each a test on a document; facets count with all the others applied.
  function tests(filters, now) {
    const where = filters.where?.length ? new Set(filters.where) : null;
    const sources = filters.source?.length ? new Set(filters.source) : null;
    const languages = filters.language?.length ? new Set(filters.language) : null;
    return {
      where: (d) => !where || where.has(d.collection),
      folder: (d) => !filters.folder || ancestorsOf(d.folder).has(filters.folder),
      source: (d) => !sources || sources.has(d.source),
      language: (d) => !languages || languages.has(d.language),
      since: (d) => !filters.since || d.created >= filters.since,
      now,
    };
  }

  function facets(matched, filters, now) {
    const t = tests(filters, now);
    const names = ["where", "folder", "source", "language", "since"];
    const passesExcept = (d, skip) => names.every((n) => n === skip || t[n](d));
    const out = { where: { transcript: 0, clip: 0, message: 0 }, folder: {}, source: {}, language: {}, date: { week: 0, month: 0, year: 0 } };
    for (const { doc } of matched) {
      if (passesExcept(doc, "where")) out.where[doc.collection]++;
      if (passesExcept(doc, "folder")) for (const f of ancestorsOf(doc.folder)) out.folder[f] = (out.folder[f] || 0) + 1;
      if (passesExcept(doc, "source") && doc.source) out.source[doc.source] = (out.source[doc.source] || 0) + 1;
      if (passesExcept(doc, "language") && doc.language) out.language[doc.language] = (out.language[doc.language] || 0) + 1;
      if (passesExcept(doc, "since")) {
        const age = now - doc.created;
        if (age <= 7 * DAY) out.date.week++;
        if (age <= 30 * DAY) out.date.month++;
        if (age <= 365 * DAY) out.date.year++;
      }
    }
    return out;
  }

  return {
    /** A shard's documents (a folder's or the clips' index), replacing what it had. */
    setShard(shardId, list) {
      for (const key of shards.get(shardId) ?? []) docs.delete(key);
      const keys = [];
      for (const raw of list ?? []) {
        const doc = documentOf(raw);
        docs.set(doc.key, doc);
        keys.push(doc.key);
      }
      shards.set(shardId, keys);
    },

    removeShard(shardId) {
      for (const key of shards.get(shardId) ?? []) docs.delete(key);
      shards.delete(shardId);
    },

    /** The inbox, all of it. */
    setMessages(list) {
      messages.clear();
      this.addMessages(list);
    },

    /** New or changed messages. */
    addMessages(list) {
      for (const m of list ?? []) if (m?.id) messages.set(m.id, messageOf(m));
    },

    removeMessages(ids) {
      for (const id of ids ?? []) messages.delete(id);
    },

    /** The folder tree, {folder id: parent id}, so a folder filter takes in its subfolders. */
    setFolders(map) {
      parents = { ...(map ?? {}) };
      ancestry = new Map();
    },

    size() {
      let n = 0;
      for (const _ of everything()) n++;
      return n;
    },

    /**
     * Results for a query (an empty query lists everything, newest first) and
     * filters {where, folder, source, language, since}.
     */
    search(query, filters = {}, { now = Date.now() } = {}) {
      const began = performance.now();
      const terms = queryTerms(query);
      const matched = [];
      for (const doc of everything()) {
        if (!terms.length) {
          matched.push({ doc, rank: 0, count: 0, segments: [] });
          continue;
        }
        const verdict = judge(doc, terms);
        if (verdict) matched.push({ doc, ...verdict });
      }

      const t = tests(filters, now);
      const results = matched
        .filter(({ doc }) => t.where(doc) && t.folder(doc) && t.source(doc) && t.language(doc) && t.since(doc))
        .sort((a, b) => b.rank - a.rank || b.count - a.count || b.doc.created - a.doc.created)
        .map(({ doc, rank, count, segments }) => ({
          doc: publicDoc(doc),
          score: rank * 1_000_000 + Math.min(count, 999_999),
          hits: segments.slice(0, HITS_SHOWN).map((index) => {
            const seg = doc.segments[index];
            return { segment: index, start: seg.start, speaker: seg.speaker, snippet: snippet(seg, terms) };
          }),
          more: Math.max(0, segments.length - HITS_SHOWN),
        }));

      return { results, facets: facets(matched, filters, now), ms: performance.now() - began };
    },
  };
}

/** What a result says about its document (not the search's working copies). */
function publicDoc(doc) {
  const out = {
    id: doc.id,
    collection: doc.collection,
    folder: doc.folder,
    folderPath: doc.folderPath,
    source: doc.source,
    title: doc.title,
    created: doc.created,
    language: doc.language,
  };
  if (doc.collection === "message") {
    out.sourceName = doc.sourceName;
    out.alsoClip = Boolean(doc.alsoClip);
  }
  return out;
}

/** Just past the character at i, and the points or accents written on it. */
function endOf(text, i) {
  let end = i + (text.codePointAt(i) > 0xffff ? 2 : 1);
  while (end < text.length && /\p{M}/u.test(text[end])) end++;
  return end;
}
