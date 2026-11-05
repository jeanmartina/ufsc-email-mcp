import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decodeCharacterReferences,
  htmlToText,
  parseAuthResults,
  sanitizeText,
} from '../src/analyze.js';
import { collectAttachments, isMediaType } from '../src/attachments.js';
import { loadConfig } from '../src/config.js';
import {
  ImapClient,
  LOGIN_COOLDOWN_MS,
  MAX_MAILBOXES,
  MAX_STATUS_QUERIES,
  STATUS_BUDGET_MS,
} from '../src/imap.js';
import { isMessageId, threadIdsOf } from '../src/message.js';
import { fencedUntrustedResult } from '../src/result.js';

import {
  FakeImap,
  message,
  type FakeMailbox,
  type FakeMessage,
} from './fake-imap.js';
import {
  call,
  connect,
  defaultMailboxes,
  jsonOf,
  testConfig,
  textOf,
} from './harness.js';

/**
 * The 2026-09-07 review, one block per finding. Every test here was red on
 * the tree before its fix — the counter-proof in the pull request counts them.
 *
 * Control characters and surrogates are built at runtime rather than spelled
 * as escapes: the editing tools turn `\uXXXX` in a file into the raw byte.
 */
const ESC = String.fromCharCode(27);
const RLO = String.fromCodePoint(0x202e);
const HIGH = String.fromCharCode(0xd800);
const FFFD = String.fromCodePoint(0xfffd);
const ESCAPED_ESC = '\\u001b';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function withExit(): { errors: string[]; exit: ReturnType<typeof vi.spyOn> } {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as never);
  return { errors, exit };
}

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    IMAP_HOST: 'imap.example.net',
    IMAP_USER: 'me@example.net',
    IMAP_PASSWORD: 'secret-password',
    ...overrides,
  };
}

/** A fake whose connect is refused every time, counting the attempts. */
function refusing(): { fake: FakeImap; attempts: () => number } {
  const fake = new FakeImap([{ path: 'INBOX', messages: [message(1)] }]);
  let attempts = 0;
  fake.connect = async () => {
    attempts += 1;
    throw Object.assign(new Error('login failed'), {
      code: 'AUTHENTICATIONFAILED',
      responseText: 'NO [AUTHENTICATIONFAILED] Invalid credentials',
    });
  };
  return { fake, attempts: () => attempts };
}

function folders(count: number): FakeMailbox[] {
  return Array.from({ length: count }, (_v, i) => ({
    path: `Folder${String(i).padStart(4, '0')}`,
    messages: [],
  }));
}

/* ------------------------------------------------- 1.7 login cooldown -- */

describe('a refused connection is answered from memory (1.7)', () => {
  it('does not log in again within the cooldown, and says so', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { fake, attempts } = refusing();
    const client = new ImapClient(testConfig(), () => fake);

    await expect(client.listMailboxes()).rejects.toThrow(/login failed/);
    expect(attempts()).toBe(1);

    // Two more tool calls in the same second: the answer is the remembered
    // one, and the provider sees no second attempt.
    for (let i = 0; i < 2; i += 1) {
      const error = await client.listMailboxes().catch((e: unknown) => e);
      expect(String((error as Error).message)).toContain(
        'repeated from memory'
      );
      expect(String((error as Error).message)).toContain(
        'next attempt possible at'
      );
      expect((error as { code?: string }).code).toBe('AUTHENTICATIONFAILED');
    }
    expect(attempts()).toBe(1);

    vi.setSystemTime(Date.now() + LOGIN_COOLDOWN_MS + 1);
    await expect(client.listMailboxes()).rejects.toThrow(/login failed/);
    expect(attempts()).toBe(2);
  });

  it('applies to the mailbox path as well, where the reconnect lives', async () => {
    const { fake, attempts } = refusing();
    const client = new ImapClient(testConfig(), () => fake);
    await expect(
      client.withMailbox('INBOX', true, async () => 'x')
    ).rejects.toThrow(/login failed/);
    await expect(
      client.withMailbox('INBOX', true, async () => 'x')
    ).rejects.toThrow(/repeated from memory/);
    expect(attempts()).toBe(1);
  });

  it('is not sticky when the factory itself throws', async () => {
    // A rejected promise left in `connecting` used to answer every later call
    // with the same rejection for the life of the process.
    vi.useFakeTimers({ toFake: ['Date'] });
    let calls = 0;
    const client = new ImapClient(testConfig(), () => {
      calls += 1;
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
      });
    });
    await expect(client.listMailboxes()).rejects.toThrow(/ENOTFOUND/);
    vi.setSystemTime(Date.now() + LOGIN_COOLDOWN_MS + 1);
    await expect(client.listMailboxes()).rejects.toThrow(/ENOTFOUND/);
    expect(calls).toBe(2);
  });

  it('reaches the model with the hint and the cooldown note', async () => {
    const harness = await connect();
    harness.imap.connect = async () => {
      throw Object.assign(new Error('login failed'), {
        code: 'AUTHENTICATIONFAILED',
      });
    };
    await call(harness.client, 'list_mailboxes');
    const second = await call(harness.client, 'list_mailboxes');
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('repeated from memory');
    expect(textOf(second)).toContain('check IMAP_USER and IMAP_PASSWORD');
    await harness.close();
  });
});

