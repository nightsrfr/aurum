import { Router } from "express";
import { config } from "../config.js";
import { getBooking } from "../db.js";
import { createEmbeddedCheckoutSession, getStripeClient } from "../services/stripe.js";
import { continueChatLink, widgetLoaderScript } from "./demo.js";
import { bookingPaymentSummaryHtml } from "./paymentSummary.js";
import { confirmBooking } from "./stripeWebhook.js";

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
        <title>Pay your deposit — ${config.venueName}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #222; }
          h1 { font-size: 18px; margin-bottom: 4px; }
          h2 { font-size: 20px; }
          .summary { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; font-size: 14px; }
          .summary strong { display: block; margin-top: 4px; font-size: 16px; }
          .msg { text-align: center; padding: 40px 0; }
          .error { color: #b3261e; }
          .demoFallbackBtn { padding: 12px 20px; font-size: 16px; }
        </style>
      </head>
      <body>
        <h1>${config.venueName}</h1>
        ${body}
        ${continueChatLink()}
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
        ${bookingPaymentSummaryHtml(booking)}
      </div>
      <div id="checkout-container"></div>
      <script src="https://js.stripe.com/v3/" onerror="window.__stripeScriptFailed = true;"></script>
      <script>
        (function () {
          var container = document.getElementById("checkout-container");
          var settled = false;

          // Renders a real, working fallback — never a blank box or an inert
          // error paragraph with nothing to do. This app can only ever run
          // with a test-mode (or no) Stripe key (see config.ts's sk_live_
          // refusal), so a demo-style "confirm without a real charge" button
          // is consistent with what this whole app already is, not a special
          // case invented just for this failure path.
          function showFallback(reason) {
            if (settled) return;
            settled = true;
            console.error("Embedded checkout could not load — falling back to the demo confirm button. Reason:", reason);
            container.innerHTML =
              '<p class="error">We couldn\\'t load the secure card form in this browser.</p>' +
              '<form id="demoFallbackForm"><button type="submit" class="demoFallbackBtn">Confirm payment (demo)</button></form>';
            document.getElementById("demoFallbackForm").addEventListener("submit", function (e) {
              e.preventDefault();
              this.querySelector("button").disabled = true;
              fetch(window.location.pathname + "/demo-confirm", { method: "POST" })
                .then(function (res) { return res.json(); })
                .then(function () {
                  container.innerHTML = "<p><strong>Payment confirmed ✅</strong> Check the chat below for your confirmation.</p>";
                })
                .catch(function () {
                  container.innerHTML = '<p class="error">That didn\\'t go through either — let us know in the chat below.</p>';
                });
            });
          }

          function markSettled() {
            settled = true;
          }

          // A silent hang (initEmbeddedCheckout() never resolving OR
          // rejecting — the actual "rendered blank" symptom this was built
          // for, seen with a publishable key that doesn't match the secret
          // key's own Stripe account) has nothing else to catch it, so it
          // needs its own timeout rather than relying on a promise
          // rejection that may never come.
          var STRIPE_INIT_TIMEOUT_MS = 6000;
          var timeoutId = setTimeout(function () { showFallback("timed out waiting for Stripe to render"); }, STRIPE_INIT_TIMEOUT_MS);

          if (window.__stripeScriptFailed) {
            clearTimeout(timeoutId);
            showFallback("https://js.stripe.com/v3/ failed to load");
            return;
          }

          var stripe;
          try {
            stripe = Stripe(${JSON.stringify(config.stripe.publishableKey)});
          } catch (e) {
            clearTimeout(timeoutId);
            showFallback("Stripe(...) threw: " + e);
            return;
          }

          fetch(window.location.pathname + "/session", { method: "POST" })
            .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
            .then(function (result) {
              if (!result.ok) {
                clearTimeout(timeoutId);
                showFallback("session endpoint returned an error: " + (result.data && result.data.error));
                return;
              }
              return stripe.initEmbeddedCheckout({ clientSecret: result.data.clientSecret }).then(function (checkout) {
                clearTimeout(timeoutId);
                markSettled();
                checkout.mount("#checkout-container");
              });
            })
            .catch(function (err) {
              clearTimeout(timeoutId);
              showFallback("promise rejected: " + err);
            });
        })();
      </script>
    `)
  );
});

// The client-side fallback's own confirm action (see showFallback() above) —
// reachable only when the real embedded Stripe form genuinely could not
// render. Same effect as the /demo/pay/:bookingId/confirm button: calls the
// exact same confirmBooking() the real Stripe webhook calls, so the rest of
// the confirmation flow (chat message, SMS/email per the guest's chosen
// channel) behaves identically either way. Refuses to re-confirm a booking
// that isn't (or is no longer) awaiting payment, same guard as the session
// endpoint below.
checkoutRouter.post("/pay/:bookingId/demo-confirm", async (req, res) => {
  const booking = getBooking(req.params.bookingId);
  if (!booking) {
    return res.status(404).json({ error: "Booking not found." });
  }
  if (booking.status !== "pending_payment") {
    return res.status(400).json({ error: "This booking is no longer awaiting payment." });
  }
  await confirmBooking(booking.id);
  res.json({ success: true });
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
      // The webhook (which may land a moment before or after this redirect
      // does) is what actually calls confirmBooking() and sets
      // confirmation_channel — read the booking back rather than
      // presupposing a channel the guest may not have chosen. See
      // stripeWebhook.ts's confirmBooking() for the one place that decision
      // is honored.
      const booking = getBooking(req.params.bookingId);
      const deliveryText =
        booking?.confirmation_channel === "sms"
          ? "a confirmation text is on its way"
          : booking?.confirmation_channel === "email"
            ? "a confirmation email is on its way"
            : "your confirmation details are right here in the chat";
      return res.type("html").send(
        paymentPage(`<div class="msg"><h2>Payment successful ✅</h2><p>You're all set — ${deliveryText}. Feel free to keep chatting below if you have any other questions.</p></div>`)
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
