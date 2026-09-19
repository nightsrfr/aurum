import { Router } from "express";
import Stripe from "stripe";
import { config } from "../config.js";
import { getStripeClient } from "../services/stripe.js";
import { db, updateBooking, appendSystemMessage } from "../db.js";
import { sendSms } from "../services/twilio.js";
import { sendEmail } from "../services/email.js";
import { publish } from "../services/liveUpdates.js";
import { formatMoney } from "../services/format.js";

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
  // (it's always the number they're texting from). On the web widget it's
  // never a real phone unless the guest is choosing to be texted their
  // confirmation — see confirmation_channel/confirmation_contact below,
  // which is the ONLY source of truth for a web booking's delivery choice.
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
  const minSpendCents = resolveMinSpendCents();
  const balanceCents = Math.max(minSpendCents - booking.amount_cents, 0);
  const balanceLine =
    balanceCents > 0
      ? ` Your deposit is credited against the ${config.venueName} minimum — the remaining ${formatMoney(balanceCents)} balance is settled at the table on the night.`
      : "";

  // Never presuppose a delivery channel the guest didn't actually pick —
  // "a confirmation text is on its way" used to be hardcoded here
  // regardless of whether a real phone even existed, let alone whether the
  // guest consented to being texted. An SMS-channel guest is unaffected by
  // any of this (isWeb is false, so none of the branches below run) and
  // keeps getting confirmed exactly as before.
  const deliveryLine = isWeb
    ? booking.confirmation_channel === "sms"
      ? ` A confirmation text is on its way to ${booking.confirmation_contact}.`
      : booking.confirmation_channel === "email"
        ? ` A confirmation email is on its way to ${booking.confirmation_contact}.`
        : "" // chat_only or never answered — say nothing extra; this message IS the confirmation
    : hasRealPhone
      ? ` A confirmation text is on its way to ${booking.phone} with all the details.`
      : "";

  const message = `🎉 Payment received — you're officially booked for ${booking.date} at ${config.venueName}!${deliveryLine} Just give the door the name "${booking.guest_name}" and you're in.${balanceLine} We can't wait to see you — get ready for an unforgettable night!`;

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

  if (!isWeb) {
    // SMS-channel booking — unchanged behavior, always text the guest's own
    // real number, exactly as this has always worked.
    if (hasRealPhone) {
      try {
        await sendSms(booking.phone, message);
      } catch (err) {
        console.error(`Failed to send payment-confirmation SMS to ${booking.phone}:`, err);
      }
    }
    return;
  }

  // Web-channel booking — the ONLY two cases that ever leave the chat: the
  // guest explicitly opted into text (set_confirmation_channel, gated by
  // config.webSmsOptIn and the consent throttles — see agent/tools.ts) or
  // email. Anything else (declined both, never answered, throttled) sends
  // nothing further — the chat message above already is the confirmation.
  if (booking.confirmation_channel === "sms" && booking.confirmation_contact) {
    try {
      // Exactly one text, ending with the required opt-out line — this is
      // the one and only SMS a web-originated confirmation ever sends.
      await sendSms(booking.confirmation_contact, `${message} Reply STOP to opt out.`);
    } catch (err) {
      console.error(`Failed to send web-confirmation SMS to ${booking.confirmation_contact}:`, err);
    }
  } else if (booking.confirmation_channel === "email" && booking.confirmation_contact) {
    try {
      await sendEmail(booking.confirmation_contact, `Your ${config.venueName} booking confirmation`, message);
    } catch (err) {
      console.error(`Failed to send web-confirmation email to ${booking.confirmation_contact}:`, err);
    }
  }
}
