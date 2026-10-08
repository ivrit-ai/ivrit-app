"""End to end: the server in hub mode, scheduled by Eliezer's hub.

Runs the real hub (from the eliezer repo, against a throwaway Postgres), the real
server (tests/hub_harness.py: Drive is a local directory, RunPod is a fake here),
and uploads files through the server's own API with a real session cookie. Checks:
a file goes upload -> transcode -> hub -> credit -> RunPod (by a signed link) ->
Drive; the quota is the hub's; a second user's file waits for the one RunPod slot
and shows its place; a server killed mid-job picks the job up again from RunPod
without a second run; a file lost with its server fails cleanly and is refunded.

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

    def upload(self, email, path, name):
        boundary = uuid.uuid4().hex
        with open(path, "rb") as f:
            content = f.read()
        parts = []
        for key, value in (("language", "he"), ("save_audio", "true")):
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                     f"Content-Type: audio/ogg\r\n\r\n".encode() + content + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        status, body = self.call("POST", "/upload", email, raw=b"".join(parts),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=120)
        events = [json.loads(line) for line in body.decode().splitlines() if line.strip()] if status == 200 else []
        return status, events, body

    def toc(self, email):
        status, body = self.call("GET", "/appdata/toc", email)
        return json.loads(body)["entries"] if status == 200 else None


def entry_for(api, email, name):
    for e in api.toc(email) or []:
        if e.get("source_filename") == name:
            return e
    return None


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
        HARNESS_RUNPOD_URL=f"http://127.0.0.1:{rp_port}", TMPDIR=tmp,
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
        api.upload("dov@example.com", make_audio("survivor.ogg", 20), "survivor.ogg")
        wait_until(lambda: rp.runs > runs_before, 30)
        # Let the first heartbeat carry the RunPod job id to the hub.
        wait_until(lambda: hubq.execute("SELECT backend_ref FROM queue_messages WHERE backend_ref IS NOT NULL").fetchone(), 30)
        app_process.send_signal(signal.SIGKILL)
        app_process.wait()
        app_process, api = start_app()
        survived = wait_until(lambda: (lambda e: e if e and e.get("status") in ("Ready", "Failed") else None)(
            entry_for(api, "dov@example.com", "survivor.ogg")), 90)
        check("after a crash the job still finishes", survived and survived["status"] == "Ready", survived)
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
