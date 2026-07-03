#!/usr/bin/env bash
# Restart ONLY Maestro's own electron.exe processes for local boot-testing.
#
# `taskkill /IM electron.exe` matches every process with that image name on
# the whole machine — any Electron app running unpackaged in dev mode (e.g.
# Halyard via `electron .`) shows up under the exact same name and gets
# killed too. That silently closed the captain's live Halyard session every time
# this repo's boot-test used a blind image-name kill. This scopes the kill to
# PIDs whose command line actually points at THIS repo before terminating
# anything, and only kills the app's own top-level electron.exe (image-name
# taskkill would also be needed for child renderer/gpu/utility processes, but
# Windows tree-kills those automatically when the parent that spawned them
# exits, via /T).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_PATH_WIN=$(pwd -W | sed 's#/#\\#g')

pids=$(wmic process where "name='electron.exe'" get ProcessId,CommandLine /format:csv 2>/dev/null \
  | grep -i "$REPO_PATH_WIN" \
  | awk -F',' '{print $NF}' \
  | tr -d '\r' \
  | grep -E '^[0-9]+$' || true)

for pid in $pids; do
  echo "Killing Maestro electron.exe PID $pid"
  taskkill //F //T //PID "$pid" 2>/dev/null || true
done

sleep 1
(npm start > /tmp/maestro-boot.log 2>&1 &)
sleep 6
grep -i error /tmp/maestro-boot.log || echo "clean boot"
