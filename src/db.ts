import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
`);

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
