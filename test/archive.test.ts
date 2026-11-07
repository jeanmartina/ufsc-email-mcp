import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeCrc32 } from '../src/archive.js';
import {
  cleanupAllTempFiles,
  resolveTempDownload,
  runWithRequestContext,
  sweepExpiredTempFiles,
} from '../src/temp-store.js';
import {
  buildDocx,
  buildMultiPagePdf,
  buildPdf,
  patchDeclaredSize,
  zip,
} from './document-fixtures.js';
import { message } from './fake-imap.js';
import { call, connect, jsonOf, textOf } from './harness.js';

afterEach(async () => {
  await cleanupAllTempFiles();
  vi.restoreAllMocks();
});

function fields(result: {
  structuredContent?: unknown;
}): Record<string, unknown> {
  const value = result.structuredContent;
  if (value === undefined) {
    throw new Error('result carries no structuredContent');
  }
  return value as Record<string, unknown>;
}

/**
 * Builds a raw PKZIP archive by hand so tests can craft symlinks, encrypted
 * entries, overlapping local headers (zbsm.zip), stored 13 MB blobs, and CRC errors.
 */
interface RawZipEntrySpec {
  name: string;
  data: Buffer;
  method?: 0 | 8 | 99;
  gpbf?: number;
  versionMadeBy?: number;
  externalAttr?: number;
  declaredUncompressed?: number;
  crcOverride?: number;
  localOffsetOverride?: number;
}

function buildCustomZip(specs: RawZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let localOffset = 0;

  for (const spec of specs) {
    const nameBytes = Buffer.from(spec.name, 'utf-8');
    const method = spec.method ?? 8;
    const gpbf = spec.gpbf ?? 0x0800; // UTF-8
    const crc = spec.crcOverride ?? computeCrc32(spec.data);
    const compressed =
      method === 0 ? spec.data : deflateRawSync(spec.data, { level: 6 });
    const uncompressedSize = spec.declaredUncompressed ?? spec.data.length;

    const entryLocalOffset = spec.localOffsetOverride ?? localOffset;

    if (spec.localOffsetOverride === undefined) {
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(gpbf, 6);
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt16LE(0, 10);
      localHeader.writeUInt16LE(0, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(compressed.length, 18);
      localHeader.writeUInt32LE(uncompressedSize, 22);
      localHeader.writeUInt16LE(nameBytes.length, 26);
      localHeader.writeUInt16LE(0, 28);
      localParts.push(localHeader, nameBytes, compressed);
      localOffset += localHeader.length + nameBytes.length + compressed.length;
    }

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(spec.versionMadeBy ?? 0x0314, 4); // Unix
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(gpbf, 8);
    cdHeader.writeUInt16LE(method, 10);
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressed.length, 20);
    cdHeader.writeUInt32LE(uncompressedSize, 24);
    cdHeader.writeUInt16LE(nameBytes.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(spec.externalAttr ?? (0o100644 << 16) >>> 0, 38);
    cdHeader.writeUInt32LE(entryLocalOffset, 42);
    cdParts.push(cdHeader, nameBytes);
  }

  const cdBuffer = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuffer, eocd]);
}

