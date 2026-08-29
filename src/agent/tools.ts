import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { countActiveBookings, createBooking, createFlag, listTablesConfig, updateBooking } from "../db.js";
import { createPaymentLink } from "../services/stripe.js";

type Table = { id: string; name: string; capacity: number; minSpend: number; description: string };

// Read fresh from the DB on every call (not cached) so a table edited or
// added in the admin Settings tab is usable immediately.
function getTables(): Table[] {
  return listTablesConfig().map((t) => ({
    id: t.id,
    name: t.name,
    capacity: t.capacity,
    minSpend: t.min_spend,
    description: t.description,
  }));
}

export const toolDefinitions: Anthropic.Tool[] = [
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
        phone: { type: "string", description: "The guest's phone number, in E.164 format." },
      },
      required: ["date", "party_size", "table_id", "guest_name", "phone"],
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

export async function runTool(name: string, input: any, channelId: string): Promise<any> {
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
          remaining_tonight: remaining,
          fits_party: party_size ? t.capacity >= party_size : true,
        };
      });
      return { date, results };
    }

    case "start_booking": {
      const { date, party_size, table_id, guest_name, phone } = input;
      const table = getTables().find((t) => t.id === table_id);
      if (!table) {
        return { success: false, reason: "unknown_table_id" };
      }
      const booked = countActiveBookings(date, table_id);
      if (booked >= config.maxTablesPerTierPerNight) {
        return { success: false, reason: "sold_out", table_id, date };
      }

      const bookingId = randomUUID();
      const amountCents = table.minSpend * 100;

      createBooking({
        id: bookingId,
        phone,
        guest_name,
        date,
        party_size,
        table_id,
        amount_cents: amountCents,
        status: "pending_payment",
        payment_url: null,
        stripe_session_id: null,
        channel_id: channelId,
      });

      const payment = await createPaymentLink({
        bookingId,
        amountCents,
        description: `${table.name} - ${date} - ${config.venueName}`,
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
        amount_usd: table.minSpend,
        payment_url: payment.url,
      };
    }

    case "flag_for_human": {
      createFlag(input.phone, input.summary);
      console.log(`\n[NEEDS HUMAN] ${input.phone}: ${input.summary}\n`);
      return { success: true, flagged: true };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