/* ------------------------------------------- 1.9/1.10 STATUS fan-out -- */

describe('list_mailboxes without LIST-STATUS is bounded (1.9/1.10)', () => {
  it('issues at most MAX_STATUS_QUERIES STATUS commands and counts the rest', async () => {
    const fake = new FakeImap(folders(MAX_STATUS_QUERIES + 150));
    fake.capabilities.delete('LIST-STATUS');
    const client = new ImapClient(testConfig(), () => fake);
    const listing = await client.listMailboxes();
    expect(fake.calls.filter((entry) => entry.name === 'status')).toHaveLength(
      MAX_STATUS_QUERIES
    );
    expect(listing.statusOmitted).toBe(150);
    expect(listing.mailboxes).toHaveLength(MAX_STATUS_QUERIES + 150);
    expect(listing.mailboxes[0]?.messages).toBe(0);
    expect(listing.mailboxes[MAX_STATUS_QUERIES]?.messages).toBeUndefined();
  });

  it('stops issuing STATUS when the wall-clock budget is spent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fake = new FakeImap(folders(50));
    fake.capabilities.delete('LIST-STATUS');
    const slow = fake.status.bind(fake);
    fake.status = async (path, query) => {
      vi.setSystemTime(Date.now() + STATUS_BUDGET_MS / 4);
      return slow(path, query);
    };
    const client = new ImapClient(testConfig(), () => fake);
    const listing = await client.listMailboxes();
    expect(fake.calls.filter((entry) => entry.name === 'status')).toHaveLength(
      4
    );
    expect(listing.statusOmitted).toBe(46);
  });

  it('keeps listing a folder the server refuses to STATUS', async () => {
    const fake = new FakeImap(folders(3));
    fake.capabilities.delete('LIST-STATUS');
    const slow = fake.status.bind(fake);
    fake.status = async (path, query) => {
      if (path === 'Folder0001') {
        throw Object.assign(new Error('refused'), { code: 'NO' });
      }
      return slow(path, query);
    };
    const client = new ImapClient(testConfig(), () => fake);
    const listing = await client.listMailboxes();
    expect(listing.mailboxes.map((box) => box.path)).toEqual([
      'Folder0000',
      'Folder0001',
      'Folder0002',
    ]);
    expect(listing.statusOmitted).toBe(1);
  });

  it('never asks the fallback of a server that has LIST-STATUS', async () => {
    const fake = new FakeImap(folders(300));
    const client = new ImapClient(testConfig(), () => fake);
    const listing = await client.listMailboxes();
    expect(fake.calls.filter((entry) => entry.name === 'status')).toHaveLength(
      0
    );
    expect(listing.statusOmitted).toBe(0);
    expect(listing.mailboxes[299]?.messages).toBe(0);
  });

  it('caps the entries and reports the total', async () => {
    const fake = new FakeImap(folders(MAX_MAILBOXES + 7));
    const client = new ImapClient(testConfig(), () => fake);
    const listing = await client.listMailboxes();
    expect(listing.total).toBe(MAX_MAILBOXES + 7);
    expect(listing.mailboxes).toHaveLength(MAX_MAILBOXES);
  });

  it('tells the model which folders came without counts', async () => {
    const mailboxes = folders(MAX_STATUS_QUERIES + 2);
    const harness = await connect({ mailboxes });
    harness.imap.capabilities.delete('LIST-STATUS');
    const result = await call(harness.client, 'list_mailboxes');
    expect(result.isError).toBeFalsy();
    const payload = jsonOf(result) as {
      status_omitted?: number;
      total_mailboxes: number;
      note: string;
    };
    expect(payload.status_omitted).toBe(2);
    expect(payload.total_mailboxes).toBe(MAX_STATUS_QUERIES + 2);
    expect(payload.note).toContain('listed without counts');
    await harness.close();
  });
});

