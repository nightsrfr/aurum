import { Router } from "express";
import cors from "cors";
import { config } from "../config.js";
import { runAgent } from "../agent/claude.js";
import { getConversationTranscript, loadConversation } from "../db.js";
import { subscribe } from "../services/liveUpdates.js";
import { isMessageTooLong, tryStartWebConversation, TOO_LONG_MESSAGE, RATE_LIMITED_MESSAGE } from "../agent/guards.js";

export const chatRouter = Router();

// Scoped to just this router's routes (not applied globally in server.ts)
// so the Twilio/Stripe webhooks — server-to-server calls with no Origin
// header, unaffected by CORS either way — are never accidentally coupled
// to this allowlist. Browsers preflight cross-origin requests against
// whatever origin list this reports; a non-browser client (curl, a
// script) ignores CORS entirely, so this is a defense against a hostile
// third-party site quietly draining the demo's daily model-call budget
// through a visitor's own browser, not a hard security boundary on its own.
chatRouter.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all (curl, server-to-server, same-origin) —
      // let it through; this isn't the layer that's supposed to stop that.
      if (!origin) return callback(null, true);
      if (config.allowedChatOrigins.includes(origin)) return callback(null, true);
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
  })
);

/**
 * Backend for the website chat widget. The widget generates a random
 * session id per browser (stored in localStorage) and sends it with every
 * message. We prefix it with "web:" before handing it to the same
 * runAgent() the SMS channel uses, so web sessions and real phone numbers
 * never collide in the conversations/bookings tables, while reusing all
 * the same tools, system prompt, and booking/payment logic.
 */
chatRouter.post("/api/chat", async (req, res) => {
  const sessionId = req.body?.sessionId as string | undefined;
  const message = req.body?.message as string | undefined;

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing sessionId" });
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Missing message" });
  }
  if (isMessageTooLong(message)) {
    return res.status(400).json({ reply: TOO_LONG_MESSAGE });
  }

  const channelId = `web:${sessionId}`;

  // Rate-limit only the START of a new conversation (no history yet) —
  // an already-started conversation's later messages are never blocked
  // here, same reasoning as the guest concierge's own turn cap: someone
  // mid-conversation isn't the abuse pattern this guards against.
  const isNewConversation = loadConversation(channelId).length === 0;
  if (isNewConversation && !tryStartWebConversation(req.ip ?? "unknown")) {
    return res.status(429).json({ reply: RATE_LIMITED_MESSAGE });
  }

  try {
    const reply = await runAgent(channelId, message.trim());
    res.json({ reply });
  } catch (err) {
    console.error("Widget chat agent error:", err);
    res.status(500).json({
      reply: "Sorry, something went wrong on our end — please try again in a moment.",
    });
  }
});

/**
 * Lets the widget rebuild its chat history after a full page load — the
 * guest navigating from the homepage to the menu page, or from a payment
 * link to the payment-confirmation page, should still see the same
 * conversation rather than a blank chat window. Only plain guest/bot text
 * is returned; tool_use/tool_result blocks are internal plumbing the widget
 * never needs to render.
 */
chatRouter.get("/api/chat/history", (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing sessionId" });
  }

  const channelId = `web:${sessionId}`;
  res.json({ messages: getConversationTranscript(channelId) });
});

/**
 * Server-Sent-Events stream the widget keeps open for as long as its page
 * is loaded. The only thing ever pushed down it is a staff "jump in" reply
 * sent from the admin console (see routes/admin.ts) — normal bot replies
 * already reach the widget directly as the response to its own /api/chat
 * POST, so they don't need this. This is what makes a staff reply show up
 * in an already-open guest chat window instantly instead of only on the
 * next page load.
 */
chatRouter.get("/api/chat/stream", (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing sessionId" });
  }
  const channelId = `web:${sessionId}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("\n");

  const unsubscribe = subscribe(channelId, res);

  // Some hosts/proxies (Render included) close idle connections after
  // ~55-100s of silence. A comment line every 25s resets that clock without
  // EventSource treating it as a real message.
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
