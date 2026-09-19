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
// scoped to only /api/chat, /api/chat/history, and /api/chat/stream, and
// restricted to the real marketing-site origins plus localhost. Every
// other route here is either same-origin navigation (/admin, /pay, /demo)
// or a server-to-server webhook (Twilio/Stripe never send a browser
// Origin header, so CORS is meaningless for them either way) — a global
// open policy had no reason to cover those too.

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
