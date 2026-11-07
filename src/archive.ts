import { createInflateRaw } from 'node:zlib';

import { defuseAutoFetch, stripInvisible } from './analyze.js';
import {
  EXECUTABLE_EXTENSIONS,
  extensionOf,
  hasDoubleExtensionBait,
  inferMimeFromExtension,
  sniffContent,
} from './attachments.js';
import { isExtractable } from './extract/index.js';

export type ArchiveErrorCode =
  | 'size_exceeded'
  | 'unsupported_format'
  | 'invalid_archive'
  | 'corrupt_archive'
  | 'corrupt_document'
  | 'no_text_layer'
  | 'encrypted_archive'
  | 'path_traversal'
  | 'absolute_path'
  | 'symlink_entry'
  | 'executable_blocked'
  | 'zip_bomb'
  | 'entry_not_found'
  | 'timeout'
  | 'out_of_memory'
  | 'busy';

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;

  constructor(code: ArchiveErrorCode, message: string) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

export interface ArchiveLimits {
  maxArchiveBytes: number;
  maxTotalUncompressedBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
  maxCompressionRatio: number;
}

/** Textual MIME types directly readable (with pagination) without binary document parsers. */
const TEXTUAL_ARCHIVE_MIMES = new Set([
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'text/html',
  'text/calendar',
  'application/json',
  'application/xml',
  'application/rtf',
]);

export function isDirectlyReadableTextMime(mimeType: string): boolean {
  return TEXTUAL_ARCHIVE_MIMES.has(mimeType.toLowerCase());
}

export function isReadableArchiveEntryMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return isExtractable(lower) || isDirectlyReadableTextMime(lower);
}

export interface ArchiveEntryInfo {
  /** Sanitized base filename. */
  name: string;
  /** Normalized relative path inside the archive (handle for read_archive_entry). */
  entryPath: string;
  /** Lowercase extension without leading dot, or ''. */
  extension: string;
  /** Inferred media type from filename extension. */
  mimeType: string;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionRatio: number;
  compressionMethod: number;
  crc32: number;
  encrypted: boolean;
  isSymlink: boolean;
  executable: boolean;
  extractable: boolean;
  readableAsText: boolean;
  allowed: boolean;
  errorCode?: ArchiveErrorCode | undefined;
  notes: string[];
  /** Internal offsets used only by the server during extraction. */
  localHeaderOffset: number;
}

export interface ParsedArchive {
  entries: ArchiveEntryInfo[];
  totalEntries: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  blockedCount: number;
  centralDirectoryOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT = 0xffff;
const EOCD_MIN_BYTES = 22;
const CD_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
/** Minimum uncompressed size before applying compression-ratio bomb threshold. */
const RATIO_CHECK_MIN_UNCOMPRESSED = 64 * 1024;

/** Standard IEEE 802.3 CRC-32 lookup table. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    const tableVal = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = (tableVal ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Inspects a ZIP archive's Central Directory without inflating any entry payload.
 * Enforces magic-byte, structural, bomb, path, symlink, encryption, and executable checks.
 */
export function inspectZipArchive(
  buffer: Buffer,
  limits: ArchiveLimits
): ParsedArchive {
  if (buffer.length > limits.maxArchiveBytes) {
    throw new ArchiveError(
      'size_exceeded',
      `Archive size (${buffer.length} bytes) exceeds IMAP_MAX_ARCHIVE_BYTES (${limits.maxArchiveBytes} bytes).`
    );
  }

  const verdict = sniffContent(buffer);
  if (verdict.executable) {
    throw new ArchiveError(
      'executable_blocked',
      `Attachment bytes are an executable (${verdict.detectedType}), not a ZIP archive.`
    );
  }
  if (verdict.detectedType !== 'application/zip') {
    throw new ArchiveError(
      'invalid_archive',
      `Attachment bytes do not carry a valid PKZIP signature (detected ${verdict.detectedType ?? 'unrecognised format'}). Declared MIME types are never trusted alone.`
    );
  }

  if (buffer.length < EOCD_MIN_BYTES) {
    throw new ArchiveError(
      'corrupt_archive',
      'Archive is truncated (smaller than minimum 22-byte ZIP End of Central Directory).'
    );
  }

  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new ArchiveError(
      'corrupt_archive',
      'Could not locate a valid ZIP End of Central Directory record; the archive is corrupt or truncated.'
    );
  }

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const cdDisk = buffer.readUInt16LE(eocdOffset + 6);
  if (diskNumber !== 0 || cdDisk !== 0) {
    throw new ArchiveError(
      'unsupported_format',
      'Multi-part or spanned ZIP archives are not supported.'
    );
  }

