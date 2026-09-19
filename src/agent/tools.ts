import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import {
  countActiveBookings,
  countRecentSmsConsents,
  createBooking,
  createFlag,
  getBooking,
  listTablesConfig,
  recordSmsConsent,
  updateBooking,
} from "../db.js";
import { createPaymentLink } from "../services/stripe.js";
import { normalizeEmail, normalizeUsPhone } from "../services/contactValidation.js";
import { SMS_CONFIRMATION_DISCLOSURE, tryRecordWebSmsConfirmationByIp } from "./guards.js";

type Table = { id: string; name: string; capacity: number; minSpend: number; deposit: number; description: string };

// Read fresh from the DB on every call (not cached) so a table edited or
// added in the admin Settings tab is usable immediately.
function getTables(): Table[] {
  return listTablesConfig().map((t) => ({
    id: t.id,
    name: t.name,
    capacity: t.capacity,
    minSpend: t.min_spend,
    deposit: t.deposit,
    description: t.description,
  }));
}

const BASE_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "get_table_options",
    description:
      "Returns the full list of table tiers with capacity, minimum spend, and description. Use this to answer general pricing/capacity questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_availability",
    description:
      "Checks how many tables of each tier are still available for a given date, given a limited nightly inventory per tier.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format." },
        party_size: { type: "number", description: "Number of guests in the party." },
      },
      required: ["date"],
    },
  },
  {
    name: "start_booking",
    description:
      "Creates a pending booking for a specific table tier and date, and generates a payment link for the minimum spend. Only call this after the guest has explicitly confirmed the date, party size, table tier, and name.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format." },
        party_size: { type: "number" },
        table_id: { type: "string", description: "One of the table ids from get_table_options." },
        guest_name: { type: "string" },
        // Optional on the web channel — a web guest is no longer asked for
        // a phone number up front; they only give one if/when they later
        // choose "text" via set_confirmation_channel. Still always present
        // for an SMS-channel booking, since claude.ts forces the guest's
        // own real number onto this field before the tool ever runs.
        phone: {
          type: "string",
          description:
            "The guest's phone number, in E.164 format. Omit on the web widget unless the guest has already volunteered one.",
        },
      },
      required: ["date", "party_size", "table_id", "guest_name"],
    },
  },
  {
    name: "flag_for_human",
    description:
      "Use this when the guest needs something a staff member must handle (large events, complaints, refunds, special requests). Logs the request for the team.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string" },
        summary: { type: "string", description: "Short summary of what the guest needs." },
      },
      required: ["phone", "summary"],
    },
  },
];

// Only offered on the web channel — an SMS-channel guest is already texting
// us from their own real number and keeps getting confirmations the way
// they always have (see agent/systemPrompt.ts and stripeWebhook.ts's
// confirmBooking()), so this tool would never have anything to do there.
// Excluding it entirely (rather than just instructing the model not to use
// it) means an SMS conversation structurally cannot reach this code path.
const SET_CONFIRMATION_CHANNEL_TOOL: Anthropic.Tool = {
  name: "set_confirmation_channel",
  description:
    "Records how a WEB guest wants their booking confirmation delivered once payment completes. Call this once, right after start_booking, after the guest has answered whether they want it by text or email (or declined both). For channel 'sms', only offer this at all if the system prompt says texting is currently available, and show the required disclosure sentence to the guest BEFORE they choose — this call validates and normalizes whatever phone number they give, it does not display the disclosure itself. For channel 'email', pass a real email address. For channel 'none', omit contact.",
  input_schema: {
    type: "object",
    properties: {
      booking_id: { type: "string" },
      channel: { type: "string", enum: ["sms", "email", "none"] },
      contact: {
        type: "string",
        description: "Phone number (channel=sms) or email address (channel=email). Omit for channel=none.",
      },
    },
    required: ["booking_id", "channel"],
  },
};

export function getToolDefinitions(channel: "sms" | "web"): Anthropic.Tool[] {
  return channel === "web" ? [...BASE_TOOL_DEFINITIONS, SET_CONFIRMATION_CHANNEL_TOOL] : BASE_TOOL_DEFINITIONS;
}

