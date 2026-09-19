import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-tools-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";
// No STRIPE_SECRET_KEY — createPaymentLink() runs in demo mode, so
// start_booking never touches a real (or even test-mode) Stripe account.

const { runTool } = await import("./tools.js");
const { listTablesConfig, getBooking } = await import("../db.js");

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
