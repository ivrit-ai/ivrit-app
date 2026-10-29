// Screens of the real app for the Play listing: the web app as it runs in the
// Android shell (the shell itself faked in the page), against the same stack
// as the browser test (store/test-transcribe.mjs): a local Communicator, and the
// app's Python server with Drive as a local folder (server/tests/stack.py). The
// transcripts and messages are invented, and saved the way the app saves them.
//
//   SERVER_PYTHON=... ELIEZER_PYTHON=... node capture.mjs   → raw/*.png, 1080×2160
//
// Needs what the browser test needs: a Communicator checkout (COMMUNICATOR_DIR,
// default ../../notifier), Docker for the test databases, Chromium (CHROME,
// default Playwright's cache), and ffmpeg. Live transcription runs the real
// on-device model, fetched once into a cache (MODEL_CACHE, default the
// system's temporary folder).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync, gzipSync } from "node:zlib";
import { chromium } from "playwright-core";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.dirname(HERE);
const COMMUNICATOR = path.resolve(process.env.COMMUNICATOR_DIR ?? path.join(ROOT, "../notifier"));
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const PYTHON = process.env.SERVER_PYTHON ?? "python3";
const CACHE = process.env.MODEL_CACHE ?? path.join(tmpdir(), "ivrit-store-cache");
const OUT = path.join(HERE, "raw");
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

// The fake microphone hears Hebrew (the fixture, as WAV, which Chromium wants).
const MIC = path.join(CACHE, "hebrew-mic.wav");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(HERE, "fixtures/hebrew-12s.ogg"), "-ac", "1", "-ar", "48000", MIC]);

const { createUser, freshDatabase, startApp, startFcmService } = await import(path.join(COMMUNICATOR, "test/harness.js"));

const appPort = 31000 + Math.floor(Math.random() * 4000);
const origin = `http://localhost:${appPort}`;
const pool = await freshDatabase();
const fcm = await startFcmService();
const comm = await startApp({ APP_ORIGINS: origin, APP_TOKEN_ISSUER: origin, FCM_SERVICE_ACCOUNT: JSON.stringify(fcm.account), FCM_API_BASE: fcm.origin });

// Eliezer, as in production.
const admin = await createUser(pool, { email: process.env.ADMIN_EMAIL ?? "admin@example.com" });
const eliezer = await comm.call("POST", "/api/admin/sources", {
  cookie: admin.cookie,
  body: {
    id: "eliezer",
    name: "Eliezer",
    name_he: "אליעזר",
    description: "Transcripts of the voice messages you send on WhatsApp.",
    description_he: "תמלולים של ההודעות הקוליות שאתם שולחים בוואטסאפ.",
    link_methods: [
      { label: "Open WhatsApp", label_he: "פתיחת וואטסאפ", url_template: "https://wa.me/972559571223?text=link%20{code}", text_template: "link {code}" },
    ],
  },
});
await comm.call("PUT", "/api/admin/sources/eliezer/icon", { cookie: admin.cookie, raw: readFileSync(path.join(HERE, "eliezer.png")), type: "image/png" });
await pool.end();

const stack = spawn(PYTHON, ["-u", path.join(ROOT, "server/tests/stack.py"), String(appPort), comm.origin], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, COMMUNICATOR_SOURCE_KEY: "none" },
});
const info = await new Promise((resolve) => createInterface({ input: stack.stdout }).on("line", (l) => l.startsWith("{") && resolve(JSON.parse(l))));
// However this ends, the stack stops with it (its hub, server and database).
process.on("exit", () => stack.kill());
let current = null; // the page being captured

// --- the sample library: invented recordings, in folders, as My files keeps them

const SPEAKER = ["SPEAKER_01", "SPEAKER_02"]; // as the server numbers them, from 1
// [speaker, text] lines, timed one after another.
function segments(lines) {
  let at = 0;
  return lines.map(([who, text]) => {
    const seconds = Math.max(3, text.length / 13);
    const segment = { start: at, end: at + seconds, text, ...(who == null ? {} : { speakers: [SPEAKER[who]] }) };
    at += seconds + 0.6;
    return segment;
  });
}