describe('ZIP archives and large attachments (~13 MB acceptance suite)', () => {
  it('inspects a ~13 MB application/x-zip-compressed archive with multiple PDFs and DOCXs, paginates text with page traceability, and keeps mailbox strictly read-only', async () => {
    const multiPagePdf = buildMultiPagePdf(8);
    const summaryPdf = Buffer.concat([
      Buffer.from('\n\n'),
      buildPdf({
        text: 'Parecer Tecnico Questao 75 aprovado pela banca.',
      }),
    ]);
    const docxA = buildDocx([
      'Memorial descritivo do recurso administrativo.',
      'Fundamentacao bibliografica completa.',
    ]);
    const docxB = buildDocx(['Anexo complementar em formato Word.']);
    const htmlDoc = Buffer.from(
      '<html><head><style>.secret{display:none}</style><script>alert(1)</script></head>' +
        '<body><h1>Resumo HTML</h1><p>Conteudo visivel ao avaliador.</p></body></html>',
      'utf-8'
    );
    const rtfDoc = Buffer.from(
      '{\\rtf1\\ansi\\b Nota Oficial\\b0\\par Texto em RTF legivel.}',
      'utf-8'
    );
    // Stored high-entropy image payload to bring archive size to ~13 MB (matching real case 12.9 MB).
    const highEntropyPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(12_900_000),
    ]);

    const archive = buildCustomZip([
      { name: 'questao_75/relatorio_paginas.pdf', data: multiPagePdf },
      { name: 'questao_75/parecer_banca.pdf', data: summaryPdf },
      { name: 'questao_75/recurso_candidato.docx', data: docxA },
      { name: 'questao_75/anexo_extra.docx', data: docxB },
      {
        name: 'questao_75/observacoes.txt',
        data: Buffer.from('Observacao textual simples linha 1.\nLinha 2.'),
      },
      { name: 'questao_75/espelho.html', data: htmlDoc },
      { name: 'questao_75/despacho.rtf', data: rtfDoc },
      {
        name: 'questao_75/evidencia_alta_resolucao.png',
        data: highEntropyPng,
        method: 0,
      },
    ]);

    expect(archive.length).toBeGreaterThan(12_800_000);
    expect(archive.length).toBeLessThan(25 * 1024 * 1024);

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const harness = await connect({
      mailboxes: [
        {
          path: 'INBOX',
          messages: [
            message(64553, {
              from: { name: 'Candidato', address: 'adpinter@gmail.com' },
              subject: 'Documentacao Questao 75',
              attachments: [
                {
                  partId: '2',
                  filename: 'docs_questao_75-20261106.zip',
                  contentType: 'application/x-zip-compressed',
                  content: archive,
                },
              ],
            }),
          ],
        },
      ],
    });

    // 1. get_attachments lists the 12.9 MB application/x-zip-compressed attachment as allowed & archive=true
    const attList = jsonOf(
      await call(harness.client, 'get_attachments', {
        mailbox: 'INBOX',
        uid: 64553,
      })
    ) as {
      attachments: Array<{
        part_id: string;
        filename: string;
        content_type: string;
        allowed: boolean;
        archive: boolean;
      }>;
    };
    expect(attList.attachments[0]).toMatchObject({
      part_id: '2',
      filename: 'docs_questao_75-20261106.zip',
      content_type: 'application/x-zip-compressed',
      allowed: true,
      archive: true,
    });

    // 2. list_archive_entries inspects all 8 entries without extracting payloads
    const listedResult = await call(harness.client, 'list_archive_entries', {
      mailbox: 'INBOX',
      uid: 64553,
      part_id: '2',
    });
    expect(listedResult.isError).toBeFalsy();
    const listed = jsonOf(listedResult) as {
      archive_filename: string;
      declared_mime_type: string;
      detected_mime_type: string;
      total_entries: number;
      blocked_entries: number;
      entries: Array<{
        name: string;
        entry_path: string;
        extension: string;
        mime_type: string;
        compressed_bytes: number;
        uncompressed_bytes: number;
        readable_as_text: boolean;
        allowed: boolean;
      }>;
    };
    expect(listed.archive_filename).toBe('docs_questao_75-20261106.zip');
    expect(listed.declared_mime_type).toBe('application/x-zip-compressed');
    expect(listed.detected_mime_type).toBe('application/zip');
    expect(listed.total_entries).toBe(8);
    expect(listed.blocked_entries).toBe(0);
    expect(listed.entries.map((e) => e.entry_path)).toContain(
      'questao_75/relatorio_paginas.pdf'
    );

    const pdfMeta = listed.entries.find(
      (e) => e.entry_path === 'questao_75/relatorio_paginas.pdf'
    )!;
    expect(pdfMeta.mime_type).toBe('application/pdf');
    expect(pdfMeta.readable_as_text).toBe(true);
    expect(pdfMeta.uncompressed_bytes).toBe(multiPagePdf.length);

    // 3. Paginate through the 8-page PDF in small slices and reconstruct the entire text
    const reconstructed: string[] = [];
    const seenPageRanges: Array<{ from_page: number; to_page: number }> = [];
    let cursor: number | null = 0;
    let safety = 0;

    while (cursor !== null && safety < 30) {
      safety += 1;
      const pageRes = await call(harness.client, 'read_archive_entry', {
        mailbox: 'INBOX',
        uid: 64553,
        part_id: '2',
        entry_path: 'questao_75/relatorio_paginas.pdf',
        mode: 'text',
        offset: cursor,
        max_chars: 45,
      });
      expect(pageRes.isError).toBeFalsy();
      const structured = fields(pageRes);
      expect(structured.archive_filename).toBe('docs_questao_75-20261106.zip');
      expect(structured.entry_path).toBe('questao_75/relatorio_paginas.pdf');
      expect(structured.page_count).toBe(8);
      expect(structured.page_range).toBeDefined();
      seenPageRanges.push(
        structured.page_range as { from_page: number; to_page: number }
      );
      reconstructed.push(structured.body as string);
      cursor = structured.next_offset as number | null;
    }

    const fullPdfText = reconstructed.join('');
    for (let p = 1; p <= 8; p += 1) {
      expect(fullPdfText).toContain(`== Page ${p} ==`);
      expect(fullPdfText).toContain(`Seite ${p}`);
    }
    expect(seenPageRanges[0]?.from_page).toBe(1);
    expect(seenPageRanges.at(-1)?.to_page).toBe(8);

    // 4. Read DOCX, TXT, HTML, and RTF entries inside the archive
    const docxRes = await call(harness.client, 'read_archive_entry', {
      mailbox: 'INBOX',
      uid: 64553,
      part_id: '2',
      entry_path: 'questao_75/recurso_candidato.docx',
    });
    expect(fields(docxRes).body).toContain(
      'Memorial descritivo do recurso administrativo.'
    );

    const htmlRes = await call(harness.client, 'read_archive_entry', {
      mailbox: 'INBOX',
      uid: 64553,
      part_id: '2',
      entry_path: 'questao_75/espelho.html',
    });
    expect(fields(htmlRes).body).toContain('Conteudo visivel ao avaliador.');
    expect(fields(htmlRes).body).not.toContain('alert(1)');

    const rtfRes = await call(harness.client, 'read_archive_entry', {
      mailbox: 'INBOX',
      uid: 64553,
      part_id: '2',
      entry_path: 'questao_75/despacho.rtf',
    });
    expect(fields(rtfRes).body).toContain('Texto em RTF legivel.');

    const leadingNewlinePdfRes = await call(
      harness.client,
      'read_archive_entry',
      {
        mailbox: 'INBOX',
        uid: 64553,
        part_id: '2',
        entry_path: 'questao_75/parecer_banca.pdf',
      }
    );
    expect(leadingNewlinePdfRes.isError).toBeFalsy();
    expect(fields(leadingNewlinePdfRes).body).toContain(
      'Parecer Tecnico Questao 75 aprovado pela banca.'
    );

    // 5. Verify strictly read-only mailbox operations and privacy-preserving audit logs
    expect(harness.imap.lockLog.length).toBeGreaterThan(0);
    expect(harness.imap.lockLog.every((lock) => lock.readOnly)).toBe(true);
    expect(
      harness.imap.calls.some((c) =>
        [
          'messageFlagsAdd',
          'messageFlagsRemove',
          'messageFlagsSet',
          'messageMove',
          'messageCopy',
          'messageDelete',
          'append',
        ].includes(c.name)
      )
    ).toBe(false);

    const auditLines = stderrSpy.mock.calls.flat().join('\n');
    expect(auditLines).toContain('list_archive_entries');
    expect(auditLines).toContain('read_archive_entry');
    // Confidential filenames, paths, senders, and document contents must NEVER appear in logs.
    expect(auditLines).not.toContain('docs_questao_75');
    expect(auditLines).not.toContain('recurso_candidato');
    expect(auditLines).not.toContain('Memorial descritivo');
    expect(auditLines).not.toContain('adpinter@gmail.com');

    await harness.close();
  });

  it('materializes original archive entries and attachments into an isolated 0700/0600 temp store with capability URLs and automatic TTL cleanup', async () => {
    const rawPdf = buildPdf({
      text: 'Documento original preservado bit a bit',
    });
    const archive = zip({ 'laudos/original.pdf': rawPdf });

    const harness = await connect({
      mailboxes: [
        {
          path: 'INBOX',
          messages: [
            message(21, {
              attachments: [
                {
                  partId: '2',
                  filename: 'pacote.zip',
                  contentType: 'application/zip',
                  content: archive,
                },
              ],
            }),
          ],
        },
      ],
    });

    const stagedResult = await runWithRequestContext(
      { baseUrl: 'https://n8n.labsec.ufsc.br/mcp/email' },
      () =>
        call(harness.client, 'read_archive_entry', {
          mailbox: 'INBOX',
          uid: 21,
          part_id: '2',
          entry_path: 'laudos/original.pdf',
          mode: 'download',
        })
    );
    expect(stagedResult.isError).toBeFalsy();

    // Ensure raw binary/base64 was NOT dumped into MCP JSON response
    expect(textOf(stagedResult)).not.toContain(rawPdf.toString('base64'));

    const payload = jsonOf(stagedResult) as {
      action: string;
      temp_path: string;
      download_url: string;
      sha256: string;
      uncompressed_bytes: number;
    };
    expect(payload.action).toBe('materialized');
    expect(payload.uncompressed_bytes).toBe(rawPdf.length);
    expect(payload.download_url).toMatch(
      /^https:\/\/n8n\.labsec\.ufsc\.br\/mcp\/email\/files\/dl_[0-9a-f]{64}\/original\.pdf$/
    );

    const diskBytes = await readFile(payload.temp_path);
    expect(diskBytes.equals(rawPdf)).toBe(true);
    const fileInfo = await stat(payload.temp_path);
    expect(fileInfo.mode & 0o777).toBe(0o600);

    const tokenMatch = /\/files\/(dl_[0-9a-f]{64})\//.exec(
      payload.download_url
    );
    expect(tokenMatch?.[1]).toBeDefined();
    const resolved = await resolveTempDownload(tokenMatch![1]!);
    expect(resolved?.sha256).toBe(payload.sha256);

    // Advance time past TTL and verify automatic cleanup deletes the file from disk
    const removed = await sweepExpiredTempFiles(Date.now() + 3600 * 1000);
    expect(removed).toBe(1);
    expect(await resolveTempDownload(tokenMatch![1]!)).toBeUndefined();
    await expect(stat(payload.temp_path)).rejects.toThrow();

    await harness.close();
  });
});

