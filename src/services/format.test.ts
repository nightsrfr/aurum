import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDateLong, formatMoney } from "./format.js";

test("formatMoney: two decimals, thousands-separated", () => {
  assert.equal(formatMoney(250000), "$2,500.00");
  assert.equal(formatMoney(65000), "$650.00");
  assert.equal(formatMoney(185000), "$1,850.00");
  assert.equal(formatMoney(0), "$0.00");
});

test("formatDateLong: 'YYYY-MM-DD' -> weekday, abbreviated month (Sept, not Sep), day", () => {
  // 2026-09-19 is a real Saturday — verified against a real calendar, not
  // assumed, since a bug here would render the WRONG weekday for every date
  // on the pay page and in booking confirmations.
  assert.equal(formatDateLong("2026-09-19"), "Saturday, Sept 19");
  assert.equal(formatDateLong("2026-01-01"), "Thursday, Jan 1");
  assert.equal(formatDateLong("2026-12-25"), "Friday, Dec 25");
});

test("formatDateLong: never shifts a day via UTC parsing (the new Date('YYYY-MM-DD') trap)", () => {
  // new Date("2026-09-19") parses as UTC midnight, which renders as Sept
  // 18th in any timezone behind UTC (e.g. America/New_York) — this function
  // must never go through that code path for a bare calendar date.
  assert.equal(formatDateLong("2026-09-19"), "Saturday, Sept 19");
});

test("formatDateLong: an unparseable input is returned verbatim rather than throwing", () => {
  assert.equal(formatDateLong("not-a-date"), "not-a-date");
});
