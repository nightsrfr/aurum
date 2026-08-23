/**
 * All the venue-specific facts the concierge relies on, kept separate from
 * the prompt wording so you can update policy without touching prose.
 * These are reasonable nightclub-industry defaults — review each line and
 * replace anything that doesn't match your actual venue before relying on
 * this for real guests.
 */
export const venueInfo = {
  hours:
    "Open Thursday through Saturday. Doors at 10pm, last entry 1am, we close at 2am.",

  agePolicy:
    "Every guest needs a valid government-issued photo ID for entry.",

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

  parkingInfo:
    "There's no dedicated valet or private lot — guests typically use nearby paid parking garages or street parking.",

  musicInfo:
    "Expect a mix of hip-hop, R&B, and open format from our resident DJs. Specific lineups and any special guest DJs vary by night — if a guest asks about a specific night's lineup, let them know you'll flag it for the team to confirm.",

  otherPolicies:
    "No outside food or beverages. Bag checks may apply at the door.",
};

export const venueInfoAsPromptText = Object.entries(venueInfo)
  .map(([, value]) => `- ${value}`)
  .join("\n");
