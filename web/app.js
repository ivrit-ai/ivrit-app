import { detectLocale, localized, locale, setLocale, t } from "./i18n.js";
import { ApiError, createCommunicator, pushSupported } from "./client/communicator.js";

const $ = (id) => document.getElementById(id);
const store = self.NotifierStore;
// Notifications, accounts and sources are Communicator's: this app is one of
// its clients, calling its API from this origin (see client/communicator.js).
// Its devices are registered as "app" so Communicator can tell them apart.
// Inside the installed app, the account is the Google account chosen on the
// phone, held as the app's own session (see appToken): every call carries it,
// and no cookie of Communicator's is used. In a browser, Communicator's own
// sign-in stands.
const config = self.IVRIT_CONFIG;
const inShell = Boolean(self.Capacitor?.isNativePlatform?.());
const communicator = createCommunicator({
  base: config.communicator,
  client: "app",
  store,
  token: inShell ? () => appToken() : null,
});

// The native shell (Capacitor) when this page runs inside the installed app,
// null in a browser. Inside the app, notifications come through Firebase and
// native code instead of web push, sign-in is Google's on the phone, and the
// app knows its own notification settings.
//
// The page is loaded from app.ivrit.ai, so it gets only the bridge Capacitor
// injects (no @capacitor/core, and so no registerPlugin): plugin calls go
// through its two primitives, nativePromise and addListener.
const capacitor = self.Capacitor;

function nativePlugin(name) {
  return new Proxy(
    {},
    {
      get: (_, method) =>
        method === "addListener"
          ? (event, callback) => Promise.resolve(capacitor.addListener(name, event, callback))
          : (options = {}) => capacitor.nativePromise(name, method, options),
    }
  );
}

const shell = inShell
  ? { ivrit: nativePlugin("IvritNative"), app: nativePlugin("App"), browser: nativePlugin("Browser") }
  : null;

// A native call that never answers must not hold up the page.
const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
const { api, post, patch, del } = communicator;
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const state = {
  me: null,
  view: "inbox",
  messages: [],
  filter: "all",
  query: "",
  expanded: new Set(),
  catalog: { sources: [], subscriptions: [] },
};

// ---------------------------------------------------------------- helpers

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

let toastTimer;
function toast(message, action) {
  const box = $("toast");
  $("toast-text").textContent = message;
  const button = $("toast-action");
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = () => {
      box.hidden = true;
      action.run();
    };
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), action ? 6000 : 3500);
}

function ask(message, { ok = t("continue"), danger = false } = {}) {
  const dialog = $("confirm");
  $("confirm-text").textContent = message;
  const button = $("confirm-ok");
  button.textContent = ok;
  button.className = `btn ${danger ? "danger" : "primary"}`;
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true })
  );
}

// Stable per-name colour for sources without a logo.
function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function sourceOf(message) {
  return state.catalog.sources.find((s) => s.id === message.source_id) ?? null;
}

function sourceName(message) {
  const source = sourceOf(message);
  return source ? localized(source, "name") : message.source;
}

function avatar({ icon: src, name }, big = false) {
  const cls = `avatar${big ? " big" : ""}`;
  if (src) return el("img", { class: cls, src, alt: "", loading: "lazy" });
  const letter = [...(name || "?").trim()][0]?.toUpperCase() ?? "?";
  return el("span", { class: `${cls} mono`, style: `--hue:${hue(name || "?")}`, text: letter });
}

function messageAvatar(message) {
  // The app's own transcriptions: WhatsApp's mark for a recording shared from
  // WhatsApp, the app's for any other.
  if (isAppMessage(message)) {
    // WhatsApp's official glyph, as issued: on its own, not in the avatar's box.
    return message.source_id === WHATSAPP_SOURCE
      ? el("img", { class: "avatar glyph", src: "/icons/whatsapp-glyph-2026.svg", alt: "WhatsApp", loading: "lazy" })
      : avatar({ icon: "/icons/icon-192.png", name: "ivrit.ai" });
  }
  const source = sourceOf(message);
  return avatar({ icon: source?.icon, name: sourceName(message) });
}

const DAY_MS = 86_400_000;

function formatters() {
  const tag = locale() === "he" ? "he-IL" : undefined;
  return {
    day: new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long" }),
    dayYear: new Intl.DateTimeFormat(tag, { day: "numeric", month: "long", year: "numeric" }),
    clock: new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }),
    date: new Intl.DateTimeFormat(tag, { dateStyle: "medium" }),
  };
}

function dayLabel(ms) {
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (ms >= midnight) return t("today");
  if (ms >= midnight - DAY_MS) return t("yesterday");
  const f = formatters();
  return new Date(ms).getFullYear() === new Date().getFullYear() ? f.day.format(ms) : f.dayYear.format(ms);
}

function relativeTime(ms) {
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 60) return t("justNow");
  if (seconds < 3600) return t("minutesAgo", Math.floor(seconds / 60));
  if (seconds < 6 * 3600) return t("hoursAgo", Math.floor(seconds / 3600));
  return formatters().clock.format(ms);
}

function whenever(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Date.now() - ms < DAY_MS ? relativeTime(ms) : formatters().date.format(ms);
}

// ---------------------------------------------------------------- push

// Where notifications come from: web push in a browser, Firebase in the app.
// The rest of the page asks this, never the browser directly.
let nativeStatus = null;
const notify = shell
  ? {
      supported: () => nativeStatus?.available !== false,
      permission: () => nativeStatus?.permission ?? "default",
      // Only the app can see this: allowed, but its channel was turned down so
      // messages wait silently in the list.
      popupOff: () => nativeStatus?.permission === "granted" && nativeStatus.popup === false,
      async refresh() {
        nativeStatus = await withTimeout(
          shell.ivrit.notificationStatus().catch(() => ({ available: false })),
          3000,
          { available: false }
        );
      },
      async request() {
        nativeStatus = await shell.ivrit.requestPermission();
        return nativeStatus.permission;
      },
      async register() {
        const reg = await shell.ivrit.pushRegistration();
        return communicator.registerNativeDevice({
          transport: "fcm",
          token: reg.token,
          key: reg.key,
          oldToken: reg.previousToken,
          label: "ivrit.ai · Android",
        });
      },
    }
  : {
      supported: pushSupported,
      permission: () => (pushSupported() ? Notification.permission : "unsupported"),
      popupOff: () => false,
      async refresh() {},
      request: () => Notification.requestPermission(),
      register: () => communicator.registerDevice(),
    };

const registerThisDevice = () => notify.register();

// The safety net that works everywhere: Chrome has never shipped
// pushsubscriptionchange, so re-upserting on open keeps endpoints fresh.
async function reconcile() {
  if (!notify.supported() || notify.permission() !== "granted") return;
  const last = Number(localStorage.getItem("reconciled_at") ?? 0);
  if (Date.now() - last < RECONCILE_INTERVAL_MS) return;
  try {
    await registerThisDevice();
    state.pushFailed = false;
  } catch {
    state.pushFailed = true;
  }
  renderNotifyBanner();
}

