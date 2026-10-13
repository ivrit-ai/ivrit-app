"""End to end: the server in hub mode, scheduled by Eliezer's hub.

Runs the real hub (from the eliezer repo, against a throwaway Postgres), the real
server (tests/hub_harness.py: Drive is a local directory, RunPod is a fake here),
and uploads files through the server's own API with a real session cookie. Checks:
a file goes upload -> transcode -> hub -> credit -> RunPod (by a signed link) ->
Drive; the quota is the hub's; a second user's file waits for the one RunPod slot
and shows its place; a server killed mid-job picks the job up again from RunPod
without a second run; a file lost with its server fails cleanly and is refunded.
Folders in My files: made, nested, renamed, deleted; a file transcribed into one;
moved between them; a readable copy beside each transcript, refreshed on edits; a
folder that is not the user's refused; a job surviving a crash lands in its folder.
Search: each folder's index written on completion, edits, moves and deletes, and
caught up when lost or edited elsewhere; the manifest lists them by version.

    ELIEZER_DIR=~/dev/eliezer ELIEZER_PYTHON=<python with the hub's requirements> \\
        python tests/test_hub_mode.py
"""

import gzip
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg
from cryptography.fernet import Fernet

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
ELIEZER = os.path.expanduser(os.environ.get("ELIEZER_DIR", "~/dev/eliezer"))
ELIEZER_PYTHON = os.environ.get("ELIEZER_PYTHON", sys.executable)
WORK = tempfile.mkdtemp(prefix="hub-mode-")
TOKEN = "app-server-token"
SESSION_KEY = Fernet.generate_key().decode()
APP_SESSION_KEY = subprocess.run(
    ["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"],
    capture_output=True, text=True, check=True).stdout
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)


