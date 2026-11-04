# FNOS 客户端强力卸载器

一个**便携单文件** EXE：把 FNOS 飞牛私有云桌面客户端**装在哪、跑了什么、留下什么**，全部清掉。

- 系统：**Windows 10 / Windows 11**（32 位、64 位均可）
- 运行库：系统自带 .NET Framework 4.x（Win10 1607+ / Win11 全版本内置，无需额外安装）
- 便携：单 exe，免安装、不写自己的注册表、不驻留后台
- 权限：**需要管理员**（右键 →「以管理员身份运行」；直接双击也会弹 UAC）

## 为什么不用自带的卸载

客户端自带卸载（`Uninstall FNOS.exe`）只处理 NSIS 自己登记的那部分：程序目录 + 卸载登记项。
实际测试中，下面这些都会留下：

| 类别 | 具体位置（示例） |
|---|---|
| 用户数据 | `%APPDATA%\fnos-client`（设置、Cookie、日志、皮肤、下载记录、播放进度、窗口状态）、`%APPDATA%\fnos-probe` |
| 便携模式数据 | 便携包会写到 `<exe 同级>\data`，随包位置而定，可能在任意盘 |
| 安装目录 | `%LOCALAPPDATA%\Programs\FNOS`，或用户自选的**任意盘**目录（安装器允许改路径） |
| 注册表 | `HKCU\Software\FNOS`、`...\Uninstall\{GUID}`、`...\Uninstall\FNOS`、`Run` 自启值 `FNOS`、`App Paths\FNOS.exe` |
| 快捷方式 | 桌面、公共桌面、开始菜单、任务栏固定、启动文件夹 |
| 系统痕迹 | `MuiCache`、`AppSwitched`、`AppBadgeUpdated`、`Compatibility Assistant\Store`、`UserAssist`（ROT13 路径）、搜索「最近应用」 |
| 其它 | 计划任务、服务、防火墙规则、崩溃转储 `%LOCALAPPDATA%\CrashDumps\FNOS*.dmp`、`%TEMP%\fnos*`、任务栏跳转列表 |

本工具就是把这些一次性清干净。

## 用法

1. 把 `FNOS-Uninstaller.exe` 放到**桌面**或任意**不在客户端安装目录内**的位置（工具会检测并阻止"自己删自己"）。
2. 右键 →「以管理员身份运行」。
3. 程序自动扫描（默认**深度扫描所有磁盘**，包含其它 Windows 用户目录），几秒到几十秒。
4. **先核对清单**：
   - 顶部摘要显示总项数与勾选数、预计释放空间；
   - 「安装目录 / 用户数据 / 注册表 / 自启」是必看项；
   - 「使用记录」是低价值的最近使用痕迹（灰显），数量可能很多，可用「隐藏使用记录」只看关键项（**隐藏不影响删除**）。
5. 想留底就点「导出清单」，会在 exe 同目录生成 `uninstall-plan.txt`。
6. 点「开始卸载」→ 二次确认 → 执行；完成后自动重新扫描一遍，并生成 `uninstall-report.txt`。

### 命令行（可选）

| 参数 | 作用 |
|---|---|
| `/dry-run` | 只扫描并写出 `uninstall-plan.txt`，**不做任何修改** |
| `/dry-run /no-deep` | 同上，但跳过全盘扫描（几秒出结果） |
| `/silent` | 无人值守：扫描 → 全选 → 删除 → 写报告（失败返回码 2） |
| `/keep-data` | 保留「用户数据」类（设置/Cookie/日志） |
| `/report=<路径>` | 指定报告输出位置 |

例：`FNOS-Uninstaller.exe /dry-run` 先看一眼要删什么。

## 安全设计

- **特征校验**：全盘扫描时必须同时满足「目录里有 `FNOS.exe`」且「同级存在 `resources\app.asar` 或 `resources\app` 或 `Uninstall FNOS.exe` 或 `data\settings.json`」，才会判定为安装目录；仅仅叫 `FNOS` 的空文件夹不会被删。
- **路径白名单**：固定目录按精确名称匹配（`fnos-client`、`fnos-probe`、`Programs\FNOS` 等）。
- **匹配收紧**：注册表值只认 `com.fnos.client`、`\FNOS\`、`fnos-client`、`FNOS.exe` 以及 `fnos-*` 文件名，不会因为「别人家软件名字里带 fnos」被误清（其使用记录除外，见下）。
- **先预览后执行**：默认只扫描，勾选与二次确认之后才动手。
- **占用兜底**：文件被占用时先结束相关进程，仍不行则登记 `PendingFileRenameOperations`，**重启后自动删除**。
- **不碰**：Windows 事件日志、系统还原点、你个人的其它数据、Wi-Fi 密码、浏览器数据。

## 常见问题

**Q：卸载后「程序和功能」里还有 FNOS？**
A：先按提示重启（部分项目登记为重启删除），再运行一次本工具。

**Q：某些项失败（红色 ×）？**
A：多数是文件被占用或不在管理员权限下。重启 → 再运行一次；报告里会列出具体路径，可手动删除。

**Q：便携包本体（`FNOS-x.y.z-portable.exe`）为什么没删？**
A：便携包常与你的其它文件放在同一目录，工具只删它的 `data` 子目录，**不删整个目录**，避免误删同目录的其它文件。便携包 exe 请自己删。

**Q：会删我 NAS 上的数据吗？**
A：不会。只清理本机文件与注册表，不联网、不接触 NAS。

## 从源码构建

```powershell
powershell -ExecutionPolicy Bypass -File build-uninstaller.ps1
# 产物：dist\FNOS-Uninstaller.exe
```

用 Windows 自带 `csc.exe`（.NET Framework 4.x）编译，无第三方依赖、不需要安装 SDK。
源文件：`src/Model.cs`（数据模型）、`src/Util.cs`（文件/注册表/进程/系统版本）、`src/Scanner.cs`（痕迹扫描）、`src/Executor.cs`（清理执行）、`src/Program.cs`（界面与入口）。

## 版本

- 1.0.0：首个版本。覆盖安装目录（任意盘）、用户数据、便携数据、注册表、自启、快捷方式、计划任务、服务、防火墙、崩溃转储、临时文件、跳转列表、最近使用记录；Win10/Win11 适配（真实版本识别、系统级 DPI 感知、Win11 深色标题栏与圆角、深浅色主题跟随）。
