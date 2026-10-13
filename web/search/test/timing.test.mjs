import assert from "node:assert/strict";
import { test } from "node:test";
import { createSearch } from "../engine.js";

// About 300 hours of Hebrew: ~3M characters in ~30k segments, over 300
// transcripts in 10 folders, plus 2,000 inbox messages.
function corpus() {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const letters = "אבגדהוזחטיכלמנסעפצקרשת";
  const vocabulary = Array.from({ length: 4000 }, () => {
    const n = 2 + Math.floor(random() * 5);
    let w = "";
    for (let i = 0; i < n; i++) w += letters[Math.floor(random() * letters.length)];
    return w;
  });
  const sentence = (words) => Array.from({ length: words }, () => (random() < 0.2 ? "ו" : "") + vocabulary[Math.floor(random() * vocabulary.length)]).join(" ");
  const shards = {};
  for (let t = 0; t < 300; t++) {
    const folder = `f${t % 10}`;
    const segments = Array.from({ length: 100 }, (_, i) => [i * 36, i % 3 ? "דובר" : null, sentence(20)]);
    (shards[folder] ??= []).push({ id: `t${t}`, collection: "transcript", folder, origin: "upload", title: `שיחה ${t}`, created: t, language: "he", segments });
  }
  const messages = Array.from({ length: 2000 }, (_, i) => ({ id: `m${i}`, created_at: i, source_id: "eliezer", title: "תמלול", body: sentence(30) }));
  return { shards, messages, vocabulary };
}

test("a two-word search over ~300 hours takes well under 150 ms", () => {
  const { shards, messages, vocabulary } = corpus();
  const s = createSearch();
  const loading = performance.now();
  for (const [id, docs] of Object.entries(shards)) s.setShard(id, docs);
  s.setMessages(messages);
  const loaded = performance.now() - loading;

  let chars = 0;
  for (const docs of Object.values(shards)) for (const d of docs) for (const seg of d.segments) chars += seg[2].length;
  // One common word (in ~150 segments), and two that share segments: the
  // costly path, with results to rank and snippets to cut.
  const both = shards.f3[0].segments[5][2].split(" ").filter((w) => !w.startsWith("ו")).slice(0, 2).join(" ");
  const timings = {};
  for (const query of [vocabulary[17], both]) {
    s.search(query); // warm up
    let total = 0;
    let found = 0;
    for (let i = 0; i < 5; i++) {
      const out = s.search(query);
      total += out.ms;
      found = out.results.length;
    }
    timings[query] = { ms: total / 5, found };
  }
  console.log(`corpus: ${(chars / 1e6).toFixed(1)}M chars, 30000 segments + 2000 messages; loaded in ${loaded.toFixed(0)} ms; ` +
    Object.entries(timings).map(([q, t]) => `"${q}": ${t.found} results in ${t.ms.toFixed(1)} ms`).join("; "));
  for (const [q, t] of Object.entries(timings)) {
    assert.ok(t.found > 0, `"${q}" found nothing`);
    assert.ok(t.ms < 150, `"${q}" took ${t.ms.toFixed(1)} ms`);
  }
  assert.ok(chars > 2.5e6, `corpus too small: ${chars}`);
});
