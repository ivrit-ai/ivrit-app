#!/usr/bin/env python3
"""The App Store release of the iPhone app, through the App Store Connect API
(the key CI signs and uploads with; .github/workflows/app-store.yml).

    app-store.py status
        What App Store Connect has: the app, its versions and their states,
        the latest builds, the price, and review submissions.

    app-store.py prepare
        The version (shared/app.json's) ready to submit: its texts and the
        app's (store/app-store.json), categories, age rating, copyright, the
        screenshots (store/iphone/), the newest processed build of that
        version, and the review notes. App Privacy, and the review contact and
        sign-in, are App Store Connect's to fill in by hand (no API for the
        first; the second never in git).

    app-store.py submit
        Sends that version to App Review.

Needs ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, and pyjwt and cryptography.
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import jwt

API = "https://api.appstoreconnect.apple.com/v1"
ROOT = Path(__file__).resolve().parent.parent
LISTING = json.loads((ROOT / "store/app-store.json").read_text())
VERSION = json.loads((ROOT / "shared/app.json").read_text())["version"]
EDITABLE = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"}
problems: list[str] = []


def token() -> str:
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
        Path(os.environ["ASC_KEY_PATH"]).read_text(),
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"},
    )


class Refused(Exception):
    pass


def call(method: str, path: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        path if path.startswith("http") else API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"authorization": f"Bearer {token()}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        errors = json.loads(e.read() or b"{}").get("errors", [{}])
        detail = "; ".join(f"{x.get('code')}: {x.get('detail')}" for x in errors)
        raise Refused(f"{method} {path.split('?')[0]}: {e.code} {detail}") from None


def soft(what: str, fn):
    """A step that may fail without stopping the rest: said, and counted."""
    try:
        return fn()
    except Refused as e:
        problems.append(f"{what}: {e}")
        print(f"  ! {what}: {e}")
        return None


def app() -> dict:
    found = call("GET", f"/apps?filter[bundleId]={LISTING['bundleId']}")["data"]
    if not found:
        sys.exit(f"no app with bundle id {LISTING['bundleId']} in App Store Connect")
    return found[0]


def versions(app_id: str) -> list[dict]:
    return call("GET", f"/apps/{app_id}/appStoreVersions?filter[platform]=IOS&limit=20")["data"]


def builds(app_id: str, version: str | None = None) -> list[dict]:
    query = f"filter[app]={app_id}&sort=-uploadedDate&limit=10&include=preReleaseVersion"
    if version:
        query += f"&filter[preReleaseVersion.version]={version}"
    return call("GET", f"/builds?{query}")["data"]


def status() -> None:
    a = app()
    attrs = a["attributes"]
    print(f"app {a['id']}: {attrs['name']} ({attrs['bundleId']}), primary locale {attrs.get('primaryLocale')}")
    for v in versions(a["id"]):
        va = v["attributes"]
        print(f"  version {va['versionString']}: {va.get('appStoreState') or va.get('appVersionState')}")
    for b in builds(a["id"]):
        ba = b["attributes"]
        print(f"  build {ba['version']}: {ba['processingState']}, uploaded {ba['uploadedDate']}, expired {ba.get('expired')}")
    schedule = soft("price", lambda: call("GET", f"/apps/{a['id']}/appPriceSchedule"))
    print(f"  price schedule: {'set' if schedule and schedule.get('data') else 'none'}")
    availability = soft("availability", lambda: call("GET", f"/apps/{a['id']}/appAvailabilityV2"))
    print(f"  availability: {'set' if availability and availability.get('data') else 'none'}")
    for info in call("GET", f"/apps/{a['id']}/appInfos")["data"]:
        print(f"  app info {info['id']}: {info['attributes'].get('state') or info['attributes'].get('appStoreState')}")
    submissions = soft("submissions", lambda: call("GET", f"/reviewSubmissions?filter[app]={a['id']}&limit=5"))
    for s in (submissions or {}).get("data", []):
        print(f"  review submission {s['id']}: {s['attributes'].get('state')}")


def editable_version(app_id: str) -> dict:
    """This version, made if it is not there yet; the one waiting to be sent if it is.
    A version waiting under another number (App Store Connect's first is "1.0")
    takes this one's: a build's version must match it."""
    for v in versions(app_id):
        va = v["attributes"]
        state = va.get("appStoreState") or va.get("appVersionState")
        if va["versionString"] != VERSION and state == "PREPARE_FOR_SUBMISSION":
            print(f"  version {va['versionString']} → {VERSION}")
            return call("PATCH", f"/appStoreVersions/{v['id']}", {"data": {
                "type": "appStoreVersions", "id": v["id"], "attributes": {"versionString": VERSION}}})["data"]
    for v in versions(app_id):
        va = v["attributes"]
        if va["versionString"] == VERSION:
            state = va.get("appStoreState") or va.get("appVersionState")
            if state not in EDITABLE and state not in {"PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"}:
                sys.exit(f"version {VERSION} is {state}: not editable (bump shared/app.json's version)")
            return v
    print(f"  making version {VERSION}")
    return call("POST", "/appStoreVersions", {"data": {
        "type": "appStoreVersions",
        "attributes": {"platform": "IOS", "versionString": VERSION, "copyright": LISTING["copyright"], "releaseType": "AFTER_APPROVAL"},
        "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
    }})["data"]


def upsert_localizations(kind: str, parent: str, parent_id: str, relation: str, fields: dict[str, list[str]]) -> dict:
    """Each locale's texts on a version or an app info, made or changed; {locale: id}."""
    existing = {x["attributes"]["locale"]: x["id"] for x in call("GET", f"/{parent}/{parent_id}/{relation}")["data"]}
    ids = {}
    for locale, texts in LISTING["locales"].items():
        attrs = {k: texts[k] for k in fields if texts.get(k)}
        if locale in existing:
            soft(f"{kind} {locale}", lambda: call("PATCH", f"/{kind}/{existing[locale]}", {"data": {"type": kind, "id": existing[locale], "attributes": attrs}}))
            ids[locale] = existing[locale]
        else:
            made = soft(f"{kind} {locale}", lambda: call("POST", f"/{kind}", {"data": {
                "type": kind, "attributes": {"locale": locale, **attrs},
                "relationships": {parent[:-1] if parent.endswith("s") else parent: {"data": {"type": parent, "id": parent_id}}},
            }}))
            if made:
                ids[locale] = made["data"]["id"]
    return ids


def screenshots(localization_id: str, files: list[Path]) -> None:
    kind = LISTING["screenshotDisplayType"]
    sets = call("GET", f"/appStoreVersionLocalizations/{localization_id}/appScreenshotSets")["data"]
    found = next((s for s in sets if s["attributes"]["screenshotDisplayType"] == kind), None)
    if found:
        for old in call("GET", f"/appScreenshotSets/{found['id']}/appScreenshots")["data"]:
            call("DELETE", f"/appScreenshots/{old['id']}")
        set_id = found["id"]
    else:
        set_id = call("POST", "/appScreenshotSets", {"data": {
            "type": "appScreenshotSets", "attributes": {"screenshotDisplayType": kind},
            "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": localization_id}}},
        }})["data"]["id"]
    for file in files:
        data = file.read_bytes()
        shot = call("POST", "/appScreenshots", {"data": {
            "type": "appScreenshots", "attributes": {"fileName": file.name, "fileSize": len(data)},
            "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": set_id}}},
        }})["data"]
        for op in shot["attributes"]["uploadOperations"]:
            part = data[op["offset"]: op["offset"] + op["length"]]
            request = urllib.request.Request(op["url"], method=op["method"], data=part,
                                             headers={h["name"]: h["value"] for h in op["requestHeaders"]})
            urllib.request.urlopen(request).read()
        call("PATCH", f"/appScreenshots/{shot['id']}", {"data": {
            "type": "appScreenshots", "id": shot["id"],
            "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()},
        }})
        print(f"    {file.name}")


