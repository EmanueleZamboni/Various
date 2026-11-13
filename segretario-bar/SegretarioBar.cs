// Segretario Bar (13/11/2026): the "where was I" tabs glued to the top of the Claude desktop app, in every chat.
// The Claude app is a sealed Store package, so this is a tiny window of its own that follows the Claude window:
// - owned by the Claude window, so it moves above it, minimises with it and never covers other apps;
// - cut to the shape of the tabs (SetWindowRgn), so clicks anywhere else go straight to Claude;
// - reads which chat Claude shows (title and address) through Windows accessibility, and tells the Segretario
//   (title and link only, never the content), exactly like the Chrome extension does on claude.ai;
// - fetches the list from hub.emazamboni.com with the Telegram-code cookie of its own WebView2 profile.
// Built with the C# 5 compiler that ships with Windows (build.ps1). Language: C# 5, so no $"" or ?.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SegretarioBar
{
    static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
        [DllImport("gdi32.dll")] public static extern int CombineRgn(IntPtr d, IntPtr a, IntPtr b, int mode);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
        [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
        [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    }

    static class Program
    {
        public static readonly string DataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SegretarioBar");

        public static void Log(string s)
        {
            try
            {
                Directory.CreateDirectory(DataDir);
                string f = Path.Combine(DataDir, "bar.log");
                if (File.Exists(f) && new FileInfo(f).Length > 512 * 1024) File.Delete(f);
                File.AppendAllText(f, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + s + Environment.NewLine);
            }
            catch { }
        }

        [STAThread]
        static void Main()
        {
            bool primo;
            using (var unico = new Mutex(true, "SegretarioBar-Ema", out primo))
            {
                if (!primo) return;
                Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); // per-monitor v2: same pixels as the Claude window
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += (s, e) => Log("error: " + e.Exception);
                Log("start " + Application.ExecutablePath);
                Application.Run(new BarForm());
                Log("quit");
            }
        }
    }

    class BarForm : Form
    {
        public const string Hub = "https://hub.emazamboni.com";
        const int TopCss = 40;       // just under the Claude app's top row (36 points tall)
        const int MaxWidthCss = 1100;
        static readonly Regex ChatLink = new Regex(@"^https://claude\.ai/(chat|project)/([A-Za-z0-9-]{8,80})$");
        static readonly Regex CodeLink = new Regex(@"^claude://claude\.ai/epitaxy/local_[A-Za-z0-9-]{8,80}$");
        static readonly Regex OpenUrl = new Regex(@"^https://claude\.ai/(chat|project)/([A-Za-z0-9-]{8,80})(?:[/?#].*)?$");
        static readonly Regex TitleTail = new Regex(@"\s*[-|–—]\s*Claude(?: Code)?\s*$", RegexOptions.IgnoreCase);

        readonly WebView2 web = new WebView2();
        readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer();
        readonly HttpClient http = new HttpClient(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false });
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly NotifyIcon tray = new NotifyIcon();
        public CoreWebView2Environment Env;

        IntPtr claude = IntPtr.Zero, owner = IntPtr.Zero;
        DateTime nextFind = DateTime.MinValue;
        bool pageReady, shown, open, mouseWasDown, loginOffered;
        List<double[]> shape = new List<double[]>(); // css px: x, y, w, h, ledge
        Rectangle placed = Rectangle.Empty; double placedScale; string placedShape = "";
        LoginForm login;
        string quiLink = "", quiTitle = ""; bool quiCode;
        readonly Dictionary<string, KeyValuePair<string, DateTime>> marked = new Dictionary<string, KeyValuePair<string, DateTime>>();

        public BarForm()
        {
            Text = "Segretario Bar";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            Size = new Size(10, 10);
            BackColor = Color.FromArgb(248, 247, 243);
            web.Dock = DockStyle.Fill;
            Controls.Add(web);
            http.Timeout = TimeSpan.FromSeconds(20);

            var menu = new ContextMenuStrip();
            menu.Items.Add("Refresh the recent chats", null, (s, e) => Refresh(true));
            menu.Items.Add("Log in to the Segretario", null, (s, e) => ShowLogin());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit Segretario Bar", null, (s, e) => { tray.Visible = false; Application.Exit(); });
            tray.ContextMenuStrip = menu;
            tray.Icon = MakeIcon();
            tray.Text = "Segretario Bar: recent Claude chats";
            tray.Visible = true;

            tick.Interval = 100;
            tick.Tick += (s, e) => Follow();
            var watcher = new Thread(WatchClaude) { IsBackground = true, Name = "watch-claude" };
            watcher.SetApartmentState(ApartmentState.MTA);
            watcher.Start();
        }

        // Appearing never takes the focus; a click does (a NOACTIVATE window let no click reach the WebView2, seen
        // 13/11/2026), and the page hands it back to Claude right after ("fatto"). Out of the taskbar and Alt+Tab.
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x00000080 /*TOOLWINDOW*/;
                return cp;
            }
        }
        // Shown and hidden through WinForms (Visible), never with a bare ShowWindow: the WebView2 control only draws
        // while WinForms thinks its window is visible, otherwise the bar is a blank white box (seen 13/11/2026).
        bool allowShow;
        protected override void SetVisibleCore(bool value)
        {
            if (!IsHandleCreated) { CreateHandle(); value = false; } // stay hidden until there is a shape to show
            else if (value && !allowShow) value = false;
            base.SetVisibleCore(value);
        }
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Start();
        }

        static Icon MakeIcon()
        {
            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var b = new SolidBrush(Color.FromArgb(75, 78, 219))) g.FillEllipse(b, 2, 2, 28, 28);
                using (var w = new SolidBrush(Color.White))
                {
                    g.FillRectangle(w, 9, 10, 14, 3); g.FillRectangle(w, 9, 15, 14, 3); g.FillRectangle(w, 9, 20, 9, 3);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        async void Start()
        {
            try
            {
                Directory.CreateDirectory(Program.DataDir);
                Env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "WebView2"), null);
                await web.EnsureCoreWebView2Async(Env);
                var c = web.CoreWebView2;
                c.Settings.AreDevToolsEnabled = false;
                c.Settings.AreDefaultContextMenusEnabled = false;
                c.Settings.IsZoomControlEnabled = false;
                c.Settings.IsStatusBarEnabled = false;
                c.NavigationStarting += (s, e) => { if (!(e.Uri.StartsWith("data:") || e.Uri.StartsWith("about:"))) e.Cancel = true; };
                c.NewWindowRequested += (s, e) => { e.Handled = true; };
                c.WebMessageReceived += OnMessage;
                c.NavigateToString(BuildPage());
                tick.Start();
            }
            catch (Exception ex)
            {
                Program.Log("WebView2 start failed: " + ex);
                MessageBox.Show("Segretario Bar could not start its web view:\n" + ex.Message, "Segretario Bar");
                Application.Exit();
            }
        }

        static string Asset(string name)
        {
            return File.ReadAllText(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), name), Encoding.UTF8);
        }

        string BuildPage()
        {
            bool hidden = false;
            try { hidden = File.ReadAllText(Path.Combine(Program.DataDir, "hidden.txt")).Trim() == "1"; } catch { }
            string tabs = "null";
            try
            {
                string t = File.ReadAllText(TabsFile, Encoding.UTF8);
                if (json.DeserializeObject(t) is Dictionary<string, object>) tabs = t.Replace("</", "<\\/");
            }
            catch { }
            return Asset("bar.html")
                .Replace("/*CSS*/", Asset("bar.css"))
                .Replace("/*NASCOSTA*/false", hidden ? "true" : "false")
                .Replace("/*TABS*/null", tabs)
                .Replace("/*JS*/", Asset("bar.js"));
        }

        static string TabsFile { get { return Path.Combine(Program.DataDir, "tabs.json"); } }

        void Post(Dictionary<string, object> m)
        {
            if (web.CoreWebView2 == null) return;
            try { web.CoreWebView2.PostWebMessageAsJson(json.Serialize(m)); } catch (Exception ex) { Program.Log("post: " + ex.Message); }
        }

        readonly HashSet<string> seenTypes = new HashSet<string>();
        static double Num(object o) { try { return Convert.ToDouble(o); } catch { return 0; } }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> m;
            try { m = json.DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>; } catch { return; }
            if (m == null || !m.ContainsKey("tipo")) return;
            string tipo = Convert.ToString(m["tipo"]);
            if (seenTypes.Add(tipo)) Program.Log("first message from the page: " + tipo);
            if (tipo == "forma")
            {
                var list = new List<double[]>();
                var rects = m.ContainsKey("rects") ? m["rects"] as IEnumerable : null;
                if (rects != null)
                    foreach (var r in rects)
                    {
                        var d = r as Dictionary<string, object>;
                        if (d == null) continue;
                        list.Add(new[] { Num(d["x"]), Num(d["y"]), Num(d["w"]), Num(d["h"]), d.ContainsKey("ledge") ? Num(d["ledge"]) : 0,
                            d.ContainsKey("top") ? Num(d["top"]) : 0 });
                    }
                shape = list;
                shapeVw = m.ContainsKey("vw") ? Num(m["vw"]) : 0;
                shapeRight = m.ContainsKey("destra") && m["destra"] is bool && (bool)m["destra"];
                open = m.ContainsKey("aperto") && m["aperto"] is bool && (bool)m["aperto"];
                pageReady = true;
                Follow();
            }
            else if (tipo == "lista") { lastCode = ""; lastColour = ""; nextSample = DateTime.MinValue; rowCssNow = -1; Refresh(false); } // the page (re)loaded: send the Code chats again too
            else if (tipo == "login") ShowLogin();
            else if (tipo == "nascosta")
            {
                bool v = m.ContainsKey("valore") && m["valore"] is bool && (bool)m["valore"];
                try { File.WriteAllText(Path.Combine(Program.DataDir, "hidden.txt"), v ? "1" : "0"); } catch { }
            }
            else if (tipo == "salva" && m.ContainsKey("stato") && m["stato"] is Dictionary<string, object>)
            {
                try
                {
                    string tmp = TabsFile + ".tmp";
                    File.WriteAllText(tmp, json.Serialize(m["stato"]), Encoding.UTF8);
                    if (File.Exists(TabsFile)) File.Replace(tmp, TabsFile, null); else File.Move(tmp, TabsFile);
                }
                catch (Exception ex) { Program.Log("save tabs: " + ex.Message); }
            }
            else if (tipo == "apri") OpenChat(m.ContainsKey("link") ? Convert.ToString(m["link"]) : "");
            else if (tipo == "fatto" && claude != IntPtr.Zero && Native.GetForegroundWindow() == Handle) Native.SetForegroundWindow(claude);
        }

        // ---------- the Segretario, through the hub, with the Telegram-code cookie ----------
        public async Task<KeyValuePair<int, string>> HubCallWith(CoreWebView2 core, HttpMethod method, string path, string body)
        {
            var list = await core.CookieManager.GetCookiesAsync(Hub + "/");
            var sb = new StringBuilder();
            foreach (var c in list) { if (sb.Length > 0) sb.Append("; "); sb.Append(c.Name).Append('=').Append(c.Value); }
            using (var req = new HttpRequestMessage(method, Hub + path))
            {
                if (sb.Length > 0) req.Headers.TryAddWithoutValidation("Cookie", sb.ToString());
                req.Headers.TryAddWithoutValidation("Cache-Control", "no-store");
                if (body != null) req.Content = new StringContent(body, Encoding.UTF8, "application/json");
                using (var resp = await http.SendAsync(req))
                    return new KeyValuePair<int, string>((int)resp.StatusCode, await resp.Content.ReadAsStringAsync());
            }
        }

        bool refreshing;
        public async void Refresh(bool fromMenu)
        {
            if (refreshing || web.CoreWebView2 == null) return;
            refreshing = true;
            var m = new Dictionary<string, object>();
            m["tipo"] = "lista";
            try
            {
                var r = await HubCallWith(web.CoreWebView2, HttpMethod.Get, "/chat-recenti.json?quante=40", null);
                if (r.Key == 200) m["dati"] = json.DeserializeObject(r.Value);
                else
                {
                    m["errore"] = "http " + r.Key;
                    if (r.Key == 401 && !loginOffered) { loginOffered = true; ShowLogin(); }
                }
            }
            catch (Exception ex) { m["errore"] = ex.Message; Program.Log("refresh: " + ex.Message); }
            finally { refreshing = false; }
            Post(m);
        }

        public void ShowLogin()
        {
            if (login != null && !login.IsDisposed) { login.Activate(); return; }
            login = new LoginForm(this);
            login.FormClosed += (s, e) => Refresh(false);
            login.Show();
        }

        void OpenChat(string link)
        {
            string target = null;
            var mc = ChatLink.Match(link);
            if (mc.Success) target = "claude://claude.ai/" + mc.Groups[1].Value + "/" + mc.Groups[2].Value;
            else if (CodeLink.IsMatch(link)) target = link;
            if (target == null) { Program.Log("refused to open: " + link); return; }
            if (TestTarget != null) { Program.Log("test mode, would open: " + target); return; }
            Program.Log("open " + target);
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Exception ex) { Program.Log("open " + target + ": " + ex.Message); }
        }

        // ---------- the Claude window ----------
        // SEGBAR_TARGET=notepad sticks the bar to another app's window instead (for testing clicks without
        // touching Claude); in that mode chats are only logged, never opened.
        static readonly string TestTarget = Environment.GetEnvironmentVariable("SEGBAR_TARGET");

        static IntPtr FindClaude()
        {
            if (!string.IsNullOrEmpty(TestTarget))
            {
                foreach (var p in Process.GetProcessesByName(TestTarget))
                    using (p) if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle;
                return IntPtr.Zero;
            }
            foreach (var p in Process.GetProcessesByName("claude"))
            {
                try
                {
                    if (p.MainWindowHandle == IntPtr.Zero || p.MainWindowTitle != "Claude") continue;
                    string path = p.MainModule.FileName;
                    if (path.IndexOf(@"\WindowsApps\Claude_", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    return p.MainWindowHandle;
                }
                catch (Exception ex) { Program.Log("find claude: " + ex.Message); }
                finally { p.Dispose(); }
            }
            return IntPtr.Zero;
        }

        void Hide2()
        {
            if (!shown) return;
            allowShow = false;
            Visible = false;
            shown = false;
        }

        DateTime nextStatus = DateTime.MinValue, nextRaise = DateTime.MinValue;
        void WriteStatus(string why)
        {
            if (DateTime.Now < nextStatus) return;
            nextStatus = DateTime.Now.AddSeconds(5);
            try
            {
                File.WriteAllText(Path.Combine(Program.DataDir, "status.txt"),
                    DateTime.Now.ToString("HH:mm:ss") + " claude=" + claude + " page=" + pageReady + " shapes=" + shape.Count +
                    " shown=" + shown + " placed=" + placed + " scale=" + placedScale + " qui=" + quiTitle + " | " + quiLink +
                    " | " + why + " shape=" + json.Serialize(shape));
            }
            catch { }
        }

        // Windows tells us the moment the Claude window moves or changes size (EVENT_OBJECT_LOCATIONCHANGE), so the bar
        // follows every step of a drag or a resize instead of trailing behind a timer.
        Native.WinEventProc moveProc;   // kept in a field: the delegate must outlive the hook
        IntPtr moveHook = IntPtr.Zero;
        void HookMoves()
        {
            if (moveHook != IntPtr.Zero) { Native.UnhookWinEvent(moveHook); moveHook = IntPtr.Zero; }
            uint pid; Native.GetWindowThreadProcessId(claude, out pid);
            if (pid == 0) return;
            if (moveProc == null)
                moveProc = (hook, ev, hwnd, idObject, idChild, thread, time) => { if (hwnd == claude && idObject == 0) Follow(); };
            moveHook = Native.SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, moveProc, pid, 0, 0 /*OUTOFCONTEXT*/);
            if (moveHook == IntPtr.Zero) Program.Log("could not watch the Claude window's moves; following it on the timer only");
        }

        // the top row's free space: left end from the window's LEFT edge, right end from its RIGHT edge (Claude's icons
        // stay against the right edge when the window is resized), top and button line from its top
        int[] rowRel;
        bool dockedNow, compactNow; double rowCssNow = -1;

        void Follow()
        {
            WriteStatus("tick");
            if (claude == IntPtr.Zero || !Native.IsWindow(claude))
            {
                claude = IntPtr.Zero;
                if (DateTime.Now >= nextFind) { claude = FindClaude(); nextFind = DateTime.Now.AddSeconds(1); }
                if (claude == IntPtr.Zero) { Hide2(); return; }
            }
            if (!pageReady || shape.Count == 0 || Native.IsIconic(claude) || !Native.IsWindowVisible(claude)) { Hide2(); return; }
            if (owner != claude) { Native.SetWindowLongPtr(Handle, -8 /*GWLP_HWNDPARENT*/, claude); owner = claude; HookMoves(); }

            Native.RECT r;
            if (Native.DwmGetWindowAttribute(claude, 9 /*EXTENDED_FRAME_BOUNDS*/, out r, Marshal.SizeOf(typeof(Native.RECT))) != 0) { Hide2(); return; }
            double s = Native.GetDpiForWindow(claude) / 96.0;
            if (s <= 0) s = 1;
            int fullW = r.R - r.L;
            int wCss = (int)Math.Min(MaxWidthCss, fullW / s - 24);
            if (wCss < 200) { Hide2(); return; }
            double hCss = 0;
            foreach (var q in shape) hCss = Math.Max(hCss, q[1] + q[3] + q[4]);
            int w = (int)Math.Round(wCss * s), h = (int)Math.Ceiling((hCss + 2) * s);
            var want = new Rectangle(r.L + (fullW - w) / 2, r.T + (int)Math.Round(TopCss * s), w, h);

            // Docked: inside the free middle of Claude's top row, exactly on the line of Claude's own buttons there
            // (same top, same height), so the tabs line up with the chat title and the icons. The row's colour is read
            // just above the bar, where the row is empty.
            // The bar lives ONLY in Claude's top row, never over the chat or the sidebar (it once fell back to floating
            // under the row when the window was narrow). Room for tabs: tabs. A little room: one compact "Tabs" button
            // that drops down the list (the drop-down may be wider than the button: it hangs below the row). No room:
            // hidden until there is.
            bool docked = false, compact = false; double rowCss = 0;
            int[] rel = rowRel;
            if (rel != null && rel.Length > 4)
            {
                int pad = (int)Math.Round(12 * s);
                int L = r.L + rel[0] + pad, R = r.R - rel[1] - pad, top = r.T + rel[4], bottom = r.T + rel[3];
                double free = (R - L) / s;
                if (free >= 110 && bottom - top > 20 * s && top - (r.T + rel[2]) >= 3)
                {
                    docked = true;
                    compact = free < 360;
                    rowCss = Math.Round((bottom - top) / s);
                    int wide = open ? Math.Max(R - L, (int)Math.Round(440 * s)) : R - L;
                    want = new Rectangle(R - wide, top, wide, h);
                }
            }
            if (!docked) { Hide2(); return; }
            if (docked != dockedNow || compact != compactNow || rowCss != rowCssNow)
            {
                Program.Log("place: " + (compact ? "compact button" : "tabs") + " in the top row at " + want);
                dockedNow = docked; compactNow = compact; rowCssNow = rowCss;
                Post(new Dictionary<string, object> { { "tipo", "modo" }, { "docked", docked }, { "compatto", compact }, { "alto", rowCss } });
            }
            string shapeKey = json.Serialize(shape) + "|" + want.Width + "|" + shapeVw; // a resize re-cuts the window too
            if (want != placed || s != placedScale || !shown)
            {
                Native.SetWindowPos(Handle, IntPtr.Zero, want.X, want.Y, want.Width, want.Height,
                    0x0004 /*NOZORDER*/ | 0x0010 /*NOACTIVATE*/);
                placed = want; placedScale = s;
                if (!shown) { allowShow = true; Visible = true; shown = true; } // ShowWithoutActivation: no focus taken
            }
            // Being owned keeps it above Claude only after Windows reorders the pair: lift it right above Claude
            // whenever Claude is the window in front (cheap, no focus taken).
            if (Native.GetForegroundWindow() == claude && DateTime.Now >= nextRaise)
            {
                Native.SetWindowPos(Handle, IntPtr.Zero /*HWND_TOP*/, 0, 0, 0, 0, 0x0001 /*NOSIZE*/ | 0x0002 /*NOMOVE*/ | 0x0010 /*NOACTIVATE*/);
                nextRaise = DateTime.Now.AddMilliseconds(400);
            }
            if (shapeKey != placedShape || s != placedScale) { ApplyShape(s); placedShape = shapeKey; }
            else if (placedShape == "") { ApplyShape(s); placedShape = shapeKey; }
            SampleBelow(s);

            // a click anywhere outside the tabs closes the open card or history, as on claude.ai
            bool down = (Native.GetAsyncKeyState(0x01) & 0x8000) != 0;
            if (down && !mouseWasDown && open)
            {
                Native.POINT p; Native.GetCursorPos(out p);
                if (!Inside(p.X - placed.X, p.Y - placed.Y, s)) Post(new Dictionary<string, object> { { "tipo", "fuori" } });
            }
            mouseWasDown = down;
        }

        // Claude's page colour right under the bar (11 pixels across, the most common wins, so text doesn't count):
        // the open tab is painted in it, which makes the tab flow into Claude's page like Chrome's active tab.
        // Read every 2 s, only while Claude (or the bar) is the window in front, so another window's colour never leaks.
        DateTime nextSample = DateTime.MinValue;
        string lastColour = "";
        void SampleBelow(double s)
        {
            if (DateTime.Now < nextSample || !shown) return;
            nextSample = DateTime.Now.AddSeconds(2);
            IntPtr fg = Native.GetForegroundWindow();
            if (fg != claude && fg != Handle) return;
            if (shape.Count == 0) return;
            // the page: just under the tab strip (skipped while a card hangs over it); the row: just above the bar
            int stripBottom = placed.Y + (int)Math.Ceiling((shape[0][1] + shape[0][3]) * s);
            string page = open ? lastPage : Mode(stripBottom + (int)Math.Round(4 * s));
            string row = dockedNow ? Mode(placed.Y - 2) : "";
            if (page == "") return;
            string key = page + "|" + row;
            if (key == lastColour) return;
            lastColour = key; lastPage = page;
            Post(new Dictionary<string, object> { { "tipo", "sfondo" }, { "colore", page }, { "fila", row } });
        }
        string lastPage = "";

        // the most common colour of 11 pixels across the bar's width at screen row y ("" when no colour wins)
        string Mode(int y)
        {
            var counts = new Dictionary<uint, int>();
            IntPtr dc = Native.GetDC(IntPtr.Zero);
            try
            {
                for (int i = 0; i < 11; i++)
                {
                    int x = placed.X + (int)(placed.Width * (i + 0.5) / 11);
                    uint c = Native.GetPixel(dc, x, y);
                    if (c == 0xFFFFFFFF) continue;
                    int n; counts.TryGetValue(c, out n); counts[c] = n + 1;
                }
            }
            finally { Native.ReleaseDC(IntPtr.Zero, dc); }
            uint best = 0; int bestN = 0;
            foreach (var kv in counts) if (kv.Value > bestN) { best = kv.Key; bestN = kv.Value; }
            if (bestN < 4) return "";
            return string.Format("#{0:x2}{1:x2}{2:x2}", best & 0xFF, (best >> 8) & 0xFF, (best >> 16) & 0xFF); // COLORREF is 0x00BBGGRR
        }

        // The page measured its shapes at width shapeVw; when the window has since been resized, the tabs (anchored on
        // the right when docked, centred otherwise) have already moved by this much: shift the shapes the same way at
        // once, instead of cutting the window in the old place until the page measures again.
        double shapeVw; bool shapeRight;
        double Shift(double s)
        {
            if (shapeVw <= 0 || placed.Width <= 0) return 0;
            double d = placed.Width / s - shapeVw;
            return shapeRight ? d : d / 2;
        }

        bool Inside(int x, int y, double s)
        {
            double sh = Shift(s);
            foreach (var q in shape)
                if (x >= (q[0] + sh) * s && x <= (q[0] + sh + q[2]) * s && y >= q[1] * s && y <= (q[1] + q[3] + q[4]) * s) return true;
            return false;
        }

        void ApplyShape(double s)
        {
            IntPtr all = Native.CreateRectRgn(0, 0, 0, 0);
            int d = (int)Math.Round(24 * s); // 12 px corners
            double sh = Shift(s);
            foreach (var q0 in shape)
            {
                var q = (double[])q0.Clone(); q[0] += sh;
                int l = (int)Math.Floor(q[0] * s), t = (int)Math.Floor(q[1] * s);
                int rr = (int)Math.Ceiling((q[0] + q[2]) * s), b = (int)Math.Ceiling((q[1] + q[3]) * s);
                int ledge = (int)Math.Round(q[4] * s);
                IntPtr one = q.Length > 5 && q[5] >= 2 ? Native.CreateRectRgn(l, t, rr, b + ledge)   // docked strip: square
                    : Native.CreateRoundRectRgn(l, t, rr + 1, b + 1 + ledge, d, d);
                Native.CombineRgn(all, all, one, 2 /*RGN_OR*/);
                Native.DeleteObject(one);
                if (q.Length > 5 && q[5] > 0) // rounded on top only: square off the bottom half
                {
                    IntPtr low = Native.CreateRectRgn(l, t + d, rr, b + ledge);
                    Native.CombineRgn(all, all, low, 2 /*RGN_OR*/);
                    Native.DeleteObject(low);
                }
            }
            Native.SetWindowRgn(Handle, all, true); // Windows owns the region from here
        }

        // ---------- which chat Claude shows: title + address, read through accessibility every 3 s ----------
        // The Claude window holds several pages: the app's own claude.ai page (the one we want), the built-in browser
        // panel, an app shell page, and this bar itself (Windows counts an owned window as part of its owner). Only a
        // page at https://claude.ai/ counts, the widest one if several.
        // The same pass measures Claude's top row: the free space between the buttons on its left (menu, back, chat
        // title...) and on its right (panels, more...). The tabs dock into that space, like Chrome's tabs in its title bar.
        void WatchClaude()
        {
            var docCond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document);
            while (true)
            {
                try
                {
                    IntPtr h = claude;
                    if (h != IntPtr.Zero && Native.IsWindow(h) && !Native.IsIconic(h))
                    {
                        var root = AutomationElement.FromHandle(h);
                        AutomationElement doc = null; string url = ""; double widest = 0;
                        foreach (AutomationElement d in root.FindAll(TreeScope.Descendants, docCond))
                        {
                            object vp; string u = "";
                            if (d.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) u = ((ValuePattern)vp).Current.Value ?? "";
                            if (!u.StartsWith("https://claude.ai/")) continue;
                            double w = d.Current.BoundingRectangle.Width;
                            if (w > widest) { widest = w; doc = d; url = u; }
                        }
                        if (doc != null)
                        {
                            string name = doc.Current.Name ?? "";
                            string u2 = url;
                            BeginInvoke(new Action(() => OnClaudeShows(name, u2)));
                            int[] dock = MeasureTopRow(doc);
                            BeginInvoke(new Action(() =>
                            {
                                Native.RECT fr;
                                if (dock == null || Native.DwmGetWindowAttribute(h, 9, out fr, Marshal.SizeOf(typeof(Native.RECT))) != 0) { TakeRow(null); return; }
                                TakeRow(new[] { dock[0] - fr.L, fr.R - dock[1], dock[2] - fr.T, dock[3] - fr.T, dock[4] - fr.T });
                            }));
                            if (url != lastUrl) { lastUrl = url; fastUntil = DateTime.Now.AddSeconds(3); } // a chat switch: look again soon
                        }
                    }
                }
                catch (Exception ex) { Program.Log("watch: " + ex.GetType().Name + " " + ex.Message); }
                try { ScanCode(); } catch (Exception ex) { Program.Log("code scan: " + ex.GetType().Name + " " + ex.Message); }
                Thread.Sleep(DateTime.Now < fastUntil ? 500 : 3000);
            }
        }

        string lastUrl = "";
        DateTime fastUntil = DateTime.MinValue;

        // A new top-row layout is used only once two readings in a row agree (within 4 px): while a chat loads, the row
        // is briefly half-built and one reading would throw the bar to the wrong place. A few failed readings in a row
        // are needed before the bar leaves the row.
        int[] rowCandidate; int rowHits, rowMisses; DateTime rowSince;
        void TakeRow(int[] rel)
        {
            if (rel == null) { if (++rowMisses >= 4) { rowRel = null; rowCandidate = null; } return; }
            rowMisses = 0;
            if (SameRow(rel, rowRel)) { rowCandidate = null; return; }
            if (SameRow(rel, rowCandidate)) rowHits++; else { rowCandidate = rel; rowHits = 1; rowSince = DateTime.Now; }
            // a new layout must hold for 2.5 s (several readings), so a page caught mid-load never moves the bar
            if (rowHits >= 2 && (DateTime.Now - rowSince).TotalSeconds >= 2.5 || rowRel == null && rowHits >= 2)
            {
                Program.Log("top row: free from " + rel[0] + " px after the left edge to " + rel[1] + " px before the right edge, buttons " + rel[4] + ".." + rel[3]);
                rowRel = rowCandidate; rowCandidate = null;
            }
        }
        static bool SameRow(int[] a, int[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (Math.Abs(a[i] - b[i]) > 4) return false;
            return true;
        }

        // ---------- the Claude app's own record of each Code chat ----------
        // %LOCALAPPDATA%\Claude-Data\claude_<id>\claude-code-sessions\<account>\<org>\local_<id>.json holds, among much
        // else: title, lastTurnEdgeAt (Claude finished a turn), lastFocusedAt (Ema last looked at it), latestUserFrameAt
        // (his last message), isArchived and postTurnSummary {status_category, status_detail, needs_action}.
        // Only those fields (and previousTitles, the names a renamed chat had) are read; files untouched for 30 days are
        // skipped; only changed files are read again.
        static readonly Regex LocalId = new Regex(@"^local_[A-Za-z0-9-]{8,80}$");
        readonly JavaScriptSerializer codeJson = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        readonly Dictionary<string, KeyValuePair<DateTime, Dictionary<string, object>>> codeCache =
            new Dictionary<string, KeyValuePair<DateTime, Dictionary<string, object>>>();
        string lastCode = "";

        static string SessionsRoot()
        {
            string b = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Claude-Data");
            if (!Directory.Exists(b)) return null;
            foreach (var d in Directory.GetDirectories(b, "claude_*"))
            {
                string s = Path.Combine(d, "claude-code-sessions");
                if (Directory.Exists(s)) return s;
            }
            return null;
        }

        // the names a chat had before Ema renamed it (the app keeps them): the Segretario may still know it by one of them
        static List<string> OldTitles(Dictionary<string, object> d)
        {
            var o = new List<string>();
            object v;
            if (d.TryGetValue("previousTitles", out v) && v is IEnumerable && !(v is string))
                foreach (var x in (IEnumerable)v)
                {
                    string t = x as string;
                    var dx = x as Dictionary<string, object>;
                    if (t == null && dx != null) t = S(dx, "title");
                    if (!string.IsNullOrEmpty(t) && o.Count < 8) o.Add(t.Length > 120 ? t.Substring(0, 120) : t);
                }
            return o;
        }

        static double D(Dictionary<string, object> d, string k)
        {
            object v; return d.TryGetValue(k, out v) && v != null ? Num(v) : 0;
        }
        static string S(Dictionary<string, object> d, string k)
        {
            object v; return d.TryGetValue(k, out v) && v is string ? (string)v : "";
        }

        void ScanCode()
        {
            string root = SessionsRoot();
            if (root == null) return;
            var seenFiles = new HashSet<string>();
            foreach (var f in Directory.EnumerateFiles(root, "local_*.json", SearchOption.AllDirectories))
            {
                DateTime t = File.GetLastWriteTimeUtc(f);
                if (DateTime.UtcNow - t > TimeSpan.FromDays(30)) continue;
                seenFiles.Add(f);
                KeyValuePair<DateTime, Dictionary<string, object>> c;
                if (codeCache.TryGetValue(f, out c) && c.Key == t) continue;
                Dictionary<string, object> one = null;
                try
                {
                    string txt;
                    using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (var r = new StreamReader(fs, Encoding.UTF8)) txt = r.ReadToEnd();
                    var d = codeJson.DeserializeObject(txt) as Dictionary<string, object>;
                    string id = d == null ? "" : S(d, "sessionId");
                    if (d != null && LocalId.IsMatch(id) && !(d.ContainsKey("isArchived") && d["isArchived"] is bool && (bool)d["isArchived"]))
                    {
                        var sum = d.ContainsKey("postTurnSummary") ? d["postTurnSummary"] as Dictionary<string, object> : null;
                        double turnEnd = D(d, "lastTurnEdgeAt"), userFrame = D(d, "latestUserFrameAt");
                        one = new Dictionary<string, object> {
                            { "link", "claude://claude.ai/epitaxy/" + id },
                            { "titolo", S(d, "title") },
                            { "prima", OldTitles(d) },
                            { "turnEnd", turnEnd },
                            { "focused", D(d, "lastFocusedAt") },
                            { "activity", D(d, "lastActivityAt") },
                            { "running", userFrame > turnEnd },
                            { "needs", sum != null && S(sum, "needs_action") != "" },
                            { "detail", sum == null ? "" : S(sum, "status_detail") },
                        };
                    }
                }
                catch (IOException) { continue; } // the app is writing it: read it next time
                catch (Exception ex) { Program.Log("code record " + Path.GetFileName(f) + ": " + ex.Message); }
                codeCache[f] = new KeyValuePair<DateTime, Dictionary<string, object>>(t, one);
            }
            foreach (var k in new List<string>(codeCache.Keys)) if (!seenFiles.Contains(k)) codeCache.Remove(k);

            var list = new List<object>();
            foreach (var v in codeCache.Values) if (v.Value != null) list.Add(v.Value);
            string s = codeJson.Serialize(list);
            if (s == lastCode) return;
            if (lastCode == "") Program.Log("Code chats read from the Claude app: " + list.Count);
            lastCode = s;
            BeginInvoke(new Action(() => Post(new Dictionary<string, object> { { "tipo", "code" }, { "sessioni", list } })));
        }

        // {left, right, top, bottom} of the free part of Claude's top row in screen pixels, or null when it can't be
        // measured. Everything in the row is one batch of accessibility reads (CacheRequest), not one call per element.
        static int[] MeasureTopRow(AutomationElement doc)
        {
            var dr = doc.Current.BoundingRectangle;
            if (dr.IsEmpty || dr.Width < 400) return null;
            var cr = new CacheRequest();
            cr.Add(AutomationElement.BoundingRectangleProperty);
            cr.TreeScope = TreeScope.Element;
            AutomationElementCollection all;
            using (cr.Activate()) all = doc.FindAll(TreeScope.Descendants, System.Windows.Automation.Condition.TrueCondition);
            // The row's controls: small boxes starting near the page's top. Odd ones (a loading badge, a tooltip, a
            // menu) made the free space jump around, so only two unbroken groups count: the one that starts at the
            // left edge (menu, arrows, Chat/Code switch, chat title) and the one that ends at the right (panel icons).
            var boxes = new List<System.Windows.Rect>();
            foreach (AutomationElement e in all)
            {
                System.Windows.Rect r;
                try { r = e.Cached.BoundingRectangle; } catch { continue; }
                if (r.IsEmpty || r.Width < 8 || r.Height < 20) continue;
                if (r.Top < dr.Top || r.Top > dr.Top + 14 || r.Height > 56) continue;   // only the top row's controls
                if (r.Width > dr.Width * 0.3) continue;                                  // not a whole-row container
                boxes.Add(r);
            }
            if (boxes.Count < 4) return null;
            double gap = Math.Max(60, boxes[0].Height * 3);                             // up to ~3 buttons of empty space inside a group
            boxes.Sort((a, b) => a.Left.CompareTo(b.Left));
            double leftEdge = dr.Left;
            if (boxes[0].Left - dr.Left > gap) return null;
            foreach (var r in boxes) { if (r.Left > leftEdge + gap) break; leftEdge = Math.Max(leftEdge, r.Right); }
            boxes.Sort((a, b) => b.Right.CompareTo(a.Right));
            double rightEdge = boxes[0].Right;
            foreach (var r in boxes) { if (r.Right < rightEdge - gap) break; rightEdge = Math.Min(rightEdge, r.Left); }
            if (rightEdge <= leftEdge) return null;
            // the line of the buttons: the typical top and bottom, not the most extreme
            var tops = new List<double>(); var bottoms = new List<double>();
            foreach (var r in boxes) if (r.Height >= 28) { tops.Add(r.Top); bottoms.Add(r.Bottom); }
            if (tops.Count < 3) return null;
            tops.Sort(); bottoms.Sort();
            double top = tops[tops.Count / 2], bottom = bottoms[bottoms.Count / 2];
            // left, right of the free space; the page's top; the row buttons' bottom and top (the tabs copy them)
            return new[] { (int)leftEdge, (int)rightEdge, (int)dr.Top, (int)bottom, (int)top };
        }

        static readonly Regex CodeUrl = new Regex(@"^https://claude\.ai/epitaxy/(local_[A-Za-z0-9-]{8,80})(?:[/?#].*)?$");

        void OnClaudeShows(string name, string url)
        {
            string title = TitleTail.Replace(name, "").Trim();
            bool code = url.StartsWith("https://claude.ai/epitaxy/") || name.EndsWith(" - Claude Code");
            string link = "";
            var mu = OpenUrl.Match(url);
            if (mu.Success) link = "https://claude.ai/" + mu.Groups[1].Value + "/" + mu.Groups[2].Value;
            var mc = CodeUrl.Match(url);
            if (mc.Success) link = "claude://claude.ai/epitaxy/" + mc.Groups[1].Value; // same link the tabs use for Code chats
            if (link != quiLink || title != quiTitle || code != quiCode)
            {
                quiLink = link; quiTitle = title; quiCode = code;
                Post(new Dictionary<string, object> { { "tipo", "qui" }, { "link", link }, { "titolo", title }, { "code", code } });
            }
            if (link == "" || title == "" || Regex.IsMatch(title, @"^(claude|new chat)$", RegexOptions.IgnoreCase)) return;
            KeyValuePair<string, DateTime> before;
            if (marked.TryGetValue(link, out before) && before.Key == title && DateTime.Now - before.Value < TimeSpan.FromMinutes(5)) return;
            marked[link] = new KeyValuePair<string, DateTime>(title, DateTime.Now);
            MarkOpened(title, link, code ? "claude code" : "claude.ai");
        }

        async void MarkOpened(string title, string link, string kind)
        {
            if (web.CoreWebView2 == null) return;
            try
            {
                var body = json.Serialize(new Dictionary<string, object> {
                    { "titolo", title.Length > 80 ? title.Substring(0, 80) : title }, { "link", link }, { "tipo", kind } });
                var r = await HubCallWith(web.CoreWebView2, HttpMethod.Post, "/chat-aperta", body);
                if (r.Key == 200) Refresh(false);
                else Program.Log("chat-aperta: http " + r.Key);
            }
            catch (Exception ex) { Program.Log("chat-aperta: " + ex.Message); }
        }
    }

    // A normal window with the hub's login page: Ema types the Telegram code once, the cookie stays in the profile.
    class LoginForm : Form
    {
        readonly BarForm bar;
        readonly WebView2 web = new WebView2();
        readonly System.Windows.Forms.Timer check = new System.Windows.Forms.Timer();

        public LoginForm(BarForm bar)
        {
            this.bar = bar;
            Text = "Segretario Bar: log in to your Segretario";
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(620, 820);
            web.Dock = DockStyle.Fill;
            Controls.Add(web);
            check.Interval = 3000;
            check.Tick += async (s, e) => await CheckDone();
            Load += async (s, e) =>
            {
                double k = DeviceDpi / 96.0; // the process handles DPI itself, so sizes are real pixels
                Size = new Size((int)(560 * k), (int)(760 * k));
                CenterToScreen();
                try
                {
                    await web.EnsureCoreWebView2Async(bar.Env);
                    var c = web.CoreWebView2;
                    c.Settings.AreDevToolsEnabled = false;
                    c.NavigationStarting += (o, a) => { if (!a.Uri.StartsWith(BarForm.Hub + "/")) a.Cancel = true; };
                    c.NewWindowRequested += (o, a) => { a.Handled = true; };
                    c.NavigationCompleted += async (o, a) => await CheckDone();
                    c.Navigate(BarForm.Hub + "/");
                    check.Start();
                }
                catch (Exception ex) { Program.Log("login view: " + ex); Close(); }
            };
            FormClosed += (s, e) => check.Stop();
        }

        bool done;
        async Task CheckDone()
        {
            if (done || web.CoreWebView2 == null) return;
            try
            {
                var r = await bar.HubCallWith(web.CoreWebView2, HttpMethod.Get, "/chat-recenti.json?quante=1", null);
                if (r.Key == 200) { done = true; Program.Log("logged in"); Close(); }
            }
            catch { }
        }
    }
}
