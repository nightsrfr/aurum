import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-tools-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";
// No STRIPE_SECRET_KEY — createPaymentLink() runs in demo mode, so
// start_booking never touches a real (or even test-mode) Stripe account.

const { runTool } = await import("./tools.js");
const { listTablesConfig, getBooking, createBooking } = await import("../db.js");

// WEB_SMS_OPT_IN is not set in this file, so it defaults to false — see
// tools-sms-confirmation.test.ts (a separate file/process, since this
// config value is read once at module load) for the WEB_SMS_OPT_IN=true
// path's validation/throttle behavior.
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

test("start_booking charges the table's deposit, not its full minimum spend, and records the minimum separately for display", async () => {
  const table = listTablesConfig()[0];
  assert.ok(table.deposit > 0 && table.deposit < table.min_spend, "fixture assumption: deposit should be less than the minimum");

  const result = await runTool(
    "start_booking",
    {
      date: "2026-12-31",
      party_size: 4,
      table_id: table.id,
      guest_name: "Test Guest",
      phone: "+15551234567",
    },
    "+15551234567"
  );

  assert.equal(result.success, true);
  assert.equal(result.min_spend_usd, table.min_spend);
  assert.equal(result.deposit_usd, table.deposit);
  assert.equal(result.balance_usd, table.min_spend - table.deposit);

  const booking = getBooking(result.booking_id);
  assert.ok(booking);
  // amount_cents is what's actually charged — must be the deposit, in
  // cents, never the full minimum.
  assert.equal(booking!.amount_cents, table.deposit * 100);
  assert.equal(booking!.min_spend_cents, table.min_spend * 100);
});

test("start_booking on the web channel works with no phone at all, falling back to the channel id as the placeholder", async () => {
  const table = listTablesConfig()[0];
  const channelId = `web:${randomUUID()}`;
  const result = await runTool(
    "start_booking",
    { date: "2026-12-31", party_size: 2, table_id: table.id, guest_name: "No Phone Guest" },
    channelId
  );
  assert.equal(result.success, true);
  const booking = getBooking(result.booking_id);
  assert.equal(booking!.phone, channelId, "no real phone was ever given — phone should fall back to the channel id placeholder");
});

test("get_table_options and check_availability both expose the deposit alongside the minimum, not just the minimum", async () => {
  const options = await runTool("get_table_options", {}, "+15551234567");
  assert.ok(options.tables.length > 0);
  for (const t of options.tables) {
    assert.equal(typeof t.deposit, "number");
    assert.ok(t.deposit > 0);
  }

  const availability = await runTool("check_availability", { date: "2026-12-31" }, "+15551234567");
  for (const r of availability.results) {
    assert.equal(typeof r.deposit, "number");
  }
});

test("set_confirmation_channel: channel 'email' with a valid address succeeds and is persisted on the booking", async () => {
  const { id } = makeTestBooking();
  const result = await runTool("set_confirmation_channel", { booking_id: id, channel: "email", contact: "Guest@Example.com" }, "web:x");
  assert.deepEqual(result, { success: true, channel: "email" });
  const booking = getBooking(id);
  assert.equal(booking!.confirmation_channel, "email");
  assert.equal(booking!.confirmation_contact, "guest@example.com");
});

test("set_confirmation_channel: channel 'email' with an invalid address fails and changes nothing on the booking", async () => {
  const { id } = makeTestBooking();
  const result = await runTool("set_confirmation_channel", { booking_id: id, channel: "email", contact: "not-an-email" }, "web:x");
  assert.equal(result.success, false);
  assert.equal(result.reason, "invalid_email");
  const booking = getBooking(id);
  assert.equal(booking!.confirmation_channel, null);
});

test("set_confirmation_channel: channel 'none' records chat_only", async () => {
  const { id } = makeTestBooking();
  const result = await runTool("set_confirmation_channel", { booking_id: id, channel: "none" }, "web:x");
  assert.deepEqual(result, { success: true, channel: "chat_only" });
  assert.equal(getBooking(id)!.confirmation_channel, "chat_only");
});

// WEB_SMS_OPT_IN defaults to false in this file (never set) — this is the
// exact "texting isn't offered yet" state the demo ships in until the
// venue's Twilio campaign update is approved. See
// tools-sms-confirmation.test.ts for the WEB_SMS_OPT_IN=true path.
test("set_confirmation_channel: channel 'sms' is refused outright while WEB_SMS_OPT_IN is false, regardless of the phone number given", async () => {
  const { id } = makeTestBooking();
  const result = await runTool("set_confirmation_channel", { booking_id: id, channel: "sms", contact: "+12025551234" }, "web:x");
  assert.equal(result.success, false);
  assert.equal(result.reason, "sms_not_offered");
  assert.equal(result.fallback, "chat_only");
  assert.equal(getBooking(id)!.confirmation_channel, "chat_only", "must still fall back to a safe, defined state");
});

test("set_confirmation_channel: an unknown booking id fails cleanly", async () => {
  const result = await runTool("set_confirmation_channel", { booking_id: "does-not-exist", channel: "none" }, "web:x");
  assert.deepEqual(result, { success: false, reason: "unknown_booking" });
});
