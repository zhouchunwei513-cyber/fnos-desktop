// FNOS 客户端强力卸载器 —— 底层工具（进程 / 文件 / 注册表 / 环境）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace FnosUninstall
{
    public static class Util
    {
        public static readonly string[] FnosExeNames = new string[] { "FNOS.exe", "fnos.exe", "FNOS Client.exe" };

        /// <summary>日志回调（UI 订阅）</summary>
        public static Action<string> Log = delegate { };

        private static string __logFile = "";
        private static string __logFile2 = "";
        private static readonly object __logLock = new object();

        /// <summary>
        /// 初始化持久化日志。两处都写：
        /// 1) exe 同目录 uninstall-log.txt（开发排查用，含完整异常）
        /// 2) %TEMP%\FNOS-uninstall.log（需求文档 §4.1 第 8 条要求的位置）
        /// 日志保留 30 天，超过则按日期归档。
        /// </summary>
        public static void InitLog(string dir)
        {
            try
            {
                if (!string.IsNullOrEmpty(dir))
                {
                    __logFile = Path.Combine(dir, "uninstall-log.txt");
                    RotateLog(__logFile, 30);
                }
                __logFile2 = Path.Combine(Path.GetTempPath(), "FNOS-uninstall.log");
                RotateLog(__logFile2, 30);

                StringBuilder head = new StringBuilder();
                head.AppendLine();
                head.AppendLine("===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  FNOS 卸载器启动 =====");
                head.AppendLine("系统：" + OsName());
                head.AppendLine("管理员：" + (IsAdmin() ? "是" : "否"));
                head.AppendLine("目录：" + AppDomain.CurrentDomain.BaseDirectory);
                string txt = head.ToString();
                if (__logFile.Length > 0) { try { File.AppendAllText(__logFile, txt, new UTF8Encoding(true)); } catch { } }
                File.AppendAllText(__logFile2, txt, new UTF8Encoding(true));
            }
            catch { }
        }

        /// <summary>日志超过 days 天则改名为 <name>.yyyyMMdd.log 归档，重新开始写</summary>
        private static void RotateLog(string path, int days)
        {
            try
            {
                if (!File.Exists(path)) return;
                FileInfo fi = new FileInfo(path);
                if ((DateTime.Now - fi.CreationTime).TotalDays <= days) return;
                string old = Path.Combine(Path.GetDirectoryName(path),
                    Path.GetFileNameWithoutExtension(path) + "." + fi.CreationTime.ToString("yyyyMMdd") + ".log");
                if (File.Exists(old)) File.Delete(old);
                File.Move(path, old);
            }
            catch { }
        }

        public static string LogFilePath() { return __logFile.Length > 0 ? __logFile : __logFile2; }

        public static void Write(string format, params object[] args)
        {
            string line = args == null || args.Length == 0 ? format : string.Format(format, args);
            string stamped = "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line;
            try { Log(stamped); } catch { }
            try
            {
                lock (__logLock)
                {
                    if (__logFile.Length > 0) File.AppendAllText(__logFile, stamped + "\r\n", new UTF8Encoding(false));
                    if (__logFile2.Length > 0) File.AppendAllText(__logFile2, stamped + "\r\n", new UTF8Encoding(false));
                }
            }
            catch { }
        }

        /// <summary>异常摘要：类型 + 消息，便于日志定位</summary>
        public static string Short(Exception e)
        {
            if (e == null) return "";
            string s = e.GetType().Name;
            if (!string.IsNullOrEmpty(e.Message)) s += "：" + e.Message;
            s = s.Replace("\r", " ").Replace("\n", " ");
            return s.Length <= 200 ? s : s.Substring(0, 200) + "…";
        }

        // ---------------- 路径 ----------------

        public static string Expand(string p)
        {
            if (string.IsNullOrEmpty(p)) return p;
            try { return Environment.ExpandEnvironmentVariables(p.Trim().Trim('"')); }
            catch { return p; }
        }

        /// <summary>
        /// 长路径前缀。注意：只在确实超长时才加 —— .NET Framework 的 EnumerateFiles/Directory.Delete
        /// 对普通长度的 `\\?\` 路径会抛「路径中具有非法字符」(ArgumentException)。
        /// </summary>
        public static string LongPath(string p)
        {
            if (string.IsNullOrEmpty(p)) return p;
            if (p.StartsWith(@"\\?\")) return p;
            if (p.Length < 240) return p;
            if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
            return @"\\?\" + p;
        }

        /// <summary>去掉 \\?\ 前缀（用于写 PendingFileRenameOperations）</summary>
        public static string StripLongPrefix(string p)
        {
            if (string.IsNullOrEmpty(p)) return p;
            if (p.StartsWith(@"\\?\")) return p.Substring(4);
            return p;
        }

        public static string Combine(string a, string b) { return Path.Combine(a, b); }

        public static bool DirExists(string p)
        {
            try { return !string.IsNullOrEmpty(p) && Directory.Exists(p); } catch { return false; }
        }

        public static bool FileExists(string p)
        {
            try { return !string.IsNullOrEmpty(p) && File.Exists(p); } catch { return false; }
        }

        /// <summary>目录大小（失败返回 -1）</summary>
        public static long DirSize(string path)
        {
            long total = 0;
            try
            {
                foreach (string f in Directory.EnumerateFiles(LongPath(path), "*", SearchOption.AllDirectories))
                {
                    try { total += new FileInfo(f).Length; } catch { }
                }
            }
            catch { return -1; }
            return total;
        }

        // ---------------- 文件删除 ----------------

        /// <summary>递归清只读属性，便于删除</summary>
        public static void ClearReadOnly(string root)
        {
            try
            {
                foreach (string f in Directory.EnumerateFiles(LongPath(root), "*", SearchOption.AllDirectories))
                {
                    try
                    {
                        FileAttributes a = File.GetAttributes(f);
                        if ((a & FileAttributes.ReadOnly) != 0) File.SetAttributes(f, a & ~FileAttributes.ReadOnly);
                    }
                    catch { }
                }
            }
            catch { }
        }

        private class TreeResult
        {
            public int Failed = 0;
            public string FirstError = "";
            public List<string> FailedPaths = new List<string>();
        }

        /// <summary>
        /// 目录删除（v1.0.1 重写）：整体删 → 占用探测+杀进程 → 重试 → 抢权限 → 逐文件删 → 登记重启删除。
        /// 每一步都写日志，失败时给出具体原因（不再只回一个异常类型名）。
        /// </summary>
        public static bool DeleteDirectory(string path, out string msg)
        {
            msg = "";
            if (!DirExists(path)) { msg = "不存在（已清理）"; return true; }

            // ① 整体删除
            try { Directory.Delete(LongPath(path), true); msg = "已删除"; return true; }
            catch (Exception e) { Write("    整体删除失败：" + Short(e)); }

            // ② 谁在占用 + 杀进程
            List<int> pids;
            string lockers = WhoIsLocking(path, out pids);
            if (lockers.Length > 0) Write("    占用探测：" + lockers);
            if (pids.Count > 0) Write("    已结束占用进程：" + KillPids(pids) + " 个");
            KillProcessesUnder(path);

            try { ClearReadOnly(path); Directory.Delete(LongPath(path), true); msg = "已删除（清属性/结束进程后）"; return true; }
            catch (Exception e) { Write("    二次删除失败：" + Short(e)); }

            for (int i = 0; i < 3; i++)
            {
                Thread.Sleep(800);
                try { Directory.Delete(LongPath(path), true); msg = "已删除（第 " + (i + 1) + " 次重试）"; return true; }
                catch { }
            }

            // ③ 权限不足：抢所有权后再试
            try
            {
                if (NeedTakeOwn(path))
                {
                    TakeOwnership(path);
                    Directory.Delete(LongPath(path), true);
                    msg = "已删除（修复权限后）";
                    return true;
                }
            }
            catch { }

            // ④ 逐文件删除，收集失败项
            TreeResult tr = DeleteTreeDetailed(path);
            if (!DirExists(path))
            {
                msg = tr.Failed == 0 ? "已删除（逐文件）" : ("已删除，另有 " + tr.Failed + " 个文件登记重启删除");
                return true;
            }

            // ⑤ 仍然残留：只能登记重启删除
            int scheduled = ScheduleDeleteFilesOnReboot(tr.FailedPaths);
            bool dirScheduled = ScheduleDeleteDirOnReboot(path);
            msg = "残留 " + tr.Failed + " 项（" + (tr.FirstError.Length > 0 ? tr.FirstError : "被占用") + "）";
            if (scheduled > 0) msg += "；已登记 " + scheduled + " 项重启删除";
            if (dirScheduled) msg += "；目录已登记重启删除";
            if (scheduled == 0 && !dirScheduled) msg = "删除失败：" + msg;
            return DirExists(path) == false;
        }

        public static bool DeleteFile(string path, out string msg)
        {
            msg = "";
            if (!FileExists(path)) { msg = "不存在（已清理）"; return true; }
            try
            {
                File.SetAttributes(path, FileAttributes.Normal);
                File.Delete(LongPath(path));
                msg = "已删除";
                return true;
            }
            catch (Exception e)
            {
                Write("    文件删除失败：" + path + "  ← " + Short(e));
                List<int> pids;
                string lockers = WhoIsLocking(path, out pids);
                if (lockers.Length > 0) Write("    占用探测：" + lockers);
                KillPids(pids);
                Thread.Sleep(300);
                try { File.Delete(LongPath(path)); msg = "已删除（结束占用后）"; return true; } catch { }
                int n = ScheduleDeleteFilesOnReboot(new List<string>(new string[] { path }));
                msg = n > 0 ? "被占用，已登记重启删除" : "删除失败：" + Short(e);
                return n > 0;
            }
        }

        private static TreeResult DeleteTreeDetailed(string root)
        {
            TreeResult r = new TreeResult();
            List<string> files = new List<string>();
            List<string> dirs = new List<string>();
            try
            {
                files.AddRange(Directory.EnumerateFiles(LongPath(root), "*", SearchOption.AllDirectories));
                dirs.AddRange(Directory.EnumerateDirectories(LongPath(root), "*", SearchOption.AllDirectories));
            }
            catch (Exception e)
            {
                r.Failed++;
                r.FirstError = Short(e);
                r.FailedPaths.Add(root);
                return r;
            }

            foreach (string f in files)
            {
                try
                {
                    File.SetAttributes(f, FileAttributes.Normal);
                    File.Delete(f);
                    continue;
                }
                catch (Exception e)
                {
                    // 精准定位：这个文件被谁占用？结束它再试一次
                    List<int> lockPids;
                    string who = WhoIsLocking(f, out lockPids);
                    if (who.Length > 0)
                    {
                        Write("    × " + f + "  ← 被 " + who + " 占用，尝试结束进程");
                        int k = KillPids(lockPids);
                        Write("      已结束 " + k + " 个进程，重试删除：" + (k > 0 ? "是" : "否"));
                        Thread.Sleep(400);
                        try
                        {
                            File.SetAttributes(f, FileAttributes.Normal);
                            File.Delete(f);
                            continue;
                        }
                        catch { }
                    }

                    r.Failed++;
                    if (r.FirstError.Length == 0) r.FirstError = Short(e);
                    r.FailedPaths.Add(f);
                    Write("    × " + f + "  ← " + Short(e));
                }
            }

            dirs.Sort(delegate (string a, string b) { return b.Length.CompareTo(a.Length); });
            foreach (string d in dirs)
            {
                try { Directory.Delete(d, false); } catch { }
            }
            try { Directory.Delete(LongPath(root), false); } catch { }
            return r;
        }

        private static bool NeedTakeOwn(string dir)
        {
            try
            {
                string probe = Path.Combine(dir, ".fnos-uninst-probe");
                using (FileStream fs = File.Create(probe)) { fs.WriteByte(0); }
                File.Delete(probe);
                return false;
            }
            catch (UnauthorizedAccessException) { return true; }
            catch { return false; }
        }

        /// <summary>接管所有权并授予管理员完全控制（其它用户目录 / Program Files 常需要）</summary>
        public static void TakeOwnership(string dir)
        {
            Write("    尝试接管权限：" + dir);
            try { Write("    takeown: " + Run("takeown.exe", "/f \"" + dir + "\" /r /d y", 90000).Trim()); } catch { }
            try { Run("icacls.exe", "\"" + dir + "\" /grant *S-1-5-32-544:F /t /c /q", 180000); } catch { }
        }

        /// <summary>把文件清单登记到 PendingFileRenameOperations（重启时由 SMSS 删除）</summary>
        public static int ScheduleDeleteFilesOnReboot(List<string> files)
        {
            if (files == null || files.Count == 0) return 0;
            try
            {
                using (RegistryKey k = Registry.LocalMachine.OpenSubKey(
                    @"SYSTEM\CurrentControlSet\Control\Session Manager", true))
                {
                    if (k == null) { Write("    × 无法打开 Session Manager 键（需要管理员）"); return 0; }

                    List<string> list = new List<string>();
                    string[] old = k.GetValue("PendingFileRenameOperations") as string[];
                    if (old != null) list.AddRange(old);

                    HashSet<string> exist = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    for (int i = 0; i + 1 < list.Count; i += 2) exist.Add(list[i]);

                    int added = 0;
                    foreach (string f in files)
                    {
                        if (string.IsNullOrEmpty(f)) continue;
                        string src = @"\??\" + StripLongPrefix(f);
                        if (!exist.Add(src)) continue;
                        list.Add(src);
                        list.Add("");
                        added++;
                    }
                    if (added == 0) return 0;

                    k.SetValue("PendingFileRenameOperations", list.ToArray(), RegistryValueKind.MultiString);

                    // 读回校验：确认系统真的记下了
                    string[] back = k.GetValue("PendingFileRenameOperations") as string[];
                    int verified = 0;
                    if (back != null) { foreach (string s in back) if (exist.Contains(s)) verified++; }
                    Write("    PendingFileRenameOperations 登记 " + added + " 项，读回校验 " + verified + " 项");
                    return verified;
                }
            }
            catch (Exception e)
            {
                Write("    × 登记重启删除失败：" + Short(e));
                return 0;
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool MoveFileEx(string existing, string newName, int flags);

        /// <summary>空目录登记重启删除（MOVEFILE_DELAY_UNTIL_REBOOT=4）</summary>
        public static bool ScheduleDeleteDirOnReboot(string path)
        {
            try { return MoveFileEx(@"\??\" + path, null, 4); }
            catch { return false; }
        }

        // ---------------- 快捷方式 (.lnk) ----------------

        /// <summary>
        /// 读取 .lnk 的目标与参数（WScript.Shell COM，Win10/11 通用）。
        /// 说明：FNOS 的子应用快捷方式名是「影视」「电视直播」这种应用名，
        /// 目标是 wscript.exe，参数里带 fnos-launcher.vbs —— 必须读参数才能识别。
        /// </summary>
        public static void ReadLnk(string lnkPath, out string target, out string args)
        {
            target = "";
            args = "";
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return;
                object sh = Activator.CreateInstance(t);
                object lnk = null;
                try
                {
                    lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh,
                        new object[] { lnkPath });
                    if (lnk == null) return;

                    object o1 = t.InvokeMember("TargetPath", BindingFlags.GetProperty, null, lnk, null);
                    if (o1 != null) target = o1.ToString();

                    object o2 = t.InvokeMember("Arguments", BindingFlags.GetProperty, null, lnk, null);
                    if (o2 != null) args = o2.ToString();

                    object o3 = t.InvokeMember("WorkingDirectory", BindingFlags.GetProperty, null, lnk, null);
                    if (o3 != null)
                    {
                        string wd = o3.ToString();
                        if (args.Length == 0) args = wd;
                        else args = args + " " + wd;
                    }
                }
                finally
                {
                    if (lnk != null) { try { Marshal.ReleaseComObject(lnk); } catch { } }
                    try { Marshal.ReleaseComObject(sh); } catch { }
                }
            }
            catch { }
        }

        // ---------------- 进程 ----------------

        /// <summary>结束所有 FNOS 进程，以及可执行文件位于指定目录下的进程（mpv 等）</summary>
        public static int KillFnosProcesses(params string[] extraRoots)
        {
            int killed = 0;
            try
            {
                Process[] all = Process.GetProcesses();
                foreach (Process p in all)
                {
                    try
                    {
                        if (p.Id == Process.GetCurrentProcess().Id) continue;
                        string exe = "";
                        try { exe = p.MainModule.FileName; } catch { exe = ""; }
                        string name = "";
                        try { name = p.ProcessName; } catch { name = ""; }

                        bool hit = false;
                        if (name.Equals("FNOS", StringComparison.OrdinalIgnoreCase)) hit = true;
                        if (!hit && !string.IsNullOrEmpty(exe))
                        {
                            string leaf = Path.GetFileName(exe);
                            foreach (string n in FnosExeNames)
                                if (string.Equals(leaf, n, StringComparison.OrdinalIgnoreCase)) { hit = true; break; }
                            if (!hit && extraRoots != null)
                            {
                                foreach (string root in extraRoots)
                                {
                                    if (string.IsNullOrEmpty(root)) continue;
                                    if (exe.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) { hit = true; break; }
                                }
                            }
                        }
                        if (!hit) continue;
                        p.Kill();
                        killed++;
                        try { p.WaitForExit(3000); } catch { }
                    }
                    catch { }
                    finally { try { p.Dispose(); } catch { } }
                }
            }
            catch { }
            return killed;
        }

        public static void KillProcessesUnder(string dir)
        {
            KillFnosProcesses(dir);
        }

        /// <summary>按 PID 结束进程（占用探测结果）</summary>
        public static int KillPids(List<int> pids)
        {
            int n = 0;
            if (pids == null) return 0;
            foreach (int pid in pids)
            {
                try
                {
                    if (pid <= 0 || pid == Process.GetCurrentProcess().Id) continue;
                    using (Process p = Process.GetProcessById(pid))
                    {
                        p.Kill();
                        n++;
                        try { p.WaitForExit(3000); } catch { }
                    }
                }
                catch { }
            }
            return n;
        }

        // ---------------- 占用探测（Restart Manager，Vista~Win11 通用） ----------------

        [StructLayout(LayoutKind.Sequential)]
        private struct RM_UNIQUE_PROCESS
        {
            public int dwProcessId;
            public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct RM_PROCESS_INFO
        {
            public RM_UNIQUE_PROCESS Process;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
            public string strAppName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
            public string strServiceShortName;
            public int ApplicationType;
            public uint AppStatus;
            public uint TSSessionId;
            [MarshalAs(UnmanagedType.Bool)]
            public bool bRestartable;
        }

        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        private static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);

        [DllImport("rstrtmgr.dll")]
        private static extern int RmEndSession(uint pSessionHandle);

        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        private static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
            uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);

        [DllImport("rstrtmgr.dll")]
        private static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
            [In, Out] RM_PROCESS_INFO[] rgAffectedApps, out uint lpdwRebootReasons);

        /// <summary>查「谁占用着这个路径」，返回 "进程名(PID)" 串，pids 供后续结束</summary>
        public static string WhoIsLocking(string path, out List<int> pids)
        {
            pids = new List<int>();
            StringBuilder sb = new StringBuilder();
            uint handle = 0;
            bool started = false;
            try
            {
                StringBuilder key = new StringBuilder(256);
                if (RmStartSession(out handle, 0, key) != 0) return "";
                started = true;

                // Restart Manager 对目录的识别很弱：目录要把内部文件作为资源注册才查得到占用者
                List<string> res = new List<string>();
                if (FileExists(path))
                {
                    res.Add(path);
                }
                else if (DirExists(path))
                {
                    try
                    {
                        int n = 0;
                        foreach (string f in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
                        {
                            res.Add(f);
                            if (++n >= 64) break;
                        }
                    }
                    catch { }
                    if (res.Count == 0) res.Add(path);
                }
                else res.Add(path);

                string[] resources = res.ToArray();
                if (RmRegisterResources(handle, (uint)resources.Length, resources, 0, null, 0, null) != 0) return "";

                uint needed = 0, count = 0, reasons = 0;
                int rv = RmGetList(handle, out needed, ref count, null, out reasons);
                if (rv == 234 && needed > 0)   // ERROR_MORE_DATA
                {
                    RM_PROCESS_INFO[] infos = new RM_PROCESS_INFO[needed];
                    count = needed;
                    rv = RmGetList(handle, out needed, ref count, infos, out reasons);
                    if (rv == 0)
                    {
                        for (int i = 0; i < count; i++)
                        {
                            string n = infos[i].strAppName;
                            if (string.IsNullOrEmpty(n)) n = "进程";
                            if (sb.Length > 0) sb.Append("、");
                            sb.Append(n + "(" + infos[i].Process.dwProcessId + ")");
                            pids.Add(infos[i].Process.dwProcessId);
                        }
                    }
                }
            }
            catch { }
            finally
            {
                if (started) { try { RmEndSession(handle); } catch { } }
            }
            return sb.ToString();
        }

        public static bool IsFnosRunning()
        {
            try
            {
                foreach (Process p in Process.GetProcesses())
                {
                    try
                    {
                        if (p.ProcessName.Equals("FNOS", StringComparison.OrdinalIgnoreCase)) return true;
                    }
                    catch { }
                    finally { try { p.Dispose(); } catch { } }
                }
            }
            catch { }
            return false;
        }

        // ---------------- 注册表 ----------------

        public static RegistryKey BaseKey(string hive, string view)
        {
            RegistryHive h;
            if (string.Equals(hive, "HKLM", StringComparison.OrdinalIgnoreCase)) h = RegistryHive.LocalMachine;
            else if (string.Equals(hive, "HKCR", StringComparison.OrdinalIgnoreCase)) h = RegistryHive.ClassesRoot;
            else if (string.Equals(hive, "HKU", StringComparison.OrdinalIgnoreCase)) h = RegistryHive.Users;
            else h = RegistryHive.CurrentUser;

            RegistryView v = string.Equals(view, "32", StringComparison.OrdinalIgnoreCase)
                ? RegistryView.Registry32 : RegistryView.Registry64;
            return RegistryKey.OpenBaseKey(h, v);
        }

        /// <summary>删除注册表键（含子树），不存在视为成功</summary>
        public static bool DeleteRegistryKey(string hive, string view, string subKey, out string msg)
        {
            msg = "";
            try
            {
                using (RegistryKey baseKey = BaseKey(hive, view))
                using (RegistryKey k = baseKey.OpenSubKey(subKey, true))
                {
                    if (k == null) { msg = "不存在（已清理）"; return true; }
                }
                using (RegistryKey baseKey = BaseKey(hive, view))
                {
                    baseKey.DeleteSubKeyTree(subKey, false);
                }
                msg = "已删除";
                return true;
            }
            catch (Exception e)
            {
                msg = "失败：" + e.Message;
                return false;
            }
        }

        public static bool DeleteRegistryValue(string hive, string view, string subKey, string valueName, out string msg)
        {
            msg = "";
            try
            {
                using (RegistryKey baseKey = BaseKey(hive, view))
                using (RegistryKey k = baseKey.OpenSubKey(subKey, true))
                {
                    if (k == null) { msg = "键不存在（已清理）"; return true; }
                    if (k.GetValue(valueName) == null) { msg = "值不存在（已清理）"; return true; }
                    k.DeleteValue(valueName, false);
                }
                msg = "已删除";
                return true;
            }
            catch (Exception e)
            {
                msg = "失败：" + e.Message;
                return false;
            }
        }

        public static string[] RegValueNames(string hive, string view, string subKey)
        {
            try
            {
                using (RegistryKey baseKey = BaseKey(hive, view))
                using (RegistryKey k = baseKey.OpenSubKey(subKey, false))
                {
                    if (k == null) return new string[0];
                    return k.GetValueNames();
                }
            }
            catch { return new string[0]; }
        }

        public static string[] RegSubKeys(string hive, string view, string subKey)
        {
            try
            {
                using (RegistryKey baseKey = BaseKey(hive, view))
                using (RegistryKey k = baseKey.OpenSubKey(subKey, false))
                {
                    if (k == null) return new string[0];
                    return k.GetSubKeyNames();
                }
            }
            catch { return new string[0]; }
        }

        public static string RegString(string hive, string view, string subKey, string valueName)
        {
            try
            {
                using (RegistryKey baseKey = BaseKey(hive, view))
                using (RegistryKey k = baseKey.OpenSubKey(subKey, false))
                {
                    if (k == null) return "";
                    object o = k.GetValue(valueName);
                    return o == null ? "" : o.ToString();
                }
            }
            catch { return ""; }
        }

        // ---------------- 命令行 ----------------

        /// <summary>执行命令并捕获输出（不弹窗）。不指定编码：用系统 OEM 代码页，与 netsh/schtasks 的中文输出一致</summary>
        public static string Run(string exe, string args, int timeoutMs)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(exe, args);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    string so = p.StandardOutput.ReadToEnd();
                    string se = p.StandardError.ReadToEnd();
                    if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } }
                    return so + se;
                }
            }
            catch (Exception e) { return "ERR:" + e.Message; }
        }

        // ---------------- Windows 10 / 11 适配 ----------------

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        /// <summary>在创建任何窗口前调用。WinForms 走系统级 DPI 感知（manifest 已声明，这里幂等兜底）</summary>
        public static void EnableDpiAwareness()
        {
            try { SetProcessDPIAware(); } catch { }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RTL_OSVERSIONINFOEX
        {
            public uint dwOSVersionInfoSize;
            public uint dwMajorVersion;
            public uint dwMinorVersion;
            public uint dwBuildNumber;
            public uint dwPlatformId;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string szCSDVersion;
            public ushort wServicePackMajor;
            public ushort wServicePackMinor;
            public ushort wSuiteMask;
            public byte wProductType;
            public byte wReserved;
        }

        [DllImport("ntdll.dll", CharSet = CharSet.Unicode)]
        private static extern int RtlGetVersion(ref RTL_OSVERSIONINFOEX info);

        /// <summary>
        /// 取真实系统版本。Environment.OSVersion 会被应用兼容性垫片降级成 6.2，
        /// RtlGetVersion 不受 manifest/compat shim 影响，Win10/11 上稳定返回真值。
        /// </summary>
        public static Version RealOsVersion()
        {
            try
            {
                RTL_OSVERSIONINFOEX info = new RTL_OSVERSIONINFOEX();
                info.dwOSVersionInfoSize = (uint)Marshal.SizeOf(typeof(RTL_OSVERSIONINFOEX));
                if (RtlGetVersion(ref info) == 0 && info.dwBuildNumber > 0)
                    return new Version((int)info.dwMajorVersion, (int)info.dwMinorVersion, (int)info.dwBuildNumber);
            }
            catch { }
            try { return Environment.OSVersion.Version; } catch { return new Version(10, 0, 0); }
        }

        public static int OsBuild()
        {
            try { return RealOsVersion().Build; }
            catch { return 0; }
        }

        public static bool IsWin11() { return OsBuild() >= 22000; }

        public static string OsName()
        {
            int b = OsBuild();
            string name;
            if (b >= 22000) name = "Windows 11";
            else if (b >= 10240) name = "Windows 10";
            else if (b >= 9600) name = "Windows 8.1";
            else name = "Windows " + RealOsVersion().ToString();

            string arch = Environment.Is64BitOperatingSystem ? "64 位" : "32 位";
            return name + "（Build " + b + "，" + arch + "）";
        }

        /// <summary>系统是深色还是浅色（Win10 1809+ / Win11 一致）</summary>
        public static bool SystemUsesDarkTheme()
        {
            try
            {
                string o = RegString("HKCU", "64",
                    @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme");
                if (string.IsNullOrEmpty(o)) return false;
                return o.Trim() == "0";
            }
            catch { return false; }
        }

        /// <summary>Windows「最近使用」里用 ROT13 编码存路径，解码后比对</summary>
        public static string Rot13(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            char[] c = s.ToCharArray();
            for (int i = 0; i < c.Length; i++)
            {
                char ch = c[i];
                if (ch >= 'a' && ch <= 'z') c[i] = (char)('a' + (ch - 'a' + 13) % 26);
                else if (ch >= 'A' && ch <= 'Z') c[i] = (char)('A' + (ch - 'A' + 13) % 26);
            }
            return new string(c);
        }

        public static bool IsAdmin()
        {
            try
            {
                System.Security.Principal.WindowsIdentity id = System.Security.Principal.WindowsIdentity.GetCurrent();
                System.Security.Principal.WindowsPrincipal p = new System.Security.Principal.WindowsPrincipal(id);
                return p.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        /// <summary>是否含有 FNOS 安装特征（防止误删同名目录）</summary>
        public static bool LooksLikeFnosInstall(string dir)
        {
            try
            {
                if (!DirExists(dir)) return false;
                bool exe = false;
                foreach (string n in FnosExeNames)
                    if (FileExists(Path.Combine(dir, n))) { exe = true; break; }
                if (!exe) return false;
                if (FileExists(Path.Combine(dir, @"resources\app.asar"))) return true;
                if (DirExists(Path.Combine(dir, @"resources\app"))) return true;
                if (FileExists(Path.Combine(dir, "Uninstall FNOS.exe"))) return true;
                if (FileExists(Path.Combine(dir, @"data\settings.json"))) return true;
                if (FileExists(Path.Combine(dir, "PORTABLE"))) return true;
                return false;
            }
            catch { return false; }
        }

        /// <summary>便携版数据目录（exe 同级 data）</summary>
        public static bool IsPortableDataDir(string dir)
        {
            try
            {
                if (!DirExists(dir)) return false;
                if (!FileExists(Path.Combine(dir, "settings.json"))) return false;
                return true;
            }
            catch { return false; }
        }
    }
}
