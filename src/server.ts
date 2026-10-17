import express from "express";
import { config } from "./config.js";
import { smsRouter } from "./routes/sms.js";
import { stripeWebhookRouter } from "./routes/stripeWebhook.js";
import { demoRouter } from "./routes/demo.js";
import { checkoutRouter } from "./routes/checkout.js";
import { chatRouter } from "./routes/chat.js";
import { adminRouter } from "./routes/admin.js";

const app = express();

// No global CORS here — chatRouter (routes/chat.ts) applies its own,
// restricted to the real marketing-site origins plus localhost and mounted
// on the "/api/chat" path prefix, so it covers only /api/chat,
// /api/chat/history, and /api/chat/stream. That path prefix is what keeps
// it off every other route: chatRouter is mounted here with a bare
// app.use(), so without it the allowlist would run for every later
// router too (adminRouter included). It must stay scoped, because a
// disallowed Origin is a server-side 500, not a browser-side block, and
// browsers do send Origin on same-origin POSTs — /admin/login's form post
// carries this service's own origin, which isn't on the list. The other
// routes are same-origin pages (/admin, /pay, /demo) or server-to-server
// webhooks (Twilio/Stripe send no Origin header) and need no CORS policy.

// Serves widget.js and the demo.html test page as static files.
app.use(express.static("public"));

// Stripe requires the raw body to verify webhook signatures. Scoping the
// raw-body parser to exactly this path (rather than matching by content-type
// across all routes) keeps it from swallowing the body on other JSON routes
// like /api/chat.
app.use("/webhook/stripe", express.raw({ type: "application/json" }));
app.use(stripeWebhookRouter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(smsRouter);
app.use(demoRouter);
app.use(checkoutRouter);
app.use(chatRouter);
app.use(adminRouter);

app.get("/health", (_req, res) => res.json({ ok: true, venue: config.venueName }));

app.listen(config.port, () => {
  console.log(`Nightclub SMS concierge listening on http://localhost:${config.port}`);
  console.log(`Twilio mode: ${config.twilioEnabled ? "LIVE" : "console-log demo"}`);
  console.log(`Stripe mode: ${config.stripeEnabled ? "LIVE" : "demo payment page"}`);
});
