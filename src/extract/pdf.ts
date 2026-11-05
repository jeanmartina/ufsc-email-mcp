import { createInflate } from 'node:zlib';

import type { ExtractResponse } from './types.js';

/**
 * Pages read at most, however many the document claims.
 *
 * A mail attachment that needs more than this is not a document anyone is going
 * to read in a chat window, and the page loop is the one part of extraction
 * whose cost scales with something the sender chose.
 */
const MAX_PAGES = 100;

/** Below this many points, text is not there for a reader. */
const TINY_FONT_POINTS = 2;

/**
 * How far one compressed stream may expand, and how far all of them may
 * together, before the document is refused without a parser seeing it.
 *
 * This is the memory guard for PDFs, and it has to live here because nothing
 * else bounds it. PDF.js inflates a stream into memory in full, and that memory
 * is a typed array — external to the V8 heap, so no heap limit applies to it.
 * Measured: a 3.4 MB file whose one content stream inflates to 1 GB took the
 * process to 2.1 GB of resident memory within a second, and the extraction
 * timeout only decides when that stops growing, not how far it gets. Deflate
 * reaches roughly 1000:1 on repetitive input, so the 10 MB the size limit
 * admits by default could stand for 10 GB.
 *
 * Every honest document is far below both numbers: a content stream is tens of
 * kilobytes to a few megabytes, an embedded font a few hundred kilobytes.
 */
export const MAX_STREAM_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_STREAM_BYTES = 128 * 1024 * 1024;

/**
 * pdf.js options, every one of them load-bearing.
 *
 * `isEvalSupported` reads like a performance knob and is not one: it gates
 * pdf.js's construction of `Function` objects for font and PostScript-calculator
 * programs taken from the document. That is the primitive that turned a parser
 * bug into remote code execution in CVE-2024-4367. Text extraction never needs
 * it.
 *
 * `useSystemFonts` overrides unpdf's own default of `true`. Nothing about
 * reading text needs the host's font configuration consulted on behalf of a
 * stranger's file.
 *
 * `verbosity` silences pdf.js's own logging. This matters more here than it
 * looks: the server's transport is stdio JSON-RPC, and a stray `console.log`
 * reaching the parent's stdout corrupts the framing and hangs the session. The
 * child process is also started with its stdout discarded, because one guard
 * is not a guard.
 */
const PDFJS_OPTIONS = {
  isEvalSupported: false,
  enableXfa: false,
  useSystemFonts: false,
  disableFontFace: true,
  verbosity: 0,
} as const;

/**
 * Reads the text layer of a PDF.
 *
 * The API surface used here is deliberately five calls wide — `getDocument`,
 * `getPage`, `getTextContent`, `view`, `destroy` — and it must stay that way.
 * `getJSActions` surfaces the document's own JavaScript, `getAttachments`
 * returns embedded files (a PDF can carry an executable past `sniffContent`,
 * which only ever looks at the outer `%PDF`), and `getAnnotations` carries
 * actions and URIs. None of them is needed to read text, and each is a door.
 *
 * Nothing here reaches the network, and that is worth stating because it is one
 * careless line away from being false. unpdf only sets `standardFontDataUrl`
 * and `cMapUrl` when it can resolve `pdfjs-dist`, which is not a dependency of
 * this package, so both stay unset; the document is passed as bytes, never as a
 * URL, so pdf.js never constructs its network stream. **Do not "fix" a missing
 * font or CMap by pointing either option at a CDN.** It is the most-suggested
 * workaround on the internet, and it would hand this server its first outbound
 * HTTP client — the one property SECURITY.md is built on. The cost of leaving
 * them unset is known and accepted: a PDF whose text needs a predefined CJK
 * CMap does not extract.
 */
