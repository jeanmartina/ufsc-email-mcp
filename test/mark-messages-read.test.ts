import { describe, expect, it } from 'vitest';

import { call, connect, jsonOf, textOf, tokenOf } from './harness.js';
import { message, type FakeMailbox } from './fake-imap.js';

const writeConfig = { readOnly: false };

describe('mark_messages_read and move_messages with mark_as_read', () => {
  it('1. marcas uma mensagem como lida (UID STORE +FLAGS.SILENT \\Seen)', async () => {
    const harness = await connect({ config: writeConfig });
    // Message 2 starts unread in defaultMailboxes()
    const res = await call(harness.client, 'mark_messages_read', {
      uids: [2],
      seen: true,
    });
    expect(res.isError).toBeFalsy();
    const payload = jsonOf(res) as {
      mailbox: string;
      seen: boolean;
      updated: number[];
      failed: number[];
      messages: Array<{
        uid: number;
        success: boolean;
        seen?: boolean;
        flags?: string[];
      }>;
    };
    expect(payload.mailbox).toBe('INBOX');
    expect(payload.seen).toBe(true);
    expect(payload.updated).toEqual([2]);
    expect(payload.failed).toEqual([]);
    expect(payload.messages[0]).toMatchObject({
      uid: 2,
      success: true,
      seen: true,
    });
    expect(payload.messages[0]?.flags).toContain('\\Seen');

    // Verify call to IMAP was messageFlagsAdd with silent: true
    const storeCall = harness.imap.calls.find(
      (c) => c.name === 'messageFlagsAdd'
    );
    expect(storeCall).toBeDefined();
    expect(storeCall?.args[1]).toEqual(['\\Seen']);

    await harness.close();
  });

  it('2. marca múltiplas mensagens como lidas', async () => {
    const harness = await connect({ config: writeConfig });
    // Messages 2 and 3 start unread
    const res = await call(harness.client, 'mark_messages_read', {
      uids: [2, 3],
      seen: true,
    });
    const payload = jsonOf(res) as {
      updated: number[];
      messages: Array<{ uid: number; success: boolean; seen?: boolean }>;
    };
    expect(payload.updated).toEqual([2, 3]);
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages.every((m) => m.success && m.seen)).toBe(true);

    await harness.close();
  });

  it('3. marca uma mensagem como não lida (UID STORE -FLAGS.SILENT \\Seen)', async () => {
    const harness = await connect({ config: writeConfig });
    // Message 1 starts read (\Seen) in defaultMailboxes()
    const res = await call(harness.client, 'mark_messages_read', {
      uids: [1],
      seen: false,
    });
    const payload = jsonOf(res) as {
      updated: number[];
      messages: Array<{
        uid: number;
        success: boolean;
        seen?: boolean;
        flags?: string[];
      }>;
    };
    expect(payload.updated).toEqual([1]);
    expect(payload.messages[0]).toMatchObject({
      uid: 1,
      success: true,
      seen: false,
    });
    expect(payload.messages[0]?.flags).not.toContain('\\Seen');

    // Verify call to IMAP was messageFlagsRemove with silent: true
    const removeCall = harness.imap.calls.find(
      (c) => c.name === 'messageFlagsRemove'
    );
    expect(removeCall).toBeDefined();
    expect(removeCall?.args[1]).toEqual(['\\Seen']);

    await harness.close();
  });

  it('4. repete a mesma operação sem efeitos indesejados (idempotência)', async () => {
    const harness = await connect({ config: writeConfig });
    // Mark as read once
    const first = await call(harness.client, 'mark_messages_read', {
      uids: [2],
      seen: true,
    });
    expect((jsonOf(first) as { updated: number[] }).updated).toEqual([2]);

    // Mark as read again
    const second = await call(harness.client, 'mark_messages_read', {
      uids: [2],
      seen: true,
    });
    const payload = jsonOf(second) as {
      updated: number[];
      messages: Array<{
        uid: number;
        success: boolean;
        seen?: boolean;
        flags?: string[];
      }>;
    };
    expect(payload.updated).toEqual([2]);
    expect(payload.messages[0]).toMatchObject({
      uid: 2,
      success: true,
      seen: true,
    });
    // Flags must not have duplicate \Seen
    const seenCount = payload.messages[0]?.flags?.filter(
      (f) => f === '\\Seen'
    ).length;
    expect(seenCount).toBe(1);

    await harness.close();
  });

  it('5. move mensagens de INBOX para mycolleagues e sbc-l, marcando como lidas', async () => {
    const mailboxes: FakeMailbox[] = [
      {
        path: 'INBOX',
        messages: [
          message(101, { subject: 'Colleague email 1' }),
          message(102, { subject: 'SBC announcement' }),
        ],
      },
      { path: 'mycolleagues', messages: [] },
      { path: 'sbc-l', messages: [] },
    ];
    const harness = await connect({ config: writeConfig, mailboxes });

    // Step 5a: Move 101 to mycolleagues with mark_as_read: true
    const prompt1 = await call(harness.client, 'move_messages', {
      uids: [101],
      destination: 'mycolleagues',
      mark_as_read: true,
    });
    expect(textOf(prompt1)).toContain('confirm_token');
    expect(textOf(prompt1)).toContain('Mark as read');

    const result1 = await call(harness.client, 'move_messages', {
      uids: [101],
      destination: 'mycolleagues',
      mark_as_read: true,
      confirm_token: tokenOf(prompt1),
    });
    const payload1 = jsonOf(result1) as {
      action: string;
      destination: string;
      uids: number[];
      messages: Array<{
        uid: number;
        destination: string;
        seen?: boolean;
        success: boolean;
      }>;
    };
    expect(payload1.action).toBe('moved');
    expect(payload1.destination).toBe('mycolleagues');
    expect(payload1.uids).toEqual([101]);
    expect(payload1.messages[0]).toMatchObject({
      uid: 101,
      destination: 'mycolleagues',
      seen: true,
      success: true,
    });

    // Step 5b: Move 102 to sbc-l with mark_as_read: true
    const prompt2 = await call(harness.client, 'move_messages', {
      uids: [102],
      destination: 'sbc-l',
      mark_as_read: true,
    });
    const result2 = await call(harness.client, 'move_messages', {
      uids: [102],
      destination: 'sbc-l',
      mark_as_read: true,
      confirm_token: tokenOf(prompt2),
    });
    const payload2 = jsonOf(result2) as {
      action: string;
      destination: string;
      uids: number[];
      messages: Array<{
        uid: number;
        destination: string;
        seen?: boolean;
        success: boolean;
      }>;
    };
    expect(payload2.action).toBe('moved');
    expect(payload2.destination).toBe('sbc-l');
    expect(payload2.uids).toEqual([102]);
    expect(payload2.messages[0]).toMatchObject({
      uid: 102,
      destination: 'sbc-l',
      seen: true,
      success: true,
    });

    // Verify messages landed in destination mailboxes with \Seen flag
    const mycolleaguesBox = mailboxes.find((m) => m.path === 'mycolleagues');
    const sbcBox = mailboxes.find((m) => m.path === 'sbc-l');
    expect(mycolleaguesBox?.messages[0]?.flags.has('\\Seen')).toBe(true);
    expect(sbcBox?.messages[0]?.flags.has('\\Seen')).toBe(true);

    await harness.close();
  });

  it('6. movimentação em lote para múltiplas pastas (batch moves)', async () => {
    const mailboxes: FakeMailbox[] = [
      {
        path: 'INBOX',
        messages: [
          message(201, { subject: 'Colleague work' }),
          message(202, { subject: 'SBC event' }),
        ],
      },
      { path: 'mycolleagues', messages: [] },
      { path: 'sbc-l', messages: [] },
    ];
    const harness = await connect({ config: writeConfig, mailboxes });

    const prompt = await call(harness.client, 'move_messages', {
      moves: [
        { uids: [201], destination: 'mycolleagues' },
        { uids: [202], destination: 'sbc-l' },
      ],
      mark_as_read: true,
    });
    expect(textOf(prompt)).toContain('confirm_token');

    const result = await call(harness.client, 'move_messages', {
      moves: [
        { uids: [201], destination: 'mycolleagues' },
        { uids: [202], destination: 'sbc-l' },
      ],
      mark_as_read: true,
      confirm_token: tokenOf(prompt),
    });

    const payload = jsonOf(result) as {
      action: string;
      uids: number[];
      destinations: string[];
      messages: Array<{
        uid: number;
        destination: string;
        seen?: boolean;
        success: boolean;
      }>;
    };
    expect(payload.action).toBe('moved');
    expect(payload.uids).toEqual([201, 202]);
    expect(payload.destinations).toEqual(['mycolleagues', 'sbc-l']);
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0]).toMatchObject({
      uid: 201,
      destination: 'mycolleagues',
      seen: true,
      success: true,
    });
    expect(payload.messages[1]).toMatchObject({
      uid: 202,
      destination: 'sbc-l',
      seen: true,
      success: true,
    });

    await harness.close();
  });

  it('7. falha ao alterar flags: não movimentar mensagens afetadas', async () => {
    const mailboxes: FakeMailbox[] = [
      {
        path: 'INBOX',
        messages: [
          message(301, { subject: 'Will fail flag' }),
          message(302, { subject: 'Will succeed flag' }),
        ],
      },
      { path: 'Archive', messages: [] },
    ];
    const harness = await connect({ config: writeConfig, mailboxes });

    // Simulate UID 301 failing flag update on server
    harness.imap.failFlagsForUids = new Set([301]);

    const prompt = await call(harness.client, 'move_messages', {
      uids: [301, 302],
      destination: 'Archive',
      mark_as_read: true,
    });

    const result = await call(harness.client, 'move_messages', {
      uids: [301, 302],
      destination: 'Archive',
      mark_as_read: true,
      confirm_token: tokenOf(prompt),
    });

    const payload = jsonOf(result) as {
      uids: number[];
      messages: Array<{
        uid: number;
        destination: string;
        success: boolean;
        seen?: boolean;
        error?: string;
      }>;
      failed: Array<{ uid: number; reason: string }>;
    };

    // Only 302 should have been moved
    expect(payload.uids).toEqual([302]);
    expect(payload.failed).toHaveLength(1);
    expect(payload.failed[0]?.uid).toBe(301);

    // UID 301 must NOT have been moved from INBOX!
    const inbox = mailboxes.find((m) => m.path === 'INBOX');
    expect(inbox?.messages.some((m) => m.uid === 301)).toBe(true);
    expect(inbox?.messages.some((m) => m.uid === 302)).toBe(false);

    // Archive must only have UID 302
    const archive = mailboxes.find((m) => m.path === 'Archive');
    expect(archive?.messages.some((m) => m.uid === 301)).toBe(false);
    expect(archive?.messages.some((m) => m.uid === 302)).toBe(true);

    await harness.close();
  });

  it('8. persistência do estado após reconexão IMAP', async () => {
    const mailboxes: FakeMailbox[] = [
      {
        path: 'INBOX',
        messages: [message(401, { subject: 'Persistent message' })],
      },
    ];
    // First session: mark as read
    const firstHarness = await connect({ config: writeConfig, mailboxes });
    await call(firstHarness.client, 'mark_messages_read', {
      uids: [401],
      seen: true,
    });
    await firstHarness.close();

    // Second session (reconnect): read state must persist
    const secondHarness = await connect({ config: writeConfig, mailboxes });
    const listRes = await call(secondHarness.client, 'list_messages', {
      limit: 10,
    });
    const payload = jsonOf(listRes) as {
      messages: Array<{ uid: number; seen: boolean; flags: string[] }>;
    };
    const msg401 = payload.messages.find((m) => m.uid === 401);
    expect(msg401).toBeDefined();
    expect(msg401?.seen).toBe(true);
    expect(msg401?.flags).toContain('\\Seen');

    await secondHarness.close();
  });

  it('9. comportamento quando um UID não existe', async () => {
    const harness = await connect({ config: writeConfig });
    // UID 99999 does not exist in default mailboxes, UID 2 exists
    const res = await call(harness.client, 'mark_messages_read', {
      uids: [2, 99999],
      seen: true,
    });
    const payload = jsonOf(res) as {
      updated: number[];
      failed: number[];
      messages: Array<{ uid: number; success: boolean; error?: string }>;
    };
    expect(payload.updated).toEqual([2]);
    expect(payload.failed).toEqual([99999]);

    const msg99999 = payload.messages.find((m) => m.uid === 99999);
    expect(msg99999?.success).toBe(false);
    expect(msg99999?.error).toContain('not found in mailbox');

    const msg2 = payload.messages.find((m) => m.uid === 2);
    expect(msg2?.success).toBe(true);

    await harness.close();
  });
});
