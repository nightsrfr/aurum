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

  let event: Stripe.Event;
  try {
    const signature = req.headers["stripe-signature"] as string;
    event = config.stripe.webhookSecret
      ? stripe.webhooks.constructEvent(req.body, signature, config.stripe.webhookSecret)
      : (JSON.parse(req.body.toString()) as Stripe.Event);
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
  // `phone`, which today always holds the same value anyway (see the Booking
  // type in db.ts for why they're kept as separate columns).
  const channelId: string = booking.channel_id ?? booking.phone;
  const isWeb = channelId.startsWith("web:");

  const message = `🎉 Payment received — you're officially booked for ${booking.date} at ${config.venueName}! A confirmation text is on its way with all the details. Just give the door the name "${booking.guest_name}" and you're in. We can't wait to see you — get ready for an unforgettable night!`;

  // Drop the confirmation into the guest's actual chat, tagged as a system
  // message (not a normal bot reply) so the admin transcript can tell them
  // apart. This is what makes the guest's own conversation — not just the
  // static /pay/:bookingId/return page — acknowledge a successful payment.
  appendSystemMessage(channelId, message);

  if (isWeb) {
    // Push it instantly if the guest's tab is still open; if not, it's
    // already saved above and will show up next time the widget loads.
    publish(channelId, { role: "assistant", text: message, source: "system" });
  } else {
    try {
      await sendSms(channelId, message);
    } catch (err) {
      console.error(`Failed to send payment-confirmation SMS to ${channelId}:`, err);
    }
  }
}
