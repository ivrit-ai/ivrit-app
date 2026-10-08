"""For the browser test (store/test-transcribe.mjs): the hub, a fake RunPod, and the app's Python server (Drive
as a local folder), with a session cookie and an app session minted for one user.
Prints one JSON line, then runs until killed.

    python server_stack.py <app port> <communicator origin>
"""
import json, os, subprocess, sys, tempfile, threading, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import test_hub_mode as t
from http.server import ThreadingHTTPServer
from cryptography.fernet import Fernet
from app_sessions import Sessions

app_port, comm = int(sys.argv[1]), sys.argv[2]
origin = f"http://localhost:{app_port}"
ELIEZER_PYTHON = os.environ.get("ELIEZER_PYTHON", sys.executable)
work = tempfile.mkdtemp(prefix="browser-stack-")
pg, hub_port, rp_port = t.free_port(), t.free_port(), t.free_port()
container = "browser-stack-pg"
subprocess.run(["docker", "rm", "-f", container], capture_output=True)
subprocess.run(["docker", "run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=pw", "-p", f"127.0.0.1:{pg}:5432", "postgres:16-alpine"], check=True, capture_output=True)
t.wait_until(lambda: subprocess.run(["docker", "exec", container, "pg_isready", "-U", "postgres"], capture_output=True).returncode == 0, 30)
time.sleep(1)
subprocess.run(["docker", "exec", container, "psql", "-U", "postgres", "-c", "CREATE DATABASE app;"], check=True, capture_output=True)
rp = ThreadingHTTPServer(("127.0.0.1", rp_port), t.RunPodHandler)
threading.Thread(target=rp.serve_forever, daemon=True).start()
t.rp.delay = 2.0
eliezer = os.path.join(t.ELIEZER, "status_site")
hub_env = dict(os.environ, DATABASE_URL=f"postgresql://postgres:pw@127.0.0.1:{pg}/postgres", QUEUE_TOKEN="q", APP_SERVER_TOKEN="tok",
               CREDIT_POOLS="runpod=2", PORT=str(hub_port), WHATSAPP_GRAPH_URL="http://127.0.0.1:9", TELEGRAM_API_URL="http://127.0.0.1:9")
subprocess.run([ELIEZER_PYTHON, "-c", "import app; app.init_db(); app.init_queue_db()"], cwd=eliezer, env=hub_env, check=True)
hub = subprocess.Popen([ELIEZER_PYTHON, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(hub_port), "--no-access-log"],
                       cwd=eliezer, env=hub_env, stdout=open(f"{work}/hub.log", "w"), stderr=subprocess.STDOUT)
cookie_key = Fernet.generate_key().decode()
session_key = subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"], capture_output=True, text=True, check=True).stdout
tmp = f"{work}/tmp"
os.makedirs(tmp)
app_env = dict(os.environ, TS_XHOST_MODE="1", DATABASE_URL=f"postgresql://postgres:pw@127.0.0.1:{pg}/app", BASE_URL=origin,
               GOOGLE_CLIENT_ID="test-client", GOOGLE_CLIENT_SECRET="x", SESSION_ENCRYPTION_KEY=cookie_key, RUNPOD_API_KEY="k",
               RUNPOD_ENDPOINT_ID="ep", RUNPOD_KEY_ENCRYPTION_KEY=Fernet.generate_key().decode(), HUB_URL=f"http://127.0.0.1:{hub_port}",
               APP_SERVER_TOKEN="tok", HARNESS_DATA=f"{work}/drive", HARNESS_RUNPOD_URL=f"http://127.0.0.1:{rp_port}", TMPDIR=tmp,
               APP_SESSION_KEY=session_key, APP_SESSION_ISSUER=origin, COMMUNICATOR_URL=comm, HARNESS_TEST_LOGIN="1")
server = subprocess.Popen([sys.executable, os.path.join(HERE, "hub_harness.py"), str(app_port)],
                          cwd=os.path.dirname(HERE), env=app_env, stdout=open(f"{work}/app.log", "w"), stderr=subprocess.STDOUT)
api = t.Api(f"http://127.0.0.1:{app_port}")
def alive():
    try:
        return api.call("GET", "/login")[0] == 200
    except OSError:
        return False
t.wait_until(alive, 60)
email, sub = "dana@example.com", "dana-sub"
cookie = Fernet(cookie_key.encode()).encrypt(json.dumps({"user_email": email, "google_sub": sub, "refresh_token": "rt-dana",
        "runpod_token": "", "runpod_key_load_failed": False, "v": 1}).encode()).decode()
session = Sessions(origin, "test-client", session_key).issue(sub, email, "Dana")
print(json.dumps({"cookie": cookie, "session": session, "work": work}), flush=True)
try:
    while True:
        time.sleep(1)
finally:
    server.terminate(); hub.terminate()
    subprocess.run(["docker", "rm", "-f", container], capture_output=True)
