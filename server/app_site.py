"""The ivrit.ai app's own site, served by this server at app.ivrit.ai: its pages
(web/), its configuration, Android's site verification, and its sign-in sessions
(app_sessions.py). Transcription's API lives alongside, in app.py.

install_routes() adds the routes; mount_pages() must come last, after every other
route, since it serves whatever path is left from web/.
"""

import json
import logging
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.staticfiles import StaticFiles

logger = logging.getLogger("transcribe_service.app_site")

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = Path(os.environ.get("APP_WEB_DIR") or ROOT / "web")
SHARED_DIR = ROOT / "shared"


def available() -> bool:
    return (WEB_DIR / "index.html").exists()


def _app_config() -> dict:
    with open(SHARED_DIR / "app.json", encoding="utf-8") as f:
        return json.load(f)


class Pages(StaticFiles):
    """web/, revalidated on every use (cheap, by ETag) so a fix reaches the Android
    app on its next open; fonts and icons, which never change in place, are kept
    for a day."""

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        lasting = str(full_path).endswith((".woff2", ".png", ".svg"))
        response.headers["Cache-Control"] = "public, max-age=86400" if lasting else "no-cache"
        return response


def make_sessions(google_client_id: Optional[str]):
    from app_sessions import Sessions

    key = os.environ.get("APP_SESSION_KEY")
    if not key or not google_client_id:
        logger.warning("App sign-in is off: APP_SESSION_KEY or GOOGLE_CLIENT_ID is not set")
        return None
    issuer = os.environ.get("APP_SESSION_ISSUER") or f"https://{_app_config()['host']}"
    return Sessions(issuer, google_client_id, key, os.environ.get("GOOGLE_JWKS_URL"))


def install_routes(app: FastAPI, google_client_id: Optional[str]):
    app_json = _app_config()
    # Where the app's services live. Overridable for staging; the defaults are the
    # public addresses, which are not secrets.
    config = {
        "communicator": (os.environ.get("COMMUNICATOR_URL") or app_json["communicator"]).rstrip("/"),
        "transcribe": (os.environ.get("TRANSCRIBE_URL") or app_json["transcribe"]).rstrip("/"),
        "eliezer": (os.environ.get("ELIEZER_URL") or app_json["eliezer"]).rstrip("/"),
        # The site's OAuth client: Google issues the app's ID tokens to it.
        "googleClientId": google_client_id or None,
    }
    config_js = f"self.IVRIT_CONFIG = {json.dumps(config)};\n"
    sessions = make_sessions(google_client_id)
    app.state.app_sessions = sessions

    @app.get("/config.js", include_in_schema=False)
    async def config_script():
        return Response(config_js, media_type="application/javascript", headers={"Cache-Control": "no-cache"})

    # Android checks this to let the app open app.ivrit.ai without browser UI.
    @app.get("/.well-known/assetlinks.json", include_in_schema=False)
    async def assetlinks():
        path = SHARED_DIR / "assetlinks.json"
        if not path.exists():
            return JSONResponse([], status_code=404)
        return FileResponse(path, media_type="application/json")

    @app.get("/.well-known/jwks.json", include_in_schema=False)
    async def jwks():
        if sessions is None:
            return JSONResponse({"keys": []}, status_code=404)
        return JSONResponse(sessions.jwks, headers={"Cache-Control": "public, max-age=3600"})

    # Signing in: a Google ID token in, a session out; and renewing a session.
    @app.post("/auth/google", include_in_schema=False)
    async def auth_google(request: Request):
        if sessions is None:
            return JSONResponse({"error": "sign_in_unavailable"}, status_code=503)
        try:
            body = await request.json()
            id_token = str((body or {}).get("idToken") or "")
            return JSONResponse(await run_in_threadpool(sessions.from_google, id_token))
        except Exception as e:
            logger.warning(json.dumps({"msg": "google_sign_in_rejected", "err": type(e).__name__}))
            return JSONResponse({"error": "invalid_token"}, status_code=401)

    @app.post("/auth/renew", include_in_schema=False)
    async def auth_renew(request: Request):
        if sessions is None:
            return JSONResponse({"error": "sign_in_unavailable"}, status_code=503)
        header = request.headers.get("authorization", "")
        try:
            return JSONResponse(sessions.renew(header[7:] if header.startswith("Bearer ") else ""))
        except Exception:
            return JSONResponse({"error": "invalid_session"}, status_code=401)

    @app.get("/privacy", include_in_schema=False)
    async def privacy():
        return FileResponse(WEB_DIR / "privacy.html", headers={"Cache-Control": "no-cache"})

    # Google Play's account deletion page: how to delete, with or without the app.
    @app.get("/delete-account", include_in_schema=False)
    async def delete_account():
        return FileResponse(WEB_DIR / "delete-account.html", headers={"Cache-Control": "no-cache"})

    # The on-device transcription lab (web/lab/): its probe and benchmark pages post
    # their results here, and they land in the log, one JSON line each.
    @app.post("/lab/report", include_in_schema=False)
    async def lab_report(request: Request, kind: str = ""):
        raw = (await request.body())[: 2 * 1024 * 1024].decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except ValueError:
            body = raw
        logger.info(json.dumps({"msg": "lab_report", "kind": kind[:20], "ua": request.headers.get("user-agent"),
                                "body": body}, ensure_ascii=False))
        return Response(status_code=204)


def mount_pages(app: FastAPI):
    # The lab's quantized models, made at start-up into LAB_MODELS_DIR
    # (scripts/lab_models.py); missing until then.
    lab_models = os.environ.get("LAB_MODELS_DIR")
    if lab_models:
        os.makedirs(lab_models, exist_ok=True)
        app.mount("/lab/models", Pages(directory=lab_models), name="lab-models")
    app.mount("/", Pages(directory=WEB_DIR, html=True), name="pages")
