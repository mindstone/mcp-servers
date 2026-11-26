Param (
    [Parameter(Mandatory=$true)][string]$CaCertificateName,
    [Parameter(Mandatory=$true)][string]$CaCertificatePath,
    [Parameter(Mandatory=$true)][string]$LocalhostCertificatePath,
    [Parameter(Mandatory=$true)][string]$OutputMarker
)
$ErrorActionPreference = 'Stop'
$ca = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($CaCertificatePath)
$leaf = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($LocalhostCertificatePath)
$namedCa = $ca.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -eq $CaCertificateName
$roots = @(Get-ChildItem Cert:\CurrentUser\Root | Where-Object {
    $_.Subject -eq $ca.Subject -and $_.Thumbprint -eq $ca.Thumbprint -and
    $_.NotAfter -gt (Get-Date).AddDays(1)
})
$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
$chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
try {
    $chainValid = $chain.Build($leaf)
    $issuer = @($chain.ChainElements.Certificate | Where-Object {
        $_.Subject -eq $leaf.Issuer -and $_.Thumbprint -eq $ca.Thumbprint
    })
    Write-Output $OutputMarker
    @{
        chainValid = [bool]$chainValid
        chainStatus = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
        storeMatches = [bool]($namedCa -and $roots.Count -eq 1)
        issuerMatches = [bool]($issuer.Count -gt 0)
    } | ConvertTo-Json -Compress
} finally {
    $chain.Dispose()
    $leaf.Dispose()
    $ca.Dispose()
}
