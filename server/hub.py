"""The app's side of the shared transcription scheduler: Eliezer's hub.

Transcription capacity is shared between Eliezer's voice messages and the app's
files, so neither decides alone when a file goes to the GPUs. Instead the hub hands
out credits (status_site/credits.py in the eliezer repo): this server registers each
transcoded file there and keeps the file; the hub grants a credit when a slot is
free, in a fair order across everyone; this server then sends the file to RunPod
(by a signed link to /download), reports progress while it runs, and returns the
credit with the outcome. Quota is the hub's too: it charges a job when registered
and refunds it if the job ends with no transcript.

On by setting HUB_URL and APP_SERVER_TOKEN; without them (local mode, development)
the server schedules in its own memory, as before.
"""

import asyncio
import contextvars
import hashlib
import hmac
import logging
import os
import socket
import time
from typing import Optional

import aiohttp
import ivrit.audio as ivrit_audio
from ivrit.types import Segment

logger = logging.getLogger("transcribe_service.hub")

HUB_URL = os.environ.get("HUB_URL", "").rstrip("/")
APP_SERVER_TOKEN = os.environ.get("APP_SERVER_TOKEN", "")
ENABLED = bool(HUB_URL and APP_SERVER_TOKEN)
INSTANCE = os.environ.get("XHOSTD_INSTANCE_ID") or socket.gethostname()

# How long RunPod may take to start fetching a file after it is submitted. Credits
# keep RunPod from queueing, so this is generous.
MEDIA_LINK_SECONDS = 6 * 3600


class HubError(Exception):
    def __init__(self, status: int, detail):
        super().__init__(f"hub answered {status}: {detail}")
        self.status = status
        self.detail = detail


def owner_of(user_email: str) -> str:
    """Who a job belongs to, at the hub: fairness, per-owner caps and quota."""
    return "e:" + user_email.strip().lower()


