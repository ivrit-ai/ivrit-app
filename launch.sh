#!/bin/sh
# xhost boot time, as the non-root 'app' user. One exec line: uvicorn becomes
# PID 1 and receives stop signals directly. The server (server/app.py) serves the
# app's pages (web/) and the transcription API; its schema migrates at startup.
set -eu
cd server
exec uvicorn app:app --host 0.0.0.0 --port "${XHOSTD_HTTP_PORT:-${PORT:-8080}}" \
  --proxy-headers --forwarded-allow-ips='*'
