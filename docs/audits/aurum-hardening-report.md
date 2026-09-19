# Aurum hardening report

Covers making this repo safe to embed publicly on the Afterset marketing
site (concierge-platform), per the "Real AI demo on the marketing site"
instruction. This app was previously a single-operator prototype, reachable
only by whoever knew the webhook/API URLs; it's now embedded, unauthenticated,
on a public marketing site, so every guard here assumes a hostile visitor
will find and try to abuse it.

## 1. Security fixes

**`/webhook/sms` — Twilio signature validation (`src/routes/sms.ts`).**
Previously accepted any POST with the right shape, with no way to tell a
real Twilio request from a forged one — someone who found the URL could
puppet the agent (and the model spend behind it) as any phone number.
`isGenuineTwilioRequest()` now recomputes the expected signature via
`twilio.validateRequest(authToken, signature, url, params)` from the exact
URL Twilio would have posted to (`BASE_URL` + the request path) and the
parsed form body, and rejects with `403` on any mismatch — including when
`TWILIO_AUTH_TOKEN` itself isn't configured, since there's no way to
validate anything without it. Fails **closed**, not open.

**`/webhook/stripe` — refuses unsigned events (`src/routes/stripeWebhook.ts`).**
Previously fell back to `JSON.parse(req.body.toString())` — trusting the
raw body as a real Stripe event — whenever `STRIPE_WEBHOOK_SECRET` wasn't
set. That meant anyone who found the URL could POST a fake
`checkout.session.completed` event with any `bookingId` and have
`confirmBooking()` mark it paid and text the guest a "you're booked"
confirmation, with zero money ever moving. Now returns `400` immediately
when the secret is unset, before ever attempting to parse the body as a
trusted event — no code path left that treats an unsigned payload as real.

Both fixes are covered by real HTTP tests (`src/routes/sms.test.ts`,
`src/routes/stripeWebhook.test.ts`, `src/routes/stripeWebhook-configured.test.ts`):
a missing signature, a forged signature, and a genuinely correct signature
(computed with the SDK's own `twilio.getExpectedTwilioSignature()`, not
hand-rolled) for the SMS webhook; an unsigned event, a signed-but-wrong
signature, and the "secret configured, garbage signature" case for the
Stripe webhook.

## 2. Cost/abuse guards (none existed before this)

New module `src/agent/guards.ts`, wired into `src/agent/claude.ts` (the
turn cap and the daily model-call cap) and both public entry points
(`src/routes/chat.ts`, `src/routes/sms.ts` — message length and the
per-IP/per-phone new-conversation limits):

- **Message length ≤ 800 characters** — checked in both `/api/chat` and
  `/webhook/sms` before the message ever reaches `runAgent()`.
- **25 real guest turns per conversation**, then a fixed wrap-up reply
  ("...text (202) 875-8563 any time to keep going with the real thing").
  Checked in `runAgent()` itself, before the 26th turn's message is even
  sent to the model — `countRealUserTurns()` counts only plain-string
  guest messages, deliberately excluding the synthetic array-content
  "user" messages the tool-calling loop also pushes onto history.
- **5 new web conversations per IP per hour**, **5 new SMS conversations
  per phone per hour** — in-memory sliding buckets (`guards.ts`), checked
  only when a channel has *no* existing history yet; an already-running
  conversation's later messages are never rate-limited. Render restarting
  and clearing these is fine — they're a generous backstop, not a real
  limit anyone should hit in normal use.
- **Global daily cap on real model calls** (`DEMO_DAILY_MODEL_CALLS`,
  default 2000), persisted in a new `model_call_counters` SQLite table
  (survives a Render restart mid-day, unlike the in-memory rate limits
  above) so the cap can't quietly reset itself. Checked immediately before
  **every** `anthropic.messages.create()` call, not once per guest turn —
  a single turn can round-trip through the model more than once via tool
  use (checking availability, then booking), and each of those calls
  counts. Once reached, every further reply for the rest of the day is a
  fixed "The demo is resting — text (202) 875-8563 tomorrow" message with
  zero model calls, for any guest, on either channel.

