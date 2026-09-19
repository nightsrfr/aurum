import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// A separate file/process from tools.test.ts — same "config is read once at
// module load" reasoning already used throughout this repo (config.test.ts,
// stripeWebhook-configured.test.ts). WEB_SMS_OPT_IN=true here is the only
// way to exercise the actual SMS-consent validation/throttle path at all;
// tools.test.ts covers the (default) false path, where none of this can
// even be reached.
const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-sms-confirmation-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";
process.env.WEB_SMS_OPT_IN = "true";

const { runTool } = await import("./tools.js");
const { SMS_CONFIRMATION_DISCLOSURE } = await import("./guards.js");
const { createBooking, getBooking, db } = await import("../db.js");

function makeTestBooking(overrides: Partial<Parameters<typeof createBooking>[0]> = {}) {
  const id = randomUUID();
  const channelId = `web:${randomUUID()}`;
  createBooking({
    id,
    phone: channelId,
    guest_name: "Test Guest",
    date: "2026-12-31",
    party_size: 2,
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

test("set_confirmation_channel: channel 'sms' with a valid phone succeeds, normalizes to E.164, and records a consent row with the exact disclosure shown", async () => {
  const { id, channelId } = makeTestBooking();
  const result = await runTool(
    "set_confirmation_channel",
    { booking_id: id, channel: "sms", contact: "(202) 555-1234" },
    channelId,
    "203.0.113.1"
  );
  assert.deepEqual(result, { success: true, channel: "sms" });

  const booking = getBooking(id);
  assert.equal(booking!.confirmation_channel, "sms");
  assert.equal(booking!.confirmation_contact, "+12025551234");

  const consent = db
    .prepare(`SELECT * FROM sms_consents WHERE phone = ?`)
    .get("+12025551234") as { phone: string; channel_id: string; disclosure_text: string } | undefined;
  assert.ok(consent, "a consent row must be recorded the moment a text confirmation is actually accepted");
  assert.equal(consent!.channel_id, channelId);
  assert.equal(consent!.disclosure_text, SMS_CONFIRMATION_DISCLOSURE);
});

// The exact defect this whole validation layer exists to close.
test("set_confirmation_channel: channel 'sms' with '555-0100' is rejected as an invalid phone, and nothing is recorded", async () => {
  const { id } = makeTestBooking();
  const result = await runTool("set_confirmation_channel", { booking_id: id, channel: "sms", contact: "555-0100" }, "web:x", "203.0.113.2");
  assert.equal(result.success, false);
  assert.equal(result.reason, "invalid_phone");
  assert.equal(getBooking(id)!.confirmation_channel, null, "an invalid phone must not even fall back to chat_only — ask again instead");

  const consent = db.prepare(`SELECT COUNT(*) as c FROM sms_consents WHERE phone LIKE '%5550100%'`).get() as { c: number };
  assert.equal(consent.c, 0);
});

test("throttle: a second web-originated confirmation text to the SAME phone within 24h is refused and falls back to chat_only", async () => {
  const phone = "2025557001";
  const first = makeTestBooking();
  const firstResult = await runTool(
    "set_confirmation_channel",
    { booking_id: first.id, channel: "sms", contact: phone },
    first.channelId,
    "203.0.113.10"
  );
  assert.equal(firstResult.success, true);

  const second = makeTestBooking();
  const secondResult = await runTool(
    "set_confirmation_channel",
    { booking_id: second.id, channel: "sms", contact: phone },
    second.channelId,
    // Different IP too — proves this is the PHONE throttle catching it, not
    // the IP one, since a fresh IP would otherwise sail through.
    "203.0.113.11"
  );
  assert.equal(secondResult.success, false);
  assert.equal(secondResult.reason, "rate_limited");
  assert.equal(getBooking(second.id)!.confirmation_channel, "chat_only");
});

test("throttle: a 4th distinct phone number's confirmation text from the SAME IP within an hour is refused", async () => {
  const ip = "203.0.113.20";
  const phones = ["2025557101", "2025557102", "2025557103", "2025557104"];
  const results = [];
  for (const phone of phones) {
    const booking = makeTestBooking();
    results.push(await runTool("set_confirmation_channel", { booking_id: booking.id, channel: "sms", contact: phone }, booking.channelId, ip));
  }
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, true);
  assert.equal(results[2].success, true);
  assert.equal(results[3].success, false, "the 4th distinct phone from the same IP within the hour should be throttled");
  assert.equal(results[3].reason, "rate_limited");
});
