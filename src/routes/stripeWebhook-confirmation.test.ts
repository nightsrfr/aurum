import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// A separate file/process from stripeWebhook.test.ts/-configured.test.ts —
// same "config is read once at module load" reasoning already documented
// there. This file never sets TWILIO_*/RESEND_API_KEY, so sendSms/sendEmail
// both stay in their own demo-mode console.log fallback — no real network
// call anywhere in this file, same discipline as every other test here.
const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-confirmbooking-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";

const { confirmBooking } = await import("./stripeWebhook.js");
const { createBooking, getConversationTranscript } = await import("../db.js");

type ConsoleCall = { text: string };

function captureConsoleLog(t: any): ConsoleCall[] {
  const calls: ConsoleCall[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    calls.push({ text: args.map(String).join(" ") });
  });
  return calls;
}

function makeWebBooking(overrides: Partial<Parameters<typeof createBooking>[0]> = {}) {
  const id = randomUUID();
  const channelId = `web:${randomUUID()}`;
  createBooking({
    id,
    phone: channelId,
    guest_name: "Test Guest",
    date: "2026-12-31",
    party_size: 4,
    table_id: "booth-b",
    amount_cents: 50000,
    min_spend_cents: 200000,
    status: "pending_payment",
    payment_url: null,
    stripe_session_id: null,
    channel_id: channelId,
    confirmation_channel: null,
    confirmation_contact: null,
    ...overrides,
  });
  return { id, channelId };
}

test("web booking, confirmation_channel 'sms': sends exactly one demo SMS, ending with the required opt-out line", async (t) => {
  const calls = captureConsoleLog(t);
  const { id, channelId } = makeWebBooking({
    confirmation_channel: "sms",
    confirmation_contact: "+15551234567",
  });

  await confirmBooking(id);

  const smsLines = calls.filter((c) => c.text.includes("[DEMO SMS -> +15551234567]"));
  assert.equal(smsLines.length, 1, "exactly one SMS should be sent for a web sms-confirmation booking");
  const emailLines = calls.filter((c) => c.text.includes("[DEMO EMAIL"));
  assert.equal(emailLines.length, 0, "no email should be sent when the guest chose text");

  const smsBody = calls.map((c) => c.text).join("\n");
  assert.match(smsBody, /Reply STOP to opt out\./);

  const transcript = getConversationTranscript(channelId);
  assert.ok(transcript.some((m) => m.text.includes("Payment received")));
});

test("web booking, confirmation_channel 'email': sends exactly one demo email, never an SMS", async (t) => {
  const calls = captureConsoleLog(t);
  const { id } = makeWebBooking({
    confirmation_channel: "email",
    confirmation_contact: "guest@example.com",
  });

  await confirmBooking(id);

  const emailLines = calls.filter((c) => c.text.includes("[DEMO EMAIL -> guest@example.com]"));
  assert.equal(emailLines.length, 1);
  const smsLines = calls.filter((c) => c.text.includes("[DEMO SMS"));
  assert.equal(smsLines.length, 0, "no SMS should be sent when the guest chose email");
});

test("web booking with no confirmation channel (declined both / never answered): sends neither SMS nor email — chat only", async (t) => {
  const calls = captureConsoleLog(t);
  const { id, channelId } = makeWebBooking({ confirmation_channel: null, confirmation_contact: null });

  await confirmBooking(id);

  assert.equal(calls.filter((c) => c.text.includes("[DEMO SMS")).length, 0);
  assert.equal(calls.filter((c) => c.text.includes("[DEMO EMAIL")).length, 0);
  const transcript = getConversationTranscript(channelId);
  assert.ok(transcript.some((m) => m.text.includes("Payment received")), "the chat message is still the confirmation");
});

test("web booking with confirmation_channel 'chat_only' (declined explicitly / throttled): also sends neither", async (t) => {
  const calls = captureConsoleLog(t);
  const { id } = makeWebBooking({ confirmation_channel: "chat_only", confirmation_contact: null });

  await confirmBooking(id);

  assert.equal(calls.filter((c) => c.text.includes("[DEMO SMS")).length, 0);
  assert.equal(calls.filter((c) => c.text.includes("[DEMO EMAIL")).length, 0);
});

test("SMS-channel booking (not web) still always texts, unaffected by confirmation_channel", async (t) => {
  const calls = captureConsoleLog(t);
  const id = randomUUID();
  const realPhone = "+15559998888";
  createBooking({
    id,
    phone: realPhone,
    guest_name: "Text Guest",
    date: "2026-12-31",
    party_size: 2,
    table_id: "booth-b",
    amount_cents: 50000,
    min_spend_cents: 200000,
    status: "pending_payment",
    payment_url: null,
    stripe_session_id: null,
    channel_id: realPhone,
    confirmation_channel: null, // never set for a real SMS-channel booking
    confirmation_contact: null,
  });

  await confirmBooking(id);

  const smsLines = calls.filter((c) => c.text.includes(`[DEMO SMS -> ${realPhone}]`));
  assert.equal(smsLines.length, 1, "an SMS-channel booking must keep texting exactly as it always has");
});
