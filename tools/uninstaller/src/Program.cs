// FNOS 客户端强力卸载器 —— 入口与界面
// 便携单文件：不写注册表、不装服务、不依赖 .NET 之外的东西
// 目标系统：Windows 10 / Windows 11（32/64 位均可运行）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("FNOS-Uninstaller")]
[assembly: AssemblyDescription("FNOS 客户端强力卸载工具（Windows 10 / 11）")]
[assembly: AssemblyProduct("FNOS 客户端强力卸载")]
[assembly: AssemblyCompany("FNOS")]
[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]

namespace FnosUninstall
{
    internal static class Program
    {
        public static string[] Args = new string[0];
        public const string AppTitle = "FNOS 客户端强力卸载";

        [STAThread]
        private static void Main(string[] args)
        {
            Args = args ?? new string[0];

            // 必须在创建任何窗口之前声明 DPI 感知，否则 Win10/11 高分屏下界面会被位图拉伸
            Util.EnableDpiAwareness();
            // 持久化日志：exe 同目录 uninstall-log.txt，出问题可直接发这个文件
            Util.InitLog(AppDomain.CurrentDomain.BaseDirectory);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool dry = HasFlag("dry-run") || HasFlag("dryrun") || HasFlag("listonly");
            bool silent = HasFlag("silent") || HasFlag("quiet") || HasFlag("y") || HasFlag("s");
            bool cleanup = HasFlag("cleanup") || HasFlag("uninstall");

            if (dry || silent || cleanup)
            {
                int code = ConsoleMode(dry, silent, cleanup);
                Environment.Exit(code);
                return;
            }

            Application.Run(new MainForm());
        }

