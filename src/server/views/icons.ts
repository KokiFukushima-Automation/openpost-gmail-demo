/**
 * docs/09_phase5_spec.md §3.2: inline SVG glyphs for the mobile bottom nav. `raw()`-wrapped constant
 * strings only, never database-derived - the same rule every other `raw()` call site in this tree
 * follows. No icon font, no extra request.
 */
import { raw, type SafeHtml } from './html.js';

function icon(path: string): SafeHtml {
  return raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`);
}

export const ICON_MESSAGES = icon('<path d="M4 5h16v11H7l-3 3z" stroke-linejoin="round"/>');
export const ICON_COMPOSE = icon('<path d="M4 20h16M15 4l5 5-11 11H4v-5z" stroke-linejoin="round"/>');
export const ICON_CAMPAIGNS = icon('<path d="M3 11l18-7-5 18-4-7-7-4z" stroke-linejoin="round"/>');
export const ICON_REMINDERS = icon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>');
export const ICON_STATS = icon('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke-linecap="round"/>');
export const ICON_MORE = icon('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>');
