#!/bin/sh
# xhost boot time, as the non-root 'app' user. One exec line: node becomes
# PID 1 and receives stop signals directly.
set -eu

exec node --max-old-space-size=256 server.js
