// The one way text is compared in search: every document is normalised once,
// when it is loaded, and every query the same way, so both sides meet on the
// same letters. Hebrew points and cantillation are dropped, final letters fold to
// their regular forms, geresh and gershayim (in any of the ways people type them)
// are dropped from inside words, so צה"ל, צה״ל and צהל are one word; other
// scripts lose case and accents; anything that is not a letter or a digit is a
// space. The map from each normalised character back to the original text is
// what lets a match be highlighted where it really is.

const FINALS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };

// Geresh and gershayim, and the quotes and apostrophes typed for them.
const QUOTES = new Set(["׳", "״", "'", '"', "`", "’", "‘", "”", "“"]);

// Within the Hebrew points block, the marks that are punctuation rather than
// points: maqaf, paseq, sof pasuq, nun hafukha.
const HEBREW_PUNCTUATION = new Set([0x05be, 0x05c0, 0x05c3, 0x05c6]);

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const MARKS = /\p{M}/gu;

const isLetter = (ch) => ch !== undefined && LETTER_OR_DIGIT.test(ch);
const isMark = (ch) => ch !== undefined && /\p{M}/u.test(ch);

// The letters on either side of position i, looking past points (צָה״ל).
function between(s, i, width) {
  let before = i - 1;
  while (isMark(s[before])) before--;
  return isLetter(s[before]) && isLetter(s[i + width]);
}

/**
 * text → {norm, map}: map[i] is the index in text of norm[i]'s character.
 */
export function normalize(text) {
  const out = [];
  const map = [];
  const s = String(text ?? "");
  // A space only between two kept characters: none leading, none doubled.
  const space = (at) => {
    if (out.length && out[out.length - 1] !== " ") {
      out.push(" ");
      map.push(at);
    }
  };
  const keep = (ch, at) => {
    out.push(ch);
    map.push(at);
  };

  for (let i = 0; i < s.length; ) {
    const code = s.codePointAt(i);
    const ch = String.fromCodePoint(code);
    const width = ch.length;

    if (code < 0x80) {
      // ASCII, the common case outside Hebrew, without Unicode tables.
      if ((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a)) keep(ch, i);
      else if (code >= 0x41 && code <= 0x5a) keep(String.fromCharCode(code + 32), i);
      else if (!(QUOTES.has(ch) && between(s, i, 1))) space(i);
    } else if (code >= 0x0591 && code <= 0x05c7) {
      if (HEBREW_PUNCTUATION.has(code)) space(i);
      // Points and cantillation: dropped.
    } else if (code >= 0x05d0 && code <= 0x05ea) {
      keep(FINALS[ch] ?? ch, i);
    } else if (QUOTES.has(ch)) {
      // Inside a word it is geresh or gershayim, and dropped; elsewhere a quote.
      if (!between(s, i, width)) space(i);
    } else {
      const folded = ch.normalize("NFD").replace(MARKS, "").toLowerCase();
      if (!folded) {
        // A combining mark on its own: part of the letter before it.
      } else {
        for (const c of folded) {
          if (LETTER_OR_DIGIT.test(c)) keep(c, i);
          else space(i);
        }
      }
    }
    i += width;
  }
  if (out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }
  return { norm: out.join(""), map };
}

// Opening and closing quotes for phrases, in the ways they are typed.
const PHRASE_QUOTES = new Set(['"', "״", "“", "”"]);

/**
 * A query → its terms: each quoted run is one phrase, every other word a term of
 * its own. A quote between two letters is gershayim (צה"ל), not a phrase.
 */
export function queryTerms(query) {
  const q = String(query ?? "");
  const parts = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (PHRASE_QUOTES.has(ch) && !between(q, i, 1)) {
      parts.push({ text: current, phrase: quoted });
      current = "";
      quoted = !quoted;
    } else {
      current += ch;
    }
  }
  parts.push({ text: current, phrase: quoted });

  const terms = [];
  for (const part of parts) {
    const words = normalize(part.text).norm.split(" ").filter(Boolean);
    if (!words.length) continue;
    if (part.phrase && words.length > 1) terms.push({ words, phrase: true });
    else for (const word of words) terms.push({ words: [word], phrase: false });
  }
  return terms;
}
