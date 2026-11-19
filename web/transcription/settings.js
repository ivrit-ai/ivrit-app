// Transcribing's settings, in the app's Settings: transcribing on the user's
// devices only, the model the phone does it with (where it can run ivrit.ai's Turbo
// model), the user's own RunPod key (no weekly limit, more languages; kept
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
  // What transcribing here gives, speakers or not, as the phone's model has it.
  const onDeviceSub = el("span", { class: "sub" });
  const describeOnDevice = () => {
    onDeviceSub.textContent = !local.supported() ? tr("localOnlyUnsupported")
      : tr(host.deviceSpeakers?.() ? "localOnlyBodySpeakers" : "localOnlyBody");
  };
  describeOnDevice();
  const onDeviceBox = el("label", { class: "tr-check" }, [onDevice, el("span", {}, [
    el("span", { text: tr("localOnlyTitle") }),
    onDeviceSub,
  ])]);
  const phoneModelBox = await phoneModel(host, describeOnDevice);
  const status = boot.runpodKeyStatus || {};
  const balance = el("span", { class: "muted" });
  const input = el("input", { class: "tr-input", type: "password", autocomplete: "off", placeholder: tr("runpodKeyPlaceholder"), dir: "ltr" });
  const save = el("button", { class: "btn primary small", type: "submit", text: tr("save") });
  const form = el("form", { class: "stack" }, [
    onDeviceBox,
    phoneModelBox,
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

// The Turbo model the phone transcribes recordings with, in the background (the small
// one is live transcription's only), a large download the first time (sizes:
// scripts/turbo_model.py's files). Only on phones that can run it. Then where it runs:
// the GPU once it passed its check on the phone (automatic), the CPU, or the GPU
// whenever it gives the right words; and what that check found. One size only
// (docs/turbo-android.md, decision 2): shown, not chosen, while that is so.
const PHONE_MODELS = { q8_0: 875 };
const PROCESSORS = ["auto", "cpu", "gpu"];

async function phoneModel(host, onModel) {
  const { el } = host;
  let current;
  try {
    current = await host.onDeviceModel?.();
  } catch {
    current = null;
  }
  if (!current) return null;
  const sizes = Object.entries(PHONE_MODELS);
  const model = sizes.length === 1
    ? el("span", { text: tr(`phoneModel_${sizes[0][0]}`, { megabytes: sizes[0][1] }) })
    : el("select", { class: "tr-select", "aria-label": tr("phoneModelTitle") },
      sizes.map(([value, megabytes]) => el("option", { value, text: tr(`phoneModel_${value}`, { megabytes }) })));
  // The Lab's WebGPU trial ("webgpu") is shown here only while it is chosen there.
  const processors = current.processor === "webgpu" ? [...PROCESSORS, "webgpu"] : PROCESSORS;
  const processor = el("select", { class: "tr-select", "aria-label": tr("phoneProcessorTitle") },
    processors.map((value) => el("option", { value, text: tr(`phoneProcessor_${value}`) })));
  const note = el("span", { class: "sub" });
  const gpuNote = el("span", { class: "sub" });
  const processorField = el("label", { class: "tr-field" }, [el("span", { text: tr("phoneProcessorTitle") }), processor, gpuNote]);
  const show = () => {
    if (sizes.length > 1) model.value = current.model;
    processor.value = current.processor || "auto";
    note.textContent = tr(current.ready ? "phoneModelTurboBody" : "phoneModelTurboDownload");
    const gpu = current.gpu;
    gpuNote.textContent = !gpu
      ? tr("phoneGpuUnchecked")
      : tr(`phoneGpu_${gpu.state}`, { name: gpu.name ? `(${gpu.name})` : "", cpu: gpu.cpuSeconds?.toFixed(1), gpu: gpu.gpuSeconds?.toFixed(1) });
  };
  const choose = (options) => async () => {
    model.disabled = processor.disabled = true;
    try {
      current = await host.onDeviceModel(options());
    } catch {
      host.toast(tr("errorInternalServer"));
    } finally {
      model.disabled = processor.disabled = false;
      show();
      onModel?.();
    }
  };
  model.addEventListener("change", choose(() => ({ model: model.value })));
  processor.addEventListener("change", choose(() => ({ processor: processor.value })));
  show();
  return el("div", { class: "stack" }, [
    el("label", { class: "tr-field" }, [el("span", { text: tr("phoneModelTitle") }), model, note]),
    processorField,
    // How fast this phone transcribes, and how it does among others.
    el("div", { class: "row" }, [
      el("a", { class: "btn", href: "/lab/#phone-bench", text: tr("phoneBenchmark") }),
      el("a", { class: "btn quiet", href: "/bench/", text: tr("phoneLeaderboard") }),
    ]),
  ]);
}
