import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import defaultTables from "./data/tables.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const db = new Database(path.join(__dirname, "..", "concierge.sqlite"));

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    phone TEXT PRIMARY KEY,
    history TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    guest_name TEXT,
    date TEXT NOT NULL,
    party_size INTEGER NOT NULL,
    table_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_payment',
    payment_url TEXT,
    stripe_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Persisted version of what flag_for_human reports. Previously this only
  -- went to console.log and vanished — the admin panel needs it to survive
  -- as an actionable queue.
  CREATE TABLE IF NOT EXISTS flags (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Venue policy text (hours, dress code, cancellation policy, etc.) as
  -- editable key/value pairs, so the admin Settings tab can change what the
  -- bot says without a code change or redeploy. Seeded once below from
  -- sane defaults.
  CREATE TABLE IF NOT EXISTS venue_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Table inventory/pricing, editable from the admin Settings tab. Seeded
  -- once below from data/tables.json.
  CREATE TABLE IF NOT EXISTS tables_config (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    min_spend INTEGER NOT NULL,
    description TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
`);

// ---- One-time seeding --------------------------------------------------

const DEFAULT_VENUE_SETTINGS: Record<string, string> = {
  hours: "Open Thursday through Saturday. Doors at 10pm, last entry 1am, we close at 2am.",
  agePolicy: "Every guest needs a valid government-issued photo ID for entry.",
  dressCode:
    "Upscale nightlife attire. No athletic wear, plain t-shirts, shorts, sneakers, or flat-brim/baseball caps. When in doubt, dress like you're going somewhere nice for dinner first.",
  arrivalPolicy:
    "Tables are held until 11:30pm. If a guest is running late, tell them to text and let us know — we'll do our best to hold it, but can't guarantee it after that time.",
  paymentPolicy:
    "The minimum spend amount is charged in full when the guest completes the payment link, and it's applied as a credit toward whatever they order that night — frame it as prepaying their tab, not an extra fee on top.",
  cancellationPolicy:
    "Cancellations made 48+ hours before the reservation date get a full refund. Inside 48 hours, the minimum spend is non-refundable, but we're happy to help reschedule to another available night instead.",
  walkInPolicy:
    "Guests without a table reservation are welcome as walk-ins on a first-come, first-served basis with a cover charge at the door (cover varies by night). VIP tables are reserved in advance through this text line only.",
  largeGroupPolicy:
    "For parties larger than 20 guests, requests for multiple tables together, or full venue buyouts/private events — don't try to book it directly. Let the guest know you're flagging it for the events team, and use the flag_for_human tool.",
  parkingInfo: "There's no dedicated valet or private lot — guests typically use nearby paid parking garages or street parking.",
  musicInfo:
    "Expect a mix of hip-hop, R&B, and open format from our resident DJs. Specific lineups and any special guest DJs vary by night — if a guest asks about a specific night's lineup, let them know you'll flag it for the team to confirm.",
  otherPolicies: "No outside food or beverages. Bag checks may apply at the door.",
};

function seedVenueSettingsIfEmpty() {
  const { c } = db.prepare(`SELECT COUNT(*) as c FROM venue_settings`).get() as { c: number };
  if (c > 0) return;
  const insert = db.prepare(`INSERT INTO venue_settings (key, value) VALUES (?, ?)`);
  const tx = db.transaction((entries: [string, string][]) => {
    for (const [key, value] of entries) insert.run(key, value);
  });
  tx(Object.entries(DEFAULT_VENUE_SETTINGS));
}
seedVenueSettingsIfEmpty();

function seedTablesConfigIfEmpty() {
  const { c } = db.prepare(`SELECT COUNT(*) as c FROM tables_config`).get() as { c: number };
  if (c > 0) return;
  const insert = db.prepare(
    `INSERT INTO tables_config (id, name, capacity, min_spend, description, sort_order)
     VALUES (@id, @name, @capacity, @min_spend, @description, @sort_order)`
  );
  const tx = db.transaction((rows: any[]) => {
    for (const row of rows) insert.run(row);
  });
  tx(
    (defaultTables as any[]).map((t, i) => ({
      id: t.id,
      name: t.name,
      capacity: t.capacity,
      min_spend: t.minSpend,
      description: t.description,
      sort_order: i,
    }))
  );
}
seedTablesConfigIfEmpty();

export type ConversationMessage = {
  role: "user" | "assistant";
  content: unknown;
};

export function loadConversation(phone: string): ConversationMessage[] {
  const row = db.prepare("SELECT history FROM conversations WHERE phone = ?").get(phone) as
    | { history: string }
    | undefined;
  if (!row) return [];
  return JSON.parse(row.history);
}

export function saveConversation(phone: string, history: ConversationMessage[]) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversations (phone, history, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at`
  ).run(phone, JSON.stringify(history), now);
}

