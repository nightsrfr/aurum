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
};
