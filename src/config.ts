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
  },
  get twilioEnabled() {
    return Boolean(this.twilio.accountSid && this.twilio.authToken && this.twilio.fromNumber);
  },

  stripe: {
    secretKey: env("STRIPE_SECRET_KEY"),
    webhookSecret: env("STRIPE_WEBHOOK_SECRET"),
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