def free_everywhere(app_id: str) -> None:
    """Free, if no price is set yet (a new app has none)."""
    schedule = soft("price", lambda: call("GET", f"/apps/{app_id}/appPriceSchedule"))
    if schedule and schedule.get("data"):
        return
    points = call("GET", f"/apps/{app_id}/appPricePoints?filter[territory]=USA&limit=200")["data"]
    free = next(p for p in points if float(p["attributes"]["customerPrice"]) == 0)
    soft("price: free", lambda: call("POST", "/appPriceSchedules", {
        "data": {"type": "appPriceSchedules", "relationships": {
            "app": {"data": {"type": "apps", "id": app_id}},
            "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
            "manualPrices": {"data": [{"type": "appPrices", "id": "${free}"}]},
        }},
        "included": [{"type": "appPrices", "id": "${free}", "attributes": {"startDate": None},
                      "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": free["id"]}}}}],
    }))
    print("  price: free")


def everywhere(app_id: str) -> None:
    """Available in every territory, and in new ones as they come, if not set yet."""
    try:
        call("GET", f"/apps/{app_id}/appAvailabilityV2")
        return
    except Refused:
        pass
    territories = [t["id"] for t in call("GET", "/territories?limit=200")["data"]]
    soft("availability", lambda: call("POST", "https://api.appstoreconnect.apple.com/v2/appAvailabilities", {
        "data": {"type": "appAvailabilities", "attributes": {"availableInNewTerritories": True}, "relationships": {
            "app": {"data": {"type": "apps", "id": app_id}},
            "territoryAvailabilities": {"data": [{"type": "territoryAvailabilities", "id": f"${{{t}}}"} for t in territories]},
        }},
        "included": [{"type": "territoryAvailabilities", "id": f"${{{t}}}", "attributes": {"available": True},
                      "relationships": {"territory": {"data": {"type": "territories", "id": t}}}} for t in territories],
    }))
    print(f"  available in {len(territories)} territories")