  const declaredRecords = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (
    declaredRecords === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new ArchiveError(
      'unsupported_format',
      'Zip64 extended headers exceed supported mail archive bounds.'
    );
  }

  if (declaredRecords > limits.maxEntries * 4) {
    throw new ArchiveError(
      'zip_bomb',
      `Archive declares ${declaredRecords} Central Directory records, exceeding safe limit (${limits.maxEntries} file entries, IMAP_MAX_ARCHIVE_ENTRIES).`
    );
  }

  if (cdOffset + cdSize > eocdOffset) {
    throw new ArchiveError(
      'corrupt_archive',
      'ZIP Central Directory extends past End of Central Directory record.'
    );
  }

  const entries: ArchiveEntryInfo[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;

  for (let i = 0; i < declaredRecords; i += 1) {
    if (cursor + CD_HEADER_BYTES > cdEnd) {
      throw new ArchiveError(
        'corrupt_archive',
        'Truncated Central Directory entry header in ZIP archive.'
      );
    }
    if (buffer.readUInt32LE(cursor) !== CD_SIGNATURE) {
      throw new ArchiveError(
        'corrupt_archive',
        'Invalid Central Directory file header signature in ZIP archive.'
      );
    }

    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const gpbf = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const uncompressedBytes = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const externalAttr = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const nextCursor =
      cursor + CD_HEADER_BYTES + nameLen + extraLen + commentLen;
    if (nextCursor > cdEnd) {
      throw new ArchiveError(
        'corrupt_archive',
        'Central Directory entry variable fields extend past Central Directory bounds.'
      );
    }

    if (
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ArchiveError(
        'size_exceeded',
        'Archive entry requires Zip64 sizes exceeding configured safety ceilings.'
      );
    }

    const rawNameBytes = buffer.subarray(
      cursor + CD_HEADER_BYTES,
      cursor + CD_HEADER_BYTES + nameLen
    );
    const isUtf8 = (gpbf & 0x0800) !== 0;
    const rawName = decodeEntryName(rawNameBytes, isUtf8);
    cursor = nextCursor;

    const unixFileType = ((externalAttr >>> 16) & 0o170000) >>> 0;
    const creatorOs = (versionMadeBy >>> 8) & 0xff;
    const hasUnixMode =
      (creatorOs === 3 || creatorOs === 19) && unixFileType !== 0;
    const isSymlink = hasUnixMode
      ? unixFileType === 0o120000
      : unixFileType === 0o120000;
    const isDirectoryAttr =
      (hasUnixMode && unixFileType === 0o040000) ||
      ((externalAttr & 0x10) !== 0 && rawName.endsWith('/'));

    const pathVerdict = inspectEntryPath(rawName);

    // Skip clean directory placeholders so callers receive actionable files.
    if (
      pathVerdict.errorCode === undefined &&
      !isSymlink &&
      (rawName.endsWith('/') || isDirectoryAttr) &&
      uncompressedBytes === 0
    ) {
      continue;
    }

    if (entries.length >= limits.maxEntries) {
      throw new ArchiveError(
        'zip_bomb',
        `Archive exceeds maximum allowed file entries (${limits.maxEntries}, IMAP_MAX_ARCHIVE_ENTRIES).`
      );
    }

    // Verify local header bounds and record byte span to defeat overlapping-entry ZIP bombs (zbsm.zip).
    if (localHeaderOffset + LOCAL_HEADER_BYTES > cdOffset) {
      throw new ArchiveError(
        'corrupt_archive',
        'Local file header offset points outside archive data region.'
      );
    }
    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_SIGNATURE) {
      throw new ArchiveError(
        'corrupt_archive',
        'Local file header signature mismatch inside ZIP archive.'
      );
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart =
      localHeaderOffset + LOCAL_HEADER_BYTES + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedBytes;
    if (dataEnd > cdOffset) {
      throw new ArchiveError(
        'corrupt_archive',
        'Compressed entry payload extends past start of Central Directory.'
      );
    }
    spans.push({ start: localHeaderOffset, end: dataEnd });

    const ratio =
      uncompressedBytes === 0
        ? 1
        : Number((uncompressedBytes / Math.max(1, compressedBytes)).toFixed(2));

    if (
      uncompressedBytes >= RATIO_CHECK_MIN_UNCOMPRESSED &&
      ratio > limits.maxCompressionRatio
    ) {
      throw new ArchiveError(
        'zip_bomb',
        `Archive entry compression ratio (${ratio}:1) exceeds maximum safe ratio (${limits.maxCompressionRatio}:1, IMAP_MAX_COMPRESSION_RATIO).`
      );
    }

    totalCompressedBytes += compressedBytes;
    totalUncompressedBytes += uncompressedBytes;

    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      const archiveRatio = totalUncompressedBytes / Math.max(1, buffer.length);
      if (archiveRatio > limits.maxCompressionRatio) {
        throw new ArchiveError(
          'zip_bomb',
          `Total uncompressed size (${totalUncompressedBytes} bytes) expands ${archiveRatio.toFixed(1)}x beyond archive size, exceeding bomb limits.`
        );
      }
      throw new ArchiveError(
        'size_exceeded',
        `Total uncompressed size across entries exceeds IMAP_MAX_ARCHIVE_TOTAL_BYTES (${limits.maxTotalUncompressedBytes} bytes).`
      );
    }

    const encrypted =
      (gpbf & 0x0001) !== 0 || (gpbf & 0x0040) !== 0 || method === 99;
    const baseName = pathVerdict.baseName;
    const extension = extensionOf(baseName);
    const executable =
      (extension !== '' && EXECUTABLE_EXTENSIONS.has(extension)) ||
      hasDoubleExtensionBait(baseName);
    const mimeType = inferMimeFromExtension(extension);

    const notes: string[] = [];
    let errorCode: ArchiveErrorCode | undefined = pathVerdict.errorCode;

    if (pathVerdict.errorCode === 'path_traversal') {
      notes.push(
        'blocked: entry path contains traversal segments or unsafe separators'
      );
    } else if (pathVerdict.errorCode === 'absolute_path') {
      notes.push('blocked: entry uses an absolute or drive-prefixed path');
    }

    if (isSymlink) {
      errorCode ??= 'symlink_entry';
      notes.push('blocked: symbolic links inside archives are refused');
    } else if (
      hasUnixMode &&
      unixFileType !== 0o100000 &&
      unixFileType !== 0o040000
    ) {
      errorCode ??= 'unsupported_format';
      notes.push('blocked: special Unix device/socket/FIFO entry');
    }

    if (encrypted) {
      errorCode ??= 'encrypted_archive';
      notes.push('blocked: entry is password-protected / encrypted');
    }

    if (executable) {
      errorCode ??= 'executable_blocked';
      notes.push('blocked: executable or double-extension filename');
    }

    if (uncompressedBytes > limits.maxEntryBytes) {
      errorCode ??= 'size_exceeded';
      notes.push(
        `blocked: uncompressed size (${uncompressedBytes} bytes) exceeds IMAP_MAX_ARCHIVE_ENTRY_BYTES (${limits.maxEntryBytes} bytes)`
      );
    }

    if (!encrypted && method !== 0 && method !== 8) {
      errorCode ??= 'unsupported_format';
      notes.push(
        `blocked: unsupported ZIP compression method (${method}); only stored (0) and deflate (8) are supported`
      );
    }

    if (
      pathVerdict.normalizedPath.startsWith('__MACOSX/') ||
      baseName.startsWith('._')
    ) {
      notes.push('macOS AppleDouble metadata entry');
    }

    const allowed = errorCode === undefined;
    const extractable = allowed && isExtractable(mimeType);
    const readableAsText =
      allowed &&
      !pathVerdict.normalizedPath.startsWith('__MACOSX/') &&
      !baseName.startsWith('._') &&
      isReadableArchiveEntryMime(mimeType);

    entries.push({
      name: baseName,
      entryPath: pathVerdict.normalizedPath,
      extension,
      mimeType,
      compressedBytes,
      uncompressedBytes,
      compressionRatio: ratio,
      compressionMethod: method,
      crc32,
      encrypted,
      isSymlink,
      executable,
      extractable,
      readableAsText,
      allowed,
      errorCode,
      notes,
      localHeaderOffset,
    });
  }

