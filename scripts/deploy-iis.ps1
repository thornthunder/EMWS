<#
.SYNOPSIS
    Builds EMWS and mirrors the build into an IIS site folder.

.DESCRIPTION
    EMWS is a static site, so deploying is "copy dist\ to the folder IIS serves".
    This script does the build, stamps it with emws-build.json, and mirrors it across
    with robocopy.

    Mirroring DELETES anything in the target folder that is not part of the build, so
    the script refuses to touch a non-empty folder unless it already holds an EMWS
    deployment (it looks for emws-build.json) or you pass -Force.

    Run it from an elevated prompt if the target is under C:\inetpub.

.PARAMETER SitePath
    The physical folder of the IIS site, application or virtual directory.

.PARAMETER SkipBuild
    Deploy the existing dist\ folder without rebuilding.

.PARAMETER Force
    Allow mirroring into a non-empty folder that is not an existing EMWS deployment.

.EXAMPLE
    .\scripts\deploy-iis.ps1 -SitePath C:\inetpub\wwwroot\emws

.EXAMPLE
    .\scripts\deploy-iis.ps1 -SitePath \\webserver\sites\emws -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string] $SitePath,

    [switch] $SkipBuild,

    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repo 'dist'
$markerName = 'emws-build.json'

if (-not $SkipBuild) {
    Push-Location $repo
    try {
        if (-not (Test-Path (Join-Path $repo 'node_modules'))) {
            Write-Host 'Installing dependencies (npm ci)...'
            npm ci
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        }
        Write-Host 'Building (npm run build)...'
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'The build failed; nothing was deployed.' }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path (Join-Path $dist 'index.html'))) {
    throw "No build found at $dist. Run without -SkipBuild."
}
if (-not (Test-Path (Join-Path $dist 'web.config'))) {
    throw "dist\web.config is missing; IIS would serve .wasm with the wrong MIME type."
}

# Refuse to mirror over somebody else's files.
if (Test-Path $SitePath) {
    $existing = @(Get-ChildItem -Force -LiteralPath $SitePath)
    $isEmws = Test-Path (Join-Path $SitePath $markerName)
    if ($existing.Count -gt 0 -and -not $isEmws -and -not $Force) {
        throw ("$SitePath is not empty and is not an EMWS deployment (no $markerName). " +
            "Mirroring would delete its $($existing.Count) item(s). Check the path, or pass -Force.")
    }
}

# Stamp the build, so you can always tell what a server is running: <site>/emws-build.json
$commit = 'unknown'
try {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $sha = & git -C $repo rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $sha) { $commit = "$sha".Trim() }
}
catch { }
finally { $ErrorActionPreference = $previous }

$package = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$stamp = [ordered]@{
    name    = 'EMWS'
    version = $package.version
    commit  = $commit
    builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
$stampJson = $stamp | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $dist $markerName), $stampJson, (New-Object System.Text.UTF8Encoding($false)))

$robocopyArgs = @($dist, $SitePath, '/MIR', '/R:2', '/W:2', '/NFL', '/NDL', '/NP', '/NJH')
if (-not $PSCmdlet.ShouldProcess($SitePath, "Mirror $dist (deleting anything else there)")) {
    # -WhatIf: let robocopy list what it would do, without doing it.
    $robocopyArgs += '/L'
    Write-Host "What if: robocopy would make these changes to ${SitePath}:"
}

& robocopy @robocopyArgs
# robocopy: 0-7 are degrees of success, 8 and above are failures.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE." }

Write-Host ''
Write-Host "EMWS $($stamp.version) ($commit) -> $SitePath"
Write-Host 'Verify the live site with:  node scripts/smoke-browser.mjs https://your-server/your-path/'
exit 0
