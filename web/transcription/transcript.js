// A transcript and what can be made of it: its edits applied, its speakers named,
// laid out for reading, and exported. No DOM here.
//
// A transcript is transcribe.ivrit.ai's results file ({results: [segment]}, each
// segment {text, start, end, speakers: ["SPEAKER_01"], words}). Edits are kept
// beside it (the .edits.json.gz overlay), in transcribe.ivrit.ai's own format, which
// both read: {edits: {"<segment index>": text}, speakerNames: {"SPEAKER_01": name},
// speakerSwaps: {"<segment index>": "SPEAKER_02"}}. Segments are never split,
// merged or retimed.

const SPEAKER_WORDS = {
  he: { speaker: "דובר {num}", unknown: "דובר לא מזוהה" },
  yi: { speaker: "רעדנדיקער {num}", unknown: "ניט־ידענטיפֿיצירטער רעדנדיקער" },
  en: { speaker: "Speaker {num}", unknown: "Unknown speaker" },
  fr: { speaker: "Locuteur {num}", unknown: "Locuteur inconnu" },
  es: { speaker: "Hablante {num}", unknown: "Hablante desconocido" },
  de: { speaker: "Sprecher {num}", unknown: "Unbekannter Sprecher" },
  zh: { speaker: "说话者 {num}", unknown: "未知说话者" },
};

export const RTL = (language) => language === "he" || language === "yi";

export const emptyEdits = () => ({ edits: {}, speakerNames: {}, speakerSwaps: {} });

export function normalizeEdits(data) {
  return {
    edits: { ...(data?.edits || {}) },
    speakerNames: { ...(data?.speakerNames || {}) },
    speakerSwaps: { ...(data?.speakerSwaps || {}) },
  };
}

export const hasEdits = (e) => Boolean(e && (Object.keys(e.edits).length || Object.keys(e.speakerNames).length || Object.keys(e.speakerSwaps).length));

// The segments as edited: text replaced, speakers swapped (names apply when labelled).
export function effective(results, e) {
  return results.map((segment, index) => {
    const out = { ...segment, speakers: segment.speakers ? [...segment.speakers] : [] };
    if (Object.prototype.hasOwnProperty.call(e.edits, index)) out.text = e.edits[index];
    if (Object.prototype.hasOwnProperty.call(e.speakerSwaps, index) && out.speakers.length) out.speakers[0] = e.speakerSwaps[index];
    return out;
  });
}

export const speakerOf = (segment) => (segment.speakers && segment.speakers.length ? segment.speakers[0] : null);
export const speakerNumber = (id) => parseInt(String(id).replace("SPEAKER_", ""), 10) || 0;
export const speakerId = (num) => `SPEAKER_${String(num).padStart(2, "0")}`;

// "Speaker 2", in the transcript's language, or the name the user gave.
export function speakerLabel(id, language, names = {}) {
  const words = SPEAKER_WORDS[language] || SPEAKER_WORDS.en;
  if (!id) return words.unknown;
  if (names[id]) return names[id];
  return words.speaker.replace("{num}", String(speakerNumber(id)));
}

// Every speaker a transcript has, in order of first appearance.
export function speakersIn(segments) {
  const seen = [];
  for (const s of segments) {
    const id = speakerOf(s);
    if (id && !seen.includes(id)) seen.push(id);
  }
  return seen.sort((a, b) => speakerNumber(a) - speakerNumber(b));
}

