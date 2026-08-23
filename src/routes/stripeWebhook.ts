import { Router } from "express";
import Stripe from "stripe";
import { config } from "../config.js";
import { getStripeClient } from "../services/stripe.js";
import { db, updateBooking } from "../db.js";
import { sendSms } from "../services/twilio.js";

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

  await sendSms(
    booking.phone,
    `You're all set! Your table is confirmed for ${booking.date}. See you at the door — just give them the name "${booking.guest_name}". 🎉`
  );
}
