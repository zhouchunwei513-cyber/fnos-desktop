// FNOS 客户端强力卸载器 —— 底层工具（进程 / 文件 / 注册表 / 环境）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
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

        public static void Write(string format, params object[] args)
        {
            string line = args == null || args.Length == 0 ? format : string.Format(format, args);
            try { Log("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line); }
            catch { }
        }

        // ---------------- 路径 ----------------

        public static string Expand(string p)
        {
            if (string.IsNullOrEmpty(p)) return p;
            try { return Environment.ExpandEnvironmentVariables(p.Trim().Trim('"')); }
            catch { return p; }
        }

        /// <summary>长路径前缀，避免 260 字符限制</summary>
        public static string LongPath(string p)
        {
            if (string.IsNullOrEmpty(p)) return p;
            if (p.StartsWith(@"\\?\")) return p;
            if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
            return @"\\?\" + p;
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

        /// <summary>目录删除：先常规，再清属性，最后登记重启删除</summary>
        public static bool DeleteDirectory(string path, out string msg)
        {
            msg = "";
            if (!DirExists(path)) { msg = "不存在（已清理）"; return true; }
            try
            {
                Directory.Delete(LongPath(path), true);
                msg = "已删除";
                return true;
            }
            catch (Exception e1)
            {
                msg = e1.GetType().Name;
            }
            try
            {
                ClearReadOnly(path);
                Directory.Delete(LongPath(path), true);
                msg = "已删除（清只读后）";
                return true;
            }
            catch (Exception e2)
            {
                msg = e2.GetType().Name;
            }
            // 杀占用进程后重试
            KillProcessesUnder(path);
            Thread.Sleep(300);
            try
            {
                Directory.Delete(LongPath(path), true);
                msg = "已删除（结束占用进程后）";
                return true;
            }
            catch (Exception e3)
            {
                // 登记重启删除
                bool ok = ScheduleDeleteOnReboot(path);
                msg = ok ? "占用中，已登记重启后删除" : "删除失败：" + e3.Message;
                return ok;
            }
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
                bool ok = ScheduleDeleteOnReboot(path);
                msg = ok ? "占用中，已登记重启后删除" : "删除失败：" + e.Message;
                return ok;
            }
        }

        /// <summary>通过 PendingFileRenameOperations 登记重启删除</summary>
        public static bool ScheduleDeleteOnReboot(string path)
        {
            try
            {
                using (RegistryKey k = Registry.LocalMachine.OpenSubKey(
                    @"SYSTEM\CurrentControlSet\Control\Session Manager", true))
                {
                    if (k == null) return false;
                    string[] old = k.GetValue("PendingFileRenameOperations") as string[];
                    List<string> list = new List<string>();
                    if (old != null) list.AddRange(old);
                    foreach (string one in EnumerateFilesForPending(path))
                    {
                        list.Add(@"\??\" + one);
                        list.Add("");
                    }
                    k.SetValue("PendingFileRenameOperations", list.ToArray(), RegistryValueKind.MultiString);
                }
                return true;
            }
            catch { return false; }
        }

        private static List<string> EnumerateFilesForPending(string path)
        {
            List<string> outList = new List<string>();
            try
            {
                if (FileExists(path)) { outList.Add(path); return outList; }
                if (!DirExists(path)) return outList;
                outList.AddRange(Directory.EnumerateFiles(LongPath(path), "*", SearchOption.AllDirectories));
                // 目录本身排在文件之后
                List<string> dirs = new List<string>(Directory.EnumerateDirectories(LongPath(path), "*", SearchOption.AllDirectories));
                dirs.Sort(delegate (string a, string b) { return b.Length.CompareTo(a.Length); });
                outList.AddRange(dirs);
                outList.Add(path);
            }
            catch { }
            return outList;
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
