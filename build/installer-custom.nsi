; =====================================================================
; FNOS 自定义 NSIS 安装脚本 (v1.10.4)
; 由沙箱内的 Linux makensis 直接编译，不依赖 wine。
; 功能：
;   - 检测程序是否在运行，若运行则提示退出后重试
;   - 选择安装目录（MUI_PAGE_DIRECTORY）
;   - 默认创建桌面快捷方式 + 开始菜单程序组（无选项页，强制创建）
;   - 释放 win-unpacked 目录中的全部文件
;   - 生成卸载程序、控制面板卸载项
; =====================================================================

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

; ------------------ 基本信息 ------------------
!define PRODUCT_NAME       "FNOS"
!define PRODUCT_VERSION    "1.10.4"
!define PRODUCT_PUBLISHER  "FNOS"
!define PRODUCT_REGKEY     "Software\${PRODUCT_PUBLISHER}\${PRODUCT_NAME}"
!define UNINSTALL_REGKEY   "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define MAIN_EXE           "FNOS.exe"
!define MUTEX_NAME         "FNOS_CLIENT_SINGLE_INSTANCE"

Name "${PRODUCT_NAME}"
OutFile "INSTALLER_OUT.exe"
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "${PRODUCT_REGKEY}" "InstallDir"

; ------------------ 变量 ------------------
Var StartMenuFolder

; ------------------ 界面 ------------------
!define MUI_ABORTWARNING
!define MUI_ICON "ICON_PATH"
!define MUI_UNICON "ICON_PATH"
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${PRODUCT_NAME} ${PRODUCT_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "本向导将引导你完成 ${PRODUCT_NAME} 的安装。$\r$\n$\r$\n所有登录信息与缓存均使用 Windows 系统凭据加密保存在本机。$\r$\n$\r$\n点击「下一步」继续。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${MAIN_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "安装完成后立即启动 ${PRODUCT_NAME}"
!define MUI_STARTMENUPAGE_DEFAULTFOLDER "${PRODUCT_NAME}"
!define MUI_STARTMENUPAGE_REGISTRY_ROOT HKCU
!define MUI_STARTMENUPAGE_REGISTRY_KEY  "${PRODUCT_REGKEY}"
!define MUI_STARTMENUPAGE_REGISTRY_VALUENAME "Start Menu Folder"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE_FILE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_STARTMENU "App" $StartMenuFolder
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ------------------ 安装前回调：检测程序是否运行 ------------------
Function .onInit
  ; 使用互斥量检测主程序是否运行；主程序通过 app.requestSingleInstanceLock 创建同名 mutex
label_check:
  System::Call 'kernel32::CreateMutexW(i 0, i 1, w "${MUTEX_NAME}") i .r1 ?e'
  Pop $0
  ${If} $0 = 183  ; ERROR_ALREADY_EXISTS
    MessageBox MB_ICONSTOP|MB_TOPMOST|MB_SETFOREGROUND \
      "检测到 ${PRODUCT_NAME} 正在运行。$\r$\n$\r$\n请先退出正在运行的 ${PRODUCT_NAME}（包括任务栏托盘图标），然后点击「重试」继续安装，或点击「取消」退出安装。" \
      /SD IDRETRY IDRETRY label_check IDCANCEL abort_install
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(i $1)'
  goto done_init
abort_install:
  System::Call 'kernel32::CloseHandle(i $1)'
  Abort
done_init:
FunctionEnd

; ------------------ 安装段 ------------------
Section "-Core" SecCore
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "APP_DIR\*.*"

  WriteRegStr HKCU "${PRODUCT_REGKEY}"  "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${PRODUCT_REGKEY}"  "Version"    "${PRODUCT_VERSION}"

  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "DisplayName"     "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "DisplayVersion"  "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "Publisher"       "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "DisplayIcon"     "$INSTDIR\${MAIN_EXE}"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_REGKEY}" "NoRepair" 1

  ; 桌面快捷方式（始终创建）
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${MAIN_EXE}" "" "$INSTDIR\${MAIN_EXE}" 0

  ; 开始菜单程序组（始终创建）
  !insertmacro MUI_STARTMENU_WRITE_BEGIN App
    CreateDirectory "$SMPROGRAMS\$StartMenuFolder"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\${PRODUCT_NAME}.lnk"   "$INSTDIR\${MAIN_EXE}" "" "$INSTDIR\${MAIN_EXE}" 0
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\卸载 ${PRODUCT_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
  !insertmacro MUI_STARTMENU_WRITE_END

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

; ------------------ 卸载前回调：检测程序是否运行 ------------------
Function un.onInit
label_uncheck:
  System::Call 'kernel32::CreateMutexW(i 0, i 1, w "${MUTEX_NAME}") i .r1 ?e'
  Pop $0
  ${If} $0 = 183
    MessageBox MB_ICONSTOP|MB_TOPMOST|MB_SETFOREGROUND \
      "检测到 ${PRODUCT_NAME} 正在运行。$\r$\n$\r$\n请先退出正在运行的 ${PRODUCT_NAME}（包括任务栏托盘图标），然后点击「重试」继续卸载，或点击「取消」退出卸载。" \
      /SD IDRETRY IDRETRY label_uncheck IDCANCEL un_abort
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(i $1)'
  goto un_done
un_abort:
  System::Call 'kernel32::CloseHandle(i $1)'
  Abort
un_done:
FunctionEnd

; ------------------ 卸载 ------------------
Section "Uninstall"
  ; 删除程序文件
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.exe"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.css"
  Delete "$INSTDIR\*.js"
  Delete "$INSTDIR\*.svg"
  Delete "$INSTDIR\*.png"
  Delete "$INSTDIR\*.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  !insertmacro MUI_STARTMENU_GETFOLDER "App" $StartMenuFolder
  RMDir /r "$SMPROGRAMS\$StartMenuFolder"

  DeleteRegKey HKCU "${PRODUCT_REGKEY}"
  DeleteRegKey HKCU "${UNINSTALL_REGKEY}"
SectionEnd
