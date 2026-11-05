import { Readable } from 'node:stream';

import type {
  FetchMessageObject,
  FetchQueryObject,
  ListResponse,
  MessageStructureObject,
  SearchObject,
  StatusObject,
} from 'imapflow';

import type { ImapConnection } from '../src/imap.js';

/**
 * In-memory stand-in for an IMAP server.
 *
 * It exists so the tool tests exercise the real registration, argument
 * validation, policy and framing code without a network. It implements only
 * what {@link ImapConnection} declares, which is the point: the narrow
 * interface is what keeps this fake from drifting into fiction.
 */
export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  subject: string;
  from: { name?: string; address: string };
  to: Array<{ name?: string; address: string }>;
  date: Date;
  body: string;
  html?: string;
  messageId?: string;
  attachments?: FakeAttachment[];
  /** Extra raw header lines, written into the source as given. */
  headers?: string[];
}

export interface FakeAttachment {
  partId: string;
  filename: string;
  contentType: string;
  content: Buffer;
  /** Overrides the size the structure declares, to fake a lying sender. */
  declaredSize?: number;
}

export interface FakeMailbox {
  path: string;
  messages: FakeMessage[];
  permanentFlags?: Set<string>;
  specialUse?: string;
}

export class FakeImap implements ImapConnection {
  // LIST-STATUS is what lets a listing carry its counters in one round trip.
  // A test that wants the per-folder STATUS fallback deletes it.
  readonly capabilities = new Map<string, boolean | number>([
    ['IMAP4rev1', true],
    ['IDLE', true],
    ['MOVE', true],
    ['LIST-STATUS', true],
  ]);

  /** Every command the tools issued, in order — the tests assert on this. */
  readonly calls: Array<{ name: string; args: unknown[] }> = [];

  connected = false;
  /** Set to make the next command fail, e.g. to exercise the reconnect path. */
  failNext: Error | undefined;
  /** Specific UIDs that should fail flag changes, to test partial flag failures. */
  failFlagsForUids: Set<number> | undefined;

  private selected: string | undefined;
  private locksHeld = 0;
  readonly lockLog: Array<{ path: string; readOnly: boolean }> = [];

