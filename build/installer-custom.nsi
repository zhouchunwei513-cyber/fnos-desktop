; =====================================================================
; FNOS 自定义 NSIS 安装脚本 (v1.12)
; 由沙箱内的 Linux makensis 直接编译，不依赖 wine。
; 功能：
;   - 检测程序是否在运行，若运行则提示退出后重试
;   - 选择安装目录（MUI_PAGE_DIRECTORY）
;   - 默认创建桌面快捷方式 + 开始菜单程序组（无选项页，强制创建）
;   - 释放 win-unpacked 目录中的全部文件
;   - 生成卸载程序、控制面板卸载项
;   - v1.10.5: 安装前删除旧的快捷方式并刷新 Windows 图标缓存，
;             确保新安装后快捷方式图标立即更新为飞牛 LOGO
; =====================================================================

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

; ------------------ 基本信息 ------------------
!define PRODUCT_NAME       "FNOS"
!define PRODUCT_VERSION    "1.12.0"
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

  ; v1.12: 彻底解决桌面/开始菜单快捷方式图标不刷新的顽固问题。
  ; 1) 删除所有可能存在的旧 .lnk（包括历史上其他快捷方式名）让 Windows 必须重建；
  ; 2) 桌面 / 开始菜单图标直接引用 $INSTDIR\icon.ico（独立 ICO 文件，
  ;    不依赖 EXE 资源段缓存），避免 Windows 资源管理器对 EXE 图标的内部缓存；
  ; 3) SHChangeNotify 广播 SHCNE_ASSOCCHANGED + SHCNE_UPDATEITEM，
  ;    并调用 ie4uinit.exe -show（Win10/11 会重建图标缓存并刷新任务栏/桌面）。
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$DESKTOP\FNOS Cloud.lnk"
  Delete "$DESKTOP\FNOS 飞牛私有云.lnk"
  !insertmacro MUI_STARTMENU_WRITE_BEGIN App
    Delete "$SMPROGRAMS\$StartMenuFolder\${PRODUCT_NAME}.lnk"
    Delete "$SMPROGRAMS\$StartMenuFolder\FNOS Cloud.lnk"
    Delete "$SMPROGRAMS\$StartMenuFolder\FNOS 飞牛私有云.lnk"
    Delete "$SMPROGRAMS\$StartMenuFolder\卸载 ${PRODUCT_NAME}.lnk"
  !insertmacro MUI_STARTMENU_WRITE_END

  ; 确保 icon.ico 存在于安装目录（package.json 已把 icon.ico 列入 files）
  ; 桌面快捷方式：图标使用独立 ICO 文件，绕开 EXE 图标缓存
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${MAIN_EXE}" "" "$INSTDIR\icon.ico" 0 SW_SHOWNORMAL "" "" "" "FNOS 飞牛私有云桌面客户端"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\PropertySystem\SystemTileData\$DESKTOP\${PRODUCT_NAME}.lnk" "AppUserModelID" "com.fnos.client"

  ; 开始菜单程序组
  !insertmacro MUI_STARTMENU_WRITE_BEGIN App
    CreateDirectory "$SMPROGRAMS\$StartMenuFolder"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\${PRODUCT_NAME}.lnk" "$INSTDIR\${MAIN_EXE}" "" "$INSTDIR\icon.ico" 0 SW_SHOWNORMAL "" "" "" "FNOS 飞牛私有云桌面客户端"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\卸载 ${PRODUCT_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\icon.ico" 0 SW_SHOWNORMAL
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\PropertySystem\SystemTileData\$SMPROGRAMS\$StartMenuFolder\${PRODUCT_NAME}.lnk" "AppUserModelID" "com.fnos.client"
  !insertmacro MUI_STARTMENU_WRITE_END

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; v1.12: 三重刷新图标缓存
  ; 1) SHChangeNotify(SHCNE_ASSOCCHANGED, ...) 通知所有进程关联变更
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ; 2) SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, lnkPath) 强制资源管理器重读该快捷方式
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$DESKTOP\${PRODUCT_NAME}.lnk", i 0)'
  ; 3) ie4uinit.exe -show 清理并重建图标缓存（Win10/11 通用；在 Win7/8 上自动忽略）
  nsExec::ExecToLog '"$WINDIR\System32\ie4uinit.exe" -show'
  Pop $0
  ; 兼容 Win7/8：-ClearIconCache
  nsExec::ExecToLog '"$WINDIR\System32\ie4uinit.exe" -ClearIconCache'
  Pop $0
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
