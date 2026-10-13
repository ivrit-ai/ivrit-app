"""readable_doc: effective() agrees with the app's (tests/fixtures/effective.json, which
web/transcription/test/effective.test.mjs checks too), and the document reads right.

    python tests/test_readable_doc.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import readable_doc  # noqa: E402

fixture = json.load(open(os.path.join(HERE, "fixtures", "effective.json"), encoding="utf-8"))
results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  [{detail}]"))


overlay = readable_doc.normalize_edits(fixture["edits"])
segments = readable_doc.effective(fixture["results"], overlay)
got = [{"text": s["text"], "speakers": s["speakers"]} for s in segments]
check("effective() matches the app's, on the shared fixture", got == fixture["expected"], got)
check("...and leaves the transcript itself alone", fixture["results"][1]["text"] == "טעות כתיב")

page = readable_doc.render_html("שיחה.ogg", segments, "he", overlay["speakerNames"], "2026-10-14 · 0:12")
check("the document is right to left for Hebrew", 'dir="rtl"' in page)
check("speakers by their given names, others by number", "דנה:" in page and "דובר 2:" in page, page)
check("one turn per run of a speaker", page.count("דנה:") == 1, page)
check("each turn with the time it starts", "[0:00]" in page and "[8:00]" not in page and "[0:08]" in page, page)
check("text is escaped", "&lt;" in readable_doc.render_html("t", [{"text": "<b>", "start": 0}], "en", {}))
check("no speakers when the transcript has none",
      "Speaker" not in readable_doc.render_html("t", [{"text": "hi", "start": 0}], "en", {}))
check("the Doc is named by the title, without the audio's extension",
      readable_doc.doc_name("שיחה.ogg") == "שיחה" and readable_doc.doc_name("v1.2 notes") == "v1.2 notes")

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
