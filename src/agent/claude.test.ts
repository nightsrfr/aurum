import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-claude-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";
// Left at its generous default (2000) deliberately — this file exercises
// the 25-turn cap with 25+ real (mocked) model calls, and a low daily cap
// here would interfere with that. See claude-daily-cap.test.ts (a
// separate process) for the daily-cap path.

const { runAgent, anthropic } = await import("./claude.js");
const { loadConversation } = await import("../db.js");

function mockReply(t: any, text: string) {
  return t.mock.method(anthropic.messages, "create", async () => ({
    content: [{ type: "text", text }],
  }));
}

test("a real guest turn calls the model normally (mocked, no real network call) and saves the reply", async (t) => {
  const mock = mockReply(t, "Sure, what date were you thinking?");
  const reply = await runAgent("+15559990001", "how much for a table");
  assert.equal(reply, "Sure, what date were you thinking?");
  assert.equal(mock.mock.callCount(), 1);
});

test("the 25th real guest turn still calls the model, but the 26th is a fixed wrap-up reply with zero model calls", async (t) => {
  const phone = "+15559990002";
  const mock = mockReply(t, "ok");
  for (let i = 0; i < 25; i++) {
    await runAgent(phone, `message number ${i}`);
  }
  assert.equal(mock.mock.callCount(), 25, "all 25 real turns should have called the model");

  const reply = await runAgent(phone, "one more message past the cap");
  assert.equal(mock.mock.callCount(), 25, "the 26th turn must not call the model at all");
  assert.match(reply, /demo caps out|text \(202\)/i);

  const history = loadConversation(phone);
  const lastTwo = history.slice(-2);
  assert.equal(lastTwo[0].content, "one more message past the cap");
  assert.deepEqual((lastTwo[1].content as any)[0].text, reply);
});