class HubClient:
    def __init__(self):
        self._session: Optional[aiohttp.ClientSession] = None

    def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={
                "Authorization": f"Bearer {APP_SERVER_TOKEN}",
                "X-Instance-Id": INSTANCE,
            })
        return self._session

    async def close(self):
        if self._session is not None:
            await self._session.close()

    async def _call(self, method, path, *, json=None, params=None, timeout=30, ok=(200, 201)):
        async with self._http().request(
            method, HUB_URL + path, json=json, params=params,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as response:
            try:
                body = await response.json(content_type=None)
            except ValueError:
                body = None
            if response.status not in ok:
                raise HubError(response.status, (body or {}).get("detail") if isinstance(body, dict) else body)
            return response.status, body

    async def register(self, job_id, owner, duration, *, byok, spec, max_running=1):
        """The job, with its queue position and estimate. HubError 402 (quota, with
        remaining_seconds and wait_seconds) or 429 (too many waiting) on refusal."""
        _, body = await self._call("POST", "/credits/jobs", json={
            "job_id": job_id, "owner": owner, "duration": duration, "byok": byok,
            "charge": not byok, "max_running": max_running, "spec": spec,
        })
        return body

    async def wait(self, max_jobs, wait_seconds, byok=True):
        _, body = await self._call("POST", "/credits/wait", json={
            "max": max_jobs, "wait": wait_seconds, "byok": byok,
        }, timeout=wait_seconds + 30)
        return body["grants"]

    async def progress(self, handle, *, stage=None, percent=None, eta_s=None, backend_ref=None):
        """{cancel} - or None when the credit is no longer this server's."""
        try:
            _, body = await self._call("POST", "/credits/progress", json={
                "handle": handle, "stage": stage, "percent": percent, "eta_s": eta_s,
                "backend_ref": backend_ref,
            })
        except HubError as e:
            if e.status == 409:
                return None
            raise
        return body

    async def done(self, handle, status, *, error=None, duration=None):
        """Return the credit. Retried, since a lost answer would leave the job to be
        granted again; the hub accepts a repeat."""
        for attempt in range(5):
            try:
                await self._call("POST", "/credits/done", json={
                    "handle": handle, "status": status, "error": error, "duration": duration,
                }, ok=(200, 409))
                return
            except (aiohttp.ClientError, asyncio.TimeoutError, HubError) as e:
                logger.warning("returning credit %s failed (attempt %s): %s", handle, attempt + 1, e)
                await asyncio.sleep(2 * (attempt + 1))

    async def release(self, handle):
        await self._call("POST", "/credits/release", json={"handle": handle})

    async def cancel(self, job_id, owner):
        _, body = await self._call("POST", "/credits/cancel", json={"job_id": job_id, "owner": owner})
        return body["state"]

    async def jobs(self, owner=None, ids=None):
        params = {"owner": owner} if owner else {"ids": ",".join(ids or [])}
        _, body = await self._call("GET", "/credits/jobs", params=params)
        return body["jobs"]

    async def quota(self, owner):
        _, body = await self._call("GET", "/credits/quota", params={"owner": owner})
        return body

    async def status(self):
        _, body = await self._call("GET", "/credits/status")
        return body


client = HubClient()


# --- RunPod job ids
#
# A job's RunPod id is what lets a restarted server pick up a transcription already
# running instead of paying for it twice. ivrit submits the job deep inside
# transcribe_async; this subclass reports the id to whoever started that call.

_on_submit = contextvars.ContextVar("on_runpod_submit", default=None)


class _ReportingRunPodJob(ivrit_audio.AsyncRunPodJob):
    async def submit(self):
        await super().submit()
        report = _on_submit.get()
        if report and self.job_id:
            report(self.job_id, self.endpoint_id)


ivrit_audio.AsyncRunPodJob = _ReportingRunPodJob


def report_runpod_submissions(callback):
    """Call callback(runpod_job_id, endpoint_id) for RunPod jobs this task submits."""
    _on_submit.set(callback)


async def attach_runpod(api_key, endpoint_id, runpod_job_id, poll_seconds=5):
    """The segments of a RunPod job submitted earlier, once it finishes: the worker
    keeps its whole output (return_aggregate_stream), so nothing streamed to a server
    that has since restarted is lost."""
    job = ivrit_audio.AsyncRunPodJob(api_key, endpoint_id, payload=None)
    job.job_id = runpod_job_id
    while True:
        body = await job.status_body()
        state = body.get("status")
        if state in ("IN_QUEUE", "IN_PROGRESS"):
            await asyncio.sleep(poll_seconds)
            continue
        if state != "COMPLETED":
            raise Exception(f"RunPod job {state}: {body.get('error')}")
        for chunk in body.get("output") or []:
            for entry in chunk if isinstance(chunk, list) else []:
                if entry.get("type") == "segments":
                    for element in entry["data"]:
                        yield Segment(**element)
                elif entry.get("type") == "error":
                    raise Exception(f"RunPod error: {entry.get('data')}")
        return


async def cancel_runpod(api_key, endpoint_id, runpod_job_id):
    job = ivrit_audio.AsyncRunPodJob(api_key, endpoint_id, payload=None)
    job.job_id = runpod_job_id
    try:
        await job.cancel()
    except Exception as e:
        logger.warning("cancelling RunPod job %s failed: %s", runpod_job_id, e)


# --- signed links to the media, for RunPod

def _media_key() -> bytes:
    secret = os.environ.get("MEDIA_LINK_KEY") or os.environ.get("SESSION_ENCRYPTION_KEY") or ""
    return hashlib.sha256(b"media-link:" + secret.encode()).digest()


def media_token(job_id: str, ttl: int = MEDIA_LINK_SECONDS) -> str:
    expires = int(time.time()) + ttl
    mac = hmac.new(_media_key(), f"{job_id}.{expires}".encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{mac}"


def media_token_valid(job_id: str, token: Optional[str]) -> bool:
    if not token or "." not in token:
        return False
    expires, mac = token.split(".", 1)
    if not expires.isdigit() or int(expires) < time.time():
        return False
    expected = hmac.new(_media_key(), f"{job_id}.{expires}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, expected)
