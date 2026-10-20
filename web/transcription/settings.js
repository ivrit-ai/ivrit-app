// Transcribing's settings, in the app's Settings: transcribing on the user's
// devices only, the user's own RunPod key (no weekly limit, more languages; kept
// encrypted in their Drive, never shown again), its balance, and Stats for Nerds.

import * as api from "./api.js";
import * as local from "./local/local.js";
import { serverError, setLanguage, tr } from "./strings.js";

export async function render(box, host, onChange) {
  const { el } = host;
  setLanguage(host.locale());
  let boot;
  try {
    boot = await api.boot();
  } catch {
    boot = null;
  }
  if (!boot?.signedIn) {
    box.replaceChildren(el("p", { class: "muted", text: tr("runpodHelpText") }));
    return;
  }
  // On the user's devices only: their audio is never transcribed on a server
  // (and the server refuses it).
  const onDevice = el("input", { type: "checkbox", checked: Boolean(boot.localOnly), disabled: !local.supported() && !boot.localOnly });
  onDevice.addEventListener("change", async () => {
    onDevice.disabled = true;
    try {
      const saved = await api.setLocalOnly(onDevice.checked);
      onChange?.({ ...boot, localOnly: Boolean(saved.localOnly) });
      render(box, host, onChange);
    } catch (err) {
      onDevice.checked = !onDevice.checked;
      onDevice.disabled = false;
      host.toast(serverError(err.data, "errorInternalServer"));
    }
  });
  const onDeviceBox = el("label", { class: "tr-check" }, [onDevice, el("span", {}, [
    el("span", { text: tr("localOnlyTitle") }),
    el("span", { class: "sub", text: local.supported() ? tr("localOnlyBody") : tr("localOnlyUnsupported") }),
  ])]);
  const status = boot.runpodKeyStatus || {};
  const balance = el("span", { class: "muted" });
  const input = el("input", { class: "tr-input", type: "password", autocomplete: "off", placeholder: tr("runpodKeyPlaceholder"), dir: "ltr" });
  const save = el("button", { class: "btn primary small", type: "submit", text: tr("save") });
  const form = el("form", { class: "stack" }, [
    onDeviceBox,
    el("p", { class: "muted", text: tr("runpodHelpText") }),
    status.has_key
      ? el("div", { class: "row spread" }, [
          el("span", { text: tr("runpodKeySavedHint", { hint: status.hint }) }),
          el("button", { class: "btn danger small", type: "button", text: tr("removeRunpodKey"), onclick: async () => {
            try {
              const next = await api.removeRunpodKey();
              host.toast(tr("runpodKeyRemoved"));
              onChange?.({ ...boot, runpodKeyStatus: next });
              render(box, host, onChange);
            } catch (err) {
              host.toast(serverError(err.data, "errorRunpodKeyRemoveFailed"));
            }
          } }),
        ])
      : null,
    status.load_failed ? el("p", { class: "muted", text: tr("runpodKeyLoadFailed") }) : null,
    status.has_key ? balance : null,
    el("div", { class: "row" }, [input, save]),
    el("a", { href: "https://youtu.be/xr8RQRFERLs", target: "_blank", rel: "noopener", class: "muted", text: tr("runpodHelpWatch") }),
    el("div", { class: "row" }, [el("a", { class: "btn quiet small", href: "#t/stats", text: "Stats for Nerds" })]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;
    save.disabled = true;
    try {
      const next = await api.saveRunpodKey(key);
      host.toast(tr("runpodSettingsSaved") + (next.needs_wait ? ` ${tr("runpodEndpointWait")}` : ""));
      onChange?.({ ...boot, runpodKeyStatus: next });
      render(box, host, onChange);
    } catch (err) {
      host.toast(serverError(err.data, "errorRunpodKeySaveFailed"));
      save.disabled = false;
    }
  });
  box.replaceChildren(form);
  if (status.has_key) {
    api.balance().then((b) => {
      balance.textContent = typeof b.clientBalance === "number" ? tr("balanceLine", { amount: `$${b.clientBalance.toFixed(2)}` }) : tr("balanceLoadingError");
    }, () => (balance.textContent = tr("balanceLoadingError")));
  }
}