export async function extractPdf(
  bytes: Uint8Array,
  maxChars: number
): Promise<ExtractResponse> {
  // Before the parser, not inside it: by the time pdf.js has inflated a stream
  // the memory is spent, and there is no option that makes it stop earlier.
  if (await expandsTooFar(bytes)) return { ok: false, reason: 'too-large' };

  const { getDocumentProxy } = await import('unpdf');

  let pdf;
  try {
    // Normalised, not passed through. A Node `Buffer` is a `Uint8Array`, so it
    // satisfies the signature — but it is a view into a shared allocation pool
    // at a non-zero `byteOffset`, and pdf.js reaches for the underlying
    // `ArrayBuffer`. Handed a Buffer it reads the pool instead of the document
    // and reports a corrupt file, which is a bug that looks exactly like a bad
    // attachment. `set` on a fresh array is the copy that ends it.
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    pdf = await getDocumentProxy(owned, PDFJS_OPTIONS);
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }

  try {
    const declared = pdf.numPages;
    const pageCount = Math.min(declared, MAX_PAGES);
    const parts: string[] = [];
    let length = 0;
    // Set only by the character cap. It used to be initialised from
    // `declared > pageCount`, and since the loop below ran only while it was
    // false, a document with more than a hundred pages was never read at all
    // and came back as "no text layer" — the diagnosis for a scan, on a long
    // contract. The page count the walk stopped short of is reported
    // separately, as `declaredUnitCount`.
    let clipped = false;
    let hiddenRuns = 0;
    let totalRuns = 0;

    // Sequentially, not `Promise.all` over the page count — which is what
    // unpdf's own `extractText` does. That form allocates an array as long as
    // the document claims to be and holds every page's text content live at
    // once, both sized by a number the sender wrote.
    for (let page = 1; page <= pageCount; page += 1) {
      const proxy = await pdf.getPage(page);
      const box = proxy.view;
      const content = await proxy.getTextContent();
      const line: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        totalRuns += 1;
        if (isHidden(item, box)) hiddenRuns += 1;
        line.push(item.str);
        if (item.hasEOL) line.push('\n');
      }
      const text = line.join('');
      if (length + text.length >= maxChars) {
        parts.push(text.slice(0, maxChars - length));
        clipped = true;
        break;
      }
      parts.push(text, '\n');
      length += text.length + 1;
    }

    const text = parts.join('');
    // Trimmed, because an image-only PDF still yields the page separators this
    // loop writes. `text !== ''` would call a scanned invoice a text document.
    if (text.trim() === '') return { ok: false, reason: 'no-text-layer' };

    return {
      ok: true,
      text,
      unitLabel: 'pages',
      unitCount: pageCount,
      ...(declared > pageCount ? { declaredUnitCount: declared } : {}),
      clipped,
      hiddenRuns,
      totalRuns,
    };
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  } finally {
    // Releases the parsing state. The process is about to exit anyway, but a
    // document that fails on page 3 of 100 should not hold its object graph
    // while the remaining pages are abandoned. `destroy` is on the loading
    // task, not on the document proxy — the proxy only has `cleanup`, which
    // keeps the transport alive.
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/**
 * Whether a text run is drawn where a reader will not find it.
 *
 * A signal, never a filter — the same position this server takes on suspicious
 * mail. Two of the four ways to hide text in a PDF are visible from here (off
 * the page, and set microscopically small) and two are not: fill colour is not
 * exposed by the text-content API at all, and text render mode 3 is exactly how
 * every OCR'd scan stores the text layer over its own image, so treating it as
 * hidden would reject the main thing this feature exists to read.
 *
 * So the count goes into a note, the text goes to the model either way, and the
 * result header says plainly that some of what follows is text a person opening
 * the document would not see.
 *
 * "Off the page" is measured against the page's own box, not against the
 * origin: a MediaBox need not start at 0,0, and text past the right or top
 * edge is as invisible as text past the left one.
 */
function isHidden(
  item: { transform?: unknown; height?: number },
  box: number[]
): boolean {
  const t = item.transform;
  if (Array.isArray(t) && t.length >= 6) {
    const x = Number(t[4]);
    const y = Number(t[5]);
    const [x0, y0, x1, y1] = box;
    // Measured against pdf.js 6: a run placed *entirely* off the page produces
    // no text item at all, so this catches the half that hangs over an edge
    // and the other half never arrives — which is the better outcome and not
    // one to undo.
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      (x < (x0 ?? 0) ||
        y < (y0 ?? 0) ||
        x > (x1 ?? Infinity) ||
        y > (y1 ?? Infinity))
    ) {
      return true;
    }
  }
  const size = item.height ?? 0;
  return size > 0 && size < TINY_FONT_POINTS;
}

/**
 * Maps a pdf.js rejection to a reason code.
 *
 * On the name, never the message. The message is a pdf.js implementation
 * detail that changes between releases, and it quotes the document.
 */
function reasonFor(error: unknown): 'encrypted' | 'corrupt' {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'PasswordException' ? 'encrypted' : 'corrupt';
}

/* ------------------------------------------------------------ pre-scan -- */

