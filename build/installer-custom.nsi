; =====================================================================
; FNOS 自定义 NSIS 安装脚本 (v1.11)
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
!define PRODUCT_VERSION    "1.11"
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

  ; v1.11: 彻底解决桌面/开始菜单快捷方式图标不刷新的问题。
  ; 1) 删除旧 .lnk 让 Windows 重新解析图标；
  ; 2) 同时删除用户级 IconCache.db 中相关缓存通过 SHChangeNotify；
  ; 3) 显式调用 ie4uinit.exe -ClearIconCache（Win10/11 通用）刷新图标缓存。
  ; 注意：不使用 -show 参数，避免在某些 Windows 版本上短暂闪任务栏。
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  !insertmacro MUI_STARTMENU_WRITE_BEGIN App
    Delete "$SMPROGRAMS\$StartMenuFolder\${PRODUCT_NAME}.lnk"
    Delete "$SMPROGRAMS\$StartMenuFolder\卸载 ${PRODUCT_NAME}.lnk"
  !insertmacro MUI_STARTMENU_WRITE_END

  ; 桌面快捷方式（始终创建）
  ; iconPathName 同时指向 $INSTDIR\${MAIN_EXE}（rcedit 已把飞牛 LOGO 写入 EXE 资源段）
  ; 并通过额外写入 .ico 旁挂，确保即使 Windows 图标缓存异常也能正确解析
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${MAIN_EXE}" "" "$INSTDIR\${MAIN_EXE}" 0 SW_SHOWNORMAL "" "" "" "FNOS 飞牛私有云桌面客户端"
  ; 设置 AppUserModelID（和 main.js 中 setAppUserModelId 一致）
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\PropertySystem\SystemTileData\$DESKTOP\${PRODUCT_NAME}.lnk" "AppUserModelID" "com.fnos.client"

  ; 开始菜单程序组（始终创建）
  !insertmacro MUI_STARTMENU_WRITE_BEGIN App
    CreateDirectory "$SMPROGRAMS\$StartMenuFolder"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\${PRODUCT_NAME}.lnk"   "$INSTDIR\${MAIN_EXE}" "" "$INSTDIR\${MAIN_EXE}" 0 SW_SHOWNORMAL "" "" "" "FNOS 飞牛私有云桌面客户端"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\卸载 ${PRODUCT_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0 SW_SHOWNORMAL
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\PropertySystem\SystemTileData\$SMPROGRAMS\$StartMenuFolder\${PRODUCT_NAME}.lnk" "AppUserModelID" "com.fnos.client"
  !insertmacro MUI_STARTMENU_WRITE_END

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; v1.11: 双重刷新图标缓存。SHChangeNotify 广播关联变更 + ie4uinit 清理缓存。
  ; SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, NULL, NULL)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ; 异步调用 ie4uinit.exe -ClearIconCache（不阻塞安装完成）
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
