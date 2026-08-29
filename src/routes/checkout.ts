import { Router } from "express";
import { config } from "../config.js";
import { getBooking } from "../db.js";
import { createEmbeddedCheckoutSession, getStripeClient } from "../services/stripe.js";
import { widgetLoaderScript } from "./demo.js";

/**
 * The real (non-demo) payment page. Once STRIPE_SECRET_KEY is configured,
 * createPaymentLink() (services/stripe.ts) points guests here instead of
 * /demo/pay/:bookingId. This renders Stripe's Embedded Checkout inline on
 * our own page — the guest enters their card details without ever being
 * redirected to a checkout.stripe.com URL. The actual booking confirmation
 * (status flip + SMS) still happens independently via /webhook/stripe
 * (routes/stripeWebhook.ts) once Stripe reports the payment succeeded —
 * this page is only the guest-facing UI around that.
 */
export const checkoutRouter = Router();

function paymentPage(body: string): string {
  return `
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #222; }
          h2 { font-size: 20px; }
          .summary { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; font-size: 14px; }
          .summary strong { display: block; margin-top: 4px; font-size: 16px; }
          .msg { text-align: center; padding: 40px 0; }
          .error { color: #b3261e; }
        </style>
      </head>
      <body>
        ${body}
        ${widgetLoaderScript()}
      </body>
    </html>
  `;
}

checkoutRouter.get("/pay/:bookingId", (req, res) => {
  if (!config.stripeEnabled) {
    // Safety net — createPaymentLink() only hands out /pay/... links when
    // Stripe is actually configured, but guard here too in case an old link
    // is revisited after STRIPE_SECRET_KEY gets unset.
    return res.redirect(`/demo/pay/${req.params.bookingId}`);
  }

  const booking = getBooking(req.params.bookingId);
  if (!booking) {
    return res.status(404).type("html").send(paymentPage(`<div class="msg"><h2>Booking not found</h2></div>`));
  }

  if (booking.status === "confirmed") {
    return res.type("html").send(
      paymentPage(`<div class="msg"><h2>Already confirmed ✅</h2><p>This table is already booked and paid for — no further action needed.</p></div>`)
    );
  }
  if (booking.status === "cancelled") {
    return res.type("html").send(
      paymentPage(`<div class="msg"><h2>Booking cancelled</h2><p>This booking was cancelled, so this payment link is no longer active. Ask in the chat below if you'd like to book again.</p></div>`)
    );
  }

  if (!config.stripe.publishableKey) {
    // Fail loudly and server-side rather than silently in the browser — a
    // missing STRIPE_PUBLISHABLE_KEY otherwise shows up as nothing more
    // than a blank box where the payment form should be, which is very
    // hard to diagnose from the guest's side.
    console.error(
      "STRIPE_PUBLISHABLE_KEY is not set — /pay pages cannot load the embedded checkout form."
    );
    return res.status(500).type("html").send(
      paymentPage(
        `<div class="msg error"><h2>Payment form unavailable</h2><p>We hit a configuration issue on our end (missing publishable key). Let us know in the chat below and we'll get it sorted, or try again shortly.</p></div>`
      )
    );
  }

  res.type("html").send(
    paymentPage(`
      <div class="summary">
        ${booking.table_id} — ${booking.date}
        <br>Party of ${booking.party_size} under "${booking.guest_name}"
        <strong>Minimum spend due: $${(booking.amount_cents / 100).toFixed(2)}</strong>
      </div>
      <div id="checkout-container"></div>
      <script src="https://js.stripe.com/v3/"></script>
      <script>
        (function () {
          var stripe;
          try {
            stripe = Stripe(${JSON.stringify(config.stripe.publishableKey)});
          } catch (e) {
            document.getElementById("checkout-container").innerHTML =
              '<p class="error">Could not initialize the payment form (invalid Stripe key). Let us know in the chat below.</p>';
            console.error("Stripe.js init failed:", e);
            return;
          }
          fetch(window.location.pathname + "/session", { method: "POST" })
            .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
            .then(function (result) {
              if (!result.ok) {
                document.getElementById("checkout-container").innerHTML =
                  '<p class="error">' + (result.data.error || "Something went wrong loading payment.") + "</p>";
                return;
              }
              return stripe.initEmbeddedCheckout({ clientSecret: result.data.clientSecret }).then(function (checkout) {
                checkout.mount("#checkout-container");
              });
            })
            .catch(function () {
              document.getElementById("checkout-container").innerHTML =
                '<p class="error">Could not load the payment form — please refresh and try again.</p>';
            });
        })();
      </script>
    `)
  );
});

checkoutRouter.post("/pay/:bookingId/session", async (req, res) => {
  const booking = getBooking(req.params.bookingId);
  if (!booking) {
    return res.status(404).json({ error: "Booking not found." });
  }
  if (booking.status !== "pending_payment") {
    return res.status(400).json({ error: "This booking is no longer awaiting payment." });
  }

  try {
    const clientSecret = await createEmbeddedCheckoutSession({
      bookingId: booking.id,
      amountCents: booking.amount_cents,
      description: `${booking.table_id} - ${booking.date} - ${config.venueName}`,
    });
    res.json({ clientSecret });
  } catch (err) {
    console.error("Failed to create embedded checkout session:", err);
    res.status(500).json({ error: "Could not start payment — please try again in a moment." });
  }
});

// Embedded Checkout does a top-level redirect here once payment completes
// (or for payment methods that require one). The webhook is what actually
// confirms the booking + sends the SMS — this page just reflects that back
// to the guest using the session status Stripe already resolved.
checkoutRouter.get("/pay/:bookingId/return", async (req, res) => {
  const stripe = getStripeClient();
  const sessionId = req.query.session_id as string | undefined;

  if (!stripe || !sessionId) {
    return res.type("html").send(
      paymentPage(`<div class="msg"><h2>Payment status unknown</h2><p>Check the chat below or ask us to confirm your booking.</p></div>`)
    );
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === "paid") {
      return res.type("html").send(
        paymentPage(`<div class="msg"><h2>Payment successful ✅</h2><p>You're all set — a confirmation text is on its way. Feel free to keep chatting below if you have any other questions.</p></div>`)
      );
    }
    return res.type("html").send(
      paymentPage(`<div class="msg"><h2>Payment not completed</h2><p>No charge was made. Let us know in the chat below if you'd like to try again or pick a different table or date.</p></div>`)
    );
  } catch (err) {
    console.error("Failed to retrieve checkout session on return:", err);
    return res.type("html").send(
      paymentPage(`<div class="msg"><h2>Payment status unknown</h2><p>Check the chat below or ask us to confirm your booking.</p></div>`)
    );
  }
});
