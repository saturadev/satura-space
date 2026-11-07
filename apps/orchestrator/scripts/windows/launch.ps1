$ErrorActionPreference = 'Stop'
Push-Location -Path (Join-Path $PSScriptRoot '..\..')
try {
    corepack pnpm dev
}
finally {
    Pop-Location
}
