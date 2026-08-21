; =====================================================================
; FNOS 自定义 NSIS fragment (v1.12)
;
; 本文件通过 package.json 的 build.nsis.include 被 electron-builder
; 注入到主安装脚本中。因此不能定义 PRODUCT_NAME / OutFile / Section
; "-Core" 等，只提供 customInstall / customUnInstall 宏，在主流程
; 完成文件复制后被调用。
;
; 作用：在 electron-builder 默认创建完快捷方式后，删除旧快捷方式，
; 用独立 icon.ico（而非 EXE 资源段）重新创建桌面和开始菜单快捷方式，
; 并强制三重刷新 Windows 图标缓存，彻底解决"新图标不覆盖旧图标"的
; 顽固问题。
; =====================================================================

!include "LogicLib.nsh"

; 主程序文件名（与 package.json productName 一致）
!define FNOS_MAIN_EXE "FNOS.exe"

; ------------------ 安装后回调 ------------------
!macro customInstall
  ; 1) 删除 electron-builder 刚创建的、以及历史上可能存在的所有旧 .lnk，
  ;    强制 Windows 必须重新解析图标。
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$DESKTOP\FNOS Cloud.lnk"
  Delete "$DESKTOP\FNOS 飞牛私有云.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\FNOS Cloud.lnk"
  Delete "$SMPROGRAMS\FNOS 飞牛私有云.lnk"

  ; 2) 重新创建桌面快捷方式：图标【直接引用 $INSTDIR\icon.ico】，
  ;    不通过 EXE 资源段（Windows 对 EXE 图标有内部缓存，是历史版本
  ;    图标不刷新的根因）。
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" \
    "$INSTDIR\${FNOS_MAIN_EXE}" "" \
    "$INSTDIR\icon.ico" 0 SW_SHOWNORMAL "" "" "" \
    "FNOS 飞牛私有云桌面客户端"

  ; 3) 开始菜单快捷方式（electron-builder 默认在 $SMPROGRAMS 根目录）
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" \
    "$INSTDIR\${FNOS_MAIN_EXE}" "" \
    "$INSTDIR\icon.ico" 0 SW_SHOWNORMAL "" "" "" \
    "FNOS 飞牛私有云桌面客户端"

  ; 4) 写入 AppUserModelID，与 main.js 中 app.setAppUserModelId('com.fnos.client')
  ;    一致，任务栏分组和通知区域统一使用飞牛 LOGO。
  WriteRegStr HKCU \
    "Software\Microsoft\Windows\CurrentVersion\PropertySystem\SystemTileData\$DESKTOP\${SHORTCUT_NAME}.lnk" \
    "AppUserModelID" "com.fnos.client"
  WriteRegStr HKCU \
    "Software\Microsoft\Windows\CurrentVersion\PropertySystem\SystemTileData\$SMPROGRAMS\${SHORTCUT_NAME}.lnk" \
    "AppUserModelID" "com.fnos.client"

  ; 5) 三重刷新图标缓存：
  ;    a) SHChangeNotify(SHCNE_ASSOCCHANGED, ...) 通知所有进程文件关联变更
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ;    b) SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, lnkPath) 强制资源管理器
  ;       重读这两个快捷方式的图标
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$DESKTOP\${SHORTCUT_NAME}.lnk", i 0)'
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$SMPROGRAMS\${SHORTCUT_NAME}.lnk", i 0)'
  ;    c) ie4uinit.exe -show 清理并重建图标缓存（Win10/11 通用；Win7/8 自动忽略）
  nsExec::ExecToLog '"$WINDIR\System32\ie4uinit.exe" -show'
  Pop $0
  ;    Win7/8 兼容：-ClearIconCache
  nsExec::ExecToLog '"$WINDIR\System32\ie4uinit.exe" -ClearIconCache'
  Pop $0
!macroend

; ------------------ 卸载后回调 ------------------
!macro customUnInstall
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  ; 卸载后也广播一次，让残留图标立即从桌面/开始菜单消失
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
