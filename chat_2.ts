import { Router } from "express";
import { runAgent } from "../agent/claude.js";
import { loadConversation } from "../db.js";

export const chatRouter = Router();

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

  const channelId = `web:${sessionId}`;

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
  const history = loadConversation(channelId);

  const messages = history
    .map((m) => {
      if (m.role === "user") {
        // A real guest message is a plain string. Tool-result turns are
        // arrays of tool_result blocks fed back to Claude — not something
        // the widget should ever display.
        if (typeof m.content === "string" && m.content.trim()) {
          return { role: "user" as const, text: m.content };
        }
        return null;
      }
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const text = (m.content as any[])
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n")
          .trim();
        // Assistant turns that were pure tool calls (e.g. checking
        // availability) have no visible text — skip those.
        return text ? { role: "assistant" as const, text } : null;
      }
      return null;
    })
    .filter((m): m is { role: "user" | "assistant"; text: string } => m !== null);

  res.json({ messages });
});