export type TranscriptMessage = { role: "user" | "assistant"; text: string };

/**
 * Turns a raw stored conversation (which interleaves real guest/bot text
 * with tool_use/tool_result plumbing) into just the plain-text turns a
 * human would want to read — used by both the widget's history-restore
 * endpoint and the admin conversation viewer, so the filtering logic only
 * lives in one place.
 */
export function getConversationTranscript(channelId: string): TranscriptMessage[] {
  const history = loadConversation(channelId);
  const out: TranscriptMessage[] = [];
  for (const m of history) {
    if (m.role === "user") {
      if (typeof m.content === "string" && m.content.trim()) {
        out.push({ role: "user", text: m.content });
      }
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = (m.content as any[])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text) out.push({ role: "assistant", text });
    }
  }
  return out;
}

export type ConversationSummary = {
  channelId: string;
  channel: "sms" | "web";
  displayId: string;
  messageCount: number;
  lastMessageAt: string;
  lastMessagePreview: string;
};

/** One row per guest/session, newest activity first — the admin Conversations list. */
export function listConversationSummaries(): ConversationSummary[] {
  const rows = db
    .prepare(`SELECT phone, history, updated_at FROM conversations ORDER BY updated_at DESC`)
    .all() as { phone: string; history: string; updated_at: string }[];

  return rows.map((r) => {
    const channel: "sms" | "web" = r.phone.startsWith("web:") ? "web" : "sms";
    const displayId = channel === "web" ? r.phone.slice(4) : r.phone;
    const transcript = getConversationTranscript(r.phone);
    const last = transcript[transcript.length - 1];
    return {
      channelId: r.phone,
      channel,
      displayId,
      messageCount: transcript.length,
      lastMessageAt: r.updated_at,
      lastMessagePreview: last ? last.text.slice(0, 140) : "",
    };
  });
}

export type Booking = {
  id: string;
  phone: string;
  guest_name: string | null;
  date: string;
  party_size: number;
  table_id: string;
  amount_cents: number;
  status: string;
  payment_url: string | null;
  stripe_session_id: string | null;
  created_at: string;
  updated_at: string;
};

export function countActiveBookings(date: string, tableId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM bookings
       WHERE date = ? AND table_id = ? AND status IN ('pending_payment', 'confirmed')`
    )
    .get(date, tableId) as { count: number };
  return row.count;
}

export function createBooking(booking: Omit<Booking, "created_at" | "updated_at">) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bookings
      (id, phone, guest_name, date, party_size, table_id, amount_cents, status, payment_url, stripe_session_id, created_at, updated_at)
     VALUES (@id, @phone, @guest_name, @date, @party_size, @table_id, @amount_cents, @status, @payment_url, @stripe_session_id, @now, @now)`
  ).run({ ...booking, now });
}