def prepare() -> None:
    a = app()
    app_id = a["id"]
    print(f"app {app_id}, version {VERSION}")
    version = editable_version(app_id)
    soft("copyright", lambda: call("PATCH", f"/appStoreVersions/{version['id']}", {"data": {
        "type": "appStoreVersions", "id": version["id"], "attributes": {"copyright": LISTING["copyright"]}}}))

    print("  texts")
    locs = upsert_localizations("appStoreVersionLocalizations", "appStoreVersions", version["id"], "appStoreVersionLocalizations",
                                {"description": [], "keywords": [], "promotionalText": [], "supportUrl": [], "marketingUrl": []})
    infos = call("GET", f"/apps/{app_id}/appInfos")["data"]
    info = next((i for i in infos if (i["attributes"].get("state") or i["attributes"].get("appStoreState")) not in {"READY_FOR_DISTRIBUTION", "READY_FOR_SALE"}), infos[0])
    upsert_localizations("appInfoLocalizations", "appInfos", info["id"], "appInfoLocalizations", {"name": [], "subtitle": [], "privacyPolicyUrl": []})
    soft("categories", lambda: call("PATCH", f"/appInfos/{info['id']}", {"data": {"type": "appInfos", "id": info["id"], "relationships": {
        "primaryCategory": {"data": {"type": "appCategories", "id": LISTING["primaryCategory"]}},
        "secondaryCategory": {"data": {"type": "appCategories", "id": LISTING["secondaryCategory"]}},
    }}}))

    # 4+: nothing of what the questionnaire asks about.
    rating = soft("age rating", lambda: call("GET", f"/appInfos/{info['id']}/ageRatingDeclaration"))
    if rating and rating.get("data"):
        # Each question: no (a yes/no one), or none at all (a how-much one). The
        # overrides and the kids' band are not questions.
        skip = {"kidsAgeBand", "ageRatingOverride", "ageRatingOverrideV2", "koreaAgeRatingOverride"}
        none = {k: False if isinstance(v, bool) else "NONE" for k, v in rating["data"]["attributes"].items()
                if k not in skip and (isinstance(v, (bool, str)) or v is None)}
        soft("age rating", lambda: call("PATCH", f"/ageRatingDeclarations/{rating['data']['id']}", {"data": {
            "type": "ageRatingDeclarations", "id": rating["data"]["id"], "attributes": none}}))

    free_everywhere(app_id)
    everywhere(app_id)

    files = sorted((ROOT / LISTING["screenshots"]).glob("*.png"))
    for locale, loc_id in locs.items():
        print(f"  screenshots, {locale}")
        soft(f"screenshots {locale}", lambda: screenshots(loc_id, files))

    ready = [b for b in builds(app_id, VERSION) if b["attributes"]["processingState"] == "VALID" and not b["attributes"].get("expired")]
    if ready:
        build = ready[0]
        soft("build", lambda: call("PATCH", f"/appStoreVersions/{version['id']}/relationships/build", {"data": {"type": "builds", "id": build["id"]}}))
        print(f"  build {build['attributes']['version']}")
    else:
        problems.append(f"no processed build of version {VERSION} yet")
        print(f"  ! no processed build of version {VERSION} yet")

    detail = soft("review notes", lambda: call("GET", f"/appStoreVersions/{version['id']}/appStoreReviewDetail"))
    notes = {"notes": LISTING["reviewNotes"]}
    if detail and detail.get("data"):
        soft("review notes", lambda: call("PATCH", f"/appStoreReviewDetails/{detail['data']['id']}", {"data": {
            "type": "appStoreReviewDetails", "id": detail["data"]["id"], "attributes": notes}}))
    else:
        soft("review notes", lambda: call("POST", "/appStoreReviewDetails", {"data": {
            "type": "appStoreReviewDetails", "attributes": notes,
            "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": version["id"]}}}}}))

    print("\nBy hand in App Store Connect: App Privacy; the review contact, and the Google test account (sign-in required).")
    if problems:
        sys.exit("\n".join(["Not done:"] + problems))


def submit() -> None:
    app_id = app()["id"]
    version = next((v for v in versions(app_id) if v["attributes"]["versionString"] == VERSION), None)
    if not version:
        sys.exit(f"no version {VERSION}: run prepare first")
    submission = call("POST", "/reviewSubmissions", {"data": {
        "type": "reviewSubmissions", "attributes": {"platform": "IOS"},
        "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})["data"]
    call("POST", "/reviewSubmissionItems", {"data": {"type": "reviewSubmissionItems", "relationships": {
        "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": submission["id"]}},
        "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version["id"]}}}}})
    call("PATCH", f"/reviewSubmissions/{submission['id']}", {"data": {
        "type": "reviewSubmissions", "id": submission["id"], "attributes": {"submitted": True}}})
    print(f"version {VERSION} sent to App Review (submission {submission['id']})")


if __name__ == "__main__":
    commands = {"status": status, "prepare": prepare, "submit": submit}
    if sys.argv[1:2] and sys.argv[1] in commands:
        try:
            commands[sys.argv[1]]()
        except Refused as e:
            sys.exit(str(e))
    else:
        sys.exit(__doc__)
