# Nightclub SMS Concierge — Prototype

An AI concierge that guests text to ask about VIP tables, get pricing, and book +
pay for a table, powered by Claude (Anthropic), Twilio SMS, and Stripe.

Everything runs in **demo mode** out of the box — you only need an Anthropic API
key to test the full conversation + booking flow. Twilio and Stripe are optional
until you're ready to go live.

## What's in here

```
src/
  data/tables.json       mock table inventory (tiers, capacity, min spend)
  db.ts                  SQLite storage for conversations + bookings
  agent/
    systemPrompt.ts       the concierge's persona + house rules
    tools.ts              tool implementations Claude can call
    claude.ts             the tool-use loop (Claude <-> tools <-> reply)
  services/
    twilio.ts             sends SMS (or console.logs it in demo mode)
    stripe.ts             creates a payment link (or demo page)
  routes/
    sms.ts                Twilio inbound-SMS webhook
    stripeWebhook.ts       Stripe payment-confirmation webhook
    demo.ts                fake "pay now" page for testing without Stripe
  server.ts               Express app
  cli.ts                  terminal chat tester (no Twilio needed)
```

## 1. Install

```bash
npm install
cp .env.example .env
```

Add your `ANTHROPIC_API_KEY` to `.env`. Everything else can stay blank for now.

## 2. Test the conversation in your terminal (no accounts needed)

```bash
npm run chat
```

Try things like:
- "how much for a table for 8 people this saturday"
- "what's the dress code"
- "ok let's book the VIP booth for 10 people on 2026-09-05, name's Alex"

Claude will use the `get_table_options` / `check_availability` / `start_booking`
tools, and in demo mode will hand you a local `http://localhost:.../demo/pay/...`
link instead of a real Stripe checkout. Open it, click "Confirm Payment (Demo)",
and you'll see the confirmation text printed to the console (since Twilio isn't
configured yet).

## 3. Run it as a real server

```bash
npm run dev
```

This starts the Express server (default port 3000) with the same agent, exposed
over HTTP so Twilio can reach it.

## 4. Wire up real text messaging (Twilio)

1. Create a free Twilio account and buy/trial a phone number.
2. Put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` in `.env`.
3. Expose your local server publicly for testing: `ngrok http 3000`.
4. In the Twilio console, set the phone number's "A message comes in" webhook to
   `https://<your-ngrok-or-deployed-url>/webhook/sms` (HTTP POST).
5. Text the Twilio number from your phone — you're now talking to the AI agent.

## 5. Wire up real payments (Stripe)

1. Create a free Stripe account (test mode is instant, no approval needed).
2. Put your test `STRIPE_SECRET_KEY` in `.env`. Bookings will now generate real
   Stripe Checkout links instead of the demo page.
3. In the Stripe dashboard, add a webhook endpoint pointing to
   `https://<your-url>/webhook/stripe` listening for `checkout.session.completed`,
   and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Test with Stripe's test card `4242 4242 4242 4242`, any future expiry/CVC.

## 6. Deploy

Any Node host works (Render, Fly.io, Railway, a small VPS). Set the same env
vars there, point `BASE_URL` at the deployed URL, and point the Twilio/Stripe
webhooks at it instead of ngrok.

## Customizing for your venue

- Edit `src/data/tables.json` for your real table tiers, capacity, and pricing.
- Edit `src/agent/systemPrompt.ts` for your venue name, house rules, dress code,
  hours, and tone.
- `MAX_TABLES_PER_TIER_PER_NIGHT` in `.env` is a placeholder availability model
  (N tables per tier per night). Swap `check_availability` / `start_booking` in
  `src/agent/tools.ts` for a real reservation system or calendar once you have
  one.
- Conversation history and bookings are stored in `concierge.sqlite` (created
  automatically). Fine for a prototype; swap for Postgres when you scale.

## Where this fits in the bigger picture

This is phase 1 (texting) of the two-part system:

1. **SMS concierge** (this repo) — guests text a number, Claude answers
   questions and books + charges a table.
2. **Website concierge** (next phase) — a chat widget on your site backed by
   the *same* agent core (`src/agent/`). You'd reuse `systemPrompt.ts` and
   `tools.ts` as-is, add a small web chat UI (widget + `/webhook/web` endpoint
   instead of `/webhook/sms`), and swap the payment flow for Stripe Checkout /
   Payment Element embedded directly on the page instead of a texted link.
   Because the agent logic and tools are already decoupled from Twilio in this
   codebase, most of phase 2 is front-end work plus one new route.
