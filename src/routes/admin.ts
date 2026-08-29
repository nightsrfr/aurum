import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { config } from "../config.js";
import {
  listBookings,
  getBooking,
  updateBooking,
  getOverviewStats,
  listConversationSummaries,
  getConversationTranscript,
  appendStaffMessage,
  listFlags,
  resolveFlag,
  getVenueSettings,
  setVenueSetting,
  listTablesConfig,
  upsertTableConfig,
  deleteTableConfig,
} from "../db.js";
import { sendSms } from "../services/twilio.js";

export const adminRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PAGES_DIR = path.join(__dirname, "..", "..", "admin-pages");

function sendPage(res: any, filename: string) {
  res.type("html").send(fs.readFileSync(path.join(ADMIN_PAGES_DIR, filename), "utf8"));
}

// ---- Auth ----------------------------------------------------------------
//
// Deliberately dependency-free: a signed, expiring cookie using Node's
// built-in crypto (HMAC) instead of pulling in cookie-parser + a session
// store for what is, for now, a single shared admin password. Good enough
// for a single-operator pilot; swap for real per-user accounts before this
// becomes a multi-tenant product.

const COOKIE_NAME = "concierge_admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(value: string): string {
  return crypto.createHmac("sha256", config.adminPassword).update(value).digest("hex");
}

function makeSessionCookie(): string {
  const expires = String(Date.now() + SESSION_TTL_MS);
  return `${expires}.${sign(expires)}`;
}