/* --------------------------------------- 1.3/4.2 metadata beside fence -- */

describe('sender strings in the metadata block are bounded and cleaned (1.3/4.2)', () => {
  it('reads a message whose Authentication-Results id is sixty thousand letters', async () => {
    const mailboxes = defaultMailboxes();
    mailboxes[0]!.messages.push(
      message(9, {
        headers: [`Authentication-Results: ${'a'.repeat(60_000)}; spf=pass`],
      })
    );
    const harness = await connect({ mailboxes });
    const result = await call(harness.client, 'get_message', { uid: 9 });
    // Before the cap this was "the full result exceeded 50000 characters":
    // the id sat in the metadata block, which has its own budget and nothing
    // array-shaped to shrink, so the message could not be read at all.
    expect(result.isError).toBeFalsy();
    const security = (
      result.structuredContent as {
        security: { auth: { authservId?: string; forgeable: boolean } };
      }
    ).security;
    expect(security.auth.authservId).toBeUndefined();
    expect(security.auth.forgeable).toBe(true);
    expect(textOf(result)).not.toContain('a'.repeat(1000));
    await harness.close();
  });

  it('caps the authserv-id at a hostname and keeps the verdicts', () => {
    const long = parseAuthResults(`${'b'.repeat(300)}; spf=pass; dkim=fail`);
    expect(long.authservId).toBeUndefined();
    expect(long.spf).toBe('pass');
    expect(long.dkim).toBe('fail');
    const ok = parseAuthResults('mx.example.net; spf=pass', 'mx.example.net');
    expect(ok.authservId).toBe('mx.example.net');
    expect(ok.forgeable).toBe(false);
  });

  it('reports a declared content type that is not a media type as octet-stream, without quoting it', async () => {
    const declared = `application/${'x'.repeat(100_000)}${ESC}`;
    const mailboxes = defaultMailboxes();
    mailboxes[0]!.messages.push(
      message(9, {
        attachments: [
          {
            partId: '2',
            filename: 'blob.bin',
            contentType: declared,
            content: Buffer.from('bytes'),
          },
        ],
      })
    );
    const harness = await connect({ mailboxes });
    for (const [tool, args] of [
      ['get_attachments', { uid: 9 }],
      ['get_message', { uid: 9 }],
    ] as const) {
      const result = await call(harness.client, tool, args);
      expect(result.isError, tool).toBeFalsy();
      expect(textOf(result), tool).not.toContain('x'.repeat(200));
      expect(textOf(result), tool).toContain('application/octet-stream');
    }
    const refused = await call(harness.client, 'get_attachments', {
      uid: 9,
      part_id: '2',
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused).length).toBeLessThan(2000);
    expect(textOf(refused)).toContain('not a valid media type');
    await harness.close();
  });

  it('knows a media type when it sees one', () => {
    for (const good of ['application/pdf', 'text/plain', 'image/svg+xml']) {
      expect(isMediaType(good), good).toBe(true);
    }
    for (const bad of [
      'pdf',
      'a/b/c',
      `text/${ESC}`,
      `x/${'y'.repeat(128)}`,
      '',
    ]) {
      expect(isMediaType(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('treats a size that is not a safe integer as unknown', () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 5 },
        {
          part: '2',
          type: 'application/pdf',
          size: Number.POSITIVE_INFINITY,
          disposition: 'attachment',
          dispositionParameters: { filename: 'a.pdf' },
        },
        {
          part: '3',
          type: 'application/pdf',
          size: -1,
          disposition: 'attachment',
          dispositionParameters: { filename: 'b.pdf' },
        },
      ],
    };
    const found = collectAttachments(structure as never);
    expect(found.map((c) => c.size)).toEqual([undefined, undefined]);
  });

  it('lists a message whose declared attachment size is Infinity', async () => {
    // imapflow reads the size with `Number(v) || 0`; `1e400` is Infinity,
    // JSON writes it as null, and null fails the `size: number` the output
    // schema promises — for the whole listing.
    const mailboxes = defaultMailboxes();
    mailboxes[0]!.messages.push(
      message(9, {
        attachments: [
          {
            partId: '2',
            filename: 'big.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('%PDF-1.4'),
            declaredSize: Number.POSITIVE_INFINITY,
          },
        ],
      })
    );
    const harness = await connect({ mailboxes });
    const result = await call(harness.client, 'get_attachments', { uid: 9 });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain('Output validation error');
    await harness.close();
  });

  it('drops a References id that carries a control or invisible character', async () => {
    const mailboxes = defaultMailboxes();
    mailboxes[0]!.messages.push(
      message(9, {
        headers: [
          `References: <good@example.net> <bad${ESC}@example.net> <${RLO}rtl@example.net>`,
        ],
      })
    );
    const harness = await connect({ mailboxes });
    const result = await call(harness.client, 'get_message', { uid: 9 });
    const references = (result.structuredContent as { references: string[] })
      .references;
    expect(references).toContain('<good@example.net>');
    expect(references.some((id) => id.includes(ESC))).toBe(false);
    expect(references.some((id) => id.includes(RLO))).toBe(false);
    expect(textOf(result)).not.toContain(ESC);
    await harness.close();
  });

  it('isMessageId refuses what the header regex alone let through', () => {
    expect(isMessageId('<a@b>')).toBe(true);
    expect(isMessageId(`<a${ESC}@b>`)).toBe(false);
    expect(isMessageId(`<${RLO}a@b>`)).toBe(false);
    expect(isMessageId(`<${'a'.repeat(256)}>`)).toBe(false);
    expect(threadIdsOf({ references: `<a@b> <c${ESC}@d>` })).toEqual(['<a@b>']);
  });

  it('cleans a keyword that is not an atom and keeps the ones that are', async () => {
    const mailboxes = defaultMailboxes();
    mailboxes[0]!.messages.push(
      message(9, {
        flags: new Set(['\\Seen', '$Label1', `Junk${ESC}${'k'.repeat(200)}`]),
      })
    );
    const harness = await connect({ mailboxes });
    const result = await call(harness.client, 'list_messages', {});
    const summary = (
      result.structuredContent as {
        messages: Array<{ uid: number; flags: string[] }>;
      }
    ).messages.find((m) => m.uid === 9)!;
    expect(summary.flags).toContain('\\Seen');
    expect(summary.flags).toContain('$Label1');
    expect(summary.flags.some((flag) => flag.includes(ESC))).toBe(false);
    expect(Math.max(...summary.flags.map((flag) => flag.length))).toBeLessThan(
      100
    );
    await harness.close();
  });
});

/* ------------------------------------------------ 3.4 server's words -- */

describe("the server's own words are cleaned where they are the mail server's (3.4)", () => {
  it('bounds and cleans capabilities and permanent flags in get_server_info', async () => {
    const mailboxes = defaultMailboxes();
    mailboxes[0]!.permanentFlags = new Set([
      '\\Seen',
      `Evil${ESC}${'z'.repeat(300)}`,
    ]);
    const harness = await connect({ mailboxes });
    harness.imap.capabilities.set(`X-${ESC}${'c'.repeat(300)}`, true);
    for (let i = 0; i < 150; i += 1)
      harness.imap.capabilities.set(`X-CAP-${i}`, true);
    const result = await call(harness.client, 'get_server_info');
    expect(result.isError).toBeFalsy();
    const info = jsonOf(result) as {
      capabilities: string[];
      permanent_flags: string[];
    };
    expect(info.capabilities.length).toBeLessThanOrEqual(100);
    expect(info.permanent_flags.some((f) => f.includes(ESC))).toBe(false);
    expect(info.capabilities.some((c) => c.includes(ESC))).toBe(false);
    expect(Math.max(...info.permanent_flags.map((f) => f.length))).toBeLessThan(
      100
    );
    expect(textOf(result)).not.toContain(ESC);
    await harness.close();
  });

  it('cleans the hierarchy delimiter', async () => {
    const harness = await connect();
    const list = harness.imap.list.bind(harness.imap);
    harness.imap.list = async (options) =>
      (await list(options)).map((entry) =>
        Object.assign(entry, { delimiter: `/${ESC}${RLO}` })
      );
    const result = await call(harness.client, 'list_mailboxes');
    const payload = jsonOf(result) as {
      mailboxes: Array<{ delimiter: string }>;
    };
    expect(payload.mailboxes[0]?.delimiter).toBe('/');
    await harness.close();
  });
});

/* ------------------------------------------------- 4.1 error messages -- */

describe('library and runtime error messages are bounded and escaped (4.1)', () => {
  it('escapes and cuts a connect error that quotes what the other end sent', async () => {
    const harness = await connect();
    harness.imap.connect = async () => {
      throw Object.assign(
        new Error(`certificate altnames: DNS:${ESC}evil ${'n'.repeat(5000)}`),
        { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
      );
    };
    const result = await call(harness.client, 'list_mailboxes');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(ESCAPED_ESC);
    expect(textOf(result)).not.toContain(ESC);
    expect(textOf(result)).toContain('(truncated)');
    expect(textOf(result).length).toBeLessThan(2600);
    await harness.close();
  });

  it('escapes an error without a type of its own', async () => {
    const harness = await connect();
    harness.imap.noop = async () => {
      throw new TypeError(`Cannot read ${ESC}x`);
    };
    const result = await call(harness.client, 'list_messages', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(ESCAPED_ESC);
    expect(textOf(result)).not.toContain(ESC);
    await harness.close();
  });

  it('quotes a bounded copy of a resource URI it refuses', async () => {
    const harness = await connect();
    const uri = `imap://message/${'9'.repeat(5000)}x/part/1`;
    const error = await harness.client
      .readResource({ uri })
      .catch((e: unknown) => e as Error);
    expect(String((error as Error).message)).toContain('no valid UID');
    expect(String((error as Error).message).length).toBeLessThan(400);
    await harness.close();
  });
});

/* ------------------------------------------ 5.3 character references -- */

describe('character references decode the way a client decodes them (5.3)', () => {
  it.each([
    ['&#x26;#104;', '&#104;'],
    ['&#0000000104;', 'h'],
    ['&#104 x', 'h x'],
    ['&#x68', 'h'],
    ['&#0;', FFFD],
    ['&#xD800;', FFFD],
    ['&#1114112;', FFFD],
    ['&amp;lt;', '&lt;'],
    ['&nbsp;a', ' a'],
    ['&apos;', "'"],
    ['&Constructor;', '&Constructor;'],
    ['&constructor;', '&constructor;'],
    ['&__proto__;', '&__proto__;'],
    ['&#', '&#'],
    ['&', '&'],
  ])('%j decodes to %j', (input, expected) => {
    expect(decodeCharacterReferences(input)).toBe(expected);
    expect(htmlToText(input)).toBe(expected);
  });

  it('decodes every scalar with any zero padding to the character', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 0x10ffff })
          .filter((n) => n < 0xd800 || n > 0xdfff),
        fc.integer({ min: 0, max: 12 }),
        fc.boolean(),
        (n, zeros, hex) => {
          const digits = hex ? n.toString(16) : String(n);
          const reference = `&#${hex ? 'x' : ''}${'0'.repeat(zeros)}${digits};`;
          expect(decodeCharacterReferences(reference)).toBe(
            String.fromCodePoint(n)
          );
        }
      ),
      { numRuns: 300 }
    );
  });

  it('stays linear on a run of reference starts', () => {
    const started = performance.now();
    htmlToText('&#'.repeat(256_000));
    htmlToText('&#x'.repeat(170_000));
    htmlToText('&'.repeat(512_000));
    expect(performance.now() - started).toBeLessThan(500);
  });
});

