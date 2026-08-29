import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { smsRouter } from "./routes/sms.js";
import { stripeWebhookRouter } from "./routes/stripeWebhook.js";
import { demoRouter } from "./routes/demo.js";
import { checkoutRouter } from "./routes/checkout.js";
import { chatRouter } from "./routes/chat.js";
import { adminRouter } from "./routes/admin.js";

const app = express();

// Allows the website widget (loaded on a venue's own domain) to call this
// API cross-origin. Open to any origin for the prototype — worth locking
// down to specific venue domains before this handles real traffic at scale.
app.use(cors());

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