// Soft prompt, then the real one. Resolves to what happened: "granted" once
// this device is registered, "dismissed" when the user said not now, or the
// trouble that stopped it (see notificationTrouble).
async function enableNotifications() {
  if (!notify.supported()) return troubleWithoutPush();
  if (notify.permission() === "denied") return "denied";
  if (notify.permission() !== "granted") {
    const dialog = $("preprompt");
    dialog.showModal();
    await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
    if (dialog.returnValue !== "yes") return "dismissed";
    // Safari ignores requestPermission outside a user gesture, and a denial is
    // permanent, so this only ever runs from a deliberate click.
    const permission = await notify.request();
    // Still "default" means the browser answered for the user without asking:
    // Chrome's quiet prompt, or a request dismissed too often before. In the
    // app it means the user closed Android's dialog.
    if (permission !== "granted") return permission === "denied" ? "denied" : shell ? "dismissed" : "hidden";
  }
  try {
    await registerThisDevice();
    state.pushFailed = false;
    toast(t("registered"));
    return "granted";
  } catch {
    // Allowed, yet the browser could not subscribe: Brave with Google push
    // messaging off, some private windows, a push service that is down.
    state.pushFailed = true;
    return "failed";
  }
}

// ---------------------------------------------------------------- notification trouble

function platform() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const os = ios ? "ios" : /Android/.test(ua) ? "android" : /Mac OS X/.test(ua) ? "mac" : "desktop";
  const browser = navigator.brave
    ? "brave"
    : /SamsungBrowser/.test(ua)
      ? "samsung"
      : /Edg\//.test(ua)
        ? "edge"
        : /Firefox\/|FxiOS/.test(ua)
          ? "firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "chrome"
            : /Safari\//.test(ua)
              ? "safari"
              : "other";
  return { os, browser };
}

function troubleWithoutPush() {
  if (shell) return "unsupported";
  return platform().os === "ios" && !installed() ? "ios-install" : "unsupported";
}

// Why notifications cannot reach this device, or null when nothing is known to
// be wrong. "default" (never asked) is not trouble: it is a question to ask.
function notificationTrouble() {
  if (!notify.supported()) return troubleWithoutPush();
  if (notify.permission() === "denied") return "denied";
  if (notify.permission() === "granted" && state.pushFailed) return "failed";
  if (notify.popupOff()) return "nopopup";
  return null;
}

function helpSteps(trouble) {
  if (shell) return t(trouble === "nopopup" ? "helpAppPopup" : trouble === "denied" ? "helpAppDenied" : "helpAppFailed");
  const { os, browser } = platform();
  const host = location.host;
  if (trouble === "ios-install") return t("helpIos-install");
  if (trouble === "hidden") return t("helpHidden");
  if (trouble === "failed") return browser === "brave" ? t("helpBrave") : t("helpFailed");
  if (trouble === "unsupported") return t("helpFailed");
  if (os === "ios") return t("helpIos");
  if (os === "android") return browser === "samsung" ? t("helpSamsung", host) : t("helpAndroid", host);
  if (browser === "firefox") return t("helpFirefox", host);
  if (browser === "safari") return t("helpSafari", host);
  if (["chrome", "edge", "brave"].includes(browser)) return t("helpChromium", host);
  return t("helpGeneric");
}

// Steps for this browser and device, and what to do once they are done.
function helpPanel(trouble, { retry, skip } = {}) {
  const actions = [];
  // In the app, the right settings screen is one tap away.
  if (shell && (trouble === "denied" || trouble === "nopopup")) {
    actions.push(
      el("button", { class: "btn primary", type: "button", text: t("openSettings"), onclick: () => shell.ivrit.openNotificationSettings() })
    );
  }
  if (retry && trouble !== "unsupported" && trouble !== "ios-install" && trouble !== "nopopup") {
    actions.push(el("button", { class: "btn primary", type: "button", text: t("helpRetry"), onclick: retry }));
  }
  if (skip) actions.push(el("button", { class: "btn quiet", type: "button", text: t("linkAnyway"), onclick: skip }));
  return el("div", { class: "help" }, [
    el("h3", { text: t(`helpTitle_${trouble}`) }),
    el("p", { class: "muted", text: t(trouble === "nopopup" ? "helpLeadPopup" : "helpLead") }),
    el("ol", {}, helpSteps(trouble).map((step) => el("li", { text: step }))),
    !shell && (trouble === "denied" || trouble === "hidden") ? el("p", { class: "hint", text: t("helpSystem") }) : null,
    actions.length ? el("div", { class: "row" }, actions) : null,
  ]);
}

// "I've allowed them": look again, and carry on if they were.
async function recheckNotifications() {
  await notify.refresh();
  if (notify.supported() && notify.permission() === "default") return enableNotifications();
  const trouble = notificationTrouble();
  if (trouble === "denied") {
    toast(t("stillBlocked"));
    return trouble;
  }
  return enableNotifications();
}

// Permission changes (the user fixing it in site settings) re-render whatever
// is showing, where the browser reports them.
navigator.permissions
  ?.query({ name: "notifications" })
  .then((status) => {
    status.onchange = () => {
      if (!state.me) return;
      renderNotifyBanner();
      if (state.view === "settings") renderPermission();
    };
  })
  .catch(() => {});

function renderNotifyBanner() {
  const box = $("notify-banner");
  const trouble = notificationTrouble();
  const ask = !trouble && notify.supported() && notify.permission() === "default";
  let dismissed = 0;
  try {
    dismissed = Number(localStorage.getItem("notify_banner_dismissed") ?? 0);
  } catch {}
  if ((!trouble && !ask) || Date.now() - dismissed < 7 * DAY_MS) {
    box.hidden = true;
    return;
  }
  box.replaceChildren(
    icon("bell"),
    el("span", { class: "grow", text: ask ? t("bannerAsk") : trouble === "nopopup" ? t("bannerNoPopup") : t("bannerOff") }),
    el("button", {
      class: "btn small primary",
      type: "button",
      text: ask ? t("bannerTurnOn") : t("bannerFix"),
      onclick: async () => {
        if (!ask) return showView("settings");
        await enableNotifications();
        renderNotifyBanner();
      },
    }),
    el("button", {
      class: "icon-btn",
      type: "button",
      "aria-label": t("dismiss"),
      onclick: () => {
        try {
          localStorage.setItem("notify_banner_dismissed", String(Date.now()));
        } catch {}
        box.hidden = true;
      },
    }, [icon("close")])
  );
  box.hidden = false;
}

// ---------------------------------------------------------------- sync

const sync = () => communicator.sync();

async function refreshCatalog() {
  try {
    const catalog = await api("/api/sources");
    // Logos are served by Communicator, as paths on its own origin.
    for (const source of catalog.sources) if (source.icon) source.icon = new URL(source.icon, config.communicator).href;
    state.catalog = catalog;
    await store.setMeta("catalog", state.catalog);
  } catch {
    state.catalog = (await store.getMeta("catalog")) ?? state.catalog;
  }
}

async function loadMessages() {
  state.messages = await store.all();
  const unread = state.messages.filter((m) => !m.read).length;
  $("unread-badge").hidden = !unread;
  $("unread-badge").textContent = unread > 99 ? "99+" : String(unread);
  store.updateBadge().catch(() => {});
}

async function refreshInbox({ fromServer = true } = {}) {
  if (fromServer) {
    try {
      await sync();
    } catch (err) {
      if (err instanceof TypeError) toast(t("offline"));
    }
  }
  await loadMessages();
  if (state.view === "inbox") renderInbox();
}

// ---------------------------------------------------------------- inbox

function filterKey(m) {
  if (isAppMessage(m)) return `s:${APP_SOURCE}`;
  return m.source_id ? `s:${m.source_id}` : `p:${m.source}`;
}

