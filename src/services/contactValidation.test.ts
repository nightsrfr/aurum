import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, normalizeUsPhone } from "./contactValidation.js";

test("normalizeUsPhone: accepts real 10-digit numbers in any common formatting, normalized to E.164", () => {
  assert.equal(normalizeUsPhone("2025551234"), "+12025551234");
  assert.equal(normalizeUsPhone("(202) 555-1234"), "+12025551234");
  assert.equal(normalizeUsPhone("202-555-1234"), "+12025551234");
  assert.equal(normalizeUsPhone("+1 202 555 1234"), "+12025551234");
  assert.equal(normalizeUsPhone("12025551234"), "+12025551234");
});

// The exact defect caught in testing: "555-0100" (7 digits, no area code at
// all) was previously accepted with no validation in place whatsoever.
test("normalizeUsPhone: rejects '555-0100' and the whole reserved-for-fiction 555-01XX range", () => {
  assert.equal(normalizeUsPhone("555-0100"), null);
  assert.equal(normalizeUsPhone("5550100"), null);
  assert.equal(normalizeUsPhone("2025550100"), null, "555-01XX is reserved regardless of area code");
  assert.equal(normalizeUsPhone("2025550199"), null);
  // A real 555 exchange OUTSIDE the reserved 0100-0199 line-number block is
  // fine — 555 itself isn't banned, only the fictional sub-range is.
  assert.equal(normalizeUsPhone("2025550234"), "+12025550234");
});

test("normalizeUsPhone: rejects the wrong digit count and obviously invalid area codes/exchanges", () => {
  assert.equal(normalizeUsPhone("12345"), null, "too short");
  assert.equal(normalizeUsPhone("123456789012"), null, "too long");
  assert.equal(normalizeUsPhone("0205551234"), null, "area code can't start with 0");
  assert.equal(normalizeUsPhone("1205551234"), null, "area code can't start with 1");
  assert.equal(normalizeUsPhone("2020551234"), null, "exchange can't start with 0");
  assert.equal(normalizeUsPhone(""), null);
  assert.equal(normalizeUsPhone(undefined), null);
  assert.equal(normalizeUsPhone(null), null);
});

test("normalizeEmail: accepts a plausible address, trimmed and lowercased", () => {
  assert.equal(normalizeEmail("  Guest@Example.COM "), "guest@example.com");
});

test("normalizeEmail: rejects obvious junk", () => {
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("missing-domain@"), null);
  assert.equal(normalizeEmail("@missing-local.com"), null);
  assert.equal(normalizeEmail("no-dot@example"), null);
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(undefined), null);
});