export async function runTool(name: string, input: any, channelId: string, ip?: string): Promise<any> {
  switch (name) {
    case "get_table_options":
      return { tables: getTables() };

    case "check_availability": {
      const { date, party_size } = input;
      const results = getTables().map((t) => {
        const booked = countActiveBookings(date, t.id);
        const remaining = Math.max(config.maxTablesPerTierPerNight - booked, 0);
        return {
          table_id: t.id,
          name: t.name,
          capacity: t.capacity,
          minSpend: t.minSpend,
          deposit: t.deposit,
          remaining_tonight: remaining,
          fits_party: party_size ? t.capacity >= party_size : true,
        };
      });
      return { date, results };
    }

    case "start_booking": {
      const { date, party_size, table_id, guest_name } = input;
      // On the web channel, a phone number is no longer collected up
      // front — the guest only gives one later if/when they choose "text"
      // for their confirmation (set_confirmation_channel below). Falling
      // back to the channel id itself here matches the existing "web:<uuid>
      // placeholder means no real phone yet" convention already relied on
      // elsewhere (see stripeWebhook.ts's confirmBooking()). An SMS-channel
      // call always has a real phone — claude.ts forces it onto this field.
      const phone: string = input.phone || channelId;
      const table = getTables().find((t) => t.id === table_id);
      if (!table) {
        return { success: false, reason: "unknown_table_id" };
      }
      const booked = countActiveBookings(date, table_id);
      if (booked >= config.maxTablesPerTierPerNight) {
        return { success: false, reason: "sold_out", table_id, date };
      }

      const bookingId = randomUUID();
      // Charges the DEPOSIT, not the full minimum spend — credited against
      // the minimum on the night (see venue_settings.paymentPolicy). The
      // full minimum is still recorded (min_spend_cents) purely for
      // display on the pay page/receipt; it is never charged directly.
      const depositCents = table.deposit * 100;
      const minSpendCents = table.minSpend * 100;

      createBooking({
        id: bookingId,
        phone,
        guest_name,
        date,
        party_size,
        table_id,
        amount_cents: depositCents,
        min_spend_cents: minSpendCents,
        status: "pending_payment",
        payment_url: null,
        stripe_session_id: null,
        channel_id: channelId,
        confirmation_channel: null,
        confirmation_contact: null,
      });

      const payment = await createPaymentLink({
        bookingId,
        amountCents: depositCents,
        description: `${table.name} deposit - ${date} - ${config.venueName}`,
        customerPhone: phone,
      });

      updateBooking(bookingId, {
        payment_url: payment.url,
        stripe_session_id: payment.sessionId,
      });

      return {
        success: true,
        booking_id: bookingId,
        table_name: table.name,
        date,
        party_size,
        min_spend_usd: table.minSpend,
        deposit_usd: table.deposit,
        balance_usd: table.minSpend - table.deposit,
        payment_url: payment.url,
      };
    }

    case "flag_for_human": {
      createFlag(input.phone, input.summary);
      console.log(`\n[NEEDS HUMAN] ${input.phone}: ${input.summary}\n`);
      return { success: true, flagged: true };
    }

    case "set_confirmation_channel": {
      const { booking_id, channel, contact } = input;
      const booking = getBooking(booking_id);
      if (!booking) {
        return { success: false, reason: "unknown_booking" };
      }

      if (channel === "none") {
        updateBooking(booking_id, { confirmation_channel: "chat_only", confirmation_contact: null });
        return { success: true, channel: "chat_only" };
      }

      if (channel === "email") {
        const email = normalizeEmail(contact);
        if (!email) return { success: false, reason: "invalid_email" };
        updateBooking(booking_id, { confirmation_channel: "email", confirmation_contact: email });
        return { success: true, channel: "email" };
      }

      if (channel === "sms") {
        // Defense in depth — the tool's own description tells the model
        // this is only ever offered when texting is available, but the
        // system prompt is a suggestion a determined guest could try to
        // talk around; this check can't be.
        if (!config.webSmsOptIn) {
          updateBooking(booking_id, { confirmation_channel: "chat_only", confirmation_contact: null });
          return { success: false, reason: "sms_not_offered", fallback: "chat_only" };
        }

        const phone = normalizeUsPhone(contact);
        if (!phone) {
          return { success: false, reason: "invalid_phone" };
        }

        // Both throttles fall back to the same safe outcome — chat-only —
        // rather than an error the model has to improvise a response to.
        const ipOk = ip ? tryRecordWebSmsConfirmationByIp(ip) : true;
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const recentForPhone = countRecentSmsConsents(phone, oneDayAgo);
        if (!ipOk || recentForPhone > 0) {
          updateBooking(booking_id, { confirmation_channel: "chat_only", confirmation_contact: null });
          return { success: false, reason: "rate_limited", fallback: "chat_only" };
        }

        // Recorded only now, at the moment we're actually about to honor
        // it — never for a declined/throttled/invalid attempt. This row is
        // both the TCPA-style consent proof and the persisted counter the
        // 24h-per-phone throttle above reads back.
        recordSmsConsent({ phone, channelId, disclosureText: SMS_CONFIRMATION_DISCLOSURE });
        updateBooking(booking_id, { confirmation_channel: "sms", confirmation_contact: phone });
        return { success: true, channel: "sms" };
      }

      return { success: false, reason: "invalid_channel" };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
