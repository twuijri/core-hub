; Core Hub's additions to electron-builder's NSIS installer (electron-builder.config.cjs
; `nsis.include`). Checked by the upgrade job in .github/workflows/desktop.yml.
;
; 1.1.1 installed `corehub.exe` in `%LOCALAPPDATA%\Programs\corehub`; since then the app is
; `Core Hub.exe` in `...\Programs\Core Hub`. electron-builder installs an upgrade into the folder
; the registry remembers (and its directory page appends `\Core Hub` to a folder without that
; name), so on its own an upgrade from 1.1.1 would land in `corehub` or `corehub\Core Hub`.
; customCheckAppRunning runs in the install section before the previous version's uninstaller
; empties its folder: it points the install at the `Core Hub` folder beside the old one. The data
; folder (`%APPDATA%\Core Hub`) is not touched.

; electron-builder leaves these out when customCheckAppRunning is defined; its default check,
; which customCheckAppRunning runs, needs them.
!include "getProcessInfo.nsh"
Var pid

!macro coreHubInstallFolder
  Push $R0
  StrCpy $R0 $INSTDIR "" -17
  ${if} $R0 == "\corehub\Core Hub"
    StrCpy $INSTDIR $INSTDIR -17
    StrCpy $INSTDIR "$INSTDIR\Core Hub"
  ${else}
    StrCpy $R0 $INSTDIR "" -8
    ${if} $R0 == "\corehub"
      StrCpy $INSTDIR $INSTDIR -8
      StrCpy $INSTDIR "$INSTDIR\Core Hub"
    ${endif}
  ${endif}
  Pop $R0
  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

; Replaces electron-builder's default check, which it then runs unchanged.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !insertmacro coreHubInstallFolder
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

; `corehub://` opens this .exe from the moment it is installed. The app registers itself again at
; every start (src/main/index.ts), but a 1.1.1 registration names `corehub.exe`, which the upgrade
; removed, until the new version first runs. Same keys as Electron's setAsDefaultProtocolClient.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\corehub" "" "URL:corehub"
  WriteRegStr HKCU "Software\Classes\corehub" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\corehub\shell\open\command" "" '"$appExe" "%1"'
!macroend

; A real uninstall (not the one an upgrade runs) forgets the scheme when it still names this copy.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $R0 HKCU "Software\Classes\corehub\shell\open\command" ""
    ${if} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      DeleteRegKey HKCU "Software\Classes\corehub"
    ${endif}
  ${endif}
!macroend
