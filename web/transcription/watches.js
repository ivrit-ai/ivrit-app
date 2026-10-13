// Watched folders, in Settings (Android): folders on the phone whose new recordings
// are transcribed by themselves, each into a My files folder. The phone does the
// watching and uploading (FolderWatchWorker, WatchUploadWorker); this is where they
// are added, shown, paused and removed. Only shown when the shell has the feature
// ("watchFolders" in notificationStatus().features).

import * as api from "./api.js";
import { serverError, setLanguage, tr } from "./strings.js";

const LANGUAGES = { he: "עברית", en: "English", yi: "ייִדיש", fr: "Français", es: "Español", de: "Deutsch", zh: "中文" };
const DISCLOSED = "watchDisclosed";

let host = null;
let native = null;
let box = null;
let tree = null;

/** Renders into box; native is the shell's plugin. */
export async function render(container, hostApi, nativePlugin) {
  host = hostApi;
  native = nativePlugin;
  box = container;
  setLanguage(host.locale());
  await draw();
}

// A watch's state changed (the phone checked, sent, hit an error).
export function changed() {
  if (box?.isConnected) draw();
}

async function draw() {
  const { el, icon } = host;
  const { watches = [] } = await native.watches().catch(() => ({}));
  box.replaceChildren(
    el("p", { class: "muted", text: tr("watchIntro") }),
    watches.length ? el("div", { class: "list" }, watches.map(row)) : null,
    el("div", { class: "row" }, [
      el("button", { class: "btn small", type: "button", onclick: () => addSheet() }, [icon("plus"), el("span", { text: tr("watchAdd") })]),
    ])
  );
}

function ago(ms) {
  if (!ms) return "";
  const minutes = Math.round((Date.now() - ms) / 60000);
  return minutes < 1 ? tr("watchJustNow") : minutes < 60 ? tr("watchMinutesAgo", { n: minutes }) : tr("watchHoursAgo", { n: Math.round(minutes / 60) });
}

function state(w) {
  if (w.paused) return tr("watchPaused");
  const errors = { signin: "watchErrorSignin", quota: "watchErrorQuota", access: "watchErrorAccess", failed: "watchErrorFailed" };
  if (w.lastError) return errors[w.lastError] ? tr(errors[w.lastError]) : serverError({ i18n_key: w.lastError }, "watchErrorFailed");
  const parts = [w.lastChecked ? tr("watchChecked", { when: ago(w.lastChecked) }) : tr("watchStarting")];
  if (w.waiting) parts.push(tr("watchWaiting", { n: w.waiting }));
  if (w.sent) parts.push(tr("watchSent", { n: w.sent }));
  return parts.join(" · ");
}

function row(w) {
  const { el, icon } = host;
  const destination = [tr("back"), w.folderName].filter(Boolean).join(" › ");
  return el("div", { class: "list-row watch-row" }, [
    el("div", { class: "grow" }, [
      el("div", { dir: "auto" }, [el("b", { text: w.label }), document.createTextNode(` → ${destination}`)]),
      el("div", { class: `sub${w.lastError ? " danger" : ""}`, text: state(w) }),
    ]),
    el("button", { class: "btn quiet small", type: "button", text: w.paused ? tr("watchResume") : tr("watchPause"),
      onclick: () => native.updateWatch({ id: w.id, paused: !w.paused }).then(draw) }),
    el("button", { class: "icon-btn", type: "button", "aria-label": tr("watchEdit"), title: tr("watchEdit"), onclick: () => addSheet(w) }, [icon("edit")]),
    el("button", { class: "icon-btn", type: "button", "aria-label": tr("watchRemove"), title: tr("watchRemove"), onclick: () => remove(w) }, [icon("trash")]),
  ]);
}

async function remove(w) {
  if (!(await host.ask(tr("watchRemoveConfirm", { name: w.label }), { ok: tr("watchRemove"), danger: true }))) return;
  await native.removeWatch({ id: w.id }).catch(() => {});
  draw();
}

// My files' folders, flat under their parents, for the destination picker.
async function destinations() {
  tree = await api.folders().catch(() => tree || { top: null, folders: [] });
  const out = [{ id: "", name: tr("back"), depth: 0 }];
  const walk = (parent, depth) => tree.folders
    .filter((f) => f.parent === parent)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((f) => {
      out.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    });
  walk(tree.top, 1);
  return out;
}

// Adding a watch (or changing one): where its transcripts go, and its filters; then
// Android's folder picker, after saying plainly what watching does.
async function addSheet(existing) {
  const { el } = host;
  const choices = await destinations();
  const folder = el("select", { class: "tr-select", "aria-label": tr("saveTo") },
    choices.map((c) => el("option", { value: c.id, text: `${"  ".repeat(Math.max(0, c.depth - 1))}${c.depth > 1 ? "› " : ""}${c.name}` })));
  folder.value = existing?.folder || "";
  const language = el("select", { class: "tr-select", "aria-label": tr("transcribeLanguage") },
    Object.entries(LANGUAGES).map(([key, name]) => el("option", { value: key, text: name })));
  language.value = existing?.language || "he";
  const minSeconds = el("input", { class: "tr-input", type: "number", min: 0, max: 3600, value: existing?.minSeconds ?? 5, dir: "ltr" });
  const maxMinutes = el("input", { class: "tr-input", type: "number", min: 0, max: 1200, value: existing ? Math.round((existing.maxSeconds || 0) / 60) : 0, dir: "ltr" });
  const wifi = el("input", { type: "checkbox", checked: existing?.wifiOnly ?? false });
  const go = el("button", { class: "btn primary", type: "submit", text: existing ? tr("save") : tr("watchChoose") });
  const disclose = !existing && !localStorage.getItem(DISCLOSED);
  const form = el("form", { class: "stack" }, [
    el("label", { class: "tr-field" }, [el("span", { class: "muted", text: tr("watchInto") }), folder]),
    el("label", { class: "tr-field" }, [el("span", { class: "muted", text: tr("transcribeLanguage") }), language]),
    el("div", { class: "row" }, [
      el("label", { class: "tr-field grow" }, [el("span", { class: "muted", text: tr("watchMinSeconds") }), minSeconds]),
      el("label", { class: "tr-field grow" }, [el("span", { class: "muted", text: tr("watchMaxMinutes") }), maxMinutes]),
    ]),
    el("label", { class: "tr-check" }, [wifi, el("span", { text: tr("watchWifiOnly") })]),
    disclose ? el("p", { class: "notice", text: tr("watchDisclosure") }) : null,
    el("div", { class: "row end" }, [go]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const options = {
      folder: folder.value,
      folderName: folder.value ? tree.folders.find((f) => f.id === folder.value)?.name || "" : "",
      language: language.value,
      minSeconds: Math.max(0, Number(minSeconds.value) || 0),
      maxSeconds: Math.max(0, Number(maxMinutes.value) || 0) * 60,
      wifiOnly: wifi.checked,
    };
    go.disabled = true;
    try {
      if (existing) await native.updateWatch({ id: existing.id, ...options });
      else {
        await native.addWatch(options);
        localStorage.setItem(DISCLOSED, "1");
        host.toast(tr("watchAdded"));
      }
      host.sheet.close();
      draw();
    } catch (err) {
      go.disabled = false;
      if (err?.code !== "cancelled") host.toast(tr("watchErrorFailed"));
    }
  });
  host.sheet.open(existing ? tr("watchEdit") : tr("watchAdd"), form);
}
