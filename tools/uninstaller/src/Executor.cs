// FNOS 客户端强力卸载器 —— 执行清理
using System;
using System.Collections.Generic;
using System.Text;

namespace FnosUninstall
{
    public static class Executor
    {
        /// <summary>执行顺序权重：先解依赖，再删数据，最后删目录</summary>
        private static int Rank(TraceItem it)
        {
            switch (it.Kind)
            {
                case ItemKind.Service: return 10;
                case ItemKind.ScheduledTask: return 20;
                case ItemKind.FirewallRule: return 30;
                case ItemKind.RegistryValue: return 40;
                case ItemKind.RegistryKey: return 50;
                case ItemKind.Shortcut: return 60;
                case ItemKind.File: return 70;
                case ItemKind.Directory: return 80;
                default: return 90;
            }
        }

        public static List<StepResult> Run(List<TraceItem> items, InstallInfo info,
            Action<string> log, Action<int, int, string> progress)
        {
            List<StepResult> results = new List<StepResult>();
            if (items == null || items.Count == 0) return results;

            // 1) 结束进程（必须先做，否则文件被占用）
            log("结束 FNOS 相关进程…");
            List<string> roots = new List<string>();
            if (info != null)
            {
                roots.AddRange(info.InstallDirs);
                roots.AddRange(info.PortableDirs);
            }
            foreach (TraceItem it in items)
            {
                if (it.Kind == ItemKind.Directory && !string.IsNullOrEmpty(it.Path)) roots.Add(it.Path);
            }
            int killed = Util.KillFnosProcesses(roots.ToArray());
            log(killed > 0 ? ("已结束 " + killed + " 个进程") : "没有发现运行中的客户端进程");

            // 2) 按权重排序执行
            List<TraceItem> ordered = new List<TraceItem>(items);
            ordered.Sort(delegate (TraceItem a, TraceItem b)
            {
                int ra = Rank(a), rb = Rank(b);
                if (ra != rb) return ra.CompareTo(rb);
                return string.Compare(a.Detail, b.Detail, StringComparison.OrdinalIgnoreCase);
            });

            int total = ordered.Count;
            int index = 0;
            foreach (TraceItem it in ordered)
            {
                index++;
                if (progress != null) { try { progress(index, total, it.Title); } catch { } }

                bool ok = false;
                string msg = "";
                try
                {
                    switch (it.Kind)
                    {
                        case ItemKind.Service:
                            ok = RemoveService(it.Name, out msg);
                            break;
                        case ItemKind.ScheduledTask:
                            ok = RunOk("schtasks.exe", "/delete /tn \"" + it.Name + "\" /f", out msg);
                            break;
                        case ItemKind.FirewallRule:
                            ok = RunOk("netsh.exe", "advfirewall firewall delete rule name=\"" + it.Name + "\"", out msg);
                            break;
                        case ItemKind.RegistryValue:
                            ok = Util.DeleteRegistryValue(it.Hive, it.View, it.SubKey, it.ValueName, out msg);
                            break;
                        case ItemKind.RegistryKey:
                            ok = Util.DeleteRegistryKey(it.Hive, it.View, it.SubKey, out msg);
                            break;
                        case ItemKind.Shortcut:
                        case ItemKind.File:
                            ok = Util.DeleteFile(it.Path, out msg);
                            break;
                        case ItemKind.Directory:
                            ok = Util.DeleteDirectory(it.Path, out msg);
                            break;
                        default:
                            msg = "未知类型，跳过";
                            ok = false;
                            break;
                    }
                }
                catch (Exception e)
                {
                    msg = "异常：" + e.Message;
                    ok = false;
                }

                results.Add(new StepResult(it, ok, msg));
                log((ok ? "√ " : "× ") + it.Category + " | " + it.Detail + "  → " + msg);
            }

            // 3) 收尾：再杀一次（有些子进程是删除过程中才退出的）
            try { Util.KillFnosProcesses(roots.ToArray()); } catch { }

            // 4) 删除空的 Programs 目录残留（仅当为空）
            try
            {
                string programs = Util.Expand(@"%LOCALAPPDATA%\Programs");
                if (Util.DirExists(programs))
                {
                    string fnos = System.IO.Path.Combine(programs, "FNOS");
                    if (Util.DirExists(fnos) && System.IO.Directory.GetFileSystemEntries(fnos).Length == 0)
                    {
                        System.IO.Directory.Delete(fnos, false);
                        log("清理空目录：" + fnos);
                    }
                }
            }
            catch { }

            return results;
        }