const INTERVIEW = [
  [0, "ברוכה הבאה לתוכנית. היום אנחנו מדברים על שינה, ועל למה כל כך הרבה אנשים ישנים פחות ממה שהם צריכים."],
  [1, "תודה שהזמנתם אותי. האמת שזה אחד הנושאים שהכי מעסיקים אותי בשנים האחרונות."],
  [0, "אז בואי נתחיל מהבסיס. כמה שעות שינה מבוגר באמת צריך?"],
  [1, "רוב המבוגרים צריכים בין שבע לתשע שעות. אבל יותר מהמספר, מה שחשוב הוא הקביעות: ללכת לישון ולקום באותה שעה, גם בסוף השבוע."],
  [0, "וזה נכון גם למי שעובד במשמרות?"],
  [1, "שם זה מסובך יותר. אנחנו ממליצים לשמור על חושך מלא בחדר, ולהימנע ממסכים בשעה שלפני השינה."],
  [0, "דיברת על מסכים. כמה זה באמת משפיע?"],
  [1, "יותר ממה שנדמה. האור הכחול מעכב את הפרשת המלטונין, והתוכן עצמו משאיר את המוח ער וחושב."],
  [0, "ומה לגבי קפה? אני שותה כוס אחרי הצהריים ומרגיש שזה לא משנה כלום."],
  [1, "קפאין נשאר בגוף שש שעות ויותר. אולי נרדמים, אבל השינה העמוקה נפגעת, ובבוקר מרגישים את זה."],
];
const LECTURE = [
  [null, "בשיעור הקודם דיברנו על ההנחה שאנשים מקבלים החלטות באופן רציונלי. היום נראה כמה פעמים ההנחה הזאת לא מחזיקה."],
  [null, "קחו לדוגמה את אפקט העיגון: מספר שאנחנו שומעים במקרה משפיע על ההערכה שלנו, גם כשברור שאין לו שום קשר לשאלה."],
  [null, "בניסוי המפורסם, הנבדקים סובבו גלגל מזל לפני שהעריכו נתון גאוגרפי, ומי שקיבל מספר גבוה נתן הערכה גבוהה יותר."],
];
const MEETING = [
  [0, "בוקר טוב לכולם. שלושה נושאים היום: ההשקה, התקציב לרבעון הבא, והגיוס."],
  [1, "לגבי ההשקה, אנחנו בזמנים. נשארו שתי בדיקות אחרונות, ואם הן עוברות, עולים ביום ראשון."],
  [0, "מצוין. ומה עם המשוב מהלקוחות בפיילוט?"],
  [1, "רובו חיובי. הבקשה העיקרית הייתה ייצוא לאקסל, והוספנו את זה למשימות של השבוע."],
];
const NOTE = [[null, "רעיון לפרויקט: לאסוף את כל ההקלטות מהסדנה, לתמלל אותן, ולהכין מהן חוברת סיכום למשתתפים עד סוף החודש."]];
const CALL = [
  [0, "שלום, רציתי לשאול לגבי הדוח השנתי. מתי אתה צריך את הקבלות?"],
  [1, "עד סוף החודש יהיה מצוין. תשלח לי גם את אישורי התרומות, הם מזכים בזיכוי במס."],
];
const VOICE = [[null, "היי מותק, רק מזכירה שמחר בשבע אצל סבתא. תביא את השולחן המתקפל, ואל תשכח את העוגה מהמקרר."]];

const FOLDERS = ["פגישות עבודה", "הרצאות"];
// Newest first, as the list shows them.
const LIBRARY = [
  { folder: null, filename: "ראיון עם ד״ר נועה לוי על שינה.mp3", lines: INTERVIEW, audio: true },
  { folder: null, filename: "הודעה מאמא.opus", lines: VOICE, origin: "whatsapp" },
  { folder: null, filename: "שיחה עם רואה החשבון.m4a", lines: CALL },
  { folder: null, filename: "רעיון לפרויקט.m4a", lines: NOTE },
  { folder: "פגישות עבודה", filename: "פגישת צוות שבועית.m4a", lines: MEETING },
  { folder: "הרצאות", filename: "שיעור 4 - כלכלה התנהגותית.m4a", lines: LECTURE },
];

