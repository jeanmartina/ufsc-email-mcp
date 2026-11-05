import type { FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { AddressObject, ParsedMail } from 'mailparser';

import {
  assess,
  htmlToText,
  sanitizeText,
  stripInvisible,
  type SecurityAssessment,
} from './analyze.js';
import { collectAttachments, type AttachmentCandidate } from './attachments.js';

/**
 * Per-field caps. One oversized header must not be able to eat the whole result
 * budget on its own — a 2 MB Subject is legal MIME.
 */
const SUBJECT_MAX = 2000;
const ADDRESS_MAX = 4000;
/** RFC 5322 allows a long Message-ID; nothing needs more than this to be useful. */
const MESSAGE_ID_MAX = 256;
/** Flags one summary carries, and the length of each. A keyword is an atom. */
const FLAGS_MAX = 50;
const FLAG_MAX = 64;
const FLAG_ATOM = /^\\?[A-Za-z0-9$_.-]{1,64}$/;

/**
 * Whether a string is a Message-ID this server will pass on: angle-bracketed,
 * bounded, and free of whitespace, control and invisible characters.
 *
 * Both halves matter. The ids go into the `references` list of the metadata
 * block outside the fence, and into the In-Reply-To and References headers of
 * a draft. `[^\s<>]` refused whitespace and nothing else, so an id carrying an
 * escape sequence or a directional override was a handle nobody could see
 * whole.
 */
export function isMessageId(value: string): boolean {
  return /^<[^\s<>]{1,255}>$/.test(value) && stripInvisible(value) === value;
}

export interface MessageSummary {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string | undefined;
  size: number | undefined;
  flags: string[];
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
}

/** Projection of an envelope fetch. Every string here came from the sender. */
export function summarize(message: FetchMessageObject): MessageSummary {
  const envelope = message.envelope;
  const flags = [...(message.flags ?? [])];
  return {
    uid: message.uid,
    subject: sanitizeText(envelope?.subject ?? '(no subject)', SUBJECT_MAX),
    from: sanitizeText(formatEnvelopeAddresses(envelope?.from), ADDRESS_MAX),
    to: sanitizeText(formatEnvelopeAddresses(envelope?.to), ADDRESS_MAX),
    date: isoDate(envelope?.date ?? message.internalDate),
    size: message.size,
    // A keyword is set by whoever has write access to the folder — on a shared
    // mailbox, a colleague — and reached the model as it came. An atom is
    // passed through as the handle it is; anything else is cleaned like a
    // subject, and the list is bounded.
    flags: flags
      .slice(0, FLAGS_MAX)
      .map((flag) =>
        FLAG_ATOM.test(flag) ? flag : sanitizeText(flag, FLAG_MAX)
      ),
    seen: flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
    answered: flags.includes('\\Answered'),
    hasAttachments: collectAttachments(message.bodyStructure).length > 0,
  };
}

/** imapflow hands back a Date, but a malformed header can leave a raw string. */
function isoDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatEnvelopeAddresses(
  addresses: ReadonlyArray<{ name?: string; address?: string }> | undefined
): string {
  if (addresses === undefined || addresses.length === 0) return '(none)';
  return addresses
    .map((entry) => {
      const address = entry.address ?? '(no address)';
      return entry.name === undefined || entry.name === ''
        ? address
        : `${entry.name} <${address}>`;
    })
    .join(', ');
}

function formatParsedAddresses(
  value: AddressObject | AddressObject[] | undefined
): string {
  if (value === undefined) return '(none)';
  const list = Array.isArray(value) ? value : [value];
  const text = list.map((entry) => entry.text).join(', ');
  return text === '' ? '(none)' : text;
}

export interface RenderedMessage {
  /** Server-side facts and verdicts. Safe to present as this server's voice. */
  metadata: {
    uid: number;
    date: string | undefined;
    messageId: string | undefined;
    /** The References/In-Reply-To chain, for reconstructing the conversation. */
    references: string[];
    security: SecurityAssessment;
    attachments: Array<
      Pick<AttachmentCandidate, 'partId' | 'filename' | 'contentType' | 'size'>
    >;
  };
  /** Headers and body, written by the sender. */
  content: string;
}

/**
 * Parses a raw message and splits it into what this server knows and what the
 * sender wrote.
 *
 * The split is the whole point: the metadata block can be trusted because the
 * server produced it, and everything in `content` gets fenced by the caller so
 * the model can tell where the server stops speaking.
 */
export async function renderMessage(
  uid: number,
  source: Buffer,
  trustedAuthservId?: string
): Promise<RenderedMessage> {
  const parsed: ParsedMail = await simpleParser(source, {
    // Attachments are fetched deliberately, one at a time, through the policy
    // in attachments.ts. Parsing them here would pull every byte into memory
    // for a call that only wants the text.
    skipImageLinks: true,
  });

  const body = bodyTextOf(parsed);
  const text = sanitizeText(body);
  const security = assess(
    `${parsed.subject ?? ''}\n${text}`,
    headerValue(parsed, 'authentication-results'),
    trustedAuthservId
  );

  const content = [
    `From: ${sanitizeText(formatParsedAddresses(parsed.from), ADDRESS_MAX)}`,
    `To: ${sanitizeText(formatParsedAddresses(parsed.to), ADDRESS_MAX)}`,
    parsed.cc === undefined
      ? undefined
      : `Cc: ${sanitizeText(formatParsedAddresses(parsed.cc), ADDRESS_MAX)}`,
    `Subject: ${sanitizeText(parsed.subject ?? '(no subject)', SUBJECT_MAX)}`,
    '',
    text,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');

  return {
    metadata: {
      uid,
      date: parsed.date?.toISOString(),
      // Sender-chosen, unbounded in length, and it lands in the metadata block
      // *outside* the fence — the one part of the result the model is told is
      // ours. Every other sender string on this path is sanitised; this one
      // was going through raw.
      messageId:
        parsed.messageId === undefined
          ? undefined
          : sanitizeText(parsed.messageId, MESSAGE_ID_MAX),
      references: threadIdsOf({
        ...(parsed.references === undefined
          ? {}
          : { references: parsed.references }),
        ...(parsed.inReplyTo === undefined
          ? {}
          : { inReplyTo: parsed.inReplyTo }),
      }),
      security,
      attachments: [],
    },
    content,
  };
}

/**
 * Prefers the plain-text part, falls back to converting the HTML one.
 *
 * mailparser's own `text` fallback is deliberately not used: it keeps content
 * the recipient never sees, which is precisely where an instruction meant only
 * for the model would be parked.
 */
function bodyTextOf(parsed: ParsedMail): string {
  if (typeof parsed.text === 'string' && parsed.text.trim() !== '') {
    return parsed.text;
  }
  if (typeof parsed.html === 'string' && parsed.html !== '') {
    return htmlToText(parsed.html);
  }
  return '(no text content)';
}

function headerValue(parsed: ParsedMail, name: string): string | undefined {
  const value = parsed.headers.get(name);
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.filter((v) => typeof v === 'string').join('\n');
  return undefined;
}

/**
 * Message-IDs from the References/In-Reply-To chain, for thread reconstruction.
 * Bounded: a long-running thread accumulates hundreds of them, and each one
 * becomes a search term.
 */
export function threadIdsOf(parsed: {
  messageId?: string | undefined;
  references?: string | string[] | undefined;
  inReplyTo?: string | undefined;
}): string[] {
  const references =
    parsed.references === undefined
      ? []
      : Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references.split(/\s+/);
  const all = [
    ...references,
    ...(parsed.inReplyTo === undefined ? [] : [parsed.inReplyTo]),
    ...(parsed.messageId === undefined ? [] : [parsed.messageId]),
  ]
    .map((id) => id.trim())
    .filter(isMessageId);
  return [...new Set(all)].slice(0, 50);
}
