import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import express from "express";

const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-stripewebhook-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";
process.env.STRIPE_SECRET_KEY = "sk_test_thisIsAFakeTestKeyShapeOnly";
// Deliberately NOT setting STRIPE_WEBHOOK_SECRET — this is exactly the
// "unsigned events" scenario the fix must refuse.

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

test("SECURITY: with STRIPE_WEBHOOK_SECRET unset, a forged (unsigned) checkout.session.completed event is refused with 400, never parsed as trusted JSON", async () => {
  const { server, base } = await startApp();
  try {
    const forgedEvent = {
      id: "evt_forged",
      type: "checkout.session.completed",
      data: { object: { metadata: { bookingId: "some-real-booking-id" } } },
    };
    const res = await fetch(`${base}/webhook/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No Stripe-Signature header at all — exactly what an attacker who
      // found this URL and knew nothing about the account's webhook
      // secret would send.
      body: JSON.stringify(forgedEvent),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(text, /not configured/i);
  } finally {
    server.close();
  }
});

test("SECURITY: even with a Stripe-Signature header present, an unsigned-webhook-secret config still refuses rather than trusting it", async () => {
  const { server, base } = await startApp();
  try {
    const forgedEvent = { id: "evt_forged2", type: "checkout.session.completed", data: { object: {} } };
    const res = await fetch(`${base}/webhook/stripe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=1,v1=totallyMadeUp",
      },
      body: JSON.stringify(forgedEvent),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
