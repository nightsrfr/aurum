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

  venueName: env("VENUE_NAME", "The Venue"),
  maxTablesPerTierPerNight: Number(env("MAX_TABLES_PER_TIER_PER_NIGHT", "3")),

  // Optional link to a bottle-service/VIP menu page. Empty string means
  // "no menu page yet" — the bot falls back to describing pricing verbally.
  menuUrl: env("MENU_URL", ""),

  // Shared password for the /admin console. Empty means the admin panel is
  // fully locked out (see routes/admin.ts) rather than falling back to an
  // insecure default — you must set this explicitly before /admin works.
  adminPassword: env("ADMIN_PASSWORD", ""),
};
