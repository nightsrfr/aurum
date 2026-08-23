import { Router } from "express";
import { getBooking } from "../db.js";
import { confirmBooking } from "./stripeWebhook.js";

/**
 * Lets you test the entire booking + payment + confirmation-SMS flow
 * before you've created a real Stripe account. In demo mode, start_booking
 * points guests to /demo/pay/:bookingId instead of a real Stripe Checkout
 * page. Once you add a real STRIPE_SECRET_KEY, this route is unused —
 * guests pay on Stripe's hosted page instead.
 */
export const demoRouter = Router();

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
      </body>
    </html>
  `);
});

demoRouter.post("/demo/pay/:bookingId/confirm", async (req, res) => {
  await confirmBooking(req.params.bookingId);
  res.type("html").send(
    `<html><body style="font-family: sans-serif; max-width: 420px; margin: 60px auto;">
      <h2>Payment confirmed ✅</h2>
      <p>A confirmation text has been sent to the guest (check your terminal if Twilio isn't configured yet).</p>
    </body></html>`
  );
});

demoRouter.get("/demo/success", (req, res) => res.send("Payment successful — you can close this tab."));
demoRouter.get("/demo/cancelled", (req, res) => res.send("Payment cancelled."));