  // Check for overlapping local spans (Fifield non-recursive zbsm.zip bomb).
  const sortedSpans = spans.toSorted((a, b) => a.start - b.start);
  for (let i = 1; i < sortedSpans.length; i += 1) {
    const prev = sortedSpans[i - 1];
    const curr = sortedSpans[i];
    if (prev !== undefined && curr !== undefined && curr.start < prev.end) {
      throw new ArchiveError(
        'zip_bomb',
        'Overlapping local file headers detected in ZIP archive (non-recursive ZIP bomb signature).'
      );
    }
  }

  const blockedCount = entries.filter((entry) => !entry.allowed).length;

  return {
    entries,
    totalEntries: entries.length,
    totalCompressedBytes,
    totalUncompressedBytes,
    blockedCount,
    centralDirectoryOffset: cdOffset,
  };
}

/**
 * Extracts and verifies a single entry's raw bytes in memory using streaming
 * bounded decompression, CRC-32 verification, and magic-byte executable inspection.
 */
export async function extractArchiveEntryBytes(
  archiveBuffer: Buffer,
  parsed: ParsedArchive,
  entryPath: string,
  limits: ArchiveLimits
): Promise<{
  entry: ArchiveEntryInfo;
  bytes: Buffer;
  detectedType: string | undefined;
}> {
  const entry = parsed.entries.find((item) => item.entryPath === entryPath);
  if (entry === undefined) {
    throw new ArchiveError(
      'entry_not_found',
      `No entry at path "${sanitizeDisplayPath(entryPath)}" in this ZIP archive. Call list_archive_entries to see the exact entry_path values.`
    );
  }

  if (!entry.allowed) {
    throw new ArchiveError(
      entry.errorCode ?? 'unsupported_format',
      `Refused archive entry "${entry.entryPath}": ${entry.notes.join('; ') || 'blocked by archive security policy'}.`
    );
  }

  const localOffset = entry.localHeaderOffset;
  if (
    localOffset + LOCAL_HEADER_BYTES > parsed.centralDirectoryOffset ||
    archiveBuffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
  ) {
    throw new ArchiveError(
      'corrupt_archive',
      'Local file header is missing or corrupt.'
    );
  }

  const localGpbf = archiveBuffer.readUInt16LE(localOffset + 6);
  const localMethod = archiveBuffer.readUInt16LE(localOffset + 8);
  if (
    (localGpbf & 0x0001) !== 0 ||
    (localGpbf & 0x0040) !== 0 ||
    localMethod === 99
  ) {
    throw new ArchiveError(
      'encrypted_archive',
      `Archive entry "${entry.entryPath}" is password-protected in its local header.`
    );
  }
  if (localMethod !== entry.compressionMethod) {
    throw new ArchiveError(
      'corrupt_archive',
      'Archive entry compression method disagrees between Central Directory and Local Header.'
    );
  }

  const localNameLen = archiveBuffer.readUInt16LE(localOffset + 26);
  const localExtraLen = archiveBuffer.readUInt16LE(localOffset + 28);
  const dataStart =
    localOffset + LOCAL_HEADER_BYTES + localNameLen + localExtraLen;
  const dataEnd = dataStart + entry.compressedBytes;
  if (dataEnd > parsed.centralDirectoryOffset) {
    throw new ArchiveError(
      'corrupt_archive',
      'Compressed entry bytes extend past Central Directory.'
    );
  }

  const compressedSlice = archiveBuffer.subarray(dataStart, dataEnd);
  let extracted: Buffer;

  if (entry.compressionMethod === 0) {
    if (compressedSlice.length !== entry.uncompressedBytes) {
      throw new ArchiveError(
        'corrupt_archive',
        'Stored ZIP entry compressed length does not match declared uncompressed size.'
      );
    }
    if (compressedSlice.length > limits.maxEntryBytes) {
      throw new ArchiveError(
        'size_exceeded',
        `Entry exceeds IMAP_MAX_ARCHIVE_ENTRY_BYTES (${limits.maxEntryBytes} bytes).`
      );
    }
    extracted = Buffer.from(compressedSlice);
  } else if (entry.compressionMethod === 8) {
    extracted = await inflateBounded(
      compressedSlice,
      entry.uncompressedBytes,
      limits.maxEntryBytes,
      limits.maxCompressionRatio
    );
  } else {
    throw new ArchiveError(
      'unsupported_format',
      `Unsupported compression method ${entry.compressionMethod}.`
    );
  }

  const actualCrc = computeCrc32(extracted);
  if (actualCrc !== entry.crc32) {
    throw new ArchiveError(
      'corrupt_archive',
      `CRC-32 checksum mismatch while reading "${entry.entryPath}" — the archive entry is corrupted.`
    );
  }

  const verdict = sniffContent(extracted);
  if (verdict.executable) {
    throw new ArchiveError(
      'executable_blocked',
      `Refused "${entry.entryPath}": extracted bytes are an executable (${verdict.detectedType}), regardless of filename.`
    );
  }

  return {
    entry,
    bytes: extracted,
    detectedType: verdict.detectedType,
  };
}

