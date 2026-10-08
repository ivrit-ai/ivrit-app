// The app in a browser, signed in, transcribing in its Transcribe tab (web/transcription/):
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "he-IL", acceptDownloads: true });
  await context.addInitScript((session) => {
    if (!localStorage.getItem("app_session")) localStorage.setItem("app_session", JSON.stringify({ ...session, renewed_at: Date.now() }));
  }, info.session);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const shot = (name) => page.screenshot({ path: path.join(OUT, `bt-${name}.png`) });
  const server = (url, init) => page.evaluate(async ([url, init]) => {
    const res = await fetch(url, { credentials: "same-origin", ...init });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [url, init ?? {}]);

  await page.goto(`${origin}/__test/login?email=dana@example.com&sub=dana-sub&to=/%23transcribe`);
  // First run: keep short recordings in Drive? Yes.
  const asked = await page.waitForSelector("dialog[open]", { timeout: 20000 }).catch(() => null);
  check("the first run asks whether to keep short recordings in Drive", Boolean(asked) && (await asked.textContent()).includes("Drive"));
  if (asked) await page.click("#confirm-ok");

  // --- the list
  const listed = await page.waitForSelector("#tr-feed", { timeout: 30000 }).catch(() => null);
  check("the Transcribe tab shows the user's transcripts", Boolean(listed), errors.join(" | "));
  await page.waitForTimeout(1200);
  check("with nothing yet, it says so", (await page.locator("#tr-feed .empty").count()) === 1);
  check("its title and quota are the app's", (await page.locator("#tr-list .title").textContent()) === "תמלול"
    && /השבוע/.test(await page.locator("#tr-quota").textContent()), await page.locator("#tr-quota").textContent());
  await shot("1-list-empty");

  // --- a new transcription, through the sheet
  await page.setInputFiles("#tr-input", SAMPLE);
  const sheet = await page.waitForSelector("#sheet[open] .tr-new", { timeout: 5000 }).catch(() => null);
  check("choosing a file opens the app's sheet, with the language and keeping the audio", Boolean(sheet)
    && (await page.locator("#sheet .tr-select").inputValue()) === "he");
  await shot("2-sheet");
  await page.click("#sheet .tr-new button[type=submit]");
  const onItsWay = await page.waitForSelector("#tr-feed .tr-file .tag.accent, #tr-feed .tr-file .tag", { timeout: 10000 }).catch(() => null);
  check("the file shows in the list on its way", Boolean(onItsWay));
  let ready = null;
  for (let i = 0; i < 60 && !ready; i++) {
    await page.waitForTimeout(1500);
    const toc = await server("/appdata/toc");
    ready = toc.body?.entries?.find((e) => e.status === "Ready") ?? null;
  }
  check("it is transcribed and ready", Boolean(ready));
  await page.waitForSelector("#tr-feed .tr-file.openable", { timeout: 15000 }).catch(() => null);
  check("the list shows it ready, by name", (await page.locator("#tr-feed .tr-file.openable .msg-title").first().textContent()) === "sample.ogg");
  await shot("3-list");

  // --- the transcript
  await page.click("#tr-feed .tr-file.openable");
  const reader = await page.waitForSelector("#tr-reader #tr-text .tr-seg", { timeout: 20000 }).catch(() => null);
  check("it opens as a screen of its own, with the text by speaker", Boolean(reader)
    && (await page.locator("#tr-text").textContent()).includes("תמלול") && (await page.locator("#tr-text .tr-who").count()) > 0);
  check("...its link is its own (#t/<id>)", page.url().includes(`#t/${ready?.results_id}`), page.url());
  check("...with its audio", (await page.locator("#tr-audio").count()) === 1);
  await shot("4-transcript");

  // display: timestamps on
  await page.click(".tr-toolbar button:has(use[href='#i-display'])");
  await page.click("#sheet .seg button:has-text('כולל קודי זמן')");
  check("display options apply at once (timestamps)", (await page.locator("#tr-text .tr-range").count()) > 0);
  await page.click("#sheet-close");
  await page.click(".tr-toolbar button:has(use[href='#i-display'])");
  await page.click("#sheet .seg button:has-text('ללא קודי זמן')");
  await page.click("#sheet-close");

  // statistics
  await page.click(".tr-toolbar button:has(use[href='#i-chart'])");
  check("statistics, in a sheet", (await page.locator("#sheet .tr-figure").count()) >= 5);
  await page.click("#sheet-close");

  // export
  await page.click(".tr-toolbar button:has(use[href='#i-download'])");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }).catch(() => null), page.click("#sheet .tr-choice:has-text('SRT')")]);
  check("export: SRT", download?.suggestedFilename() === "sample.srt", download?.suggestedFilename());

  // --- editing: a sentence and a speaker's name, saved as transcribe.ivrit.ai saves them
  await page.click(".tr-toolbar button:has(use[href='#i-edit'])");
  await page.waitForSelector("#tr-text.editing .tr-seg[contenteditable]");
  const seg = page.locator("#tr-text .tr-seg").first();
  await seg.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ותוקן");
  await page.click("#tr-text .tr-who");
  await page.fill("#sheet .tr-input", "דנה");
  await page.click("#sheet form button[type=submit]");
  await shot("5-editing");
  await page.click(".tr-editbar .btn.primary");
  await page.waitForTimeout(1000);
  const saved = await server(`/appdata/edits/${ready?.results_id}`);
  check("edits are saved in transcribe.ivrit.ai's format", saved.body?.edits?.["0"]?.endsWith("ותוקן")
    && saved.body?.speakerNames?.SPEAKER_00 === "דנה" && JSON.stringify(saved.body?.speakerSwaps) === "{}", JSON.stringify(saved.body));
  check("...and show: the new name, marked edited", (await page.locator("#tr-text .tr-who").first().textContent()) === "דנה"
    && (await page.locator(".tr-edited").count()) === 1);
  await page.click(".tr-modes button:nth-child(3)");
  await page.waitForTimeout(800);
  check("comparing shows what changed", (await page.locator("#tr-text ins").count()) > 0);
  await shot("6-compare");
  await page.click(".tr-modes button:nth-child(1)");

  // --- back to the list, and the language
  await page.click(".tr-back");
  await page.waitForSelector("#tr-list:not([hidden])");
  check("back returns to the list", !page.url().includes("#t/"));
  await page.click("#lang-switch button[data-locale='en']");
  await page.waitForTimeout(800);
  check("in English, the tab is too", (await page.locator("#tr-list .title").textContent()) === "Transcribe"
    && (await page.locator("#tr-list .btn.primary span").textContent()) === "Upload a file");
  await page.click("#lang-switch button[data-locale='yi']");
  await page.waitForTimeout(500);
  check("...and in Yiddish", (await page.locator("#tr-list .title").textContent()) === "טראַנסקריבירן");
  await page.click("#lang-switch button[data-locale='he']");

  // --- Settings: transcribing's own, natively
  await page.click("#tabs button[data-view='settings']");
  await page.waitForSelector("#transcribe-settings-box form", { timeout: 10000 }).catch(() => null);
  check("Settings holds transcribing's settings (the user's own RunPod key)", (await page.locator("#transcribe-settings-box input[type=password]").count()) === 1);
  await page.click("#transcribe-settings-box a[href='#t/stats']");
  const nerds = await page.waitForSelector(".tr-nerds .tr-figure", { timeout: 15000 }).catch(() => null);
  check("Stats for Nerds", Boolean(nerds) && (await page.locator(".tr-nerds .tr-chart").count()) >= 5);
  await shot("7-nerds");

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
  const files = (() => { try { return readdirSync(path.join(info.work, "drive", "clips", "rt-dana")); } catch { return []; } })();
  check("...in a folder apart from the transcriptions", files.includes("toc.json.gz") && files.length === 2, files.join(","));

  // --- a phone
  await page.setViewportSize({ width: 412, height: 860 });
  await page.goto(`${origin}/#t/${encodeURIComponent(ready?.results_id ?? "")}`);
  await page.waitForSelector("#tr-reader #tr-text .tr-seg", { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(800);
  await shot("8-phone-transcript");
  const tabs = await page.evaluate(() => {
    const r = document.getElementById("tabs").getBoundingClientRect();
    return { y: r.y, h: r.height };
  });
  check("on a phone, a transcript opens from its link, under the app's tab bar", tabs.h > 0 && tabs.y > 700, JSON.stringify(tabs));
  await page.click(".tr-back");
  await page.waitForTimeout(800);
  await shot("9-phone-list");

  const realErrors = errors.filter((e) => !/favicon|ERR_|Failed to load resource/.test(e));
  check("no script errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 600));
} finally {
  await browser.close();
  stack.kill();
  await comm.stop?.();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
