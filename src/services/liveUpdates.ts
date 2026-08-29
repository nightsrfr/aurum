import type { Response } from "express";

/**
 * In-memory registry of open Server-Sent-Events connections from the
 * website chat widget, keyed by channelId ("web:<sessionId>"). This is what
 * lets an admin's "jump in" staff reply appear in an already-open guest
 * chat window immediately, instead of only showing up the next time that
 * page loads or the widget history endpoint is polled.
 *
 * Deliberately in-memory and per-process — this app runs as a single Node
 * server, so a plain Map is sufficient. If this is ever scaled to run as
 * multiple instances behind a load balancer, this needs to move to a
 * shared pub/sub (e.g. Redis) so a staff reply handled by one instance
 * still reaches a guest whose SSE connection landed on a different one.
 */
const subscribers = new Map<string, Set<Response>>();

/** Registers an open SSE response for a channel. Returns an unsubscribe function. */
export function subscribe(channelId: string, res: Response): () => void {
  let set = subscribers.get(channelId);
  if (!set) {
    set = new Set();
    subscribers.set(channelId, set);
  }
  set.add(res);
  return () => {
    set!.delete(res);
    if (set!.size === 0) subscribers.delete(channelId);
  };
}

export type LiveMessage = { role: "assistant"; text: string; source: "staff" };

/**
 * Pushes a message to every open connection for a channel right now.
 * Returns true if at least one connection actually received it (i.e. the
 * guest currently has the chat open), false if there was nobody listening
 * — the caller uses that to report honestly whether delivery was instant.
 */
export function publish(channelId: string, message: LiveMessage): boolean {
  const set = subscribers.get(channelId);
  if (!set || set.size === 0) return false;
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      // Connection already dropped on the client side; its own "close"
      // handler will unsubscribe it shortly, nothing to do here.
    }
  }
  return true;
}
