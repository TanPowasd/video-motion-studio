; Vmotion Windows installer (NSIS 3, per-user, no administrator rights).
; Built by scripts/package-installer.ts, which stages a copy of the portable package without
; portable.flag/profile and passes:
;   VERSION, VIVERSION, SOURCE_DIR, FILES_NSH (VM_REMOVE_PROGRAM macro), OUTFILE, ESTIMATED_KB
; See docs/INSTALLER.md.

Unicode true
ManifestDPIAware true

!ifndef VERSION | VIVERSION | SOURCE_DIR | FILES_NSH | OUTFILE
  !error "Build with scripts/package-installer.ts (npm run package:installer)"
!endif
!ifndef ESTIMATED_KB
  !define ESTIMATED_KB 0
!endif

!define APP_NAME "Vmotion"
!define APP_EXE "Vmotion.exe"
!define APP_KEY "Software\Vmotion"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vmotion"
!define UNINST_EXE "Uninstall Vmotion.exe"
!define PROG_ID "Vmotion.Project"
!define DIR_VERB_KEY "Software\Classes\Directory\shell\Vmotion"
; Electron's default userData for package name "vmotion" (installed, non-portable builds).
!define PROFILE_DIR "$APPDATA\vmotion"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "${FILES_NSH}"

Name "${APP_NAME} ${VERSION}"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Vmotion"
InstallDirRegKey HKCU "${APP_KEY}" "InstallDir"
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "${APP_NAME} ${VERSION}"
ShowInstDetails hide
ShowUninstDetails hide

!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Vmotion"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_COMPONENTS
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

VIProductVersion "${VIVERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "LegalCopyright" "Apache-2.0"

; ---------------------------------------------------------------- shared helpers

; Vmotion.exe is locked while the desktop app or a CLI/MCP session (ELECTRON_RUN_AS_NODE)
; runs from this folder; replacing or deleting files then would leave a broken install.
!macro VM_ENSURE_NOT_RUNNING_FN prefix
Function ${prefix}EnsureNotRunning
  ${If} ${FileExists} "$INSTDIR\${APP_EXE}"
    retry:
    ClearErrors
    FileOpen $0 "$INSTDIR\${APP_EXE}" a
    ${If} ${Errors}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Vmotion 正在运行（桌面窗口，或外部 agent 的 CLI/MCP 会话）。$\r$\n请先关闭它们，然后点“重试”。" /SD IDCANCEL IDRETRY retry
      Abort "Vmotion 正在运行"
    ${EndIf}
    FileClose $0
  ${EndIf}
FunctionEnd
!macroend
!insertmacro VM_ENSURE_NOT_RUNNING_FN ""
!insertmacro VM_ENSURE_NOT_RUNNING_FN "un."

; Add/remove $INSTDIR\bin in the user PATH (see user-path.ps1 for why PowerShell).
!macro VM_USER_PATH mode
  InitPluginsDir
  File "/oname=$PLUGINSDIR\user-path.ps1" "${__FILEDIR__}\user-path.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\user-path.ps1" -Mode ${mode} -Dir "$INSTDIR\bin"'
  Pop $0
  ${If} $0 != "0"
    DetailPrint "无法更新用户 PATH（${mode}）：$0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法自动更新用户 PATH。CLI 仍可通过 $INSTDIR\bin\vmotion.cmd 使用。" /SD IDOK
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro VM_REMOVE_ASSOCIATION
  ReadRegStr $0 HKCU "Software\Classes\.vmotion" ""
  ${If} $0 == "${PROG_ID}"
    DeleteRegValue HKCU "Software\Classes\.vmotion" ""
    DeleteRegKey /ifempty HKCU "Software\Classes\.vmotion"
  ${EndIf}
  DeleteRegKey HKCU "Software\Classes\${PROG_ID}"
  DeleteRegKey HKCU "${DIR_VERB_KEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro VM_REMOVE_SHORTCUTS
  Delete "$SMPROGRAMS\Vmotion\Vmotion.lnk"
  Delete "$SMPROGRAMS\Vmotion\Vmotion Agent 工作台.lnk"
  Delete "$SMPROGRAMS\Vmotion\卸载 Vmotion.lnk"
  RMDir "$SMPROGRAMS\Vmotion"
