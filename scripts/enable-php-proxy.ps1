<#
.SYNOPSIS
    Lets an EMWS site forward solver requests to a NEC service.

.DESCRIPTION
    EMWS is static files; the only server-side part is solver/index.php, which forwards
    to a NEC solver on the network. That needs two things on IIS:

      1. *.php on this site handled by a modern PHP, not whatever the server inherits.
      2. The solver's address in that PHP process's environment.

    IIS keys FastCGI applications on the executable plus its arguments, so this registers
    a PHP instance of its own for EMWS and sets the environment variables there. Nothing
    is written into the site folder, so a rebuild cannot wipe it.

    Run it from an elevated PowerShell.

.PARAMETER SiteName
    The IIS site, as it appears in IIS Manager.

.PARAMETER SolverUrl
    The NEC solver to forward to.

.PARAMETER PhpCgi
    php-cgi.exe to use. Defaults to the newest under C:\Program Files\PHP.

.PARAMETER Token
    Optional shared secret, sent as "Authorization: Bearer <token>".

.PARAMETER Remove
    Undo everything this script set up.

.EXAMPLE
    .\scripts\enable-php-proxy.ps1 -SiteName emws.local -SolverUrl http://192.168.0.124:8073

.EXAMPLE
    .\scripts\enable-php-proxy.ps1 -SiteName emws.local -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string] $SiteName,

    [string] $SolverUrl = 'http://192.168.0.124:8073',

    [string] $PhpCgi,

    [string] $Token = '',

    [int] $TimeoutSeconds = 300,

    [switch] $Remove
)

$ErrorActionPreference = 'Stop'
$appcmd = Join-Path $env:windir 'system32\inetsrv\appcmd.exe'
if (-not (Test-Path $appcmd)) { throw 'IIS does not appear to be installed (appcmd.exe not found).' }

# The marker makes this a FastCGI application of its own, which is what lets it carry
# its own environment variables.
$marker = "-d emws.site=$SiteName"
$handlerName = "EMWS_PHP_$($SiteName -replace '[^A-Za-z0-9]', '_')"
# Legacy mappings inherited from the server would otherwise win: *.php matches the first.
$shadowing = @('PHP53_via_FastCGI', 'PHP54_via_FastCGI', 'PHP_via_FastCGI', 'PHP_via_FastCGI1')

function Get-RegisteredPhp {
    <#  Every php-cgi.exe already registered as a FastCGI application for this site.
        Upgrading PHP changes the executable and so makes a new application; without
        this, the old ones would pile up and -Remove would leave them behind. #>
    $config = & $appcmd list config -section:system.webServer/fastCgi
    $pattern = [regex]::Escape("arguments=`"$marker`"")
    return $config |
        Where-Object { $_ -match "fullPath=`"([^`"]+)`"" -and $_ -match $pattern } |
        ForEach-Object { [regex]::Match($_, 'fullPath="([^"]+)"').Groups[1].Value } |
        Select-Object -Unique
}

function Invoke-AppCmd {
    param([string[]] $Arguments, [switch] $IgnoreErrors)
    $output = & $appcmd @Arguments 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $IgnoreErrors) {
        throw "appcmd $($Arguments -join ' ')`n$output"
    }
    return $output
}

if (-not $PhpCgi) {
    # Folders are named like "8.5.7", "v8.4.13": take the newest that actually has php-cgi.exe.
    $PhpCgi = Get-ChildItem 'C:\Program Files\PHP' -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
            $exe = Join-Path $_.FullName 'php-cgi.exe'
            if (Test-Path $exe) {
                $numbers = @(($_.Name -replace '[^0-9.]', '').Trim('.') -split '\.' | Where-Object { $_ -ne '' } | Select-Object -First 3)
                while ($numbers.Count -lt 2) { $numbers += '0' }
                [pscustomobject]@{ Path = $exe; Version = [version]($numbers -join '.') }
            }
        } |
        Sort-Object Version |
        ForEach-Object {
            # Prefer an install that can actually make outbound requests.
            $php = Join-Path (Split-Path $_.Path -Parent) 'php.exe'
            $hasCurl = $false
            if (Test-Path $php) {
                $modules = & $php -m 2>$null
                $hasCurl = ($modules -contains 'curl')
            }
            $_ | Add-Member -NotePropertyName HasCurl -NotePropertyValue $hasCurl -PassThru
        } |
        Sort-Object HasCurl, Version |
        Select-Object -Last 1 -ExpandProperty Path
}
if (-not $PhpCgi -or -not (Test-Path $PhpCgi)) {
    throw 'Could not find php-cgi.exe. Install PHP, or pass -PhpCgi with its path.'
}

