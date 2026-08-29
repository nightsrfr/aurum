import Stripe from "stripe";
import { config } from "../config.js";

const stripe = config.stripeEnabled ? new Stripe(config.stripe.secretKey) : null;

type CreatePaymentParams = {
  bookingId: string;
  amountCents: number;
  description: string;
  customerPhone: string;
};

/**
 * Creates a payment link for the booking deposit / minimum spend.
 *
 * If STRIPE_SECRET_KEY isn't set yet, falls back to a local "demo payment"
 * page (see src/routes/demo.ts) so you can test the entire booking + payment
 * + confirmation flow before you've created a Stripe account.
 *
 * When Stripe IS configured, this deliberately does NOT create the Stripe
 * Checkout Session yet — it just points the guest at our own /pay/:bookingId
 * page (routes/checkout.ts), which creates a fresh embedded session the
 * moment it's actually loaded. Two reasons: it keeps the guest on our own
 * domain the whole time instead of redirecting to checkout.stripe.com, and
 * it sidesteps Checkout Sessions' fixed 24-hour expiry — a guest who opens
 * the link two days later still gets a brand new, valid session.
 */
export async function createPaymentLink(params: CreatePaymentParams): Promise<{
  url: string;
  sessionId: string;
}> {
  if (!stripe) {
    return {
      url: `${config.baseUrl}/demo/pay/${params.bookingId}`,
      sessionId: `demo_${params.bookingId}`,
    };
  }

  return {
    url: `${config.baseUrl}/pay/${params.bookingId}`,
    sessionId: "",
  };
}

type CreateEmbeddedSessionParams = {
  bookingId: string;
  amountCents: number;
  description: string;
};

/**
 * Creates a Stripe Checkout Session in "embedded" mode — rendered inline on
 * our own /pay/:bookingId page via Stripe.js instead of redirecting to a
 * Stripe-hosted page. Called fresh every time that page loads (see
 * routes/checkout.ts), so this is intentionally cheap to call repeatedly.
 */
export async function createEmbeddedCheckoutSession(
  params: CreateEmbeddedSessionParams
): Promise<string> {
  if (!stripe) {
    throw new Error("Stripe is not configured");
  }

  const session = await stripe.checkout.sessions.create({
    ui_mode: "embedded",
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: params.description },
          unit_amount: params.amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: { bookingId: params.bookingId },
    return_url: `${config.baseUrl}/pay/${params.bookingId}/return?session_id={CHECKOUT_SESSION_ID}`,
  });

  return session.client_secret!;
}

export function getStripeClient() {
  return stripe;
}
