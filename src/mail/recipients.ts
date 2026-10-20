import type { TransportName } from '../types.js';
import type { MimeAddress } from './mime.js';

/**
 * Pure recipient-semantics module (docs/07_recipient_semantics.md §6.1). Every function here is a
 * plain data transform with no I/O, no DB, no network - `src/cli/commands/send.ts` is the only
 * caller that turns a `SendPlan` into actual sends.
 */

export type RecipientMode = 'per-recipient' | 'single';
export type RecipientModeOption = RecipientMode | 'auto';

export interface AddressInput {
  email: string;
  kind: 'to' | 'cc' | 'bcc';
  name?: string | undefined;
}

export interface CopyPlan {
  /** The one addressee this copy is *for*, in per-recipient mode. Absent for the single aggregate
   *  copy, which is for everyone at once. */
  address?: string;
  kind?: 'to' | 'cc' | 'bcc';
  /** One address in per-recipient mode; every address (to+cc+bcc) in single mode - the SMTP
   *  envelope's `RCPT TO` list, or (for `gmail`) the addresses the submitted headers must not
   *  exceed (§6.2's gmail.ts fan-out guard). */
  envelopeTo: string[];
  headerTo: MimeAddress[];
  headerCc: MimeAddress[];
  /** ALWAYS empty, on every transport, in every mode, with exactly one exception: the single
   *  aggregate copy sent over `MAIL_TRANSPORT=gmail` (§3.2/§5.3) - Gmail's own submission pipeline
   *  strips the header before delivery, and there is no envelope override to hide it another way. */
  headerBcc: MimeAddress[];
  isAggregate: boolean;
}

export interface SendPlan {
  mode: RecipientMode;
  /** `<op.{messageId}@{fromDomain}>` - shared by every delivered copy's `References` header and by
   *  the untracked Sent copy's own `Message-ID` (§2.1). */
  threadRootMessageId: string;
  date: Date;
  copies: CopyPlan[];
  /** Headers for the untracked self-copy (§3.1/§4.1): always the FULL to/cc/bcc lists, on every
   *  mode and transport - this copy never goes out over the wire, so HC-3 does not apply to it. */
  sentCopy: { headerTo: MimeAddress[]; headerCc: MimeAddress[]; headerBcc: MimeAddress[] };
}

/**
 * §3.3's decision table, pure and total. Never silently downgrades a request and never silently
 * fans a per-recipient send out over an API with no envelope - both failure modes throw with a
 * remedy named in the message.
 */
export function resolveRecipientMode(
  requested: RecipientModeOption,
  transport: TransportName,
  recipientCount: number,
): RecipientMode {
  // Row 1: a single recipient never needs an aggregate row - the per-recipient/single distinction
  // is meaningless with N=1, so this always wins regardless of what was requested.
  if (recipientCount <= 1) return 'per-recipient';

  if (requested === 'single') return 'single';

  if (requested === 'per-recipient') {
    if (transport === 'gmail') {
      throw new Error(
        'RECIPIENT_MODE=per-recipient is impossible over MAIL_TRANSPORT=gmail: users.messages.send has ' +
          'no envelope override, so per-recipient copies bearing the full To/Cc headers would fan out ' +
          'N² messages. Use --transport gmail-smtp for CC-correct per-recipient delivery, or ' +
          '--recipient-mode single to send one message with message-level tracking.',
      );
    }
    return 'per-recipient';
  }

  // requested === 'auto'
  if (transport === 'gmail') return 'single';
  return 'per-recipient';
}

/** `<op.{messageId}@{fromDomain}>` - a synthetic Message-ID that never collides with anything a
 *  real mail client generates, distinct from every copy's own per-copy Message-ID (§2.1). */
export function threadRootMessageId(messageId: string, fromEmail: string): string {
  const at = fromEmail.indexOf('@');
  const domain = at >= 0 ? fromEmail.slice(at + 1) : 'localhost';
  return `<op.${messageId}@${domain}>`;
}

function toMimeAddress(a: AddressInput): MimeAddress {
  return a.name !== undefined ? { email: a.email, name: a.name } : { email: a.email };
}

export interface BuildSendPlanArgs {
  addresses: AddressInput[];
  mode: RecipientMode;
  transport: TransportName;
  messageId: string;
  fromEmail: string;
  now: number;
}

/**
 * Turns a resolved `RecipientMode` into the concrete per-copy header/envelope plan (§6.1). Never
 * inspects suppression/opt-out state - that is `send.ts`'s job, before this is even called (§3.4's
 * all-or-nothing suppression check in single mode happens on the *address list*, upstream).
 */
export function buildSendPlan(args: BuildSendPlanArgs): SendPlan {
  const { addresses, mode, transport, messageId, fromEmail, now } = args;

  const headerTo = addresses.filter((a) => a.kind === 'to').map(toMimeAddress);
  const headerCc = addresses.filter((a) => a.kind === 'cc').map(toMimeAddress);
  const bccAddresses = addresses.filter((a) => a.kind === 'bcc').map(toMimeAddress);

  const threadRoot = threadRootMessageId(messageId, fromEmail);
  const date = new Date(now);

  const sentCopy = { headerTo, headerCc, headerBcc: bccAddresses };

  if (mode === 'per-recipient') {
    const copies: CopyPlan[] = addresses.map((a) => ({
      address: a.email,
      kind: a.kind,
      envelopeTo: [a.email],
      headerTo,
      headerCc,
      headerBcc: [], // HC-3: never on a delivered copy
      isAggregate: false,
    }));
    return { mode, threadRootMessageId: threadRoot, date, copies, sentCopy };
  }

  // single mode: exactly one copy, addressed to everyone.
  const allAddresses = addresses.map((a) => a.email);
  // §3.2/§5.3: the one documented exception to HC-3 - Gmail-API single mode places Bcc in the
  // submitted raw and relies on Gmail's own submission pipeline to strip it before delivery.
  // Every other transport keeps headerBcc empty; those Bcc addressees are delivered purely by
  // envelopeTo (RCPT TO), same as per-recipient mode.
  const headerBcc = transport === 'gmail' ? bccAddresses : [];
  const copies: CopyPlan[] = [
    {
      envelopeTo: allAddresses,
      headerTo,
      headerCc,
      headerBcc,
      isAggregate: true,
    },
  ];
  return { mode, threadRootMessageId: threadRoot, date, copies, sentCopy };
}
