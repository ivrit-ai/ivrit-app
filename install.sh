#!/bin/sh
# xhost build time, as root. Output is baked into the image.
set -eu
pip install -r server/requirements-xhost.txt
# The on-device lab's quantized models (web/lab/models/), made from the public
# f16 model while the app serves them; does nothing without web/lab/models.json.
pip install numpy
python3 scripts/lab_models.py