def free_port():
    s = socket.socket()
    s.bind(("", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_until(predicate, timeout, step=0.5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return None


# --- a fake RunPod: fetches the file by the link it is given, then "transcribes" it

class FakeRunPod:
    def __init__(self):
        self.jobs = {}
        self.runs = 0
        self.fetches = []
        self.delay = 1.0
        self.lock = threading.Lock()

    def submit(self, payload):
        def find_url(value):
            if isinstance(value, str) and value.startswith("http"):
                return value
            if isinstance(value, dict):
                value = list(value.values())
            if isinstance(value, list):
                for v in value:
                    found = find_url(v)
                    if found:
                        return found
            return None

        url = find_url(payload)
        job_id = "rp-" + uuid.uuid4().hex[:8]
        with self.lock:
            self.runs += 1
            self.jobs[job_id] = {"status": "IN_QUEUE", "url": url, "streamed": False, "size": 0}
        threading.Thread(target=self._work, args=(job_id, self.delay), daemon=True).start()
        return job_id

    def _work(self, job_id, delay):
        job = self.jobs[job_id]
        job["status"] = "IN_PROGRESS"
        try:
            with urllib.request.urlopen(job["url"], timeout=10) as r:
                job["size"] = len(r.read())
            self.fetches.append((job["url"], 200))
        except urllib.error.HTTPError as e:
            self.fetches.append((job["url"], e.code))
            job["status"] = "FAILED"
            job["error"] = f"download {e.code}"
            return
        time.sleep(delay)
        if job["status"] == "IN_PROGRESS":
            job["status"] = "COMPLETED"

    def output(self, job_id):
        n = self.jobs[job_id]["size"]
        return [[{"type": "segments", "data": [{
            "text": f"תמלול של {n} בתים", "start": 0.0, "end": 2.0, "speakers": ["SPEAKER_00"],
            "words": [{"word": "תמלול", "start": 0.0, "end": 1.0, "probability": 0.9, "speaker": "SPEAKER_00"}],
        }]}]]


rp = FakeRunPod()


class RunPodHandler(BaseHTTPRequestHandler):
    def _send(self, body, status=200):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        parts = self.path.strip("/").split("/")  # v2, endpoint, action[, id]
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if parts[2] == "run":
            return self._send({"id": rp.submit(body), "status": "IN_QUEUE"})
        if parts[2] == "cancel":
            rp.jobs[parts[3]]["status"] = "CANCELLED"
            return self._send({"status": "CANCELLED"})
        self._send({}, 404)

    def do_GET(self):
        parts = self.path.strip("/").split("/")
        job = rp.jobs.get(parts[3]) if len(parts) > 3 else None
        if job is None:
            return self._send({"error": "not found"}, 404)
        if parts[2] == "status":
            body = {"status": job["status"], "delayTime": 1, "executionTime": 1, "error": job.get("error")}
            if job["status"] == "COMPLETED":
                body["output"] = rp.output(parts[3])
            return self._send(body)
        if parts[2] == "stream":
            if job["status"] != "COMPLETED":
                state = job["status"] if job["status"] != "IN_QUEUE" else "IN_PROGRESS"
                time.sleep(0.5)
                return self._send({"status": state, "stream": []})
            stream = [] if job["streamed"] else [{"output": chunk} for chunk in rp.output(parts[3])]
            job["streamed"] = True
            return self._send({"status": "COMPLETED", "stream": stream})
        self._send({}, 404)

    def log_message(self, *a):
        pass


# --- helpers for the server's API

def cookie_for(email):
    session = {"user_email": email, "refresh_token": "rt-" + email.split("@")[0], "runpod_token": "",
               "runpod_key_load_failed": False, "v": 1}
    return "__Host-session=" + Fernet(SESSION_KEY.encode()).encrypt(json.dumps(session).encode()).decode()


class Api:
    def __init__(self, base):
        self.base = base

    def call(self, method, path, email=None, body=None, raw=None, headers=None, timeout=60):
        h = dict(headers or {})
        if email:
            h["Cookie"] = cookie_for(email)
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def upload(self, email, path, name, folder=None, token=None, extra=()):
        boundary = uuid.uuid4().hex
        with open(path, "rb") as f:
            content = f.read()
        parts = []
        fields = [("language", "he"), ("save_audio", "true")] + ([("folder", folder)] if folder else []) + list(extra)
        for key, value in fields:
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                     f"Content-Type: audio/ogg\r\n\r\n".encode() + content + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
        if token:
            headers["Authorization"] = "Bearer " + token
        status, body = self.call("POST", "/upload", None if token else email, raw=b"".join(parts),
                                 headers=headers, timeout=120)
        events = [json.loads(line) for line in body.decode().splitlines() if line.strip()] if status == 200 else []
        return status, events, body

    def toc(self, email, folder=None):
        query = "?folder=" + urllib.parse.quote(folder, safe="") if folder else ""
        status, body = self.call("GET", "/appdata/toc" + query, email)
        return json.loads(body)["entries"] if status == 200 else None

    def folders(self, email):
        status, body = self.call("GET", "/appdata/folders", email)
        return json.loads(body) if status == 200 else None


def entry_for(api, email, name, folder=None):
    for e in api.toc(email, folder) or []:
        if e.get("source_filename") == name:
            return e
    return None


def search_shard(api, email, shard="top"):
    """(docs, pending) of one search index."""
    status, body = api.call("GET", f"/appdata/search/index?shard={urllib.parse.quote(shard, safe='')}", email)
    if status != 200:
        return None, None
    return json.loads(gzip.decompress(body))["docs"], None


def ready(api, email, name, folder=None):
    e = entry_for(api, email, name, folder)
    return e if e and e.get("status") in ("Ready", "Failed") else None


def q(folder):
    return urllib.parse.quote(folder, safe="")


def main():
    pg_port, hub_port, app_port, rp_port = free_port(), free_port(), free_port(), free_port()
    container = "hub-mode-pg"
    subprocess.run(["docker", "rm", "-f", container], capture_output=True)
    subprocess.run(["docker", "run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=pw",
                    "-p", f"127.0.0.1:{pg_port}:5432", "postgres:16-alpine"], check=True, capture_output=True)
    wait_until(lambda: subprocess.run(["docker", "exec", container, "pg_isready", "-U", "postgres"],
                                      capture_output=True).returncode == 0, 30)
    time.sleep(1)
    subprocess.run(["docker", "exec", container, "psql", "-U", "postgres", "-c", "CREATE DATABASE app;"],
                   check=True, capture_output=True)
    hub_db = f"postgresql://postgres:pw@127.0.0.1:{pg_port}/postgres"
    app_db = f"postgresql://postgres:pw@127.0.0.1:{pg_port}/app"

    rp_server = ThreadingHTTPServer(("127.0.0.1", rp_port), RunPodHandler)
    threading.Thread(target=rp_server.serve_forever, daemon=True).start()

    # The hub: one RunPod slot, credits that lapse quickly.
    hub_env = dict(os.environ, DATABASE_URL=hub_db, QUEUE_TOKEN="queue-token", APP_SERVER_TOKEN=TOKEN,
                   CREDIT_POOLS="runpod=1", CREDIT_LEASE_SECONDS="6", QUEUE_SWEEP_INTERVAL_SECONDS="1",
                   PORT=str(hub_port), WHATSAPP_GRAPH_URL="http://127.0.0.1:9", TELEGRAM_API_URL="http://127.0.0.1:9")
    hubdir = os.path.join(ELIEZER, "status_site")
    subprocess.run([ELIEZER_PYTHON, "-c", "import app; app.init_db(); app.init_queue_db()"],
                   cwd=hubdir, env=hub_env, check=True)
    hub = subprocess.Popen([ELIEZER_PYTHON, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port",
                            str(hub_port), "--no-access-log"], cwd=hubdir, env=hub_env,
                           stdout=open(os.path.join(WORK, "hub.log"), "w"), stderr=subprocess.STDOUT)

    data = os.path.join(WORK, "drive")
    tmp = os.path.join(WORK, "tmp")
    os.makedirs(tmp)
    app_env = dict(
        os.environ, TS_XHOST_MODE="1", DATABASE_URL=app_db, BASE_URL=f"http://127.0.0.1:{app_port}",
        GOOGLE_CLIENT_ID="test-client", GOOGLE_CLIENT_SECRET="test-secret", SESSION_ENCRYPTION_KEY=SESSION_KEY,
        RUNPOD_API_KEY="rp-key", RUNPOD_ENDPOINT_ID="ep-shared", RUNPOD_KEY_ENCRYPTION_KEY=Fernet.generate_key().decode(),
        HUB_URL=f"http://127.0.0.1:{hub_port}", APP_SERVER_TOKEN=TOKEN, HARNESS_DATA=data,
        HARNESS_RUNPOD_URL=f"http://127.0.0.1:{rp_port}", TMPDIR=tmp, APP_SESSION_KEY=APP_SESSION_KEY,
        DOC_REFRESH_DELAY_SECONDS="0.3",
    )
    log = open(os.path.join(WORK, "app.log"), "a")

    def start_app():
        process = subprocess.Popen([sys.executable, os.path.join(HERE, "hub_harness.py"), str(app_port)],
                                   cwd=SERVER, env=app_env, stdout=log, stderr=subprocess.STDOUT)
        api = Api(f"http://127.0.0.1:{app_port}")
        if not wait_until(lambda: _alive(api), 60):
            raise RuntimeError("server did not start; see " + log.name)
        return process, api

    def _alive(api):
        try:
            return api.call("GET", "/login")[0] == 200
        except OSError:
            return False

    fixtures = os.path.join(WORK, "audio")
    os.makedirs(fixtures)

    def make_audio(name, seconds):
        path = os.path.join(fixtures, name)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                        f"sine=frequency=440:duration={seconds}", "-c:a", "libopus", "-b:a", "24k", path], check=True)
        return path

    app_process = None
    hubq = psycopg.connect(hub_db, autocommit=True)
    try:
        app_process, api = start_app()

        # --- the app's own site, on the same server
        def get(path, **kw):
            r = urllib.request.Request(api.base + path, **kw)
            try:
                with urllib.request.urlopen(r, timeout=10) as resp:
                    return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
            except urllib.error.HTTPError as e:
                return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
        status, headers, body = get("/")
        check("/ is the app's page", status == 200 and b"app.js" in body and headers.get("cache-control") == "no-cache",
              (status, headers.get("cache-control")))
        status, headers, _ = get("/icons/icon-192.png")
        check("icons are cached for a day", status == 200 and "max-age=86400" in headers.get("cache-control", ""), headers)
        status, headers, body = get("/config.js")
        check("/config.js names the app's client", status == 200 and b'"googleClientId": "test-client"' in body, body)
        status, _, body = get("/sw.js")
        check("/sw.js is the app's worker", status == 200 and body == open(os.path.join(SERVER, "..", "web", "sw.js"), "rb").read())
        status, headers, body = get("/transcribe")
        check("/transcribe leads to the app's Transcribe tab (its page, followed)",
              status == 200 and b"app.js" in body, status)
        status, _, body = get("/.well-known/jwks.json")
        check("the session keys are published", status == 200 and json.loads(body)["keys"][0]["kid"], body[:100])
        status, _, body = get("/auth/google", data=b'{"idToken": "a.b.c"}', method="POST",
                              headers={"Content-Type": "application/json"})
        check("a bad Google token is refused", status == 401, (status, body))
        sys.path.insert(0, SERVER)
        from app_sessions import Sessions
        token = Sessions(f"https://app.ivrit.ai", "test-client", APP_SESSION_KEY).issue("s1", "s1@example.com")["token"]
        status, _, body = get("/auth/renew", method="POST", headers={"Authorization": "Bearer " + token})
        renewed = json.loads(body) if status == 200 else {}
        check("a session renews, for 90 days", renewed.get("token")
              and renewed["expires_at"] > (time.time() + 89 * 86400) * 1000, (status, body[:100]))
        status, _, _ = get("/auth/renew", method="POST", headers={"Authorization": "Bearer " + token[:-4] + "AAAA"})
        check("a forged session does not", status == 401, status)
        status, _, _ = get("/languages")
        check("the transcription API still wants a sign-in", status == 401, status)

        # --- one file, all the way to Drive
        rp.delay = 1.0
        status, events, raw = api.upload("ada@example.com", make_audio("one.ogg", 30), "one.ogg")
        kinds = [e.get("type") or e.get("event") for e in events]
        check("upload accepted and transcoded", status == 200 and "transcoding_complete" in kinds, (status, raw[:300]))
        done = wait_until(lambda: (lambda e: e if e and e.get("status") in ("Ready", "Failed") else None)(
            entry_for(api, "ada@example.com", "one.ogg")), 60)
        check("the file is transcribed and listed as Ready", done and done["status"] == "Ready", done)
        check("RunPod fetched the file by a signed link",
              rp.fetches and rp.fetches[0][1] == 200 and "?t=" in rp.fetches[0][0], rp.fetches)
        job_id = done["job_id"] if done else ""
        status, _ = api.call("GET", f"/download/{job_id}")
        check("the file cannot be fetched without the signature", status == 404, status)
        if done:
            results_path = os.path.join(data, "rt-ada", f"{done['results_id']}.json.gz")
            saved = json.loads(gzip.decompress(open(results_path, "rb").read())) if os.path.exists(results_path) else {}
            check("the transcript is saved to the user's Drive", saved.get("results")
                  and saved["results"][0]["text"].startswith("תמלול"), saved)
            check("...with the audio", os.path.exists(os.path.join(data, "rt-ada", f"{done['results_id']}.opus")))
        status, body = api.call("GET", "/quota", "ada@example.com")
        quota = json.loads(body)
        check("the quota is the hub's, charged for the file",
              status == 200 and quota["maxMinutesPerWeek"] - 0.6 < quota["remainingMinutes"] < quota["maxMinutesPerWeek"] - 0.4,
              quota)
        hub_job = hubq.execute("SELECT status, lane FROM credit_jobs WHERE job_id = %s", (job_id,)).fetchone()
        check("the hub has the job as done", hub_job == ("done", "file_short"), hub_job)

        # --- folders in My files
        ada = os.path.join(data, "rt-ada")
        docs = [n for n in os.listdir(ada) if n.endswith(".html")]
        check("a readable copy is made beside the transcript", done and done.get("doc_id")
              and len(docs) == 1 and "תמלול" in open(os.path.join(ada, docs[0]), encoding="utf-8").read(), (docs, done))
        indexed = wait_until(lambda: (search_shard(api, "ada@example.com")[0] or {}).get((done or {}).get("results_id")), 10)
        check("the transcript is in the top folder's search index, with its text",
              indexed and indexed["segments"] and "תמלול" in indexed["segments"][0][2] and indexed["title"] == "one.ogg", indexed)
        status, body = api.call("GET", "/appdata/search/manifest", "ada@example.com")
        manifest = json.loads(body) if status == 200 else {}
        check("the manifest lists the index by its version", any(sh["shard"] == "top" and sh["version"] for sh in manifest.get("shards", [])),
              manifest)
        os.unlink(os.path.join(ada, "search.json.gz"))
        rebuilt, _ = search_shard(api, "ada@example.com")
        check("a lost index is made again from the toc", rebuilt and (done or {}).get("results_id") in rebuilt, rebuilt)
        if done:
            # An edit made elsewhere (the old site writes no index): caught up on the next look.
            with open(os.path.join(ada, f"{done['results_id']}.edits.json.gz"), "wb") as f:
                f.write(gzip.compress(json.dumps({"edits": {"0": "נערך באתר הישן"}, "speakerNames": {}, "speakerSwaps": {}}).encode()))
            caught = (search_shard(api, "ada@example.com")[0] or {}).get(done["results_id"], {})
            check("an edit made elsewhere is caught up", caught.get("segments") and caught["segments"][0][2] == "נערך באתר הישן", caught)
        tree = api.folders("ada@example.com")
        check("no folders at first, and the top folder named", tree and tree["top"] and tree["folders"] == [], tree)
        status, body = api.call("POST", "/appdata/folders", "ada@example.com", body={"name": "Calls"})
        calls = json.loads(body) if status == 201 else {}
        status, body = api.call("POST", "/appdata/folders", "ada@example.com", body={"name": "2026", "parent": calls.get("id")})
        year = json.loads(body) if status == 201 else {}
        check("folders are made, and nest", calls.get("parent") == tree["top"] and year.get("parent") == calls.get("id"),
              (calls, year))
        status, _ = api.call("POST", "/appdata/folders", "ada@example.com", body={"name": "Calls"})
        check("...not twice under one name", status == 409, status)
        status, _ = api.call("POST", "/appdata/folders", "ada@example.com", body={"name": "a/b"})
        check("...nor with a path for a name", status == 400, status)
        names = {f["name"]: f["parent"] for f in api.folders("ada@example.com")["folders"]}
        check("the folder tree lists them with their parents", names == {"Calls": tree["top"], "2026": calls["id"]}, names)

        rp.delay = 1.0
        status, events, raw = api.upload("ada@example.com", make_audio("call.ogg", 20), "call.ogg", folder=calls["id"])
        call = wait_until(lambda: ready(api, "ada@example.com", "call.ogg", calls["id"]), 60)
        check("a file uploaded into a folder is transcribed there", call and call["status"] == "Ready", (call, raw[:200]))
        check("...and not in the top folder", entry_for(api, "ada@example.com", "call.ogg") is None)
        if call:
            rid = call["results_id"]
            check("...its files in that folder in Drive", all(os.path.exists(os.path.join(calls["id"], f"{rid}{ext}"))
                                                             for ext in (".json.gz", ".opus")) and call.get("doc_id", "").startswith(calls["id"]),
                  os.listdir(calls["id"]))
            status, _ = api.call("GET", f"/appdata/results/{rid}?folder={q(calls['id'])}", "ada@example.com")
            status_top, _ = api.call("GET", f"/appdata/results/{rid}", "ada@example.com")
            check("its transcript is read by its folder (and not found elsewhere)", (status, status_top) == (200, 404),
                  (status, status_top))
            status, _ = api.call("POST", f"/appdata/edits/{rid}?folder={q(calls['id'])}", "ada@example.com",
                                 body={"edits": {"0": "שורה ערוכה"}, "speakerNames": {}, "speakerSwaps": {}})
            refreshed = wait_until(lambda: "שורה ערוכה" in open(entry_for(api, "ada@example.com", "call.ogg", calls["id"])["doc_id"],
                                                                 encoding="utf-8").read(), 10)
            check("an edit reaches the readable copy", status == 200 and refreshed, status)
            in_calls = wait_until(lambda: ((search_shard(api, "ada@example.com", calls["id"])[0] or {}).get(rid) or {}).get("segments", [[0, "", ""]])[0][2] == "שורה ערוכה", 10)
            check("...and the folder's search index", in_calls)
            status, _ = api.call("POST", "/appdata/move", "ada@example.com",
                                 body={"results_id": rid, "from": calls["id"], "to": year["id"]})
            moved = entry_for(api, "ada@example.com", "call.ogg", year["id"])
            check("a transcript moves between folders, with its files and its copy",
                  status == 200 and moved and entry_for(api, "ada@example.com", "call.ogg", calls["id"]) is None
                  and os.path.exists(os.path.join(year["id"], f"{rid}.json.gz"))
                  and os.path.exists(os.path.join(year["id"], f"{rid}.edits.json.gz"))
                  and moved.get("doc_id", "").startswith(year["id"]), (status, moved))
            status, _ = api.call("GET", f"/appdata/edits/{rid}?folder={q(year['id'])}", "ada@example.com")
            check("...and is read from there", status == 200, status)
            check("...its search entry moving with it", rid in (search_shard(api, "ada@example.com", year["id"])[0] or {})
                  and rid not in (search_shard(api, "ada@example.com", calls["id"])[0] or {}))
            status, _ = api.call("POST", f"/appdata/delete?folder={q(year['id'])}", "ada@example.com", body={"results_id": rid})
            check("a deleted transcript leaves the index", status == 200 and rid not in (search_shard(api, "ada@example.com", year["id"])[0] or {}),
                  status)

        status, body = api.call("POST", "/appdata/folders", "bea@example.com", body={"name": "Bea's"})
        beas = json.loads(body) if status == 201 else {}
        status, _ = api.call("GET", f"/appdata/toc?folder={q(beas.get('id', 'x'))}", "ada@example.com")
        status_move, _ = api.call("POST", "/appdata/move", "ada@example.com",
                                  body={"results_id": (done or {}).get("results_id"), "to": beas.get("id")})
        check("another user's folder is refused", (status, status_move) == (404, 404), (status, status_move))

        status, body = api.call("POST", f"/appdata/folders/{q(calls['id'])}/rename", "ada@example.com", body={"name": "Meetings"})
        names = {f["name"] for f in api.folders("ada@example.com")["folders"]}
        check("a folder is renamed", status == 200 and names == {"Meetings", "2026"}, (status, names))
        meetings = next(f for f in api.folders("ada@example.com")["folders"] if f["name"] == "Meetings")
        status, _ = api.call("DELETE", f"/appdata/folders/{q(meetings['id'])}", "ada@example.com")
        check("a folder goes to the trash with what is in it", status == 200 and api.folders("ada@example.com")["folders"] == []
              and os.listdir(os.path.join(ada, ".trash")), status)
        status, _ = api.call("DELETE", f"/appdata/folders/{q(tree['top'])}", "ada@example.com")
        check("...but never the top folder", status == 400, status)

        # --- the Android app's watched folders: uploads with the app's own session, once each
        from app_sessions import Sessions
        ada_token = Sessions("https://app.ivrit.ai", "test-client", APP_SESSION_KEY).issue("ada-sub", "ada@example.com")["token"]
        upload_id = "watch-" + uuid.uuid4().hex
        watched = make_audio("watched.ogg", 15)
        status, events, raw = api.upload(None, watched, "watched.ogg", token=ada_token,
                                         extra=(("origin", "watch"), ("upload_id", upload_id)))
        check("an upload with the app's session token, no cookie, is taken",
              status == 200 and any(e.get("type") == "transcoding_complete" for e in events), (status, raw[:200]))
        status, events, raw = api.upload(None, watched, "watched.ogg", token=ada_token,
                                         extra=(("origin", "watch"), ("upload_id", upload_id)))
        check("...and the same upload again makes no second job",
              status == 200 and events and events[0].get("duplicate"), (status, raw[:200]))
        status, _, _ = api.upload(None, watched, "watched.ogg", token=ada_token[:-4] + "AAAA")
        check("...while a forged token is refused", status == 401, status)
        w = wait_until(lambda: ready(api, "ada@example.com", "watched.ogg"), 60)
        check("it is transcribed once, marked as from a watched folder",
              w and w.get("origin") == "watch" and sum(1 for e in api.toc("ada@example.com") if e.get("source_filename") == "watched.ogg") == 1, w)
        if w:
            doc = wait_until(lambda: (search_shard(api, "ada@example.com")[0] or {}).get(w["results_id"]), 10)
            check("...in search too", doc and doc.get("origin") == "watch", doc)

        # --- one RunPod slot: a second user's file waits its turn, and says so
        rp.delay = 6.0
        api.upload("bea@example.com", make_audio("first.ogg", 20), "first.ogg")
        wait_until(lambda: (entry_for(api, "bea@example.com", "first.ogg") or {}).get("status") == "Being processed", 20)
        api.upload("cal@example.com", make_audio("second.ogg", 20), "second.ogg")
        waiting = wait_until(lambda: entry_for(api, "cal@example.com", "second.ogg"), 20)
        check("while the slot is taken, the next file is Queued with its place and an estimate",
              waiting and waiting["status"] == "Queued" and waiting.get("queue_position") == 1
              and waiting.get("eta_seconds", 0) > 0, waiting)
        both = wait_until(lambda: all((entry_for(api, u, n) or {}).get("status") == "Ready"
                                      for u, n in (("bea@example.com", "first.ogg"), ("cal@example.com", "second.ogg"))), 60)
        check("...and both finish, one after the other", both)

        # --- the server dies mid-job: the job is picked up from RunPod, not run twice
        rp.delay = 12.0
        runs_before = rp.runs
        status, body = api.call("POST", "/appdata/folders", "dov@example.com", body={"name": "Kept"})
        kept = json.loads(body)["id"] if status == 201 else None
        api.upload("dov@example.com", make_audio("survivor.ogg", 20), "survivor.ogg", folder=kept)
        wait_until(lambda: rp.runs > runs_before, 30)
        # Let the first heartbeat carry the RunPod job id to the hub.
        wait_until(lambda: hubq.execute("SELECT backend_ref FROM queue_messages WHERE backend_ref IS NOT NULL").fetchone(), 30)
        app_process.send_signal(signal.SIGKILL)
        app_process.wait()
        app_process, api = start_app()
        survived = wait_until(lambda: ready(api, "dov@example.com", "survivor.ogg", kept), 90)
        check("after a crash the job still finishes, in the folder it was sent to",
              survived and survived["status"] == "Ready", survived)
        check("...from the RunPod run already under way (no second run)", rp.runs == runs_before + 1,
              (rp.runs, runs_before))

        # --- a file lost with its server (a redeploy) fails cleanly, and is refunded
        rp.delay = 10.0
        api.upload("eli@example.com", make_audio("busy.ogg", 20), "busy.ogg")
        wait_until(lambda: (entry_for(api, "eli@example.com", "busy.ogg") or {}).get("status") == "Being processed", 20)
        api.upload("fay@example.com", make_audio("lost.ogg", 20), "lost.ogg")
        wait_until(lambda: (entry_for(api, "fay@example.com", "lost.ogg") or {}).get("status") == "Queued", 20)
        fay_before = json.loads(api.call("GET", "/quota", "fay@example.com")[1])["remainingMinutes"]
        app_process.send_signal(signal.SIGKILL)
        app_process.wait()
        for name in os.listdir(tmp):  # a new container: nothing kept
            path = os.path.join(tmp, name)
            if os.path.isfile(path):
                os.unlink(path)
        app_process, api = start_app()
        lost = wait_until(lambda: (lambda e: e if e and e.get("status") in ("Ready", "Failed") else None)(
            entry_for(api, "fay@example.com", "lost.ogg")), 90)
        check("a file lost before its turn fails, saying to send it again",
              lost and lost["status"] == "Failed" and lost.get("failure_reason") == "errorMediaLost", lost)
        fay_after = json.loads(api.call("GET", "/quota", "fay@example.com")[1])["remainingMinutes"]
        check("...and its quota is given back", fay_after > fay_before + 0.25, (fay_before, fay_after))
        busy = wait_until(lambda: (lambda e: e if e and e.get("status") in ("Ready", "Failed") else None)(
            entry_for(api, "eli@example.com", "busy.ogg")), 90)
        check("...while the job RunPod already had still finishes", busy and busy["status"] == "Ready", busy)
    finally:
        if app_process:
            app_process.terminate()
        hub.terminate()
        hubq.close()
        rp_server.shutdown()
        subprocess.run(["docker", "rm", "-f", container], capture_output=True)

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    if failed:
        print("logs:", WORK)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
