# Segretario Bar

The "where was I" tabs, glued to the top of the Claude desktop app on Windows, in every chat (Chat and Code tabs).
Same bar as the claude.ai one in the Voce Chrome extension and the `segretario-tabs` Claude Code plugin:

- Chrome-style tabs: × closes one, drag to move, a click opens the chat, resting the mouse shows its card;
- a chat gets a tab (on the right) when you open it or when it starts waiting for you; **History** lists all;
- waiting for you = the tab flashes for 3 s, then stays orange until you open it (Code chats: read from the Claude app's own records in `%LOCALAPPDATA%Claude-Dataaude_*aude-code-sessions`);

The Claude app is a sealed Store package, so this is a small window of its own that follows the Claude window:
owned by it (moves, minimises and hides with it), cut to the shape of the tabs so clicks elsewhere reach Claude,
hands the keyboard straight back to Claude after a click. It reads which chat Claude shows (title and address only) through Windows
accessibility and tells the Segretario, exactly like the Chrome extension does on claude.ai.

The list comes from `hub.emazamboni.com/chat-recenti.json`, with the Telegram-code cookie of the bar's own
WebView2 profile (`%LOCALAPPDATA%\SegretarioBar`). The first start opens a login window for the code.

## Build and run

```powershell
.\build.ps1          # dist\SegretarioBar.exe, with the C# compiler that ships with Windows
```

It starts with Windows from the account's Run list (`HKCU\...\CurrentVersion\Run`, value `Segretario Bar`).
Right-click its tray icon for Refresh, Log in, Quit. `%LOCALAPPDATA%\SegretarioBar\bar.log` and `status.txt`
say what it is doing. `test\harness.html` shows the page with made-up chats in a browser (serve this folder).