async function inflateBounded(
  compressed: Buffer,
  declaredUncompressed: number,
  maxEntryBytes: number,
  maxRatio: number
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const inflater = createInflateRaw();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (error: ArchiveError): void => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      reject(error);
    };

    inflater.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxEntryBytes) {
        fail(
          new ArchiveError(
            'zip_bomb',
            `Decompressed stream exceeded IMAP_MAX_ARCHIVE_ENTRY_BYTES (${maxEntryBytes} bytes) during inflate.`
          )
        );
        return;
      }
      if (total > declaredUncompressed) {
        fail(
          new ArchiveError(
            'zip_bomb',
            `Decompressed stream exceeded declared uncompressed size (${declaredUncompressed} bytes) — spoofed ZIP header / bomb.`
          )
        );
        return;
      }
      if (
        total >= RATIO_CHECK_MIN_UNCOMPRESSED &&
        total / Math.max(1, compressed.length) > maxRatio
      ) {
        fail(
          new ArchiveError(
            'zip_bomb',
            `Decompressed stream exceeded maximum safe compression ratio (${maxRatio}:1).`
          )
        );
        return;
      }
      chunks.push(chunk);
    });

    inflater.once('error', () => {
      fail(
        new ArchiveError(
          'corrupt_archive',
          'Deflate decompression failed — the ZIP entry stream is corrupt.'
        )
      );
    });

    inflater.once('end', () => {
      if (settled) return;
      if (total !== declaredUncompressed) {
        fail(
          new ArchiveError(
            'corrupt_archive',
            `Decompressed length (${total} bytes) did not match declared size (${declaredUncompressed} bytes).`
          )
        );
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });

    inflater.end(compressed);
  });
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(
    0,
    buffer.length - EOCD_MIN_BYTES - MAX_ZIP_COMMENT
  );
  for (
    let offset = buffer.length - EOCD_MIN_BYTES;
    offset >= minOffset;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN_BYTES + commentLength === buffer.length) {
      return offset;
    }
  }
  return -1;
}