!macroend

; ---------------------------------------------------------------- install


; Refuse a portable copy (it would switch back to its own profile) and warn before
; installing into a non-empty folder that is not an earlier Vmotion install.
Function DirectoryLeave
  ${If} ${FileExists} "$INSTDIR\portable.flag"
    MessageBox MB_OK|MB_ICONEXCLAMATION "这个文件夹是 Vmotion 便携版（含 portable.flag）。请选择其他安装目录，便携版保持不变。"
    Abort
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\*.*"
  ${AndIfNot} ${FileExists} "$INSTDIR\${APP_EXE}"
    FindFirst $0 $1 "$INSTDIR\*.*"
    StrCpy $2 0
    ${DoWhile} $1 != ""
      ${If} $1 != "."
      ${AndIf} $1 != ".."
        StrCpy $2 1
        ${Break}
      ${EndIf}
      FindNext $0 $1
    ${Loop}
    FindClose $0
    ${If} $2 == 1
      MessageBox MB_YESNO|MB_ICONQUESTION "所选文件夹不是空的，也不是已有的 Vmotion 安装。$\r$\n建议安装到单独的 Vmotion 文件夹。仍然安装到这里吗？" IDYES +2
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Vmotion 程序（必需）" SecMain
  SectionIn RO
  SetShellVarContext current
  Call EnsureNotRunning
  SetOutPath "$INSTDIR"
  ; Upgrade-over-install: remove the previous program entries so stale files do not linger.
  ; Only top-level entries the installer owns; user files in the folder and the profile stay.
  !insertmacro VM_REMOVE_PROGRAM
  Delete "$INSTDIR\portable-manifest.json"
  File /r "${SOURCE_DIR}\*.*"
  ; An installed build must never be portable: settings live in the per-user profile.
  Delete "$INSTDIR\portable.flag"
  WriteUninstaller "$INSTDIR\${UNINST_EXE}"

  CreateDirectory "$SMPROGRAMS\Vmotion"
  CreateShortcut "$SMPROGRAMS\Vmotion\Vmotion.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\Vmotion\Vmotion Agent 工作台.lnk" "$INSTDIR\${APP_EXE}" "--agent-workbench" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\Vmotion\卸载 Vmotion.lnk" "$INSTDIR\${UNINST_EXE}"

  WriteRegStr HKCU "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "Version" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINST_EXE}"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINST_EXE}" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" ${ESTIMATED_KB}
SectionEnd

Section "桌面快捷方式" SecDesktop
  SetShellVarContext current
  CreateShortcut "$DESKTOP\Vmotion.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

Section "关联 .vmotion 文件，文件夹右键“用 Vmotion 打开”" SecAssoc
  WriteRegStr HKCU "Software\Classes\.vmotion" "" "${PROG_ID}"
  WriteRegStr HKCU "Software\Classes\${PROG_ID}" "" "Vmotion 工程"
  WriteRegStr HKCU "Software\Classes\${PROG_ID}\DefaultIcon" "" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "Software\Classes\${PROG_ID}\shell\open\command" "" '"$INSTDIR\${APP_EXE}" --project "%1"'
  WriteRegStr HKCU "${DIR_VERB_KEY}" "" "用 Vmotion 打开"
  WriteRegStr HKCU "${DIR_VERB_KEY}" "Icon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${DIR_VERB_KEY}\command" "" '"$INSTDIR\${APP_EXE}" --project "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd

Section "把 vmotion 命令加入用户 PATH" SecPath
  !insertmacro VM_USER_PATH add
SectionEnd

