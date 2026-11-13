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

        // never take the focus away from Claude, and stay out of the taskbar and Alt+Tab
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x08000000 /*NOACTIVATE*/ | 0x00000080 /*TOOLWINDOW*/;
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
            return Asset("bar.html")
                .Replace("/*CSS*/", Asset("bar.css"))
                .Replace("/*NASCOSTA*/false", hidden ? "true" : "false")
                .Replace("/*JS*/", Asset("bar.js"));
        }

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
                        list.Add(new[] { Num(d["x"]), Num(d["y"]), Num(d["w"]), Num(d["h"]), d.ContainsKey("ledge") ? Num(d["ledge"]) : 0 });
                    }
                shape = list;
                open = m.ContainsKey("aperto") && m["aperto"] is bool && (bool)m["aperto"];
                pageReady = true;
                Follow();
            }
            else if (tipo == "lista") Refresh(false);
            else if (tipo == "login") ShowLogin();
            else if (tipo == "nascosta")
            {
                bool v = m.ContainsKey("valore") && m["valore"] is bool && (bool)m["valore"];
                try { File.WriteAllText(Path.Combine(Program.DataDir, "hidden.txt"), v ? "1" : "0"); } catch { }
            }
            else if (tipo == "apri") OpenChat(m.ContainsKey("link") ? Convert.ToString(m["link"]) : "");
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
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Exception ex) { Program.Log("open " + target + ": " + ex.Message); }
        }

        // ---------- the Claude window ----------
        static IntPtr FindClaude()
        {
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
                    " shown=" + shown + " placed=" + placed + " qui=" + quiTitle + " | " + quiLink + " | " + why);
            }
            catch { }
        }

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
            if (owner != claude) { Native.SetWindowLongPtr(Handle, -8 /*GWLP_HWNDPARENT*/, claude); owner = claude; }

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
            string shapeKey = json.Serialize(shape);
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

            // a click anywhere outside the tabs closes the open card or history, as on claude.ai
            bool down = (Native.GetAsyncKeyState(0x01) & 0x8000) != 0;
            if (down && !mouseWasDown && open)
            {
                Native.POINT p; Native.GetCursorPos(out p);
                if (!Inside(p.X - placed.X, p.Y - placed.Y, s)) Post(new Dictionary<string, object> { { "tipo", "fuori" } });
            }
            mouseWasDown = down;
        }

        bool Inside(int x, int y, double s)
        {
            foreach (var q in shape)
                if (x >= q[0] * s && x <= (q[0] + q[2]) * s && y >= q[1] * s && y <= (q[1] + q[3] + q[4]) * s) return true;
            return false;
        }

        void ApplyShape(double s)
        {
            IntPtr all = Native.CreateRectRgn(0, 0, 0, 0);
            int d = (int)Math.Round(24 * s); // 12 px corners
            foreach (var q in shape)
            {
                int l = (int)Math.Floor(q[0] * s), t = (int)Math.Floor(q[1] * s);
                int rr = (int)Math.Ceiling((q[0] + q[2]) * s), b = (int)Math.Ceiling((q[1] + q[3]) * s);
                int ledge = (int)Math.Round(q[4] * s);
                IntPtr one = Native.CreateRoundRectRgn(l, t, rr + 1, b + 1 + ledge, d, d);
                Native.CombineRgn(all, all, one, 2 /*RGN_OR*/);
                Native.DeleteObject(one);
            }
            Native.SetWindowRgn(Handle, all, true); // Windows owns the region from here
        }

        // ---------- which chat Claude shows: title + address, read through accessibility every 3 s ----------
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
                        var doc = root.FindFirst(TreeScope.Descendants, docCond);
                        if (doc != null)
                        {
                            string name = doc.Current.Name ?? "";
                            string url = "";
                            object vp;
                            if (doc.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) url = ((ValuePattern)vp).Current.Value ?? "";
                            BeginInvoke(new Action(() => OnClaudeShows(name, url)));
                        }
                    }
                }
                catch (Exception ex) { Program.Log("watch: " + ex.GetType().Name + " " + ex.Message); }
                Thread.Sleep(3000);
            }
        }

        void OnClaudeShows(string name, string url)
        {
            string title = TitleTail.Replace(name, "").Trim();
            bool code = url.StartsWith("https://claude.ai/epitaxy/") || name.EndsWith(" - Claude Code");
            string link = "";
            var mu = OpenUrl.Match(url);
            if (mu.Success) link = "https://claude.ai/" + mu.Groups[1].Value + "/" + mu.Groups[2].Value;
            if (link != quiLink || title != quiTitle || code != quiCode)
            {
                quiLink = link; quiTitle = title; quiCode = code;
                Post(new Dictionary<string, object> { { "tipo", "qui" }, { "link", link }, { "titolo", title }, { "code", code } });
            }
            if (link == "" || title == "" || Regex.IsMatch(title, @"^(claude|new chat)$", RegexOptions.IgnoreCase)) return;
            KeyValuePair<string, DateTime> before;
            if (marked.TryGetValue(link, out before) && before.Key == title && DateTime.Now - before.Value < TimeSpan.FromMinutes(5)) return;
            marked[link] = new KeyValuePair<string, DateTime>(title, DateTime.Now);
            MarkOpened(title, link);
        }

        async void MarkOpened(string title, string link)
        {
            if (web.CoreWebView2 == null) return;
            try
            {
                var body = json.Serialize(new Dictionary<string, object> {
                    { "titolo", title.Length > 80 ? title.Substring(0, 80) : title }, { "link", link }, { "tipo", "claude.ai" } });
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
