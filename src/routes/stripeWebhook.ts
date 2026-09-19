import { Router } from "express";
import Stripe from "stripe";
import { config } from "../config.js";
import { getStripeClient } from "../services/stripe.js";
import { db, updateBooking, appendSystemMessage } from "../db.js";
import { sendSms } from "../services/twilio.js";
import { publish } from "../services/liveUpdates.js";

export const stripeWebhookRouter = Router();

/**
 * Stripe calls this when a checkout session completes. Needs the RAW body
 * (mounted with express.raw in server.ts) so the signature can be verified.
 */
stripeWebhookRouter.post("/webhook/stripe", async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(400).send("Stripe not configured");
  }

  // Never parse the body as trusted JSON without a verified signature —
  // this used to fall back to `JSON.parse(req.body.toString())` when
  // STRIPE_WEBHOOK_SECRET was unset, which meant anyone who found this URL
  // could POST a fake `checkout.session.completed` event and have
  // confirmBooking() run for a booking they never paid for. Refusing
  // outright when the secret isn't configured is the only safe option —
  // there's no way to tell a real Stripe event from a forged one without it.
  if (!config.stripe.webhookSecret) {
    console.error("Rejected /webhook/stripe request: STRIPE_WEBHOOK_SECRET is not configured.");
    return res.status(400).send("Webhook not configured");
  }

  let event: Stripe.Event;
  try {
    const signature = req.headers["stripe-signature"] as string;
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripe.webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return res.status(400).send("Invalid signature");
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = session.metadata?.bookingId;
    if (bookingId) {
      await confirmBooking(bookingId);
    }
  }

  res.json({ received: true });
});

export async function confirmBooking(bookingId: string) {
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId) as any;
  if (!booking) return;

  updateBooking(bookingId, { status: "confirmed" });

  // channel_id is the conversation this booking actually came from. Older
  // bookings created before that column existed won't have it — fall back to
  // `phone`, which today always holds the same value for those old rows
  // anyway (see the Booking type in db.ts for why they're kept separate).
  const channelId: string = booking.channel_id ?? booking.phone;
  const isWeb = channelId.startsWith("web:");

  // `phone` is a real, textable number whenever this booking came from SMS
  // (it's always the number they're texting from), or from the web widget
  // AFTER the bot started asking guests for one during booking. It'll still
  // be the non-phone "web:<uuid>" placeholder on any web booking made before
  // that change — there's nothing real to text in that case.
  const hasRealPhone = Boolean(booking.phone) && !String(booking.phone).startsWith("web:");

  // What was actually just charged is the deposit (amount_cents) — the
  // rest of the minimum is spent at the table, not charged now. Older
  // bookings (before min_spend_cents existed) fall back to the table's
  // current minimum, on the assumption pricing hasn't changed much since.
  function resolveMinSpendCents(): number {
    if (typeof booking.min_spend_cents === "number") return booking.min_spend_cents;
    const table = db.prepare("SELECT min_spend FROM tables_config WHERE id = ?").get(booking.table_id) as
      | { min_spend: number }
      | undefined;
    return table ? table.min_spend * 100 : booking.amount_cents;
  }
  const balanceCents = Math.max(resolveMinSpendCents() - booking.amount_cents, 0);
  const balanceLine =
    balanceCents > 0
      ? ` Your deposit is credited against the ${config.venueName} minimum — the remaining $${(balanceCents / 100).toFixed(2)} balance is settled at the table on the night.`
      : "";

  const message = hasRealPhone
    ? `🎉 Payment received — you're officially booked for ${booking.date} at ${config.venueName}! A confirmation text is on its way to ${booking.phone} with all the details. Just give the door the name "${booking.guest_name}" and you're in.${balanceLine} We can't wait to see you — get ready for an unforgettable night!`
    : `🎉 Payment received — you're officially booked for ${booking.date} at ${config.venueName}! Just give the door the name "${booking.guest_name}" and you're in.${balanceLine} We can't wait to see you — get ready for an unforgettable night!`;

  // Drop the confirmation into the guest's actual chat, tagged as a system
  // message (not a normal bot reply) so the admin transcript can tell them
  // apart. This is what makes the guest's own conversation — not just the
  // static /pay/:bookingId/return page — acknowledge a successful payment.
  appendSystemMessage(channelId, message);

  if (isWeb) {
    // Push it instantly if the guest's tab is still open; if not, it's
    // already saved above and will show up next time the widget loads.
    publish(channelId, { role: "assistant", text: message, source: "system" });
  }

  // Independently of the chat channel, also text the guest's real phone
  // whenever we actually have one — this is what makes "a confirmation text
  // is on its way" literally true for a web-widget booking too, not just SMS.
  if (hasRealPhone) {
    try {
      await sendSms(booking.phone, message);
    } catch (err) {
      console.error(`Failed to send payment-confirmation SMS to ${booking.phone}:`, err);
    }
  }
}
