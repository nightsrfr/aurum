import { type Booking, listTablesConfig } from "../db.js";

/**
 * Shared by the real Stripe pay page (checkout.ts) and the demo pay page
 * (demo.ts) — both need to show the same real table name (never the raw
 * table_id — a booking used to render as e.g. "vip-booth-10 — 2026-09-05")
 * plus the minimum/deposit/balance breakdown, so this lives in one place
 * rather than two independently-maintained copies.
 */
export function bookingPaymentSummaryHtml(booking: Booking): string {
  const table = listTablesConfig().find((t) => t.id === booking.table_id);
  const tableName = table?.name ?? booking.table_id; // fallback only if the table was since deleted
  const depositCents = booking.amount_cents;
  const minSpendCents = booking.min_spend_cents ?? (table ? table.min_spend * 100 : depositCents);
  const balanceCents = Math.max(minSpendCents - depositCents, 0);
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return `
    <div><strong>${tableName}</strong> — ${booking.date}</div>
    <div>Party of ${booking.party_size} under "${booking.guest_name}"</div>
    <div style="margin-top:10px;">Minimum spend: ${money(minSpendCents)}</div>
    <div><strong>Deposit due now: ${money(depositCents)}</strong></div>
    <div style="color:#666;">Balance of ${money(balanceCents)} settled at the table on the night</div>
  `;
}
