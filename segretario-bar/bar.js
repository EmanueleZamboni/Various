/* Segretario Bar (13/11/2026): the "where was I" tabs glued to the top of the Claude desktop app.
   Same behaviour as the claude.ai bar (voce-chrome/schede.js): 6 tabs with the most recent chats (claude.ai and
   Claude Code) and projects from the Segretario, an arrow for 4 more, History for all of them, an orange dot on what
   is waiting for Ema; a tab opens a card with the last step, the next step, Claude's question and an Open button.
   This page never talks to the network: the program around it (SegretarioBar.cs) fetches the list with the
   Telegram-code cookie and opens chats in the Claude app. Messages go both ways through chrome.webview. */
(() => {
  const TABS = 6, MORE = 4;
  // open = the card pinned by a click (chats with no link), peek = the card shown while the mouse rests on a tab
  const st = { items: [], err: "", open: "", peek: "", more: 0, hidden: !!window.SEG_NASCOSTA, qui: { link: "", titolo: "", code: false } };
  const host = window.chrome && window.chrome.webview;
  const manda = (m) => { try { host.postMessage(m); } catch (_) {} };

  const chiave = (x) => x.link || `${x.tipo}:${x.titolo}`;
  const corta = (v, n) => (v.length > n ? v.slice(0, n - 1) + "…" : v);
  const tipo = (x) => (x.tipo === "claude code" ? "Code" : x.tipo === "progetto" ? "Project" : "Chat");
  const sotto = (x) => (x.progetto && x.progetto !== x.titolo ? " · " + x.progetto : "");
  const eQui = (x) => (!!x.link && x.link === st.qui.link) || (st.qui.code && x.tipo === "claude code" && !!x.titolo && x.titolo === st.qui.titolo);
  function quando(v) {
    if (!v) return "";
    const roma = (d) => d.toLocaleString("sv-SE", { timeZone: "Europe/Rome", hour12: false }).slice(0, 10);
    const oggi = roma(new Date()), ieri = roma(new Date(Date.now() - 864e5));
    if (v.startsWith(oggi)) return v.slice(11, 16);
    if (v.startsWith(ieri)) return "yesterday";
    return `${v.slice(8, 10)}/${v.slice(5, 7)}`;
  }

  const root = document.createElement("div");
  root.id = "seg-schede";
  const el = (tag, cls, testo) => { const n = document.createElement(tag); if (cls) n.className = cls; if (testo != null) n.textContent = testo; return n; };

  function bottone(testo, cls, fn, titolo) {
    const b = el("button", cls, testo);
    b.type = "button";
    if (titolo) b.title = titolo;
    b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); disegna(); manda({ tipo: "fatto" }); });
    return b;
  }

  // a click goes straight to the chat; a chat with no link yet opens its card instead
  function vai(x) {
    if (x.link && !eQui(x)) { manda({ tipo: "apri", link: x.link }); st.open = ""; st.peek = ""; st.more = 0; }
    else st.open = st.open === chiave(x) ? "" : chiave(x);
  }

  // resting the mouse on a tab for a moment shows its card; it goes away when the mouse leaves tab and card
  let timerPeek = 0;
  function sbircia(n, x) {
    n.addEventListener("mouseenter", () => { clearTimeout(timerPeek); timerPeek = setTimeout(() => { if (st.peek !== chiave(x)) { st.peek = chiave(x); disegna(); } }, 350); });
    n.addEventListener("mouseleave", lascia);
  }
  function lascia() {
    clearTimeout(timerPeek);
    timerPeek = setTimeout(() => { if (st.peek) { st.peek = ""; disegna(); } }, 300);
  }

  function scheda(x) {
    const k = chiave(x);
    const b = bottone("", (k === st.open || k === st.peek ? "sel " : "") + (eQui(x) ? "qui" : ""), () => vai(x),
      x.link ? (eQui(x) ? "You are here" : "Open this chat") : "Show what this chat is doing");
    if (x.aspetta) b.appendChild(el("span", "punto"));
    b.appendChild(document.createTextNode(corta(x.titolo || "(untitled)", 22)));
    sbircia(b, x);
    return b;
  }

  function nascondi(si) {
    st.hidden = si; st.open = ""; st.more = 0;
    manda({ tipo: "nascosta", valore: si });
  }

  function disegna() {
    root.replaceChildren();
    const riga = el("div", "riga");
    const attese = st.items.filter((x) => x.aspetta).length;
    if (st.hidden) {
      const b = bottone("", "quiet", () => nascondi(false), "Show the recent chats");
      if (attese) b.appendChild(el("span", "punto"));
      b.appendChild(document.createTextNode(`Recent chats${attese ? ` · ${attese} waiting` : ""}`));
      riga.appendChild(b);
      root.appendChild(riga);
      return forma();
    }
    if (st.err && !st.items.length) {
      if (st.err === "login") {
        riga.append(el("span", "avviso", "Recent chats: log in to your Segretario once."),
          bottone("Log in", "", () => manda({ tipo: "login" })));
      } else riga.appendChild(el("span", "avviso", `Recent chats: can't reach the Segretario (${st.err})`));
      riga.appendChild(bottone("Hide", "quiet", () => nascondi(true)));
      root.appendChild(riga);
      return forma();
    }
    if (!st.items.length) { riga.appendChild(el("span", "avviso", "Recent chats: loading…")); root.appendChild(riga); return forma(); }
    st.items.slice(0, TABS).forEach((x) => riga.appendChild(scheda(x)));
    if (st.more === 1) st.items.slice(TABS, TABS + MORE).forEach((x) => riga.appendChild(scheda(x)));
    if (st.items.length > TABS) riga.appendChild(bottone(st.more === 1 ? "‹" : "›", "freccia", () => { st.more = st.more === 1 ? 0 : 1; }, st.more === 1 ? "Fewer" : "4 more"));
    riga.appendChild(bottone(st.more === 2 ? "Close history" : "History", "quiet", () => { st.more = st.more === 2 ? 0 : 2; st.open = ""; }));
    riga.appendChild(bottone("Hide", "quiet", () => nascondi(true)));
    root.appendChild(riga);

    if (st.more === 2) {
      const s = el("div", "storia");
      st.items.forEach((x) => {
        const b = bottone("", "", () => { st.more = 0; st.open = ""; vai(x); });
        const dot = el("span", x.aspetta ? "punto" : ""); if (!x.aspetta) dot.style.width = "13px";
        b.append(dot, el("span", "q", quando(x.quando)), el("span", "t", x.titolo || "(untitled)"), el("span", "k", tipo(x) + sotto(x)));
        s.appendChild(b);
      });
      root.appendChild(s);
    }

    const sel = st.items.find((x) => chiave(x) === (st.peek || st.open));
    if (sel) {
      const c = el("div", "scheda");
      c.addEventListener("mouseenter", () => clearTimeout(timerPeek));
      c.addEventListener("mouseleave", lascia);
      const t = el("div", "titolo", sel.titolo || "(untitled)");
      const stato = sel.aspetta ? "waiting for you" : sel.in_corso ? "working now" : sel.stato || "opened";
      t.appendChild(el("span", "meta", `${tipo(sel)}${sotto(sel)} · ${stato}${sel.quando ? " · " + quando(sel.quando) : ""}`));
      c.appendChild(t);
      if (sel.dove_sono) c.appendChild(el("p", "", "Last: " + corta(sel.dove_sono, 300)));
      if (sel.prossimo) c.appendChild(el("p", "", "Next: " + corta(sel.prossimo, 300)));
      if (sel.domanda) c.appendChild(el("p", "domanda", "Claude asks you: " + corta(sel.domanda, 240)));
      if (!sel.dove_sono && !sel.prossimo) c.appendChild(el("p", "meta", "This chat hasn't written its progress to the Segretario yet."));
      if (eQui(sel)) c.appendChild(el("span", "qui-testo", "You are here"));
      else if (sel.link) c.appendChild(bottone("Open this chat", "apri", () => vai(sel)));
      else c.appendChild(el("p", "meta", "No link to open yet: it gets one the next time you open this chat."));
      root.appendChild(c);
    }
    forma();
  }

  // tells the program which parts of the window to keep: everything else is cut away and clicks go to Claude.
  // setTimeout, not requestAnimationFrame: the window starts hidden, and a hidden page never paints a frame.
  let ultima = "";
  function forma() {
    setTimeout(() => {
      const rects = [];
      root.querySelectorAll(":scope > .riga, :scope > .storia, :scope > .scheda").forEach((n) => {
        const r = n.getBoundingClientRect();
        rects.push({ x: r.left, y: r.top, w: r.width, h: r.height, ledge: n.classList.contains("riga") ? 3 : 0 });
      });
      const m = { tipo: "forma", rects, aperto: !!st.open || st.more === 2 };
      const s = JSON.stringify(m);
      if (s !== ultima) { ultima = s; manda(m); }
    }, 0);
  }

  if (host) host.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.tipo === "lista") {
      if (m.dati && Array.isArray(m.dati.chat)) { st.items = m.dati.chat; st.err = ""; }
      else st.err = /401/.test(m.errore || "") ? "login" : String(m.errore || "error").slice(0, 80);
      if (st.open && !st.items.some((x) => chiave(x) === st.open)) st.open = "";
    } else if (m.tipo === "qui") {
      st.qui = { link: String(m.link || ""), titolo: String(m.titolo || ""), code: !!m.code };
    } else if (m.tipo === "fuori") {
      if (!st.open && st.more !== 2) return;
      st.open = ""; if (st.more === 2) st.more = 0;
    } else return;
    disegna();
  });

  document.body.appendChild(root);
  new ResizeObserver(() => { ultima = ""; forma(); }).observe(root);
  disegna();
  manda({ tipo: "lista" });
  setInterval(() => manda({ tipo: "lista" }), 60000);
})();