function decodeEntryName(raw: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) {
    return new TextDecoder('utf-8', { fatal: false }).decode(raw);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder('latin1').decode(raw);
  }
}

interface PathInspection {
  normalizedPath: string;
  baseName: string;
  errorCode: ArchiveErrorCode | undefined;
}

function inspectEntryPath(rawName: string): PathInspection {
  let errorCode: ArchiveErrorCode | undefined;

  // Control characters or NUL byte inside archive filenames are never legitimate.
  for (let i = 0; i < rawName.length; i += 1) {
    const code = rawName.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      errorCode = 'path_traversal';
      break;
    }
  }

  if (
    errorCode === undefined &&
    (rawName.startsWith('/') ||
      rawName.startsWith('\\') ||
      /^[A-Za-z]:/.test(rawName))
  ) {
    errorCode = 'absolute_path';
  }

  if (errorCode === undefined && rawName.includes('\\')) {
    errorCode = 'path_traversal';
  }

  const slashNormalized = rawName.replace(/\\/g, '/');
  const rawSegments = slashNormalized.split('/');
  if (errorCode === undefined && rawSegments.some((seg) => seg === '..')) {
    errorCode = 'path_traversal';
  }

  const safeSegments = rawSegments
    .filter((seg) => seg !== '' && seg !== '.')
    .map((seg) =>
      defuseAutoFetch(stripInvisible(seg.normalize('NFKC'))).slice(0, 120)
    )
    .filter((seg) => seg !== '');

  const normalizedPath =
    safeSegments.length > 0
      ? safeSegments.join('/').slice(0, 512)
      : '(unnamed)';
  const lastSegment = safeSegments.at(-1) ?? '(unnamed)';
  const baseName = lastSegment.slice(0, 120);

  return {
    normalizedPath,
    baseName,
    errorCode,
  };
}