/* --------------------------------------------------- 5.x surrogates -- */

describe('what leaves is well-formed UTF-16 (5.x)', () => {
  it('sanitizeText repairs a lone surrogate, including one made by the cut', () => {
    expect(sanitizeText(`a${HIGH}b`)).toBe(`a${FFFD}b`);
    const pair = String.fromCodePoint(0x1f600);
    const cut = sanitizeText(`ab${pair}`, 3);
    expect(cut.isWellFormed()).toBe(true);
  });

  it('a fenced result never carries a lone surrogate in either channel', () => {
    const pair = String.fromCodePoint(0x1f600);
    const body = `${'x'.repeat(199_000)}${pair}${'y'.repeat(50_000)}`;
    const result = fencedUntrustedResult('header', body, [], { uid: 1 });
    const text = (result.content[0] as { text: string }).text;
    expect(text.isWellFormed()).toBe(true);
    expect(
      String((result.structuredContent as { body: string }).body).isWellFormed()
    ).toBe(true);
  });
});

/* -------------------------------------------- 4.5 / 6.2 / 6.3 config -- */

describe('configuration values are checked for shape and never echoed (4.5)', () => {
  const secret = 'eyJhbGciOiJIUzI1NiJ9.hunter2-token-value';

  it.each([
    ['ELICITATION', secret],
    ['IMAP_ATTACHMENT_TYPES', `application/pdf,${secret}`],
    ['IMAP_MAILBOX', `INBOX${ESC}`],
    ['IMAP_MAILBOX', 'a'.repeat(256)],
    ['IMAP_DRAFTS_MAILBOX', 'Drafts%'],
    ['IMAP_USER', `me\n${secret}`],
    ['IMAP_SEEN_KEYWORD', 'A'.repeat(65)],
    ['IMAP_HOST', `${'h'.repeat(254)}`],
    ['IMAP_TRUSTED_AUTHSERV_ID', `mx.example.net ${secret}`],
    ['IMAP_DOWNLOAD_DIR', `/nonexistent/${secret}`],
  ])(
    'refuses %s with the wrong shape, describing the value by length',
    (name, raw) => {
      const { errors, exit } = withExit();
      expect(() => loadConfig(env({ [name]: raw }))).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      const joined = errors.join('\n');
      expect(joined).toContain(name);
      expect(joined).not.toContain('hunter2');
      expect(joined).not.toContain('h'.repeat(100));
      expect(joined).not.toContain(ESC);
    }
  );

  it('names the position of a bad allowlist entry', () => {
    const { errors } = withExit();
    expect(() =>
      loadConfig(env({ IMAP_ATTACHMENT_TYPES: 'text/plain, image/png, nope' }))
    ).toThrow('exit');
    expect(errors.join('\n')).toContain('entry 3');
  });

  it('accepts a host of 253 characters and a keyword of 64', () => {
    const host = `${'h'.repeat(60)}.${'i'.repeat(60)}.${'j'.repeat(60)}.${'k'.repeat(60)}.example`;
    expect(host.length).toBeLessThanOrEqual(253);
    const config = loadConfig(
      env({ IMAP_HOST: host, IMAP_SEEN_KEYWORD: 'K'.repeat(64) })
    );
    expect(config.imap.host).toBe(host);
    expect(config.imap.seenKeyword).toBe('K'.repeat(64));
  });

  it('stores the real path of an existing download directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imap-mcp-review-'));
    const link = join(directory, 'link');
    await symlink(directory, link);
    const config = loadConfig(env({ IMAP_DOWNLOAD_DIR: `${link}/` }));
    expect(config.imap.downloadDir).not.toContain('link');
    expect(config.imap.downloadDir?.endsWith('/')).toBe(false);
  });

  it('treats an empty IMAP_DOWNLOAD_DIR as unset', () => {
    expect(
      loadConfig(env({ IMAP_DOWNLOAD_DIR: '  ' })).imap.downloadDir
    ).toBeUndefined();
  });

  it('does not walk a trailing run of dots quadratically', () => {
    // The host is bounded to 253 characters, so the walk is a habit rather
    // than a risk; this pins the bound that makes it one.
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) {
      const { errors } = withExit();
      loadConfig(
        env({ IMAP_HOST: `localhost${'.'.repeat(244)}`, IMAP_TLS: 'none' })
      );
      expect(errors.join('\n')).not.toContain('unencrypted');
      vi.restoreAllMocks();
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

/* --------------------------------------------- functional findings -- */

describe('findings that were not security but were wrong', () => {
  it('hasAttachments is true for a message that has one', async () => {
    const mailboxes = defaultMailboxes();
    mailboxes[0]!.messages.push(
      message(9, {
        attachments: [
          {
            partId: '2',
            filename: 'a.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('%PDF-1.4'),
          },
        ],
      })
    );
    const harness = await connect({ mailboxes });
    const result = await call(harness.client, 'list_messages', {});
    const summaries = (
      result.structuredContent as {
        messages: Array<{ uid: number; hasAttachments: boolean }>;
      }
    ).messages;
    expect(summaries.find((m) => m.uid === 9)?.hasAttachments).toBe(true);
    expect(summaries.find((m) => m.uid === 1)?.hasAttachments).toBe(false);
    await harness.close();
  });

  it('the copy prompt names a tool that exists', async () => {
    const harness = await connect({ config: { readOnly: false } });
    const first = await call(harness.client, 'move_messages', {
      uids: [2],
      destination: 'Archive',
      mode: 'copy',
    });
    expect(textOf(first)).toContain('move_messages');
    expect(textOf(first)).not.toContain('copy_messages');
    await harness.close();
  });

  it('a reply to a message whose id is not a Message-ID gets no In-Reply-To rather than an error', async () => {
    const mailboxes = defaultMailboxes();
    const odd: FakeMessage = message(9, {
      messageId: `<odd${ESC}@example.net>`,
    });
    mailboxes[0]!.messages.push(odd);
    const harness = await connect({ config: { readOnly: false }, mailboxes });
    const result = await call(harness.client, 'save_draft', {
      to: ['a@example.net'],
      subject: 'Re: odd',
      body: 'hi',
      reply_to_uid: 9,
    });
    expect(result.isError).toBeFalsy();
    const raw = harness.imap.appended[0]!.content.toString('utf-8');
    expect(raw).not.toContain('In-Reply-To');
    expect(raw).not.toContain(ESC);
    await harness.close();
  });
});

/* ---------------------------------------- 3.8 shaped fake responses -- */

describe('what the server hands over never breaks a listing (3.8)', () => {
  const runs = Number(process.env.SHAPE_RUNS ?? '20');
  const leaf = fc.oneof(
    fc.string({ maxLength: 40, unit: 'binary' }),
    fc.constant(`application/${'x'.repeat(3000)}`),
    fc.constant(`${ESC}${RLO}`),
    fc.constant(HIGH)
  );
  const size = fc.oneof(
    fc.double(),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.constant(-1),
    fc.constant(2 ** 53)
  );

  it('answers list_messages, get_message and get_attachments with a valid result', async () => {
    await fc.assert(
      fc.asyncProperty(
        leaf,
        leaf,
        leaf,
        size,
        async (subject, type, name, declared) => {
          const mailboxes = defaultMailboxes();
          mailboxes[0]!.messages.push(
            message(9, {
              subject,
              attachments: [
                {
                  partId: '2',
                  filename: name,
                  contentType: type,
                  content: Buffer.from('bytes'),
                  declaredSize: declared,
                },
              ],
            })
          );
          const harness = await connect({ mailboxes });
          try {
            for (const [tool, args] of [
              ['list_messages', {}],
              ['get_message', { uid: 9 }],
              ['get_attachments', { uid: 9 }],
            ] as const) {
              const result = await call(harness.client, tool, args);
              const text = textOf(result);
              expect(text, tool).not.toContain('Output validation error');
              expect(text, tool).not.toContain('Cannot read properties');
              expect(text, tool).not.toContain('is not a function');
              expect(
                result.isError,
                `${tool}: ${text.slice(0, 200)}`
              ).toBeFalsy();
              expect(text).not.toContain(ESC);
            }
          } finally {
            await harness.close();
          }
        }
      ),
      { numRuns: runs }
    );
  });
});

/* ---------------------------------------------- supply chain tripwires -- */

describe('supply chain (7.x) and the pdf.js surface', () => {
  it('installs with --ignore-scripts wherever a token is held, and verifies the tag', async () => {
    const release = await readFile(
      new URL('../.github/workflows/release.yml', import.meta.url),
      'utf-8'
    );
    for (const line of release.split('\n').filter((l) => /npm ci\b/.test(l))) {
      expect(line).toContain('--ignore-scripts');
    }
    expect(release).toContain('--verify-tag');
    const ci = await readFile(
      new URL('../.github/workflows/ci.yml', import.meta.url),
      'utf-8'
    );
    expect(ci).toContain('dependency-review-action');
    expect(ci).toContain("github.event_name == 'pull_request'");
  });

  it('removes yarn and corepack from the image and ships no lockfile', async () => {
    const dockerfile = await readFile(
      new URL('../Dockerfile', import.meta.url),
      'utf-8'
    );
    // One RUN across continuation lines, so the match may cross them.
    expect(dockerfile).toMatch(/rm -rf[\s\S]{0,400}yarn/);
    expect(dockerfile).toMatch(/rm -rf[\s\S]{0,400}corepack/);
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    expect(runtime).not.toMatch(/COPY[^\n]*package-lock\.json/);
  });

  it('uses five pdf.js calls and none of the doors', async () => {
    // The comments name the doors in order to say why they stay shut; the
    // code must not. Comments are stripped before the check.
    const source = (
      await readFile(new URL('../src/extract/pdf.ts', import.meta.url), 'utf-8')
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const door of [
      'getAnnotations',
      'getJSActions',
      'getAttachments',
      'AnnotationLayer',
      'enableScripting',
      '.render(',
      'cMapUrl',
      'standardFontDataUrl',
    ]) {
      expect(source, door).not.toContain(door);
    }
    expect(source).toContain('isEvalSupported: false');
  });

  it('pins the pdf.js unpdf bundles, so a bump is a decision', async () => {
    // CVE-2026-16633 (pdf.js 5.6.83 to 6.2.107): scripting attached to form
    // fields by the annotation layer, which this server never renders. The
    // note in SECURITY.md is written against this exact version; when unpdf
    // moves, this test fails so the note is revisited rather than outlived.
    const pkg = JSON.parse(
      await readFile(
        new URL('../node_modules/unpdf/package.json', import.meta.url),
        'utf-8'
      )
    ) as { version: string; devDependencies: Record<string, string> };
    expect(pkg.version).toBe('1.8.1');
    expect(pkg.devDependencies['pdfjs-dist']).toBe('~6.1.200');
  });
});