Covered by `src/agent/guards.test.ts` (unit-level: length boundary, turn
counting excluding tool-result messages, the cap flipping at exactly 25,
the daily cap counting and refusing correctly, both rate limiters allowing
up to the limit and no further), `src/agent/claude.test.ts` (integration:
the 25th real turn still calls the mocked model, the 26th doesn't, and the
fixed reply is actually saved to history), and
`src/agent/claude-daily-cap.test.ts` (a separate process with
`DEMO_DAILY_MODEL_CALLS=2`, proving the 3rd call across any conversation
gets the fixed reply with the mocked model never invoked).

## 3. CORS restricted to the real embedding origins

Removed the global, wide-open `app.use(cors())` in `src/server.ts`.
`chatRouter` (`src/routes/chat.ts`) now applies its own `cors()`
middleware, scoped only to `/api/chat`, `/api/chat/history`, and
`/api/chat/stream`, allowing exactly `concierge-platform.onrender.com`,
`afterset.ai`, `www.afterset.ai`, and any `localhost`/`127.0.0.1` origin
for local development. Every other route (admin, pay pages, demo pages,
the Twilio/Stripe webhooks) is either same-origin browser navigation or a
server-to-server call with no `Origin` header — neither is affected by
CORS either way, so removing the global policy changes nothing for them.
This is a defense against a hostile third-party page silently draining
the demo's daily model-call budget through a visitor's own browser, not a
hard security boundary on its own (a non-browser client can always ignore
CORS entirely) — the guards in §2 are what actually bound the cost.
Covered by `src/routes/chat.test.ts`: an allowed origin is reflected back,
a disallowed origin is refused, localhost is allowed.

## 4. Deposit, not full minimum spend

