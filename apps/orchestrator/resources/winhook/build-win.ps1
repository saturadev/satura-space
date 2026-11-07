$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $dir 'unityhook_win.c'
$out = Join-Path $dir 'unityhook.dll'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "vswhere not found at $vswhere" }
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) {
  foreach ($cand in (& $vswhere -all -prerelease -property installationPath)) {
    if (Get-ChildItem (Join-Path $cand 'VC\Tools\MSVC') -Recurse -Filter cl.exe -ErrorAction SilentlyContinue | Select-Object -First 1) { $vsPath = $cand; break }
  }
}
if (-not $vsPath) { throw 'No Visual Studio install with the C++ toolset (VC.Tools.x86.x64) was found.' }
Write-Host "[winhook-win] using VS at $vsPath"

$vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object { if ($_ -match '^(.*?)=(.*)$') { Set-Item -Path ("Env:" + $matches[1]) -Value $matches[2] } }
$msvc = Get-ChildItem (Join-Path $vsPath 'VC\Tools\MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$cl = Join-Path $msvc.FullName 'bin\HostX64\x64\cl.exe'
if (-not (Test-Path $cl)) { throw "cl.exe not found at $cl" }

Push-Location $dir
try {
  & $cl /nologo /LD /O2 /DNDEBUG $src /link /DLL "/OUT:$out" user32.lib
  if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

Get-ChildItem $dir -Include *.obj, *.lib, *.exp -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path $out) { Write-Host "[winhook-win] OK -> $out ($((Get-Item $out).Length) bytes)" } else { throw 'no DLL produced' }
