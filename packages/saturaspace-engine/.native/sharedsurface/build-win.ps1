$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'SaturaSharedSurface'
$src = Join-Path $dir 'SharedSurfaceD3D11.cpp'
$outDir = Join-Path $dir '..\..\Runtime\Plugins\x86_64'
$outDir = [System.IO.Path]::GetFullPath($outDir)
$out = Join-Path $outDir "$name.dll"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "vswhere not found at $vswhere" }
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) {
  foreach ($cand in (& $vswhere -all -prerelease -property installationPath)) {
    if (Get-ChildItem (Join-Path $cand 'VC\Tools\MSVC') -Recurse -Filter cl.exe -ErrorAction SilentlyContinue | Select-Object -First 1) {
      $vsPath = $cand; break
    }
  }
}
if (-not $vsPath) { throw 'No Visual Studio install with the C++ toolset (VC.Tools.x86.x64) was found.' }
Write-Host "[build-win] using VS at $vsPath"

$msvcRoot = Join-Path $vsPath 'VC\Tools\MSVC'
$msvc = Get-ChildItem $msvcRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
$cl = Join-Path $msvc.FullName 'bin\HostX64\x64\cl.exe'
if (-not (Test-Path $cl)) { throw "cl.exe not found at $cl" }

$vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
  if ($_ -match '^(.*?)=(.*)$') { Set-Item -Path ("Env:" + $matches[1]) -Value $matches[2] }
}

Push-Location $dir
try {
  & $cl /nologo /LD /O2 /EHsc /MD /DNDEBUG /I"$dir" $src `
    /link /DLL "/OUT:$out" d3d11.lib dxgi.lib
  if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

Get-ChildItem $dir -Include *.obj, *.lib, *.exp -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "[build-win] output: $out"
if (Test-Path $out) { Write-Host "[build-win] OK ($((Get-Item $out).Length) bytes)" } else { throw 'build produced no DLL' }