/**
 * Whether the document's compressed streams expand past the limits above.
 *
 * One forward pass over the file, finding every `stream … endstream` and
 * decoding the ones whose filter can grow: Flate, LZW and RunLength, each
 * optionally behind an ASCIIHex or ASCII85 wrapper. The decoders stop the
 * moment they cross the remaining budget, so the work this costs is bounded by
 * the budget plus one stream, whatever the file holds — and a decoder that
 * hits a corrupt byte counts what it produced up to there, which is also what
 * pdf.js would have got.
 *
 * The data is delimited the way pdf.js delimits it: by `/Length` where the
 * number is direct or a resolvable reference and actually lands on
 * `endstream`, and by the first `endstream` otherwise. Using only the keyword
 * would let a sender end the scan early by writing the word inside their own
 * compressed bytes.
 *
 * Image codecs — DCT, JPX, JBIG2, CCITT — are not decoded here, because text
 * extraction never decodes them either.
 */
export async function expandsTooFar(bytes: Uint8Array): Promise<boolean> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // latin1 keeps a one-to-one mapping between string index and byte offset.
  const text = data.toString('latin1');
  let total = 0;
  let cursor = 0;

  for (;;) {
    const at = text.indexOf('stream', cursor);
    if (at < 0) return false;
    cursor = at + 6;
    // A keyword, not the tail of `endstream` or part of a name.
    const before = at === 0 ? ' ' : (text[at - 1] as string);
    if (!/[\s>]/.test(before)) continue;

    let start = at + 6;
    if (text[start] === '\r') start += 1;
    if (text[start] === '\n') start += 1;

    const objAt = text.lastIndexOf('obj', at);
    const dict = text.slice(Math.max(objAt, cursor - 6 - 4096, 0), at);
    const end = streamEnd(text, dict, start);
    if (end < 0) return false;
    cursor = end + 9;

    const filters = filtersOf(dict);
    if (!filters.some((name) => EXPANDING.has(name))) continue;

    const limit = Math.min(MAX_STREAM_BYTES, MAX_TOTAL_STREAM_BYTES - total);
    const size = await expansionOf(
      data.subarray(start, end),
      filters,
      /\/EarlyChange\s+0\b/.test(dict) ? 0 : 1,
      limit
    );
    if (size > limit) return true;
    total += size;
  }
}

const EXPANDING = new Set([
  'FlateDecode',
  'Fl',
  'LZWDecode',
  'LZW',
  'RunLengthDecode',
  'RL',
]);

/** Where the stream's data ends: by a trustworthy `/Length`, else by keyword. */
function streamEnd(text: string, dict: string, start: number): number {
  const length = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(dict);
  if (length !== null) {
    let declared: number | undefined;
    if (length[2] === undefined) {
      declared = Number(length[1]);
    } else {
      const object = new RegExp(
        `(?:^|\\s)${length[1]}\\s+${length[2]}\\s+obj\\s*(\\d+)`
      ).exec(text);
      if (object !== null) declared = Number(object[1]);
    }
    if (declared !== undefined && Number.isSafeInteger(declared)) {
      let after = start + declared;
      if (text[after] === '\r') after += 1;
      if (text[after] === '\n') after += 1;
      if (text.startsWith('endstream', after)) return start + declared;
    }
  }
  return text.indexOf('endstream', start);
}

/** The `/Filter` names of a stream dictionary, in application order. */
function filtersOf(dict: string): string[] {
  const match = /\/Filter\s*(?:\[([^\]]*)\]|\/([A-Za-z0-9]+))/.exec(dict);
  if (match === null) return [];
  if (match[2] !== undefined) return [match[2]];
  return [...(match[1] as string).matchAll(/\/([A-Za-z0-9]+)/g)].map(
    (name) => name[1] as string
  );
}

/**
 * Bytes the filter chain produces, or any number past `limit` once it does.
 *
 * Flate is materialised, because a second filter may follow it; LZW and
 * RunLength only count, and end the chain, because nothing honest stacks
 * another expanding filter behind them.
 */
async function expansionOf(
  raw: Uint8Array,
  filters: string[],
  earlyChange: number,
  limit: number
): Promise<number> {
  let current = raw;
  for (const filter of filters) {
    switch (filter) {
      case 'ASCIIHexDecode':
      case 'AHx':
        current = hexDecode(current);
        break;
      case 'ASCII85Decode':
      case 'A85':
        current = ascii85Decode(current);
        break;
      case 'FlateDecode':
      case 'Fl': {
        const inflated = await inflate(current, limit);
        if (inflated === undefined) return limit + 1;
        current = inflated;
        break;
      }
      case 'LZWDecode':
      case 'LZW':
        return lzwLength(current, earlyChange, limit);
      case 'RunLengthDecode':
      case 'RL':
        return runLengthLength(current, limit);
      default:
        // An image codec, or something unknown: the chain stops producing
        // anything text extraction would read.
        return current === raw ? 0 : current.length;
    }
  }
  return current === raw ? 0 : current.length;
}