function renderChips() {
  const seen = new Map();
  for (const m of state.messages) if (!seen.has(filterKey(m))) seen.set(filterKey(m), m);
  const box = $("chips");
  if (seen.size < 2) {
    box.replaceChildren();
    state.filter = "all";
    return;
  }
  const chip = (key, label, lead) =>
    el(
      "button",
      {
        class: "chip",
        type: "button",
        role: "tab",
        "aria-selected": String(state.filter === key),
        onclick: () => {
          state.filter = key;
          renderInbox();
        },
      },
      [lead, el("span", { text: label })]
    );
  box.replaceChildren(
    chip("all", t("all")),
    ...[...seen].map(([key, m]) => chip(key, sourceName(m), messageAvatar(m)))
  );
}

function visibleMessages() {
  const q = state.query.trim().toLowerCase();
  return state.messages.filter((m) => {
    if (state.filter !== "all" && filterKey(m) !== state.filter) return false;
    if (!q) return true;
    return [m.title, m.body, m.subtitle, sourceName(m)].some((v) => v?.toLowerCase().includes(q));
  });
}

function messageText(m) {
  return [m.title, m.body].filter(Boolean).join("\n\n");
}

function renderMessage(m, index) {
  const expanded = state.expanded.has(m.id);
  const body = m.body
    ? el("div", {
        class: `msg-body${expanded ? "" : " clamp"}${m.kind === "pending" ? " pending" : ""}`,
        dir: "auto",
        lang: m.lang ?? undefined,
        text: m.body,
        onclick: () => toggle(m),
      })
    : null;
  const more = el("button", { class: "act more", type: "button", hidden: true, text: expanded ? t("showLess") : t("showMore"), onclick: () => toggle(m) });

  const actions = el("div", { class: "msg-actions" }, [
    more,
    el("span", { class: "spacer" }),
    m.url
      ? el("a", { class: "act", href: m.url, target: "_blank", rel: "noopener noreferrer", onclick: () => read([m.id]) }, [icon("external"), el("span", { text: t("openLink") })])
      : null,
    el("button", { class: "act", type: "button", "aria-label": t("copy"), onclick: () => copy(m) }, [icon("copy"), el("span", { text: t("copy") })]),
    navigator.share
      ? el("button", { class: "act", type: "button", "aria-label": t("share"), onclick: () => share(m) }, [icon("share")])
      : null,
    el("button", { class: "act", type: "button", "aria-label": t("delete"), onclick: () => remove(m) }, [icon("trash")]),
  ]);

  const node = el("article", { class: `msg${m.read ? "" : " unread"}`, id: `m-${m.id}`, style: `--i:${Math.min(index, 12)}` }, [
    messageAvatar(m),
    el("div", { class: "msg-main" }, [
      el("div", { class: "msg-head" }, [
        el("span", { class: "msg-source", text: sourceName(m) }),
        m.subtitle ? el("span", { dir: "auto", text: m.subtitle }) : null,
        el("time", { datetime: new Date(m.created_at).toISOString(), title: new Date(m.created_at).toLocaleString(), text: relativeTime(m.created_at) }),
      ]),
      m.title ? el("h3", { class: "msg-title", dir: "auto", text: m.title }) : null,
      body,
      m.partial ? el("div", { class: "partial-note", text: t("loadingFull") }) : null,
      actions,
    ]),
  ]);

  // Only offer "show more" when the clamp actually hid something.
  if (body) {
    requestAnimationFrame(() => {
      more.hidden = !expanded && body.scrollHeight <= body.clientHeight + 2;
    });
  }
  return node;
}

// What the inbox last drew. Loading redraws it several times (the phone's copy,
// then the sources, the server's messages, Eliezer's jobs); an unchanged inbox
// is left alone, so it does not flicker, and cards slide in only the first time.
let drawnInbox = null;

function inboxSignature(list) {
  return JSON.stringify([
    locale(),
    state.filter,
    state.query,
    [...state.expanded],
    state.catalog.sources.map((s) => [s.id, s.icon, s.name, s.name_he]),
    list.map((m) => [m.id, m.read, m.kind, m.title, m.subtitle, m.body, m.partial, m.source_id]),
  ]);
}

function renderInbox() {
  renderChips();
  const feed = $("feed");
  const list = visibleMessages();
  $("mark-all").hidden = !state.messages.some((m) => !m.read);
  const signature = inboxSignature(list);
  // Relative times ("3 min ago") still move on, so a redraw is due at least
  // once a minute even when nothing else changed.
  if (signature === drawnInbox?.signature && Date.now() - drawnInbox.at < 60_000) return;
  if (drawnInbox) feed.classList.add("settled");
  drawnInbox = { signature, at: Date.now() };

  if (!state.messages.length) {
    feed.replaceChildren(
      el("div", { class: "empty" }, [
        el("div", { class: "empty-art" }, [el("span"), el("span")]),
        el("h3", { text: t("emptyTitle") }),
        el("p", { text: t("emptyBody") }),
        el("button", { class: "btn primary", type: "button", onclick: () => showView("sources") }, [icon("sources"), el("span", { text: t("emptyAction") })]),
      ])
    );
    return;
  }
  if (!list.length) {
    feed.replaceChildren(el("p", { class: "empty muted", text: t("noMatches") }));
    return;
  }

  const nodes = [];
  let day = null;
  list.forEach((m, i) => {
    const label = dayLabel(m.created_at);
    if (label !== day) {
      day = label;
      nodes.push(el("div", { class: "day", text: label }));
    }
    nodes.push(renderMessage(m, i));
  });
  feed.replaceChildren(...nodes);
}

async function read(ids) {
  const unread = ids.filter((id) => state.messages.find((m) => m.id === id && !m.read));
  if (!unread.length) return;
  await store.markRead(unread);
  for (const m of state.messages) if (unread.includes(m.id)) m.read = true;
  await loadMessages();
  for (const id of unread) $(`m-${id}`)?.classList.remove("unread");
  $("mark-all").hidden = !state.messages.some((m) => !m.read);
}

function toggle(m) {
  if (state.expanded.has(m.id)) state.expanded.delete(m.id);
  else state.expanded.add(m.id);
  read([m.id]);
  const node = $(`m-${m.id}`);
  node?.replaceWith(renderMessage({ ...m, read: true }, 0));
}

async function copy(m) {
  try {
    await navigator.clipboard.writeText(messageText(m));
    toast(t("copied"));
    read([m.id]);
  } catch (err) {
    toast(t("error", err.message));
  }
}

async function share(m) {
  try {
    await navigator.share({ title: sourceName(m), text: messageText(m) });
    read([m.id]);
  } catch {
    // Dismissing the share sheet is not an error worth reporting.
  }
}

async function remove(m) {
  const node = $(`m-${m.id}`);
  node?.remove();
  await store.remove([m.id]);
  await loadMessages();
  renderInbox();
  toast(t("deleted"), {
    label: t("undo"),
    run: async () => {
      await store.restore(m);
      await loadMessages();
      renderInbox();
    },
  });
}

// #m/<id>: opened from a notification.
async function openFromHash() {
  const match = /^#m\/(.+)$/.exec(location.hash);
  if (!match) return;
  history.replaceState(null, "", location.pathname);
  const id = decodeURIComponent(match[1]);
  showView("inbox");
  if (!state.messages.some((m) => m.id === id)) await refreshInbox();
  state.filter = "all";
  state.query = "";
  $("search").value = "";
  state.expanded.add(id);
  renderInbox();
  read([id]);
  const node = $(`m-${id}`);
  if (node) {
    node.scrollIntoView({ block: "start", behavior: "smooth" });
    node.classList.add("flash");
  }
}

// ---------------------------------------------------------------- sources

function subscriptionsOf(sourceId) {
  return state.catalog.subscriptions.filter((s) => s.source_id === sourceId);
}

