// FNOS 客户端强力卸载器 —— 数据模型
// 目标框架：.NET Framework 4.x（Windows 10/11 内置），C# 5 语法
using System;
using System.Collections.Generic;

namespace FnosUninstall
{
    /// <summary>痕迹类型：决定执行时用哪种删除手法</summary>
    public enum ItemKind
    {
        Directory,
        File,
        RegistryKey,
        RegistryValue,
        Shortcut,
        ScheduledTask,
        FirewallRule,
        Service,
        Other
    }

    /// <summary>一条待清理的痕迹</summary>
    public class TraceItem
    {
        public string Category = "";   // 安装目录 / 用户数据 / 注册表 / 自启 / 快捷方式 / 计划任务 / 防火墙 / 服务 / 其它
        public string Title = "";      // 人读的短名
        public string Detail = "";     // 具体路径 / 注册表键 / 服务名
        public ItemKind Kind = ItemKind.Other;

        // 执行参数（按 Kind 解释）
        public string Path = "";       // 目录、文件、快捷方式
        public string Hive = "";       // HKCU / HKLM / HKCR
        public string View = "64";     // 64 / 32（注册表视图）
        public string SubKey = "";     // 注册表子键
        public string ValueName = "";  // 注册表值名（Kind=RegistryValue 时）
        public string Name = "";       // 服务名 / 计划任务名 / 防火墙规则名

        public bool Checked = true;
        public bool MustRestart = false;   // 需要重启才能删（被占用）
        public string Note = "";           // 附加说明（风险提示等）
        public long SizeBytes = -1;        // 目录大小，-1 表示未知

        public string SizeText()
        {
            if (SizeBytes < 0) return "";
            double b = SizeBytes;
            string[] u = new string[] { "B", "KB", "MB", "GB", "TB" };
            int i = 0;
            while (b >= 1024 && i < u.Length - 1) { b /= 1024; i++; }
            return b.ToString(i == 0 ? "0" : "0.0") + " " + u[i];
        }
    }

    /// <summary>扫描阶段收集到的安装信息（用于汇总显示）</summary>
    public class InstallInfo
    {
        public List<string> InstallDirs = new List<string>();
        public List<string> PortableDirs = new List<string>();
        public List<string> DataDirs = new List<string>();
        public List<string> UninstallKeys = new List<string>();
        public bool AnyRunning = false;
    }

    /// <summary>执行结果</summary>
    public class StepResult
    {
        public TraceItem Item;
        public bool Ok;
        public string Message = "";
        public StepResult(TraceItem it, bool ok, string msg) { Item = it; Ok = ok; Message = msg; }
    }
}