/** Inflates up to `limit` bytes; `undefined` once the output would pass it. */
function inflate(
  data: Uint8Array,
  limit: number
): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let produced = 0;
    let settled = false;
    const stream = createInflate();
    const finish = (value: Uint8Array | undefined): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(value);
    };
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      produced += chunk.length;
      if (produced > limit) {
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    // A corrupt stream yields what it decoded before the bad byte, which is
    // also what pdf.js gets from it. The listener stays attached after
    // settling so a late error has somewhere to go.
    stream.on('error', () => finish(Buffer.concat(chunks)));
    stream.on('end', () => finish(Buffer.concat(chunks)));
    stream.end(data);
  });
}

/**
 * Output length of a PDF LZW stream, without building a single string.
 *
 * Every dictionary entry is one byte longer than the entry it extends, so the
 * length of any code is known from lengths alone — which is all the question
 * needs. Codes are 9 to 12 bits, MSB first; 256 clears, 257 ends; the width
 * grows one code early under the default `EarlyChange`.
 */
function lzwLength(
  data: Uint8Array,
  earlyChange: number,
  limit: number
): number {
  let produced = 0;
  let bits = 0;
  let held = 0;
  let pos = 0;
  let width = 9;
  let lengths: number[] = [];
  let previous = 0;
  let hasPrevious = false;

  while (produced <= limit) {
    while (held < width && pos < data.length) {
      bits = (bits << 8) | (data[pos] as number);
      pos += 1;
      held += 8;
    }
    if (held < width) break;
    const code = (bits >>> (held - width)) & ((1 << width) - 1);
    held -= width;
    bits &= (1 << held) - 1;

    if (code === 256) {
      lengths = [];
      width = 9;
      hasPrevious = false;
      continue;
    }
    if (code === 257) break;

    let length: number;
    if (code < 256) length = 1;
    else if (code - 258 < lengths.length)
      length = lengths[code - 258] as number;
    else if (code - 258 === lengths.length && hasPrevious)
      length = previous + 1;
    else break;

    produced += length;
    if (hasPrevious) lengths.push(previous + 1);
    previous = length;
    hasPrevious = true;
    if (width < 12 && 258 + lengths.length + earlyChange >= 1 << width)
      width += 1;
  }
  return produced;
}

/** Output length of a RunLength stream. */
function runLengthLength(data: Uint8Array, limit: number): number {
  let produced = 0;
  let i = 0;
  while (i < data.length && produced <= limit) {
    const marker = data[i] as number;
    i += 1;
    if (marker === 128) break;
    if (marker < 128) {
      produced += marker + 1;
      i += marker + 1;
    } else {
      produced += 257 - marker;
      i += 1;
    }
  }
  return produced;
}

function hexDecode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 2));
  let n = 0;
  let pending = -1;
  for (const byte of data) {
    if (byte === 0x3e) break; // '>'
    const digit =
      byte >= 0x30 && byte <= 0x39
        ? byte - 0x30
        : byte >= 0x41 && byte <= 0x46
          ? byte - 0x37
          : byte >= 0x61 && byte <= 0x66
            ? byte - 0x57
            : -1;
    if (digit < 0) continue;
    if (pending < 0) {
      pending = digit;
    } else {
      out[n] = pending * 16 + digit;
      n += 1;
      pending = -1;
    }
  }
  if (pending >= 0) {
    out[n] = pending * 16;
    n += 1;
  }
  return out.subarray(0, n);
}

function ascii85Decode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 5) * 4 + 4);
  let n = 0;
  const group: number[] = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2; // '<~'
  const flush = (count: number): void => {
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [
      value >>> 24,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    ];
    for (let k = 0; k < count - 1; k += 1) {
      out[n] = bytes[k] as number;
      n += 1;
    }
    group.length = 0;
  };
  for (; i < data.length; i += 1) {
    const byte = data[i] as number;
    if (byte === 0x7e) break; // '~' of '~>'
    if (byte === 0x7a && group.length === 0) {
      n += 4; // 'z' is four zero bytes
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    group.push(byte - 0x21);
    if (group.length === 5) flush(5);
  }
  if (group.length > 1) flush(group.length);
  return out.subarray(0, n);
}
