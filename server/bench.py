"""The on-device benchmark: phones transcribe ivrit.ai's benchmark recording with the
Turbo model (the app's Lab page, Benchmark.java), and post how it went here. The
transcript is scored here against the recording's reference, so every phone is
scored alike; each run gets a page of its own (/bench/?id=…), and the best verified
run of each phone makes the leaderboard (/bench/): verified runs only, once the
site can check (below); until then, every run, marked unverified.

Verified: Google Play vouched for the result (Play Integrity's standard request,
its request hash the SHA-256 of the result as posted): the genuine app from Play
(ai.ivrit.app) on a phone that passes Google's device check. The app asks for that
with the Google Cloud project linked to the app in the Play Console
(PLAY_INTEGRITY_PROJECT, its number), and the site decodes the token with a service
account of that project (PLAY_INTEGRITY_SERVICE_ACCOUNT, its JSON key). Without
them runs are kept, unverified, and stay off the leaderboard.

The recording: ivrit-ai/turbo-benchmark on Hugging Face (from the eval-d1 set);
bench/benchmark-he.txt is its reference.
"""

import hashlib
import json
import logging
import os
import re
import secrets
import time
from pathlib import Path

import aiohttp
import jwt
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

BENCHMARK = "benchmark-he"
AUDIO_SECONDS = 297.0
REFERENCE = (Path(__file__).parent / "bench" / f"{BENCHMARK}.txt").read_text(encoding="utf-8")
MAX_BODY = 64 * 1024
PACKAGE = "ai.ivrit.app"
INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity"
INTEGRITY_MAX_AGE_MS = 10 * 60 * 1000


def words(text: str) -> list:
    """Words to compare: punctuation dropped, in order."""
    return re.sub(r"[^\w\s]", " ", text).split()


def word_error_rate(reference: list, hypothesis: list) -> float:
    """Word-level edit distance over the reference's length."""
    previous = list(range(len(hypothesis) + 1))
    for i, r in enumerate(reference, 1):
        current = [i] + [0] * len(hypothesis)
        for j, h in enumerate(hypothesis, 1):
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h))
        previous = current
    return previous[-1] / len(reference)


def text(value, limit: int) -> str:
    return str(value or "")[:limit]


def public(row) -> dict:
    """A run as its page and the leaderboard show it: the phone's report, less its transcript."""
    body = json.loads(row["body"])
    body.pop("transcript", None)
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "wer": row["wer"],
        "verified": bool(row["verified"]),
        **body,
    }


def judge(payload: dict, digest: str, now_ms: float) -> dict:
    """A decoded Play Integrity token's verdicts, and whether they vouch for this result: the
    genuine app from Play, on a phone meeting Google's device check, for this very result
    (its hash), lately."""
    request = payload.get("requestDetails", {})
    app = payload.get("appIntegrity", {})
    device = payload.get("deviceIntegrity", {}).get("deviceRecognitionVerdict", [])
    fresh = abs(now_ms - float(request.get("timestampMillis", 0))) < INTEGRITY_MAX_AGE_MS
    verdict = {
        "app": app.get("appRecognitionVerdict"),
        "device": device,
        "fresh": fresh,
        "matches": request.get("requestHash") == digest and request.get("requestPackageName") == PACKAGE,
    }
    verdict["verified"] = (
        verdict["matches"] and fresh and verdict["app"] == "PLAY_RECOGNIZED" and "MEETS_DEVICE_INTEGRITY" in device
    )
    return verdict


class Integrity:
    """Play Integrity tokens decoded with the project's service account, its access token kept until it ends."""

    def __init__(self, project: str, account: str):
        self.project = int(project) if project.strip().isdigit() else None
        self.account = json.loads(account) if account.strip() else None
        self.access = ("", 0.0)

    def available(self) -> bool:
        return bool(self.project and self.account)

    async def token(self, http: aiohttp.ClientSession) -> str:
        if self.access[1] > time.time() + 60:
            return self.access[0]
        now = int(time.time())
        assertion = jwt.encode(
            {
                "iss": self.account["client_email"],
                "scope": INTEGRITY_SCOPE,
                "aud": "https://oauth2.googleapis.com/token",
                "iat": now,
                "exp": now + 3600,
            },
            self.account["private_key"],
            algorithm="RS256",
        )
        async with http.post(
            "https://oauth2.googleapis.com/token",
            data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        ) as r:
            body = await r.json()
        self.access = (body["access_token"], now + float(body.get("expires_in", 3600)))
        return self.access[0]

    async def verify(self, integrity_token: str, digest: str) -> dict:
        """What Google Play said of the token: {verified, …the verdicts}."""
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as http:
            access = await self.token(http)
            async with http.post(
                f"https://playintegrity.googleapis.com/v1/{PACKAGE}:decodeIntegrityToken",
                headers={"Authorization": f"Bearer {access}"},
                json={"integrity_token": integrity_token},
            ) as r:
                body = await r.json()
                if r.status != 200:
                    logger.warning(
                        "Play Integrity refused a token: %s %s", r.status, body.get("error", {}).get("message")
                    )
                    return {"verified": False, "reason": "refused"}
        return judge(body.get("tokenPayloadExternal", {}), digest, time.time() * 1000)


