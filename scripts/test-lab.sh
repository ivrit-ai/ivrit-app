#!/bin/sh
# The benchmark on phones we don't have, on Firebase Test Lab (androidTest
# TrialOnPhones): each phone runs it as a user would from the Lab page, on the
# processor asked for, and reports to the site's log (kind lab-phones; the worker's
# own reports as usual). Physical phones cost $5 an hour after the day's free 30
# minutes; each run here takes 5-15 minutes (the model's download, then the
# benchmark), at most 20 (the test gives up at 15). One phone at a time is the
# default: name more on purpose. A phone at hand runs the same test over adb:
#   adb shell am instrument -w -e processor auto -e class ai.ivrit.app.TrialOnPhones \
#       ai.ivrit.app.test/androidx.test.runner.AndroidJUnitRunner
#
#   scripts/test-lab.sh [processor] [model,version ...]
#   scripts/test-lab.sh programs [model,version ...]
#
# processor: auto (the default), gpu or cpu (DECODING=fast: greedy, as Settings'
# choice of speed). programs: only the encoder's WebGPU programs timed, each version
# of them (androidTest ProgramsOnPhones, kind lab-programs), without the model: 2-4
# minutes a phone, at most 10. Phones: Test Lab's model ids with an Android version
# (gcloud firebase test android models list); by default the Galaxy S23 (Adreno
# 740). Turbo is offered on Galaxy S23s and on (Turbo.supported): dm1q,35 (S23),
# e1s,36 (S24, Exynos), pa1q,36 (S25). Needs gcloud signed in, on a project with Test Lab
# (CLOUDSDK_CORE_PROJECT or gcloud's own). The results are in the log; the run
# itself at the link gcloud prints.
set -eu
cd "$(dirname "$0")/.."
processor=${1:-auto}
[ $# -gt 0 ] && shift
if [ $# -eq 0 ]; then
    set -- dm1q,35
fi
. scripts/android-env.sh
(cd shell/android && ./gradlew -q :app:assembleDebug :app:assembleDebugAndroidTest)
devices=""
for d in "$@"; do
    devices="$devices --device model=${d%,*},version=${d#*,},locale=iw_IL,orientation=portrait"
done
if [ "$processor" = programs ]; then
    # A process each (the orchestrator): ggml reads its switches once.
    set -- --test-targets "class ai.ivrit.app.ProgramsOnPhones" --use-orchestrator --timeout 10m
else
    set -- --test-targets "class ai.ivrit.app.TrialOnPhones" --environment-variables "processor=$processor,minutes=15,decoding=${DECODING:-accurate}" --timeout 20m
fi
# shellcheck disable=SC2086
gcloud firebase test android run --type instrumentation --async \
    --app shell/android/app/build/outputs/apk/debug/app-debug.apk \
    --test shell/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \
    "$@" --no-record-video --no-performance-metrics \
    --results-history-name "turbo $processor" $devices
