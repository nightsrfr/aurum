import { config } from "../config.js";

/**
 * Sends a transactional email via Resend's HTTP API (raw fetch, no SDK —
 * same convention as services/twilio.ts). Falls back to a console-log demo
 * mode when RESEND_API_KEY/EMAIL_FROM aren't set, so the full booking +
 * payment + confirmation flow is testable before a real Resend account
 * exists — identical reasoning to Twilio/Stripe's own demo-mode fallbacks.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!config.resendEnabled) {
    console.log(`\n[DEMO EMAIL -> ${to}]\nSubject: ${subject}\n${text}\n`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.resend.emailFrom,
      to,
      subject,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}
