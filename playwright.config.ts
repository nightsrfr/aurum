import { defineConfig } from "@playwright/test";
import path from "node:path";
import os from "node:os";

// A real browser is the only way to prove the actual public/widget.js file
// behaves correctly — concierge-platform's own e2e suite (which embeds this
// widget on the marketing site) stubs it out entirely, so a real bug here
// would never be caught there. This spawns the real app against a scratch
// SQLite file in the OS temp dir, same "never touch the dev DB" discipline
// as concierge-platform's own playwright.config.ts.
const PORT = 3911;
const scratchDb = path.join(os.tmpdir(), `aurum-e2e-${Date.now()}.sqlite`);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: "npx tsx src/server.ts",
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PORT: String(PORT),
      DB_PATH: scratchDb,
      BASE_URL: `http://localhost:${PORT}`,
      VENUE_NAME: "Salt & Vine",
      ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key",
    },
  },
});