        public static bool HasFlag(string name)
        {
            foreach (string a in Args)
            {
                if (a == null) continue;
                string s = a.TrimStart('-', '/');
                if (string.Equals(s, name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        public static string ArgValue(string name, string def)
        {
            foreach (string a in Args)
            {
                if (a == null) continue;
                string s = a.TrimStart('-', '/');
                int eq = s.IndexOf('=');
                if (eq <= 0) continue;
                if (!string.Equals(s.Substring(0, eq), name, StringComparison.OrdinalIgnoreCase)) continue;
                return s.Substring(eq + 1);
            }
            return def;
        }

        public static string ExeDir()
        {
            try { return Path.GetDirectoryName(Application.ExecutablePath); }
            catch { return Environment.CurrentDirectory; }
        }

        /// <summary>判断是否为便携版清理目标（data\ 目录、Electron 共享目录 FNOS 项、%TEMP% 残留）</summary>
        private static bool IsPortableCleanupItem(TraceItem it)
        {
            string p = (it.Path ?? "").ToLowerInvariant();
            if (p.Length == 0) p = (it.Detail ?? "").ToLowerInvariant();
            // 便携版 data 目录（Electron userData）
            if (p.Contains("\\data\\") || p.EndsWith("\\data")) return true;
            // Electron 共享目录 FNOS 专属项
            if (p.Contains("\\appdata\\roaming\\electron")) return true;
            // %TEMP% 中的 fnos 残留（fnos_ 前缀目录、FNOS.exe 孤儿副本、日志）
            if (p.Contains("\\temp\\fnos") || (p.Contains("\\temp\\") && p.Contains("fnos.exe"))) return true;
            // 快捷方式（fnos-launcher.vbs 相关）
            if (it.Kind == ItemKind.Shortcut) return true;
            return false;
        }

        /// <summary>无界面模式：/dry-run 只出清单，/silent 真删，/cleanup 便携版数据清理</summary>
        private static int ConsoleMode(bool dry, bool silent, bool cleanup)
        {
            StringBuilder logBuf = new StringBuilder();
            Util.Log = delegate (string s) { logBuf.AppendLine(s); };

            // 用户数据策略（需求文档 §6）：
            //   /Purge      = 删除所有数据（含配置）
            //   /KeepAllData= 仅删除程序，数据全部保留
            //   默认、/KeepData = 保留配置（删缓存/日志/更新包）
            if (HasFlag("purge")) Scanner.UserDataMode = 1;
            else if (HasFlag("keepalldata")) Scanner.UserDataMode = 2;
            else Scanner.UserDataMode = 0;

            InstallInfo info = new InstallInfo();
            // /no-deep：跳过全盘扫描，几秒出结果（适合快速核对，UI 里对应「深度扫描」不勾）
            bool deep = !HasFlag("no-deep");
            List<TraceItem> items = Scanner.Scan(deep, info, delegate (string s) { logBuf.AppendLine(s); });

            List<TraceItem> sel = new List<TraceItem>();
            foreach (TraceItem it in items)
            {
                if (!it.Checked) continue;
                // /cleanup 模式：只处理便携版数据 + Electron 共享目录 FNOS 专属项
                if (cleanup && !IsPortableCleanupItem(it)) continue;
                sel.Add(it);
            }

            string outDir = ExeDir();
            if (dry)
            {
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("FNOS 卸载计划（dry-run，未做任何修改）");
                sb.AppendLine("时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
                sb.AppendLine("系统：" + Util.OsName());
                sb.AppendLine("管理员：" + (Util.IsAdmin() ? "是" : "否"));
                sb.AppendLine(new string('-', 62));
                foreach (TraceItem it in sel)
                {
                    sb.AppendLine("[" + it.Category + "] " + it.Title + "  →  " + it.Detail
                        + (it.SizeBytes >= 0 ? "  (" + it.SizeText() + ")" : ""));
                    if (!string.IsNullOrEmpty(it.Note)) sb.AppendLine("        备注：" + it.Note);
                }
                sb.AppendLine(new string('-', 62));
                sb.AppendLine("合计 " + sel.Count + " 项");
                try { File.WriteAllText(Path.Combine(outDir, "uninstall-plan.txt"), sb.ToString(), new UTF8Encoding(true)); }
                catch { }
                return 0;
            }

            List<StepResult> results = Executor.Run(sel, info, delegate (string s) { logBuf.AppendLine(s); }, null);
            string report = Executor.BuildReport(results, info, false);
            string rp = ArgValue("report", Path.Combine(outDir, "uninstall-report.txt"));
            try { File.WriteAllText(rp, report + "\r\n\r\n---- 日志 ----\r\n" + logBuf, new UTF8Encoding(true)); } catch { }

            int fail = 0;
            foreach (StepResult r in results) if (!r.Ok) fail++;
            // 退出码：0=全部成功；1=部分失败（日志有明细）；2=用户取消
            return fail > 0 ? 1 : 0;
        }
    }

    internal class MainForm : Form
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        private ListView lv;
        private TextBox txtLog;
        private Label lblStatus;
        private Label lblSummary;
        private ProgressBar pb;
        private Button btnScan;
        private Button btnAll;
        private Button btnNone;
        private Button btnExport;
        private Button btnLog;
        private Button btnRun;
        private Button btnClose;
        private CheckBox chkDeep;
        private CheckBox chkHideUsage;
        private RadioButton rdKeepConfig;
        private RadioButton rdPurge;
        private RadioButton rdKeepAll;
        private InstallInfo info = new InstallInfo();
        private List<TraceItem> items = new List<TraceItem>();
        private bool busy = false;
        private bool darkTheme = false;
        private bool showUsage = true;   // 是否显示「使用记录」行（不影响实际删除）
        private bool suppress = false;   // 批量刷新勾选状态时抑制汇总刷新

        public MainForm()
        {
            darkTheme = Util.SystemUsesDarkTheme();
            BuildUi();
            TryDarkTitleBar();
            Util.Log = delegate (string s) { AppendLog(s); };
            Load += delegate { StartScan(true); };
        }

        private void TryDarkTitleBar()
        {
            if (!darkTheme) return;
            try
            {
                int v = 1;
                // DWMWA_USE_IMMERSIVE_DARK_MODE：Win10 1903+/Win11 为 20，1809 为 19
                int hr = DwmSetWindowAttribute(Handle, 20, ref v, sizeof(int));
                if (hr != 0) DwmSetWindowAttribute(Handle, 19, ref v, sizeof(int));
                // Win11 圆角（DWMWA_WINDOW_CORNER_PREFERENCE=33, ROUND=2）；Win10 会返回错误，忽略
                if (Util.IsWin11())
                {
                    int pref = 2;
                    DwmSetWindowAttribute(Handle, 33, ref pref, sizeof(int));
                }
            }
            catch { }
        }

        private void BuildUi()
        {
            Text = Program.AppTitle + "  v1.1.0";
            Font = new Font("Microsoft YaHei UI", 9F);
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            ClientSize = new Size(1000, 720);
            MinimumSize = new Size(880, 620);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = darkTheme ? Color.FromArgb(32, 36, 48) : Color.FromArgb(245, 246, 250);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            // ---------- 顶部说明 ----------
            Panel pnlHead = new Panel();
            pnlHead.Dock = DockStyle.Top;
            pnlHead.AutoSize = true;
            pnlHead.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            pnlHead.Padding = new Padding(18, 12, 18, 10);
            pnlHead.BackColor = Color.FromArgb(24, 28, 42);

            FlowLayoutPanel headFlow = new FlowLayoutPanel();
            headFlow.Dock = DockStyle.Top;
            headFlow.AutoSize = true;
            headFlow.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            headFlow.FlowDirection = FlowDirection.TopDown;
            headFlow.WrapContents = false;

            Label t1 = new Label();
            t1.Text = "FNOS 客户端强力卸载";
            t1.Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold);
            t1.ForeColor = Color.White;
            t1.AutoSize = true;
            t1.Margin = new Padding(0, 0, 0, 4);

            Label t2 = new Label();
            t2.Text = "清除安装目录（任意盘）、用户数据、注册表、自启、快捷方式、计划任务、防火墙规则与最近使用记录。删除前请先核对清单。";
            t2.ForeColor = Color.FromArgb(178, 190, 214);
            t2.AutoSize = true;
            t2.Margin = new Padding(0, 0, 0, 6);

            Label t3 = new Label();
            t3.Text = (Util.IsAdmin() ? "● 管理员权限已获得" : "● 未获得管理员权限（安装目录/注册表会失败）")
                    + "      " + Util.OsName()
                    + (Util.IsWin11() ? "  · Win11 适配" : "  · Win10 适配");
            t3.ForeColor = Util.IsAdmin() ? Color.FromArgb(120, 220, 150) : Color.FromArgb(255, 160, 120);
            t3.AutoSize = true;
            t3.Margin = new Padding(0);

            headFlow.Controls.Add(t1);
            headFlow.Controls.Add(t2);
            headFlow.Controls.Add(t3);
            pnlHead.Controls.Add(headFlow);

            // ---------- 工具条（FlowLayoutPanel：高 DPI 下按序排列不重叠）----------
            FlowLayoutPanel pnlTools = new FlowLayoutPanel();
            pnlTools.Dock = DockStyle.Top;
            pnlTools.AutoSize = true;
            pnlTools.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            pnlTools.FlowDirection = FlowDirection.LeftToRight;
            pnlTools.WrapContents = false;
            pnlTools.Padding = new Padding(12, 10, 12, 8);
            pnlTools.BackColor = darkTheme ? Color.FromArgb(40, 44, 58) : Color.FromArgb(252, 252, 254);

            btnScan = MakeButton("重新扫描", 96);
            btnScan.Click += delegate { StartScan(chkDeep.Checked); };

            chkDeep = new CheckBox();
            chkDeep.Text = "深度扫描所有磁盘";
            chkDeep.Checked = true;
            chkDeep.AutoSize = true;
            chkDeep.ForeColor = darkTheme ? Color.Gainsboro : Color.Black;
            chkDeep.Margin = new Padding(12, 8, 6, 0);

            // 用户数据三选一（需求文档 §6）：保留配置（默认）/ 全部删除 / 仅删程序
            Label lbData = new Label();
            lbData.Text = "用户数据：";
            lbData.AutoSize = true;
            lbData.ForeColor = darkTheme ? Color.Gainsboro : Color.Black;
            lbData.Margin = new Padding(10, 9, 2, 0);

            rdKeepConfig = new RadioButton();
            rdKeepConfig.Text = "保留配置";
            rdKeepConfig.AutoSize = true;
            rdKeepConfig.Checked = true;
            rdKeepConfig.ForeColor = darkTheme ? Color.Gainsboro : Color.Black;
            rdKeepConfig.Margin = new Padding(2, 8, 2, 0);
            rdKeepConfig.CheckedChanged += delegate { ApplyUserDataMode(); };

            rdPurge = new RadioButton();
            rdPurge.Text = "全部删除";
            rdPurge.AutoSize = true;
            rdPurge.ForeColor = darkTheme ? Color.Gainsboro : Color.Black;
            rdPurge.Margin = new Padding(2, 8, 2, 0);
            rdPurge.CheckedChanged += delegate { ApplyUserDataMode(); };

            rdKeepAll = new RadioButton();
            rdKeepAll.Text = "仅删程序";
            rdKeepAll.AutoSize = true;
            rdKeepAll.ForeColor = darkTheme ? Color.Gainsboro : Color.Black;
            rdKeepAll.Margin = new Padding(2, 8, 12, 0);
            rdKeepAll.CheckedChanged += delegate { ApplyUserDataMode(); };

            chkHideUsage = new CheckBox();
            chkHideUsage.Text = "隐藏使用记录";
            chkHideUsage.AutoSize = true;
            chkHideUsage.ForeColor = darkTheme ? Color.Gainsboro : Color.Black;
            chkHideUsage.Margin = new Padding(6, 8, 16, 0);
            chkHideUsage.CheckedChanged += delegate { showUsage = !chkHideUsage.Checked; RenderList(); UpdateSummary(); };

            btnAll = MakeButton("全选", 64);
            btnAll.Margin = new Padding(0, 3, 6, 0);
            btnAll.Click += delegate { SetAll(true); };
            btnNone = MakeButton("全不选", 72);
            btnNone.Margin = new Padding(0, 3, 6, 0);
            btnNone.Click += delegate { SetAll(false); };
            btnExport = MakeButton("导出清单", 90);
            btnExport.Margin = new Padding(0, 3, 6, 0);
            btnExport.Click += delegate { ExportPlan(); };

            btnLog = MakeButton("打开日志", 90);
            btnLog.Margin = new Padding(0, 3, 0, 0);
            btnLog.Click += delegate { OpenLog(); };

            pnlTools.Controls.Add(btnScan);
            pnlTools.Controls.Add(chkDeep);
            pnlTools.Controls.Add(lbData);
            pnlTools.Controls.Add(rdKeepConfig);
            pnlTools.Controls.Add(rdPurge);
            pnlTools.Controls.Add(rdKeepAll);
            pnlTools.Controls.Add(chkHideUsage);
            pnlTools.Controls.Add(btnAll);
            pnlTools.Controls.Add(btnNone);
            pnlTools.Controls.Add(btnExport);
            pnlTools.Controls.Add(btnLog);

            // ---------- 列表 ----------
            lv = new ListView();
            lv.Dock = DockStyle.Fill;
            lv.View = View.Details;
            lv.CheckBoxes = true;
            lv.FullRowSelect = true;
            lv.GridLines = false;
            lv.HideSelection = false;
            lv.BorderStyle = BorderStyle.None;
            if (darkTheme)
            {
                lv.BackColor = Color.FromArgb(38, 42, 56);
                lv.ForeColor = Color.Gainsboro;
            }
            lv.Columns.Add("类别", 92);
            lv.Columns.Add("对象", 250);
            lv.Columns.Add("位置 / 键名", 520);
            lv.Columns.Add("大小", 82);
            lv.ItemChecked += delegate (object s, ItemCheckedEventArgs e)
            {
                TraceItem it = e.Item.Tag as TraceItem;
                if (it != null) it.Checked = e.Item.Checked;
                if (!suppress) UpdateSummary();
            };

            // ---------- 底部 ----------
            Panel pnlBottom = new Panel();
            pnlBottom.Dock = DockStyle.Bottom;
            pnlBottom.Height = 236;
            pnlBottom.Padding = new Padding(12, 6, 12, 10);
            pnlBottom.BackColor = BackColor;

            lblSummary = new Label();
            lblSummary.Dock = DockStyle.Top;
            lblSummary.Height = 26;
            lblSummary.Text = "尚未扫描";
            lblSummary.ForeColor = darkTheme ? Color.Gainsboro : Color.Black;

            txtLog = new TextBox();
            txtLog.Multiline = true;
            txtLog.ReadOnly = true;
            txtLog.ScrollBars = ScrollBars.Vertical;
            txtLog.Dock = DockStyle.Fill;
            txtLog.BorderStyle = BorderStyle.FixedSingle;
            txtLog.BackColor = darkTheme ? Color.FromArgb(30, 34, 46) : Color.FromArgb(248, 249, 252);
            txtLog.ForeColor = darkTheme ? Color.Gainsboro : Color.Black;
            txtLog.Font = new Font("Consolas", 9F);

            FlowLayoutPanel pnlRun = new FlowLayoutPanel();
            pnlRun.Dock = DockStyle.Bottom;
            pnlRun.Height = 84;
            pnlRun.FlowDirection = FlowDirection.LeftToRight;
            pnlRun.WrapContents = false;

            btnRun = MakeButton("开始卸载", 120);
            btnRun.BackColor = Color.FromArgb(198, 52, 52);
            btnRun.ForeColor = Color.White;
            btnRun.FlatStyle = FlatStyle.Flat;
            btnRun.FlatAppearance.BorderSize = 0;
            btnRun.Margin = new Padding(0, 26, 8, 0);
            btnRun.Click += delegate { RunUninstall(); };

            btnClose = MakeButton("退出", 84);
            btnClose.Margin = new Padding(0, 26, 0, 0);
            btnClose.Click += delegate { Close(); };

            pnlRun.Controls.Add(btnRun);
            pnlRun.Controls.Add(btnClose);

            Panel pnlProgress = new Panel();
            pnlProgress.Dock = DockStyle.Bottom;
            pnlProgress.Height = 40;

            pb = new ProgressBar();
            pb.Dock = DockStyle.Bottom;
            pb.Height = 8;
            pb.Style = ProgressBarStyle.Continuous;

            lblStatus = new Label();
            lblStatus.Dock = DockStyle.Top;
            lblStatus.Height = 26;
            lblStatus.Text = "就绪";
            lblStatus.ForeColor = darkTheme ? Color.Gainsboro : Color.Black;

            pnlProgress.Controls.Add(lblStatus);
            pnlProgress.Controls.Add(pb);

            pnlBottom.Controls.Add(txtLog);
            pnlBottom.Controls.Add(lblSummary);
            pnlBottom.Controls.Add(pnlProgress);
            pnlBottom.Controls.Add(pnlRun);

            Controls.Add(lv);
            Controls.Add(pnlBottom);
            Controls.Add(pnlTools);
            Controls.Add(pnlHead);
        }

        private Button MakeButton(string text, int w)
        {
            Button b = new Button();
            b.Text = text;
            b.AutoSize = false;
            b.Size = new Size(w, 30);
            b.Margin = new Padding(0, 3, 6, 0);
            b.UseVisualStyleBackColor = true;
            return b;
        }

        private void AppendLog(string s)
        {
            if (txtLog == null) return;
            if (txtLog.InvokeRequired)
            {
                try { txtLog.BeginInvoke((MethodInvoker)delegate { AppendLog(s); }); } catch { }
                return;
            }
            txtLog.AppendText(s + "\r\n");
        }

        private void SetStatus(string s)
        {
            if (lblStatus.InvokeRequired)
            {
                try { lblStatus.BeginInvoke((MethodInvoker)delegate { SetStatus(s); }); } catch { }
                return;
            }
            lblStatus.Text = s;
        }

        // ---------------------------------------------------------------- 扫描

        /// <summary>把「用户数据」三选一同步给扫描器</summary>
        private void ApplyUserDataMode()
        {
            int m = 0;
            if (rdPurge != null && rdPurge.Checked) m = 1;
            else if (rdKeepAll != null && rdKeepAll.Checked) m = 2;
            Scanner.UserDataMode = m;
        }

        private void StartScan(bool deep)
        {
            if (busy) return;
            ApplyUserDataMode();
            busy = true;
            btnScan.Enabled = false;
            btnRun.Enabled = false;
            lv.Items.Clear();
            items.Clear();
            info = new InstallInfo();
            txtLog.Clear();
            pb.Style = ProgressBarStyle.Marquee;
            SetStatus("正在扫描…");

            Thread th = new Thread(delegate ()
            {
                List<TraceItem> found = null;
                string err = "";
                try
                {
                    found = Scanner.Scan(deep, info, delegate (string s)
                    {
                        SetStatus(s);
                        AppendLog(s);
                    });
                }
                catch (Exception e) { err = e.Message; }

                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        pb.Style = ProgressBarStyle.Continuous;
                        busy = false;
                        btnScan.Enabled = true;
                        btnRun.Enabled = true;

                        if (err.Length > 0)
                        {
                            MessageBox.Show(this, "扫描出错：" + err, Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                            SetStatus("扫描失败");
                            return;
                        }
                        FillList(found);
                    });
                }
                catch { }
            });
            th.IsBackground = true;
            th.Start();
        }

        private static int CatRank(string c)
        {
            switch (c)
            {
                case "安装目录": return 10;
                case "用户数据": return 20;
                case "注册表": return 30;
                case "自启": return 40;
                case "快捷方式": return 50;
                case "计划任务": return 60;
                case "防火墙": return 70;
                case "服务": return 80;
                case "使用记录": return 90;
                default: return 95;
            }
        }

        private void FillList(List<TraceItem> found)
        {
            items = found;
            // 关键项排前面：「使用记录」这类低价值痕迹沉底，避免淹没安装目录与注册表
            items.Sort(delegate (TraceItem a, TraceItem b)
            {
                int r = CatRank(a.Category).CompareTo(CatRank(b.Category));
                if (r != 0) return r;
                return string.Compare(a.Detail, b.Detail, StringComparison.OrdinalIgnoreCase);
            });

            RenderList();
            UpdateSummary();

            if (items.Count == 0)
                SetStatus("没有发现 FNOS 客户端的痕迹（可能已卸载干净）");
            else
                SetStatus("扫描完成，请核对清单后点「开始卸载」");
        }

        /// <summary>按筛选重建可见行。勾选状态存在 TraceItem 上，隐藏不影响实际删除</summary>
        private void RenderList()
        {
            suppress = true;
            lv.BeginUpdate();
            try
            {
                lv.Items.Clear();
                foreach (TraceItem it in items)
                {
                    if (!showUsage && it.Category == "使用记录") continue;
                    ListViewItem row = new ListViewItem(it.Category);
                    row.SubItems.Add(it.Title);
                    row.SubItems.Add(it.Detail);
                    row.SubItems.Add(it.SizeText());
                    row.Tag = it;
                    row.Checked = it.Checked;
                    if (it.Category == "使用记录")
                        row.ForeColor = darkTheme ? Color.Silver : Color.DimGray;
                    lv.Items.Add(row);
                }
            }
            finally
            {
                lv.EndUpdate();
                suppress = false;
            }
        }

        private void UpdateSummary()
        {
            int n = 0;
            long bytes = 0;
            foreach (TraceItem it in items)
            {
                if (!it.Checked) continue;
                n++;
                if (it.SizeBytes > 0) bytes += it.SizeBytes;
            }
            string size = "";
            if (bytes > 0)
            {
                double b = bytes;
                string[] u = new string[] { "B", "KB", "MB", "GB" };
                int i = 0;
                while (b >= 1024 && i < u.Length - 1) { b /= 1024; i++; }
                size = "，约 " + b.ToString("0.0") + " " + u[i];
            }
            int shown = lv.Items.Count;
            string extra = shown == items.Count ? "" : "（显示 " + shown + " 项）";
            lblSummary.Text = "共 " + items.Count + " 项，已勾选 " + n + " 项" + size + extra;
        }

        private void SetAll(bool on)
        {
            foreach (TraceItem it in items) it.Checked = on;
            suppress = true;
            try { foreach (ListViewItem row in lv.Items) row.Checked = on; }
            finally { suppress = false; }
            UpdateSummary();
        }

        private void OpenLog()
        {
            try
            {
                string p = Util.LogFilePath();
                if (string.IsNullOrEmpty(p) || !File.Exists(p))
                {
                    MessageBox.Show(this, "还没有生成日志（执行一次扫描后就会有）。", Program.AppTitle,
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Process.Start("notepad.exe", "\"" + p + "\"");
            }
            catch (Exception e)
            {
                MessageBox.Show(this, "打开日志失败：" + e.Message, Program.AppTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void ExportPlan()
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("FNOS 卸载清单（仅预览，未删除任何文件）");
            sb.AppendLine("生成时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            sb.AppendLine("系统：" + Util.OsName());
            sb.AppendLine(new string('-', 70));
            foreach (TraceItem it in items)
            {
                if (!it.Checked) continue;
                sb.AppendLine("[" + it.Category + "] " + it.Title + "  →  " + it.Detail);
                if (!string.IsNullOrEmpty(it.Note)) sb.AppendLine("        备注：" + it.Note);
            }
            string p = Path.Combine(Program.ExeDir(), "uninstall-plan.txt");
            try
            {
                File.WriteAllText(p, sb.ToString(), new UTF8Encoding(true));
                MessageBox.Show(this, "清单已保存：\r\n" + p, Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception e)
            {
                MessageBox.Show(this, "保存失败：" + e.Message, Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        // ---------------------------------------------------------------- 执行

        private List<TraceItem> Selected()
        {
            List<TraceItem> sel = new List<TraceItem>();
            foreach (TraceItem it in items) if (it.Checked) sel.Add(it);
            return sel;
        }

        private void RunUninstall()
        {
            if (busy) return;
            List<TraceItem> sel = Selected();
            if (sel.Count == 0)
            {
                MessageBox.Show(this, "没有勾选任何项目。", Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!Util.IsAdmin())
            {
                MessageBox.Show(this, "当前不是管理员权限，安装目录/注册表/HKLM 项会失败。\r\n请右键 exe →「以管理员身份运行」。",
                    Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }

            string self = "";
            try { self = Path.GetFullPath(Application.ExecutablePath); } catch { }
            List<string> badDirs = new List<string>();
            foreach (TraceItem it in sel)
            {
                if (it.Kind != ItemKind.Directory || string.IsNullOrEmpty(it.Path)) continue;
                try
                {
                    if (self.Length > 0 && self.StartsWith(Path.GetFullPath(it.Path).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                        badDirs.Add(it.Path);
                }
                catch { }
            }
            if (badDirs.Count > 0)
            {
                MessageBox.Show(this,
                    "卸载器自己就在下面这个目录里，无法一边运行一边删除它：\r\n\r\n" +
                    badDirs[0] + "\r\n\r\n请先把本卸载器 exe 复制到桌面或其它位置，再运行一次。",
                    Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            int dirCount = 0;
            foreach (TraceItem it in sel) if (it.Kind == ItemKind.Directory) dirCount++;

            string dataLine;
            if (Scanner.UserDataMode == 1)
                dataLine = "· 用户数据：【全部删除】——设置、Cookie、日志、皮肤、下载记录、播放进度，不可恢复";
            else if (Scanner.UserDataMode == 2)
                dataLine = "· 用户数据：【完全保留】（仅删程序，数据全部留下）";
            else
                dataLine = "· 用户数据：【保留配置】——删缓存/日志/更新包，保留 settings.json、servers.json、皮肤";

            string ask = "即将删除 " + sel.Count + " 项（其中目录 " + dirCount + " 个）：\r\n\r\n" +
                         "· 安装目录及其下全部文件（resources / mpv / 更新缓存）\r\n" +
                         dataLine + "\r\n" +
                         "· 注册表：产品项、卸载登记、开机自启、MuiCache、最近使用记录\r\n" +
                         "· 快捷方式（含「影视」「电视直播」这类子应用快捷方式）、计划任务、防火墙规则\r\n" +
                         "· 安装器残留、Windows 错误报告、Electron 共享目录内的 FNOS 专属文件\r\n\r\n" +
                         "此操作不可撤销。建议先点「导出清单」留底。\r\n\r\n确定继续？";
            if (MessageBox.Show(this, ask, "确认卸载", MessageBoxButtons.YesNo, MessageBoxIcon.Warning,
                    MessageBoxDefaultButton.Button2) != DialogResult.Yes)
            {
                Environment.ExitCode = 2;
                return;
            }

            busy = true;
            btnRun.Enabled = false;
            btnScan.Enabled = false;
            btnAll.Enabled = false;
            btnNone.Enabled = false;
            pb.Style = ProgressBarStyle.Continuous;
            pb.Value = 0;
            pb.Maximum = sel.Count;
            SetStatus("正在清理…");

            Thread th = new Thread(delegate ()
            {
                List<StepResult> results = null;
                try
                {
                    results = Executor.Run(sel, info,
                        delegate (string s) { AppendLog(s); },
                        delegate (int cur, int total, string title)
                        {
                            try
                            {
                                BeginInvoke((MethodInvoker)delegate
                                {
                                    if (cur <= pb.Maximum) pb.Value = cur;
                                    SetStatus("(" + cur + "/" + total + ") " + title);
                                });
                            }
                            catch { }
                        });
                }
                catch (Exception e)
                {
                    AppendLog("执行异常：" + e.Message);
                }

                try { BeginInvoke((MethodInvoker)delegate { Finish(results); }); }
                catch { }
            });
            th.IsBackground = true;
            th.Start();
        }

        private void Finish(List<StepResult> results)
        {
            busy = false;
            btnRun.Enabled = true;
            btnScan.Enabled = true;
            btnAll.Enabled = true;
            btnNone.Enabled = true;

            if (results == null) { SetStatus("执行失败"); return; }

            int ok = 0, fail = 0;
            foreach (StepResult r in results) { if (r.Ok) ok++; else fail++; }

            string report = Executor.BuildReport(results, info, false);
            string p = Path.Combine(Program.ExeDir(), "uninstall-report.txt");
            try { File.WriteAllText(p, report, new UTF8Encoding(true)); } catch { }

            SetStatus("完成：成功 " + ok + " 项，失败 " + fail + " 项");
            AppendLog("===== 完成：成功 " + ok + "，失败 " + fail + " =====");

            string msg = "清理完成。\r\n\r\n成功 " + ok + " 项，失败 " + fail + " 项。\r\n报告：\r\n" + p;
            if (fail > 0)
            {
                msg += "\r\n\r\n失败项多为文件被占用（日志里有占用进程名）。处理："
                     + "\r\n1) 重启电脑，已登记的文件会在重启时被系统删除；"
                     + "\r\n2) 重启后再运行一次本工具，清掉剩下的空目录与注册表项。"
                     + "\r\n\r\n详细日志：\r\n" + Util.LogFilePath();
            }
            MessageBox.Show(this, msg, Program.AppTitle, MessageBoxButtons.OK,
                fail > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);

            // 不再自动重扫（以前会自动再扫一遍，看起来像"反复扫描"）；需要的点「重新扫描」
            SetStatus(fail > 0
                ? "已清理，仍有 " + fail + " 项失败：重启后再运行一次；点「重新扫描」可查看剩余"
                : "清理完成；点「重新扫描」可确认是否还有残留");
        }
    }
}
