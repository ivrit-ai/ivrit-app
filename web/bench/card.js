// The on-device benchmark's result, as the Lab page (just run) and /bench/ (shared)
// show it: a run's report (server/bench.py: what Benchmark.java sent, scored here)
// as a card, and the leaderboard as a table. Hebrew, as these pages are.

const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const clock = (seconds) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// How many seconds of speech a second of work: over 1, faster than it was spoken.
export const speed = (run) => run.audioSeconds / run.seconds;

export const phone = (run) => [run.device?.manufacturer, run.device?.model].filter(Boolean).join(" ");

const where = (run) =>
  run.run?.processor === "gpu"
    ? `מעבד גרפי${run.run.backend ? ` (${run.run.backend}${run.run.chose === "webgpu" ? ", מנוע חדש" : ""})` : ""}${run.run.decoderCpu ? ", מפענח במעבד" : ""}`
    : "מעבד";

// Android's thermal status (0 none … 6 shutdown): from 2, moderate, the phone slows itself down.
const HOT = 2;
const hottest = (run) => Math.max(run.conditions?.start?.thermalStatus ?? 0, run.conditions?.end?.thermalStatus ?? 0);
const THERMAL = ["רגיל", "חם קצת", "חם (מאט)", "חם מאוד (מאט)", "חם מאוד (מאט)", "חם מאוד (מאט)", "חם מאוד (מאט)"];

function conditions(run) {
  const s = run.conditions?.start, e = run.conditions?.end;
  if (!s || !e) return "";
  const temp = (c) => (c?.batteryC == null ? "?" : `${c.batteryC.toFixed(0)}°`);
  return `<dt>חום</dt><dd>${esc(THERMAL[hottest(run)] ?? "?")} · סוללה ${temp(s)} ← ${temp(e)}</dd>
    <dt>בטעינה</dt><dd>${s.charging ? "כן" : "לא"}</dd>
    <dt>מסך דלוק</dt><dd>${s.screenOn || e.screenOn ? "כן" : "לא"}</dd>`;
}

export function card(run, url) {
  const accuracy = run.wer == null ? "—" : `${((1 - run.wer) * 100).toFixed(1)}%`;
  const stages = run.stages || {};
  const stage = (label, key) => (stages[key] ? `<dt>${label}</dt><dd>${stages[key].toFixed(1)} שנ׳</dd>` : "");
  return `<div class="bench-card">
    <div class="bench-big">${clock(run.seconds)}</div>
    <div class="bench-sub">5 דקות של עברית, פי ${speed(run).toFixed(2)} ממהירות הדיבור</div>
    <div class="bench-verified ${run.verified ? "ok" : ""}">${run.verified ? "✓ מאומת על ידי Google Play" : "לא מאומת"}</div>
    ${hottest(run) >= HOT ? `<div class="bench-hot">הטלפון התחמם במהלך הבדיקה והאט את עצמו: התוצאה איטית מהרגיל.</div>` : ""}
    <dl class="bench-facts">
      <dt>דיוק</dt><dd>${accuracy}</dd>
      <dt>דוברים</dt><dd>${esc(run.speakersFound ?? "—")}</dd>
      <dt>טלפון</dt><dd>${esc(phone(run))}</dd>
      ${run.device?.soc ? `<dt>שבב</dt><dd>${esc(run.device.soc)}</dd>` : ""}
      <dt>רץ על</dt><dd>${esc(where(run))}</dd>
    </dl>
    <details class="bench-more"><summary>פרטים</summary>
      <dl class="bench-facts">
        ${stage("הכנה", "prepare")}${stage("טעינת המודל", "load")}${stage("תמלול", "transcribe")}${stage("טביעות קול", "prints")}${stage("זיהוי דוברים", "cluster")}
        ${stage("בדיקת המעבד הגרפי (פעם ראשונה)", "check")}${stage("כיוון התהליכונים (פעם ראשונה)", "tune")}
        <dt>מודל</dt><dd>${esc(run.engine)}</dd>
        <dt>גרסה</dt><dd>${esc(run.app)}</dd>
        ${run.run?.gpu ? `<dt>מעבד גרפי</dt><dd>${esc(run.run.gpu)}</dd>` : ""}
        <dt>תהליכונים</dt><dd>${esc(run.run?.threads)} / מפענח ${esc(run.run?.decodeThreads)}</dd>
        <dt>Android</dt><dd>${esc(run.device?.android)}</dd>
        ${conditions(run)}
      </dl>
    </details>
    ${url ? `<p class="bench-link"><a href="${esc(url)}">${esc(url)}</a></p>` : ""}
  </div>`;
}

// The leaderboard: each phone's fastest run, fastest first.
export function board(runs, versions) {
  const rows = runs.map((r, i) => `<tr>
    <td class="n">${i + 1}</td>
    <td><a href="/bench/?id=${encodeURIComponent(r.id)}">${esc(phone(r))}</a>${r.verified ? ` <span title="מאומת על ידי Google Play">✓</span>` : ""}${r.device?.soc ? `<div class="bench-soc">${esc(r.device.soc)}</div>` : ""}
      ${versions ? `<div class="bench-soc">${esc(r.engine)} · ${esc(r.app)}</div>` : ""}</td>
    <td class="n">${clock(r.seconds)}</td>
    <td class="n">${speed(r).toFixed(2)}×</td>
    <td class="n">${r.wer == null ? "—" : `${((1 - r.wer) * 100).toFixed(1)}%`}</td>
    <td>${esc(where(r))}</td>
  </tr>`);
  return `<table class="bench-board"><thead><tr><th>#</th><th>טלפון</th><th>זמן</th><th>מהירות</th><th>דיוק</th><th>רץ על</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table>`;
}

export const STYLE = `
  .bench-card { padding: 18px; border-radius: 16px; background: var(--card); border: 1px solid var(--line); margin: 12px 0; }
  .bench-big { font: 700 56px/1 var(--font-display); direction: ltr; text-align: center; font-variant-numeric: tabular-nums; }
  .bench-sub { text-align: center; color: var(--ink-2); margin: 6px 0 6px; }
  .bench-verified { text-align: center; font-size: 13px; color: var(--muted); margin: 0 0 14px; }
  .bench-verified.ok { color: var(--ok); }
  .bench-hot { text-align: center; font-size: 13px; color: var(--danger); margin: -8px 0 14px; }
  .bench-facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 8px 0; font-size: 15px; }
  .bench-facts dt { color: var(--muted); }
  .bench-facts dd { margin: 0; overflow-wrap: anywhere; }
  .bench-more summary { cursor: pointer; color: var(--muted); }
  .bench-link { font-size: 14px; direction: ltr; text-align: left; overflow-wrap: anywhere; }
  .bench-board { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
  .bench-board th, .bench-board td { padding: 8px 4px; border-top: 1px solid var(--line-soft); text-align: start; vertical-align: top; }
  .bench-board td.n { direction: ltr; text-align: end; font-variant-numeric: tabular-nums; }
  .bench-soc { font-size: 12px; color: var(--muted); }
`;
