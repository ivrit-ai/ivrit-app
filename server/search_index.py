"""The search index of one folder: what the app searches on the device
(web/search/), kept in the user's own Drive beside the folder's toc.json.gz, as
search.json.gz (docs/folders-and-search.md, "Search across everything").

    {"version": 1, "updated": <ms>,
     "docs": {"<id>": {"title", "created" (ms), "duration", "language", "origin",
                       "stamp", "segments": [[start, speaker, text], ...]}}}

A transcript's text is as the user sees it: edits applied, speakers by the names
they were given (readable_doc.effective). A clip is one segment. `stamp` names the
edits it was made from (the edits file's version in Drive), so an entry made
stale by an edit elsewhere (the old site) is recognised and made again.
"""

import gzip
import json
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import readable_doc

INDEX_NAME = "search.json.gz"
VERSION = 1


def empty() -> Dict[str, Any]:
    return {"version": VERSION, "updated": 0, "docs": {}}


def load(raw: Optional[bytes]) -> Dict[str, Any]:
    if not raw:
        return empty()
    try:
        index = json.loads(gzip.decompress(raw))
    except (OSError, ValueError):
        return empty()
    if index.get("version") != VERSION or not isinstance(index.get("docs"), dict):
        return empty()
    return index


def dump(index: Dict[str, Any]) -> bytes:
    index["updated"] = int(time.time() * 1000)
    return gzip.compress(json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _ms(iso: Optional[str]) -> int:
    try:
        return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000)
    except (TypeError, ValueError):
        return 0


def transcript_doc(entry: dict, results: List[dict], edits: Optional[dict], stamp: str) -> Dict[str, Any]:
    """A transcript's index entry, from its toc entry, its segments and its edits."""
    overlay = readable_doc.normalize_edits(edits)
    language = entry.get("language") or "he"
    segments = []
    for segment in readable_doc.effective(results or [], overlay):
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        speaker = readable_doc.speaker_of(segment)
        label = readable_doc.speaker_label(speaker, language, overlay["speakerNames"]) if speaker else ""
        segments.append([round(float(segment.get("start") or 0), 2), label, text])
    return {
        "title": entry.get("source_filename") or "",
        "created": _ms(entry.get("completed_at")),
        "duration": entry.get("duration_seconds") or 0,
        "language": language,
        "origin": entry.get("origin") or "upload",
        "stamp": stamp,
        "segments": segments,
    }


def clip_doc(clip: dict) -> Dict[str, Any]:
    """A clip's index entry (clips are one text: a voice message, a shared recording)."""
    text = (clip.get("text") or "").strip()
    return {
        "title": clip.get("title") or "",
        "created": _ms(clip.get("created_at")),
        "duration": clip.get("duration_seconds") or 0,
        "language": clip.get("language") or "he",
        "origin": clip.get("origin") or "app",
        "stamp": "",
        "segments": [[0, "", text]] if text else [],
    }
