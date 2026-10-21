// The live screen: Hebrew transcribed as it is spoken, on the device
// (local/live.js), with a timer, Pause and Stop; then Save (the transcript, and
// the recording if kept, into My files) or Discard.

import * as api from "./api.js";
import { ENGINE, LANGUAGE } from "./local/local.js";
import { startLive, supported } from "./local/live.js";
import { serverError, tr } from "./strings.js";
import { clock } from "./transcript.js";

export { supported };

let host = null;
let session = null; // the live session, while one runs

// Leaving the page mid-session loses it: asked first.
addEventListener("beforeunload", (e) => {
  if (session) {
    e.preventDefault();
    e.returnValue = "";
  }
});

export const busy = () => Boolean(session);

/**
 * Opens the live screen. hooks: showScreen(node), back() (to the list), saved(resultsId, folder).
 */
export async function open(hostApi, { folder, folderPicker, hooks }) {
  host = hostApi;
  const { el, icon } = host;
  const status = el("p", { class: "lede tr-live-status", text: tr("liveStarting") });
  const timer = el("span", { class: "tr-timer", dir: "ltr", text: "00:00" });
  const text = el("article", { class: "card tr-text tr-live-text", dir: "rtl", lang: LANGUAGE }, [
    el("p", { class: "muted", text: tr("liveHint") }),
  ]);
  const pause = el("button", { class: "btn", type: "button", disabled: true }, [icon("pause"), el("span", { text: tr("livePause") })]);
  const stop = el("button", { class: "btn primary", type: "button", disabled: true }, [icon("stop"), el("span", { text: tr("liveStop") })]);
  const controls = el("div", { class: "row tr-live-controls" }, [timer, el("span", { class: "spacer" }), pause, stop]);
  const back = el("button", { class: "btn quiet small tr-back", type: "button", onclick: () => leave() }, [icon("back"), el("span", { text: tr("back") })]);
  const screen = el("div", { class: "tr-reader tr-live", id: "tr-live" }, [
    back,
    el("h2", { class: "title", text: tr("liveTitle") }),
    status,
    controls,
    text,
  ]);
  hooks.showScreen(screen);

  let follow = true; // keep the newest words in view, until the user scrolls up
  const onScroll = () => (follow = innerHeight + scrollY >= document.body.scrollHeight - 80);
  addEventListener("scroll", onScroll, { passive: true });
  let ticker = null;

  const draw = (segments) => {
    if (!segments.length) return;
    text.replaceChildren(...segments.map((s, i) =>
      el("p", { class: `tr-turn${i === segments.length - 1 && session && !session.paused ? " tr-live-now" : ""}`, text: s.text })));
    if (follow) scrollTo({ top: document.body.scrollHeight });
  };

  async function leave() {
    if (session && !(await host.ask(tr("liveDiscardConfirm"), { ok: tr("liveDiscard"), danger: true }))) return;
    session?.discard();
    session = null;
    finish();
    hooks.back();
  }

  function finish() {
    clearInterval(ticker);
    removeEventListener("scroll", onScroll);
  }

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
    return hooks.back();
  }

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
    let result;
    try {
      result = await live.stop();
    } finally {
      session = null;
      finish();
    }
    draw(result.segments);
    offerSave(result);
  });

  // What was heard: into My files (with the recording if kept), or nowhere.
  function offerSave({ segments, seconds, audio }) {
    controls.replaceChildren(timer);
    timer.textContent = clock(seconds);
    if (!segments.length) {
      status.textContent = tr("liveNothing");
      return;
    }
    status.textContent = tr("liveDone");
    const keep = el("input", { type: "checkbox", checked: localStorage.getItem("tr_save_audio") !== "false" });
    const destination = folderPicker(folder);
    const save = el("button", { class: "btn primary", type: "button", text: tr("liveSave") });
    const discard = el("button", { class: "btn quiet", type: "button", text: tr("liveDiscard") });
    const box = el("div", { class: "card stack tr-live-save" }, [
      el("label", { class: "tr-field" }, [el("span", { class: "muted", text: tr("saveTo") }), destination]),
      el("label", { class: "tr-check" }, [keep, el("span", { text: tr("liveKeepAudio") })]),
      el("div", { class: "row" }, [save, discard]),
    ]);
    screen.append(box);
    discard.addEventListener("click", async () => {
      if (!(await host.ask(tr("liveDiscardConfirm"), { ok: tr("liveDiscard"), danger: true }))) return;
      hooks.back();
    });
    save.addEventListener("click", async () => {
      save.disabled = true;
      discard.disabled = true;
      save.textContent = tr("statusLocalSaving");
      try {
        const to = destination.value || null;
        const saved = await api.saveLocal(
          { filename: audio.name, language: LANGUAGE, duration_seconds: seconds, folder: to, origin: "live", engine: ENGINE },
          segments,
          keep.checked ? audio : null
        );
        localStorage.setItem("tr_save_audio", String(keep.checked));
        host.toast(tr("localSaved"));
        hooks.saved(saved.results_id, to);
      } catch (err) {
        host.toast(serverError(err?.data, "errorLocalSaveFailed"));
        save.disabled = false;
        discard.disabled = false;
        save.textContent = tr("liveSave");
      }
    });
  }
}
