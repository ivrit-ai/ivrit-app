// Screens of the real app for the Play listing: the web app as it runs in the
// Android shell (the shell itself faked in the page), against a local
// Communicator from its test harness, with made-up sample transcripts.
//
//   node capture.mjs        → raw/*.png, 1080×2160
//
// Needs a Communicator checkout (COMMUNICATOR_DIR, default ../../notifier)
// with Docker for its test database, and Chromium (CHROME, default
// Playwright's cache).
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.dirname(HERE);
const COMMUNICATOR = path.resolve(process.env.COMMUNICATOR_DIR ?? path.join(ROOT, "../notifier"));
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const OUT = path.join(HERE, "raw");
mkdirSync(OUT, { recursive: true });

const { createUser, freshDatabase, startApp, startFcmService } = await import(path.join(COMMUNICATOR, "test/harness.js"));

const appPort = 31000 + Math.floor(Math.random() * 4000);
const appOrigin = `http://localhost:${appPort}`;
const pool = await freshDatabase();
const fcm = await startFcmService();
const comm = await startApp({
  APP_ORIGINS: appOrigin,
  APP_HANDOFF_URLS: "ai.ivrit.app://auth",
  FCM_SERVICE_ACCOUNT: JSON.stringify(fcm.account),
  FCM_API_BASE: fcm.origin,
});
// The app's pages, as the site serves them, pointed at this Communicator.
const APP = JSON.parse(readFileSync(path.join(ROOT, "shared/app.json"), "utf8"));
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const WEB = path.join(ROOT, "web");
const web = createServer((req, res) => {
  const { pathname } = new URL(req.url, appOrigin);
  if (pathname === "/config.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    const config = { communicator: comm.origin, transcribe: APP.transcribe, eliezer: APP.eliezer, googleClientId: null };
    return res.end(`self.IVRIT_CONFIG = ${JSON.stringify(config)};\n`);
  }
  const file = path.join(WEB, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
  try {
    if (!file.startsWith(WEB)) throw new Error("outside");
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => web.listen(appPort, r));

// Eliezer, as in production.
const admin = await createUser(pool, { email: process.env.ADMIN_EMAIL ?? "admin@example.com" });
const { json: created } = await comm.call("POST", "/api/admin/sources", {
  cookie: admin.cookie,
  body: {
    id: "eliezer",
    name: "Eliezer",
    name_he: "אליעזר",
    description: "Transcripts of the voice messages you send on WhatsApp.",
    description_he: "תמלולים של ההודעות הקוליות שאתם שולחים בוואטסאפ.",
    link_methods: [
      { label: "Open WhatsApp", label_he: "פתיחת וואטסאפ", url_template: "https://wa.me/972559571223?text=link%20{code}", text_template: "link {code}" },
      { label: "Open Telegram", label_he: "פתיחת טלגרם", url_template: "https://t.me/BenYehudaBot?start=link-{code}", text_template: "/link {code}" },
    ],
  },
});
await comm.call("PUT", "/api/admin/sources/eliezer/icon", { cookie: admin.cookie, raw: readFileSync(path.join(HERE, "eliezer.png")), type: "image/png" });

async function linkedUser(email, name) {
  const user = await createUser(pool, { email, locale: "he" });
  await pool.query("UPDATE users SET name = $2 WHERE sub = $1", [user.sub, name]);
  const minted = await comm.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "eliezer" } });
  await comm.call("POST", "/api/source/v1/links", {
    bearer: created.key,
    origin: null,
    body: { code: minted.json.code, subject: `sample-${email}`, label: "WhatsApp +972…567" },
  });
  return user;
}

// Sample transcripts: invented, the kind of voice messages people send.
const MIN = 60_000;
const now = Date.now();
const SAMPLES = [
  { ago: 3 * MIN, st: "0:42", read: false, body: "היי, רק רציתי לעדכן שהגעתי. הפגישה הייתה מצוינת, הם אהבו את ההצעה ורוצים להתקדם כבר בשבוע הבא. נדבר בערב, יש לי המון לספר לך." },
  { ago: 18 * MIN, st: "0:16", read: false, body: "אני בדרך, אגיע בעוד עשר דקות בערך. תשמרו לי מקום ליד החלון." },
  { ago: 95 * MIN, st: "1:08", read: true, body: "תזכורת לעצמי: לקנות חלב, לחם ועגבניות, להתקשר לשרברב בקשר לברז במטבח, ולא לשכוח את יום ההולדת של סבתא ביום חמישי. אולי להזמין עוגה מהקונדיטוריה ליד הבית." },
  { ago: 26 * 60 * MIN, st: "0:51", read: true, body: "שלום לכולם, מזכירה שארוחת שישי השבוע אצלנו. מי שמביא קינוח שיגיד מראש, כדי שלא יהיו לנו שוב שלוש עוגות שוקולד כמו בפעם שעברה." },
  { ago: 27 * 60 * MIN, st: "0:09", read: true, body: "אליעזר מקושר! מעכשיו התמלולים של ההודעות הקוליות שתשלחו בוואטסאפ יגיעו לכאן." },
];
const sampleMessages = SAMPLES.map((m, i) => ({
  id: `01SAMPLE${String(i).padStart(18, "0")}`,
  created_at: now - m.ago,
  source: "Eliezer",
  source_id: "eliezer",
  title: "",
  subtitle: m.st,
  body: m.body,
  lang: "he",
  read: m.read,
}));

