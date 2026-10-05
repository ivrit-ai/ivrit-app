#!/bin/sh
# Copies Communicator's client (device store, API client, push handler) into
# web/client/, pinned to the commit it came from. Nothing is fetched from
# Communicator at runtime: a change there reaches this app only through here.
#
#   scripts/sync-client.sh [path to a Communicator checkout]   (default ../notifier)
set -eu
cd "$(dirname "$0")/.."
src=${1:-../notifier}
git -C "$src" diff --quiet HEAD -- public/client || { echo "uncommitted changes in $src/public/client" >&2; exit 1; }
for f in store.js communicator.js push.js; do cp "$src/public/client/$f" "web/client/$f"; done
echo "ivrit-ai/communicator $(git -C "$src" rev-parse HEAD)" > web/client/SOURCE
cat web/client/SOURCE
