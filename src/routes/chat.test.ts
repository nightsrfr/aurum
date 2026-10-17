import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import express from "express";

const tmpDir = mkdtempSync(path.join(tmpdir(), "aurum-chat-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "test-password";

const { chatRouter } = await import("./chat.js");

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use(chatRouter);
  // Stand-in for a router mounted after chatRouter in server.ts (adminRouter
  // is) — proves the chat CORS allowlist doesn't leak onto it.
  app.post("/admin/login", (_req, res) => res.status(204).end());
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

test("a message over 800 characters is rejected with 400 before ever reaching the agent (no ANTHROPIC_API_KEY needed to prove this)", async () => {
  const { server, base } = await startApp();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "test-session-1", message: "a".repeat(801) }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("CORS: a request from an allowed marketing-site origin gets that origin reflected back", async () => {
  const { server, base } = await startApp();
  try {
    const res = await fetch(`${base}/api/chat/history?sessionId=test-session-2`, {
      headers: { Origin: "https://concierge-platform.onrender.com" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "https://concierge-platform.onrender.com");
  } finally {
    server.close();
  }
});

test("CORS: a preflight request from a disallowed origin is not granted access", async () => {
  const { server, base } = await startApp();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://some-random-scraper-site.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.notEqual(res.headers.get("access-control-allow-origin"), "https://some-random-scraper-site.example");
  } finally {
    server.close();
  }
});

test("CORS: localhost is allowed for local development", async () => {
  const { server, base } = await startApp();
  try {
    const res = await fetch(`${base}/api/chat/history?sessionId=test-session-3`, {
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
  } finally {
    server.close();
  }
});

test("CORS: the chat allowlist does not apply outside /api/chat — a same-origin POST to a later router (e.g. /admin/login) is not rejected", async () => {
  const { server, base } = await startApp();
  try {
    // Browsers send Origin on same-origin POSTs; this service's own origin
    // is deliberately not in allowedChatOrigins.
    const res = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { Origin: "https://aurum-demo.onrender.com", "Content-Type": "application/json" },
      body: JSON.stringify({ password: "x" }),
    });
    assert.equal(res.status, 204);
  } finally {
    server.close();
  }
});
