#!/bin/sh
# xhost build time, as root. Output is baked into the image.
set -eu
pip install -r server/requirements-xhost.txt