function renderSources() {
  const box = $("sources");
  if (!state.catalog.sources.length) {
    box.replaceChildren(el("p", { class: "muted", text: t("noSources") }));
    return;
  }
  box.replaceChildren(
    ...state.catalog.sources.map((source) => {
      const subs = subscriptionsOf(source.id);
      const name = localized(source, "name");
      return el("div", { class: "card source-card" }, [
        el("div", { class: "source-top" }, [
          avatar({ icon: source.icon, name }, true),
          el("div", { class: "grow" }, [
            el("h3", {}, [
              el("span", { text: name }),
              subs.length ? el("span", { class: "tag ok" }, [icon("check"), el("span", { text: t("linked") })]) : null,
            ]),
            el("p", { text: localized(source, "description") }),
          ]),
        ]),
        subs.length
          ? el(
              "div",
              { class: "subs" },
              subs.map((sub) =>
                el("div", { class: "list-row" }, [
                  el("div", { class: "grow" }, [
                    el("div", { dir: "auto", text: sub.label || name }),
                    el("div", { class: "sub", text: sub.last_message_at ? t("lastMessage", whenever(sub.last_message_at)) : t("noMessagesYet") }),
                  ]),
                  el("button", { class: "btn quiet small", type: "button", text: t("unlink"), onclick: () => unlink(source, sub) }),
                ])
              )
            )
          : null,
        el("div", { class: "row" }, [
          el("button", { class: `btn ${subs.length ? "" : "primary"}`, type: "button", onclick: () => openLinkSheet(source) }, [
            icon(subs.length ? "plus" : "sources"),
            el("span", { text: subs.length ? t("linkAnother") : t("link") }),
          ]),
        ]),
      ]);
    })
  );
}

async function unlink(source, sub) {
  if (!(await ask(t("unlinkConfirm", localized(source, "name")), { ok: t("unlink"), danger: true }))) return;
  try {
    await del(`/api/subscriptions/${encodeURIComponent(sub.id)}`);
    toast(t("unlinked"));
    await refreshCatalog();
    renderSources();
  } catch (err) {
    toast(t("error", err.message));
  }
}

// ---------------------------------------------------------------- link sheet

let sheetTimers = [];

function clearSheetTimers() {
  for (const timer of sheetTimers) clearTimeout(timer), clearInterval(timer);
  sheetTimers = [];
}

async function openLinkSheet(source) {
  const dialog = $("sheet");
  const name = localized(source, "name");
  $("sheet-title").textContent = t("sheetTitle", name);
  $("sheet-avatar").replaceChildren(avatar({ icon: source.icon, name }));
  dialog.showModal();
  const trouble = notificationTrouble();
  if (trouble) return renderHelpStep(source, trouble);
  if (notify.supported() && notify.permission() === "default") return renderNotifyStep(source);
  // Allowed, but this device may never have subscribed (or lost it): make
  // sure before the user links, since a link with no device reaches no one.
  if (notify.supported() && !localStorage.getItem("device_id")) {
    const result = await enableNotifications();
    if (result !== "granted") return renderHelpStep(source, result);
  }
  mintCode(source);
}

function closeSheet() {
  clearSheetTimers();
  if ($("sheet").open) $("sheet").close();
}

function renderNotifyStep(source) {
  $("sheet-body").replaceChildren(
    el("p", { class: "step-label", text: t("stepNotify") }),
    el("div", { class: "row" }, [
      el("button", {
        class: "btn primary",
        type: "button",
        onclick: async () => {
          const result = await enableNotifications();
          if (result === "granted" || result === "dismissed") mintCode(source);
          else renderHelpStep(source, result);
        },
      }, [icon("bell"), el("span", { text: t("enableHere") })]),
      el("button", { class: "btn quiet", type: "button", text: t("notNow"), onclick: () => mintCode(source) }),
    ])
  );
}

// Linking still works without notifications (messages wait in the app), so
// the user can always go on; but they should know why nothing will pop up.
function renderHelpStep(source, trouble) {
  $("sheet-body").replaceChildren(
    helpPanel(trouble, {
      retry: async () => {
        const result = await recheckNotifications();
        if (result === "granted") mintCode(source);
        else if (result !== "denied") renderHelpStep(source, result === "dismissed" ? trouble : result);
      },
      skip: () => mintCode(source),
    })
  );
}

async function mintCode(source) {
  clearSheetTimers();
  let link;
  try {
    link = await post("/api/links", { source_id: source.id });
  } catch (err) {
    $("sheet-body").replaceChildren(
      el("p", { class: "step-label", text: err.detail?.error === "too_many_subscriptions" ? t("tooManyLinks") : t("error", err.message) })
    );
    return;
  }
  const name = localized(source, "name");
  const methodLabel = (m) => (locale() === "he" && m.label_he) || m.label;
  const primaryText = link.methods.find((m) => m.text)?.text;
  const countdown = el("small");
  const status = el("div", { class: "status" }, [el("span", { class: "pulse" }), el("div", {}, [el("span", { text: t("waiting") }), countdown])]);

  $("sheet-body").replaceChildren(
    el("p", { class: "step-label", text: `${t("stepSend")} ${name}:` }),
    el("div", { class: "code-box" }, [
      el("span", { class: "code", text: link.code }),
      el("button", {
        class: "icon-btn",
        type: "button",
        "aria-label": t("copy"),
        onclick: async () => {
          await navigator.clipboard.writeText(link.code).catch(() => {});
          toast(t("copied"));
        },
      }, [icon("copy")]),
    ]),
    el(
      "div",
      { class: "methods" },
      link.methods
        .filter((m) => m.url)
        .map((m, i) =>
          el("a", { class: `btn ${i === 0 ? "primary" : ""}`, href: m.url, target: "_blank", rel: "noopener" }, [
            el("span", { text: methodLabel(m) }),
            icon("chevron"),
          ])
        )
    ),
    primaryText
      ? el("div", {}, [
          el("p", { class: "hint", text: t("orSendText") }),
          el("div", { class: "literal" }, [
            el("span", { text: primaryText }),
            el("button", {
              class: "icon-btn",
              type: "button",
              "aria-label": t("copy"),
              onclick: async () => {
                await navigator.clipboard.writeText(primaryText).catch(() => {});
                toast(t("copied"));
              },
            }, [icon("copy")]),
          ]),
        ])
      : null,
    status
  );

  const expires = Date.parse(link.expires_at);
  const tick = () => {
    const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
    countdown.textContent = t("expiresIn", `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`);
  };
  tick();
  sheetTimers.push(setInterval(tick, 1000));

  const poll = async () => {
    if (!$("sheet").open) return;
    let result = null;
    if (document.visibilityState === "visible") result = await api(`/api/links/${link.link_id}`).catch(() => null);
    if (result?.state === "linked") return renderLinked(source, result.subscription);
    if (result && result.state !== "pending") return renderExpired(source, result.state);
    sheetTimers.push(setTimeout(poll, 2000));
  };
  sheetTimers.push(setTimeout(poll, 2000));
}

async function renderLinked(source, subscription) {
  clearSheetTimers();
  $("sheet-body").replaceChildren(
    el("div", { class: "success" }, [
      el("div", { class: "tick" }, [icon("check")]),
      el("h3", { dir: "auto", text: t("linkedAs", subscription?.label) }),
      el("p", { text: t("linkedBody") }),
      el("button", { class: "btn primary", type: "button", text: t("done"), onclick: closeSheet }),
    ])
  );
  await refreshCatalog();
  renderSources();
  // The source's welcome message is on its way; pick it up.
  setTimeout(() => refreshInbox(), 2500);
}

