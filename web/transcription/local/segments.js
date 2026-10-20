// The on-device model's output, [piece, seconds] per token (asr.js), as the app's
// transcript: sentences {start, end, text, speakers: [], words: [{word, start, end}]}.
//
// A piece starting with "▁" starts a word; one that is only punctuation joins the
// word before it. A word starts at its first piece's time; the model gives no end
// times, so a word ends where the next one starts, but no later than shortly after
// its last piece (a pause is not part of a word). A sentence ends after a word with
// . ? ! or …, at a pause, or, past MAX_SENTENCE seconds, at the next comma or word.
// The model writes its own punctuation; nothing is added.

const PAUSE = 1.0; // seconds of silence that end a sentence
const MAX_SENTENCE = 20;
const LONG_SENTENCE = 12; // past this, a comma ends it too
const TAIL = 0.4; // a word's end at most this long after its last piece
const MIN_WORD = 0.04;
const PUNCTUATION = /^[.,?!:;…"'()\[\]\-–—]+$/;
const ENDS_SENTENCE = /[.?!…]["')\]]*$/;

export function toWords(tokens) {
  const words = [];
  let current = null;
  for (const [piece, at] of tokens) {
    const starts = piece.startsWith("▁");
    const text = piece.replace(/▁/g, "");
    if (!text) continue;
    if (current && (!starts || PUNCTUATION.test(text))) {
      current.word += text;
      current.last = at;
      continue;
    }
    current = { word: text, start: at, last: at };
    words.push(current);
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const latest = w.last + TAIL;
    w.end = round(Math.max(w.start + MIN_WORD, next ? Math.min(next.start, latest) : latest));
    w.start = round(w.start);
    delete w.last;
  }
  return words;
}

export function toSegments(tokens) {
  const words = toWords(tokens);
  const segments = [];
  let current = [];
  const close = () => {
    if (!current.length) return;
    segments.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.word).join(" "),
      speakers: [],
      words: current,
    });
    current = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    current.push(w);
    const next = words[i + 1];
    if (!next) break;
    const length = w.end - current[0].start;
    const pause = next.start - w.end;
    if (
      ENDS_SENTENCE.test(w.word) ||
      pause >= PAUSE ||
      length >= MAX_SENTENCE ||
      (length >= LONG_SENTENCE && /,$/.test(w.word))
    ) {
      close();
    }
  }
  close();
  return segments;
}

const round = (seconds) => Math.round(seconds * 1000) / 1000;
