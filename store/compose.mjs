// Turns the captured screens into Play's listing graphics:
//
//   phone/01-…png … 07-…png   1080×1920 screenshots, captioned, in a phone
//   feature-graphic.png        1024×500
//
// Both without transparency, as Play requires. Run capture.mjs first.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
// Google Play's (phone/, 1080×1920, and the feature graphic), or the App Store's
// (DEVICE=iphone: iphone/, 1290×2796, from raw/iphone/).
const IPHONE = process.env.DEVICE === "iphone";
const DIR = IPHONE ? "iphone" : "phone";
const SIZE = IPHONE ? { width: 1290, height: 2796 } : { width: 1080, height: 1920 };
mkdirSync(path.join(HERE, DIR), { recursive: true });

// Hebrew, the listing's language. Each says one thing the app does.
const SCREENS = [
  { file: "01-files", shot: "files", title: "כל התמלולים שלכם, בתיקיות", sub: "שמורים ב-Google Drive שלכם, ובכל מכשיר" },
  { file: "02-reader", shot: "reader", title: "תמלול מדויק בעברית, עם דוברים", sub: "מאזינים, עורכים, ומייצאים ל-Word או לכתוביות" },
  { file: "03-live", shot: "live", title: "תמלול חי, תוך כדי דיבור", sub: "על הטלפון עצמו, גם בלי חשבון" },
  { file: "04-search", shot: "search", title: "מוצאים כל מילה שנאמרה", sub: "חיפוש בכל התמלולים וההודעות" },
  { file: "05-inbox", shot: "inbox", title: "ההודעות הקוליות מוואטסאפ, כטקסט", sub: "שולחים לאליעזר, והתמלול מגיע לכאן" },
  { file: "06-notification", shot: "notification", title: "קופצות על המסך, גם כשהאפליקציה סגורה", sub: "כל תמלול מגיע כהתראה, ברגע שהוא מוכן" },
  { file: "07-dark", shot: "files-dark", title: "גם במצב כהה", sub: "בעברית, באנגלית וביידיש, בהיר או כהה" },
];

// The app's status-bar icon, white, for the lock-screen mock-up.
execFileSync("rsvg-convert", ["-w", "64", "-h", "64", path.join(HERE, "../shared/brand/badge.svg"), "-o", path.join(HERE, "badge-white.png")]);

// Served over HTTP rather than opened as files: the app's font stylesheet
// points at /fonts/, as on app.ivrit.ai.
const ROOT = path.dirname(HERE);
const TYPES = { ".html": "text/html", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  let file = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (file.startsWith("/fonts/")) file = `/web${file}`;
  const full = path.join(ROOT, path.normalize(file));
  let body;
  try {
    if (!full.startsWith(ROOT)) throw new Error("outside");
    body = readFileSync(full);
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(full)] ?? "application/octet-stream" }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/store/`;

const browser = await chromium.launch({ executablePath: CHROME });

async function render(file, { width, height }, out) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(BASE + file);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
  await page.close();
  // Play rejects screenshots with an alpha channel.
  execFileSync("convert", [out, "-background", "white", "-alpha", "remove", "-alpha", "off", out]);
  console.log("wrote", path.relative(HERE, out));
}

for (const s of SCREENS) {
  const query = new URLSearchParams({ shot: s.shot, title: s.title, sub: s.sub });
  if (IPHONE) {
    // Drawn as Android shows it: not for the App Store.
    if (s.shot === "notification") continue;
    query.set("device", "iphone");
    query.set("shot", `iphone/${s.shot}`);
  }
  await render(`screen.html?${query}`, SIZE, path.join(HERE, DIR, `${s.file}.png`));
}
if (!IPHONE) await render("feature.html", { width: 1024, height: 500 }, path.join(HERE, "feature-graphic.png"));
await browser.close();
server.close();
