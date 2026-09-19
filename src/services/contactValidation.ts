// Validates guest-supplied contact info for the web widget's confirmation-
// channel consent flow (agent/tools.ts's set_confirmation_channel) — see
// "Demo polish" in docs/audits/aurum-hardening-report.md. A caught defect
// during testing: "555-0100" (only 7 digits, no area code at all) was
// accepted as a phone number with no validation in place at all before this.

/**
 * Normalizes a US phone number to E.164 ("+15551234567"), or returns null
 * if it isn't a plausible real US number. Requires exactly 10 digits (an
 * optional leading country code "1" is stripped first) and rejects the
 * NANPA-reserved fictional range 555-0100 through 555-0199 (the exact shape
 * of the invalid test number caught in testing) plus the standard NANP rule
 * that an area code or exchange can't start with 0 or 1.
 */
export function normalizeUsPhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  if (digits.length !== 10) return null;

  const areaCode = digits.slice(0, 3);
  const exchange = digits.slice(3, 6);
  const line = digits.slice(6, 8);

  if (areaCode[0] === "0" || areaCode[0] === "1") return null;
  if (exchange[0] === "0" || exchange[0] === "1") return null;
  // NANPA's own reserved-for-fiction block, regardless of area code —
  // exactly what "555-0100" is an instance of.
  if (exchange === "555" && line === "01") return null;

  return `+1${digits}`;
}

/** Deliberately simple — this only needs to reject obvious junk before an email actually gets sent, not fully validate per RFC 5322. */
export function normalizeEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}
