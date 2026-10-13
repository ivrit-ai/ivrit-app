import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize, queryTerms } from "../normalize.js";

const norm = (s) => normalize(s).norm;

test("Hebrew points and cantillation are dropped", () => {
  assert.equal(norm("שָׁלוֹם"), "שלומ");
  assert.equal(norm("בְּרֵאשִׁ֖ית"), "בראשית");
});

test("final letters fold to their regular forms", () => {
  assert.equal(norm("ךםןףץ"), "כמנפצ");
  assert.equal(norm("ספרים"), norm("ספרימ"));
});

test("geresh and gershayim, however typed, are dropped inside words", () => {
  for (const s of ['צה"ל', "צה״ל", "צה”ל", "צהל"]) assert.equal(norm(s), "צהל", s);
  for (const s of ["ג'ירפה", "ג׳ירפה", "ג’ירפה"]) assert.equal(norm(s), "גירפה", s);
  // After points, too.
  assert.equal(norm("צָה״ל"), "צהל");
  // Outside a word a quote is punctuation.
  assert.equal(norm('"שלום" לך'), "שלומ לכ");
});

test("maqaf and other punctuation become single spaces", () => {
  assert.equal(norm("בית־ספר"), "בית ספר");
  assert.equal(norm("  א,  ב... ג!  "), "א ב ג");
  assert.equal(norm("ירושלים׃"), "ירושלימ");
});

test("other scripts lose case and accents", () => {
  assert.equal(norm("Café CRÈME"), "cafe creme");
  assert.equal(norm("Ünïcödé 42"), "unicode 42");
});

test("the map points back at each character's place in the original", () => {
  const text = "שָׁלוֹם, Café";
  const { norm: n, map } = normalize(text);
  assert.equal(n.length, map.length);
  for (let i = 0; i < n.length; i++) {
    if (n[i] !== " ") assert.equal(norm(text[map[i]]), n[i]);
  }
  assert.equal(text[map[n.indexOf("c")]], "C");
});

test("queries: words, quoted phrases, and gershayim that is not a quote", () => {
  assert.deepEqual(queryTerms("בית ספר"), [
    { words: ["בית"], phrase: false },
    { words: ["ספר"], phrase: false },
  ]);
  assert.deepEqual(queryTerms('דנה "בית ספר" מחר'), [
    { words: ["דנה"], phrase: false },
    { words: ["בית", "ספר"], phrase: true },
    { words: ["מחר"], phrase: false },
  ]);
  assert.deepEqual(queryTerms('צה"ל'), [{ words: ["צהל"], phrase: false }]);
  assert.deepEqual(queryTerms("“בית ספר”"), [{ words: ["בית", "ספר"], phrase: true }]);
  // A one-word "phrase" is just the word; an unclosed quote runs to the end.
  assert.deepEqual(queryTerms('"שלום"'), [{ words: ["שלומ"], phrase: false }]);
  assert.deepEqual(queryTerms('"בית ספר'), [{ words: ["בית", "ספר"], phrase: true }]);
  assert.deepEqual(queryTerms("  "), []);
});
