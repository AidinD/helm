#!/usr/bin/env bash
# Restart ONLY Helm's own electron.exe processes for local boot-testing.
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
# launched a NEW Helm instance on top of the old one instead of replacing
# it. The captain caught this live — three stray Helm instances had piled up.
# `grep -F` (fixed-string) was tried next and still failed/crashed against
# the real wmic output in this environment. Switched to PowerShell's
# Get-CimInstance + a plain `-like` string match instead: no regex escaping
# ambiguity, and verified live (killed exactly the Helm PIDs, left
# Halyard's 4 untouched). The PowerShell logic lives in its own
# kill-helm.ps1, invoked via -File rather than inlined via -Command —
# nesting a PowerShell string literal inside a bash single-quoted argument
# mis-parsed the -Filter argument (a second quoting layer to avoid, not a
# problem worth fighting inline).
set -euo pipefail
cd "$(dirname "$0")/.."

powershell.exe -NoProfile -File "$(pwd -W)/scripts/kill-helm.ps1"

sleep 1
(npm start > /tmp/helm-boot.log 2>&1 &)
sleep 6

# Real liveness signal, not a single-keyword grep. The old check
# (`grep -i error ... || echo "clean boot"`) reported "clean boot" whenever
# the log lacked the literal word "error" — but a broken start such as
# `'electron' is not recognized ...` (seen after the Maestro->Helm rename
# broke node_modules/.bin) contains no "error", so it printed "clean boot"
# while no process was actually running. Ask the OS whether a Helm
# electron.exe is really up, reusing the same filter kill-helm.ps1 uses.
if powershell.exe -NoProfile -File "$(pwd -W)/scripts/check-helm.ps1" >/dev/null 2>&1; then
    echo "clean boot"
else
    echo "BOOT FAILED - no Helm electron.exe process is running."
    # Broadened failure-pattern scan for a quick hint at the cause; the full
    # log tail follows regardless.
    grep -iE "not recognized|cannot find module|error:?|throw|exception" /tmp/helm-boot.log || true
    echo "--- last 30 lines of /tmp/helm-boot.log ---"
    tail -n 30 /tmp/helm-boot.log
    exit 1
fi