; Record the choices and undo components unticked during an upgrade.
Section "-Finish"
  SetShellVarContext current
  ${If} ${SectionIsSelected} ${SecDesktop}
    WriteRegDWORD HKCU "${APP_KEY}" "DesktopShortcut" 1
  ${Else}
    WriteRegDWORD HKCU "${APP_KEY}" "DesktopShortcut" 0
    Delete "$DESKTOP\Vmotion.lnk"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecAssoc}
    WriteRegDWORD HKCU "${APP_KEY}" "FileAssociation" 1
  ${Else}
    WriteRegDWORD HKCU "${APP_KEY}" "FileAssociation" 0
    !insertmacro VM_REMOVE_ASSOCIATION
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecPath}
    WriteRegDWORD HKCU "${APP_KEY}" "UserPath" 1
  ${Else}
    ReadRegDWORD $1 HKCU "${APP_KEY}" "UserPath"
    WriteRegDWORD HKCU "${APP_KEY}" "UserPath" 0
    ${If} $1 == "1"
      !insertmacro VM_USER_PATH remove
    ${EndIf}
  ${EndIf}
SectionEnd

; Defined after the sections so the ${Sec*} indexes exist.
Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Vmotion 需要 64 位 Windows 10/11。" /SD IDOK
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Vmotion 需要 Windows 10 或 Windows 11。" /SD IDOK
    Abort
  ${EndIf}
  ; Upgrade over an existing install: keep the optional components the user chose before.
  ReadRegStr $0 HKCU "${APP_KEY}" "InstallDir"
  ${If} $0 != ""
    ReadRegDWORD $1 HKCU "${APP_KEY}" "DesktopShortcut"
    ${If} $1 == "0"
      SectionSetFlags ${SecDesktop} 0
    ${EndIf}
    ReadRegDWORD $1 HKCU "${APP_KEY}" "FileAssociation"
    ${If} $1 == "0"
      SectionSetFlags ${SecAssoc} 0
    ${EndIf}
    ReadRegDWORD $1 HKCU "${APP_KEY}" "UserPath"
    ${If} $1 == "0"
      SectionSetFlags ${SecPath} 0
    ${EndIf}
  ${EndIf}
FunctionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "程序文件、开始菜单快捷方式和卸载程序。设置保存在 %APPDATA%\vmotion，升级时保留。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "在桌面创建 Vmotion 快捷方式。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAssoc} "双击 .vmotion 文件打开所在工程；在文件夹右键菜单中直接用 Vmotion 打开工程。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPath} "把 $INSTDIR\bin 加入当前用户 PATH，新终端中可直接运行 vmotion（CLI/MCP）。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---------------------------------------------------------------- uninstall

Function un.onInit
  SetShellVarContext current
FunctionEnd

Section "un.Vmotion 程序与快捷方式（保留工程）" UnSecMain
  SectionIn RO
  SetShellVarContext current
  Call un.EnsureNotRunning
  !insertmacro VM_REMOVE_SHORTCUTS
  Delete "$DESKTOP\Vmotion.lnk"
  !insertmacro VM_REMOVE_ASSOCIATION
  ReadRegDWORD $1 HKCU "${APP_KEY}" "UserPath"
  ${If} $1 == "1"
    !insertmacro VM_USER_PATH remove
  ${EndIf}
  ; Exactly the entries the installer wrote; projects kept in this folder are not touched.
  !insertmacro VM_REMOVE_PROGRAM
  Delete "$INSTDIR\${UNINST_EXE}"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
SectionEnd

Section /o "un.同时删除设置、最近项目和界面缓存（%APPDATA%\vmotion）" UnSecProfile
  SetShellVarContext current
  RMDir /r "${PROFILE_DIR}"
SectionEnd

!insertmacro MUI_UNFUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${UnSecMain} "删除程序文件、快捷方式、文件关联和 PATH 项。你的工程、素材和导出文件不会被删除。"
  !insertmacro MUI_DESCRIPTION_TEXT ${UnSecProfile} "默认保留，以便重新安装后恢复设置和最近项目。勾选后一并删除 %APPDATA%\vmotion。"
!insertmacro MUI_UNFUNCTION_DESCRIPTION_END
