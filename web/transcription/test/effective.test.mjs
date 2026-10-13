// effective() agrees with the server's readable copy (server/readable_doc.py) on the
// shared fixture, server/tests/fixtures/effective.json.
//
//   node --test web/transcription/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { effective, normalizeEdits } from "../transcript.js";

const fixture = JSON.parse(readFileSync(new URL("../../../server/tests/fixtures/effective.json", import.meta.url), "utf8"));

test("effective() matches the server's, on the shared fixture", () => {
  const segments = effective(fixture.results, normalizeEdits(fixture.edits));
  assert.deepEqual(segments.map((s) => ({ text: s.text, speakers: s.speakers })), fixture.expected);
});
