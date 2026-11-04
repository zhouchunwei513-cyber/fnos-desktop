// FNOS 客户端强力卸载器 —— 痕迹扫描
// 原则：只删「有 FNOS 特征」的东西；固定白名单目录按名称精确匹配；全盘扫描必须通过特征校验。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Microsoft.Win32;

namespace FnosUninstall
{
    public static class Scanner
    {
        // 固定数据/安装目录（%变量% 形式，运行时展开）
        private static readonly string[] KnownDirs = new string[]
        {
            @"%APPDATA%\fnos-client",
            @"%APPDATA%\FNOS",
            @"%APPDATA%\fnos-probe",
            @"%LOCALAPPDATA%\fnos-client",
            @"%LOCALAPPDATA%\FNOS",
            @"%LOCALAPPDATA%\fnos-updater",
            @"%LOCALAPPDATA%\Programs\FNOS",
            @"%LOCALAPPDATA%\Programs\fnos-client",
            @"%PROGRAMFILES%\FNOS",
            @"%PROGRAMFILES(X86)%\FNOS",
            @"%PROGRAMDATA%\FNOS",
            @"%PROGRAMDATA%\fnos-client",
            @"%USERPROFILE%\.fnos",
            @"%USERPROFILE%\fnos-client"
        };

        // 明确属于本客户端的注册表键（HKCU/HKLM × 64/32 各查一遍）
        private static readonly string[] KnownRegKeys = new string[]
        {
            @"Software\fnos-client",
            @"Software\FNOS",
            @"Software\com.fnos.client",
            @"Software\Classes\com.fnos.client",
            @"Software\Classes\fnos",
            @"Software\Classes\.fnos",
            @"Software\Microsoft\Windows\CurrentVersion\Uninstall\com.fnos.client",
            @"Software\Microsoft\Windows\CurrentVersion\App Paths\FNOS.exe"
        };

        // 需要「按值名/值内容」清理的键：自启类
        private static readonly string[] ValueScanKeys = new string[]
        {
            @"Software\Microsoft\Windows\CurrentVersion\Run",
            @"Software\Microsoft\Windows\CurrentVersion\RunOnce",
            @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder"
        };

        // 兼容性/兼容助手记录（Win7~Win11 通用）
        private static readonly string[] CompatKeys = new string[]
        {
            @"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Compatibility Assistant\Store",
            @"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"
        };

        // 「最近使用」类记录：不属于功能配置，单独一类，方便用户选择是否清
        private static readonly string[] UsageScanKeys = new string[]
        {
            @"Software\Microsoft\Windows\CurrentVersion\Explorer\FeatureUsage\AppSwitched",
            @"Software\Microsoft\Windows\CurrentVersion\Explorer\FeatureUsage\AppBadgeUpdated",
            @"Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache"
        };

        private static readonly HashSet<string> SkipDirNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Windows", "$Recycle.Bin", "System Volume Information", "WinSxS", "node_modules", ".git",
            "Config.Msi", "Recovery", "PerfLogs", "MSOCache", "$WinREAgent", "Windows.old",
            "Microsoft", "Packages", "Temp", "tmp", "DriverStore"
        };

        public static List<TraceItem> Scan(bool deep, InstallInfo info, Action<string> progress)
        {
            List<TraceItem> items = new List<TraceItem>();
            HashSet<string> seenDir = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> seenKey = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            Write(progress, "① 读取注册表卸载信息…");
            ScanUninstallRegistry(items, seenDir, info, seenKey, progress);

            Write(progress, "② 检查固定安装/数据目录…");
            ScanKnownDirs(items, seenDir, info);

            Write(progress, "③ 检查注册表产品项、自启与关联…");
            ScanKnownReg(items, seenKey, progress);

            Write(progress, "④ 检查快捷方式与开始菜单…");
            ScanShortcuts(items);

            Write(progress, "⑤ 检查计划任务…");
            ScanScheduledTasks(items, progress);

            Write(progress, "⑥ 检查服务与防火墙规则…");
            ScanServices(items, progress);
            ScanFirewall(items, progress);

            Write(progress, "⑦ 检查崩溃转储、临时文件、跳转列表…");
            ScanLooseFiles(items);

            Write(progress, "⑦b 检查「最近使用」隐私痕迹（UserAssist / 搜索记录）…");
            ScanPrivacyTraces(items);

            if (deep)
            {
                Write(progress, "⑧ 全盘扫描安装目录（较慢，请稍候）…");
                ScanAllDrives(items, seenDir, info, progress);
                Write(progress, "⑨ 检查其它 Windows 用户目录…");
                ScanOtherProfiles(items, seenDir, info);
            }

            info.AnyRunning = Util.IsFnosRunning();
            Write(progress, "扫描完成：共发现 " + items.Count + " 项");
            return items;
        }

