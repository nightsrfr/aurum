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

  const session = await stripe.checkout.sessions.create({
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
    success_url: `${config.baseUrl}/demo/success?booking=${params.bookingId}`,
    cancel_url: `${config.baseUrl}/demo/cancelled?booking=${params.bookingId}`,
  });

  return { url: session.url!, sessionId: session.id };
}

export function getStripeClient() {
  return stripe;
}
