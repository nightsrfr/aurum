import { getVenueSettings } from "../db.js";

/**
 * All the venue-specific policy facts the concierge relies on (hours, dress
 * code, cancellation policy, etc.) now live in the venue_settings table, not
 * hardcoded here — see db.ts for the seed defaults and the admin Settings
 * tab for how they get edited. This file just formats whatever is
 * currently in the database into prompt text, read fresh on every call so
 * an admin edit takes effect on the very next guest message with no
 * redeploy or restart needed.
 */
export function getVenueInfoAsPromptText(): string {
  const settings = getVenueSettings();
  return Object.values(settings)
    .map((value) => `- ${value}`)
    .join("\n");
}
