// Google Play's publishing API, for scripts/publish-android.sh: signs in as
// the play-publisher service account and uploads a bundle to a track.
//
//   node scripts/play.mjs status                  tracks and their releases
//   node scripts/play.mjs listing                 the store listing, per language
//   node scripts/play.mjs icon <file.png>         sets the listing's icon
//   node scripts/play.mjs graphics                feature graphic and screenshots from store/
//   node scripts/play.mjs upload <file.aab> [track] [notes]
//
// The key is ~/keys/ivrit-app-play-publisher.json, or PLAY_SERVICE_ACCOUNT.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const PACKAGE = JSON.parse(readFileSync(new URL("../shared/app.json", import.meta.url))).packageId;
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;
const account = JSON.parse(readFileSync(process.env.PLAY_SERVICE_ACCOUNT || `${homedir()}/keys/ivrit-app-play-publisher.json`, "utf8"));

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: account.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url")}`;
  const res = await fetch(account.token_uri, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const token = await accessToken();
async function call(method, url, { json, body, type } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (json) headers["content-type"] = "application/json";
  if (type) headers["content-type"] = type;
  const res = await fetch(url, { method, headers, body: json ? JSON.stringify(json) : body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url.replace(/\?.*/, "")}: ${res.status} ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}

// Every change goes through an "edit", committed at the end or not at all.
const edit = await call("POST", `${API}/edits`, { json: {} });
const [command, file, track = "internal", notes] = process.argv.slice(2);
try {
  if (command === "status") {
    const { tracks } = await call("GET", `${API}/edits/${edit.id}/tracks`);
    for (const t of tracks) console.log(t.track, JSON.stringify(t.releases?.map((r) => ({ status: r.status, versionCodes: r.versionCodes, name: r.name })) ?? []));
  } else if (command === "listing") {
    const details = await call("GET", `${API}/edits/${edit.id}/details`);
    const { listings = [] } = await call("GET", `${API}/edits/${edit.id}/listings`);
    console.log("default language:", details.defaultLanguage, "| contact:", details.contactEmail ?? "-");
    for (const l of listings) {
      const { images = [] } = await call("GET", `${API}/edits/${edit.id}/listings/${l.language}/icon`);
      console.log(l.language, JSON.stringify({ title: l.title, short: l.shortDescription, icon: images.length }));
    }
  } else if (command === "icon") {
    // The store listing's icon, in every language the listing has.
    const { listings = [] } = await call("GET", `${API}/edits/${edit.id}/listings`);
    if (!listings.length) throw new Error("no store listing yet");
    for (const { language } of listings) {
      await call("DELETE", `${API}/edits/${edit.id}/listings/${language}/icon`);
      await call("POST", `${UPLOAD}/edits/${edit.id}/listings/${language}/icon?uploadType=media`, {
        body: readFileSync(file),
        type: "image/png",
      });
      console.log("icon set for", language);
    }
    await call("POST", `${API}/edits/${edit.id}:commit`);
  } else if (command === "graphics") {
    // The listing's feature graphic and phone screenshots, from store/, in
    // the listing's default language. Replaces whatever is there.
    const { readdirSync } = await import("node:fs");
    const store = new URL("../store/", import.meta.url).pathname;
    const { defaultLanguage: lang } = await call("GET", `${API}/edits/${edit.id}/details`);
    const put = async (type, filePath) =>
      call("POST", `${UPLOAD}/edits/${edit.id}/listings/${lang}/${type}?uploadType=media`, { body: readFileSync(filePath), type: "image/png" });
    await call("DELETE", `${API}/edits/${edit.id}/listings/${lang}/featureGraphic`);
    await put("featureGraphic", `${store}feature-graphic.png`);
    await call("DELETE", `${API}/edits/${edit.id}/listings/${lang}/phoneScreenshots`);
    const shots = readdirSync(`${store}phone`).filter((f) => f.endsWith(".png")).sort();
    for (const shot of shots) await put("phoneScreenshots", `${store}phone/${shot}`);
    await call("POST", `${API}/edits/${edit.id}:commit`);
    console.log(`${lang}: feature graphic and ${shots.length} phone screenshots`);
  } else if (command === "upload") {
    const bundle = await call("POST", `${UPLOAD}/edits/${edit.id}/bundles?uploadType=media`, {
      body: readFileSync(file),
      type: "application/octet-stream",
    });
    await call("PUT", `${API}/edits/${edit.id}/tracks/${track}`, {
      json: {
        track,
        releases: [
          {
            versionCodes: [String(bundle.versionCode)],
            status: "completed",
            ...(notes ? { releaseNotes: [{ language: (await call("GET", `${API}/edits/${edit.id}/details`)).defaultLanguage, text: notes }] } : {}),
          },
        ],
      },
    });
    await call("POST", `${API}/edits/${edit.id}:commit`);
    console.log(`released versionCode ${bundle.versionCode} to ${track}`);
  } else {
    throw new Error("usage: play.mjs status | listing | icon <file.png> | graphics | upload <file.aab> [track] [notes]");
  }
} finally {
  if (command === "status" || command === "listing") await call("DELETE", `${API}/edits/${edit.id}`).catch(() => {});
}
