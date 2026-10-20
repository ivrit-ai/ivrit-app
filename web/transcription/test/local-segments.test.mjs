// The on-device model's tokens as words and sentences (local/segments.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { toSegments, toWords } from "../local/segments.js";

test("pieces join into words; a word starts at its first piece", () => {
  const words = toWords([["▁ב", 1.44], ["פר", 1.6], ["ק", 1.76], ["▁של", 1.92], ["▁שלום", 2.4], [".", 2.6]]);
  assert.deepEqual(words.map((w) => w.word), ["בפרק", "של", "שלום."]);
  assert.equal(words[0].start, 1.44);
  assert.equal(words[1].start, 1.92);
});

test("a word ends where the next starts, but not past a pause", () => {
  const words = toWords([["▁אחת", 1.0], ["▁שתיים", 1.3], ["▁שלוש", 5.0]]);
  assert.equal(words[0].end, 1.3);
  assert.equal(words[1].end, 1.7); // its last piece + 0.4, not 5.0
  assert.equal(words[2].end, 5.4);
});

test("punctuation with its own word mark still joins the word before it", () => {
  const words = toWords([["▁כן", 1.0], ["▁,", 1.1], ["▁לא", 1.4]]);
  assert.deepEqual(words.map((w) => w.word), ["כן,", "לא"]);
});

test("sentences end at the model's punctuation and at pauses", () => {
  const segments = toSegments([
    ["▁שלום", 0.5], [".", 0.7], ["▁מה", 1.0], ["▁שלומך", 1.3], ["?", 1.5],
    ["▁טוב", 4.0], ["▁תודה", 4.3], ["▁ואתה", 7.0],
  ]);
  assert.deepEqual(segments.map((s) => s.text), ["שלום.", "מה שלומך?", "טוב תודה", "ואתה"]);
  assert.equal(segments[1].start, 1.0);
  assert.equal(segments[2].end, 4.7);
  assert.deepEqual(segments[0].speakers, []);
  assert.equal(segments[1].words.length, 2);
});

test("a long run without punctuation is cut at most every 20 seconds", () => {
  const tokens = [];
  for (let t = 0; t < 60; t += 0.5) tokens.push(["▁מילה", t]);
  const segments = toSegments(tokens);
  assert.ok(segments.length >= 3);
  for (const s of segments) assert.ok(s.end - s.start <= 20.5, `${s.start}-${s.end}`);
});

test("nothing heard is no sentences", () => {
  assert.deepEqual(toSegments([]), []);
});