function renderExpired(source, state_) {
  clearSheetTimers();
  $("sheet-body").replaceChildren(
    el("p", { class: "step-label", text: state_ === "expired_attempt" ? t("codeTriedExpired") : t("codeExpired") }),
    el("button", { class: "btn primary", type: "button", text: t("newCode"), onclick: () => mintCode(source) })
  );
}

// ---------------------------------------------------------------- settings

function renderAccount() {
  const me = state.me;
  const box = $("account");
  if (me.kind === "anonymous") {
    box.className = "panel warn";
    box.replaceChildren(
      el("h3", { text: t("anonymousTitle") }),
      el("p", { class: "muted", text: t("anonymousBody") }),
      signInLink(el("a", { class: "btn primary" }, el("span", { text: t("upgrade") })))
    );
    return;
  }
  box.className = "panel";
  box.replaceChildren(
    el("div", { class: "account-head" }, [
      avatar({ name: me.name || me.email }, true),
      el("div", {}, [el("h3", { text: me.name || t("accountTitle") }), el("p", { text: t("signedInAs", me.email) })]),
    ])
  );
}

function renderLocaleSwitches() {
  for (const button of document.querySelectorAll("[data-locale]")) {
    button.setAttribute("aria-pressed", String(button.dataset.locale === locale()));
  }
}

async function changeLocale(next) {
  if (next === locale()) return;
  setLocale(next);
  renderLocaleSwitches();
  await store.setMeta("locale", next).catch(() => {});
  configureShell();
  if (state.me) patch("/api/me", { locale: next }).catch(() => {});
  rerender();
}

function renderPermission() {
  const permission = notify.supported() ? notify.permission() : "unsupported";
  const trouble = notificationTrouble();
  const copy = { unsupported: "permUnsupported", default: "permDefault", granted: "permGranted", denied: "permDenied" };
  $("permission").textContent = t(copy[permission]);
  $("permission").hidden = Boolean(trouble);
  $("permission-help").replaceChildren(
    trouble
      ? helpPanel(trouble, {
          retry: async () => {
            await recheckNotifications();
            renderPermission();
            renderNotifyBanner();
            renderDevices().catch(() => {});
          },
        })
      : ""
  );
  $("enable").hidden = permission !== "default";
  $("test").hidden = permission !== "granted" || Boolean(trouble);
}

async function renderDevices() {
  const { devices } = await api("/api/devices");
  const mine = localStorage.getItem("device_id");
  const list = $("devices");
  if (!devices.length) {
    list.replaceChildren(el("p", { class: "muted", text: t("noDevices") }));
    return;
  }
  const f = formatters();
  list.replaceChildren(
    ...devices.map((device) =>
      el("div", { class: "list-row" }, [
        el("div", { class: "grow" }, [
          el("div", {}, [
            el("span", { text: device.label ?? "—" }),
            String(device.id) === mine ? el("span", { class: "tag accent", style: "margin-inline-start:8px", text: t("thisDevice") }) : null,
          ]),
          el("div", { class: "sub", text: t("added", f.date.format(Date.parse(device.created_at))) }),
        ]),
        el("button", {
          class: "btn quiet small",
          type: "button",
          text: t("remove"),
          onclick: async () => {
            await del(`/api/devices/${device.id}`);
            if (String(device.id) === mine) localStorage.removeItem("device_id");
            await renderDevices();
          },
        }),
      ])
    )
  );
}

async function renderStorage() {
  $("storage").textContent = t("storageBody", await store.count());
}

async function renderDiagnostics() {
  if (shell) {
    await notify.refresh();
    const rows = [
      [t("permission"), notify.permission()],
      [t("popupSetting"), nativeStatus?.popup ? t("yes") : t("no")],
      [t("pushService"), notify.supported() ? "Firebase" : t("notSubscribed")],
    ];
    $("diagnostics").replaceChildren(...rows.flatMap(([term, value]) => [el("dt", { text: term }), el("dd", { text: value })]));
    return;
  }
  const rows = [
    [t("permission"), pushSupported() ? Notification.permission : "unsupported"],
    [t("installed"), installed() ? t("yes") : t("noTab")],
    [t("serviceWorker"), "serviceWorker" in navigator ? "supported" : "missing"],
  ];
  if (pushSupported()) {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    rows.push([t("pushService"), sub ? new URL(sub.endpoint).host : t("notSubscribed")]);
  }
  $("diagnostics").replaceChildren(...rows.flatMap(([term, value]) => [el("dt", { text: term }), el("dd", { text: value })]));
}

// Signing out must also stop this device receiving the account's pushes, and
// must not leave the account's messages behind for the next person.
async function forgetThisDevice() {
  await communicator.forgetDevice();
  await store.clear();
  await store.updateBadge().catch(() => {});
}

// ---------------------------------------------------------------- transcribe

// Files shared into the app (a WhatsApp voice note, a recording) wait in this
// cache, put there by the service worker, until sent on or discarded. They go
// to transcribe.ivrit.ai through its own share target: a top-level form post,
// which its service worker receives exactly as if the file had been shared to
// it directly.
const SHARE_CACHE = "share-inbox";

// In the app, Android hands the files to native code, which keeps them; they
// go on through Android's share menu, since transcribe.ivrit.ai (with its own
// Google sign-in) cannot run inside the app.
async function sharedFiles() {
  if (shell) {
    const { files } = await shell.ivrit.sharedFiles();
    return files.map((f) => ({
      key: f.id,
      name: f.name || t("sharedUnnamed"),
      type: f.type,
      size: f.size,
      durationMs: f.durationMs,
      origin: f.origin || "",
      uploadId: f.uploadId || "",
    }));
  }
  const cache = await caches.open(SHARE_CACHE);
  const files = [];
  for (const request of await cache.keys()) {
    const res = await cache.match(request);
    const name = decodeURIComponent(res.headers.get("x-name") || "") || t("sharedUnnamed");
    const blob = await res.blob();
    files.push({ key: request.url, name, type: res.headers.get("content-type") || "", blob, size: blob.size });
  }
  return files;
}

async function discardShared(key) {
  if (shell) return shell.ivrit.discardShared({ id: key });
  await (await caches.open(SHARE_CACHE)).delete(key);
}

function formatSize(bytes) {
  const mb = bytes / 1_048_576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function sendToTranscribe(file) {
  if (shell) return shell.ivrit.shareOn({ id: file.key, title: t("sharedChooser") });
  const input = el("input", { type: "file", name: "media" });
  const transfer = new DataTransfer();
  transfer.items.add(new File([file.blob], file.name, { type: file.type }));
  input.files = transfer.files;
  const form = el("form", { method: "POST", action: `${config.transcribe}/share-target`, enctype: "multipart/form-data", hidden: true }, [input]);
  document.body.append(form);
  // The file is in memory now; the page is about to navigate away.
  await discardShared(file.key);
  form.submit();
}

// ---------------------------------------------------------------- transcribe here, by Eliezer

// A clip shared into the app that Eliezer takes (up to 10 minutes, 20 MB) goes
// straight to Eliezer, under the Google account chosen on the phone: the app
// sends Google's ID token, which Eliezer checks with Google, and nothing else
// is involved. The result is fetched back and kept here as a message from the
// app itself (APP_SOURCE), with the app's mark.
const APP_SOURCE = "ivrit-app";
// The same, for a recording shared from WhatsApp (shown with WhatsApp's mark instead).
const WHATSAPP_SOURCE = "ivrit-app:whatsapp";
function isAppMessage(m) {
  return m.source_id === APP_SOURCE || m.source_id === WHATSAPP_SOURCE;
}
const ELIEZER_MAX_SECONDS = 600;
const ELIEZER_MAX_BYTES = 20 * 1024 * 1024;
const POLL_MS = 3000;

const eliezerReady = () => Boolean(shell && config.eliezer && config.googleClientId);
const fitsEliezer = (file) =>
  eliezerReady() && file.durationMs > 0 && file.durationMs <= ELIEZER_MAX_SECONDS * 1000 && file.size <= ELIEZER_MAX_BYTES;

// Signing in is Google's, once: the Google ID token from the phone's account
// sheet is exchanged with this site's server for the app's own session (see
// session.js there), which names the same Google account and lasts months.
// It is renewed at most once a day while the app is used, so an active user
// stays signed in, as in Gmail. Eliezer and Communicator accept it.
const SESSION_KEY = "app_session";

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function writeSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}