        private static bool RemoveService(string name, out string msg)
        {
            msg = "";
            if (string.IsNullOrEmpty(name)) { msg = "服务名为空"; return false; }

            string outp = "";
            try { outp = Util.Run("sc.exe", "stop \"" + name + "\"", 20000); } catch { }
            KillServiceProcesses(name);
            try { Util.Run("sc.exe", "config \"" + name + "\" start= disabled", 20000); } catch { }

            string del = Util.Run("sc.exe", "delete \"" + name + "\"", 20000);
            bool ok = del.IndexOf("SUCCESS", StringComparison.OrdinalIgnoreCase) >= 0 ||
                      del.IndexOf("成功", StringComparison.Ordinal) >= 0 ||
                      del.IndexOf("1060", StringComparison.Ordinal) >= 0; // 1060 = 服务不存在
            msg = ok ? "已停止并删除" : "删除返回：" + FirstLine(del + outp);
            return ok;
        }

        private static void KillServiceProcesses(string serviceName)
        {
            try
            {
                string img = Util.RegString("HKLM", "64", @"SYSTEM\CurrentControlSet\Services\" + serviceName, "ImagePath");
                if (string.IsNullOrEmpty(img)) return;
                string exe = img.Trim().Trim('"');
                int q = exe.IndexOf("\" ");
                if (q > 0) exe = exe.Substring(1, q - 1);
                string dir = "";
                try { dir = System.IO.Path.GetDirectoryName(exe); } catch { }
                if (!string.IsNullOrEmpty(dir)) Util.KillFnosProcesses(dir);
            }
            catch { }
        }

        private static bool RunOk(string exe, string args, out string msg)
        {
            string outp = Util.Run(exe, args, 30000);
            bool ok = outp.IndexOf("success", StringComparison.OrdinalIgnoreCase) >= 0 ||
                      outp.IndexOf("成功", StringComparison.Ordinal) >= 0 ||
                      outp.IndexOf("SUCCESS", StringComparison.Ordinal) >= 0 ||
                      !outp.StartsWith("ERR:") && outp.Trim().Length == 0;
            // 目标本就不存在也视为成功
            if (!ok && (outp.IndexOf("找不到", StringComparison.Ordinal) >= 0 ||
                        outp.IndexOf("No rules", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        outp.IndexOf("cannot find", StringComparison.OrdinalIgnoreCase) >= 0))
                ok = true;
            msg = ok ? "已删除" : FirstLine(outp);
            return ok;
        }

        private static string FirstLine(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            string[] parts = s.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            string line = parts.Length > 0 ? parts[0].Trim() : s.Trim();
            if (line.Length > 160) line = line.Substring(0, 160) + "…";
            return line;
        }

        /// <summary>生成卸载报告文本</summary>
        public static string BuildReport(List<StepResult> results, InstallInfo info, bool dryRun)
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("FNOS 客户端强力卸载报告");
            sb.AppendLine("时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            sb.AppendLine("模式：" + (dryRun ? "仅扫描（未做任何修改）" : "实际删除"));
            sb.AppendLine("管理员：" + (Util.IsAdmin() ? "是" : "否"));
            sb.AppendLine(new string('-', 60));

            int ok = 0, fail = 0;
            foreach (StepResult r in results)
            {
                if (r.Ok) ok++; else fail++;
                sb.AppendLine((r.Ok ? "[OK]   " : "[FAIL] ") + r.Item.Category + " | " + r.Item.Detail + " → " + r.Message);
            }
            sb.AppendLine(new string('-', 60));
            sb.AppendLine("成功 " + ok + " 项，失败 " + fail + " 项，共 " + results.Count + " 项");

            if (fail > 0)
            {
                sb.AppendLine();
                sb.AppendLine("失败项通常是被占用或权限不足：重启后再运行一次，或手动删除上面列出的路径。");
            }
            return sb.ToString();
        }
    }
}
