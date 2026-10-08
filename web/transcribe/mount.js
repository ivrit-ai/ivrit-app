// The Transcribe view: what transcribe.ivrit.ai does (files up to 20 hours, recording,
// languages, speakers, My files in the user's Drive, the editor, exports, RunPod keys,
// quota, Stats for Nerds), running inside the app. Its page moved here whole
// (transcribe.html, transcribe.css, transcribe.js, i18n.js), so nothing it could do
// is lost; it talks to this site's server, which is transcribe.ivrit.ai's server too.
//
// It needs this browser signed in with Google and Drive (the server's cookie):
// boot() says whether it is; the app connects Drive when not (web/app.js).

const LIBRARIES = [
  "https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js",
  "https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/diff@5.1.0/dist/diff.min.js",
];

let mounted = null;

function script(src) {
  return new Promise((resolve, reject) => {
    const node = document.createElement("script");
    node.src = src;
    node.onload = resolve;
    node.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(node);
  });
}

function stylesheet(href) {
  return new Promise((resolve, reject) => {
    const node = document.createElement("link");
    node.rel = "stylesheet";
    node.href = href;
    node.onload = resolve;
    node.onerror = () => reject(new Error(`could not load ${href}`));
    document.head.append(node);
  });
}

// Whether this browser is signed in for transcribing, and what the view needs to start.
export async function boot() {
  const res = await fetch("/transcribe/boot", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`boot ${res.status}`);
  return res.json();
}

// The dark selectors of the moved styles key on <html data-theme>; the app follows
// the system's scheme.
function followTheme() {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
  apply();
  dark.addEventListener("change", apply);
}

// Load the view into container (once). host: { signedOut() } - the server no longer
// knows this browser; the app asks to connect again.
export function mount(container, host, { bootData, locale }) {
  if (mounted) return mounted;
  mounted = (async () => {
    followTheme();
    window.TranscribeHost = host;
    window.TRANSCRIBE_BOOT = bootData;
    const [markup] = await Promise.all([
      fetch("/transcribe/transcribe.html").then((r) => r.text()),
      stylesheet("/transcribe/transcribe.css"),
      ...LIBRARIES.map(script),
    ]);
    const root = document.createElement("div");
    root.id = "transcribe-app";
    root.innerHTML = markup;
    container.replaceChildren(root);
    await script("/transcribe/i18n.js");
    setLocale(locale);
    await import("/transcribe/tiptap.js");
    await script("/transcribe/transcribe.js");
  })();
  mounted.catch(() => (mounted = null));
  return mounted;
}

export function setLocale(locale) {
  if (!window.I18N) return;
  window.I18N.setLanguage(locale);
  window.I18N.apply();
  window.TranscribeHost?.relocalize?.();
}

// Files to transcribe from elsewhere in the app (shared in, too long for a clip).
export function addFiles(files) {
  window.TranscribeHost?.handleFiles?.(files);
}
