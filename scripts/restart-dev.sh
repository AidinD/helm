#!/usr/bin/env bash
# Restart ONLY Maestro's own electron.exe processes for local boot-testing.
#
# `taskkill /IM electron.exe` matches every process with that image name on
# the whole machine — any Electron app running unpackaged in dev mode (e.g.
# Halyard via `electron .`) shows up under the exact same name and gets
# killed too. That silently closed the captain's live Halyard session every time
# this repo's boot-test used a blind image-name kill.
#
# FIRST attempt scoped this via `wmic ... | grep -i "$REPO_PATH_WIN"` — but
# grep interprets a literal Windows path's backslashes as regex escape
# sequences (`\R`, `\T`, `\m`...), so the match silently failed EVERY time
# (`|| true` swallowed the failure with no visible error) and every restart
# launched a NEW Maestro instance on top of the old one instead of replacing
# it. The captain caught this live — three stray Maestro instances had piled up.
# `grep -F` (fixed-string) was tried next and still failed/crashed against
# the real wmic output in this environment. Switched to PowerShell's
# Get-CimInstance + a plain `-like` string match instead: no regex escaping
# ambiguity, and verified live (killed exactly the Maestro PIDs, left
# Halyard's 4 untouched). The PowerShell logic lives in its own
# kill-maestro.ps1, invoked via -File rather than inlined via -Command —
# nesting a PowerShell string literal inside a bash single-quoted argument
# mis-parsed the -Filter argument (a second quoting layer to avoid, not a
# problem worth fighting inline).
set -euo pipefail
cd "$(dirname "$0")/.."

powershell.exe -NoProfile -File "$(pwd -W)/scripts/kill-maestro.ps1"

sleep 1
(npm start > /tmp/maestro-boot.log 2>&1 &)
sleep 6
grep -i error /tmp/maestro-boot.log || echo "clean boot"
