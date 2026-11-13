/* Segretario Bar (13/11/2026): Chrome-style tabs glued to the top of the Claude desktop app.
   - Tabs stay where they are. × closes one. Drag a tab to move it. A click opens the chat; resting the mouse on a tab
     shows its card (last step, next step, Claude's question).
   - A chat gets a tab (at the right end, like Chrome) when you open it, or when it starts waiting for you.
   - Waiting for you: the tab flashes for 3 seconds, then stays orange until you open the chat.
     Code chats: Claude finished a turn after you last looked at the chat (the Claude app's own records, read by
     SegretarioBar.cs). Other chats: the chat told the Segretario it waits for you, after you last opened it.
   - History lists every recent chat, newest first.
   Data: the list from the Segretario ("lista") and the Code chats from the Claude app ("code"), both handed in by
   SegretarioBar.cs through chrome.webview; this page never talks to the network. Tab layout is saved by the program
   (tabs.json) through "salva". */
(() => {
  // as many tabs as fit at a readable width (about 118 px each, after the History and Hide buttons); the rest go under ›
  const VISIBLE = () => Math.max(2, Math.min(12, Math.floor((window.innerWidth - 190) / 118)));
  const T0 = Date.now();
  const FLASH_MS = 3000;
  const host = window.chrome && window.chrome.webview;
  const manda = (m) => { try { host.postMessage(m); } catch (_) {} };

  // T is what survives a restart: the tabs, their order, what was closed, what was seen
  const T = Object.assign({ order: [], snap: {}, closed: {}, seen: {}, waiting: [], init: false }, window.SEG_TABS || {});
  const st = { items: [], code: {}, err: "", open: "", peek: "", more: 0, hidden: !!window.SEG_NASCOSTA,
    qui: { link: "", titolo: "", code: false }, flash: {}, drag: null, ready: { lista: false, code: false } };
  let prevWaiting = new Set(T.waiting);

  const chiave = (x) => x.link || `${x.tipo}:${x.titolo}`;
  const corta = (v, n) => (v.length > n ? v.slice(0, n - 1) + "…" : v);
  const tipo = (x) => (x.tipo === "claude code" ? "Code" : x.tipo === "progetto" ? "Project" : "Chat");
  const sotto = (x) => (x.progetto && x.progetto !== x.titolo ? " · " + x.progetto : "");
  const roma = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Rome", hour12: false }).slice(0, 16);
  const ms = (q) => { const t = Date.parse(String(q || "").replace(" ", "T")); return isNaN(t) ? 0 : t; };
  const eQui = (x) => (!!x.link && x.link === st.qui.link) || (st.qui.code && x.tipo === "claude code" && !!x.titolo && x.titolo === st.qui.titolo);
  function quando(v) {
    if (!v) return "";
    const oggi = roma(Date.now()).slice(0, 10), ieri = roma(Date.now() - 864e5).slice(0, 10);
    if (v.startsWith(oggi)) return v.slice(11, 16);
    if (v.startsWith(ieri)) return "yesterday";
    return `${v.slice(8, 10)}/${v.slice(5, 7)}`;
  }

  // the Segretario's list plus the Claude app's Code chats, one entry per chat, newest first
  let tutte = [], perChiave = new Map();
  function unisci() {
    const m = new Map();
    st.items.forEach((x) => m.set(chiave(x), Object.assign({}, x)));
    Object.values(st.code).forEach((c) => {
      const old = m.get(c.link);
      const x = old || { tipo: "claude code", titolo: c.titolo, link: c.link, progetto: "", stato: "", aspetta: false,
        dove_sono: "", prossimo: "", domanda: "", quando: "", in_corso: false };
      x.titolo = c.titolo || x.titolo;               // the name you gave it in the app wins
      x.quando = [x.quando, roma(c.activity)].sort().pop();
      x.in_corso = c.running;
      if (!x.dove_sono && c.detail) x.dove_sono = c.detail;
      x.code = c;
      m.set(c.link, x);
    });
    tutte = [...m.values()].sort((a, b) => (b.quando || "").localeCompare(a.quando || ""));
    perChiave = new Map(tutte.map((x) => [chiave(x), x]));
  }

  function aspetta(x) {
    const seen = T.seen[chiave(x)] || 0;
    if (x.code) return x.code.turnEnd > 0 && x.code.turnEnd > Math.max(x.code.focused, seen) && !x.code.running;
    return !!x.aspetta && ms(x.quando) > seen;
  }

  // tabs follow what happens: a chat you open, or one that starts waiting for you, gets a tab
  let salvaTimer = 0;
  function salva() { clearTimeout(salvaTimer); salvaTimer = setTimeout(() => manda({ tipo: "salva", stato: T }), 800); }
  function apriScheda(k) {
    if (T.order.includes(k)) return false;
    T.order.push(k); delete T.closed[k]; return true;
  }
  function aggiornaSchede() {
    unisci();
    if (!st.ready.lista) return;
    // the very first tabs wait for the Code chats too (or 4 s, if the Claude app sends none)
    if (!T.init && !st.ready.code && Date.now() - T0 < 4000) { setTimeout(() => { aggiornaSchede(); disegna(); }, 4100 - (Date.now() - T0)); return; }
    let cambiato = false;
    if (!T.init) {
      T.order = tutte.slice(0, 6).map(chiave); T.init = true;
      T.waiting = tutte.filter(aspetta).map(chiave).sort(); prevWaiting = new Set(T.waiting); // no flash for what already waited
      cambiato = true;
    }
    const ora = new Set();
    tutte.forEach((x) => {
      const k = chiave(x);
      if (eQui(x)) { T.seen[k] = Date.now(); if (apriScheda(k)) cambiato = true; }
      if (aspetta(x)) {
        ora.add(k);
        if (!prevWaiting.has(k)) { st.flash[k] = Date.now() + FLASH_MS; if (apriScheda(k)) cambiato = true; setTimeout(disegna, FLASH_MS + 50); }
      }
    });
    const lista = [...ora].sort();
    if (lista.join("|") !== [...prevWaiting].sort().join("|")) { T.waiting = lista; cambiato = true; }
    prevWaiting = ora;
    T.order.forEach((k) => { const x = perChiave.get(k); if (x) T.snap[k] = { titolo: x.titolo, link: x.link, tipo: x.tipo, progetto: x.progetto }; });
    Object.keys(T.snap).forEach((k) => { if (!T.order.includes(k)) delete T.snap[k]; });
    if (cambiato) salva();
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
    T.seen[chiave(x)] = Date.now(); salva();
    if (x.link && !eQui(x)) { manda({ tipo: "apri", link: x.link }); st.open = ""; st.peek = ""; st.more = 0; }
    else st.open = st.open === chiave(x) ? "" : chiave(x);
  }
  function chiudi(k) {
    T.order = T.order.filter((v) => v !== k); T.closed[k] = Date.now(); delete T.snap[k];
    if (st.open === k) st.open = ""; if (st.peek === k) st.peek = "";
    salva();
  }

  // resting the mouse on a tab for a moment shows its card; it goes away when the mouse leaves tab and card
  let timerPeek = 0;
  function sbircia(n, k) {
    n.addEventListener("mouseenter", () => { clearTimeout(timerPeek); if (st.drag) return; timerPeek = setTimeout(() => { if (!st.drag && st.peek !== k) { st.peek = k; disegna(); } }, 400); });
    n.addEventListener("mouseleave", lascia);
  }
  function lascia() { clearTimeout(timerPeek); timerPeek = setTimeout(() => { if (st.peek) { st.peek = ""; disegna(); } }, 300); }

  function voce(k) { return perChiave.get(k) || Object.assign({ aspetta: false, quando: "" }, T.snap[k] || { titolo: k }); }

  function scheda(k, i) {
    const x = voce(k);
    const w = perChiave.has(k) && aspetta(x);
    const cls = ["tab"];
    if (k === st.open || k === st.peek) cls.push("sel");
    if (eQui(x)) cls.push("qui");
    if (w) cls.push("attesa");
    if ((st.flash[k] || 0) > Date.now()) cls.push("lampo");
    const t = el("div", cls.join(" "));
    t.setAttribute("role", "tab");
    t.tabIndex = 0;
    t.title = (x.link ? (eQui(x) ? "You are here" : "Open this chat") : "Show what this chat is doing") + " · " + tipo(x) + sotto(x);
    if (w) t.appendChild(el("span", "punto"));
    t.appendChild(el("span", "nome", x.titolo || "(untitled)"));
    const x2 = el("button", "chiudi", "×");
    x2.type = "button"; x2.title = "Close tab";
    x2.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    x2.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); chiudi(k); disegna(); manda({ tipo: "fatto" }); });
    t.appendChild(x2);
    t.addEventListener("pointerdown", (ev) => inizioTrascina(ev, t, k, i));
    t.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); vai(x); disegna(); } });
    sbircia(t, k);
    return t;
  }

  // ---- drag a tab to move it: the others slide aside, the order is saved on release ----
  function inizioTrascina(ev, t, k, i) {
    if (ev.button !== 0) return;
    const tabs = [...root.querySelectorAll(".riga .tab")];
    st.drag = { k, i, x0: ev.clientX, mosso: false, tabs, rects: tabs.map((n) => n.getBoundingClientRect()), to: i, el: t };
    t.setPointerCapture(ev.pointerId);
    t.addEventListener("pointermove", muovi);
    t.addEventListener("pointerup", fine, { once: true });
    t.addEventListener("pointercancel", fine, { once: true });
  }
  function muovi(ev) {
    const d = st.drag; if (!d) return;
    const dx = ev.clientX - d.x0;
    if (!d.mosso && Math.abs(dx) < 6) return;
    if (!d.mosso) { d.mosso = true; st.peek = ""; clearTimeout(timerPeek); d.el.classList.add("trascina"); }
    const r = d.rects[d.i], first = d.rects[0], last = d.rects[d.rects.length - 1];
    const lim = Math.max(first.left - r.left, Math.min(last.right - r.right, dx));
    d.el.style.transform = `translateX(${lim}px)`;
    const centro = r.left + r.width / 2 + lim;
    let to = 0;
    d.rects.forEach((q, j) => { if (j !== d.i && q.left + q.width / 2 < centro) to++; });
    d.to = to;
    const passo = r.width + 3;
    d.tabs.forEach((n, j) => {
      if (j === d.i) return;
      const s = d.i < j && j <= to ? -passo : to <= j && j < d.i ? passo : 0;
      n.style.transform = s ? `translateX(${s}px)` : "";
    });
  }
  function fine() {
    const d = st.drag; st.drag = null; if (!d) return;
    d.el.removeEventListener("pointermove", muovi);
    if (!d.mosso) { const x = voce(d.k); vai(x); disegna(); manda({ tipo: "fatto" }); return; }
    const vis = T.order.slice(0, VISIBLE());
    const [m] = vis.splice(d.i, 1); vis.splice(d.to, 0, m);
    T.order = vis.concat(T.order.slice(VISIBLE()));
    salva(); disegna(); manda({ tipo: "fatto" });
  }

  function nascondi(si) { st.hidden = si; st.open = ""; st.peek = ""; st.more = 0; manda({ tipo: "nascosta", valore: si }); }

  function disegna() {
    if (st.drag) return;                 // never redraw under a tab being dragged
    root.replaceChildren();
    const riga = el("div", "riga");
    const attese = tutte.filter(aspetta).length;
    if (st.hidden) {
      const b = bottone("", "quiet", () => nascondi(false), "Show the tabs");
      if (attese) b.appendChild(el("span", "punto"));
      b.appendChild(document.createTextNode(`Recent chats${attese ? ` · ${attese} waiting` : ""}`));
      riga.appendChild(b); root.appendChild(riga);
      return forma();
    }
    if (st.err && !st.ready.lista) {
      if (st.err === "login") riga.append(el("span", "avviso", "Recent chats: log in to your Segretario once."), bottone("Log in", "", () => manda({ tipo: "login" })));
      else riga.appendChild(el("span", "avviso", `Recent chats: can't reach the Segretario (${st.err})`));
      riga.appendChild(bottone("Hide", "quiet", () => nascondi(true)));
      root.appendChild(riga);
      return forma();
    }
    if (!st.ready.lista) { riga.appendChild(el("span", "avviso", "Recent chats: loading…")); root.appendChild(riga); return forma(); }

    const n = VISIBLE(), vis = T.order.slice(0, n), resto = T.order.slice(n);
    const tabs = el("div", "tabs");
    vis.forEach((k, i) => tabs.appendChild(scheda(k, i)));
    if (!vis.length) tabs.appendChild(el("span", "avviso", "No tabs: open a chat, or pick one in History"));
    riga.appendChild(tabs);
    if (resto.length) riga.appendChild(bottone(st.more === 1 ? "‹" : `› ${resto.length}`, "freccia", () => { st.more = st.more === 1 ? 0 : 1; st.open = ""; }, st.more === 1 ? "Close" : "More tabs"));
    riga.appendChild(bottone(st.more === 2 ? "Close history" : "History", "quiet", () => { st.more = st.more === 2 ? 0 : 2; st.open = ""; }));
    riga.appendChild(bottone("Hide", "quiet", () => nascondi(true)));
    root.appendChild(riga);

    if (st.more === 1 || st.more === 2) {
      const s = el("div", "storia");
      const lista = st.more === 1 ? resto.map(voce) : tutte;
      lista.forEach((x) => {
        const b = bottone("", "", () => { st.more = 0; st.open = ""; apriScheda(chiave(x)); vai(x); salva(); });
        const w = perChiave.has(chiave(x)) && aspetta(x);
        const dot = el("span", w ? "punto" : ""); if (!w) dot.style.width = "13px";
        b.append(dot, el("span", "q", quando(x.quando)), el("span", "t", x.titolo || "(untitled)"), el("span", "k", tipo(x) + sotto(x)));
        s.appendChild(b);
      });
      root.appendChild(s);
    }

    const sel = perChiave.get(st.peek || st.open) || (st.peek || st.open ? voce(st.peek || st.open) : null);
    if (sel) {
      const c = el("div", "scheda");
      c.addEventListener("mouseenter", () => clearTimeout(timerPeek));
      c.addEventListener("mouseleave", lascia);
      const t = el("div", "titolo", sel.titolo || "(untitled)");
      const w = perChiave.has(chiave(sel)) && aspetta(sel);
      const stato = w ? "waiting for you" : sel.in_corso ? "working now" : sel.stato || "opened";
      t.appendChild(el("span", "meta", `${tipo(sel)}${sotto(sel)} · ${stato}${sel.quando ? " · " + quando(sel.quando) : ""}`));
      c.appendChild(t);
      if (sel.dove_sono) c.appendChild(el("p", "", "Last: " + corta(sel.dove_sono, 300)));
      if (sel.prossimo) c.appendChild(el("p", "", "Next: " + corta(sel.prossimo, 300)));
      if (sel.domanda) c.appendChild(el("p", "domanda", "Claude asks you: " + corta(sel.domanda, 240)));
      if (!sel.dove_sono && !sel.prossimo) c.appendChild(el("p", "meta", "This chat hasn't written its progress yet."));
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
        // the strip has square bottom corners (it sits on Claude's page); the cards are rounded all round
        // (docked in Claude's top row it is square all round)
        const riga = n.classList.contains("riga");
        rects.push({ x: r.left, y: r.top, w: r.width, h: r.height, ledge: 0, top: riga ? (root.classList.contains("docked") ? 2 : 1) : 0 });
      });
      const m = { tipo: "forma", rects, aperto: !!st.open || st.more !== 0 };
      const s = JSON.stringify(m);
      if (s !== ultima) { ultima = s; manda(m); }
    }, 0);
  }

  if (host) host.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.tipo === "lista") {
      if (m.dati && Array.isArray(m.dati.chat)) { st.items = m.dati.chat; st.err = ""; st.ready.lista = true; }
      else st.err = /401/.test(m.errore || "") ? "login" : String(m.errore || "error").slice(0, 80);
    } else if (m.tipo === "code") {
      const c = {};
      (m.sessioni || []).forEach((s) => { if (s && s.link) c[s.link] = s; });
      st.code = c; st.ready.code = true;
    } else if (m.tipo === "qui") {
      st.qui = { link: String(m.link || ""), titolo: String(m.titolo || ""), code: !!m.code };
    } else if (m.tipo === "sfondo") {
      // Claude's page colour under the bar: the open tab takes it, and light/dark follows it
      const c = String(m.colore || "");
      if (!/^#[0-9a-f]{6}$/i.test(c)) return;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
      const scuro = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
      root.style.setProperty("--merge", c);
      root.style.setProperty("--merge-ink", scuro ? "#F1F0EC" : "#16161A");
      root.dataset.tema = scuro ? "dark" : "light";
      // docked: the strip takes the colour of Claude's own top row, so only the tabs show
      if (/^#[0-9a-f]{6}$/i.test(String(m.fila || ""))) root.style.setProperty("--strip", m.fila);
      else root.style.removeProperty("--strip");
      return;
    } else if (m.tipo === "modo") {
      root.classList.toggle("docked", !!m.docked);
      if (m.alto > 0) root.style.setProperty("--alto", m.alto + "px");
      ultima = ""; forma();
      return;
    } else if (m.tipo === "fuori") {
      if (!st.open && st.more === 0) return;
      st.open = ""; st.more = 0;
    } else return;
    aggiornaSchede();
    disegna();
  });

  document.body.appendChild(root);
  new ResizeObserver(() => { ultima = ""; forma(); }).observe(root);
  let largo = window.innerWidth;   // the Claude window got wider or narrower: redo how many tabs fit
  window.addEventListener("resize", () => { if (Math.abs(window.innerWidth - largo) > 40) { largo = window.innerWidth; disegna(); } });
  disegna();
  manda({ tipo: "lista" });
  setInterval(() => manda({ tipo: "lista" }), 60000);
})();