function isValidSession(value: string | undefined): boolean {
  if (!config.adminPassword || !value) return false;
  const dotIndex = value.indexOf(".");
  if (dotIndex === -1) return false;
  const expires = value.slice(0, dotIndex);
  const signature = value.slice(dotIndex + 1);
  // timingSafeEqual requires equal-length buffers, and a forged signature of
  // the wrong length would otherwise throw instead of just failing closed.
  const expected = sign(expires);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(expires) > Date.now();
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setSessionCookie(res: any) {
  const value = makeSessionCookie();
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}; SameSite=Lax`
  );
}

function clearSessionCookie(res: any) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function requireAdminPage(req: any, res: any, next: any) {
  const cookies = parseCookies(req.headers.cookie);
  if (isValidSession(cookies[COOKIE_NAME])) return next();
  res.redirect("/admin/login");
}

function requireAdminApi(req: any, res: any, next: any) {
  const cookies = parseCookies(req.headers.cookie);
  if (isValidSession(cookies[COOKIE_NAME])) return next();
  res.status(401).json({ error: "Not authenticated" });
}

adminRouter.get("/admin/login", (req, res) => {
  if (!config.adminPassword) {
    return res
      .type("html")
      .send(
        `<body style="font-family:sans-serif;max-width:480px;margin:80px auto;">
          <h2>Admin console not configured</h2>
          <p>Set an <code>ADMIN_PASSWORD</code> environment variable on this service, then reload this page.</p>
        </body>`
      );
  }
  sendPage(res, "login.html");
});

adminRouter.post("/admin/login", (req, res) => {
  const password = req.body?.password as string | undefined;
  if (!config.adminPassword) {
    return res.redirect("/admin/login");
  }
  const a = Buffer.from(password ?? "");
  const b = Buffer.from(config.adminPassword);
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (matches) {
    setSessionCookie(res);
    return res.redirect("/admin");
  }
  res.redirect("/admin/login?error=1");
});

adminRouter.post("/admin/logout", (req, res) => {
  clearSessionCookie(res);
  res.redirect("/admin/login");
});

adminRouter.get("/admin", requireAdminPage, (req, res) => {
  sendPage(res, "dashboard.html");
});

// ---- JSON API --------------------------------------------------------------

adminRouter.get("/admin/api/overview", requireAdminApi, (req, res) => {
  res.json(getOverviewStats());
});

// -- Bookings --

adminRouter.get("/admin/api/bookings", requireAdminApi, (req, res) => {
  const status = (req.query.status as string) || undefined;
  const search = (req.query.search as string) || undefined;
  res.json({ bookings: listBookings({ status, search }) });
});

adminRouter.post("/admin/api/bookings/:id/status", requireAdminApi, (req, res) => {
  const { id } = req.params;
  const { status } = req.body as { status?: string };
  const allowed = ["pending_payment", "confirmed", "cancelled"];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
  }
  const booking = getBooking(id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  updateBooking(id, { status });
  res.json({ success: true, booking: getBooking(id) });
});

// -- Conversations --

adminRouter.get("/admin/api/conversations", requireAdminApi, (req, res) => {
  res.json({ conversations: listConversationSummaries() });
});

adminRouter.get("/admin/api/conversations/:channelId", requireAdminApi, (req, res) => {
  // channelId arrives URL-encoded since it can be "web:<uuid>" or a raw
  // "+1XXXXXXXXXX" phone number, both of which need escaping in a URL path.
  const channelId = decodeURIComponent(req.params.channelId);
  res.json({ messages: getConversationTranscript(channelId) });
});

// Staff "jump in" reply: sends a message into an ongoing guest conversation
// as though it were a bot turn. For an SMS channel (channelId is the
// guest's phone number, not "web:...") it's actually delivered live over
// Twilio. For a web-widget conversation there's no live push channel to an
// already-open tab, so it only becomes visible next time the guest's page
// loads/reopens — the response says which happened so the UI can be honest
// about it instead of implying an SMS-style instant delivery.
adminRouter.post("/admin/api/conversations/:channelId/messages", requireAdminApi, async (req, res) => {
  const channelId = decodeURIComponent(req.params.channelId);
  const text = (req.body?.text as string | undefined)?.trim();
  if (!text) {
    return res.status(400).json({ error: "text is required" });
  }

  const messages = appendStaffMessage(channelId, text);

  const isWeb = channelId.startsWith("web:");
  let delivered: "sms" | "web-only" = "web-only";
  if (!isWeb) {
    try {
      await sendSms(channelId, text);
      delivered = "sms";
    } catch (err) {
      console.error(`Failed to send staff SMS reply to ${channelId}:`, err);
      return res.status(502).json({
        error: "Message was saved but the SMS failed to send. Check Twilio config/logs.",
        messages,
      });
    }
  }

  res.json({ success: true, delivered, messages });
});

// -- Flags (needs-follow-up queue) --

adminRouter.get("/admin/api/flags", requireAdminApi, (req, res) => {
  const status = (req.query.status as string) || undefined;
  res.json({ flags: listFlags(status) });
});

adminRouter.post("/admin/api/flags/:id/resolve", requireAdminApi, (req, res) => {
  resolveFlag(req.params.id);
  res.json({ success: true });
});

// -- Settings: venue policies + table inventory --

adminRouter.get("/admin/api/settings", requireAdminApi, (req, res) => {
  res.json({
    venueName: config.venueName,
    policies: getVenueSettings(),
    tables: listTablesConfig(),
  });
});

adminRouter.post("/admin/api/settings/policies", requireAdminApi, (req, res) => {
  const updates = req.body as Record<string, string>;
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ error: "Expected an object of policy key/value pairs" });
  }
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value === "string") setVenueSetting(key, value);
  }
  res.json({ success: true, policies: getVenueSettings() });
});

adminRouter.post("/admin/api/settings/tables", requireAdminApi, (req, res) => {
  const t = req.body as {
    id?: string;
    name?: string;
    capacity?: number;
    min_spend?: number;
    description?: string;
    sort_order?: number;
  };
  if (!t.id || !t.name || typeof t.capacity !== "number" || typeof t.min_spend !== "number" || !t.description) {
    return res.status(400).json({ error: "id, name, capacity, min_spend, and description are required" });
  }
  upsertTableConfig({
    id: t.id,
    name: t.name,
    capacity: t.capacity,
    min_spend: t.min_spend,
    description: t.description,
    sort_order: t.sort_order ?? 0,
  });
  res.json({ success: true, tables: listTablesConfig() });
});

adminRouter.delete("/admin/api/settings/tables/:id", requireAdminApi, (req, res) => {
  deleteTableConfig(req.params.id);
  res.json({ success: true, tables: listTablesConfig() });
});