let renewing = null;

async function appToken() {
  const session = readSession();
  if (!session?.token || session.expires_at < Date.now() + 60_000) return null;
  if (Date.now() - (session.renewed_at ?? 0) > DAY_MS && !renewing) {
    renewing = fetch("/auth/renew", { method: "POST", headers: { authorization: `Bearer ${session.token}` } })
      .then(async (res) => {
        if (res.ok) writeSession({ ...(await res.json()), renewed_at: Date.now() });
        else if (res.status === 401) writeSession(null);
      })
      .catch(() => {})
      .finally(() => (renewing = null));
  }
  return session.token;
}

async function signInWithGoogle() {
  let idToken;
  try {
    ({ idToken } = await shell.ivrit.googleIdToken({ clientId: config.googleClientId, interactive: true }));
  } catch (err) {
    if (err?.code !== "cancelled") toast(t("googleFailed"));
    return;
  }
  const res = await fetch("/auth/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  }).catch(() => null);
  if (!res?.ok) return toast(t(res ? "googleFailed" : "offline"));
  writeSession({ ...(await res.json()), renewed_at: Date.now() });
  location.replace("/");
}

async function eliezer(path) {
  const token = await appToken();
  if (!token) throw new ApiError(401, { error: "signed_out" });
  const res = await fetch(`${config.eliezer}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  return res.json();
}

function clock(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const untitled = (name) => name?.replace(/\.[a-z0-9]{1,5}$/i, "") || null;
const appSource = (origin) => (origin === "whatsapp" ? WHATSAPP_SOURCE : APP_SOURCE);

// A job at Eliezer, as a message in the inbox: waiting, its transcript, or why
// there is none. Keyed by the app's upload id, which exists before the job
// does (see send()); jobs from before upload ids, by their own.
function jobMessage(job) {
  const failed = job.status === "failed";
  return {
    id: `app-${job.upload_id || job.job_id}`,
    created_at: Math.round(job.created_at * 1000),
    source: "ivrit.ai",
    source_id: appSource(job.origin),
    title: untitled(job.filename),
    subtitle: job.duration ? clock(job.duration) : null,
    body: job.status === "done" ? job.text : failed ? t(`appError_${job.error}`, job.wait_minutes) : t("transcribingNow"),
    kind: job.status === "queued" ? "pending" : failed ? "notice" : "transcript",
    lang: job.status === "done" ? "he" : null,
  };
}

// Uploads handed to the background, by upload id, until Eliezer has their
// result: { origin, title, duration, created }.
async function uploads() {
  return (await store.getMeta("app_uploads").catch(() => null)) ?? {};
}

async function setUploads(list) {
  await store.setMeta("app_uploads", list);
}

async function failUpload(uploadId, error) {
  const list = await uploads();
  const upload = list[uploadId];
  delete list[uploadId];
  await setUploads(list);
  if (!upload) return;
  await store.put([
    {
      id: `app-${uploadId}`,
      created_at: upload.created,
      source: "ivrit.ai",
      source_id: appSource(upload.origin),
      title: upload.title,
      subtitle: upload.duration ? clock(upload.duration) : null,
      body: t(`appError_${error}`),
      kind: "notice",
    },
  ]);
}

// One shared file into the background: the native side uploads it to Eliezer
// (retrying until it gets through, even with the app closed), waits for the
// transcript and notifies; the inbox shows it waiting meanwhile. A file handed
// over before keeps its upload id, so sending it again is the same upload.
async function send(file) {
  const token = await appToken();
  if (!token) {
    toast(t("googleFailed"));
    return false;
  }
  const uploadId = file.uploadId || crypto.randomUUID();
  if (!file.uploadId) {
    const upload = { origin: file.origin, title: untitled(file.name), duration: file.durationMs / 1000, created: Date.now() };
    await setUploads({ ...(await uploads()), [uploadId]: upload });
    await store.put([jobMessage({ upload_id: uploadId, status: "queued", filename: file.name, created_at: upload.created / 1000, duration: upload.duration, origin: file.origin })]);
  }
  try {
    await shell.ivrit.enqueueTranscription({ id: file.key, base: config.eliezer, token, uploadId, origin: file.origin, title: untitled(file.name) ?? "" });
    return true;
  } catch (err) {
    // An older build of the app, without background transcription.
    toast(err?.code === "UNIMPLEMENTED" || /not implemented/i.test(err?.message ?? "") ? t("updateApp") : t("error", "enqueue"));
    return false;
  }
}

// Following them: Eliezer's list of this account's jobs, which also brings back
// any the app lost track of (its data cleared, say). Messages deleted here stay
// deleted. True while any is still on its way.
async function syncJobs() {
  const { jobs } = await eliezer("/app/v1/jobs");
  await store.put(jobs.map(jobMessage));
  const list = await uploads();
  for (const [id, upload] of Object.entries(list)) {
    const job = jobs.find((j) => j.upload_id === id);
    if (job && job.status !== "queued") delete list[id];
    // Never arrived in a day: lost (the file gone, the account changed).
    else if (!job && Date.now() - upload.created > DAY_MS) {
      await failUpload(id, "expired");
      delete list[id];
    }
  }
  await setUploads(list);
  return Object.keys(list).length > 0 || jobs.some((j) => j.status === "queued");
}

// While the app is open, a few seconds apart as long as something is on its way.
let polling = null;

async function pollJobs() {
  polling = null;
  if (document.visibilityState !== "visible" || !state.me || state.me.offline) return;
  let more = false;
  try {
    more = await syncJobs();
  } catch {
    more = Object.keys(await uploads()).length > 0;
  }
  await loadMessages();
  if (state.view === "inbox") renderInbox();
  if (more) polling = setTimeout(pollJobs, POLL_MS);
}

function watchJobs() {
  if (!polling && eliezerReady()) polling = setTimeout(pollJobs, 0);
}

// A recording Eliezer does not take (over 10 minutes or 20 MB, or no readable
// length) is not supported in the app for now: it is answered at once, in the
// inbox, and let go.
async function refuseShared(file) {
  const reason = file.durationMs > ELIEZER_MAX_SECONDS * 1000 ? "appError_too_long" : file.size > ELIEZER_MAX_BYTES ? "appError_too_large" : "appError_unsupported";
  await store.put([
    {
      id: `app-local-${file.key}`,
      created_at: Date.now(),
      source: "ivrit.ai",
      source_id: appSource(file.origin),
      title: untitled(file.name),
      subtitle: file.durationMs > 0 ? clock(file.durationMs / 1000) : null,
      body: t(reason),
      kind: "notice",
    },
  ]);
  await discardShared(file.key);
}

// What was shared into the app: whatever Eliezer takes goes to it at once,
// without asking, and appears in the inbox as it is transcribed; anything else
// is answered there as not supported. Files handed over earlier and still here
// (their upload needed a fresh sign-in) are handed over again.
async function takeShared() {
  if (!state.me || state.me.offline) return;
  const files = await sharedFiles().catch(() => []);
  if (!files.length) return;
  let sent = 0;
  for (const file of files) {
    if (!fitsEliezer(file)) await refuseShared(file);
    else if ((await send(file)) && !file.uploadId) sent++;
  }
  await loadMessages();
  if (sent) toast(t("transcribing"));
  showView("inbox");
  watchJobs();
}

async function renderTranscribe() {
  $("transcribe-open").href = `${config.transcribe}/`;
  const box = $("shared");
  // In the app, shared files go straight on (takeShared); nothing waits here.
  if (shell) {
    box.hidden = true;
    return;
  }
  const files = await sharedFiles().catch(() => []);
  box.hidden = !files.length;
  if (!files.length) return box.replaceChildren();
  box.replaceChildren(
    el("h3", { text: t("sharedTitle") }),
    el("p", { class: "muted", text: t(eliezerReady() ? "sharedLedeEliezer" : shell ? "sharedLedeApp" : "sharedLede") }),
    el(
      "div",
      { class: "list" },
      files.map((file) =>
        el("div", { class: "list-row" }, [
          el("div", { class: "grow" }, [
            el("div", { dir: "auto", text: file.name }),
            el("div", { class: "sub" }, [
              el("bdi", { dir: "ltr", text: [file.durationMs > 0 ? clock(file.durationMs / 1000) : null, formatSize(file.size)].filter(Boolean).join(" · ") }),
            ]),
          ]),
          el("button", { class: "btn primary small", type: "button", text: t("sharedSend"), onclick: () => sendToTranscribe(file) }),
          el("button", {
            class: "icon-btn",
            type: "button",
            "aria-label": t("delete"),
            onclick: async () => {
              await discardShared(file.key);
              renderTranscribe();
            },
          }, [icon("trash")]),
        ])
      )
    )
  );
}

// ---------------------------------------------------------------- views

const VIEWS = ["inbox", "transcribe", "sources", "settings"];

function showView(name) {
  if (!VIEWS.includes(name)) name = "inbox";
  state.view = name;
  for (const button of document.querySelectorAll("#tabs button")) {
    button.classList.toggle("active", button.dataset.view === name);
    if (button.dataset.view === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  window.scrollTo({ top: 0 });
  rerender();
}

function rerender() {
  if (!state.me) return;
  if (state.view === "inbox") renderInbox();
  if (state.view === "transcribe") renderTranscribe();
  if (state.view === "sources") {
    renderSources();
    refreshCatalog().then(renderSources);
  }
  if (state.view === "settings") {
    renderAccount();
    renderLocaleSwitches();
    renderPermission();
    renderDevices().catch(() => {});
    renderStorage();
    renderDiagnostics();
  }
}

// ---------------------------------------------------------------- wiring

for (const button of document.querySelectorAll("#tabs button")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}

for (const button of document.querySelectorAll("[data-locale]")) {
  button.addEventListener("click", () => changeLocale(button.dataset.locale));
}

$("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderInbox();
});

$("mark-all").addEventListener("click", () => read(state.messages.filter((m) => !m.read).map((m) => m.id)));

$("enable").addEventListener("click", async () => {
  await enableNotifications();
  renderPermission();
  renderNotifyBanner();
  renderDevices().catch(() => {});
  renderDiagnostics();
});

// The pop-up test. A notification arrives while the app is closed, and the
// user says what they saw: whether it popped up is the phone's per-app setting,
// which no web page can read or change, so the fix is to show them where it is.
const TEST_DELAY_SECONDS = 10;
let popupTestTimer = null;
let popupAskTimer = null;

function popupKind() {
  const { os } = platform();
  return os === "ios" ? "Ios" : os === "android" ? "Android" : "Desktop";
}

function stepsPanel(title, lead, steps, again) {
  return el("div", { class: "help" }, [
    el("h3", { text: title }),
    el("p", { class: "muted", text: lead }),
    el("ol", {}, steps.map((step) => el("li", { text: step }))),
    el("div", { class: "row" }, [el("button", { class: "btn", type: "button", text: t("testAgain"), onclick: again })]),
  ]);
}

function showPopupTest(...children) {
  const box = $("popup-test");
  box.replaceChildren(...children);
  box.hidden = !children.length;
}

function askPopupResult() {
  const answer = (kind) => () => {
    if (kind === "popped") {
      showPopupTest();
      return toast(t("testAllGood"));
    }
    if (kind === "list") {
      if (shell) return showPopupTest(helpPanel("nopopup"));
      return showPopupTest(stepsPanel(t("popupHelpTitle"), t("popupHelpLead"), t(`popup${popupKind()}`), runPopupTest));
    }
    // Nothing at all: a block we can see explains it first; otherwise it is the device.
    const trouble = notificationTrouble();
    if (trouble) return showPopupTest(helpPanel(trouble, { retry: runPopupTest }));
    showPopupTest(stepsPanel(t("nothingHelpTitle"), t("nothingHelpLead"), t(`nothing${popupKind()}`), runPopupTest));
  };
  showPopupTest(
    el("p", { class: "step-label", text: t("testAsk") }),
    el("div", { class: "stack" }, [
      el("button", { class: "btn", type: "button", text: t("testPopped"), onclick: answer("popped") }),
      el("button", { class: "btn", type: "button", text: t("testListOnly"), onclick: answer("list") }),
      el("button", { class: "btn", type: "button", text: t("testNothing"), onclick: answer("nothing") }),
    ])
  );
}

async function runPopupTest() {
  clearInterval(popupTestTimer);
  clearTimeout(popupAskTimer);
  let sent;
  try {
    sent = await post("/api/test", { delay_seconds: TEST_DELAY_SECONDS });
  } catch (err) {
    return toast(t("error", err.message));
  }
  if (!sent.devices) return toast(t("testSent", 0));
  // Counted against the clock, not ticks: timers sleep while the app is in the
  // background, which is exactly where the user is meant to be.
  const due = Date.now() + sent.delay_seconds * 1000;
  const count = el("b", { class: "countdown" });
  const tick = () => {
    const left = Math.ceil((due - Date.now()) / 1000);
    if (left > 0) return void (count.textContent = `0:${String(left).padStart(2, "0")}`);
    clearInterval(popupTestTimer);
    // A few seconds' grace for delivery before asking.
    popupAskTimer = setTimeout(askPopupResult, Math.max(0, due + 4000 - Date.now()));
  };
  showPopupTest(
    el("p", { class: "step-label" }, [`${t("testLeave")} `, count, ". ", t("testWatch")]),
    el("button", {
      class: "btn quiet small",
      type: "button",
      text: t("testCancel"),
      onclick: () => {
        clearInterval(popupTestTimer);
        clearTimeout(popupAskTimer);
        showPopupTest();
      },
    })
  );
  tick();
  popupTestTimer = setInterval(tick, 500);
}

$("test").addEventListener("click", runPopupTest);

$("clear-history").addEventListener("click", async () => {
  if (!(await ask(t("clearConfirm"), { ok: t("delete"), danger: true }))) return;
  const ids = (await store.all()).map((m) => m.id);
  await store.remove(ids);
  await loadMessages();
  renderStorage();
  toast(t("cleared"));
});

$("signout").addEventListener("click", async () => {
  const anonymous = state.me.kind === "anonymous";
  if (!(await ask(anonymous ? t("signOutAnonConfirm") : t("signOutConfirm"), { ok: t("signOut"), danger: anonymous }))) return;
  await forgetThisDevice();
  if (shell) return leaveApp();
  // An anonymous account is unreachable once signed out, so it is deleted
  // rather than left behind.
  if (anonymous) await del("/api/me").catch(() => {});
  else await post("/api/logout").catch(() => {});
  location.replace("/");
});

$("delete-account").addEventListener("click", async () => {
  if (!(await ask(t("deleteConfirm"), { ok: t("deleteAccount"), danger: true }))) return;
  await forgetThisDevice();
  await del("/api/me").catch(() => {});
  if (shell) return leaveApp();
  location.replace("/");
});

$("anon").addEventListener("click", async () => {
  $("anon").disabled = true;
  try {
    await post("/auth/anonymous", { locale: locale() });
    await start();
  } catch (err) {
    toast(t("error", err.message));
    $("anon").disabled = false;
  }
});

$("sheet-close").addEventListener("click", closeSheet);
$("sheet").addEventListener("close", clearSheetTimers);
$("sheet").addEventListener("click", (event) => {
  // A tap on the backdrop closes the sheet, as on every phone.
  if (event.target === $("sheet")) closeSheet();
});

addEventListener("scroll", () => document.querySelector(".bar").classList.toggle("scrolled", scrollY > 4), { passive: true });

// In the app: a message arrived (natively, so only the server has it until
// synced), a notification was tapped, files were shared in, or Firebase
// replaced the device's token.
if (shell) {
  shell.ivrit.addListener("push", () => state.me && refreshInbox());
  shell.ivrit.addListener("opened", ({ id }) => {
    if (state.me && id) location.hash = `#m/${encodeURIComponent(id)}`;
  });
  shell.ivrit.addListener("shared", () => {
    if (state.me) takeShared();
    else showSharedSignedOut();
  });
  // From the background transcription: refused for good, or on its way / done
  // (then the next look at Eliezer's jobs shows it).
  shell.ivrit.addListener("transcription", async ({ uploadId, state: progress, error }) => {
    if (progress === "failed" && ["too_large", "unsupported"].includes(error)) await failUpload(uploadId, error);
    await loadMessages();
    if (state.view === "inbox") renderInbox();
    watchJobs();
  });
  shell.ivrit.addListener("pushToken", () => {
    localStorage.removeItem("reconciled_at");
    if (state.me) reconcile();
  });
}

