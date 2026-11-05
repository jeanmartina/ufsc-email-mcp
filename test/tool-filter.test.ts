/**
 * What this repository still has to prove about its tool filter.
 *
 * The filter lives in `mcp-tool-allowlist` and is tested there: pattern syntax,
 * the preset, how a rejected entry is quoted back, the shape of every message.
 * Repeating that here would test the dependency.
 *
 * What only this repository can assert is the wiring — that the catalogue names
 * exactly the tools the server registers, that the messages name *these*
 * variables, and that a filtered tool is really gone rather than merely hidden.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '../src/tools/catalogue.js';

import { createServer } from '../src/server.js';
import { ToolFilterError } from 'mcp-tool-allowlist';
import { connect, testConfig, toolNames } from './harness.js';

/** The tools a server built with this configuration actually offers. */
async function names(
  // `Parameters<typeof connect>[0]` is optional, so indexing it reaches
  // through `undefined`. `NonNullable` names the object the parameter is
  // when it is passed, which is the only case this helper has.
  config: NonNullable<Parameters<typeof connect>[0]>['config'] = {}
) {
  const harness = await connect({ config });
  const list = await toolNames(harness.client);
  await harness.close();
  return list.toSorted();
}

/** Builds a server directly, for the cases where construction is what fails. */
function build(overrides: Parameters<typeof testConfig>[0] = {}): void {
  createServer(testConfig(overrides));
}

describe('the catalogue', () => {
  // These are what let the filter validate a name before anything is
  // registered. If they drift from the code, every error message drifts too.
  it('is exactly the set of tools the server registers', async () => {
    expect(await names({ readOnly: false })).toEqual([...ALL_TOOLS].toSorted());
  });

  it('splits into read and write with nothing left over', async () => {
    expect([...READ_TOOLS, ...WRITE_TOOLS].toSorted()).toEqual(
      [...ALL_TOOLS].toSorted()
    );
    expect(
      READ_TOOLS.filter((t) => (WRITE_TOOLS as readonly string[]).includes(t))
    ).toEqual([]);
    // Read-only is the default here, so this is also what an unconfigured
    // server offers.
    expect(await names()).toEqual([...READ_TOOLS].toSorted());
  });

  it('holds names the env-var syntax cannot misread', () => {
    // A comma or an asterisk in a name would break the separator or the
    // pattern; a tool called "essential" would be unreachable behind the preset.
    for (const tool of ALL_TOOLS) {
      expect(tool).toMatch(/^[a-z0-9_]+$/);
    }
    expect(ALL_TOOLS).not.toContain('essential');
  });

  it('has an essential preset that survives the read-only default', () => {
    expect(new Set(ESSENTIAL_TOOLS).size).toBe(ESSENTIAL_TOOLS.length);
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
    for (const tool of ESSENTIAL_TOOLS) expect(ALL_TOOLS).toContain(tool);
    // The preset would be useless on this server if it were all write tools:
    // read-only is the default, so most of it has to survive that.
    const readable = ESSENTIAL_TOOLS.filter((t) =>
      (READ_TOOLS as readonly string[]).includes(t)
    );
    expect(readable.length).toBeGreaterThanOrEqual(3);
  });
});

describe('selecting tools', () => {
  it('narrows tools/list to an allow list', async () => {
    expect(await names({ allowTools: 'list_mailboxes,get_message' })).toEqual([
      'get_message',
      'list_mailboxes',
    ]);
  });

  it('removes a whole family with a prefix pattern', async () => {
    const list = await names({ readOnly: false, denyTools: 'list_*' });
    expect(list.some((n) => n.startsWith('list_'))).toBe(false);
    expect(list).toHaveLength(
      ALL_TOOLS.length - ALL_TOOLS.filter((t) => t.startsWith('list_')).length
    );
  });

  it('subtracts the deny list from the allow list', async () => {
    expect(
      await names({ allowTools: 'list_*', denyTools: 'list_new_messages' })
    ).toEqual(['list_mailboxes', 'list_messages']);
  });

  it('selects the curated set for "essential"', async () => {
    expect(await names({ readOnly: false, allowTools: 'essential' })).toEqual(
      [...ESSENTIAL_TOOLS].toSorted()
    );
  });

  it('lets the preset compose with extra names', async () => {
    expect(
      await names({ readOnly: false, allowTools: 'essential,delete_messages' })
    ).toEqual([...ESSENTIAL_TOOLS, 'delete_messages'].toSorted());
  });

  it('leaves an unconfigured server untouched', async () => {
    expect(await names()).toEqual([...READ_TOOLS].toSorted());
  });
});