        private static void Write(Action<string> p, string s) { if (p != null) { try { p(s); } catch { } } }

        // ---------------------------------------------------------------- 目录

        private static void AddDir(List<TraceItem> items, HashSet<string> seen, string dir, string category,
            string title, string note, bool wholeTree)
        {
            try
            {
                if (string.IsNullOrEmpty(dir)) return;
                dir = dir.TrimEnd('\\');
                if (!Util.DirExists(dir)) return;
                if (seen.Contains(dir)) return;
                seen.Add(dir);

                TraceItem it = new TraceItem();
                it.Category = category;
                it.Title = title;
                it.Detail = dir;
                it.Kind = ItemKind.Directory;
                it.Path = dir;
                it.Note = note;
                it.SizeBytes = Util.DirSize(dir);
                items.Add(it);
            }
            catch { }
        }

        private static void AddFile(List<TraceItem> items, HashSet<string> seen, string file, string category, string title, string note)
        {
            try
            {
                if (string.IsNullOrEmpty(file)) return;
                if (!Util.FileExists(file)) return;
                if (seen.Contains(file)) return;
                seen.Add(file);

                TraceItem it = new TraceItem();
                it.Category = category;
                it.Title = title;
                it.Detail = file;
                it.Kind = ItemKind.File;
                it.Path = file;
                it.Note = note;
                try { it.SizeBytes = new FileInfo(file).Length; } catch { }
                items.Add(it);
            }
            catch { }
        }

        private static void ScanKnownDirs(List<TraceItem> items, HashSet<string> seenDir, InstallInfo info)
        {
            foreach (string raw in KnownDirs)
            {
                string dir = Util.Expand(raw);
                if (!Util.DirExists(dir)) continue;

                bool isInstall = Util.LooksLikeFnosInstall(dir);
                string lower = dir.ToLowerInvariant();

                if (isInstall)
                {
                    // 便携包：exe 与 data 同级，只删 data，不碰同目录其它文件
                    if (!Util.FileExists(Path.Combine(dir, @"resources\app.asar")) &&
                        Util.IsPortableDataDir(Path.Combine(dir, "data")))
                    {
                        AddDir(items, seenDir, Path.Combine(dir, "data"), "安装目录", "便携版数据目录",
                            "便携包把设置/Cookie 放在 exe 同级 data 下；便携包本体 FNOS.exe 需手动删除", true);
                        info.PortableDirs.Add(dir);
                        continue;
                    }
                    AddDir(items, seenDir, dir, "安装目录", "客户端安装目录", "整目录删除（含 resources、mpv、更新缓存）", true);
                    info.InstallDirs.Add(dir);
                }
                else if (lower.IndexOf("fnos") >= 0 || lower.IndexOf("userdata") >= 0)
                {
                    AddDir(items, seenDir, dir, "用户数据", "用户数据目录", "设置、日志、Cookie、皮肤、下载记录", true);
                    info.DataDirs.Add(dir);
                }
            }

            // 默认 userData 里如果仅剩 data 子目录（便携重定向痕迹）
            string roaming = Util.Expand(@"%APPDATA%\fnos-client");
            if (Util.DirExists(roaming))
            {
                AddDir(items, seenDir, roaming, "用户数据", "默认用户数据目录", "settings.json / logs / Cache / skins", true);
                info.DataDirs.Add(roaming);
            }
        }

        // ---------------------------------------------------------------- 注册表

