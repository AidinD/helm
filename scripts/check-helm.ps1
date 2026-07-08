# Reports whether THIS repo's own Helm electron.exe is actually running,
# matched by the SAME CommandLine filter kill-helm.ps1 uses ("Tools\helm").
# Used by restart-dev.sh as a real liveness signal after boot: a single
# keyword grep on the boot log is not enough (e.g. `'electron' is not
# recognized ...` contains no "error", so the old check reported "clean
# boot" while the app was dead). Called via `powershell.exe -File`, not
# inlined via -Command, to avoid nesting a PowerShell string literal inside
# a bash single-quoted argument (that mis-parsed the -Filter argument).
#
# Prints the count of matching live processes to stdout (0 when dead) so the
# caller can branch on it. Exit code mirrors it: 0 = alive, 1 = dead.
$procs = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like '*Tools\helm*' })
Write-Output $procs.Count
if ($procs.Count -gt 0) {
    exit 0
} else {
    exit 1
}
