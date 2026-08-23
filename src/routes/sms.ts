import { Router } from "express";
import { runAgent } from "../agent/claude.js";

export const smsRouter = Router();

/**
 * Twilio posts incoming SMS here as application/x-www-form-urlencoded
 * with `From` (the guest's number) and `Body` (the text they sent).
 * We reply synchronously with TwiML so Twilio sends the reply back as a
 * text in the same thread.
 */
smsRouter.post("/webhook/sms", async (req, res) => {
  const from = req.body.From as string;
  const body = (req.body.Body as string) ?? "";

  console.log(`[SMS in <- ${from}]: ${body}`);

  let reply: string;
  try {
    reply = await runAgent(from, body);
  } catch (err) {
    console.error("Agent error:", err);
    reply = "Sorry, something went wrong on our end — we'll have someone follow up shortly.";
  }

  const escaped = reply
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`
  );
});
