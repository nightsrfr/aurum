import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import express from "express";
import twilio from "twilio";

const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-sms-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key-not-real"; // never actually reached — signature checks happen first
process.env.ADMIN_PASSWORD = "test-password";
// Only TWILIO_AUTH_TOKEN is set — that's all isGenuineTwilioRequest() needs
// to validate a signature. Deliberately leaving TWILIO_ACCOUNT_SID/
// TWILIO_FROM_NUMBER unset keeps config.twilioEnabled false, so sendSms()
// stays in its own demo-mode console.log fallback instead of making a
// real (and, with a fake account SID, doomed-to-fail) call to Twilio's API.
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.BASE_URL = "https://example-demo.onrender.com";

const { smsRouter } = await import("./sms.js");
const { anthropic } = await import("../agent/claude.js");

async function startApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(smsRouter);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

const WEBHOOK_PATH = "/webhook/sms";
const FULL_URL = `${process.env.BASE_URL}${WEBHOOK_PATH}`;
const PARAMS = { From: "+15551234567", Body: "how much for a table saturday" };

test("SECURITY: a request with no X-Twilio-Signature header is rejected with 403, never reaching the agent", async () => {
  const { server, base } = await startApp();
  try {
    const res = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(PARAMS).toString(),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test("SECURITY: a request with a forged/incorrect X-Twilio-Signature is rejected with 403", async () => {
  const { server, base } = await startApp();
  try {
    const res = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": "this-is-not-a-real-signature",
      },
      body: new URLSearchParams(PARAMS).toString(),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test("a request with the real, correctly-computed X-Twilio-Signature is accepted (200, empty TwiML)", async (t) => {
  // The handler acknowledges Twilio with an empty TwiML response
  // immediately, then awaits the agent loop before its own async function
  // returns (see sms.ts's own comment on why) — mock the model call here
  // so this test doesn't depend on network reachability or a real
  // ANTHROPIC_API_KEY while that background work finishes, matching this
  // suite's "never make a real model call" discipline elsewhere.
  t.mock.method(anthropic.messages, "create", async () => ({ content: [{ type: "text", text: "ok" }] }));

  const { server, base } = await startApp();
  try {
    const signature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, FULL_URL, PARAMS);
    const res = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: new URLSearchParams(PARAMS).toString(),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<Response\s*\/?>|<Response><\/Response>/);
    // Let the handler's own background await (sendSms after runAgent)
    // settle before this test's own cleanup runs, so nothing from it
    // leaks console output into a later test.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    server.close();
  }
});

// "TWILIO_AUTH_TOKEN unset" is deliberately not covered here as a live
// server test — config.ts resolves env vars once at module load, and this
// file's config module instance is already cached with a real token by
// the tests above by the time any such case could run. It's covered
// directly by isGenuineTwilioRequest()'s own logic instead: `if
// (!config.twilio.authToken) return false;` is unconditional and runs
// before any signature comparison, and src/config.test.ts (a separate
// process per case) already proves config.twilio.authToken really is
// empty when the env var is unset.
