import { describe, expect, it, vi } from 'vitest';

/**
 * The one code path that weakens TLS, tested on its own.
 *
 * `defaultFactory` in `src/imap.ts` is the only place `ImapFlow` is
 * constructed, and the only place `rejectUnauthorized: false` can be written.
 * Nothing else in the suite reaches it — every other test injects a fake — so
 * until this file the insecure switch, the STARTTLS choice and the silenced
 * logger were untested. The module is mocked before import (`vi.mock` is
 * hoisted), and the spy records what the constructor was handed.
 */
const hoisted = vi.hoisted(() => {
  const constructed: unknown[] = [];
  class ImapFlowSpy {
    readonly capabilities = new Map<string, boolean>([['LIST-STATUS', true]]);
    constructor(config: unknown) {
      constructed.push(config);
    }
    async connect(): Promise<void> {}
    async list(): Promise<unknown[]> {
      return [];
    }
    async logout(): Promise<void> {}
    close(): void {}
  }
  return { ImapFlowSpy, constructed };
});

vi.mock('imapflow', () => ({ ImapFlow: hoisted.ImapFlowSpy }));

import { ImapClient } from '../src/imap.js';
import { testConfig } from './harness.js';

async function construct(
  overrides: Partial<ReturnType<typeof testConfig>['imap']>
): Promise<Record<string, unknown>> {
  hoisted.constructed.length = 0;
  const config = testConfig();
  Object.assign(config.imap, overrides);
  const client = new ImapClient(config);
  await client.listMailboxes();
  expect(hoisted.constructed).toHaveLength(1);
  return hoisted.constructed[0] as Record<string, unknown>;
}

describe('the real ImapFlow is constructed with', () => {
  it('certificate validation on, unless the switch says otherwise', async () => {
    expect((await construct({ insecureTls: false })).tls).toEqual({});
    expect((await construct({ insecureTls: true })).tls).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('implicit TLS as `secure`, and STARTTLS only when asked for', async () => {
    const implicit = await construct({ tls: 'implicit' });
    expect(implicit.secure).toBe(true);
    expect(implicit.doSTARTTLS).toBe(false);

    const starttls = await construct({ tls: 'starttls' });
    expect(starttls.secure).toBe(false);
    expect(starttls.doSTARTTLS).toBe(true);

    // Stated, not left to the library: unset, imapflow upgrades
    // opportunistically and a downgrade attack succeeds in silence.
    const none = await construct({ tls: 'none' });
    expect(none.secure).toBe(false);
    expect(none.doSTARTTLS).toBe(false);
  });

  it('its traffic logger off, because stdout is the MCP transport', async () => {
    expect((await construct({})).logger).toBe(false);
  });

  it('the credentials and nothing else about them', async () => {
    const built = await construct({ user: 'me@example.net', password: 'pw' });
    expect(built.auth).toEqual({ user: 'me@example.net', pass: 'pw' });
    expect(JSON.stringify(built)).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });
});