export function updateBooking(id: string, fields: Partial<Booking>) {
  const now = new Date().toISOString();
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE bookings SET ${setClause}, updated_at = @now WHERE id = @id`).run({
    ...fields,
    id,
    now,
  });
}

export function getBooking(id: string): Booking | undefined {
  return db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Booking | undefined;
}

/** All bookings for the admin Bookings tab, optionally filtered by status and/or a free-text search. */
export function listBookings(filters?: { status?: string; search?: string }): Booking[] {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filters?.status) {
    clauses.push(`status = ?`);
    params.push(filters.status);
  }
  if (filters?.search) {
    clauses.push(`(phone LIKE ? OR guest_name LIKE ? OR table_id LIKE ? OR id LIKE ?)`);
    const like = `%${filters.search}%`;
    params.push(like, like, like, like);
  }
  let query = `SELECT * FROM bookings`;
  if (clauses.length) query += ` WHERE ` + clauses.join(" AND ");
  query += ` ORDER BY created_at DESC`;
  return db.prepare(query).all(...params) as Booking[];
}

export type OverviewStats = {
  totalBookings: number;
  pendingBookings: number;
  confirmedBookings: number;
  cancelledBookings: number;
  confirmedRevenueCents: number;
  totalConversations: number;
  openFlags: number;
};

/** Headline numbers for the admin Overview tab. */
export function getOverviewStats(): OverviewStats {
  const count = (sql: string, ...params: any[]) => (db.prepare(sql).get(...params) as { c: number }).c;
  const sum = (sql: string, ...params: any[]) => (db.prepare(sql).get(...params) as { s: number | null }).s ?? 0;
  return {
    totalBookings: count(`SELECT COUNT(*) c FROM bookings`),
    pendingBookings: count(`SELECT COUNT(*) c FROM bookings WHERE status = 'pending_payment'`),
    confirmedBookings: count(`SELECT COUNT(*) c FROM bookings WHERE status = 'confirmed'`),
    cancelledBookings: count(`SELECT COUNT(*) c FROM bookings WHERE status = 'cancelled'`),
    confirmedRevenueCents: sum(`SELECT COALESCE(SUM(amount_cents),0) s FROM bookings WHERE status = 'confirmed'`),
    totalConversations: count(`SELECT COUNT(*) c FROM conversations`),
    openFlags: count(`SELECT COUNT(*) c FROM flags WHERE status = 'open'`),
  };
}

// ---- Flags (persisted flag_for_human requests) -------------------------

export type Flag = {
  id: string;
  phone: string;
  summary: string;
  status: "open" | "resolved";
  created_at: string;
  updated_at: string;
};

export function createFlag(phone: string, summary: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO flags (id, phone, summary, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)`
  ).run(randomUUID(), phone, summary, now, now);
}

export function listFlags(status?: string): Flag[] {
  if (status) {
    return db.prepare(`SELECT * FROM flags WHERE status = ? ORDER BY created_at DESC`).all(status) as Flag[];
  }
  return db.prepare(`SELECT * FROM flags ORDER BY created_at DESC`).all() as Flag[];
}

export function resolveFlag(id: string): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE flags SET status = 'resolved', updated_at = ? WHERE id = ?`).run(now, id);
}

// ---- Venue settings (policy text shown to the bot) ----------------------

/** All policy key/value pairs, in original seed order. */
export function getVenueSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM venue_settings ORDER BY rowid ASC`).all() as {
    key: string;
    value: string;
  }[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export function setVenueSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO venue_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// ---- Table inventory/pricing ---------------------------------------------

export type TableConfig = {
  id: string;
  name: string;
  capacity: number;
  min_spend: number;
  description: string;
  sort_order: number;
};

export function listTablesConfig(): TableConfig[] {
  return db.prepare(`SELECT * FROM tables_config ORDER BY sort_order ASC, name ASC`).all() as TableConfig[];
}

export function upsertTableConfig(t: TableConfig): void {
  db.prepare(
    `INSERT INTO tables_config (id, name, capacity, min_spend, description, sort_order)
     VALUES (@id, @name, @capacity, @min_spend, @description, @sort_order)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       capacity = excluded.capacity,
       min_spend = excluded.min_spend,
       description = excluded.description,
       sort_order = excluded.sort_order`
  ).run(t);
}

export function deleteTableConfig(id: string): void {
  db.prepare(`DELETE FROM tables_config WHERE id = ?`).run(id);
}