  constructor(private readonly mailboxes: FakeMailbox[]) {}

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  }

  private box(path: string): FakeMailbox {
    const found = this.mailboxes.find((m) => m.path === path);
    if (found === undefined) {
      throw Object.assign(new Error(`Mailbox doesn't exist: ${path}`), {
        code: 'NONEXISTENT',
      });
    }
    return found;
  }

  private current(): FakeMailbox {
    if (this.selected === undefined) throw new Error('no mailbox selected');
    return this.box(this.selected);
  }

  async connect(): Promise<void> {
    this.record('connect');
    this.connected = true;
  }

  async logout(): Promise<void> {
    this.record('logout');
    this.connected = false;
  }

  close(): void {
    this.connected = false;
  }

  async noop(): Promise<void> {
    this.record('noop');
  }

  async list(options?: {
    statusQuery?: { messages?: boolean; unseen?: boolean; uidNext?: boolean };
  }): Promise<ListResponse[]> {
    this.record('list', options);
    return this.mailboxes.map((box) => {
      const entry = {
        path: box.path,
        pathAsListed: box.path,
        name: box.path.split('/').pop() ?? box.path,
        delimiter: '/',
        parent: [],
        parentPath: '',
        flags: new Set<string>(),
        listed: true,
        subscribed: true,
      } as unknown as ListResponse;
      if (box.specialUse !== undefined) {
        (entry as { specialUse?: string }).specialUse = box.specialUse;
      }
      if (options?.statusQuery !== undefined) {
        (entry as { status?: StatusObject }).status = {
          path: box.path,
          messages: box.messages.length,
          unseen: box.messages.filter((m) => !m.flags.has('\\Seen')).length,
          uidNext: Math.max(0, ...box.messages.map((m) => m.uid)) + 1,
        };
      }
      return entry;
    });
  }

  async status(
    path: string,
    query: Record<string, boolean>
  ): Promise<StatusObject> {
    this.record('status', path, query);
    const box = this.box(path);
    return {
      path,
      messages: box.messages.length,
      unseen: box.messages.filter((m) => !m.flags.has('\\Seen')).length,
    };
  }

  async getMailboxLock(
    path: string,
    options?: { readOnly?: boolean }
  ): Promise<{ path: string; release(): void }> {
    this.record('getMailboxLock', path, options);
    this.box(path);
    this.selected = path;
    this.locksHeld += 1;
    this.lockLog.push({ path, readOnly: options?.readOnly === true });
    let released = false;
    return {
      path,
      release: () => {
        if (released) throw new Error('lock released twice');
        released = true;
        this.locksHeld -= 1;
      },
    };
  }

  /** Guards against a tool that forgets to release; asserted after each test. */
  get openLocks(): number {
    return this.locksHeld;
  }

  get mailbox(): false | { path: string; permanentFlags: Set<string> } {
    if (this.selected === undefined) return false;
    const box = this.box(this.selected);
    return {
      path: box.path,
      permanentFlags:
        box.permanentFlags ?? new Set(['\\Seen', '\\Flagged', '\\*']),
    };
  }

  async search(
    query: SearchObject,
    _options?: { uid?: boolean }
  ): Promise<number[] | false> {
    this.record('search', query);
    const messages = this.current().messages.filter((candidate) => {
      if (query.all === true) return true;
      if (
        query.seen !== undefined &&
        candidate.flags.has('\\Seen') !== query.seen
      )
        return false;
      if (
        query.flagged !== undefined &&
        candidate.flags.has('\\Flagged') !== query.flagged
      )
        return false;
      if (query.keyword !== undefined && !candidate.flags.has(query.keyword))
        return false;
      if (query.unKeyword !== undefined && candidate.flags.has(query.unKeyword))
        return false;
      if (
        query.subject !== undefined &&
        !candidate.subject.toLowerCase().includes(query.subject.toLowerCase())
      )
        return false;
      if (
        query.from !== undefined &&
        !candidate.from.address.toLowerCase().includes(query.from.toLowerCase())
      )
        return false;
      if (
        query.body !== undefined &&
        !candidate.body.toLowerCase().includes(query.body.toLowerCase())
      )
        return false;
      if (query.since !== undefined && candidate.date < new Date(query.since))
        return false;
      if (
        query.before !== undefined &&
        candidate.date >= new Date(query.before)
      )
        return false;
      if (query.or !== undefined) return true;
      return true;
    });
    return messages.map((m) => m.uid);
  }

  async *fetch(
    range: number[] | string,
    query: FetchQueryObject,
    _options?: { uid?: boolean }
  ): AsyncIterableIterator<FetchMessageObject> {
    this.record('fetch', range, query);
    const uids = Array.isArray(range) ? range : [];
    for (const uid of uids) {
      const found = this.current().messages.find((m) => m.uid === uid);
      if (found === undefined) continue;
      yield toFetchObject(found, query);
    }
  }

  async download(
    range: string,
    part?: string,
    options?: { uid?: boolean; maxBytes?: number }
  ): Promise<{
    meta: { contentType: string; charset?: string; filename?: string };
    content: NodeJS.ReadableStream;
  }> {
    this.record('download', range, part, options);
    const found = this.current().messages.find((m) => m.uid === Number(range));
    const attachment = found?.attachments?.find((a) => a.partId === part);
    if (attachment === undefined) throw new Error(`no such part: ${part}`);
    return {
      meta: {
        contentType: attachment.contentType,
        charset: 'utf-8',
        filename: attachment.filename,
      },
      content: Readable.from([attachment.content]),
    };
  }

  async messageFlagsAdd(
    range: number[],
    flags: string[],
    _options?: { uid?: boolean; silent?: boolean }
  ): Promise<boolean> {
    this.record('messageFlagsAdd', range, flags);
    for (const uid of range) {
      if (this.failFlagsForUids?.has(uid)) continue;
      const found = this.current().messages.find((m) => m.uid === uid);
      for (const flag of flags) found?.flags.add(flag);
    }
    return true;
  }

  async messageFlagsRemove(
    range: number[],
    flags: string[],
    _options?: { uid?: boolean; silent?: boolean }
  ): Promise<boolean> {
    this.record('messageFlagsRemove', range, flags);
    for (const uid of range) {
      if (this.failFlagsForUids?.has(uid)) continue;
      const found = this.current().messages.find((m) => m.uid === uid);
      for (const flag of flags) found?.flags.delete(flag);
    }
    return true;
  }

  async messageMove(
    range: number[],
    destination: string,
    _options?: { uid?: boolean }
  ): Promise<unknown> {
    this.record('messageMove', range, destination);
    const target = this.box(destination);
    const source = this.current();
    const uidMap = new Map<number, number>();
    for (const uid of range) {
      const index = source.messages.findIndex((m) => m.uid === uid);
      if (index >= 0) {
        const [moved] = source.messages.splice(index, 1);
        if (moved !== undefined) {
          target.messages.push(moved);
          uidMap.set(uid, moved.uid);
        }
      }
    }
    return { uidMap };
  }

  async messageCopy(
    range: number[],
    destination: string,
    _options?: { uid?: boolean }
  ): Promise<unknown> {
    this.record('messageCopy', range, destination);
    const target = this.box(destination);
    const uidMap = new Map<number, number>();
    for (const uid of range) {
      const found = this.current().messages.find((m) => m.uid === uid);
      if (found !== undefined) {
        target.messages.push({ ...found });
        uidMap.set(uid, found.uid);
      }
    }
    return { uidMap };
  }

  async messageDelete(
    range: number[],
    _options?: { uid?: boolean }
  ): Promise<boolean> {
    this.record('messageDelete', range);
    const box = this.current();
    box.messages = box.messages.filter((m) => !range.includes(m.uid));
    return true;
  }

  /** Appended drafts are kept verbatim so the tests can parse the RFC822. */
  readonly appended: Array<{ path: string; content: Buffer; flags: string[] }> =
    [];

  async append(
    path: string,
    content: string | Buffer,
    flags: string[] = []
  ): Promise<unknown> {
    this.record('append', path, flags);
    this.box(path);
    this.appended.push({
      path,
      content: Buffer.isBuffer(content) ? content : Buffer.from(content),
      flags,
    });
    return { path, uid: 900 + this.appended.length };
  }

  async mailboxCreate(path: string): Promise<unknown> {
    this.record('mailboxCreate', path);
    this.mailboxes.push({ path, messages: [] });
    return { path, created: true };
  }

  async mailboxRename(path: string, newPath: string): Promise<unknown> {
    this.record('mailboxRename', path, newPath);
    this.box(path).path = newPath;
    return { path, newPath };
  }

  async mailboxDelete(path: string): Promise<unknown> {
    this.record('mailboxDelete', path);
    const index = this.mailboxes.findIndex((m) => m.path === path);
    if (index >= 0) this.mailboxes.splice(index, 1);
    return { path };
  }
}