function sanitizeDisplayPath(raw: string): string {
  return defuseAutoFetch(stripInvisible(raw.normalize('NFKC')))
    .replace(/\p{Cc}/gu, '')
    .slice(0, 200);
}

/**
 * Strips RTF control sequences to plain readable text for `.rtf` entries inside archives.
 */
export function rtfToText(raw: string): string {
  return raw
    .replace(/\\par\b\s?/g, '\n')
    .replace(/\\line\b\s?/g, '\n')
    .replace(/\\tab\b\s?/g, '\t')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/\\u(-?\d+)\??/g, (_m, code: string) => {
      const num = Number.parseInt(code, 10);
      const cp = num < 0 ? num + 65536 : num;
      return cp >= 32 ? String.fromCodePoint(cp) : '';
    })
    .replace(
      /\{\\(?:fonttbl|colortbl|stylesheet|info|pict|\*\\[a-z]+)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi,
      ''
    )
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Computes the 1-based PDF page range covered by `[offset, end)` given `== Page N ==` markers.
 */
export function pageRangeForSlice(
  fullText: string,
  offset: number,
  end: number
): { from_page: number; to_page: number } | undefined {
  const markers: Array<{ index: number; page: number }> = [];
  const regex = /^== Page (\d+) ==$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(fullText)) !== null) {
    markers.push({
      index: match.index,
      page: Number.parseInt(match[1] ?? '1', 10),
    });
  }
  if (markers.length === 0) return undefined;

  let fromPage = markers[0]?.page ?? 1;
  for (const m of markers) {
    if (m.index <= offset) {
      fromPage = m.page;
    } else {
      break;
    }
  }

  let toPage = fromPage;
  const effectiveEnd = Math.max(offset, end - 1);
  for (const m of markers) {
    if (m.index <= effectiveEnd) {
      toPage = m.page;
    } else {
      break;
    }
  }

  return { from_page: fromPage, to_page: toPage };
}
