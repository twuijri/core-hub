# Installs the Microsoft Store MSIX on a Windows CI runner and starts it the way Windows starts a
# Store app (package identity, file-system virtualisation), in local mode, and checks that the
# embedded hub answers and where its data went. Run by .github/workflows/desktop.yml.
#
# Windows installs only a signed package, and the Store signs the real one; so a COPY is signed
# here with a throwaway self-signed certificate for the same publisher. The certificate and its
# key exist only on the runner for this step and are removed at the end; the artifact stays
# unsigned.
param([Parameter(Mandatory = $true)][string]$Msix)
$ErrorActionPreference = 'Stop'

$publisher = 'CN=814A0A23-0E7E-4406-8883-4E483DF08BDA'
$identity = 'AbdulazizAltuwijri.CoreHub'
$expectedFamily = 'AbdulazizAltuwijri.CoreHub_ndbdgnrvvdj6j'
$port = 47811
$work = Join-Path $env:RUNNER_TEMP 'msix-smoke'
New-Item -ItemType Directory -Force $work | Out-Null
$signed = Join-Path $work 'CoreHub-smoke.msix'
Copy-Item $Msix $signed

$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature `
  -FriendlyName 'Core Hub CI throwaway' -CertStoreLocation 'Cert:\CurrentUser\My' `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$password = [guid]::NewGuid().ToString('N')
$pfx = Join-Path $work 'throwaway.pfx'
$cer = Join-Path $work 'throwaway.cer'
$summary = @()
try {
  Export-PfxCertificate -Cert $cert -FilePath $pfx `
    -Password (ConvertTo-SecureString $password -AsPlainText -Force) | Out-Null
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
  $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $signtool) { throw 'signtool.exe was not found in the Windows SDK' }
  & $signtool.FullName sign /q /fd SHA256 /f $pfx /p $password $signed
  if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }

  Add-AppxPackage -Path $signed
  $pkg = Get-AppxPackage -Name $identity
  if (-not $pkg) { throw 'the package did not install' }
  Write-Output "Installed $($pkg.PackageFullName)"
  # The family name comes from the identity name and the publisher: it must be Partner Center's.
  if ($pkg.PackageFamilyName -ne $expectedFamily) {
    throw "package family $($pkg.PackageFamilyName), Partner Center says $expectedFamily"
  }
  $summary += "| Package family | ``$($pkg.PackageFamilyName)`` (Partner Center's) |"

  # Local mode from the first launch: desktop.json where the app will read it. A packaged app
  # sees the real %APPDATA% merged with its own copy, so both places get the same file.
  $real = Join-Path $env:APPDATA 'Core Hub'
  $packageRoot = Join-Path $env:LOCALAPPDATA "Packages\$($pkg.PackageFamilyName)"
  $private = Join-Path $packageRoot 'LocalCache\Roaming\Core Hub'
  $config = [ordered]@{ version = 1; mode = 'local'; port = $port; language = 'en'; closeToTray = $false } |
    ConvertTo-Json
  foreach ($dir in @($real, $private)) {
    New-Item -ItemType Directory -Force $dir | Out-Null
    Set-Content -Path (Join-Path $dir 'desktop.json') -Value $config -Encoding utf8NoBOM
  }

  Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!CoreHub"
  $health = $null
  $deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $deadline -and -not $health) {
    Start-Sleep -Seconds 3
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 5
    } catch {
      $health = $null
    }
  }
  $running = @(Get-Process -Name corehub -ErrorAction SilentlyContinue)
  Write-Output "corehub processes: $($running.Count)"
  if (-not $health) {
    Get-ChildItem -Recurse -ErrorAction SilentlyContinue $real, $packageRoot | Select-Object FullName | Format-Table -AutoSize | Out-String -Width 300 | Write-Output
    throw "the MSIX app's local hub did not answer on http://127.0.0.1:$port/api/v1/health"
  }
  Write-Output "health: $($health | ConvertTo-Json -Compress)"
  $summary += "| Local mode | the embedded hub answered ``/api/v1/health`` |"

  # Where the hub's database went: the package's private copy of %APPDATA% (virtualised) or the
  # real one. Either is writable and outside the read-only install folder.
  $inPrivate = Get-ChildItem -Recurse -Filter hub.sqlite -ErrorAction SilentlyContinue $packageRoot
  $inReal = Test-Path (Join-Path $real 'local-hub\hub.sqlite')
  if ($inPrivate) { Write-Output "hub.sqlite (package folder): $($inPrivate[0].FullName)" }
  Write-Output "hub.sqlite in the real %APPDATA%\Core Hub: $inReal"
  if (-not $inPrivate -and -not $inReal) { throw 'the local hub wrote no database' }
  $where = if ($inPrivate) { "the package's own folder (``$($inPrivate[0].FullName.Replace($env:LOCALAPPDATA, '%LOCALAPPDATA%'))``)" } else { 'the real `%APPDATA%\Core Hub\local-hub`' }
  $summary += "| Hub data | $where |"
} finally {
  Get-Process -Name corehub -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Get-AppxPackage -Name $identity | Remove-AppxPackage -ErrorAction SilentlyContinue
  Get-ChildItem 'Cert:\LocalMachine\TrustedPeople', 'Cert:\CurrentUser\My' |
    Where-Object { $_.Thumbprint -eq $cert.Thumbprint } | Remove-Item -ErrorAction SilentlyContinue
  Remove-Item -Force -ErrorAction SilentlyContinue $pfx, $cer, $signed
  if ($summary.Count -gt 0 -and $env:GITHUB_STEP_SUMMARY) {
    @('### MSIX run', '', '| Check | Result |', '|---|---|') + $summary |
      Add-Content -Path $env:GITHUB_STEP_SUMMARY
  }
}