// Saved as the app saves a transcript made on the phone (api.saveToDrive),
// through the page so its cookie goes with it.
async function fill(page) {
  const ids = {};
  for (const name of FOLDERS) {
    const made = await page.evaluate(async (name) => (await fetch("/appdata/folders", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
    })).json(), name);
    ids[name] = made.id;
  }
  const audio = readFileSync(path.join(HERE, "fixtures/hebrew-12s.ogg")).toString("base64");
  for (const item of [...LIBRARY].reverse()) {
    const segs = segments(item.lines);
    const meta = {
      filename: item.filename, language: "he", duration_seconds: Math.round(segs.at(-1).end + 1), folder: ids[item.folder] ?? null,
      origin: item.origin ?? "upload", engine: "zipformer2-66m-he",
    };
    await page.evaluate(async ({ meta, segs, audio }) => {
      const form = new FormData();
      form.append("meta", JSON.stringify(meta));
      form.append("results", await new Response(new Blob([JSON.stringify(segs)]).stream().pipeThrough(new CompressionStream("gzip"))).blob(), "results.json.gz");
      if (audio) form.append("audio", new Blob([Uint8Array.from(atob(audio), (c) => c.charCodeAt(0))], { type: "audio/ogg" }), meta.filename);
      const res = await fetch("/appdata/local", { method: "POST", credentials: "same-origin", body: form });
      if (!res.ok) throw new Error(`save ${meta.filename}: ${res.status} ${await res.text()}`);
    }, { meta, segs, audio: item.audio ? audio : null });
    // Apart, so they list in this order.
    await page.waitForTimeout(1100);
  }
}

// As the server's own transcription leaves them (with speakers, by line), not as
// the phone's: what My files mostly holds. In Drive (a local folder here).
function asServerMade(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) asServerMade(file);
    if (!name.endsWith(".json.gz") || name === "search.json.gz") continue;
    const doc = JSON.parse(gunzipSync(readFileSync(file)));
    if (name === "toc.json.gz") {
      for (const entry of doc.entries) delete entry.engine;
    } else {
      delete doc.engine;
      const item = LIBRARY.find((i) => i.filename === doc.source_filename);
      doc.results.forEach((segment, i) => (segment.speakers = item?.lines[i]?.[0] == null ? [] : [SPEAKER[item.lines[i][0]]]));
    }
    writeFileSync(file, gzipSync(JSON.stringify(doc)));
  }
}

// Spoken into the Live screen in place of what the test recording says (a real
// podcast, naming a real guest): invented, like everything else here.
const LIVE = [
  "שלום לכולם, ותודה שבאתם. היום נדבר על איך מתכננים טיול משפחתי בלי לאבד את השפיות,",
  "ונתחיל מהדבר הכי חשוב: לבחור יעד שמתאים לכולם",
];

// Voice messages Eliezer transcribed, as if they had arrived over the past day.
const MIN = 60_000;
const SAMPLES = [
  { ago: 3 * MIN, st: "0:42", read: false, body: "היי, רק רציתי לעדכן שהגעתי. הפגישה הייתה מצוינת, הם אהבו את ההצעה ורוצים להתקדם כבר בשבוע הבא. נדבר בערב, יש לי המון לספר לך." },
  { ago: 18 * MIN, st: "0:16", read: false, body: "אני בדרך, אגיע בעוד עשר דקות בערך. תשמרו לי מקום ליד החלון." },
  { ago: 95 * MIN, st: "1:08", read: true, body: "תזכורת לעצמי: לקנות חלב, לחם ועגבניות, להתקשר לשרברב בקשר לברז במטבח, ולא לשכוח את יום ההולדת של סבתא ביום חמישי. אולי להזמין עוגה מהקונדיטוריה ליד הבית." },
  { ago: 26 * 60 * MIN, st: "0:51", read: true, body: "שלום לכולם, מזכירה שארוחת שישי השבוע אצלנו. מי שמביא קינוח שיגיד מראש, כדי שלא יהיו לנו שוב שלוש עוגות שוקולד כמו בפעם שעברה." },
  { ago: 27 * 60 * MIN, st: "0:09", read: true, body: "אליעזר מקושר! מעכשיו התמלולים של ההודעות הקוליות שתשלחו בוואטסאפ יגיעו לכאן." },
];

