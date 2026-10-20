/**
 * docs/09_phase5_spec.md §2.3: pure address parsing/validation for the mobile compose form - no DB,
 * no I/O. Splits on the same separators the CLI's `collectRepeatable` already uses (`,`), plus
 * whitespace (a phone keyboard's autocomplete/share-target text commonly separates addresses with a
 * space rather than a comma).
 */

const CONTROL_CHAR_RE = /[\r\n\t\0]/;

/** A conservative but real-world-tolerant address shape: exactly one `@`, a non-empty local part, a
 *  domain with at least one dot, no whitespace or control characters anywhere. Rejecting anything
 *  containing CR/LF is a header-injection guard (test 371) - these values eventually flow into a
 *  `To:`/`Cc:`/`Bcc:` header via `buildMime`. */
export function isValidAddress(email: string): boolean {
  if (email.length === 0 || email.length > 320) return false;
  if (CONTROL_CHAR_RE.test(email)) return false;
  if (/\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.startsWith('-') || domain.endsWith('-')) return false;
  return true;
}

export interface SplitAddressesResult {
  valid: string[];
  invalid: string[];
}

/** Splits a free-text field on `,`/`;`/whitespace, trims, lower-cases the domain (never the local
 *  part - `Local@Example.com` and `local@example.com` are different mailboxes on some servers),
 *  de-duplicates while preserving first-seen order, and separates the results into valid/invalid so
 *  the caller can render a precise error rather than silently dropping a typo. */
export function splitAddresses(input: string): SplitAddressesResult {
  // Deliberately splits on `,`/`;`/horizontal whitespace only - NOT `\r`/`\n`. Splitting on
  // newlines too would let "evil@example.com\r\nBcc:attacker@evil.com" quietly become two
  // separate, individually-valid-looking tokens (the injection defused by accident, but the
  // attacker-controlled second address silently accepted as a real recipient). Keeping a `\r`/`\n`
  // attached to whatever token contains it means `isValidAddress`'s control-character check (via
  // the same guard below) rejects that whole token outright instead (test 371).
  const parts = input
    .split(/[,;\t ]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of parts) {
    if (CONTROL_CHAR_RE.test(raw) || !isValidAddress(raw)) {
      invalid.push(raw);
      continue;
    }
    const at = raw.indexOf('@');
    const normalized = `${raw.slice(0, at)}@${raw.slice(at + 1).toLowerCase()}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    valid.push(normalized);
  }
  return { valid, invalid };
}
