// The Live tab: Hebrew transcribed as it is spoken, on the device
// (local/live.js), with a timer, Pause and Finish; then what to do with it.
//
// Nothing here needs an account: the model runs on the device. Only keeping the
// transcript in My files does (Google Drive). Signed out, it is saved to the
// device, or kept here while the user signs in (which starts the page again) and
// saved to My files after.

import * as api from "./api.js";
import { ENGINE, LANGUAGE } from "./local/local.js";
import { startLive, supported } from "./local/live.js";
import { serverError, setLanguage, tr } from "./strings.js";
import { clock } from "./transcript.js";

export { supported };

let host = null;
let hooks = null;
let root = null;
let session = null; // the live session, while one runs
let result = null; // what it heard, once finished, until saved or deleted
let kept = false; // the result is also kept on the device (for after signing in)

// Leaving the page mid-session loses it, and so does leaving what it heard unsaved.
addEventListener("beforeunload", (e) => {
  if (session || (result && !result.savedHere && !kept)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

export const busy = () => Boolean(session);

// A transcript is on the tab, not yet saved anywhere.
export const hasResult = () => Boolean(result && !result.savedHere);

/**
 * Mounts the tab into container. hooks:
 *   signedIn(): whether there is an account
 *   account(): Promise<"signed-out" | "no-drive" | "ready">: where it can be saved
 *   folderPicker(selected), folder(): My files' folders, when ready
 *   signIn(): sign in (the page starts again after)
 *   connect(): Promise<boolean>: connect Google Drive
 *   saved(resultsId, folder): it is in My files
 *   changed(busy): a session started or ended
 *   recording(): a recording is under way (the microphone is taken)
 */
export async function mount(container, hostApi, tabHooks) {
  host = hostApi;
  hooks = tabHooks;
  root = container;
  setLanguage(host.locale());
  result = await takeKept().catch(() => null);
  kept = Boolean(result);
  if (result) drawResult({ recovered: true });
  else drawStart();
}

// The tab is shown. A transcript kept across signing in is saved to My files then,
// once Drive is ready; otherwise it waits on screen for the user.
export async function show() {
  if (!root || session || !result?.autoSave) return;
  result.autoSave = false;
  if ((await hooks.account()) !== "ready") return;
  await drawn;
  saveToFiles(null, [...root.querySelectorAll(".tr-live-save button")]);
}

export function relocalize(locale) {
  setLanguage(locale);
  if (!root || session) return;
  if (result) drawResult({ recovered: kept });
  else drawStart();
}

// ------------------------------------------------------------------ screens

function drawStart() {
  const { el, icon } = host;
  result = null;
  kept = false;
  root.replaceChildren(
    el("div", { class: "tr-live tr-live-idle" }, [
      el("h2", { class: "title", text: tr("liveTitle") }),
      el("p", { class: "lede", text: tr("liveHint") }),
      el("div", { class: "row" }, [
        el("button", { id: "tr-live-start", class: "btn primary", type: "button", onclick: () => begin() }, [
          icon("mic"),
          el("span", { text: tr("liveStart") }),
        ]),
      ]),
      hooks.signedIn() ? "" : el("p", { class: "fine", text: tr("liveNoAccount") }),
    ])
  );
}

const visible = () => root && !root.closest("[hidden]");

async function begin() {
  if (hooks.recording?.()) return host.toast(tr("recordingRunning"));
  const { el, icon } = host;
  const status = el("p", { class: "lede tr-live-status", text: tr("liveStarting") });
  const timer = el("span", { class: "tr-timer", dir: "ltr", text: "00:00" });
  const text = el("article", { class: "card tr-text tr-live-text", dir: "rtl", lang: LANGUAGE }, [
    el("p", { class: "muted", text: tr("liveHint") }),
  ]);
  const pause = el("button", { class: "btn", type: "button", disabled: true }, [icon("pause"), el("span", { text: tr("livePause") })]);
  const stop = el("button", { class: "btn primary", type: "button", disabled: true }, [icon("stop"), el("span", { text: tr("liveStop") })]);
  const controls = el("div", { class: "row tr-live-controls" }, [timer, el("span", { class: "spacer" }), pause, stop]);
  root.replaceChildren(
    el("div", { class: "tr-live", id: "tr-live" }, [el("h2", { class: "title", text: tr("liveTitle") }), status, controls, text])
  );

  let follow = true; // keep the newest words in view, until the user scrolls up
  const onScroll = () => visible() && (follow = innerHeight + scrollY >= document.body.scrollHeight - 80);
  addEventListener("scroll", onScroll, { passive: true });
  let ticker = null;

  const draw = (segments) => {
    if (!segments.length) return;
    text.replaceChildren(...segments.map((s, i) =>
      el("p", { class: `tr-turn${i === segments.length - 1 && session && !session.paused ? " tr-live-now" : ""}`, text: s.text })));
    // Only while the tab is shown: otherwise the page is another tab's.
    if (follow && visible()) scrollTo({ top: document.body.scrollHeight });
  };

  const finish = () => {
    clearInterval(ticker);
    removeEventListener("scroll", onScroll);
  };

  try {
    session = await startLive({
      onModel: (fraction) => (status.textContent = tr("liveModel", { progress: Math.round(fraction * 100) })),
      onText: (segments, { behind }) => {
        draw(segments);
        if (!session?.paused) status.textContent = behind > 3 ? tr("liveBehind", { seconds: Math.round(behind) }) : tr("liveListening");
      },
      onState: (state, err) => {
        if (state === "paused") status.textContent = tr("livePaused");
        else if (state === "listening") status.textContent = tr("liveListening");
        else if (state === "error") host.toast(tr("localFailed", { details: err?.message || "" }));
      },
    });
  } catch (err) {
    finish();
    session = null;
    if (err?.name === "NotAllowedError") {
      if (host.canOpenAppSettings?.() && (await host.ask(tr("micAllowInSettings"), { ok: tr("micOpenSettings") }))) host.openAppSettings();
      else host.toast(tr("micPermissionDenied"));
    } else {
      host.toast(tr("localFailed", { details: err?.message || "" }));
    }
    return drawStart();
  }
  hooks.changed?.(true);

  ticker = setInterval(() => (timer.textContent = clock(session?.seconds ?? 0)), 500);
  pause.disabled = false;
  stop.disabled = false;
  pause.addEventListener("click", () => {
    if (!session) return;
    if (session.paused) session.resume();
    else session.pause();
    pause.replaceChildren(icon(session.paused ? "mic" : "pause"), el("span", { text: tr(session.paused ? "liveResume" : "livePause") }));
  });
  stop.addEventListener("click", async () => {
    if (!session) return;
    pause.disabled = true;
    stop.disabled = true;
    status.textContent = tr("liveFinishing");
    const live = session;
    let heard;
    try {
      heard = await live.stop();
    } finally {
      session = null;
      finish();
      hooks.changed?.(false);
    }
    if (!heard.segments.length) {
      host.toast(tr("liveNothing"));
      return drawStart();
    }
    result = { segments: heard.segments, seconds: heard.seconds, audio: heard.audio };
    kept = false;
    drawResult({ recovered: false });
  });
}

// What was heard, and where it can go: My files (signing in, or connecting Drive,
// first if need be), this device, or nowhere.
let drawn = Promise.resolve();

function drawResult(options) {
  drawn = drawResultNow(options);
  return drawn;
}

async function drawResultNow({ recovered }) {
  const { el } = host;
  const { segments, seconds } = result;
  const text = el("article", { class: "card tr-text tr-live-text", dir: "rtl", lang: LANGUAGE },
    segments.map((s) => el("p", { class: "tr-turn", text: s.text })));
  const box = el("div", { class: "card stack tr-live-save" });
  root.replaceChildren(
    el("div", { class: "tr-live", id: "tr-live" }, [
      el("h2", { class: "title", text: tr("liveTitle") }),
      el("p", { class: "lede tr-live-status", text: tr(recovered ? "liveRecovered" : "liveDone") }),
      el("div", { class: "row tr-live-controls" }, [el("span", { class: "tr-timer", dir: "ltr", text: clock(seconds) })]),
      text,
      box,
    ])
  );

  const account = await hooks.account();
  if (!result || !box.isConnected) return; // drawn again meanwhile
  const keep = el("input", { type: "checkbox", checked: result.keepAudio ?? readKeepAudio() });
  keep.addEventListener("change", () => (result.keepAudio = keep.checked));
  const destination = account === "ready" ? hooks.folderPicker(hooks.folder()) : null;
  const toFiles = el("button", { class: "btn primary", type: "button", text: tr(account === "signed-out" ? "liveSignInSave" : "liveSave") });
  const toDevice = el("button", { class: "btn", type: "button", text: tr("liveSaveDevice") });
  const discard = el("button", { class: "btn quiet", type: "button", text: tr(result.savedHere ? "liveNew" : "liveDiscard") });
  box.replaceChildren(
    destination ? el("label", { class: "tr-field" }, [el("span", { class: "muted", text: tr("saveTo") }), destination]) : "",
    el("label", { class: "tr-check" }, [keep, el("span", { text: tr("liveKeepAudio") })]),
    el("div", { class: "row" }, [toFiles, toDevice, discard])
  );

  toFiles.addEventListener("click", async () => {
    result.keepAudio = keep.checked;
    if (account === "signed-out") {
      // Kept on the device while Google signs in; the page starts again after.
      try {
        await keepForLater({ ...result, autoSave: true });
        kept = true;
      } catch {
        return host.toast(tr("liveCannotKeep"));
      }
      hooks.signIn();
      return;
    }
    if (account === "no-drive") {
      toFiles.disabled = true;
      const connected = await hooks.connect().catch(() => false);
      toFiles.disabled = false;
      if (connected) drawResult({ recovered: kept });
      return;
    }
    saveToFiles(destination.value || null, [toFiles, toDevice, discard]);
  });
  toDevice.addEventListener("click", async () => {
    result.keepAudio = keep.checked;
    if (await saveToDevice()) {
      result.savedHere = true;
      discard.textContent = tr("liveNew");
    }
  });
  discard.addEventListener("click", async () => {
    if (!result.savedHere && !(await host.ask(tr("liveDiscardConfirm"), { ok: tr("liveDiscard"), danger: true }))) return;
    await dropKept().catch(() => {});
    drawStart();
  });
}

// The words as a text file, and the recording beside them if kept.
async function saveToDevice() {
  const { segments, audio, keepAudio } = result;
  const where = await host.saveFile(api.plainTextFile(segments), audio.name.replace(/\.[^.]{1,5}$/, ".txt"));
  if (!where) return false;
  if (keepAudio) await host.saveFile(audio, audio.name);
  if (where === "downloaded") host.toast(tr("liveSavedHere"));
  return true;
}

async function saveToFiles(to, buttons) {
  const { segments, seconds, audio, keepAudio } = result;
  for (const b of buttons) b.disabled = true;
  if (buttons[0]) buttons[0].textContent = tr("statusLocalSaving");
  try {
    const saved = await api.saveLocalFitting(
      { filename: audio.name, language: LANGUAGE, duration_seconds: seconds, folder: to, origin: "live", engine: ENGINE },
      segments,
      keepAudio ?? readKeepAudio() ? audio : null
    );
    try {
      localStorage.setItem("tr_save_audio", String(keepAudio ?? readKeepAudio()));
    } catch {}
    await dropKept().catch(() => {});
    host.toast(tr(saved.withoutAudio ? "savedWithoutAudio" : "localSaved"));
    drawStart();
    hooks.saved(saved.results_id, to);
  } catch (err) {
    // No room in Drive even for the words: they are kept on this device, and
    // the transcript stays here to save again once there is room.
    if (api.driveFull(err) && (await host.saveFile(api.plainTextFile(segments), audio.name.replace(/\.[^.]{1,5}$/, ".txt")))) {
      result.savedHere = true;
      host.toast(tr("driveFullKeptHere"));
    } else {
      host.toast(serverError(err?.data, "errorLocalSaveFailed"));
    }
    drawResult({ recovered: kept });
  }
}

function readKeepAudio() {
  try {
    return localStorage.getItem("tr_save_audio") !== "false";
  } catch {
    return true;
  }
}

// ------------------------------------------------------------------ kept for after signing in

// One transcript at most, in a database of its own: {segments, seconds, audio,
// name, keepAudio, autoSave}.
const DB = "ivrit-live";

function db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kept");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction("kept", mode);
      const request = action(tx.objectStore("kept"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

async function keepForLater({ segments, seconds, audio, keepAudio, autoSave }) {
  await run("readwrite", (s) => s.put({ segments, seconds, audio, name: audio.name, keepAudio, autoSave }, "result"));
}

async function takeKept() {
  if (!self.indexedDB) return null;
  const row = await run("readonly", (s) => s.get("result"));
  if (!row) return null;
  const audio = row.audio instanceof File ? row.audio : new File([row.audio], row.name, { type: row.audio.type });
  return { segments: row.segments, seconds: row.seconds, audio, keepAudio: row.keepAudio, autoSave: row.autoSave };
}

async function dropKept() {
  if (!self.indexedDB || !kept) return;
  await run("readwrite", (s) => s.delete("result"));
  kept = false;
}
