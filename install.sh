#!/bin/sh
# xhost build time, as root. Output is baked into the image.
set -eu
pip install -r server/requirements-xhost.txt
# For the on-device lab's models, made at start-up (launch.sh).
pip install numpy