        private static void ScanUninstallRegistry(List<TraceItem> items, HashSet<string> seenDir, InstallInfo info,
            HashSet<string> seenKey, Action<string> p)
        {
            string[] hives = new string[] { "HKCU", "HKLM" };
            string[] views = new string[] { "64", "32" };
            const string uninst = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";

            foreach (string hive in hives)
            {
                foreach (string view in views)
                {
                    foreach (string sub in Util.RegSubKeys(hive, view, uninst))
                    {
                        string keyPath = uninst + "\\" + sub;
                        string name = Util.RegString(hive, view, keyPath, "DisplayName");
                        string pub = Util.RegString(hive, view, keyPath, "Publisher");
                        string loc = Util.RegString(hive, view, keyPath, "InstallLocation");
                        string unstr = Util.RegString(hive, view, keyPath, "UninstallString");
                        string icon = Util.RegString(hive, view, keyPath, "DisplayIcon");

                        bool hit = Contains(name, "FNOS") || Contains(pub, "FNOS") ||
                                   Contains(loc, "fnos") || Contains(unstr, "fnos") || Contains(icon, "fnos");
                        if (!hit) continue;

                        // HKCU 的 64/32 视图指向同一份数据，按「hive+键路径」去重
                        string dedup = hive + "|" + keyPath;
                        if (!seenKey.Add(dedup)) continue;

                        TraceItem it = new TraceItem();
                        it.Category = "注册表";
                        it.Title = "卸载登记项：" + (string.IsNullOrEmpty(name) ? sub : name);
                        it.Detail = hive + "\\" + keyPath;
                        it.Kind = ItemKind.RegistryKey;
                        it.Hive = hive;
                        it.View = view;
                        it.SubKey = keyPath;
                        it.Note = "控制面板「程序和功能」里的残留条目";
                        items.Add(it);
                        info.UninstallKeys.Add(it.Detail);

                        // 顺带把 InstallLocation 指到的目录也纳入
                        if (!string.IsNullOrEmpty(loc))
                        {
                            string d = Util.Expand(loc.Trim().Trim('"'));
                            if (Util.LooksLikeFnosInstall(d))
                            {
                                AddDir(items, seenDir, d, "安装目录", "安装目录（来自注册表）", "由 Uninstall 项 InstallLocation 提供", true);
                                info.InstallDirs.Add(d);
                            }
                        }
                    }
                }
            }
            Write(p, "   卸载登记项：" + info.UninstallKeys.Count + " 个");
        }

        private static void ScanKnownReg(List<TraceItem> items, HashSet<string> seenKey, Action<string> p)
        {
            string[] hives = new string[] { "HKCU", "HKLM" };
            string[] views = new string[] { "64", "32" };

            foreach (string hive in hives)
            {
                foreach (string view in views)
                {
                    foreach (string sub in KnownRegKeys)
                    {
                        string id = hive + view + "|" + sub;
                        if (seenKey.Contains(id)) continue;

                        bool exists = false;
                        try
                        {
                            using (RegistryKey bk = Util.BaseKey(hive, view))
                            using (RegistryKey k = bk.OpenSubKey(sub, false)) { exists = k != null; }
                        }
                        catch { }
                        if (!exists) continue;
                        seenKey.Add(id);

                        TraceItem it = new TraceItem();
                        it.Category = "注册表";
                        it.Title = "产品注册表项";
                        it.Detail = hive + "\\" + sub;
                        it.Kind = ItemKind.RegistryKey;
                        it.Hive = hive;
                        it.View = view;
                        it.SubKey = sub;
                        items.Add(it);
                    }

                    // 按「值名 / 值内容」清理
                    ScanValueGroup(items, seenKey, hive, view, ValueScanKeys, "自启");
                    ScanValueGroup(items, seenKey, hive, view, CompatKeys, "注册表");
                    ScanValueGroup(items, seenKey, hive, view, UsageScanKeys, "使用记录");
                }
            }
            Write(p, "   注册表项/值已检查");
        }

        private static void ScanValueGroup(List<TraceItem> items, HashSet<string> seenKey,
            string hive, string view, string[] keys, string category)
        {
            foreach (string sub in keys)
            {
                string[] names = Util.RegValueNames(hive, view, sub);
                foreach (string vn in names)
                {
                    string v = Util.RegString(hive, view, sub, vn);
                    bool hit = MatchesFnos(vn) || MatchesFnos(v) ||
                               string.Equals(vn, "FNOS", StringComparison.OrdinalIgnoreCase);
                    if (!hit) continue;

                    string id = hive + view + "|" + sub + "|" + vn;
                    if (seenKey.Contains(id)) continue;
                    seenKey.Add(id);

                    TraceItem it = new TraceItem();
                    it.Category = category;
                    it.Title = "注册表值：" + Trim(vn, 36);
                    it.Detail = hive + "\\" + sub + "  [" + Trim(vn, 110) + "]";
                    it.Kind = ItemKind.RegistryValue;
                    it.Hive = hive;
                    it.View = view;
                    it.SubKey = sub;
                    it.ValueName = vn;
                    it.Note = Trim(v, 120);
                    items.Add(it);
                }
            }
        }

