# Upgrades a Windows CI runner from the published 1.1.1 installer (`corehub.exe` in
# `%LOCALAPPDATA%\Programs\corehub`) to the NSIS installer just built (`Core Hub.exe` in
# `...\Programs\Core Hub`), silently, the way the app's update link is used, and checks that
# nothing of the old name is left: the old folder and .exe, the shortcuts, the uninstall entry,
# the corehub:// registration, and a shortcut the person made (here in Startup, to open the app
# at login), which the new app points at itself when it starts. Then uninstalls. Run by
# .github/workflows/desktop.yml; see scripts/installer.nsh and src/shared/legacy-shortcuts.ts.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = 'Stop'

$work = Join-Path $env:RUNNER_TEMP 'nsis-upgrade'
New-Item -ItemType Directory -Force $work | Out-Null
$programs = Join-Path $env:LOCALAPPDATA 'Programs'
$oldDir = Join-Path $programs 'corehub'
$oldExe = Join-Path $oldDir 'corehub.exe'
$newDir = Join-Path $programs 'Core Hub'
$newExe = Join-Path $newDir 'Core Hub.exe'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$startup = Join-Path $startMenu 'Startup'
$ownLink = Join-Path $startup 'Core Hub.lnk'
$protocolKey = 'HKCU:\Software\Classes\corehub\shell\open\command'
$shell = New-Object -ComObject WScript.Shell
$summary = @()

function Target([string]$link) { $shell.CreateShortcut($link).TargetPath }
function Expect([bool]$ok, [string]$what) {
  if (-not $ok) { throw "upgrade: $what" }
  Write-Output "ok: $what"
}
function UninstallEntries {
  @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
      ForEach-Object { Get-ItemProperty $_.PSPath } |
      Where-Object { $_.DisplayName -like 'Core Hub*' })
}
function Install([string]$exe) {
  $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "$exe exited with $($p.ExitCode)" }
}

# 1.1.1 as people have it: installed, started once (it registered corehub:// to itself), and a
# shortcut of their own in Startup.
$old = Join-Path $work 'Core-Hub-Setup-1.1.1-x64.exe'
gh release download v1.1.1 --repo $env:GITHUB_REPOSITORY --pattern 'Core-Hub-Setup-1.1.1-x64.exe' --dir $work --clobber
if ($LASTEXITCODE -ne 0) { throw 'could not download the 1.1.1 installer' }
Install $old
Expect (Test-Path $oldExe) "1.1.1 installed $oldExe"
New-Item -Force -Path $protocolKey | Out-Null
Set-Item -Path $protocolKey -Value "`"$oldExe`" `"%1`""
New-Item -ItemType Directory -Force $startup | Out-Null
$link = $shell.CreateShortcut($ownLink)
$link.TargetPath = $oldExe
$link.WorkingDirectory = $oldDir
$link.Save()

# The upgrade.
Install $Installer
Expect (Test-Path $newExe) "the app is $newExe"
Expect (-not (Test-Path $oldDir)) "the old folder $oldDir is gone"
$strays = @(Get-ChildItem $programs -Recurse -Filter 'corehub.exe' -ErrorAction SilentlyContinue)
Expect ($strays.Count -eq 0) "no corehub.exe is left under $programs"
$menuLink = Join-Path $startMenu 'Core Hub.lnk'
Expect ((Target $menuLink) -eq $newExe) "the Start menu shortcut opens $newExe"
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Core Hub.lnk'
Expect ((Target $desktopLink) -eq $newExe) "the desktop shortcut opens $newExe"
$entries = UninstallEntries
Expect ($entries.Count -eq 1) "one uninstall entry (found $($entries.Count))"
Expect ($entries[0].DisplayName -eq "Core Hub $Version") "the uninstall entry is 'Core Hub $Version' ($($entries[0].DisplayName))"
Expect ($entries[0].InstallLocation -eq $newDir) "the uninstall entry points at $newDir ($($entries[0].InstallLocation))"
$command = (Get-Item $protocolKey).GetValue('')
Expect ($command -eq "`"$newExe`" `"%1`"") "corehub:// opens the new .exe before its first start ($command)"
$summary += "| Upgrade from 1.1.1 | ``$newExe``, old folder removed, shortcuts, uninstall entry and corehub:// on the new .exe |"

# The person's own Startup shortcut follows when the new app starts.
Expect ((Target $ownLink) -eq $oldExe) 'the Startup shortcut still names corehub.exe before the app starts'
$app = Start-Process -FilePath $newExe -PassThru
try {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Target $ownLink) -ne $newExe -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  Expect ((Target $ownLink) -eq $newExe) "the Startup shortcut now opens $newExe"
  Expect ($shell.CreateShortcut($ownLink).WorkingDirectory -eq $newDir) "its Start in folder is $newDir"
} finally {
  Get-Process -Name 'Core Hub' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
$summary += '| A Startup shortcut to corehub.exe | points at `Core Hub.exe` after the first start |'

# Uninstall: the folder, the entry and the corehub:// registration go.
Start-Sleep -Seconds 2
$uninstaller = Join-Path $newDir 'Uninstall Core Hub.exe'
Expect (Test-Path $uninstaller) "the uninstaller is $uninstaller"
Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
$deadline = (Get-Date).AddSeconds(90)
while (((UninstallEntries).Count -gt 0 -or (Test-Path $newExe)) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
Expect ((UninstallEntries).Count -eq 0) 'the uninstall entry is gone'
Expect (-not (Test-Path $newExe)) "$newExe is gone"
Expect (-not (Test-Path 'HKCU:\Software\Classes\corehub')) 'corehub:// is unregistered'
$summary += '| Uninstall | files, entry and corehub:// removed |'
Remove-Item -Force $ownLink -ErrorAction SilentlyContinue

if ($env:GITHUB_STEP_SUMMARY) {
  Add-Content $env:GITHUB_STEP_SUMMARY "`n| Windows NSIS | Result |`n|---|---|"
  $summary | ForEach-Object { Add-Content $env:GITHUB_STEP_SUMMARY $_ }
}
