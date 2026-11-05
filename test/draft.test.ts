import { describe, expect, it } from 'vitest';

import { buildDraft, encodeHeaderValue } from '../src/draft.js';
import { ToolInputError } from '../src/errors.js';

import { call, connect, jsonOf, textOf } from './harness.js';
import { message } from './fake-imap.js';

const base = {
  from: 'me@example.net',
  to: ['anna@example.net'],
  subject: 'Hello',
  body: 'Text.',
  date: new Date('2026-08-26T10:00:00Z'),
};

function headersOf(draft: Buffer): string {
  return draft.toString('utf-8').split('\r\n\r\n')[0] ?? '';
}

function bodyOf(draft: Buffer): string {
  const parts = draft.toString('utf-8').split('\r\n\r\n');
  return Buffer.from(parts.slice(1).join('\r\n\r\n'), 'base64').toString(
    'utf-8'
  );
}

describe('buildDraft', () => {
  it('produces a message with the expected headers', () => {
    const headers = headersOf(buildDraft(base));
    expect(headers).toContain('From: me@example.net');
    expect(headers).toContain('To: anna@example.net');
    expect(headers).toContain('Subject: Hello');
    expect(headers).toContain('MIME-Version: 1.0');
    expect(headers).toContain('Content-Type: text/plain; charset=utf-8');
  });

  it('round-trips the body through base64', () => {
    expect(bodyOf(buildDraft({ ...base, body: 'Grüße\nAlex' }))).toBe(
      'Grüße\nAlex'
    );
  });

  it('keeps base64 lines inside the line-length limit', () => {
    const draft = buildDraft({ ...base, body: 'x'.repeat(5000) });
    for (const line of draft.toString('utf-8').split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  it('joins multiple recipients', () => {
    const headers = headersOf(
      buildDraft({
        ...base,
        to: ['a@example.net', 'b@example.net'],
        cc: ['c@example.net'],
        bcc: ['d@example.net'],
      })
    );
    expect(headers).toContain('To: a@example.net, b@example.net');
    expect(headers).toContain('Cc: c@example.net');
    expect(headers).toContain('Bcc: d@example.net');
  });

  it('omits empty recipient headers rather than emitting them blank', () => {
    const headers = headersOf(buildDraft({ ...base, cc: [], bcc: [] }));
    expect(headers).not.toContain('Cc:');
    expect(headers).not.toContain('Bcc:');
  });

  it('threads a reply', () => {
    const headers = headersOf(
      buildDraft({
        ...base,
        thread: {
          messageId: '<3@example.net>',
          references: ['<1@example.net>', '<3@example.net>'],
        },
      })
    );
    expect(headers).toContain('In-Reply-To: <3@example.net>');
    expect(headers).toContain('References: <1@example.net> <3@example.net>');
  });

  it('folds a long References chain inside the line-length limit', () => {
    const references = Array.from(
      { length: 20 },
      (_, i) => `<${'x'.repeat(240)}-${i}@example.net>`
    );
    const draft = buildDraft({
      ...base,
      thread: { messageId: references[19] as string, references },
    });
    for (const line of draft.toString('utf-8').split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
    // Folding must not lose a reference.
    const unfolded = headersOf(draft).replace(/\r\n[ \t]/g, ' ');
    for (const reference of references) {
      expect(unfolded).toContain(reference);
    }
  });

  it('refuses to build without a sender', () => {
    expect(() => buildDraft({ ...base, from: undefined })).toThrow(
      ToolInputError
    );
  });

  it('refuses a header value carrying a bare line break', () => {
    // Belt and braces: the schemas reject this long before here, but a draft is
    // a message a human will later send under their own name, so a smuggled Bcc
    // must not survive a regression one layer up.
    expect(() =>
      buildDraft({
        ...base,
        to: ['a@example.net\r\nBcc: attacker@example.org'],
      })
    ).toThrow(ToolInputError);
  });
});

describe('encodeHeaderValue', () => {
  it('leaves plain ASCII alone', () => {
    expect(encodeHeaderValue('Invoice 4711')).toBe('Invoice 4711');
  });

  it('encodes non-ASCII as an encoded-word', () => {
    const encoded = encodeHeaderValue('Grüße');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(
      Buffer.from(
        /=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(encoded)?.[1] ?? '',
        'base64'
      ).toString('utf-8')
    ).toBe('Grüße');
  });

  it('folds a long value into several encoded-words', () => {
    const encoded = encodeHeaderValue(`Grüße ${'ä'.repeat(200)}`);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte character across two words', () => {
    const encoded = encodeHeaderValue('ä'.repeat(120));
    const decoded = encoded
      .split('\r\n ')
      .map((word) =>
        Buffer.from(
          /=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(word)?.[1] ?? '',
          'base64'
        ).toString('utf-8')
      )
      .join('');
    expect(decoded).toBe('ä'.repeat(120));
  });
});

describe('save_draft', () => {
  const writeConfig = { readOnly: false };

  it('appends to the folder the server flags as Drafts', async () => {
    const harness = await connect({ config: writeConfig });
    const result = await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'Re: Please review',
      body: 'Will do.',
    });
    expect(jsonOf(result)).toMatchObject({
      action: 'draft_saved',
      mailbox: 'Drafts',
    });
    const appended = harness.imap.appended[0];
    expect(appended?.path).toBe('Drafts');
    expect(appended?.flags).toEqual(['\\Draft', '\\Seen']);
    expect(appended?.content.toString('utf-8')).toContain(
      'To: anna@example.net'
    );
    await harness.close();
  });

  it('says plainly that nothing was sent', async () => {
    const harness = await connect({ config: writeConfig });
    const text = textOf(
      await call(harness.client, 'save_draft', {
        to: ['anna@example.net'],
        subject: 'Hi',
        body: 'Text.',
      })
    );
    expect(text).toContain('not sent');
    await harness.close();
  });

  it('honours IMAP_DRAFTS_MAILBOX over the special-use flag', async () => {
    const harness = await connect({
      config: {
        readOnly: false,
        imap: { draftsMailbox: 'Archive' } as never,
      },
    });
    expect(
      jsonOf(
        await call(harness.client, 'save_draft', {
          to: ['anna@example.net'],
          subject: 'Hi',
          body: 'Text.',
        })
      )
    ).toMatchObject({ mailbox: 'Archive' });
    await harness.close();
  });

  it('explains what to configure when there is no Drafts folder', async () => {
    const harness = await connect({
      config: writeConfig,
      mailboxes: [{ path: 'INBOX', messages: [message(1)] }],
    });
    const result = await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'Hi',
      body: 'Text.',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('IMAP_DRAFTS_MAILBOX');
    await harness.close();
  });

  it('threads a reply from the original message', async () => {
    const harness = await connect({ config: writeConfig });
    await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'Re: Please review',
      body: 'Will do.',
      reply_to_uid: 3,
    });
    const raw = harness.imap.appended[0]?.content.toString('utf-8') ?? '';
    expect(raw).toContain('In-Reply-To: <3@example.net>');
    await harness.close();
  });

  it('rejects a recipient that would inject a header', async () => {
    const harness = await connect({ config: writeConfig });
    const result = await call(harness.client, 'save_draft', {
      to: ['anna@example.net\r\nBcc: attacker@example.org'],
      subject: 'Hi',
      body: 'Text.',
    });
    expect(result.isError).toBe(true);
    expect(harness.imap.appended).toHaveLength(0);
    await harness.close();
  });

  it('rejects a subject carrying a line break', async () => {
    const harness = await connect({ config: writeConfig });
    const result = await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'Hi\r\nBcc: attacker@example.org',
      body: 'Text.',
    });
    expect(result.isError).toBe(true);
    expect(harness.imap.appended).toHaveLength(0);
    await harness.close();
  });

  it('is not registered without IMAP_READ_ONLY', async () => {
    const harness = await connect();
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('save_draft');
    await harness.close();
  });
});
