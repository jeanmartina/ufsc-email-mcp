import type { MessageStructureObject } from 'imapflow';
import { describe, expect, it } from 'vitest';

import {
  checkPolicy,
  collectAttachments,
  EXECUTABLE_EXTENSIONS,
  extensionOf,
  sanitizeFilename,
  sniffContent,
  type AttachmentCandidate,
} from '../src/attachments.js';
import { DEFAULT_ATTACHMENT_TYPES } from '../src/config.js';

const policy = {
  allowedTypes: DEFAULT_ATTACHMENT_TYPES,
  maxBytes: 1024,
  maxBytesName: 'IMAP_MAX_ATTACHMENT_BYTES',
};

function candidate(
  overrides: Partial<AttachmentCandidate> = {}
): AttachmentCandidate {
  return {
    partId: '2',
    filename: 'report.pdf',
    contentType: 'application/pdf',
    size: 100,
    disposition: 'attachment',
    allowed: true,
    notes: [],
    ...overrides,
  };
}

describe('sanitizeFilename', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFilename('Invoice 2026-08.pdf')).toBe('Invoice 2026-08.pdf');
  });

  it('replaces path separators and drops the leading dots', () => {
    const cleaned = sanitizeFilename('../../etc/passwd');
    expect(cleaned).toBe('_.._etc_passwd');
    expect(cleaned).not.toMatch(/[/\\]/);
    expect(cleaned.startsWith('.')).toBe(false);
  });

  it('replaces Windows separators too', () => {
    expect(sanitizeFilename('C:\\Windows\\System32\\evil.txt')).toBe(
      'C:_Windows_System32_evil.txt'
    );
  });

  it('strips a right-to-left override that disguises the extension', () => {
    // "invoice[RLO]fdp.exe" renders as "invoiceexe.pdf" in many clients.
    expect(sanitizeFilename('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
  });

  it('falls back for an empty or missing name', () => {
    expect(sanitizeFilename(undefined)).toBe('(unnamed)');
    expect(sanitizeFilename('   ')).toBe('(unnamed)');
    expect(sanitizeFilename('...')).toBe('(unnamed)');
  });

  it('truncates a very long name', () => {
    expect(sanitizeFilename('a'.repeat(400)).length).toBeLessThanOrEqual(121);
  });
});

describe('extensionOf', () => {
  it.each([
    ['report.pdf', 'pdf'],
    ['Archive.TAR.GZ', 'gz'],
    ['noextension', ''],
    ['trailing.', ''],
    // A hyphen and eleven characters: both were outside the old character
    // class, and an extension that reads as '' is one checkPolicy skips.
    ['launch.appref-ms', 'appref-ms'],
    ['setup.application', 'application'],
  ])('reads %s as %s', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });
});

describe('collectAttachments', () => {
  it('returns nothing for a plain text message', () => {
    const structure: MessageStructureObject = {
      part: '1',
      type: 'text/plain',
      size: 10,
    };
    expect(collectAttachments(structure)).toEqual([]);
  });

  it('finds an attachment next to the body', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        {
          part: '2',
          type: 'application/pdf',
          size: 500,
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.pdf' },
        },
      ],
    };
    expect(collectAttachments(structure)).toMatchObject([
      { partId: '2', filename: 'report.pdf', contentType: 'application/pdf' },
    ]);
  });

  it('descends into a forwarded message', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        {
          type: 'message/rfc822',
          childNodes: [
            {
              type: 'multipart/mixed',
              childNodes: [
                { part: '2.1', type: 'text/plain', size: 5 },
                {
                  part: '2.2',
                  type: 'image/png',
                  size: 20,
                  disposition: 'attachment',
                  dispositionParameters: { filename: 'inner.png' },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(collectAttachments(structure).map((a) => a.partId)).toEqual(['2.2']);
  });

  it('counts an inline image as an attachment', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', size: 10 },
        {
          part: '2',
          type: 'image/png',
          size: 20,
          disposition: 'inline',
          parameters: { name: 'tracker.png' },
        },
      ],
    };
    expect(collectAttachments(structure)).toHaveLength(1);
  });

  it('flags a double extension', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 1 },
        {
          part: '2',
          type: 'application/pdf',
          size: 10,
          disposition: 'attachment',
          dispositionParameters: { filename: 'invoice.pdf.exe' },
        },
      ],
    };
    expect(collectAttachments(structure)[0]?.notes.join(' ')).toContain(
      'double extension'
    );
  });

  it('stops descending at the depth limit instead of looping', () => {
    let node: MessageStructureObject = {
      part: '9',
      type: 'application/pdf',
      size: 1,
      dispositionParameters: { filename: 'deep.pdf' },
    };
    for (let i = 0; i < 12; i += 1) {
      node = { type: 'multipart/mixed', childNodes: [node] };
    }
    expect(collectAttachments(node)).toEqual([]);
  });
});

