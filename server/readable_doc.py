"""A transcript as a readable document: the Google Doc kept beside each transcript's
JSON in My files, so it can be read, shared and searched in Drive itself.

The text is what the user sees in the app: the transcript with its edits applied
(`effective`, the same substitution as web/transcription/transcript.js, checked
against it by tests/fixtures/effective.json), its speakers by the names the user
gave them, in turns, each with the time it starts. It is HTML, which Drive
converts into a Doc on upload.
"""

import html
from typing import Any, Dict, List, Optional

# As web/transcription/transcript.js's SPEAKER_WORDS.
SPEAKER_WORDS = {
    "he": ("דובר {num}", "דובר לא מזוהה"),
    "yi": ("רעדנדיקער {num}", "ניט־ידענטיפֿיצירטער רעדנדיקער"),
    "en": ("Speaker {num}", "Unknown speaker"),
    "fr": ("Locuteur {num}", "Locuteur inconnu"),
    "es": ("Hablante {num}", "Hablante desconocido"),
    "de": ("Sprecher {num}", "Unbekannter Sprecher"),
    "zh": ("说话者 {num}", "未知说话者"),
}

# As the app's Word export (DOCX_COLORS).
SPEAKER_COLORS = ["#2196F3", "#4CAF50", "#FF9800", "#9C27B0", "#009688", "#E91E63", "#3F51B5", "#795548", "#607D8B", "#8BC34A"]

FOOTERS = {
    "he": "תומלל באמצעות שירות התמלול של ivrit.ai",
    "yi": "טראַנסקריבירט דורך ivrit.ai'ס דינסט",
    "en": "Transcribed using ivrit.ai's transcription service",
}

RTL = ("he", "yi")


def empty_edits() -> Dict[str, Dict[str, str]]:
    return {"edits": {}, "speakerNames": {}, "speakerSwaps": {}}


def normalize_edits(data: Optional[dict]) -> Dict[str, Dict[str, str]]:
    data = data or {}
    return {key: dict(data.get(key) or {}) for key in ("edits", "speakerNames", "speakerSwaps")}


def effective(results: List[dict], edits: Dict[str, Dict[str, str]]) -> List[dict]:
    """The segments as edited: text replaced and the first speaker swapped, by
    segment index (the overlay's keys are the indices as strings)."""
    out = []
    for index, segment in enumerate(results):
        seg = {**segment, "speakers": list(segment.get("speakers") or [])}
        key = str(index)
        if key in edits["edits"]:
            seg["text"] = edits["edits"][key]
        if key in edits["speakerSwaps"] and seg["speakers"]:
            seg["speakers"][0] = edits["speakerSwaps"][key]
        out.append(seg)
    return out


def speaker_of(segment: dict) -> Optional[str]:
    speakers = segment.get("speakers") or []
    return speakers[0] if speakers else None


def speaker_number(speaker_id: str) -> int:
    try:
        return int(str(speaker_id).replace("SPEAKER_", ""))
    except ValueError:
        return 0


def speaker_label(speaker_id: Optional[str], language: str, names: Dict[str, str]) -> str:
    """"Speaker 2" in the transcript's language, or the name the user gave."""
    speaker, unknown = SPEAKER_WORDS.get(language, SPEAKER_WORDS["en"])
    if not speaker_id:
        return unknown
    if names.get(speaker_id):
        return names[speaker_id]
    return speaker.replace("{num}", str(speaker_number(speaker_id)))


def clock(seconds: Any) -> str:
    """1:05, or 1:02:05."""
    s = max(0, int(float(seconds or 0)))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def turns(segments: List[dict]) -> List[dict]:
    """Runs of consecutive segments by one speaker: [{speaker, indices}]."""
    out: List[dict] = []
    for i, segment in enumerate(segments):
        speaker = speaker_of(segment)
        if out and out[-1]["speaker"] == speaker:
            out[-1]["indices"].append(i)
        else:
            out.append({"speaker": speaker, "indices": [i]})
    return out


def render_html(title: str, segments: List[dict], language: str, names: Dict[str, str], meta: str = "") -> str:
    """The document: the title, a line about it, then each turn with its time and
    speaker. Speakers are shown only when the transcript has them."""
    rtl = language in RTL
    esc = html.escape
    has_speakers = any(speaker_of(s) for s in segments)
    lines = [
        "<html><head><meta charset=\"utf-8\"><title>" + esc(title) + "</title></head>",
        f"<body dir=\"{'rtl' if rtl else 'ltr'}\" style=\"font-family: Arial, sans-serif; font-size: 12pt; "
        f"direction: {'rtl' if rtl else 'ltr'}; text-align: {'right' if rtl else 'left'}\">",
        f"<h1>{esc(title)}</h1>",
    ]
    if meta:
        lines.append(f"<p style=\"color:#666666\">{esc(meta)}</p>")
    for turn in turns(segments):
        text = " ".join(t for t in (segments[i].get("text", "").strip() for i in turn["indices"]) if t)
        if not text:
            continue
        start = clock(segments[turn["indices"][0]].get("start"))
        label = ""
        if has_speakers:
            color = SPEAKER_COLORS[(speaker_number(turn["speaker"]) - 1) % 10] if turn["speaker"] else "#000000"
            label = f"<b style=\"color:{color}\">{esc(speaker_label(turn['speaker'], language, names))}:</b> "
        lines.append(f"<p><span style=\"color:#888888\">[{start}]</span> {label}{esc(text)}</p>")
    lines.append(f"<p style=\"color:#666666; font-size:10pt\">{esc(FOOTERS.get(language, FOOTERS['en']))}</p>")
    lines.append("</body></html>")
    return "\n".join(lines)


def doc_name(title: str) -> str:
    """The Doc's name in Drive: the transcript's title, without the audio file's extension."""
    base = (title or "transcript").strip()
    if "." in base and len(base.rsplit(".", 1)[1]) <= 5:
        base = base.rsplit(".", 1)[0]
    return base or "transcript"
