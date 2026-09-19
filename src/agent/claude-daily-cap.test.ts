import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A separate file/process from claude.test.ts (same reasoning as this
// project's own config.test.ts and stripeWebhook-configured.test.ts) —
// DEMO_DAILY_MODEL_CALLS is read once at config module load, so a low cap
// here can't leak into (or be starved by) the 25-real-call turn-cap test
// in the same process.
const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-claude-dailycap-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";
process.env.DEMO_DAILY_MODEL_CALLS = "2";

const { runAgent, anthropic } = await import("./claude.js");

test("once the global daily model-call cap is reached, further turns get the fixed 'resting' reply instead of calling the model", async (t) => {
  const mock = t.mock.method(anthropic.messages, "create", async () => ({
    content: [{ type: "text", text: "ok" }],
  }));

  await runAgent("+15559990010", "first message");
  await runAgent("+15559990011", "second message, different conversation");
  assert.equal(mock.mock.callCount(), 2, "the first two turns across any conversation should reach the model");

  const reply = await runAgent("+15559990012", "third conversation, cap should already be hit");
  assert.equal(mock.mock.callCount(), 2, "no further model call once the daily cap is reached");
  assert.match(reply, /resting|tomorrow/i);
});