// --- the phone

function fakeShell(session) {
  if (!localStorage.getItem("app_session")) localStorage.setItem("app_session", JSON.stringify({ ...session, renewed_at: Date.now() }));
  // Asked already, and answered: no first-run questions over the screens.
  localStorage.setItem("device_id", "1");
  localStorage.setItem("reconciled_at", String(Date.now()));
  localStorage.setItem("notify_asked", "1");
  localStorage.setItem("notify_announced", "1");
  const status = { available: true, permission: "granted", popup: true, importance: 4, platform: "android", features: ["saveFiles", "appSettings", "localTranscription"] };
  const listeners = {};
  const on = (plugin) => (event, fn) => ((listeners[`${plugin}:${event}`] ||= []).push(fn), Promise.resolve({ remove() {} }));
  const plugins = {
    IvritNative: {
      notificationStatus: async () => status,
      requestPermission: async () => status,
      pushRegistration: async () => ({ transport: "fcm", token: "sample-token-0123456789abcdef", key: "A".repeat(43) }),
      openNotificationSettings: async () => {},
      configure: async () => ({}),
      takeOpened: async () => ({}),
      sharedFiles: async () => ({ files: [] }),
      localTranscriptions: async () => ({ items: [] }),
      addListener: on("IvritNative"),
    },
    SystemBars: { setStyle: async () => {} },
    App: { getInfo: async () => ({ version: "0.1.0", build: "999" }), getLaunchUrl: async () => ({}), addListener: on("App") },
  };
  window.Capacitor = {
    isNativePlatform: () => true,
    nativePromise: (plugin, method, options) =>
      method === "addListener" || !plugins[plugin]?.[method]
        ? Promise.reject(Object.assign(new Error(`${plugin}.${method} not implemented`), { code: "UNIMPLEMENTED" }))
        : Promise.resolve(plugins[plugin][method](options)),
    addListener: (plugin, event, callback) => (plugins[plugin].addListener(event, callback), { remove() {} }),
  };
}

