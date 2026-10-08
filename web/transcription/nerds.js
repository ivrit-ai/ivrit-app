// Stats for Nerds: how transcription is doing (the server's /stats), as
// transcribe.ivrit.ai showed it - figures, line charts over time, tables - drawn with
// the app's parts. In English, as it always was. Refreshes every 30 seconds while open.

import * as api from "./api.js";
import { tr } from "./strings.js";

const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];
const SVG = "http://www.w3.org/2000/svg";
let timer = null;

const num = (n) => (n == null || isNaN(n) ? "–" : Number(n).toLocaleString());
const sum = (values) => values.reduce((a, b) => a + b, 0);
function hours(h) {
  if (h == null || isNaN(h)) return "–";
  const total = Math.round(h * 3600);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  return hh ? `${hh}h ${mm}m` : mm ? `${mm}m` : total ? `${total}s` : "0";
}
function span(buckets) {
  const width = buckets[1] - buckets[0];
  const h = (buckets[buckets.length - 1] - buckets[0] + width) / 3600;
  return h > 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`;
}

export function open(host, showScreen) {
  const { el, icon } = host;
  clearInterval(timer);
  const body = el("div", { class: "stack" }, [el("p", { class: "muted", text: tr("loadingFile") })]);
  showScreen(el("div", { class: "tr-reader tr-nerds", dir: "ltr" }, [
    el("button", { class: "btn quiet small tr-back", type: "button", onclick: () => history.back() }, [icon("back"), el("span", { text: tr("back") })]),
    el("h2", { class: "title", text: "Stats for Nerds" }),
    body,
  ]));
  const load = async () => {
    if (!body.isConnected) return clearInterval(timer);
    try {
      draw(host, body, await api.stats());
    } catch {
      body.replaceChildren(el("p", { class: "muted", text: "Could not load the statistics." }));
    }
  };
  load();
  timer = setInterval(load, 30000);
}

function chart(host, title, series, { buckets, note, format = num }) {
  const { el } = host;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "tr-chart");
  const box = el("div", { class: "card tr-chart-card" }, [
    el("div", { class: "row spread" }, [el("h3", { text: `${title} — last ${span(buckets)}${note ? `, ${note}` : ""}` }), el("span", { class: "muted tr-peak" })]),
    svg,
    el("div", { class: "tr-legend" }, series.map((s) => el("span", {}, [el("i", { style: `background:${s.color || "var(--ink)"}` }), document.createTextNode(s.name)]))),
  ]);
  requestAnimationFrame(() => {
    const W = svg.clientWidth || 600, H = 160, L = 40, R = 6, T = 8, B = 18;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const n = series[0]?.values.length || 0;
    if (!n) return;
    const top = Math.max(0, ...series.map((s) => Math.max(...s.values)));
    const max = Math.max(top, 1);
    const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R));
    const y = (v) => T + (H - T - B) - (v / max) * (H - T - B);
    const pts = (values) => values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const add = (tag, attrs, text) => {
      const node = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      if (text != null) node.textContent = text;
      svg.append(node);
    };
    for (const v of [0, max]) {
      add("line", { class: "axis", x1: L, x2: W - R, y1: y(v), y2: y(v) });
      add("text", { class: "axis-label", x: 2, y: y(v) + 3 }, format(v));
    }
    add("text", { class: "axis-label", x: L, y: H - 5 }, `-${span(buckets)}`);
    add("text", { class: "axis-label", x: W - R, y: H - 5, "text-anchor": "end" }, "now");
    const bold = series.find((s) => s.bold);
    if (bold) add("polygon", { class: "area", points: `${L},${y(0)} ${pts(bold.values)} ${W - R},${y(0)}` });
    for (const s of [...series.filter((s) => !s.bold), ...series.filter((s) => s.bold)]) {
      add("polyline", { points: pts(s.values), fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round", style: `stroke:${s.color || "var(--ink)"};stroke-width:${s.bold ? 2.25 : 1.5}` });
    }
    box.querySelector(".tr-peak").textContent = top > 0 ? `peak ${format(top)}` : "no data";
  });
  return box;
}

function table(host, title, head, rows) {
  const { el } = host;
  return el("div", { class: "card" }, [
    el("h3", { text: title }),
    el("table", { class: "tr-table" }, [
      head ? el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i ? "num" : "", text: h })))) : null,
      el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => el("td", { class: i ? "num" : "", text: c }))))),
    ]),
  ]);
}

function draw(host, body, data) {
  const { el } = host;
  const queued = data.queued_jobs;
  const running = data.running_jobs;
  const launch = data.transcribed_since_launch;
  const pf = data.private_vs_free;
  const since = pf.since_launch_ts ? new Date(pf.since_launch_ts * 1000).toISOString().slice(0, 10) : "launch";
  const t = data.transcoding;
  const h = data.history;
  const hourly = h.jobs_hourly;
  const day = (a) => a.slice(-24);
  const done24 = sum(day(hourly.completed));
  const failed24 = sum(day(hourly.failed));
  const audio24 = sum(day(hourly.audio_hours));
  const compute24 = sum(day(hourly.transcribe_hours));
  const figure = (label, value, unit = "") => el("div", { class: "tr-figure" }, [el("b", { text: `${value}${unit ? ` ${unit}` : ""}` }), el("span", { class: "muted", text: label })]);
  const count = (o) => o.short.count + o.long.count + o.private.count;
  const q = h.queue;
  const qs = q.series;
  const queueFields = [
    ["Queued short", qs.queued_short], ["Queued long", qs.queued_long], ["Queued private", qs.queued_private],
    ["Running short", qs.running_short], ["Running long", qs.running_long], ["Running private", qs.running_private],
    ["Transcoding queued", qs.transcoding_queued], ["Transcoding running", qs.transcoding_running],
  ];
  const share = (period, side) => {
    const total = period.private.audio_hours + period.free.audio_hours;
    return `${hours(period[side].audio_hours)}${total > 0 ? ` (${Math.round((period[side].audio_hours / total) * 100)}%)` : ""} · ${num(period[side].jobs)} jobs`;
  };
  const drive = data.errors.google_drive;
  const nodes = [
    el("div", { class: "tr-figures" }, [
      figure("Uptime", data.uptime),
      figure(`Jobs since ${since}`, num(launch.total.jobs_count)),
      figure(`Audio since ${since}`, hours(launch.total.total_minutes / 60)),
      figure("Jobs (24h)", num(done24)),
      figure("Audio (24h)", hours(audio24)),
      figure("Realtime factor (24h)", compute24 > 0 ? `${(audio24 / compute24).toFixed(1)}×` : "–"),
      figure("Failures (24h)", num(failed24), done24 + failed24 > 0 ? `(${((failed24 / (done24 + failed24)) * 100).toFixed(1)}%)` : ""),
      figure("Queued now", num(count(queued))),
      figure("Running now", num(count(running))),
      figure("Transcoding now", num(t.running_count), `/ ${num(t.running_capacity)}`),
    ]),
    chart(host, "Queue depth", [
      { name: "All jobs", values: q.buckets.map((_, i) => sum(queueFields.map(([, v]) => v[i]))), bold: true },
      ...queueFields.map(([name, values], i) => ({ name, values, color: COLORS[i % COLORS.length] })),
    ], { buckets: q.buckets, note: "15-minute peaks" }),
  ];
  for (const [key, per] of [["jobs_hourly", "hour"], ["jobs_daily", "day"]]) {
    const s = h[key];
    nodes.push(chart(host, `Jobs per ${per}`, [
      { name: "All jobs", values: s.completed.map((c, i) => c + s.failed[i]), bold: true },
      { name: "Completed", values: s.completed, color: COLORS[2] },
      { name: "Failed", values: s.failed, color: COLORS[1] },
    ], { buckets: s.buckets }));
    nodes.push(chart(host, `Audio hours per ${per}`, [
      { name: "Audio transcribed", values: s.audio_hours, bold: true },
      { name: "Compute spent", values: s.transcribe_hours, color: COLORS[0] },
    ], { buckets: s.buckets, format: hours }));
  }
  nodes.push(
    table(host, `Languages — last ${h.language_days} days`, ["Language", "Jobs", "Audio"], h.languages.length
      ? h.languages.map((l) => [l.language, num(l.jobs), hours(l.audio_hours)])
      : [[`No jobs in the last ${h.language_days} days.`, "", ""]]),
    table(host, "Private and free", ["", `Since ${since}`, `Last ${pf.recent_days} days`], [
      ["Private (own RunPod key)", share(pf.since_launch, "private"), share(pf.recent, "private")],
      ["Free (short + long)", share(pf.since_launch, "free"), share(pf.recent, "free")],
    ]),
    table(host, "Queues", ["Queue", "Queued", "Running", "Max parallel"], ["short", "long", "private"].map((k) => [
      k, `${queued[k].count} (${hours(queued[k].total_duration_minutes / 60)})`, `${running[k].count} (${hours(running[k].total_duration_minutes / 60)})`, String(data.system_info.max_parallel_jobs[k]),
    ])),
    table(host, "Transcoding", null, [
      ["Jobs", num(t.jobs)], ["Total data", `${t.total_gb.toFixed(2)} GB`], ["Total duration", t.total_duration_formatted],
      ["Queued", `${t.queued_count} / ${t.queued_capacity}`], ["Running", `${t.running_count} / ${t.running_capacity}`],
      ["Oldest running", t.running_max_elapsed_seconds > 0 ? `${Math.round(t.running_max_elapsed_seconds)}s` : "–"],
    ]),
    table(host, "Errors", null, [
      ["Drive: TOC upload", num(drive.toc_upload)], ["Drive: TOC download", num(drive.toc_download)],
      ["Drive: audio upload", num(drive.audio_upload)], ["Drive: audio download", num(drive.audio_download)],
      ["Drive: rename", num(drive.rename)], ["Drive: delete", num(drive.delete)],
      ["Drive: storage full", num(drive.storage_full)], ["Drive: storage full (pre-flight)", num(drive.storage_full_precheck)],
      ["Quota exceeded", num(data.errors.quota_denied)], ["Job timeouts", num(data.errors.job_timeouts)], ["Job timeouts (private)", num(data.errors.job_timeouts_private)],
    ]),
    el("p", { class: "muted", text: `Updated ${new Date().toLocaleTimeString()}` }),
  );
  body.replaceChildren(...nodes);
}
