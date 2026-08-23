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
  function getSessionId() {
    try {
      var existing = window.localStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      var fresh =
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : "sess-" + Math.random().toString(36).slice(2) + Date.now();
      window.localStorage.setItem(SESSION_KEY, fresh);
      return fresh;
    } catch (e) {
      // localStorage unavailable (private mode, etc.) — fall back to an
      // in-memory id that lasts for this page view only.
      return "sess-" + Math.random().toString(36).slice(2) + Date.now();
    }
  }
  var sessionId = getSessionId();

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
    ".textRow input{flex:1;border:1px solid #ddd;border-radius:20px;padding:9px 14px;" +
    "font-size:13.5px;outline:none;}" +
    ".textRow input:focus{border-color:" + ACCENT + ";}" +
    ".sendBtn{background:" + ACCENT + ";color:#fff;border:none;border-radius:20px;" +
    "padding:0 16px;font-size:13.5px;font-weight:600;cursor:pointer;}" +
    ".sendBtn:disabled{opacity:0.5;cursor:default;}" +
    ".smsFallback{margin-top:8px;font-size:11.5px;color:#888;text-align:center;}" +
    ".smsFallback a{color:" + ACCENT + ";text-decoration:none;font-weight:600;}";
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
      a.href = url;
      // Every link the bot currently sends is a payment link, so a short,
      // friendly label reads much better than a raw 60-character URL in a
      // chat bubble. Revisit this if other link types get added later.
      a.textContent = "Pay here →";
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

  var opened = false;
  function openPanel() {
    panel.classList.remove("hidden");
    if (!opened) {
      opened = true;
      addMessage(
        "bot",
        "Hey! Want to grab a VIP table? Tell me the date and party size you're thinking and I'll take it from there."
      );
      input.focus();
    }
  }
  function closePanel() {
    panel.classList.add("hidden");
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
})();
