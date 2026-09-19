import { Router } from "express";
import twilio from "twilio";
import { config } from "../config.js";
import { runAgent } from "../agent/claude.js";
import { sendSms } from "../services/twilio.js";
import { loadConversation } from "../db.js";
import { isMessageTooLong, tryStartSmsConversation, TOO_LONG_MESSAGE, RATE_LIMITED_MESSAGE } from "../agent/guards.js";

export const smsRouter = Router();

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

/**
 * Confirms this request actually came from Twilio, not anyone who found
 * the webhook URL. Twilio signs every webhook request with the account's
 * auth token — `twilio.validateRequest` recomputes that signature from the
 * exact URL Twilio would have POSTed to plus the parsed form body, and a
 * mismatch means either the request is forged or BASE_URL/the URL Twilio
 * has configured have drifted apart (a real request would then be
 * indistinguishable from a forged one, which is exactly why this fails
 * closed rather than warning and continuing).
 */
function isGenuineTwilioRequest(req: import("express").Request): boolean {
  if (!config.twilio.authToken) return false;
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;
  const url = `${config.baseUrl}${req.originalUrl}`;
  return twilio.validateRequest(config.twilio.authToken, signature, url, req.body as Record<string, string>);
}

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
  if (!isGenuineTwilioRequest(req)) {
    console.error("Rejected /webhook/sms request with an invalid or missing X-Twilio-Signature.");
    return res.status(403).send("Invalid signature");
  }

  const from = req.body.From as string;
  const body = (req.body.Body as string) ?? "";

  console.log(`[SMS in <- ${from}]: ${body}`);

  // Acknowledge receipt right away — nothing here waits on the agent, so
  // Twilio's response-time window is never in play.
  res.type("text/xml").send(EMPTY_TWIML);

  if (isMessageTooLong(body)) {
    await sendSms(from, TOO_LONG_MESSAGE).catch((err) => console.error("Failed to send too-long SMS reply:", err));
    return;
  }

  const isNewConversation = loadConversation(from).length === 0;
  if (isNewConversation && !tryStartSmsConversation(from)) {
    await sendSms(from, RATE_LIMITED_MESSAGE).catch((err) => console.error("Failed to send rate-limit SMS reply:", err));
    return;
  }

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