// The model and ONNX Runtime through a cache on disk: fetched once, not on every run.
async function cached(context) {
  await context.route(/^https:\/\/(huggingface\.co\/ivrit-ai\/|cdn\.jsdelivr\.net\/npm\/onnxruntime-web)/, async (route) => {
    const file = path.join(CACHE, encodeURIComponent(route.request().url()).slice(0, 240));
    if (!existsSync(file)) {
      const res = await route.fetch({ timeout: 0 });
      writeFileSync(`${file}.type`, res.headers()["content-type"] || "application/octet-stream");
      writeFileSync(file, await res.body());
    }
    await route.fulfill({ path: file, contentType: readFileSync(`${file}.type`, "utf8"), headers: { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" } });
  });
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${MIC}`],
});

async function phone({ dark = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 720 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "he-IL",
    colorScheme: dark ? "dark" : "light",
    permissions: ["microphone"],
  });
  await cached(context);
  await context.addInitScript(fakeShell, info.session);
  const page = (current = await context.newPage());
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  // Drive, as the app connects it (the server's sign-in for this phone).
  await page.goto(`${origin}/__test/login?email=dana@example.com&sub=dana-sub&to=/`);
  await page.waitForSelector("#tr-list:not([hidden])", { timeout: 30000 });
  // The first run's question (keeping short recordings in Drive), answered;
  // once answered, it is not asked again.
  await page.waitForSelector("#confirm[open]", { timeout: 8000 }).then(() => page.click("#confirm-ok")).catch(() => {});
  return { context, page };
}

const snap = async (page, name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log("captured", name);
};
const FILE = "#tr-feed .tr-file.openable";
// A fresh load of the page at this hash (a new address, so not only a hashchange).
let loads = 0;
const open = (page, hash) => page.goto(`${origin}/?load=${++loads}${hash}`);

try {
  const { context, page } = await phone();
  await fill(page);
  asServerMade(path.join(info.work, "drive"));

  // Eliezer linked, with its code, as the user links it.
  await page.click("#tabs [data-view='inbox']");
  await page.click("#open-sources");
  await page.click("#sources .source-card .btn.primary");
  const code = (await (await page.waitForSelector("#sheet[open] .code-box .code", { timeout: 10000 })).textContent()).replace(/[^0-9A-Z]/gi, "");
  await comm.call("POST", "/api/source/v1/links", { bearer: eliezer.json.key, origin: null, body: { code, subject: "972500000567", label: "WhatsApp +972…567" } });
  await page.waitForSelector("#sheet[open] .success", { timeout: 15000 });
  await page.click("#sheet[open] .success .btn.primary");
  // The messages, kept on the phone as if they had come over the past day.
  await page.evaluate(async (samples) => {
    const now = Date.now();
    const messages = samples.map((m, i) => ({
      id: `01SAMPLE${String(i).padStart(18, "0")}`, created_at: now - m.ago, source: "Eliezer", source_id: "eliezer",
      title: "", subtitle: m.st, body: m.body, lang: "he", read: m.read,
    }));
    await self.NotifierStore.put(messages);
    await self.NotifierStore.markRead(messages.filter((m) => m.read).map((m) => m.id));
  }, SAMPLES);

  // My files, the top folder: its folders, then what is in it.
  await open(page, "#transcribe");
  await page.waitForSelector(FILE, { timeout: 20000 });
  await snap(page, "files");

  // A transcript, by speaker, with its recording.
  await page.click(`${FILE}:has-text("ראיון עם ד״ר נועה לוי")`);
  await page.waitForSelector("#tr-reader #tr-text .tr-seg", { timeout: 20000 });
  await snap(page, "reader");

  // Search, across everything.
  await open(page, "#transcribe");
  await page.waitForSelector("#tr-list:not([hidden]) .icon-btn[aria-label='חיפוש']", { timeout: 20000 });
  await page.click("#tr-list .icon-btn[aria-label='חיפוש']");
  await page.fill("#search-q", "השבוע");
  await page.waitForSelector("#search-results .search-result .search-hit mark", { timeout: 30000 });
  await page.evaluate(() => document.activeElement?.blur());
  await snap(page, "search");

  // Messages: Eliezer's transcripts of WhatsApp voice messages.
  await open(page, "");
  await page.click("#tabs [data-view='inbox']");
  await page.waitForSelector("#view-inbox .msg", { timeout: 15000 });
  console.log("inbox search:", JSON.stringify(await page.evaluate(() => {
    const input = document.getElementById("search");
    return { value: input.value, placeholder: input.placeholder, width: input.getBoundingClientRect().width };
  })));
  await snap(page, "inbox");

  // Live: the words as they are spoken, on the phone.
  await page.click("#tabs [data-view='live']");
  await page.click("#tr-live-start");
  await page.waitForSelector("#tr-live .tr-live-text p.tr-turn", { timeout: 300000 });
  await page.waitForTimeout(9000);
  await page.evaluate((lines) => {
    const box = document.querySelector("#tr-live .tr-live-text");
    // Its next words would draw over these: the box keeps these instead.
    box.replaceChildren = () => {};
    const turns = [...box.querySelectorAll("p.tr-turn")];
    turns.slice(lines.length).forEach((p) => p.remove());
    lines.forEach((text, i) => {
      const p = turns[i] ?? box.appendChild(turns[0].cloneNode());
      p.textContent = text;
      p.classList.toggle("tr-live-now", i === lines.length - 1);
    });
  }, LIVE);
  await snap(page, "live");
  await page.click("#tr-live .tr-live-controls .btn.primary").catch(() => {});
  await context.close();

  // And dark, as the phone is set.
  const night = await phone({ dark: true });
  await night.page.waitForSelector(FILE, { timeout: 20000 });
  await snap(night.page, "files-dark");
  await night.context.close();

} catch (err) {
  // A step that fails leaves a picture of the page it failed on.
  await current?.screenshot({ path: path.join(OUT, "failed.png") }).catch(() => {});
  console.error(err);
  process.exitCode = 1;
}
await browser.close();
stack.kill();
await comm.stop();
await fcm.close();
process.exit();
