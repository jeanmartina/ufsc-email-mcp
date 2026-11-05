import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { connect } from './harness.js';

describe('server identity', () => {
  it('introduces itself in full, and the profile matches server.json', async () => {
    // What a client puts in front of a person comes from the handshake, not from
    // server.json — that file is not in the npm tarball. Both carry the same
    // profile, and this is what keeps the two from drifting apart.
    const registry = JSON.parse(
      readFileSync(new URL('../server.json', import.meta.url), 'utf8')
    ) as { title: string; description: string; websiteUrl: string };

    const info = (await connect()).client.getServerVersion();

    expect(info?.title).toBe(registry.title);
    expect(info?.description).toBe(registry.description);
    expect(info?.websiteUrl).toBe(registry.websiteUrl);
    // The registry enforces this limit; failing here beats failing on publish.
    expect(registry.description.length).toBeLessThanOrEqual(100);

    // Icons are URLs on the documentation site. A data: URI would be legal and
    // would ride along on every single handshake.
    expect(info?.icons?.length ?? 0).toBeGreaterThan(0);
    for (const icon of info?.icons ?? []) {
      expect(icon.src, 'icon src').toMatch(/^https:\/\//);
    }
  });

  it('warns about untrusted content where a model reads it first', async () => {
    // The untrusted marker on a result is read after the fact. This is the only
    // channel that arrives before the first tool call.
    const instructions = (await connect()).client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toMatch(/never\s+(?:follow|as)\s+instructions/i);
  });
});
