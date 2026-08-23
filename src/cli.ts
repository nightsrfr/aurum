import readline from "node:readline";
import { runAgent } from "./agent/claude.js";

/**
 * Local terminal tester: simulates a guest texting the concierge, without
 * needing a Twilio number or public URL. Just run `npm run chat`.
 */
const DEMO_PHONE = "+15550000000";

console.log("Texting as a demo guest. Type a message and hit enter (Ctrl+C to quit).\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
rl.prompt();

rl.on("line", async (line) => {
  const reply = await runAgent(DEMO_PHONE, line);
  console.log(`\nconcierge> ${reply}\n`);
  rl.prompt();
});
