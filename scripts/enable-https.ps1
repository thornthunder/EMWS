<#
.SYNOPSIS
    Gives an EMWS site on IIS a certificate that browsers on this machine will accept.

.DESCRIPTION
    Some of EMWS only works on a secure page: talking to a NanoVNA over USB is the one
    that matters, because the browser refuses to open a serial port from plain http://.
    On a private network there is no certificate authority to ask, so this makes one
    of its own for the site's name, tells this machine to trust it, and binds it to the
    site's https binding - replacing whatever was there.

    It is deliberately narrow: one certificate, for the names you give it, trusted on
    this machine only. Other machines on the network will still see a warning unless
    you export the certificate to them as well (see -ExportTo).

    Run it from an elevated PowerShell.

.PARAMETER SiteName
    The IIS site, as it appears in IIS Manager.

.PARAMETER HostName
    The name(s) the certificate should cover. The first is the site's https binding.

.PARAMETER Years
    How long the certificate lasts. Browsers cap what they accept at 398 days for
    public CAs, but a certificate you trust yourself is not held to that.

.PARAMETER ExportTo
    Also write the public certificate (.cer) here, to install on another machine's
    Trusted Root store so it accepts the site too.

.EXAMPLE
    .\scripts\enable-https.ps1 -SiteName emws.local -HostName emws.local

.EXAMPLE
    .\scripts\enable-https.ps1 -SiteName emws.local -HostName emws.local,emws.lan -ExportTo C:\Temp\emws-local.cer
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string] $SiteName,

    [string[]] $HostName = @($SiteName),

    [int] $Years = 5,

    [string] $ExportTo
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration

$site = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
if (-not $site) { throw "There is no IIS site called '$SiteName'." }

$primary = $HostName[0]
$friendly = "EMWS $primary (self-signed, $(Get-Date -Format yyyy-MM-dd))"

# ---- what is there now ----
$binding = Get-WebBinding -Name $SiteName -Protocol https | Where-Object { $_.bindingInformation -like "*:443:$primary" } | Select-Object -First 1
if ($binding -and $binding.certificateHash) {
    $old = Get-ChildItem Cert:\LocalMachine\My, Cert:\LocalMachine\WebHosting -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $binding.certificateHash } | Select-Object -First 1
    if ($old) {
        $names = ($old.DnsNameList | ForEach-Object { $_.Unicode }) -join ', '
        Write-Host "The https binding currently uses: $($old.Subject), for [$names], valid until $($old.NotAfter.ToString('yyyy-MM-dd'))"
        if ($old.NotAfter -lt (Get-Date)) { Write-Host '  ...which has expired.' }
        if ($names -notlike "*$primary*") { Write-Host "  ...and does not name $primary, so browsers reject it." }
    }
}

if (-not $PSCmdlet.ShouldProcess($SiteName, "Make a certificate for [$($HostName -join ', ')], trust it on this machine, and bind it")) { exit 0 }

# ---- 1. the certificate ----
$cert = New-SelfSignedCertificate `
    -DnsName $HostName `
    -FriendlyName $friendly `
    -CertStoreLocation 'Cert:\LocalMachine\My' `
    -KeyAlgorithm RSA -KeyLength 2048 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears($Years) `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')   # server authentication
Write-Host "Made:    $($cert.Subject) [$($HostName -join ', ')], thumbprint $($cert.Thumbprint), until $($cert.NotAfter.ToString('yyyy-MM-dd'))"

# ---- 2. trust it, on this machine ----
# Browsers here consult the machine's Trusted Root store; a certificate in it is accepted
# without a warning. This is the step that makes it a secure page.
$root = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
$root.Open('ReadWrite')
try {
    $public = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cert.Export('Cert'))
    $root.Add($public)
} finally {
    $root.Close()
}
Write-Host 'Trusted: added to this machine''s Trusted Root Certification Authorities'

# ---- 3. bind it ----
if (-not $binding) {
    New-WebBinding -Name $SiteName -Protocol https -Port 443 -HostHeader $primary -SslFlags 1 | Out-Null
    $binding = Get-WebBinding -Name $SiteName -Protocol https | Where-Object { $_.bindingInformation -like "*:443:$primary" } | Select-Object -First 1
    Write-Host "Bound:   new https binding for $primary"
}
$binding.AddSslCertificate($cert.Thumbprint, 'My')
Write-Host "Bound:   https://$primary/ now serves the new certificate"

# ---- 4. for other machines ----
if ($ExportTo) {
    Export-Certificate -Cert $cert -FilePath $ExportTo -Type CERT | Out-Null
    Write-Host "Exported: $ExportTo - import it into another machine's Trusted Root store and it will accept the site too"
}

Write-Host ''
Write-Host 'Check it with a browser, or:'
Write-Host "  node scripts/smoke-browser.mjs https://$primary/ --vna"
Write-Host 'A browser that had the site open needs restarting before it re-checks the certificate.'
