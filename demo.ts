import { Router } from "express";
import { config } from "../config.js";
import { getBooking } from "../db.js";
import { confirmBooking } from "./stripeWebhook.js";

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
function widgetLoaderScript(): string {
  return `
    <script>
      (function () {
        var s = document.createElement("script");
        s.src = window.location.origin + "/widget.js";
        s.setAttribute("data-api-base", window.location.origin);
        s.setAttribute("data-venue-name", ${JSON.stringify(config.venueName)});
        document.body.appendChild(s);
      })();
    </script>
  `;
}

demoRouter.get("/demo/pay/:bookingId", (req, res) => {
  const booking = getBooking(req.params.bookingId);
  if (!booking) return res.status(404).send("Booking not found");

  res.type("html").send(`
    <html>
      <body style="font-family: sans-serif; max-width: 420px; margin: 60px auto;">
        <h2>${booking.table_id} — ${booking.date}</h2>
        <p>Party of ${booking.party_size} under "${booking.guest_name}"</p>
        <p><strong>Minimum spend due: $${(booking.amount_cents / 100).toFixed(2)}</strong></p>
        <p style="color:#888">This is a DEMO payment page (no Stripe account configured yet).</p>
        <form method="POST" action="/demo/pay/${booking.id}/confirm">
          <button style="padding:12px 20px;font-size:16px;">Confirm Payment (Demo)</button>
        </form>
        ${widgetLoaderScript()}
      </body>
    </html>
  `);
});

demoRouter.post("/demo/pay/:bookingId/confirm", async (req, res) => {
  await confirmBooking(req.params.bookingId);
  res.type("html").send(
    `<html><body style="font-family: sans-serif; max-width: 420px; margin: 60px auto;">
      <h2>Payment confirmed ✅</h2>
      <p>A confirmation text has been sent to the guest (check your terminal if Twilio isn't configured yet). You can keep chatting below if you have any other questions.</p>
      ${widgetLoaderScript()}
    </body></html>`
  );
});

demoRouter.get("/demo/success", (req, res) =>
  res.type("html").send(`
    <html>
      <body style="font-family: sans-serif; max-width: 420px; margin: 60px auto; text-align:center;">
        <h2>Payment successful ✅</h2>
        <p>You're all set — a confirmation text is on its way. Feel free to keep chatting below if you have any other questions.</p>
        ${widgetLoaderScript()}
      </body>
    </html>
  `)
);

demoRouter.get("/demo/cancelled", (req, res) =>
  res.type("html").send(`
    <html>
      <body style="font-family: sans-serif; max-width: 420px; margin: 60px auto; text-align:center;">
        <h2>Payment cancelled</h2>
        <p>No charge was made. Let us know in the chat below if you'd like to pick a different table or date.</p>
        ${widgetLoaderScript()}
      </body>
    </html>
  `)
);
