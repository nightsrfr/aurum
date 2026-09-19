import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-guards-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";
process.env.DEMO_DAILY_MODEL_CALLS = "3";

const {
  isMessageTooLong,
  countRealUserTurns,
  hasReachedTurnCap,
  tryConsumeDailyModelCall,
  tryStartWebConversation,
  tryStartSmsConversation,
  __resetRateLimitsForTests,
} = await import("./guards.js");

test("isMessageTooLong: the 800-character cap, checked at the boundary", () => {
  assert.equal(isMessageTooLong("a".repeat(800)), false);
  assert.equal(isMessageTooLong("a".repeat(801)), true);
});

test("countRealUserTurns counts only plain-string guest messages, never the synthetic tool-result 'user' messages the agent loop also pushes", () => {
  const history = [
    { role: "user", content: "how much for a table" },
    { role: "assistant", content: [{ type: "text", text: "..." }] },
    { role: "user", content: "book it" },
    // A tool-result round trip looks like this — array content, same role "user".
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "{}" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "start_booking", input: {} }] },
  ];
  assert.equal(countRealUserTurns(history), 2);
});

test("hasReachedTurnCap flips at exactly 25 real guest turns", () => {
  const under = Array.from({ length: 24 }, () => ({ role: "user", content: "hi" }));
  const at = Array.from({ length: 25 }, () => ({ role: "user", content: "hi" }));
  assert.equal(hasReachedTurnCap(under), false);
  assert.equal(hasReachedTurnCap(at), true);
});

test("tryConsumeDailyModelCall stops allowing calls once DEMO_DAILY_MODEL_CALLS is reached, and never over-counts", () => {
  // DEMO_DAILY_MODEL_CALLS=3 for this whole file, but db.test.ts's own
  // increments already happened in a separate temp DB — this file has its
  // own, so it starts at 0.
  assert.equal(tryConsumeDailyModelCall(), true); // 1
  assert.equal(tryConsumeDailyModelCall(), true); // 2
  assert.equal(tryConsumeDailyModelCall(), true); // 3 — reaches the cap
  assert.equal(tryConsumeDailyModelCall(), false); // 4th call this "day" is refused
  assert.equal(tryConsumeDailyModelCall(), false); // stays refused, doesn't creep back open
});

test("per-IP and per-phone new-conversation rate limits allow up to the configured limit, then refuse", () => {
  __resetRateLimitsForTests();
  for (let i = 0; i < 5; i++) {
    assert.equal(tryStartWebConversation("203.0.113.5"), true, `web attempt ${i + 1} should be allowed`);
  }
  assert.equal(tryStartWebConversation("203.0.113.5"), false, "6th web attempt from the same IP this hour should be refused");
  // A different IP is a completely separate bucket.
  assert.equal(tryStartWebConversation("203.0.113.9"), true);

  for (let i = 0; i < 5; i++) {
    assert.equal(tryStartSmsConversation("+15550001111"), true, `sms attempt ${i + 1} should be allowed`);
  }
  assert.equal(tryStartSmsConversation("+15550001111"), false, "6th sms attempt from the same phone this hour should be refused");
});