**Schema** (`src/db.ts`): `tables_config` gained a `deposit` column
(whole dollars, matching `min_spend`'s own convention), backfilled for
every existing row via `defaultDepositForMinSpend()` — 25% of the
minimum, rounded to the nearest $50 (`$2,000` minimum → `$500` deposit,
matching the build instruction's own example exactly). `bookings` gained
`min_spend_cents`, recorded at booking time purely for display (the pay
page's minimum/deposit/balance breakdown); `amount_cents` — what's
actually charged — is now the deposit, never the full minimum.

**`start_booking`** (`src/agent/tools.ts`) charges `table.deposit`, not
`table.minSpend`, and returns `min_spend_usd`/`deposit_usd`/`balance_usd`
so the model can state all three. **The system prompt**
(`src/agent/systemPrompt.ts`) now instructs quoting "$[minSpend] minimum,
$[deposit] deposit to book, credited against your minimum" at every price
mention, and the booking-confirmation message is explicit that the link
only charges the deposit, with the balance due at the table. The
post-payment confirmation text (`src/routes/stripeWebhook.ts`) states the
real remaining balance, computed from the booking's own recorded minimum.

**Pay pages** (`src/routes/checkout.ts`, `src/routes/demo.ts`) previously
showed the raw `table_id` (e.g. "vip-booth-10 — 2026-09-05") and a single
"Minimum spend due" figure that was actually charging the full amount.
Both now share one helper, `bookingPaymentSummaryHtml()`
(`src/routes/paymentSummary.ts`), showing the real table **name**, the
minimum, the deposit actually being charged, and the remaining balance.

**Existing live database migrated, not just fresh seeds.** The old
`paymentPolicy`/`cancellationPolicy` text ("the minimum spend amount is
charged in full... non-refundable") would have directly contradicted the
new deposit behavior on a database that was already seeded before this
change. `migrateDepositPolicyTextIfUnedited()` (`src/db.ts`) compares each
value against the exact old default text and updates only an unedited
match to the new deposit-aware wording — a venue's own custom edit to
either field is never overwritten.

Covered by `src/db.test.ts` (the rounding formula against 5 real examples,
a fresh seed's deposits, the policy text migration, `upsertTableConfig`
persisting a real deposit) and `src/agent/tools.test.ts` (`start_booking`
charges the deposit in cents, records the minimum separately, and returns
all three dollar figures; `get_table_options`/`check_availability` both
expose the deposit alongside the minimum).

## 5. Never real money

`src/config.ts` now checks `STRIPE_SECRET_KEY` at module load and calls
`process.exit(1)` with a clear, loud error if it starts with `sk_live_` —
a public, unauthenticated demo embedded on a marketing site must never be
able to move a real card's money, and failing to even start is safer than
hoping every Stripe-touching code path remembers to check this itself.
Test-mode keys (`sk_test_...`) and no key at all (demo pay page) both
start normally. Covered by `src/config.test.ts`, which spawns a real
separate process per case (since the guard is a module-load-time exit,
not a function with a return value to assert on) and checks the exit
code and stderr for each of the three cases.

## 6. `widget.js`

- `data-launcher="none"`: skips rendering the floating launcher button
  entirely, for a page (like the Afterset marketing site) that opens the
  chat itself from its own buttons instead of showing a second floating
  button next to its own UI.
- `window.AftersetDemo = { open(prefill), close() }`: exposed
  unconditionally (not only with `data-launcher="none"`) — `open()` opens
  the panel and optionally pre-fills the input box with a suggested
  message (never auto-sent; the guest still presses send), `close()`
  closes it.
- `data-accent-color` and `data-venue-name` already existed and needed no
  change.
- Shadow DOM isolation is unchanged — nothing about either addition
  touches how the widget's markup/styles are isolated from the host page.

## Dependency note (and the deploy failure it caused)

`better-sqlite3` was originally bumped from `^11.3.0` to `^13.0.3`
(matching concierge-platform's own pinned version at the time) because the
older version has no prebuilt binary for this local dev machine's Node/OS
combination and falls back to compiling from source via node-gyp, which
needs a working Python toolchain that wasn't available here. That reasoning
only checked the local dev environment, though — **it never checked
against the Render service's own pinned Node version, and `^13.0.3` broke
the actual production deploy as a result.**

better-sqlite3 `13.0.0`+ declares `"engines": { "node": ">=22" }` — this
repo's own `package.json` (`"engines": { "node": "20.x" }`) and `.nodeversion`
file pin Render to Node 20.x, which is what its build actually provisions.
`npm install` doesn't hard-fail on an engines mismatch by default, but the
mismatch is real: the deployed process either failed at install/require
time or never came up cleanly, which is what Render reported as a failed
deploy on this commit. **This was found only after the deploy actually
failed on Render, not caught locally** — this repo's own dev machine runs
Node 24, so a plain `npm install && npm test` here never exercises the
Node-20 path Render's build actually uses, and nothing in this repo's own
`npm test`/`typecheck` run touches engine compatibility at all.

**Fixed by pinning `better-sqlite3` to `^12.11.1`** instead of `^13.x` —
the last line before the `>=22` requirement, and one that explicitly
declares support for `"20.x || 22.x || 23.x || 24.x || 25.x || 26.x"`
(checked directly against the published package's own `engines` field, not
assumed), so it matches Render's actual pinned Node 20.x while still
installing from a real prebuild (no node-gyp/Python fallback) on this dev
machine's Node 24 — verified by a clean reinstall here, `28/28` tests still
passing, and a clean `typecheck`. No API changes were needed either way —
better-sqlite3 keeps its synchronous API stable across all of 11.x/12.x/13.x.

**The general lesson:** a native-dependency version bump chosen to fix one
environment's install problem has to be checked against every environment
that will actually run it, not just the one that was broken at the time —
"prebuilds exist for my machine" and "this version's own declared engine
range covers the deploy target" are two different claims, and only the
first one was checked the first time.

## Test results

`npm test` (new `scripts/run-tests.mjs`, same "real recursive filesystem
walk of every `*.test.ts` under `src/`" convention as concierge-platform's
own test runner, not a maintained list): **28/28 passing**, in ~2 seconds,
with zero real network calls to Anthropic, Twilio, or Stripe anywhere in
the suite (every model/SMS/Stripe call a test path could reach is either
mocked or steered into that service's own demo-mode fallback).
`npm run typecheck`: clean. Both re-confirmed clean after the
better-sqlite3 downgrade above.

## Deploy

First push (`9d8907943fd5db7bed7184b089584e84e6ad6a54`) failed on Render —
see "Dependency note (and the deploy failure it caused)" above for the
root cause (better-sqlite3 `13.x` requiring Node `>=22` against this
service's own Node 20.x pin) and the fix (downgrading to `^12.11.1`, which
supports both). Fixed and re-pushed to `main` — see the port report in
concierge-platform (`docs/audits/real-demo-report.md`) for this repo's
follow-up commit hash and confirmation that Render redeployed it
successfully this time.
