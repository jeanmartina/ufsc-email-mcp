import { describe, expect, it, vi } from 'vitest';

import { MailError, ToolInputError } from '../src/errors.js';
import { ImapClient, asMailError, withTimeout } from '../src/imap.js';

import { FakeImap, message } from './fake-imap.js';
import { testConfig } from './harness.js';

function boxes() {
  return [{ path: 'INBOX', messages: [message(1)] }];
}

describe('ImapClient', () => {
  it('connects lazily and only once', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    expect(fake.connected).toBe(false);

    await client.withMailbox('INBOX', true, async () => 'a');
    await client.withMailbox('INBOX', true, async () => 'b');
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      1
    );
  });

  it('refuses to connect without credentials', async () => {
    const fake = new FakeImap(boxes());
    const config = testConfig();
    config.imap.host = undefined;
    const client = new ImapClient(config, () => fake);
    await expect(
      client.withMailbox('INBOX', true, async () => 'x')
    ).rejects.toThrow(/IMAP_HOST/);
    expect(fake.connected).toBe(false);
  });

  it('opens the default mailbox when none is given', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox(undefined, true, async (_c, path) => path);
    expect(fake.lockLog).toEqual([{ path: 'INBOX', readOnly: true }]);
  });

  it('releases the lock when the body throws', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await expect(
      client.withMailbox('INBOX', true, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow();
    expect(fake.openLocks).toBe(0);
  });

  it('reconnects once after a dropped connection', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox('INBOX', true, async () => 'warm');

    fake.failNext = Object.assign(new Error('socket gone'), {
      code: 'ECONNRESET',
    });
    const result = await client.withMailbox('INBOX', true, async () => 'again');
    expect(result).toBe('again');
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      2
    );
  });

  it('does not retry an error that is not a connection failure', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox('INBOX', true, async () => 'warm');

    fake.failNext = Object.assign(new Error('no permission'), { code: 'NO' });
    await expect(
      client.withMailbox('INBOX', true, async () => 'again')
    ).rejects.toThrow(/no permission/);
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      1
    );
  });

  it('reconnects for connection-less commands too', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.listMailboxes();
    fake.failNext = Object.assign(new Error('gone'), { code: 'EPIPE' });
    await expect(client.listMailboxes()).resolves.toMatchObject({ total: 1 });
  });

  it('surfaces a connect failure as a MailError', async () => {
    const client = new ImapClient(testConfig(), () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
      });
    });
    await expect(client.listMailboxes()).rejects.toBeInstanceOf(MailError);
  });

  it('reports mailbox counters from a single LIST', async () => {
    const fake = new FakeImap([
      { path: 'INBOX', messages: [message(1), message(2)] },
    ]);
    const client = new ImapClient(testConfig(), () => fake);
    const { mailboxes } = await client.listMailboxes();
    expect(mailboxes[0]).toMatchObject({
      path: 'INBOX',
      messages: 2,
      unseen: 2,
    });
    expect(fake.calls.filter((entry) => entry.name === 'status')).toHaveLength(
      0
    );
  });

  describe('keywordSupported', () => {
    it('accepts a server that takes arbitrary keywords', () => {
      const client = new ImapClient(testConfig(), () => new FakeImap(boxes()));
      expect(client.keywordSupported(new Set(['\\Seen', '\\*']))).toBe(true);
    });

    it('accepts a server that lists the keyword explicitly', () => {
      const client = new ImapClient(testConfig(), () => new FakeImap(boxes()));
      expect(client.keywordSupported(new Set(['AiSeen']))).toBe(true);
    });

    it('rejects a server that stores neither', () => {
      const client = new ImapClient(testConfig(), () => new FakeImap(boxes()));
      expect(client.keywordSupported(new Set(['\\Seen']))).toBe(false);
    });

    it('is off when the keyword is empty, even on a permissive server', () => {
      const config = testConfig();
      config.imap.seenKeyword = '';
      const client = new ImapClient(config, () => new FakeImap(boxes()));
      expect(client.keywordSupported(new Set(['\\*']))).toBe(false);
    });
  });

  it('does not tag when the keyword is disabled', async () => {
    const fake = new FakeImap(boxes());
    const config = testConfig();
    config.imap.seenKeyword = '';
    const client = new ImapClient(config, () => fake);
    await client.tagSeen(fake, [1]);
    expect(fake.calls.some((entry) => entry.name === 'messageFlagsAdd')).toBe(
      false
    );
  });

  it('does not issue a STORE for an empty UID list', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.tagSeen(fake, []);
    expect(fake.calls.some((entry) => entry.name === 'messageFlagsAdd')).toBe(
      false
    );
  });

  it('logs out on close and tolerates a failing logout', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.listMailboxes();
    await client.close();
    expect(fake.connected).toBe(false);

    const rude = new FakeImap(boxes());
    rude.logout = async () => {
      throw new Error('connection already gone');
    };
    const second = new ImapClient(testConfig(), () => rude);
    await second.listMailboxes();
    await expect(second.close()).resolves.toBeUndefined();
  });

  it('treats a missing search result as no matches', async () => {
    const fake = new FakeImap(boxes());
    fake.search = async () => false;
    const client = new ImapClient(testConfig(), () => fake);
    expect(await client.search(fake, { all: true })).toEqual([]);
  });

  it('returns nothing for an empty fetch range without talking to the server', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    expect(await client.fetchSummaries(fake, [])).toEqual([]);
    expect(fake.calls.some((entry) => entry.name === 'fetch')).toBe(false);
  });
});

describe('withTimeout', () => {
  it('passes a value through', async () => {
    await expect(withTimeout(Promise.resolve(7), 'NOOP')).resolves.toBe(7);
  });

  it('rejects with a MailError once the deadline passes', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 'SEARCH', 50);
    const assertion = expect(pending).rejects.toThrow(/SEARCH timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it('clears the timer when the command wins', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve('ok'), 'NOOP', 50)).resolves.toBe(
      'ok'
    );
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe('asMailError', () => {
  it('passes an existing MailError through untouched', () => {
    const original = new MailError('already wrapped');
    expect(asMailError(original)).toBe(original);
  });

  it('rethrows a ToolInputError rather than disguising it as a server fault', () => {
    expect(() => asMailError(new ToolInputError('bad uid'))).toThrow(
      ToolInputError
    );
  });

  it('keeps the code and the response text', () => {
    const error = asMailError(
      Object.assign(new Error('login failed'), {
        code: 'AUTHENTICATIONFAILED',
        responseText: 'NO [AUTHENTICATIONFAILED] Invalid credentials',
      })
    );
    expect(error.code).toBe('AUTHENTICATIONFAILED');
    expect(error.responseText).toContain('Invalid credentials');
    expect(error.message).toContain('IMAP error');
  });

  it('does not carry the sent command — that is where the password would be', () => {
    const error = asMailError(
      Object.assign(new Error('command failed'), {
        code: 'BAD',
        command: 'A1 LOGIN me@example.net hunter2',
        responseText: 'BAD syntax error',
      })
    );
    expect(JSON.stringify(error)).not.toContain('hunter2');
    expect(error.responseText).toBe('BAD syntax error');
  });

  it('handles a thrown non-Error', () => {
    expect(asMailError('just a string').message).toContain('just a string');
  });
});
