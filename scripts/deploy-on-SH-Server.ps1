<#
.SYNOPSIS
    Deploys EMWS to an IIS site on this server, straight from GitHub.

.DESCRIPTION
    For a web server that has nothing of EMWS on it but Git and Node.js. It clones the
    public repository fresh, then hands over to scripts\deploy-iis.ps1 inside the clone,
    which installs the locked dependency versions, builds (type-check and Vite), stamps
    the build with emws-build.json, and mirrors dist\ into the site folder.

    The repository is public, so no key, token or account is needed to read it.

    Mirroring deletes anything in the site folder that is not part of the build, so a
    non-empty folder that is not already an EMWS deployment is refused unless -Force is
    given. -WhatIf shows what would change without changing anything.

.PARAMETER SitePath
    The physical folder of the IIS site, e.g. W:\EMWS. A local folder or a UNC path: a
    mapped drive letter is only visible to the account that mapped it, and never to IIS.

.PARAMETER BuildDir
    Where to clone and build. Removed and recreated on every run.

.PARAMETER Repository
    The Git URL to clone. Default: the public EMWS repository, over https.

.PARAMETER Branch
    The branch to deploy. Default main.

.PARAMETER SiteUrl
    The site's public address, used only to print the verification command at the end.

.PARAMETER Force
    Passed on to deploy-iis.ps1: mirror into a non-empty folder that is not an existing
    EMWS deployment.

.EXAMPLE
    .\deploy-on-SH-Server.ps1 -SitePath W:\EMWS -SiteUrl https://emws.semiheavy.com/

.EXAMPLE
    .\deploy-on-SH-Server.ps1 -SitePath W:\EMWS -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string] $SitePath,

    [string] $BuildDir = 'W:\Build\EMWS',

    [string] $Repository = 'https://github.com/thornthunder/EMWS.git',

    [string] $Branch = 'main',

    [string] $SiteUrl = '',

    [switch] $Force
)

$ErrorActionPreference = 'Stop'

<#
    Runs a native command and judges it by its exit code. Under 'Stop', Windows PowerShell
    turns anything a program writes to stderr into a terminating error whenever stderr is
    redirected - as a scheduled task or a logging wrapper does - and git and npm both
    write ordinary notices there. Exit codes are what they mean by failure.
#>
function Invoke-Native([string] $What, [scriptblock] $Command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

# ---- what this server needs ----
foreach ($tool in 'git', 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not on the PATH. Building EMWS needs Git and Node.js (20.19 or later, or 22.12 or later)."
    }
}
$nodeVersion = [version]((& node --version) -replace '^v', '')
$nodeOk = ($nodeVersion.Major -eq 20 -and $nodeVersion -ge [version]'20.19.0') -or ($nodeVersion -ge [version]'22.12.0')
if (-not $nodeOk) {
    throw "Node.js $nodeVersion is too old for the build tools: 20.19 or later, or 22.12 or later, is needed."
}

foreach ($folder in $SitePath, $BuildDir) {
    $parent = Split-Path -Parent $folder
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        throw ("$parent does not exist, so $folder cannot be created there. " +
            'If that is a mapped network drive, it is only visible to the account that mapped it; use a local folder or a UNC path.')
    }
}

# ---- a fresh clone, every time ----
$env:GIT_TERMINAL_PROMPT = '0'   # a public repository never needs a login; never hang asking for one
if (Test-Path -LiteralPath $BuildDir) {
    Write-Host "Removing the previous build at $BuildDir"
    Remove-Item -LiteralPath $BuildDir -Recurse -Force
}
Write-Host "Cloning $Repository ($Branch) into $BuildDir"
Invoke-Native 'git clone' { git clone --quiet --depth 1 --branch $Branch $Repository $BuildDir }

# ---- build, stamp, mirror: the ordinary deploy script, from inside the clone ----
$deploy = Join-Path $BuildDir 'scripts\deploy-iis.ps1'
if (-not (Test-Path -LiteralPath $deploy)) { throw "The clone has no scripts\deploy-iis.ps1; is $Repository really EMWS?" }
& $deploy -SitePath $SitePath -Force:$Force -WhatIf:$WhatIfPreference

if ($SiteUrl -and -not $WhatIfPreference) {
    $base = $SiteUrl.TrimEnd('/') + '/'
    Write-Host "Which build is live:  $($base)emws-build.json"
    Write-Host "Check it works, from any machine with Edge or Chrome:  node scripts/smoke-browser.mjs $base"
}
