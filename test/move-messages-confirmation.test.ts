import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, connect, jsonOf, textOf, tokenOf } from './harness.js';
import { message, type FakeMailbox } from './fake-imap.js';
import { PersistentConfirmationStore } from '../src/confirmation-store.js';

const writeConfig = { readOnly: false };

describe('move_messages confirmation and persistence suite', () => {
  let tempStorageDir: string;

  beforeEach(() => {
    tempStorageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ufsc-imap-test-confirm-')
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    } catch {}
  });

  function customMailboxes(): FakeMailbox[] {
    return [
      {
        path: 'INBOX',
        specialUse: '\\Inbox',
        messages: [
          message(64546, { subject: 'Message 1' }),
          message(64566, { subject: 'Message 2' }),
          message(64553, { subject: 'Message 3' }),
          message(64568, { subject: 'Message 4' }),
          message(64567, { subject: 'Message 5' }),
        ],
      },
      { path: 'Archives.2026', messages: [] },
      { path: 'LATAM', messages: [] },
      { path: 'SPAM.Filtrados', messages: [] },
    ];
  }

  it('1. Confirmação válida com duas chamadas consecutivas e estrutura JSON completa', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    // Chamada 1 sem token
    const first = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
    });
    expect(textOf(first)).toContain('confirm_token');

    // Valida o retorno estruturado JSON no prompt
    const firstJson = jsonOf(first) as any;
    expect(firstJson).toMatchObject({
      status: 'confirmation_required',
      expires_in_seconds: 300,
      operation_summary: {
        mode: 'move',
        source: 'INBOX',
        message_count: 1,
        destinations: ['Archives.2026'],
      },
    });
    expect(firstJson.confirm_token).toBe(tokenOf(first));

    // Nenhuma mensagem movida antes da confirmação
    expect(
      harness.imap.calls.some((entry) => entry.name === 'messageMove')
    ).toBe(false);

    // Chamada 2 com token
    const second = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
      confirm_token: tokenOf(first),
    });
    const resultJson = jsonOf(second) as any;
    expect(resultJson).toMatchObject({
      status: 'completed',
      action: 'moved',
      source: 'INBOX',
      destination: 'Archives.2026',
      uids: [64546],
    });
    expect(resultJson.messages?.[0]?.success).toBe(true);

    await harness.close();
  });

  it('2. Confirmação válida com lote de múltiplos destinos (moves)', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    const batchArgs = {
      mailbox: 'INBOX',
      mode: 'move' as const,
      mark_as_read: true,
      moves: [
        { uids: [64546, 64566, 64553], destination: 'Archives.2026' },
        { uids: [64568], destination: 'LATAM' },
        { uids: [64567], destination: 'SPAM.Filtrados' },
      ],
    };

    // Chamada 1
    const prompt = await call(harness.client, 'move_messages', batchArgs);
    const token = tokenOf(prompt);
    expect(token).toBeTruthy();

    const promptJson = jsonOf(prompt) as any;
    expect(promptJson.operation_summary.message_count).toBe(5);
    expect(promptJson.operation_summary.destinations).toEqual([
      'Archives.2026',
      'LATAM',
      'SPAM.Filtrados',
    ]);

    // Chamada 2 com token
    const exec = await call(harness.client, 'move_messages', {
      ...batchArgs,
      confirm_token: token,
    });
    const execJson = jsonOf(exec) as any;
    expect(execJson.status).toBe('completed');
    expect(execJson.action).toBe('moved');
    expect(execJson.uids).toHaveLength(5);
    expect(execJson.messages).toHaveLength(5);
    expect(execJson.messages.every((m: any) => m.success)).toBe(true);

    await harness.close();
  });

  it('3. Confirmação com equivalência canônica entre campos omitidos e valores padrão', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    // Chamada 1 com campos omitidos (mode omitido -> 'move', mark_as_read omitido -> false, mailbox omitido -> 'INBOX')
    const first = await call(harness.client, 'move_messages', {
      uids: [64546],
      destination: 'Archives.2026',
    });
    const token = tokenOf(first);

    // Chamada 2 fornecendo explicitamente os valores padrão
    const second = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      mode: 'move',
      mark_as_read: false,
      uids: [64546],
      destination: 'Archives.2026',
      confirm_token: token,
    });
    expect(jsonOf(second)).toMatchObject({
      action: 'moved',
      uids: [64546],
    });

    await harness.close();
  });

  it('4. Equivalência canônica entre uids/destination e moves equivalente', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    // Chamada 1 via uids/destination
    const first = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
    });
    const token = tokenOf(first);

    // Chamada 2 via moves com a mesma operação
    const second = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      moves: [{ uids: [64546], destination: 'Archives.2026' }],
      confirm_token: token,
    });
    expect(jsonOf(second)).toMatchObject({
      action: 'moved',
      uids: [64546],
    });

    await harness.close();
  });

  it('5. Independência da ordenação das propriedades JSON e de UIDs', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    // Chamada 1 com UIDs [64546, 64566]
    const first = await call(harness.client, 'move_messages', {
      destination: 'Archives.2026',
      uids: [64546, 64566],
      mailbox: 'INBOX',
    });
    const token = tokenOf(first);

    // Chamada 2 com propriedades em ordem diferente e UIDs invertidos [64566, 64546]
    const second = await call(harness.client, 'move_messages', {
      confirm_token: token,
      mailbox: 'INBOX',
      uids: [64566, 64546],
      destination: 'Archives.2026',
    });
    const res = jsonOf(second) as any;
    expect(res.action).toBe('moved');
    expect(res.uids.sort()).toEqual([64546, 64566]);

    await harness.close();
  });

  it('6. Rejeição de token inválido ou adulterado', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    const result = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
      confirm_token: 'deadbeef0123456789abcdef01234567',
    });
    expect(textOf(result)).toContain('invalid, expired');
    expect(
      harness.imap.calls.some((entry) => entry.name === 'messageMove')
    ).toBe(false);

    await harness.close();
  });

  it('7. Rejeição de token expirado', async () => {
    // TTL de 10ms
    const store = new PersistentConfirmationStore(10, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    const first = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
    });
    const token = tokenOf(first);

    // Aguarda expiração
    await new Promise((r) => setTimeout(r, 25));

    const second = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
      confirm_token: token,
    });
    expect(textOf(second)).toContain('invalid, expired');

    await harness.close();
  });

  it('8. Rejeição de token reutilizado (single-use guarantee)', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    const first = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
    });
    const token = tokenOf(first);

    // Primeira execução consome o token com sucesso
    const second = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
      confirm_token: token,
    });
    expect(jsonOf(second)).toMatchObject({ action: 'moved' });

    // Segunda execução com o MESMO token é rejeitada
    const third = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
      confirm_token: token,
    });
    expect(textOf(third)).toContain('invalid, expired');

    await harness.close();
  });

  it('9. Rejeição quando UID ou destino são alterados após emissão do token', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    const first = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
    });
    const token = tokenOf(first);

    // Tentativa de usar token para mover para destino diferente
    const badDest = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'LATAM',
      confirm_token: token,
    });
    expect(textOf(badDest)).toContain('invalid, expired');

    // Tentativa de usar token para mover conjunto ampliado de UIDs
    const badUids = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546, 64568],
      destination: 'Archives.2026',
      confirm_token: token,
    });
    expect(textOf(badUids)).toContain('invalid, expired');

    await harness.close();
  });

  it('10. Chamadas atendidas por instâncias/processos diferentes (compartilhando armazenamento persistente)', async () => {
    // Instância A emite o token
    const storeA = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harnessA = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: storeA,
    });

    const first = await call(harnessA.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
    });
    const token = tokenOf(first);
    await harnessA.close();

    // Instância B (processo/conexão totalmente separada) recebe a segunda chamada com o token
    const storeB = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harnessB = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: storeB,
    });

    const second = await call(harnessB.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546],
      destination: 'Archives.2026',
      confirm_token: token,
    });
    expect(jsonOf(second)).toMatchObject({
      action: 'moved',
      destination: 'Archives.2026',
      uids: [64546],
    });

    await harnessB.close();
  });

  it('11. Falha parcial de movimentação IMAP relata estado individual de cada mensagem', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    // 64546 existe, 99999 não existe na INBOX
    const first = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546, 99999],
      destination: 'Archives.2026',
      mark_as_read: true,
    });
    const token = tokenOf(first);

    const second = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      uids: [64546, 99999],
      destination: 'Archives.2026',
      mark_as_read: true,
      confirm_token: token,
    });
    const res = jsonOf(second) as any;

    expect(res.uids).toContain(64546);
    expect(res.uids).not.toContain(99999);
    expect(res.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uid: 99999,
          destination: 'Archives.2026',
        }),
      ])
    );

    await harness.close();
  });

  it('12. Operação copy mantém mensagens originais na caixa de origem', async () => {
    const store = new PersistentConfirmationStore(300_000, tempStorageDir);
    const harness = await connect({
      config: writeConfig,
      mailboxes: customMailboxes(),
      confirmations: store,
    });

    const first = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      mode: 'copy',
      uids: [64546],
      destination: 'Archives.2026',
    });
    const token = tokenOf(first);

    const second = await call(harness.client, 'move_messages', {
      mailbox: 'INBOX',
      mode: 'copy',
      uids: [64546],
      destination: 'Archives.2026',
      confirm_token: token,
    });
    const res = jsonOf(second) as any;
    expect(res.action).toBe('copied');
    expect(res.uids).toEqual([64546]);

    // Operação messageCopy executada sem messageMove
    expect(harness.imap.calls.some((c) => c.name === 'messageCopy')).toBe(true);
    expect(harness.imap.calls.some((c) => c.name === 'messageMove')).toBe(false);

    await harness.close();
  });
});
