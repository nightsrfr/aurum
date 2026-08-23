import twilio from "twilio";
import { config } from "../config.js";

const client = config.twilioEnabled
  ? twilio(config.twilio.accountSid, config.twilio.authToken)
  : null;

/**
 * Sends an outbound SMS. If Twilio credentials aren't configured yet, this
 * just logs to the console so you can test the full flow (including
 * out-of-band payment confirmations) before you have a Twilio account.
 */
export async function sendSms(to: string, body: string): Promise<void> {
  if (!client) {
    console.log(`\n[DEMO SMS -> ${to}]\n${body}\n`);
    return;
  }
  await client.messages.create({
    to,
    from: config.twilio.fromNumber,
    body,
  });
}
