import "dotenv/config";

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(env("PORT", "3000")),
  baseUrl: env("BASE_URL", "http://localhost:3000"),

  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  claudeModel: env("CLAUDE_MODEL", "claude-sonnet-4-5"),

  twilio: {
    accountSid: env("TWILIO_ACCOUNT_SID"),
    authToken: env("TWILIO_AUTH_TOKEN"),
    fromNumber: env("TWILIO_FROM_NUMBER"),
    // Optional. When the sending number is A2P 10DLC-registered (US long
    // codes usually are), Twilio requires outbound application messages to
    // go out via the Messaging Service that carries the campaign
    // registration, not a bare "from" number — sending with just
    // TWILIO_FROM_NUMBER once the number belongs to a registered campaign
    // fails with error 30034. Set this to that Messaging Service's SID
    // (starts with "MG...") to send through it instead; leave blank to keep
    // sending from TWILIO_FROM_NUMBER directly (fine for numbers that were
    // never put in a Messaging Service / don't need 10DLC registration).
    messagingServiceSid: env("TWILIO_MESSAGING_SERVICE_SID"),
  },
  get twilioEnabled() {
    return Boolean(this.twilio.accountSid && this.twilio.authToken && this.twilio.fromNumber);
  },

  stripe: {
    secretKey: env("STRIPE_SECRET_KEY"),
    webhookSecret: env("STRIPE_WEBHOOK_SECRET"),
    // Safe to expose client-side (unlike the secret key) — needed by the
    // embedded checkout page (routes/checkout.ts) to initialize Stripe.js
    // in the guest's browser.
    publishableKey: env("STRIPE_PUBLISHABLE_KEY"),
  },
  get stripeEnabled() {
    return Boolean(this.stripe.secretKey);
  },

  resend: {
    apiKey: env("RESEND_API_KEY"),
    emailFrom: env("EMAIL_FROM"),
  },
  get resendEnabled() {
    return Boolean(this.resend.apiKey && this.resend.emailFrom);
  },

  // Guest-facing SMS confirmations (as opposed to the staff/venue's own
  // Twilio number receiving inbound texts, which is unaffected by this) are
  // off by default until the venue's Twilio campaign registration covers
  // this use — see docs/audits/aurum-hardening-report.md's "Demo polish"
  // section. When false, the web widget must never offer or mention text as
  // a confirmation option at all — see agent/systemPrompt.ts and
  // agent/tools.ts's set_confirmation_channel.
  webSmsOptIn: env("WEB_SMS_OPT_IN", "false").toLowerCase() === "true",
  // A web-originated confirmation text is a real, consent-gated send (see
  // "Demo polish" in the hardening report) — this caps how many one IP can
  // trigger per hour, on top of the per-phone 24h cap enforced from the
  // persisted sms_consents table (agent/tools.ts). Deliberately hardcoded,
  // not env-configurable, like every other fixed abuse-guard number below.
  maxWebSmsConfirmationsPerIpPerHour: 3,

  venueName: env("VENUE_NAME", "The Venue"),
  maxTablesPerTierPerNight: Number(env("MAX_TABLES_PER_TIER_PER_NIGHT", "3")),

  // Optional link to a bottle-service/VIP menu page. Empty string means
  // "no menu page yet" — the bot falls back to describing pricing verbally.
  menuUrl: env("MENU_URL", ""),

  // Shared password for the /admin console. Empty means the admin panel is
  // fully locked out (see routes/admin.ts) rather than falling back to an
  // insecure default — you must set this explicitly before /admin works.
  adminPassword: env("ADMIN_PASSWORD", ""),

  // Cost/abuse guards — see docs/audits/aurum-hardening-report.md. This app
  // is a public marketing demo, not a real venue's paid product; these
  // numbers are deliberately generous backstops against runaway spend, not
  // a product limit.
  maxMessageLength: 800,
  maxConversationTurns: 25,
  newWebConversationsPerIpPerHour: 5,
  newSmsConversationsPerPhonePerHour: 5,
  demoDailyModelCalls: Number(env("DEMO_DAILY_MODEL_CALLS", "2000")),

  // The origins allowed to call /api/chat, /api/chat/history, and
  // /api/chat/stream from a browser — the marketing sites that actually
  // embed this widget, plus localhost for local development. Twilio/Stripe
  // webhooks are server-to-server calls with no Origin header and are
  // unaffected by this — see server.ts.
  allowedChatOrigins: [
    "https://concierge-platform.onrender.com",
    "https://afterset.ai",
    "https://www.afterset.ai",
  ],
};

// This is a public, unauthenticated demo instance embedded on a marketing
// site — it must never be able to move real money. Refusing to start with a
// live secret key is a hard stop, not a warning: a demo running with live
// keys is exactly the "nothing in the demo may take real money" guarantee
// broken, and failing loudly at boot is far safer than hoping every code
// path that touches Stripe remembers to check this itself.
if (config.stripe.secretKey.startsWith("sk_live_")) {
  console.error(
    "FATAL: STRIPE_SECRET_KEY is a live-mode key (starts with sk_live_). " +
      "This app is a public demo and must never be able to charge a real card. " +
      "Use a test-mode key (sk_test_...) or leave it unset to run the demo pay page."
  );
  process.exit(1);
}
