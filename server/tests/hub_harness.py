"""Runs the server for test_hub_mode.py: the real app, with two things swapped out -
Google Drive becomes a local directory (HARNESS_DATA, one folder per refresh token),
and RunPod's API is HARNESS_RUNPOD_URL (the test's fake). Everything else - sessions,
uploads, transcoding, the hub, signed media links, Drive writes - runs for real.

    python tests/hub_harness.py <port>
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, SERVER)
os.chdir(SERVER)

port = int(sys.argv[1])
sys.argv = [sys.argv[0]]  # app.py parses its own arguments at import

import ivrit.audio as ivrit_audio  # noqa: E402

RUNPOD = os.environ["HARNESS_RUNPOD_URL"]
_init = ivrit_audio.AsyncRunPodJob.__init__


def _init_fake(self, api_key, endpoint_id, payload):
    _init(self, api_key, endpoint_id, payload)
    self.base_url = f"{RUNPOD}/v2/{endpoint_id}"


ivrit_audio.AsyncRunPodJob.__init__ = _init_fake

import app  # noqa: E402
import uvicorn  # noqa: E402
from local_file_utils import LocalFileStorageBackend  # noqa: E402

app.file_storage_backend = LocalFileStorageBackend(base_dir=os.environ["HARNESS_DATA"])
app.runpod_key_store.backend = app.file_storage_backend

uvicorn.run(app.app, host="127.0.0.1", port=port, log_level="info")