// 1:05, or 1:02:05.
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// 00:01:05.250 (subtitles).
function stamp(seconds, separator) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${separator}${String(ms).padStart(3, "0")}`;
}

// Runs of consecutive segments by one speaker: [{speaker, indices}].
export function turns(segments, indices = segments.map((_, i) => i)) {
  const out = [];
  for (const i of indices) {
    const speaker = speakerOf(segments[i]);
    const last = out[out.length - 1];
    if (last && last.speaker === speaker) last.indices.push(i);
    else out.push({ speaker, indices: [i] });
  }
  return out;
}

// Thirty-second windows, as transcribe.ivrit.ai groups them under a time range: a
// window closes at a segment that straddles its mark, at the last segment, or before
// a segment that starts after the mark. [{start, end, indices}]
export function timeGroups(segments) {
  const groups = [];
  let current = [];
  let mark = 30;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    current.push(i);
    const close =
      (s.start <= mark && s.end >= mark) || i === segments.length - 1 || (i < segments.length - 1 && segments[i + 1].start > mark);
    if (close) {
      groups.push({ start: segments[current[0]].start, end: segments[current[current.length - 1]].end, indices: current });
      current = [];
      mark += 30;
      while (i < segments.length - 1 && segments[i + 1].start > mark) mark += 30;
    }
  }
  return groups;
}

// How a transcript is laid out for reading: settings {textFormat: "continuous" |
// "segments", timestampFormat: "none" | "segments", diarizationDisplay: "enabled" |
// "disabled"}. [{range?, turns: [{speaker?, indices}]}]
export function layout(segments, settings) {
  const speakers = settings.diarizationDisplay !== "disabled";
  const split = (indices) => (speakers ? turns(segments, indices) : [{ speaker: undefined, indices }]);
  if (settings.timestampFormat === "segments") {
    return timeGroups(segments).map((g) => ({ range: `${clock(g.start)}-${clock(g.end)}`, turns: split(g.indices) }));
  }
  return [{ turns: split(segments.map((_, i) => i)) }];
}

// The transcript as plain text, laid out as on screen.
export function plainText(segments, settings, language, names, footer) {
  const joiner = settings.textFormat === "continuous" ? " " : "\n";
  const blocks = layout(segments, settings).map((block) => {
    const body = block.turns
      .map((turn) => {
        const text = turn.indices.map((i) => segments[i].text.trim()).join(joiner);
        return turn.speaker === undefined ? text : `${speakerLabel(turn.speaker, language, names)}: ${text}`;
      })
      .join("\n\n");
    return block.range ? `[${block.range}]\n${body}` : body;
  });
  return `${blocks.join("\n\n")}\n\n${footer}`;
}

export function vtt(segments) {
  return "WEBVTT\n\n" + segments.map((s, i) => `${i + 1}\n${stamp(s.start, ".")} --> ${stamp(s.end, ".")}\n${s.text.trim()}\n\n`).join("");
}

export function srt(segments) {
  return segments.map((s, i) => `${i + 1}\n${stamp(s.start, ",")} --> ${stamp(s.end, ",")}\n${s.text.trim()}\n\n`).join("");
}

export function json(segments) {
  return JSON.stringify(segments, null, 2);
}

const DOCX_COLORS = { 1: "#2196F3", 2: "#4CAF50", 3: "#FF9800", 4: "#9C27B0", 5: "#009688", 6: "#E91E63", 7: "#3F51B5", 8: "#795548", 9: "#607D8B", 10: "#8BC34A" };
const escapeHtml = (text) => String(text || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The Word document (html-docx-js turns this HTML into .docx), as transcribe.ivrit.ai made it.
export function docxHtml(segments, settings, language, names, footer) {
  const speakers = settings.diarizationDisplay !== "disabled";
  const rtl = RTL(language);
  const label = (id) => {
    if (!id) return `<span style="font-weight:700">${escapeHtml(speakerLabel(null, language, names))}: </span>`;
    const color = DOCX_COLORS[((speakerNumber(id) - 1) % 10) + 1] || "#000000";
    return `<span style="color:${color}; font-weight:700">${escapeHtml(speakerLabel(id, language, names))}: </span>`;
  };
  const lines = [
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">',
    '<head><meta charset="utf-8"><title>Transcript</title></head>',
    `<body style="font-family:'Arial', 'Helvetica', sans-serif; font-size:12pt; direction:${rtl ? "rtl" : "ltr"}; text-align:${rtl ? "right" : "left"}">`,
  ];
  if (settings.timestampFormat === "segments") {
    for (const s of segments) {
      lines.push(`<p>[${clock(s.start)}-${clock(s.end)}] ${speakers ? label(speakerOf(s)) : ""}${escapeHtml(s.text.trim())}</p>`);
    }
  } else {
    for (const turn of speakers ? turns(segments) : [{ speaker: undefined, indices: segments.map((_, i) => i) }]) {
      const text = turn.indices.map((i) => escapeHtml(segments[i].text.trim())).filter(Boolean).join(" ");
      lines.push(`<p>${turn.speaker === undefined ? "" : label(turn.speaker)}${text}</p>`);
    }
  }
  lines.push(`<p style="color:#666; font-size:10pt; margin-top:16pt">${escapeHtml(footer)}</p>`, "</body>", "</html>");
  return lines.join("\n");
}

// Figures for the statistics panel.
export function statistics(segments) {
  if (!segments.length) return null;
  const total = segments[segments.length - 1].end;
  const minutes = total / 60 || 1;
  const text = segments.map((s) => s.text).join(" ");
  const words = text.split(/\s+/).filter(Boolean).length;
  const letters = text.replace(/\s/g, "").length;
  const bySpeaker = {};
  const gaps = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const id = speakerOf(s) || "UNKNOWN";
    bySpeaker[id] = (bySpeaker[id] || 0) + (s.end - s.start);
    const next = segments[i + 1];
    if (next && speakerOf(next) !== speakerOf(s)) gaps.push(Math.max(0, next.start - s.end));
  }
  return {
    total,
    words,
    letters,
    wpm: Math.round(words / minutes),
    lpm: Math.round(letters / minutes),
    gap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    speakers: Object.entries(bySpeaker)
      .map(([id, seconds]) => ({ id, seconds, share: total ? seconds / total : 0 }))
      .sort((a, b) => b.seconds - a.seconds),
  };
}
