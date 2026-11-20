"""app_site.Pages: an open-ended range ("bytes=N-") is the file from N on (206), as the
apps resume a model's download; anything else, the whole file.

    python tests/test_pages_range.py
"""

import os
import sys
import tempfile

from starlette.applications import Starlette
from starlette.testclient import TestClient

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app_site import Pages  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  [{detail}]"))


with tempfile.TemporaryDirectory() as d:
    data = bytes(range(256)) * 40
    with open(os.path.join(d, "model.bin"), "wb") as f:
        f.write(data)
    app = Starlette()
    app.mount("/models", Pages(directory=d))
    client = TestClient(app)

    r = client.get("/models/model.bin")
    check("whole file", r.status_code == 200 and r.content == data, r.status_code)
    check("whole file says ranges are served", r.headers.get("accept-ranges") == "bytes", dict(r.headers))

    r = client.get("/models/model.bin", headers={"Range": "bytes=1000-"})
    check("the rest from 1000", r.status_code == 206 and r.content == data[1000:], r.status_code)
    check("its Content-Range", r.headers.get("content-range") == f"bytes 1000-{len(data) - 1}/{len(data)}", r.headers.get("content-range"))
    check("its length", r.headers.get("content-length") == str(len(data) - 1000), r.headers.get("content-length"))

    # Past the end: Starlette's own answer (the server's, which serves no ranges: the
    # whole file; a newer one: 416). The apps never ask so: a whole file is not resumed.
    r = client.get("/models/model.bin", headers={"Range": f"bytes={len(data)}-"})
    check("past the end: not a part", r.status_code in (200, 416), r.status_code)

    r = client.get("/models/model.bin", headers={"Range": "bytes=0-99"})
    check("another form: the whole file", r.status_code in (200, 206) and (r.content == data or r.content == data[:100]), r.status_code)

print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
