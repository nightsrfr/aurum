import { Router } from "express";
import { config } from "../config.js";
import { getBooking } from "../db.js";
import { confirmBooking } from "./stripeWebhook.js";
import { bookingPaymentSummaryHtml } from "./paymentSummary.js";

/**
 * Lets you test the entire booking + payment + confirmation-SMS flow
 * before you've created a real Stripe account. In demo mode, start_booking
 * points guests to /demo/pay/:bookingId instead of a real Stripe Checkout
 * page. Once you add a real STRIPE_SECRET_KEY, this route is unused for
 * payment itself, but /demo/success and /demo/cancelled are still where
 * Stripe redirects guests back to after a real checkout.
 */
export const demoRouter = Router();

// Every page below embeds the same booking widget, pointed at this same
// server. Because these pages are same-origin with wherever the guest
// started chatting, the widget picks up the same session id from
// localStorage and restores the exact conversation — so a guest who opened
// their payment link in a new tab lands on a page where the chat is still
// right there, with full history, instead of needing to close the tab and
// go back to find it.
//
// data-launcher="none": a pay/return/demo-pay page is a small, single-task
// page — a floating "Book a Table" launcher sitting on top of a payment
// form or a confirmation message adds visual clutter with nothing to do
// with what the guest is on the page for. continueChatLink() below is the
// deliberate replacement: the conversation is still one click away, it's
// just not a second floating button competing with the page's own content.
export function widgetLoaderScript(): string {
  return `
    <script>
      (function () {
        var s = document.createElement("script");
        s.src = window.location.origin + "/widget.js";
        s.setAttribute("data-api-base", window.location.origin);
        s.setAttribute("data-venue-name", ${JSON.stringify(config.venueName)});
        s.setAttribute("data-launcher", "none");
        document.body.appendChild(s);
      })();
    </script>
  `;
}

/** A small inline link that opens the same widget instance widgetLoaderScript() just loaded — see that function's comment for why these pages skip the floating launcher. */
export function continueChatLink(): string {
  return `
    <div style="text-align:center;margin-top:18px;">
      <a href="#" onclick="window.AftersetDemo &amp;&amp; window.AftersetDemo.open(); return false;"
         style="font-size:13px;color:#888;text-decoration:underline;">Questions? Continue the chat</a>
    </div>
  `;
}

demoRouter.get("/demo/pay/:bookingId", (req, res) => {
  const booking = getBooking(req.params.bookingId);
  if (!booking) return res.status(404).send("Booking not found");

  res.type("html").send(`
    <html>
      <head><title>Pay your deposit — ${config.venueName}</title></head>
      <body style="font-family: sans-serif; max-width: 420px; margin: 60px auto;">
        <h2 style="margin-bottom:4px;">${config.venueName}</h2>
        ${bookingPaymentSummaryHtml(booking)}
        <p style="color:#888">This is a DEMO payment page (no Stripe account configured yet).</p>
        <form method="POST" action="/demo/pay/${booking.id}/confirm">
          <button style="padding:12px 20px;font-size:16px;">Confirm Payment (Demo)</button>
        </form>
        ${continueChatLink()}
        ${widgetLoaderScript()}
      </body>
    </html>
  `);
});

demoRouter.post("/demo/pay/:bookingId/confirm", async (req, res) => {
  await confirmBooking(req.params.bookingId);
  // Read the booking back AFTER confirmBooking() so this reflects whatever
  // channel the guest actually chose (or "chat_only" if they declined
  // both/never answered) — see stripeWebhook.ts's confirmBooking() for the
  // one place that decision is honored. This page used to hardcode "a
  // confirmation text has been sent," which was already inaccurate before
  // this feature existed for any booking with no real phone on file.
  const booking = getBooking(req.params.bookingId);
  const deliveryText =
    booking?.confirmation_channel === "sms"
      ? "A confirmation text has been sent (check your terminal if Twilio isn't configured yet)."
      : booking?.confirmation_channel === "email"
        ? "A confirmation email has been sent (check your terminal if Resend isn't configured yet)."
        : "Your confirmation details are right here in the chat.";
  res.type("html").send(
    `<html>
      <head><title>Pay your deposit — ${config.venueName}</title></head>
      <body style="font-family: sans-serif; max-width: 420px; margin: 60px auto;">
      <h2>Payment confirmed ✅</h2>
      <p>${deliveryText} You can keep chatting below if you have any other questions.</p>
      ${continueChatLink()}
      ${widgetLoaderScript()}
    </body></html>`
  );
});

demoRouter.get("/demo/success", (req, res) =>
  res.type("html").send(`
    <html>
      <head><title>Pay your deposit — ${config.venueName}</title></head>
      <body style="font-family: sans-serif; max-width: 420px; margin: 60px auto; text-align:center;">
        <h2>Payment successful ✅</h2>
        <p>You're all set — check the chat below for your confirmation details.</p>
        ${continueChatLink()}
        ${widgetLoaderScript()}
      </body>
    </html>
  `)
);

demoRouter.get("/demo/cancelled", (req, res) =>
  res.type("html").send(`
    <html>
      <head><title>Pay your deposit — ${config.venueName}</title></head>
      <body style="font-family: sans-serif; max-width: 420px; margin: 60px auto; text-align:center;">
        <h2>Payment cancelled</h2>
        <p>No charge was made. Let us know in the chat below if you'd like to pick a different table or date.</p>
        ${continueChatLink()}
        ${widgetLoaderScript()}
      </body>
    </html>
  `)
);
