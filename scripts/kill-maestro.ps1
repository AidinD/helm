# Kills only THIS repo's own electron.exe processes, matched by CommandLine
# containing "Tools\maestro". Called from restart-dev.sh via
# `powershell.exe -File`, not inlined via -Command, to avoid the quoting
# ambiguity of nesting PowerShell string literals inside a bash single-quoted
# argument (that nesting silently mis-parsed the -Filter argument).
$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like '*Tools\maestro*' }
foreach ($p in $procs) {
    Write-Output "Killing Maestro electron.exe PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