describe('a filtered-out tool', () => {
  it('cannot be called either, not merely hidden', async () => {
    // This is the difference between removing the tool and disabling it: a
    // disabled tool still answers a call, which advertises a refusal.
    const harness = await connect({ config: { allowTools: 'list_mailboxes' } });
    const before = harness.imap.calls.length;

    // SDK v2 reports an unknown tool as a JSON-RPC error rather than as a
    // result carrying isError. Either way the call fails and nothing reaches
    // the API, which is what this test is about.
    await expect(
      harness.client.callTool({
        name: 'get_message',
        arguments: { uid: 1 },
      })
    ).rejects.toThrow('Tool get_message not found');
    // Nothing reached the mailbox.
    expect(harness.imap.calls).toHaveLength(before);
    await harness.close();
  });
});

describe('refusing an unusable list', () => {
  it('rejects a name no tool has, and says which names exist', () => {
    // A typo that was merely ignored would leave a tool missing with no trace
    // of why — nobody looks for the cause of an absence in an env var.
    expect(() => build({ allowTools: 'list_mailboxez' })).toThrow(
      ToolFilterError
    );
    expect(() => build({ allowTools: 'list_mailboxez' })).toThrow(
      /no tool matches "list_mailboxez".*list_mailboxes/s
    );
  });

  it('applies the same rule to the deny list', () => {
    expect(() => build({ denyTools: 'delet_messages' })).toThrow(
      /IMAP_DENY_TOOLS: no tool matches "delet_messages"/
    );
  });

  it('rejects a list that would leave no tools at all', () => {
    expect(() => build({ denyTools: '*' })).toThrow(/empty tool list/);
  });
});

describe('together with the read-only default', () => {
  it('names read-only as the reason, rather than calling the tool unknown', () => {
    // The tool exists; the default suppresses it. Reporting "unknown tool"
    // would send the reader looking for a typo that is not there — and here it
    // matters more than anywhere, because read-only is the default rather than
    // something the operator remembers switching on.
    let thrown: unknown;
    try {
      build({ allowTools: 'delete_messages' });
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('IMAP_READ_ONLY');
    expect(message).not.toContain('no tool matches');
  });

  it('narrows the essential preset to its read half', async () => {
    expect(await names({ allowTools: 'essential' })).toEqual(
      ESSENTIAL_TOOLS.filter((t) =>
        (READ_TOOLS as readonly string[]).includes(t)
      ).toSorted()
    );
  });

  it('lets a pattern cover write tools without failing', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await names({ allowTools: 'essential,delete_*' })).toEqual(
      ESSENTIAL_TOOLS.filter((t) =>
        (READ_TOOLS as readonly string[]).includes(t)
      ).toSorted()
    );
    expect(warn.mock.calls.flat().join(' ')).toContain('contributes nothing');
    warn.mockRestore();
  });

  it('says read-only is the reason when a pattern leaves nothing at all', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => build({ allowTools: 'delete_*' })).toThrow(
      /read-only mode suppresses.*IMAP_READ_ONLY is set/s
    );
    warn.mockRestore();
  });

  it('does not apply the write-tool rule to the deny list', async () => {
    // Denying something already suppressed is how a defensive list is written.
    expect(await names({ denyTools: 'delete_messages' })).toEqual(
      [...READ_TOOLS].toSorted()
    );
  });
});