function fakeShell({ popup, files, owner, messages }) {
  window.__status = { available: true, permission: "granted", popup, importance: popup ? 4 : 3 };
  // A registered device that does not need registering again.
  localStorage.setItem("device_id", "1");
  localStorage.setItem("reconciled_at", String(Date.now()));
  localStorage.setItem("notify_banner_dismissed", popup ? String(Date.now()) : "0");
  const listeners = {};
  const on = (prefix) => (event, fn) => {
    (listeners[`${prefix}:${event}`] ||= []).push(fn);
    return Promise.resolve({ remove() {} });
  };
  const ivrit = {
    notificationStatus: async () => window.__status,
    requestPermission: async () => window.__status,
    pushRegistration: async () => ({ token: "sample-token-0123456789abcdef", key: "A".repeat(43) }),
    configure: async () => {},
    takeOpened: async () => ({}),
    sharedFiles: async () => ({ files }),
    shareOn: async () => {},
    discardShared: async () => {},
    openNotificationSettings: async () => {},
    addListener: on("ivrit"),
  };
  const plugins = { IvritNative: ivrit, App: { addListener: on("app") }, Browser: { open: async () => {}, close: async () => {} } };
  // The shape of the bridge Capacitor injects into a remote page: no
  // registerPlugin, only these primitives.
  window.Capacitor = {
    isNativePlatform: () => true,
    nativePromise: (plugin, method, options) =>
      plugins[plugin]?.[method] ? Promise.resolve(plugins[plugin][method](options)) : Promise.reject(new Error(`${plugin}.${method} not implemented`)),
    addListener: (plugin, event, callback) => {
      plugins[plugin].addListener(event, callback);
      return { remove() {} };
    },
  };
  // The device's own copy of earlier messages, as if they had arrived over days.
  if (messages) {
    addEventListener("DOMContentLoaded", async () => {
      await self.NotifierStore.setMeta("owner", owner);
      await self.NotifierStore.put(messages);
      await self.NotifierStore.markRead(messages.filter((m) => m.read).map((m) => m.id));
    }, { once: true });
  }
}

const browser = await chromium.launch({ executablePath: CHROME });
async function screen(name, user, { popup = true, files = [], messages = null, dark = false, act } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 720 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "he-IL",
    colorScheme: dark ? "dark" : "light",
    extraHTTPHeaders: { cookie: `__Host-notifier_sess=${user.cookie}` },
  });
  await ctx.addInitScript(fakeShell, { popup, files, owner: user.sub, messages });
  const page = await ctx.newPage();
  await page.goto(appOrigin + "/");
  await page.waitForTimeout(1500);
  if (messages) {
    await page.reload();
    await page.waitForTimeout(1500);
  }
  if (act) await act(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await ctx.close();
  console.log("captured", name);
}

const dana = await linkedUser("dana@example.com", "דנה כהן");
await screen("inbox", dana, { messages: sampleMessages });
await screen("inbox-dark", dana, { messages: sampleMessages, dark: true });

const fresh = await createUser(pool, { email: "new@example.com", locale: "he" });
await screen("link", fresh, {
  act: async (page) => {
    await page.click('#tabs [data-view="sources"]');
    await page.waitForTimeout(600);
    await page.click("#sources .btn.primary");
    await page.waitForTimeout(1200);
  },
});

await screen("share", dana, {
  messages: sampleMessages,
  files: [{ id: "1759752000000-0", name: "PTT-20261007-WA0012.opus", type: "audio/ogg", size: 184_320 }],
  act: async (page) => {
    await page.click('#tabs [data-view="transcribe"]');
    await page.waitForTimeout(800);
  },
});

await screen("settings", dana, {
  popup: false,
  messages: sampleMessages,
  act: async (page) => {
    await page.click('#tabs [data-view="settings"]');
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const panel = document.querySelector("#permission-help").closest(".panel");
      scrollTo({ top: panel.getBoundingClientRect().top + scrollY - 76 });
    });
    await page.waitForTimeout(300);
  },
});

await browser.close();
web.close();
await comm.stop();
await fcm.close();
await pool.end();
process.exit(0);
