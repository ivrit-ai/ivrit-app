// The app in a browser, signed in, transcribing a file in its Transcribe view:
// Communicator (its test harness, COMMUNICATOR_DIR or ../notifier), the hub, a fake
// RunPod and the app's Python server (server/tests/stack.py). Screens go to OUT.
//
//   SERVER_PYTHON=... ELIEZER_PYTHON=... node store/test-transcribe.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
// Python with server/requirements-xhost.txt (and psycopg); ELIEZER_PYTHON, the hub's.
const PYTHON = process.env.SERVER_PYTHON ?? "python3";
const OUT = process.env.OUT ?? (await import("node:os")).tmpdir();
const SAMPLE = path.join(OUT, "sample.ogg");
(await import("node:child_process")).execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=40", "-c:a", "libopus", "-b:a", "24k", SAMPLE]);
const COMMUNICATOR = path.resolve(process.env.COMMUNICATOR_DIR ?? path.join(ROOT, "../notifier"));
const { freshDatabase, startApp } = await import(path.join(COMMUNICATOR, "test/harness.js"));
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

const appPort = 33000 + Math.floor(Math.random() * 2000);
const origin = `http://localhost:${appPort}`;
await freshDatabase();
const comm = await startApp({ APP_ORIGINS: origin, APP_TOKEN_ISSUER: origin });
const stack = spawn(PYTHON, ["-u", path.join(ROOT, "server/tests/stack.py"), String(appPort), comm.origin], { stdio: ["ignore", "pipe", "inherit"] });
const info = await new Promise((resolve) => createInterface({ input: stack.stdout }).on("line", (l) => l.startsWith("{") && resolve(JSON.parse(l))));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `  [${detail}]`}`);
};

const browser = await chromium.launch({ executablePath: CHROME });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "he-IL" });
  await context.addInitScript((session) => {
    if (!localStorage.getItem("app_session")) localStorage.setItem("app_session", JSON.stringify({ ...session, renewed_at: Date.now() }));
  }, info.session);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(`${origin}/__test/login?email=dana@example.com&sub=dana-sub&to=/%23transcribe`);
  // First run: keep short recordings in Drive? Yes.
  const asked = await page.waitForSelector("dialog[open]", { timeout: 20000 }).catch(() => null);
  check("the first run asks whether to keep short recordings in Drive", Boolean(asked) && (await asked.textContent()).includes("Drive"));
  if (asked) await page.click("#confirm-ok");
  const mounted = await page.waitForSelector("#transcribe-app #file-input", { state: "attached", timeout: 40000 }).catch(() => null);
  check("the Transcribe view loads transcribe's page inside the app", Boolean(mounted), errors.join(" | "));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "bt-1-transcribe.png") });
  const headerKept = await page.locator("header.bar .brand").isVisible();
  check("the app's own bar stays", headerKept);
  const strings = await page.locator("#transcribe-app [data-i18n='tabMyFiles']").textContent();
  check("its strings are in the app's language", strings?.includes("הקבצים"), strings);
  const appTabs = await page.locator("#tabs button[data-view='transcribe'] span").textContent();
  check("...and the app's own strings are untouched by its translations", appTabs === "תמלול", appTabs);

  await page.setInputFiles("#file-input", SAMPLE);
  await page.waitForSelector("#transcribe-btn:not([disabled])", { timeout: 15000 });
  await page.click("#transcribe-btn");
  let ready = null;
  let lastToc = null;
  for (let i = 0; i < 60 && !ready; i++) {
    await page.waitForTimeout(1500);
    lastToc = await page.evaluate(async () => {
      const res = await fetch("/appdata/toc", { credentials: "same-origin" });
      return { status: res.status, body: await res.json() };
    }).catch((e) => ({ error: String(e) }));
    ready = lastToc.body?.entries?.find((e) => e.status === "Ready") ?? null;
  }
  if (!ready) console.log("last toc:", JSON.stringify(lastToc).slice(0, 500));
  check("a file uploaded in the view is transcribed and listed Ready", Boolean(ready), JSON.stringify(ready));

  await page.click("#transcribe-app .tab-button[data-tab='files']");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "bt-2-files.png") });
  const listed = await page.locator("#transcribe-app #files-list").textContent();
  check("My files shows it", listed?.includes("sample"), listed?.slice(0, 200));

  await page.locator("#transcribe-app #files-list").getByText("sample").first().click();
  const viewer = await page.waitForSelector("#transcribe-app #tab-viewer.active, #transcribe-app #tab-viewer:not([hidden])", { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "bt-3-viewer.png") });
  const text = await page.locator("#transcribe-app #tab-viewer").textContent().catch(() => "");
  check("the viewer opens it, with the transcript", Boolean(viewer) && text.includes("תמלול"), text.slice(0, 200));

  // English: both the app and the view follow.
  await page.click("#lang-switch button[data-locale='en']");
  await page.waitForTimeout(800);
  const en = await page.locator("#transcribe-app [data-i18n='tabMyFiles']").textContent();
  check("switching the app to English switches the view too", en === "My Files", en);
  const back = await page.locator("#transcribe-app [data-i18n='backToFiles']").first().textContent();
  check("...every string of it (none left as a key)", back && back !== "backToFiles", back);
  await page.screenshot({ path: path.join(OUT, "bt-4-english.png") });

  // A short transcript the app has, kept in the clips folder (once).
  const clip = await page.evaluate(async () => {
    const { token } = JSON.parse(localStorage.getItem("app_session"));
    const post = () => fetch("/clips/save", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: "app-test-clip", title: "voice note", text: "שלום, זה תמלול קצר", origin: "whatsapp", created_at: new Date().toISOString() }),
    }).then((r) => r.json());
    const settings = await fetch("/settings", { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    return { settings, first: await post(), second: await post() };
  });
  check("the answer is kept", clip.settings.clipsToDrive === true && clip.settings.driveConnected === true, JSON.stringify(clip.settings));
  check("a short transcript is saved to the clips folder, once", clip.first.saved === true && clip.second.already === true, JSON.stringify(clip));
  const { readdirSync } = await import("node:fs");
  const clipsDir = path.join(info.work, "drive", "clips", "rt-dana");
  const files = (() => { try { return readdirSync(clipsDir); } catch { return []; } })();
  check("...in a folder apart from the transcriptions", files.includes("toc.json.gz") && files.length === 2, files.join(","));

  const realErrors = errors.filter((e) => !/favicon|ERR_|Failed to load resource/.test(e));
  check("no script errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 600));

  // A phone-sized screen.
  await page.setViewportSize({ width: 412, height: 860 });
  await page.click("#transcribe-app .tab-button[data-tab='transcribe']");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "bt-5-phone.png"), fullPage: false });
  const boxes = await page.evaluate(() => {
    const box = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) }; };
    return { appTabs: box("#tabs"), viewTabs: box("#transcribe-app .ts-sections"), quota: box("#main-balance-container"), gear: box("#settings-btn") };
  });
  const quotaText = await page.locator("#transcribe-app #main-balance-label").textContent();
  check("the quota follows the language too", !/[א-ת]/.test(quotaText ?? ""), quotaText);
  await page.click("#tabs button[data-view='inbox']");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "bt-6-phone-inbox.png") });
  check("on a phone, the app's tab bar is still there", boxes.appTabs && boxes.appTabs.h > 0 && boxes.appTabs.y > 700, JSON.stringify(boxes.appTabs));
  check("...and the view's own sections and settings are reachable", boxes.viewTabs?.h > 0 && boxes.gear?.h > 0 && boxes.viewTabs.y < 700, JSON.stringify(boxes));
} finally {
  await browser.close();
  stack.kill();
  await comm.stop?.();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