function toFetchObject(
  fake: FakeMessage,
  query: FetchQueryObject
): FetchMessageObject {
  const source = buildSource(fake);
  const object: Record<string, unknown> = {
    seq: fake.uid,
    uid: fake.uid,
    flags: new Set(fake.flags),
    internalDate: fake.date,
    size: source.length,
  };
  if (query.envelope === true) {
    object.envelope = {
      date: fake.date,
      subject: fake.subject,
      messageId: fake.messageId ?? `<${fake.uid}@example.net>`,
      from: [fake.from],
      to: fake.to,
    };
  }
  if (query.bodyStructure === true) {
    object.bodyStructure = buildStructure(fake);
  }
  if (query.source !== undefined && query.source !== false) {
    const maxLength =
      typeof query.source === 'object' ? query.source.maxLength : undefined;
    object.source =
      maxLength === undefined ? source : source.subarray(0, maxLength);
  }
  return object as unknown as FetchMessageObject;
}

/** Minimal but real RFC822 so mailparser has something genuine to parse. */
export function buildSource(fake: FakeMessage): Buffer {
  const headers = [
    `From: ${fake.from.name === undefined ? fake.from.address : `${fake.from.name} <${fake.from.address}>`}`,
    `To: ${fake.to.map((t) => t.address).join(', ')}`,
    `Subject: ${fake.subject}`,
    `Date: ${fake.date.toUTCString()}`,
    `Message-ID: ${fake.messageId ?? `<${fake.uid}@example.net>`}`,
    'MIME-Version: 1.0',
    ...(fake.headers ?? []),
  ];
  if (fake.html !== undefined) {
    const boundary = 'boundary42';
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return Buffer.from(
      `${headers.join('\r\n')}\r\n\r\n` +
        `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fake.body}\r\n` +
        `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${fake.html}\r\n` +
        `--${boundary}--\r\n`,
      'utf-8'
    );
  }
  headers.push('Content-Type: text/plain; charset=utf-8');
  return Buffer.from(
    `${headers.join('\r\n')}\r\n\r\n${fake.body}\r\n`,
    'utf-8'
  );
}

function buildStructure(fake: FakeMessage): MessageStructureObject {
  const text: MessageStructureObject = {
    part: '1',
    type: 'text/plain',
    size: Buffer.byteLength(fake.body),
  };
  if (fake.attachments === undefined || fake.attachments.length === 0) {
    return text;
  }
  return {
    type: 'multipart/mixed',
    childNodes: [
      text,
      ...fake.attachments.map((attachment) => ({
        part: attachment.partId,
        type: attachment.contentType,
        size: attachment.declaredSize ?? attachment.content.length,
        disposition: 'attachment',
        dispositionParameters: { filename: attachment.filename },
      })),
    ],
  };
}

/** Convenience builder so the tests stay readable. */
export function message(
  uid: number,
  overrides: Partial<FakeMessage> = {}
): FakeMessage {
  return {
    uid,
    flags: new Set<string>(),
    subject: `Message ${uid}`,
    from: { name: 'Sender', address: 'sender@example.net' },
    to: [{ address: 'me@example.net' }],
    date: new Date(
      `2026-08-${String(10 + (uid % 15)).padStart(2, '0')}T09:00:00Z`
    ),
    body: `Body of message ${uid}.`,
    ...overrides,
  };
}
