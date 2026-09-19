import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// This app is a public, unauthenticated marketing demo — it must never be
// able to move real money. Spawned as a real separate process (not just
// calling a function and checking a return value) because the guard is a
// module-load-time process.exit(1), the same way it will actually behave
// in production if this env var is ever set wrong.
function runWithStripeKey(key: string): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", "import('./src/config.ts').then(() => console.log('CONFIG_LOADED_OK'))"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "test-key",
        ADMIN_PASSWORD: "test-password",
        STRIPE_SECRET_KEY: key,
      },
      encoding: "utf8",
    }
  );
  return { status: result.status, stderr: result.stderr };
}

// Deliberately NOT a plausible key shape (hyphens break the base62 run a
// secret scanner looks for) — GitHub's push protection correctly flagged
// an earlier version of this fixture as a real-looking Stripe key. Only
// the "sk_live_" prefix itself matters to the code under test.
test("refuses to start with a live-mode Stripe secret key", () => {
  const { status, stderr } = runWithStripeKey("sk_live_NOT-A-REAL-KEY-test-fixture-only");
  assert.notEqual(status, 0, "process should exit non-zero when STRIPE_SECRET_KEY is a live key");
  assert.match(stderr, /FATAL/);
  assert.match(stderr, /sk_live_/);
});

test("starts normally with a test-mode Stripe secret key", () => {
  const { status } = runWithStripeKey("sk_test_NOT-A-REAL-KEY-test-fixture-only");
  assert.equal(status, 0);
});

test("starts normally with no Stripe key configured at all (demo pay page mode)", () => {
  const { status } = runWithStripeKey("");
  assert.equal(status, 0);
});
