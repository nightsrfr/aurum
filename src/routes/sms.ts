import { Router } from "express";
import { runAgent } from "../agent/claude.js";
import { sendSms } from "../services/twilio.js";

export const smsRouter = Router();

/**
 * Twilio posts incoming SMS here as application/x-www-form-urlencoded
 * with `From` (the guest's number) and `Body` (the text they sent).
 *
 * This used to run the whole agent loop synchronously inside this handler
 * and return its reply as the TwiML response. That works fine for a quick
 * reply, but Twilio only waits ~15 seconds for a webhook to respond — and a
 * turn that needs several tool-calling round trips to the model (checking
 * availability, starting a booking, etc.), especially once a guest's
 * conversation history has grown long, can genuinely take longer than that.
 * When it does, Twilio times out and drops the reply entirely (logged on
 * their side as error 11200), even though the agent was still working and
 * would have finished a few seconds later.
 *
 * To fix that, this now acknowledges Twilio immediately with an empty
 * TwiML response (so there's nothing for it to ever time out on), then runs
 * the agent loop in the background and sends the real reply as a separate
 * outbound message via sendSms() once it's ready — the same mechanism
 * already used for staff replies and payment confirmations. A turn can now
 * take 2 seconds or 20 and the guest still always gets their reply.
 */
smsRouter.post("/webhook/sms", async (req, res) => {
  const from = req.body.From as string;
  const body = (req.body.Body as string) ?? "";

  console.log(`[SMS in <- ${from}]: ${body}`);

  // Acknowledge receipt right away — nothing here waits on the agent, so
  // Twilio's response-time window is never in play.
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);

  try {
    const reply = await runAgent(from, body);
    await sendSms(from, reply);
  } catch (err) {
    console.error("Agent error:", err);
    try {
      await sendSms(from, "Sorry, something went wrong on our end — we'll have someone follow up shortly.");
    } catch (smsErr) {
      console.error("Failed to send fallback SMS after agent error:", smsErr);
    }
  }
});