describe('checkPolicy', () => {
  it('allows an ordinary PDF', () => {
    expect(checkPolicy(candidate(), policy).allowed).toBe(true);
  });

  it('refuses an executable extension', () => {
    const result = checkPolicy(
      candidate({ filename: 'setup.exe', contentType: 'application/pdf' }),
      policy
    );
    expect(result.allowed).toBe(false);
    expect(result.notes.join(' ')).toContain('executable file type');
  });

  it('refuses a content type outside the allowlist', () => {
    const result = checkPolicy(
      candidate({ contentType: 'application/x-sh', filename: 'x.txt' }),
      policy
    );
    expect(result.allowed).toBe(false);
    expect(result.notes.join(' ')).toContain('allowlist');
  });

  it('refuses an oversized declaration', () => {
    const result = checkPolicy(candidate({ size: 999_999 }), policy);
    expect(result.allowed).toBe(false);
    expect(result.notes.join(' ')).toContain('IMAP_MAX_ATTACHMENT_BYTES');
  });

  it('does not mutate the input', () => {
    const input = candidate({ filename: 'setup.exe' });
    checkPolicy(input, policy);
    expect(input.allowed).toBe(true);
    expect(input.notes).toEqual([]);
  });

  it.each([...EXECUTABLE_EXTENSIONS])(
    'refuses .%s, so the whole blocklist stays reachable',
    (extension) => {
      // The list and the extractor are two declarations that have to agree, and
      // reading them side by side does not show when they stop agreeing:
      // 'appref-ms' and 'application' sat in the list for months while
      // extensionOf returned '' for both, which makes checkPolicy skip the
      // executable check rather than fail it. Declared as a type from the
      // allowlist, either one was allowed with no note against it.
      const result = checkPolicy(
        // A content type that passes on its own, so the extension is what the
        // assertion is about.
        candidate({
          filename: `invoice.${extension}`,
          contentType: 'application/pdf',
        }),
        policy
      );
      expect(result.allowed).toBe(false);
      expect(result.notes.join(' ')).toContain(
        `refused: .${extension} is an executable file type`
      );
    }
  );
});

describe('sniffContent', () => {
  it.each([
    ['MZ', Buffer.from([0x4d, 0x5a, 0x90, 0x00]), 'application/x-msdownload'],
    ['ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'application/x-elf'],
    ['shebang', Buffer.from('#!/bin/sh\n'), 'text/x-shellscript'],
  ])('detects %s as executable', (_name, buffer, type) => {
    expect(sniffContent(buffer)).toEqual({
      executable: true,
      detectedType: type,
    });
  });

  it.each([
    ['Mach-O 32', 0xfeedface],
    ['Mach-O 64', 0xfeedfacf],
    ['fat binary', 0xcafebabe],
  ])('detects %s as executable', (_name, magic) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(magic >>> 0, 0);
    expect(sniffContent(buffer).executable).toBe(true);
  });

  it.each([
    ['PDF', Buffer.from('%PDF-1.7\n'), 'application/pdf'],
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['GIF', Buffer.from('GIF89a'), 'image/gif'],
    ['ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip'],
  ])('detects %s', (_name, buffer, type) => {
    expect(sniffContent(buffer)).toEqual({
      executable: false,
      detectedType: type,
    });
  });

  it('detects WEBP through the RIFF container', () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP'),
    ]);
    expect(sniffContent(buffer).detectedType).toBe('image/webp');
  });

  it('reports nothing for plain text', () => {
    expect(sniffContent(Buffer.from('Hello.'))).toEqual({
      executable: false,
      detectedType: undefined,
    });
  });

  it('does not read past the end of a short buffer', () => {
    expect(() => sniffContent(Buffer.alloc(0))).not.toThrow();
    expect(sniffContent(Buffer.from([0x4d]))).toEqual({
      executable: false,
      detectedType: undefined,
    });
  });
});