async function singlePartHarness(
  attachment: {
    filename: string;
    contentType: string;
    content: Buffer;
    declaredSize?: number;
  },
  options: Parameters<typeof connect>[0] = {}
) {
  return connect({
    ...options,
    mailboxes: [
      {
        path: 'INBOX',
        messages: [
          message(50, {
            attachments: [
              {
                partId: '2',
                ...attachment,
              },
            ],
          }),
        ],
      },
    ],
  });
}

describe('ZIP security defenses and actionable error differentiation', () => {
  it('rejects non-ZIP content masquerading behind application/zip (magic-byte check)', async () => {
    const harness = await singlePartHarness({
      filename: 'fake.zip',
      contentType: 'application/x-zip-compressed',
      content: Buffer.from('<html>not a zip archive at all</html>'),
    });

    const res = await call(harness.client, 'list_archive_entries', {
      uid: 50,
      part_id: '2',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('[error_code=invalid_archive]');
    await harness.close();
  });

  it('blocks path traversal (../), backslashes, absolute paths, and symbolic links', async () => {
    const maliciousZip = buildCustomZip([
      { name: '../../etc/passwd', data: Buffer.from('root:x:0:0:') },
      { name: '/etc/shadow', data: Buffer.from('root:*:') },
      { name: 'sub\\..\\win.ini', data: Buffer.from('[fonts]') },
      {
        name: 'docs/link_secret.txt',
        data: Buffer.from('/etc/hostname'),
        versionMadeBy: 0x0314,
        externalAttr: (0o120777 << 16) >>> 0,
      },
      {
        name: 'docs/legitimo.txt',
        data: Buffer.from('Arquivo seguro dentro do mesmo ZIP.'),
      },
    ]);

    const harness = await singlePartHarness({
      filename: 'mixed.zip',
      contentType: 'application/zip',
      content: maliciousZip,
    });

    const listRes = await call(harness.client, 'list_archive_entries', {
      uid: 50,
      part_id: '2',
    });
    expect(listRes.isError).toBeFalsy();
    const listing = jsonOf(listRes) as {
      blocked_entries: number;
      entries: Array<{
        entry_path: string;
        allowed: boolean;
        is_symlink: boolean;
        error_code?: string;
      }>;
    };
    expect(listing.blocked_entries).toBe(4);

    // Every malicious entry is refused with its specific security code on read_archive_entry
    const traversal = await call(harness.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: '../../etc/passwd',
    });
    expect(traversal.isError).toBe(true);
    expect(textOf(traversal)).toContain('[error_code=path_traversal]');

    const abs = await call(harness.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'etc/shadow',
    });
    expect(abs.isError).toBe(true);
    expect(textOf(abs)).toContain('[error_code=absolute_path]');

    const symlink = await call(harness.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'docs/link_secret.txt',
    });
    expect(symlink.isError).toBe(true);
    expect(textOf(symlink)).toContain('[error_code=symlink_entry]');

    // Meanwhile the safe sibling remains readable
    const safe = await call(harness.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'docs/legitimo.txt',
    });
    expect(safe.isError).toBeFalsy();
    expect(fields(safe).body).toContain('Arquivo seguro');

    await harness.close();
  });

  it('blocks executables both by extension and when disguised as a PDF by magic bytes', async () => {
    const mzExe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00]);
    const archive = buildCustomZip([
      { name: 'payload.exe', data: mzExe },
      { name: 'disguised_invoice.pdf', data: mzExe },
    ]);

    const harness = await singlePartHarness({
      filename: 'executables.zip',
      contentType: 'application/zip',
      content: archive,
    });

    const extBlocked = await call(harness.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'payload.exe',
    });
    expect(extBlocked.isError).toBe(true);
    expect(textOf(extBlocked)).toContain('[error_code=executable_blocked]');

    const magicBlocked = await call(harness.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'disguised_invoice.pdf',
      mode: 'download',
    });
    expect(magicBlocked.isError).toBe(true);
    expect(textOf(magicBlocked)).toContain('[error_code=executable_blocked]');

    await harness.close();
  });

  it('defeats high-ratio ZIP bombs, spoofed uncompressed header sizes, overlapping local headers, and excessive entry counts', async () => {
    // 1. High compression ratio bomb (1 MB of zeroes compresses > 200:1)
    const zeroBomb = zip({ 'bomb.txt': Buffer.alloc(1_500_000, 0x41) });
    const h1 = await singlePartHarness({
      filename: 'ratio_bomb.zip',
      contentType: 'application/zip',
      content: zeroBomb,
    });
    const r1 = await call(h1.client, 'list_archive_entries', {
      uid: 50,
      part_id: '2',
    });
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toContain('[error_code=zip_bomb]');
    await h1.close();

    // 2. Spoofed small uncompressedSize header while deflate stream actually expands further
    const lyingZip = patchDeclaredSize(
      zip({ 'lie.txt': Buffer.from('A'.repeat(20_000)) }),
      32
    );
    const h2 = await singlePartHarness({
      filename: 'lying_header.zip',
      contentType: 'application/zip',
      content: lyingZip,
    });
    const r2 = await call(h2.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'lie.txt',
    });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toContain('[error_code=zip_bomb]');
    await h2.close();

    // 3. Fifield overlapping local header bomb (two CD records sharing offset 0)
    const overlapping = buildCustomZip([
      { name: 'a.txt', data: Buffer.from('shared payload') },
      {
        name: 'b.txt',
        data: Buffer.from('shared payload'),
        localOffsetOverride: 0,
      },
    ]);
    const h3 = await singlePartHarness({
      filename: 'zbsm.zip',
      contentType: 'application/zip',
      content: overlapping,
    });
    const r3 = await call(h3.client, 'list_archive_entries', {
      uid: 50,
      part_id: '2',
    });
    expect(r3.isError).toBe(true);
    expect(textOf(r3)).toContain('[error_code=zip_bomb]');
    await h3.close();

    // 4. Excessive entry count (> maxArchiveEntries)
    const manyFiles = Object.fromEntries(
      Array.from({ length: 15 }, (_, idx) => [`f${idx}.txt`, 'ok'])
    );
    const h4 = await singlePartHarness(
      {
        filename: 'many.zip',
        contentType: 'application/zip',
        content: zip(manyFiles),
      },
      { config: { imap: { maxArchiveEntries: 10 } as never } }
    );
    const r4 = await call(h4.client, 'list_archive_entries', {
      uid: 50,
      part_id: '2',
    });
    expect(r4.isError).toBe(true);
    expect(textOf(r4)).toContain('[error_code=zip_bomb]');
    await h4.close();
  });

  it('refuses password-protected ZIP entries and password-protected inner PDFs with encrypted_archive', async () => {
    const encryptedArchive = buildCustomZip([
      {
        name: 'secret_zip_entry.pdf',
        data: Buffer.from('ciphertext'),
        gpbf: 0x0801, // bit 0 = encrypted
      },
      {
        name: 'locked_inner.pdf',
        data: buildPdf({ encrypted: true }),
      },
    ]);

    const harness = await singlePartHarness({
      filename: 'protected.zip',
      contentType: 'application/zip',
      content: encryptedArchive,
    });

    const zipEnc = await call(harness.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'secret_zip_entry.pdf',
    });
    expect(zipEnc.isError).toBe(true);
    expect(textOf(zipEnc)).toContain('[error_code=encrypted_archive]');

    const pdfEnc = await call(harness.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'locked_inner.pdf',
    });
    expect(pdfEnc.isError).toBe(true);
    expect(textOf(pdfEnc)).toContain('[error_code=encrypted_archive]');

    await harness.close();
  });

  it('differentiates corrupt_archive (truncated ZIP / bad CRC-32) from corrupt_document (damaged PDF)', async () => {
    const truncated = zip({ 'a.txt': 'hello world' }).subarray(0, 18);
    const h1 = await singlePartHarness({
      filename: 'truncated.zip',
      contentType: 'application/zip',
      content: truncated,
    });
    const r1 = await call(h1.client, 'list_archive_entries', {
      uid: 50,
      part_id: '2',
    });
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toContain('[error_code=corrupt_archive]');
    await h1.close();

    const badCrcAndDoc = buildCustomZip([
      {
        name: 'bad_crc.txt',
        data: Buffer.from('corrupted in transit'),
        crcOverride: 0xdeadbeef,
      },
      {
        name: 'broken.pdf',
        data: Buffer.from('%PDF-1.4\nnot valid xref or objects'),
      },
    ]);
    const h2 = await singlePartHarness({
      filename: 'damaged.zip',
      contentType: 'application/zip',
      content: badCrcAndDoc,
    });

    const crcErr = await call(h2.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'bad_crc.txt',
    });
    expect(crcErr.isError).toBe(true);
    expect(textOf(crcErr)).toContain('[error_code=corrupt_archive]');

    const docErr = await call(h2.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'broken.pdf',
    });
    expect(docErr.isError).toBe(true);
    expect(textOf(docErr)).toContain('[error_code=corrupt_document]');
    await h2.close();
  });

  it('reports timeout cleanly when isolated child extraction exceeds limit', async () => {
    const archive = zip({ 'slow.pdf': buildMultiPagePdf(25) });
    const harness = await singlePartHarness(
      {
        filename: 'slow.zip',
        contentType: 'application/zip',
        content: archive,
      },
      { extractLimits: { timeoutMs: 1 } }
    );

    const res = await call(harness.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'slow.pdf',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('[error_code=timeout]');
    await harness.close();
  });

  it('enforces configured archive, total uncompressed, and per-entry byte limits with size_exceeded', async () => {
    const payloadA = randomBytes(4_000);
    const payloadB = randomBytes(4_000);
    const archive = buildCustomZip([
      { name: 'a.txt', data: Buffer.from(payloadA.toString('hex')), method: 0 },
      { name: 'b.txt', data: Buffer.from(payloadB.toString('hex')), method: 0 },
    ]);

    // 1. Archive compressed size > IMAP_MAX_ARCHIVE_BYTES
    const hOuter = await singlePartHarness(
      {
        filename: 'too_big.zip',
        contentType: 'application/zip',
        content: archive,
      },
      { config: { imap: { maxArchiveBytes: 1_000 } as never } }
    );
    const rOuter = await call(hOuter.client, 'list_archive_entries', {
      uid: 50,
      part_id: '2',
    });
    expect(rOuter.isError).toBe(true);
    expect(textOf(rOuter)).toContain('[error_code=size_exceeded]');
    await hOuter.close();

    // 2. Total uncompressed > IMAP_MAX_ARCHIVE_TOTAL_BYTES
    const hTotal = await singlePartHarness(
      {
        filename: 'total_exceeded.zip',
        contentType: 'application/zip',
        content: archive,
      },
      { config: { imap: { maxArchiveTotalBytes: 10_000 } as never } }
    );
    const rTotal = await call(hTotal.client, 'list_archive_entries', {
      uid: 50,
      part_id: '2',
    });
    expect(rTotal.isError).toBe(true);
    expect(textOf(rTotal)).toContain('[error_code=size_exceeded]');
    await hTotal.close();

    // 3. Single entry > IMAP_MAX_ARCHIVE_ENTRY_BYTES
    const hEntry = await singlePartHarness(
      {
        filename: 'entry_exceeded.zip',
        contentType: 'application/zip',
        content: archive,
      },
      { config: { imap: { maxArchiveEntryBytes: 5_000 } as never } }
    );
    const rEntry = await call(hEntry.client, 'read_archive_entry', {
      uid: 50,
      part_id: '2',
      entry_path: 'a.txt',
    });
    expect(rEntry.isError).toBe(true);
    expect(textOf(rEntry)).toContain('[error_code=size_exceeded]');
    await hEntry.close();
  });
});