def install(app: FastAPI, db):
    integrity = Integrity(
        os.environ.get("PLAY_INTEGRITY_PROJECT", ""), os.environ.get("PLAY_INTEGRITY_SERVICE_ACCOUNT", "")
    )

    @app.get("/bench/config", include_in_schema=False)
    async def bench_config():
        # What the app asks Play to vouch with: the linked Cloud project's number.
        return JSONResponse({"cloudProjectNumber": integrity.project if integrity.available() else None})

    @app.post("/bench/results", include_in_schema=False)
    async def bench_post(request: Request):
        raw = await request.body()
        if len(raw) > MAX_BODY:
            return JSONResponse({"error": "too_large"}, status_code=413)
        try:
            # The result as the phone made it (the string Play's token is bound to), and the token.
            posted = json.loads(raw)
            result = posted["result"]
            body = json.loads(result)
            seconds = float(body["seconds"])
            audio = float(body["audioSeconds"])
            transcript = text(body["transcript"], 20000)
            device = body["device"]
            name = f"{text(device.get('manufacturer'), 40)} {text(device.get('model'), 60)}".strip()
        except (ValueError, KeyError, TypeError, AttributeError):
            return JSONResponse({"error": "bad_request"}, status_code=400)
        # This recording, really transcribed: its length, a time it could take.
        if abs(audio - AUDIO_SECONDS) > 2 or not 1 < seconds < 6 * 3600 or not name:
            return JSONResponse({"error": "bad_request"}, status_code=400)
        verdict = {"verified": False, "reason": "unsigned"}
        if isinstance(posted.get("integrity"), str) and integrity.available():
            try:
                verdict = await integrity.verify(posted["integrity"], hashlib.sha256(result.encode()).hexdigest())
            except (aiohttp.ClientError, KeyError, ValueError, TimeoutError) as e:
                logger.warning("Play Integrity could not be asked: %s", e)
                verdict = {"verified": False, "reason": "unchecked"}
        body["integrity"] = verdict
        wer = word_error_rate(words(REFERENCE), words(transcript))
        run_id = secrets.token_urlsafe(6)
        await db.add_bench_result(
            run_id,
            int(time.time()),
            BENCHMARK,
            name,
            text(body.get("engine"), 60),
            text(body.get("app"), 40),
            seconds,
            wer,
            bool(verdict["verified"]),
            json.dumps(body, ensure_ascii=False),
        )
        logger.info(
            json.dumps(
                {
                    "msg": "bench_result",
                    "id": run_id,
                    "device": name,
                    "seconds": seconds,
                    "wer": wer,
                    "integrity": verdict,
                }
            )
        )
        return JSONResponse({"id": run_id, "wer": wer, "verified": bool(verdict["verified"])})

    @app.get("/bench/results/{run_id}", include_in_schema=False)
    async def bench_get(run_id: str):
        row = await db.get_bench_result(run_id[:20])
        if not row:
            return JSONResponse({"error": "not_found"}, status_code=404)
        return JSONResponse(public(row), headers={"Cache-Control": "no-cache"})

    @app.get("/bench/top", include_in_schema=False)
    async def bench_top():
        # Until the site can check Play's word (PLAY_INTEGRITY_*), every run, marked unverified.
        rows = await db.bench_board(BENCHMARK, integrity.available(), 200)
        return JSONResponse(
            {"benchmark": BENCHMARK, "audioSeconds": AUDIO_SECONDS, "runs": [public(r) for r in rows]},
            headers={"Cache-Control": "no-cache"},
        )