// A push that arrives while the app is open lands in the store via the
// service worker; this only has to show it.
navigator.serviceWorker?.addEventListener("message", (event) => {
  if (!state.me) return;
  if (event.data?.type === "push") refreshInbox({ fromServer: false });
  if (event.data?.type === "open") {
    location.hash = `#m/${encodeURIComponent(event.data.id)}`;
  }
});

addEventListener("hashchange", openFromHash);

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !state.me) return;
  // Back from Android's settings, perhaps having changed exactly this.
  if (shell) {
    await notify.refresh();
    renderNotifyBanner();
    if (state.view === "settings") renderPermission();
    watchJobs();
  }
  reconcile();
  refreshInbox();
});

function installed() {
  return Boolean(shell) || navigator.standalone || matchMedia("(display-mode: standalone)").matches;
}

function showIosHint() {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $("ios-hint").hidden = !isIos || installed();
}

// Chrome and friends fire this instead of offering an install affordance of
// their own, and the event is only honoured if replayed from a real gesture —
// so it has to be captured here and spent inside the click handler.
let installPrompt = null;

addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("install-hint").hidden = installed();
});

addEventListener("appinstalled", () => {
  installPrompt = null;
  $("install-hint").hidden = true;
});

$("install").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  // Single use: a spent event cannot be replayed.
  installPrompt = null;
  $("install-hint").hidden = true;
  if (outcome === "dismissed") toast(t("installLater"));
});

