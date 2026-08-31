/**
 * Nightsrfr VIP table booking widget.
 *
 * Embed with a single script tag on the venue's website:
 *
 *   <script
 *     src="https://YOUR-RENDER-URL.onrender.com/widget.js"
 *     data-api-base="https://YOUR-RENDER-URL.onrender.com"
 *     data-phone="+12028758563"
 *     data-venue-name="The Venue"
 *   ></script>
 *
 * data-api-base: required. Your deployed backend's base URL (no trailing slash).
 * data-phone: optional. Shown as a "prefer to text?" fallback link.
 * data-venue-name: optional. Shown in the chat header. Defaults to "Book a Table".
 * data-accent-color: optional. Hex color for the launcher/buttons. Defaults to "#c81845".
 *
 * This file is intentionally dependency-free vanilla JS so it can be
 * dropped into any website regardless of what framework (or none) that
 * site uses. All markup/styles live inside a Shadow DOM so they can't
 * collide with the host site's CSS.
 *
 * Session lifetime: the chat session id lives in sessionStorage, not
 * localStorage — so it lasts for as long as this tab stays open (surviving
 * normal page navigation within it), but closing the tab ends that chat for
 * good. Reopening the site later starts a brand new conversation; the old
 * one is untouched and still fully visible in the admin console, it's just
 * not resumed. The one deliberate exception: a link the bot itself sends
 * (the payment page, the menu page) carries the current session id forward
 * as a URL parameter, so clicking through to one of those — even though it
 * opens in a new tab — still lands in the same conversation, since that's
 * the guest continuing this chat on purpose rather than starting a new visit.
 */
