import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import express from "express";

// A separate file/process from stripeWebhook.test.ts (same reasoning as
// this project's own config.test.ts spawning a fresh process per case) —
// STRIPE_WEBHOOK_SECRET is read once at config module load, so "secret
// configured" and "secret unset" can't both be exercised from the same
// already-imported config instance.
const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-stripewebhook-configured-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";
process.env.STRIPE_SECRET_KEY = "sk_test_thisIsAFakeTestKeyShapeOnly";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_thisIsAFakeWebhookSecret";

const { stripeWebhookRouter } = await import("./stripeWebhook.js");

async function startApp() {
  const app = express();
  app.use("/webhook/stripe", express.raw({ type: "application/json" }));
  app.use(stripeWebhookRouter);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

test("with STRIPE_WEBHOOK_SECRET configured, a request with a genuinely invalid signature is still refused with 400", async () => {
  const { server, base } = await startApp();
  try {
    const res = await fetch(`${base}/webhook/stripe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=1,v1=notTheRealSignature",
      },
      body: JSON.stringify({ id: "evt_x", type: "checkout.session.completed", data: { object: {} } }),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(text, /invalid signature/i);
  } finally {
    server.close();
  }
});
