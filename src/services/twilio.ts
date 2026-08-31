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
  // Prefer sending via the Messaging Service (required for A2P 10DLC
  // compliance on a registered US long code — sending from the bare number
  // once it's out of that service's Sender Pool triggers error 30034). Fall
  // back to the raw from-number for setups that never needed a Messaging
  // Service in the first place.
  await client.messages.create(
    config.twilio.messagingServiceSid
      ? { to, messagingServiceSid: config.twilio.messagingServiceSid, body }
      : { to, from: config.twilio.fromNumber, body }
  );
}