$fastCgiKey = "[fullPath='$PhpCgi',arguments='$marker']"

if ($Remove) {
    if ($PSCmdlet.ShouldProcess($SiteName, 'Remove the EMWS PHP handler and its FastCGI application')) {
        Invoke-AppCmd @('set', 'config', "$SiteName/", '-section:system.webServer/handlers', "/-[name='$handlerName']", '/commit:apphost') -IgnoreErrors | Out-Null
        foreach ($name in $shadowing) {
            Invoke-AppCmd @('set', 'config', "$SiteName/", '-section:system.webServer/handlers', "/-[name='$name']", '/commit:apphost') -IgnoreErrors | Out-Null
        }
        # Every PHP ever registered for this site, not only the one chosen today.
        foreach ($path in Get-RegisteredPhp) {
            Invoke-AppCmd @('set', 'config', '-section:system.webServer/fastCgi', "/-[fullPath='$path',arguments='$marker']", '/commit:apphost') -IgnoreErrors | Out-Null
        }
        Invoke-AppCmd @('set', 'config', '-section:system.webServer/fastCgi', "/-$fastCgiKey", '/commit:apphost') -IgnoreErrors | Out-Null
        Write-Host "Removed the EMWS PHP handler from $SiteName."
    }
    exit 0
}

if (-not $PSCmdlet.ShouldProcess($SiteName, "Handle *.php with $PhpCgi and forward to $SolverUrl")) { exit 0 }

Write-Host "PHP:    $PhpCgi"
Write-Host "Site:   $SiteName"
Write-Host "Solver: $SolverUrl"

# 1. A FastCGI application for this site alone. Clear out any PHP registered for it
#    before, so an upgrade replaces the entry instead of adding another.
foreach ($path in Get-RegisteredPhp | Where-Object { $_ -ne $PhpCgi }) {
    Write-Host "Replacing an earlier registration: $path"
    Invoke-AppCmd @('set', 'config', '-section:system.webServer/fastCgi', "/-[fullPath='$path',arguments='$marker']", '/commit:apphost') -IgnoreErrors | Out-Null
}
Invoke-AppCmd @('set', 'config', '-section:system.webServer/fastCgi', "/+$fastCgiKey", '/commit:apphost') -IgnoreErrors | Out-Null
Invoke-AppCmd @('set', 'config', '-section:system.webServer/fastCgi', "/$fastCgiKey.activityTimeout:$([Math]::Max(90, $TimeoutSeconds + 60))", "/$fastCgiKey.requestTimeout:$([Math]::Max(90, $TimeoutSeconds + 60))", '/commit:apphost') | Out-Null

# 2. Its environment: where the solver lives.
$variables = @{ EMWS_SOLVER_URL = $SolverUrl; EMWS_SOLVER_TIMEOUT = "$TimeoutSeconds" }
if ($Token -ne '') { $variables['EMWS_SOLVER_TOKEN'] = $Token }
foreach ($name in $variables.Keys) {
    Invoke-AppCmd @('set', 'config', '-section:system.webServer/fastCgi', "/-$fastCgiKey.environmentVariables.[name='$name']", '/commit:apphost') -IgnoreErrors | Out-Null
    Invoke-AppCmd @('set', 'config', '-section:system.webServer/fastCgi', "/+$fastCgiKey.environmentVariables.[name='$name',value='$($variables[$name])']", '/commit:apphost') | Out-Null
}

# 3. This site's own *.php handler, ahead of anything inherited.
foreach ($name in $shadowing) {
    Invoke-AppCmd @('set', 'config', "$SiteName/", '-section:system.webServer/handlers', "/-[name='$name']", '/commit:apphost') -IgnoreErrors | Out-Null
}
Invoke-AppCmd @('set', 'config', "$SiteName/", '-section:system.webServer/handlers', "/-[name='$handlerName']", '/commit:apphost') -IgnoreErrors | Out-Null
Invoke-AppCmd @(
    'set', 'config', "$SiteName/", '-section:system.webServer/handlers',
    "/+[name='$handlerName',path='*.php',verb='GET,HEAD,POST,OPTIONS',modules='FastCgiModule',scriptProcessor='$PhpCgi|$marker',resourceType='Either',requireAccess='Script']",
    '/commit:apphost'
) | Out-Null

Write-Host ''
Write-Host 'Done. Check it with:'
Write-Host "  curl http://$SiteName/solver/index.php?op=health"
Write-Host "Undo with: .\scripts\enable-php-proxy.ps1 -SiteName $SiteName -Remove"
