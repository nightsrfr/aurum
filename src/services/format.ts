// Shared money/date formatting for anything guest-facing — the pay page
// (paymentSummary.ts), the post-payment confirmation message
// (stripeWebhook.ts), and the demo pay page (demo.ts) all need the exact
// same formatting, so it lives in one place rather than three independently
// -maintained copies.

/** Cents -> "$2,500.00" (always two decimals, thousands-separated). */
export function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Intl's own "short" month format gives "Sep," not the "Sept" this product's
// copy consistently uses elsewhere (see agent/systemPrompt.ts's date-
// restating instruction) — spelled out here rather than relying on a
// locale's own abbreviation.
const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
];

/**
 * "YYYY-MM-DD" -> "Saturday, Sept 19". Parses the date as plain
 * year/month/day components (never through `new Date("YYYY-MM-DD")`,
 * which JS treats as UTC midnight and can render as the PREVIOUS day in a
 * negative-UTC-offset timezone like America/New_York) — this is a bare
 * calendar date with no time component, so it's constructed as a local
 * date directly rather than parsed through any timezone conversion at all.
 */
export function formatDateLong(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate; // not a date this function understands — show it verbatim rather than throw
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  return `${weekday}, ${MONTH_ABBREVIATIONS[Number(m) - 1]} ${Number(d)}`;
}