        /// <summary>只认我们自己的路径特征，避免把「名字里带 fnos 的其它软件」一起清掉</summary>
        private static bool MatchesFnos(string value)
        {
            if (string.IsNullOrEmpty(value)) return false;
            string v = value.ToLowerInvariant();
            if (v.IndexOf("com.fnos.client", StringComparison.Ordinal) >= 0) return true;
            if (v.IndexOf("fnos-client", StringComparison.Ordinal) >= 0) return true;
            if (v.IndexOf(@"\fnos\", StringComparison.Ordinal) >= 0) return true;
            if (v.IndexOf("fnos.exe", StringComparison.Ordinal) >= 0) return true;
            if (v.IndexOf("uninstall fnos.exe", StringComparison.Ordinal) >= 0) return true;

            // 安装包/旧便携包：只看文件名前缀，避免把「xxx-fnos-setup.exe」这种别家包也算进来
            string leaf = LeafName(v);
            if (leaf.StartsWith("fnos-", StringComparison.Ordinal) ||
                leaf.StartsWith("fnos_", StringComparison.Ordinal)) return true;
            return false;
        }

        private static string LeafName(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            string s = path.Trim().Trim('"');
            int i = s.LastIndexOfAny(new char[] { '\\', '/' });
            if (i >= 0 && i < s.Length - 1) s = s.Substring(i + 1);
            return s;
        }

        // ---------------------------------------------------------------- 快捷方式

        private static void ScanShortcuts(List<TraceItem> items)
        {
            List<string> dirs = new List<string>();
            dirs.Add(Util.Expand(@"%USERPROFILE%\Desktop"));
            dirs.Add(Util.Expand(@"%PUBLIC%\Desktop"));
            dirs.Add(Util.Expand(@"%APPDATA%\Microsoft\Windows\Start Menu\Programs"));
            dirs.Add(Util.Expand(@"%PROGRAMDATA%\Microsoft\Windows\Start Menu\Programs"));
            dirs.Add(Util.Expand(@"%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"));
            dirs.Add(Util.Expand(@"%APPDATA%\Microsoft\Windows\Recent"));
            dirs.Add(Util.Expand(@"%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"));
            dirs.Add(Util.Expand(@"%PROGRAMDATA%\Microsoft\Windows\Start Menu\Programs\Startup"));

            foreach (string dir in dirs)
            {
                if (!Util.DirExists(dir)) continue;
                try
                {
                    foreach (string f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                    {
                        string leaf = Path.GetFileName(f);
                        bool hit = Contains(leaf, "FNOS") || Contains(leaf, "fnos");
                        if (!hit && leaf.EndsWith(".url", StringComparison.OrdinalIgnoreCase))
                        {
                            try { hit = Contains(File.ReadAllText(f), "fnos"); } catch { }
                        }
                        if (!hit) continue;

                        TraceItem it = new TraceItem();
                        it.Category = "快捷方式";
                        it.Title = leaf;
                        it.Detail = f;
                        it.Kind = ItemKind.Shortcut;
                        it.Path = f;
                        items.Add(it);
                    }
                }
                catch { }
            }
        }

        // ---------------------------------------------------------------- 计划任务 / 服务 / 防火墙

        private static void ScanScheduledTasks(List<TraceItem> items, Action<string> p)
        {
            string outp = Util.Run("schtasks.exe", "/query /fo csv /nh", 20000);
            if (outp.StartsWith("ERR:")) { Write(p, "   计划任务查询失败（跳过）"); return; }

            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string[] lines = outp.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string line in lines)
            {
                if (line.IndexOf("fnos", StringComparison.OrdinalIgnoreCase) < 0) continue;
                string taskName = FirstCsvField(line);
                if (string.IsNullOrEmpty(taskName)) continue;
                if (!seen.Add(taskName)) continue;

                TraceItem it = new TraceItem();
                it.Category = "计划任务";
                it.Title = "计划任务";
                it.Detail = taskName;
                it.Kind = ItemKind.ScheduledTask;
                it.Name = taskName;
                items.Add(it);
            }
        }

        private static void ScanServices(List<TraceItem> items, Action<string> p)
        {
            const string svc = @"SYSTEM\CurrentControlSet\Services";
            foreach (string sub in Util.RegSubKeys("HKLM", "64", svc))
            {
                string path = svc + "\\" + sub;
                string disp = Util.RegString("HKLM", "64", path, "DisplayName");
                string img = Util.RegString("HKLM", "64", path, "ImagePath");
                if (!Contains(disp, "fnos") && !Contains(img, "fnos")) continue;
                if (Contains(img, "\\fnos-client\\") || Contains(img, "\\FNOS\\")) { }
                else if (!Contains(sub, "fnos")) continue;

                TraceItem it = new TraceItem();
                it.Category = "服务";
                it.Title = "系统服务：" + (string.IsNullOrEmpty(disp) ? sub : disp);
                it.Detail = sub + "  ← " + Trim(img, 120);
                it.Kind = ItemKind.Service;
                it.Name = sub;
                it.Note = "删除前会先停止并设为禁用";
                items.Add(it);
            }
            Write(p, "   服务检查完成");
        }

        private static void ScanFirewall(List<TraceItem> items, Action<string> p)
        {
            string outp = Util.Run("netsh.exe", "advfirewall firewall show rule name=all verbose", 40000);
            if (outp.StartsWith("ERR:") || outp.Length < 20) { Write(p, "   防火墙规则查询跳过"); return; }

            string[] lines = outp.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            string curName = "";
            bool curHit = false;
            List<string> hits = new List<string>();

            foreach (string raw in lines)
            {
                string line = raw.Trim();
                if (line.StartsWith("----")) continue;

                if (line.StartsWith("规则名称") || line.StartsWith("Rule Name"))
                {
                    if (curName.Length > 0 && curHit) hits.Add(curName);
                    curName = AfterColon(line);
                    curHit = false;
                    continue;
                }
                if (line.StartsWith("程序") || line.StartsWith("Program"))
                {
                    string v = AfterColon(line);
                    if (Contains(v, "fnos")) curHit = true;
                }
            }
            if (curName.Length > 0 && curHit) hits.Add(curName);

            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string n in hits)
            {
                if (string.IsNullOrEmpty(n) || !seen.Add(n)) continue;
                TraceItem it = new TraceItem();
                it.Category = "防火墙";
                it.Title = "防火墙规则";
                it.Detail = n;
                it.Kind = ItemKind.FirewallRule;
                it.Name = n;
                items.Add(it);
            }
            Write(p, "   防火墙：命中 " + hits.Count + " 条");
        }

        // ---------------------------------------------------------------- 零散文件

        private static void ScanLooseFiles(List<TraceItem> items)
        {
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            // 崩溃转储
            string dump1 = Util.Expand(@"%LOCALAPPDATA%\CrashDumps");
            if (Util.DirExists(dump1))
            {
                try
                {
                    foreach (string f in Directory.EnumerateFiles(dump1, "*.dmp"))
                    {
                        if (!Contains(Path.GetFileName(f), "fnos")) continue;
                        AddFile(items, seen, f, "其它", "崩溃转储", "客户端异常退出留下的 dmp");
                    }
                }
                catch { }
            }

            // 临时目录里的 fnos 遗留
            string tmp = Path.GetTempPath();
            try
            {
                foreach (string f in Directory.EnumerateFileSystemEntries(tmp, "fnos*"))
                {
                    if (Util.DirExists(f)) AddDir(items, seen, f, "其它", "临时目录残留", "更新/安装过程中解出的临时文件", true);
                    else AddFile(items, seen, f, "其它", "临时文件", "");
                }
                foreach (string f in Directory.EnumerateFileSystemEntries(tmp, "FNOS*"))
                {
                    if (Util.DirExists(f)) AddDir(items, seen, f, "其它", "临时目录残留", "更新/安装过程中解出的临时文件", true);
                    else AddFile(items, seen, f, "其它", "临时文件", "");
                }
            }
            catch { }

            // 跳转列表（任务栏右键「最近」里的记录）
            ScanJumpLists(items, seen);
        }

        private static void ScanJumpLists(List<TraceItem> items, HashSet<string> seen)
        {
            string[] dirs = new string[]
            {
                Util.Expand(@"%APPDATA%\Microsoft\Windows\Recent\AutomaticDestinations"),
                Util.Expand(@"%APPDATA%\Microsoft\Windows\Recent\CustomDestinations")
            };
            byte[] needle = Encoding.Unicode.GetBytes("com.fnos.client");
            foreach (string dir in dirs)
            {
                if (!Util.DirExists(dir)) continue;
                try
                {
                    foreach (string f in Directory.EnumerateFiles(dir))
                    {
                        try
                        {
                            FileInfo fi = new FileInfo(f);
                            if (fi.Length > 4 * 1024 * 1024) continue;
                            byte[] data = File.ReadAllBytes(f);
                            if (!ContainsBytes(data, needle)) continue;
                            AddFile(items, seen, f, "其它", "任务栏/开始菜单跳转记录", "Windows 记录的最近使用痕迹");
                        }
                        catch { }
                    }
                }
                catch { }
            }
        }

        // ---------------------------------------------------------------- 隐私痕迹（Win10 / Win11）

        /// <summary>「最近使用」类痕迹：UserAssist（ROT13 路径）与搜索最近应用</summary>
        private static void ScanPrivacyTraces(List<TraceItem> items)
        {
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            // 1) UserAssist：值名是 ROT13 编码的程序路径
            string ua = @"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist";
            foreach (string g in Util.RegSubKeys("HKCU", "64", ua))
            {
                string count = ua + "\\" + g + "\\Count";
                foreach (string vn in Util.RegValueNames("HKCU", "64", count))
                {
                    string dec = Util.Rot13(vn);
                    if (!MatchesFnos(dec) && !MatchesFnos(vn)) continue;
                    string id = "ua|" + count + "|" + vn;
                    if (!seen.Add(id)) continue;

                    TraceItem it = new TraceItem();
                    it.Category = "使用记录";
                    it.Title = "最近使用记录（UserAssist）";
                    it.Detail = "HKCU\\" + count + "  [" + Trim(dec, 100) + "]";
                    it.Kind = ItemKind.RegistryValue;
                    it.Hive = "HKCU";
                    it.View = "64";
                    it.SubKey = count;
                    it.ValueName = vn;
                    it.Note = "Windows 记录的程序启动次数与时间（Win10/11 通用）";
                    items.Add(it);
                }
            }

            // 2) 搜索框的「最近应用」
            string ra = @"Software\Microsoft\Windows\CurrentVersion\Search\RecentApps";
            foreach (string g in Util.RegSubKeys("HKCU", "64", ra))
            {
                string path = ra + "\\" + g;
                string appId = Util.RegString("HKCU", "64", path, "AppId");
                if (!MatchesFnos(appId)) continue;
                string id = "ra|" + path;
                if (!seen.Add(id)) continue;

                TraceItem it = new TraceItem();
                it.Category = "使用记录";
                it.Title = "搜索最近应用记录";
                it.Detail = "HKCU\\" + path + "  [" + Trim(appId, 90) + "]";
                it.Kind = ItemKind.RegistryKey;
                it.Hive = "HKCU";
                it.View = "64";
                it.SubKey = path;
                it.Note = "开始菜单搜索里的历史条目";
                items.Add(it);
            }
        }

        // ---------------------------------------------------------------- 全盘

        private static void ScanAllDrives(List<TraceItem> items, HashSet<string> seenDir, InstallInfo info, Action<string> p)
        {
            foreach (DriveInfo d in DriveInfo.GetDrives())
            {
                try
                {
                    if (!d.IsReady) continue;
                    if (d.DriveType != DriveType.Fixed && d.DriveType != DriveType.Removable && d.DriveType != DriveType.Network) continue;

                    string root = d.RootDirectory.FullName;
                    Write(p, "   扫描 " + root);
                    BfsScan(root, 4, items, seenDir, info, p);
                }
                catch { }
            }
        }

        private static void BfsScan(string root, int maxDepth, List<TraceItem> items, HashSet<string> seenDir, InstallInfo info, Action<string> p)
        {
            Queue<string> queue = new Queue<string>();
            queue.Enqueue(root);
            int guard = 0;

            while (queue.Count > 0)
            {
                if (guard++ > 200000) break; // 防御性上限
                string cur = queue.Dequeue();
                int depth = DepthFrom(root, cur);
                if (depth >= maxDepth) continue;

                string[] subs;
                try { subs = Directory.GetDirectories(cur); }
                catch { continue; }

                foreach (string sub in subs)
                {
                    try
                    {
                        string name = Path.GetFileName(sub);
                        if (SkipDirNames.Contains(name)) continue;

                        FileAttributes attr = File.GetAttributes(sub);
                        if ((attr & FileAttributes.ReparsePoint) != 0) continue;

                        if (Util.LooksLikeFnosInstall(sub))
                        {
                            // 安装目录 or 便携目录
                            if (!Util.FileExists(Path.Combine(sub, @"resources\app.asar")) &&
                                Util.IsPortableDataDir(Path.Combine(sub, "data")))
                            {
                                AddDir(items, seenDir, Path.Combine(sub, "data"), "安装目录", "便携版数据目录（" + sub + "）",
                                    "便携包数据；exe 本体需手动删除", true);
                                info.PortableDirs.Add(sub);
                            }
                            else
                            {
                                AddDir(items, seenDir, sub, "安装目录", "客户端安装目录（全盘发现）",
                                    "特征校验通过：含 FNOS.exe + resources/app.asar", true);
                                info.InstallDirs.Add(sub);
                            }
                            continue; // 命中后不再向下
                        }
                        queue.Enqueue(sub);
                    }
                    catch { }
                }
            }
        }

        private static int DepthFrom(string root, string path)
        {
            try
            {
                string r = root.TrimEnd('\\');
                string pp = path.TrimEnd('\\');
                if (pp.Length <= r.Length) return 0;
                string rel = pp.Substring(r.Length).Trim('\\');
                if (rel.Length == 0) return 0;
                return rel.Split('\\').Length;
            }
            catch { return 99; }
        }

        private static void ScanOtherProfiles(List<TraceItem> items, HashSet<string> seenDir, InstallInfo info)
        {
            string users = Util.Expand(@"%SystemDrive%\Users");
            if (!Util.DirExists(users)) return;

            string cur = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd('\\');
            try
            {
                foreach (string prof in Directory.GetDirectories(users))
                {
                    string leaf = Path.GetFileName(prof);
                    if (string.Equals(leaf, "Public", StringComparison.OrdinalIgnoreCase)) continue;
                    if (string.Equals(leaf, "Default", StringComparison.OrdinalIgnoreCase)) continue;
                    if (string.Equals(leaf, "Default User", StringComparison.OrdinalIgnoreCase)) continue;
                    if (string.Equals(leaf, "All Users", StringComparison.OrdinalIgnoreCase)) continue;
                    if (string.Equals(prof.TrimEnd('\\'), cur, StringComparison.OrdinalIgnoreCase)) continue;

                    string[] cands = new string[]
                    {
                        Path.Combine(prof, @"AppData\Roaming\fnos-client"),
                        Path.Combine(prof, @"AppData\Local\fnos-client"),
                        Path.Combine(prof, @"AppData\Local\Programs\FNOS"),
                        Path.Combine(prof, @"AppData\Roaming\FNOS")
                    };
                    foreach (string c in cands)
                    {
                        if (!Util.DirExists(c)) continue;
                        AddDir(items, seenDir, c, "用户数据", "其它用户的数据目录（" + leaf + "）",
                            "该 Windows 账户下使用过客户端", true);
                        info.DataDirs.Add(c);
                    }
                }
            }
            catch { }
        }

        // ---------------------------------------------------------------- 小工具

        private static bool Contains(string hay, string needle)
        {
            if (string.IsNullOrEmpty(hay) || string.IsNullOrEmpty(needle)) return false;
            return hay.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string Trim(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            s = s.Replace("\r", " ").Replace("\n", " ").Trim();
            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }

        private static string FirstCsvField(string line)
        {
            if (string.IsNullOrEmpty(line)) return "";
            if (line[0] == '"')
            {
                int end = line.IndexOf('"', 1);
                if (end > 1) return line.Substring(1, end - 1);
                return "";
            }
            int c = line.IndexOf(',');
            return c > 0 ? line.Substring(0, c) : line;
        }

        private static string AfterColon(string line)
        {
            int i = line.IndexOf(':');
            if (i < 0) i = line.IndexOf('：');
            if (i < 0) return "";
            return line.Substring(i + 1).Trim();
        }

        private static bool ContainsBytes(byte[] data, byte[] needle)
        {
            if (data == null || needle == null || needle.Length == 0) return false;
            int limit = data.Length - needle.Length;
            for (int i = 0; i <= limit; i++)
            {
                if (data[i] != needle[0]) continue;
                bool ok = true;
                for (int j = 1; j < needle.Length; j++)
                {
                    if (data[i + j] != needle[j]) { ok = false; break; }
                }
                if (ok) return true;
            }
            return false;
        }
    }
}