(function () {
  var scriptEl = document.currentScript;
  if (!scriptEl) return;

  var API_BASE = (scriptEl.dataset.apiBase || "").replace(/\/$/, "");
  var PHONE = scriptEl.dataset.phone || "";
  var VENUE_NAME = scriptEl.dataset.venueName || "Book a Table";
  var ACCENT = scriptEl.dataset.accentColor || "#c81845";

  if (!API_BASE) {
    console.error("[nightsrfr-widget] Missing required data-api-base attribute.");
    return;
  }

  var SESSION_KEY = "nightsrfr_widget_session_id";
  // A link the bot sends (payment/menu page) puts the session id here so the
  // new tab it opens in can pick up the SAME conversation on purpose, rather
  // than being treated as a fresh visit. See getSessionId() below.
  var SESSION_PARAM = "nsrfr_chat";

  function freshSessionId() {
    return window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : "sess-" + Math.random().toString(36).slice(2) + Date.now();
  }

  function getSessionId() {
    // 1. Continuing an existing conversation via a link the bot sent —
    //    honor that even though it's a new tab, and scrub the id out of the
    //    visible URL so it doesn't linger if the guest bookmarks/shares it.
    try {
      var url = new URL(window.location.href);
      var fromLink = url.searchParams.get(SESSION_PARAM);
      if (fromLink) {
        window.sessionStorage.setItem(SESSION_KEY, fromLink);
        url.searchParams.delete(SESSION_PARAM);
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
        return fromLink;
      }
    } catch (e) {
      // URL/history APIs unavailable for some reason — fall through.
    }

    // 2. This tab's own session. sessionStorage (not localStorage) is what
    //    makes closing the tab end the chat: it survives page navigation
    //    within this tab, but the browser wipes it the moment the tab
    //    closes, so a later visit in a new tab starts a fresh conversation.
    try {
      var existing = window.sessionStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      var fresh = freshSessionId();
      window.sessionStorage.setItem(SESSION_KEY, fresh);
      return fresh;
    } catch (e) {
      // sessionStorage unavailable (private mode, etc.) — fall back to an
      // in-memory id that lasts for this page view only.
      return freshSessionId();
    }
  }
  var sessionId = getSessionId();

  // Appends this tab's session id onto a same-origin link before rendering
  // it as clickable — see the SESSION_PARAM comment above. Left untouched
  // for any link that isn't pointed at our own backend.
  function withSessionParam(url) {
    try {
      var u = new URL(url, window.location.href);
      if (u.origin === new URL(API_BASE).origin) {
        u.searchParams.set(SESSION_PARAM, sessionId);
      }
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  // Whether the guest had the chat panel open is also persisted, purely so
  // that navigating to another page on the same site within this same tab
  // (menu, payment, confirmation) reopens the panel automatically instead
  // of guests having to re-find and re-click the launcher every time.
  var OPEN_KEY = "nightsrfr_widget_open";
  function isPanelOpenStored() {
    try {
      return window.sessionStorage.getItem(OPEN_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  function setPanelOpenStored(isOpen) {
    try {
      if (isOpen) window.sessionStorage.setItem(OPEN_KEY, "1");
      else window.sessionStorage.removeItem(OPEN_KEY);
    } catch (e) {
      // Ignore — worst case the panel just doesn't auto-reopen on the next page.
    }
  }

  // ---- Build host element + shadow root ----------------------------------
  var host = document.createElement("div");
  host.id = "nightsrfr-widget-host";
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");
  style.textContent =
    ":host{all:initial;}" +
    "*{box-sizing:border-box;font-family:-apple-system,Segoe UI,Arial,sans-serif;}" +
    ".launcher{position:fixed;bottom:20px;right:20px;z-index:2147483000;" +
    "background:" + ACCENT + ";color:#fff;border:none;border-radius:999px;" +
    "padding:14px 20px;font-size:15px;font-weight:600;cursor:pointer;" +
    "box-shadow:0 8px 24px rgba(0,0,0,0.25);display:flex;align-items:center;gap:8px;}" +
    ".launcher:hover{filter:brightness(1.08);}" +
    ".launcher.hidden{display:none;}" +
    ".launcher.hasUnread::after{content:'';position:absolute;top:-2px;right:-2px;" +
    "width:12px;height:12px;border-radius:50%;background:#ff3b30;border:2px solid #fff;}" +
    ".panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 32px);" +
    "height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;" +
    "box-shadow:0 16px 48px rgba(0,0,0,0.3);display:flex;flex-direction:column;overflow:hidden;" +
    "z-index:2147483000;}" +
    ".panel.hidden{display:none;}" +
    ".header{background:" + ACCENT + ";color:#fff;padding:14px 16px;display:flex;" +
    "align-items:center;justify-content:space-between;}" +
    ".header h2{font-size:15px;margin:0;font-weight:700;}" +
    ".header p{font-size:12px;margin:2px 0 0;opacity:0.85;}" +
    ".closeBtn{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;" +
    "line-height:1;padding:0 4px;}" +
    ".messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;" +
    "background:#faf9f8;}" +
    ".msg{max-width:80%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.45;" +
    "white-space:pre-wrap;word-wrap:break-word;}" +
    ".msg.bot{align-self:flex-start;background:#eee;color:#222;border-bottom-left-radius:4px;}" +
    ".msg.user{align-self:flex-end;background:" + ACCENT + ";color:#fff;border-bottom-right-radius:4px;}" +
    ".msg.typing{align-self:flex-start;background:#eee;color:#888;font-style:italic;}" +
    ".footer{border-top:1px solid #eee;padding:10px;}" +
    ".textRow{display:flex;gap:8px;}" +
    // 16px is deliberate, not a style choice: any input under 16px makes iOS
    // Safari auto-zoom the whole page in when the guest taps it, which is
    // what threw the fixed-position panel out of alignment with the
    // keyboard/toolbar in the screenshots.
    ".textRow input{flex:1;border:1px solid #ddd;border-radius:20px;padding:9px 14px;" +
    "font-size:16px;outline:none;}" +
    ".textRow input:focus{border-color:" + ACCENT + ";}" +
    ".sendBtn{background:" + ACCENT + ";color:#fff;border:none;border-radius:20px;" +
    "padding:0 16px;font-size:13.5px;font-weight:600;cursor:pointer;}" +
    ".sendBtn:disabled{opacity:0.5;cursor:default;}" +
    ".smsFallback{margin-top:8px;font-size:11.5px;color:#888;text-align:center;}" +
    ".smsFallback a{color:" + ACCENT + ";text-decoration:none;font-weight:600;}" +
    // On phones a small floating card is cramped and, combined with the
    // on-screen keyboard, is what was overlapping the browser's own UI in
    // the screenshots. Below 480px the panel instead takes over the full
    // screen like a standard mobile chat sheet; JS sets an explicit inline
    // height (see syncPanelHeight below) so it tracks the visual viewport
    // instead of the keyboard shoving it around. This block is placed last
    // so its rules win the cascade over the base .panel/.header/.footer
    // rules above wherever they overlap (e.g. padding shorthand).
    "@media (max-width:480px){" +
    ".panel{left:0;right:0;bottom:0;top:0;width:100%;max-width:100%;" +
    "height:100%;max-height:none;border-radius:0;}" +
    ".header{padding-top:calc(14px + env(safe-area-inset-top));}" +
    ".footer{padding-bottom:calc(10px + env(safe-area-inset-bottom));}" +
    "}";
  shadow.appendChild(style);

  var launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.type = "button";
  launcher.textContent = "💬 Book a Table";
  shadow.appendChild(launcher);

  var panel = document.createElement("div");
  panel.className = "panel hidden";
  panel.innerHTML =
    '<div class="header">' +
    "<div><h2>" + escapeHtml(VENUE_NAME) + "</h2><p>Usually replies in seconds</p></div>" +
    '<button class="closeBtn" type="button" aria-label="Close">&times;</button>' +
    "</div>" +
    '<div class="messages"></div>' +
    '<div class="footer">' +
    '<div class="textRow">' +
    '<input type="text" placeholder="Type a message..." />' +
    '<button class="sendBtn" type="button">Send</button>' +
    "</div>" +
    (PHONE
      ? '<div class="smsFallback">Prefer to text? <a href="sms:' +
        encodeURIComponent(PHONE) +
        '">Text ' +
        escapeHtml(PHONE) +
        "</a></div>"
      : "") +
    "</div>";
  shadow.appendChild(panel);

  var messagesEl = panel.querySelector(".messages");
  var input = panel.querySelector("input");
  var sendBtn = panel.querySelector(".sendBtn");
  var closeBtn = panel.querySelector(".closeBtn");

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Picks the button label for a link the bot sends, based on what kind of
  // link it is. Everything the bot currently sends is either a payment link
  // or the bottle-menu link, so this only needs to tell those two apart —
  // add more patterns here if new link types get added later.
  function labelForLink(url) {
    if (/\/menu(\.html)?(\?|#|$)/i.test(url)) return "View Menu →";
    return "Pay here →";
  }

  // Renders text into an element with any http(s) URLs turned into real,
  // clickable links — built with DOM nodes (never innerHTML on guest/bot
  // text) so this stays safe from script injection either direction.
  function renderWithLinks(el, text) {
    var re = /(https?:\/\/\S+)/g;
    var lastIndex = 0;
    var match;
    while ((match = re.exec(text)) !== null) {
      var url = match[0];
      var trailing = "";
      while (url.length > 0 && /[.,!?;:'")\]]/.test(url[url.length - 1])) {
        trailing = url[url.length - 1] + trailing;
        url = url.slice(0, -1);
      }
      if (match.index > lastIndex) {
        el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var a = document.createElement("a");
      a.href = withSessionParam(url);
      a.textContent = labelForLink(url);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.color = "inherit";
      a.style.fontWeight = "700";
      a.style.textDecoration = "underline";
      el.appendChild(a);
      if (trailing) el.appendChild(document.createTextNode(trailing));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      el.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function addMessage(role, text) {
    var el = document.createElement("div");
    el.className = "msg " + role;
    renderWithLinks(el, text);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  // Becomes true once the panel has real content in it — either restored
  // history or the one-time greeting — so we never show the greeting twice.
  var opened = false;

  function showGreeting() {
    opened = true;
    addMessage(
      "bot",
      "Hey! Want to grab a VIP table? Tell me the date and party size you're thinking and I'll take it from there."
    );
  }

  // On phones the panel goes full-screen (see the max-width:480px rule
  // above), so the launcher pill behind it serves no purpose while open —
  // leaving it visible is what was peeking out from behind/under the panel
  // in the screenshots. Hide it whenever the panel is open, on any size.
  var isMobile = window.matchMedia && window.matchMedia("(max-width:480px)").matches;

  // iOS/Android don't shrink `100vh`/fixed elements to make room for the
  // on-screen keyboard — the panel just gets covered instead. When the
  // visualViewport API is available, pin the panel's actual height to it so
  // the footer (input + send button) always stays above the keyboard.
  function syncPanelHeight() {
    if (!isMobile || panel.classList.contains("hidden")) return;
    if (window.visualViewport) {
      panel.style.height = window.visualViewport.height + "px";
    }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncPanelHeight);
  }

  // Remembers the page's own scroll lock state so closePanel() only ever
  // restores what openPanel() itself changed.
  var bodyOverflowBeforeOpen = "";

  function openPanel() {
    panel.classList.remove("hidden");
    launcher.classList.add("hidden");
    launcher.classList.remove("hasUnread");
    setPanelOpenStored(true);
    if (!opened) showGreeting();
    syncPanelHeight();

    if (isMobile) {
      // The full-screen mobile panel is position:fixed, top:0 — but iOS
      // Safari positions "fixed" relative to the layout viewport, not
      // what's actually on screen. If the guest had scrolled the page
      // (or the address bar hadn't collapsed yet) the instant the panel
      // opened, the panel could render below the visible area, so it
      // looked like the tap did nothing until you scrolled to find it.
      // Snapping to the top first, and locking background scroll while
      // the panel is open, keeps the panel's fixed position aligned with
      // what's actually visible.
      window.scrollTo(0, 0);
      bodyOverflowBeforeOpen = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      // Also defer focusing the input: focusing immediately pops the
      // keyboard while the browser is still settling the scroll/address
      // bar from the line above, which is exactly the kind of mid-layout
      // shift that made the panel appear to jump off-screen. Giving it a
      // beat lets that settle first.
      setTimeout(function () { input.focus(); }, 300);
    } else {
      input.focus();
    }
  }
  function closePanel() {
    panel.classList.add("hidden");
    launcher.classList.remove("hidden");
    setPanelOpenStored(false);
    panel.style.height = "";
    if (isMobile) {
      document.body.style.overflow = bodyOverflowBeforeOpen;
    }
  }

  launcher.addEventListener("click", function () {
    if (panel.classList.contains("hidden")) openPanel();
    else closePanel();
  });
  closeBtn.addEventListener("click", closePanel);

  var sending = false;
  function send() {
    var text = input.value.trim();
    if (!text || sending) return;
    addMessage("user", text);
    input.value = "";
    sending = true;
    sendBtn.disabled = true;
    var typingEl = addMessage("typing", "Typing...");

    fetch(API_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId, message: text }),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        typingEl.remove();
        addMessage("bot", data.reply || "Sorry, I didn't catch that — could you try again?");
      })
      .catch(function () {
        typingEl.remove();
        addMessage("bot", "Sorry, something went wrong reaching us — please try again in a moment.");
      })
      .finally(function () {
        sending = false;
        sendBtn.disabled = false;
        input.focus();
      });
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") send();
  });

  // ---- Restore conversation across page loads -----------------------------
  // Runs once on every page this widget is embedded on. If this browser
  // already has a conversation for this session (e.g. the guest started
  // chatting on the homepage and then clicked through to the menu page, or
  // followed a payment link that landed on our own confirmation page), we
  // repaint that history here instead of starting over. If the panel was
  // left open, it's reopened automatically too.
  function restoreFromServer() {
    fetch(API_BASE + "/api/chat/history?sessionId=" + encodeURIComponent(sessionId))
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        var messages = (data && data.messages) || [];
        if (messages.length > 0) {
          opened = true;
          messages.forEach(function (m) {
            addMessage(m.role === "user" ? "user" : "bot", m.text);
          });
        }
        if (isPanelOpenStored()) {
          panel.classList.remove("hidden");
          launcher.classList.add("hidden");
          if (!opened) showGreeting();
          syncPanelHeight();
          // Same full-screen scroll lock as openPanel() below — this path
          // reopens the chat automatically after a same-site navigation
          // (e.g. index.html -> menu.html mid-conversation), so it needs
          // the same treatment or the guest could scroll the page behind
          // a "full screen" chat that isn't actually locking it in place.
          if (isMobile) {
            bodyOverflowBeforeOpen = document.body.style.overflow;
            document.body.style.overflow = "hidden";
          }
        }
      })
      .catch(function () {
        // If the history fetch fails (offline, cold start, etc.), still
        // honor a previously-open panel rather than leaving the guest
        // stranded — they'll just see a fresh greeting instead of history.
        if (isPanelOpenStored()) {
          panel.classList.remove("hidden");
          launcher.classList.add("hidden");
          if (!opened) showGreeting();
          syncPanelHeight();
          // Same full-screen scroll lock as openPanel() below — this path
          // reopens the chat automatically after a same-site navigation
          // (e.g. index.html -> menu.html mid-conversation), so it needs
          // the same treatment or the guest could scroll the page behind
          // a "full screen" chat that isn't actually locking it in place.
          if (isMobile) {
            bodyOverflowBeforeOpen = document.body.style.overflow;
            document.body.style.overflow = "hidden";
          }
        }
      });
  }
  restoreFromServer();

  // ---- Live staff messages -------------------------------------------------
  // Keeps a Server-Sent-Events connection open for as long as this page is
  // loaded. The only thing that ever arrives here is a staff "jump in"
  // reply sent from the admin console — normal bot replies already arrive
  // as the direct response to this widget's own /api/chat call, so they
  // don't go through this. This is what makes a staff reply show up in an
  // already-open chat window immediately instead of only on next reload.
  // If EventSource isn't supported, or the connection drops, the guest
  // still gets the message the next time this page loads (restoreFromServer
  // above), so this is a pure enhancement, not a dependency.
  if (window.EventSource) {
    var stream = new EventSource(
      API_BASE + "/api/chat/stream?sessionId=" + encodeURIComponent(sessionId)
    );
    stream.onmessage = function (evt) {
      if (!evt.data) return;
      var msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (e) {
        return;
      }
      if (!msg || typeof msg.text !== "string") return;
      opened = true;
      addMessage("bot", msg.text);
      if (panel.classList.contains("hidden")) {
        launcher.classList.add("hasUnread");
      }
    };
    // EventSource reconnects automatically on its own after a dropped
    // connection (browser-native behavior) — nothing else needed here.
  }
})();