// A different account on this browser must never see the previous one's
// messages.
async function claimStore(sub) {
  const owner = await store.getMeta("owner");
  if (owner && owner !== sub) await store.clear();
  if (owner !== sub) await store.setMeta("owner", sub);
}

function showSharedSignedOut() {
  document.body.dataset.started = "1";
  history.replaceState(null, "", location.pathname);
  $("view-transcribe").hidden = false;
  $("transcribe-back").hidden = false;
  renderTranscribe();
}

$("transcribe-back").addEventListener("click", () => {
  $("view-transcribe").hidden = true;
  $("transcribe-back").hidden = true;
  $("landing").hidden = false;
});

function signInLink(node) {
  if (!shell) {
    node.href = communicator.loginUrl(`${location.origin}/`);
    return node;
  }
  node.href = "#";
  node.addEventListener("click", (event) => {
    event.preventDefault();
    signInWithGoogle();
  });
  return node;
}

// Signing out of the app forgets the Google account chosen on the phone; there
// is no session of Communicator's to end.
async function leaveApp() {
  writeSession(null);
  await shell.ivrit.forgetGoogle().catch(() => {});
  location.replace("/");
}

// What a notification needs to show while the app is closed.
function configureShell() {
  shell?.ivrit
    .configure({
      locale: locale(),
      communicator: config.communicator,
      sources: state.catalog.sources.map(({ id, name, name_he }) => ({ id, name, name_he: name_he ?? null })),
    })
    .catch(() => {});
}

async function start() {
  signInLink($("signin"));
  await notify.refresh();
  setLocale(detectLocale());
  renderLocaleSwitches();
  showIosHint();
  if (shell) {
    // A Google account is the only way in: no account-less use in the app.
    $("anon").hidden = true;
    document.querySelector('[data-i18n="anonCaveat"]').hidden = true;
    // Signed in is having a session: no call to Google, no account sheet.
    if (!(await appToken())) {
      if (location.hash === "#shared") return showSharedSignedOut();
      $("landing").hidden = false;
      document.body.dataset.started = "1";
      return;
    }
  }
  try {
    state.me = await api("/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // A session no longer accepted (say, a new signing key): sign in again.
      if (shell) writeSession(null);
      if (location.hash === "#shared") return showSharedSignedOut();
      $("landing").hidden = false;
      document.body.dataset.started = "1";
      return;
    }
    // Offline with a session we cannot check: show what is on the device.
    const owner = await store.getMeta("owner").catch(() => null);
    if (!owner) {
      $("landing").hidden = false;
      document.body.dataset.started = "1";
      return;
    }
    state.me = { sub: owner, kind: "unknown", offline: true };
    toast(t("offline"));
  }

  setLocale(detectLocale(state.me.locale));
  renderLocaleSwitches();
  await store.setMeta("locale", locale()).catch(() => {});
  await claimStore(state.me.sub);
  store.pruneTombstones().catch(() => {});
  navigator.storage?.persist?.().catch(() => {});

  document.body.classList.add("app");
  document.body.dataset.started = "1";
  $("landing").hidden = true;
  $("tabs").hidden = false;

  state.catalog = (await store.getMeta("catalog")) ?? state.catalog;
  await loadMessages();
  showView("inbox");
  renderNotifyBanner();

  if (location.hash === "#upgraded") {
    history.replaceState(null, "", location.pathname);
    toast(t("upgraded"));
  }
  if (state.me.offline) return;

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  await refreshCatalog();
  configureShell();
  await refreshInbox();
  const opened = await shell?.ivrit.takeOpened().catch(() => null);
  if (opened?.id) history.replaceState(null, "", `/#m/${encodeURIComponent(opened.id)}`);
  await openFromHash();
  if (shell) await takeShared();
  watchJobs();
  if (location.hash === "#shared") {
    history.replaceState(null, "", location.pathname);
    showView("transcribe");
  }
  reconcile();
}

start();
