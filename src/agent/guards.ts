import { config } from "../config.js";
import { incrementDailyModelCallCount, getDailyModelCallCount } from "../db.js";

// Cost/abuse guards for a public, unauthenticated marketing demo — see
// docs/audits/aurum-hardening-report.md. These are deliberately generous
// backstops against a runaway bill or a scripted abuse attempt, not a
// product limit; nothing here should ever bind on a real, curious visitor
// having one normal conversation.

export const TOO_LONG_MESSAGE = `That message is a bit long for the demo — could you shorten it to under ${config.maxMessageLength} characters?`;
export const TURN_CAP_MESSAGE =
  "Thanks for chatting! This demo caps out here — text (202) 875-8563 any time to keep going with the real thing.";
export const DAILY_CAP_MESSAGE = "The demo is resting — text (202) 875-8563 tomorrow.";
export const RATE_LIMITED_MESSAGE =
  "This demo is getting a lot of visitors from your network right now — try again in a bit, or text (202) 875-8563.";

// The exact disclosure the bot must show BEFORE a web guest chooses to
// receive their confirmation by text (config.webSmsOptIn gates whether text
// is even offered at all — see agent/systemPrompt.ts). Recorded verbatim
// into sms_consents alongside the opt-in itself (agent/tools.ts's
// set_confirmation_channel) so the exact disclosure text shown is part of
// the consent record, not just described after the fact.
export const SMS_CONFIRMATION_DISCLOSURE =
  "You'll get one text with your confirmation. Msg & data rates may apply. Reply STOP to opt out.";

export function isMessageTooLong(text: string): boolean {
  return text.length > config.maxMessageLength;
}

/**
 * Counts real guest turns in a stored history — excludes the synthetic
 * tool-result "user" messages the agent loop also pushes onto history
 * during a tool-calling round trip (those always have array content, an
 * actual guest message is always a plain string). Exported so both
 * claude.ts (the turn-cap check) and its own tests can share one
 * definition of "a real turn."
 */
export function countRealUserTurns(history: { role: string; content: unknown }[]): number {
  return history.filter((m) => m.role === "user" && typeof m.content === "string").length;
}

export function hasReachedTurnCap(history: { role: string; content: unknown }[]): boolean {
  return countRealUserTurns(history) >= config.maxConversationTurns;
}

/**
 * Call once immediately before each real `anthropic.messages.create()` —
 * never after. Returns true (and counts the call) if today's global cap
 * hasn't been reached yet; false means don't call the model at all.
 */
export function tryConsumeDailyModelCall(): boolean {
  if (getDailyModelCallCount() >= config.demoDailyModelCalls) return false;
  incrementDailyModelCallCount();
  return true;
}

// ---- Per-IP / per-phone "new conversation" rate limiting ------------------
//
// In-memory, not persisted to SQLite — a Render restart clearing these is
// fine, since (like every guard on this page) they're a generous backstop
// nobody should hit in normal use, not a real limit worth surviving a
// restart for. Keyed by one fixed one-hour window per key, lazily reset the
// next time that key is checked rather than by a timer.

type Bucket = { windowStart: number; count: number };
const HOUR_MS = 60 * 60 * 1000;

function checkAndIncrement(buckets: Map<string, Bucket>, key: string, limit: number): boolean {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= HOUR_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count++;
  return true;
}

const ipBuckets = new Map<string, Bucket>();
const phoneBuckets = new Map<string, Bucket>();
const webSmsConfirmationIpBuckets = new Map<string, Bucket>();

/** true = this IP may start a new web conversation this hour (an ongoing conversation's later messages never call this). */
export function tryStartWebConversation(ip: string): boolean {
  return checkAndIncrement(ipBuckets, ip, config.newWebConversationsPerIpPerHour);
}

/** true = this phone number may start a new SMS conversation this hour. */
export function tryStartSmsConversation(phone: string): boolean {
  return checkAndIncrement(phoneBuckets, phone, config.newSmsConversationsPerPhonePerHour);
}

/**
 * true = this IP may trigger a web-originated confirmation-text opt-in this
 * hour. In-memory (not persisted) — unlike the per-phone 24h throttle
 * (db.ts's countRecentSmsConsents, which has to survive a restart since 24h
 * is long relative to this demo's uptime), an hourly IP bucket resetting on
 * restart is the same acceptable tradeoff every other in-memory guard on
 * this page already makes.
 */
export function tryRecordWebSmsConfirmationByIp(ip: string): boolean {
  return checkAndIncrement(webSmsConfirmationIpBuckets, ip, config.maxWebSmsConfirmationsPerIpPerHour);
}

// Exposed for tests only, to reset state between cases without reaching
// into module-private Maps directly.
export function __resetRateLimitsForTests(): void {
  ipBuckets.clear();
  phoneBuckets.clear();
  webSmsConfirmationIpBuckets.clear();
}
