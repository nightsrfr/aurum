import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-db-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";

const {
  defaultDepositForMinSpend,
  listTablesConfig,
  getVenueSettings,
  incrementDailyModelCallCount,
  getDailyModelCallCount,
  upsertTableConfig,
} = await import("./db.js");

test("defaultDepositForMinSpend: 25% of the minimum, rounded to the nearest $50", () => {
  assert.equal(defaultDepositForMinSpend(2000), 500); // the exact example from the build instruction
  assert.equal(defaultDepositForMinSpend(500), 150);
  assert.equal(defaultDepositForMinSpend(1200), 300);
  assert.equal(defaultDepositForMinSpend(2500), 650);
  assert.equal(defaultDepositForMinSpend(5000), 1250);
});

test("a fresh database seeds every table with a real, non-zero deposit derived from its own minimum", () => {
  const tables = listTablesConfig();
  assert.ok(tables.length > 0);
  for (const t of tables) {
    assert.equal(typeof t.deposit, "number");
    assert.ok(t.deposit > 0, `${t.id} should have a positive deposit, got ${t.deposit}`);
    assert.equal(t.deposit, defaultDepositForMinSpend(t.min_spend));
  }
});

test("paymentPolicy and cancellationPolicy no longer describe charging the full minimum spend", () => {
  const settings = getVenueSettings();
  assert.match(settings.paymentPolicy, /deposit/i);
  assert.doesNotMatch(settings.paymentPolicy, /charged in full/i);
  assert.match(settings.cancellationPolicy, /deposit/i);
});

test("upsertTableConfig persists a real, editable deposit value", () => {
  upsertTableConfig({
    id: "test-table",
    name: "Test Table",
    capacity: 8,
    min_spend: 1000,
    deposit: 250,
    description: "a table for testing",
    sort_order: 99,
  });
  const table = listTablesConfig().find((t) => t.id === "test-table");
  assert.ok(table);
  assert.equal(table!.deposit, 250);
});

test("incrementDailyModelCallCount persists across calls and getDailyModelCallCount reads it back without incrementing", () => {
  const before = getDailyModelCallCount();
  const after1 = incrementDailyModelCallCount();
  assert.equal(after1, before + 1);
  const peeked = getDailyModelCallCount();
  assert.equal(peeked, after1); // peeking never increments
  const after2 = incrementDailyModelCallCount();
  assert.equal(after2, after1 + 1);
});
