#!/bin/sh
# xhost boot time, as the non-root 'app' user. One exec line: uvicorn becomes
# PID 1 and receives stop signals directly. The server (server/app.py) serves the
# app's pages (web/) and the transcription API; its schema migrates at startup.
set -eu
# The on-device lab's quantized models (scripts/lab_models.py), made in the
# background at low priority while the server serves; nothing without
# web/lab/models.json.
export LAB_MODELS_DIR=/tmp/lab-models
nice -n 19 python3 scripts/lab_models.py > /tmp/lab-models.log 2>&1 &
cd server
exec uvicorn app:app --host 0.0.0.0 --port "${XHOSTD_HTTP_PORT:-${PORT:-8080}}" \
  --proxy-headers --forwarded-allow-ips='*'
