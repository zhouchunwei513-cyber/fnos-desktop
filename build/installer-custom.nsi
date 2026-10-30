; ============================================================
; FNOS Desktop 自定义 NSIS 片段
; 由 package.json 的 build.nsis.include 注入（位置：main script 顶部 header，
; 早于 MUI2 被 include，所以本文件顶层只放 !include / Var，页面函数放在宏内）。
;
; v3.0.24（用户需求）：安装时提供「是否创建桌面快捷方式」的可选项。
;   - 自定义页面插在「选择安装目录」之后（electron-builder 的
;     customPageAfterChangeDir 宏），默认勾选，保持原有行为；
;   - customInstall 在 electron-builder 创建快捷方式之后执行，按勾选状态
;     保留 / 删除 / 重建桌面快捷方式；
;   - 开始菜单快捷方式始终创建（卸载入口依赖它）。
; ============================================================

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; 勾选框句柄 / 勾选状态（${BST_CHECKED} / ${BST_UNCHECKED}）
Var fnosShortcutCheckbox
Var fnosShortcutState

; .onInit 阶段初始化默认值（静默安装 /S 不走页面，也保持默认勾选）
!macro customInit
  StrCpy $fnosShortcutState ${BST_CHECKED}
!macroend

; 「选择附加任务」页：在目录选择页之后出现
!macro customPageAfterChangeDir
  Page custom fnosShortcutPageShow fnosShortcutPageLeave

  Function fnosShortcutPageShow
    !insertmacro MUI_HEADER_TEXT "选择附加任务" "请选择是否为 FNOS 创建桌面快捷方式。开始菜单快捷方式始终创建。"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 28u "是否在桌面创建 FNOS 快捷方式？$\r$\n开始菜单快捷方式始终创建。"
    Pop $0

    ${NSD_CreateCheckbox} 0 36u 100% 14u "创建桌面快捷方式(&D)"
    Pop $fnosShortcutCheckbox
    ${If} $fnosShortcutState == ${BST_CHECKED}
      ${NSD_Check} $fnosShortcutCheckbox
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function fnosShortcutPageLeave
    ${NSD_GetState} $fnosShortcutCheckbox $fnosShortcutState
  FunctionEnd
!macroend

; 安装：electron-builder 已按 createDesktopShortcut 建过桌面链接，
; 这里按用户选择决定保留还是删除；勾选则重建一次（顺带刷新图标缓存）。
!macro customInstall
  ${If} $fnosShortcutState == ${BST_CHECKED}
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "FNOS 飞牛私有云桌面客户端"
    System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${Else}
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\${SHORTCUT_NAME} - 快捷方式.lnk"
    System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}

  ; 开始菜单快捷方式：确保存在并指向主程序（凭据/图标缓存问题兜底）
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "FNOS 飞牛私有云桌面客户端"
  ${EndIf}
!macroend

; 卸载：清掉桌面快捷方式
!macro customUnInstall
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$DESKTOP\${SHORTCUT_NAME} - 快捷方式.lnk"
!macroend
