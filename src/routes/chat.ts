import { Router } from "express";
import { runAgent } from "../agent/claude.js";

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
