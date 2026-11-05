import { deflateSync } from 'node:zlib';

import { zipSync } from 'fflate';

/**
 * Builders for the document formats the extractor reads.
 *
 * Built rather than checked in, for the reason the rest of this suite builds
 * its MIME by hand: every hostile case below is a *variation* — a page count
 * that lies, an encryption dictionary, a central directory patched to declare
 * four gigabytes — and a base64 blob gives you one document and no variations.
 * A fixture file would also be a binary in a repository that ships none.
 */

interface PdfOptions {
  text?: string;
  /** Written into /Count regardless of how many pages the tree really has. */
  declaredPages?: number;
  /** Font size, in points. Small values are how text hides from a reader. */
  fontSize?: number;
  /** Text placement. Negative coordinates put it off the page. */
  at?: [number, number];
  /** Adds an /Encrypt reference to the trailer. */
  encrypted?: boolean;
  /** Draws a filled rectangle instead of any text at all. */
  imageOnly?: boolean;
}

/**
 * A real, minimal PDF that pdf.js extracts text from.
 *
 * The font is one of the standard fourteen, so there is no embedded font
 * program — which is exactly why this works in a dependency tree where
 * `pdfjs-dist` is absent and `standardFontDataUrl` is deliberately unset.
 */
export function buildPdf(options: PdfOptions = {}): Buffer {
  const {
    text = 'Rechnung 1200,00 EUR',
    declaredPages,
    fontSize = 24,
    at = [72, 720],
    encrypted = false,
    imageOnly = false,
  } = options;

  const stream = imageOnly
    ? '0 0 100 100 re f'
    : `BT /F1 ${fontSize} Tf ${at[0]} ${at[1]} Td (${escapePdf(text)}) Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R] /Count ${declaredPages ?? 1} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  if (encrypted) {
    // Not cryptographically real, and it does not need to be: pdf.js builds its
    // cipher factory and rejects with a PasswordException before validating
    // anything, which is the branch under test.
    objects.push(
      '<< /Filter /Standard /V 2 /R 3 /Length 128 /P -1 ' +
        `/O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> >>`
    );
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R` +
    (encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<00> <00>]` : '') +
    ` >>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

function escapePdf(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}

/**
 * A PDF with `count` real pages, each carrying one line of text.
 *
 * Distinct from `buildPdf({ declaredPages })`, which lies in `/Count`: pdf.js
 * corrects a `/Count` that does not match the page tree, so a lie cannot reach
 * the page loop. These pages are real, which is what exercises the cap.
 */
export function buildMultiPagePdf(count: number): Buffer {
  const objects: (string | Buffer)[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  // Objects: 1 catalog, 2 pages, then a page and a content object per page,
  // then the shared font last.
  const fontNumber = 3 + count * 2;
  const kids: string[] = [];
  for (let page = 0; page < count; page += 1) kids.push(`${3 + page * 2} 0 R`);
  objects.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`);
  for (let page = 0; page < count; page += 1) {
    const contentNumber = 4 + page * 2;
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        `/Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`
    );
    const stream = `BT /F1 24 Tf 72 720 Td (Seite ${page + 1}) Tj ET`;
    objects.push(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
    );
  }
  objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  );
  return assemblePdf(objects);
}

export type StreamFilter =
  | 'flate'
  | 'lzw'
  | 'runlength'
  | 'ascii85+flate'
  | 'asciihex+flate'
  /** An image codec: the pre-scan must leave it alone. Stored raw. */
  | 'dct';

interface FilteredPdfOptions {
  /**
   * How the stream dictionary states its length. `indirect` puts the number
   * in its own object, as most writers do; `wrong` declares ten bytes, which
   * is what forces the pre-scan back onto the `endstream` keyword.
   */
  length?: 'direct' | 'indirect' | 'wrong';
}

/**
 * A one-page PDF whose content stream is `megabytes` of text behind `filter`.
 *
 * The file itself stays small — kilobytes — while the stream decodes to the
 * size asked for. Past the pre-scan's ceiling this is the bomb it exists to
 * catch before pdf.js materialises it; below the ceiling it is an ordinary,
 * if wordy, document that must still be read.
 */
export function buildFilteredPdf(
  filter: StreamFilter,
  megabytes: number,
  options: FilteredPdfOptions = {}
): Buffer {
  const operator = `(${'A'.repeat(80)}) Tj\n`;
  const body = Buffer.alloc(Math.round(megabytes * 1024 * 1024)).fill(
    operator,
    0,
    undefined,
    'latin1'
  );
  const raw = Buffer.concat([
    Buffer.from('BT /F1 12 Tf 72 720 Td\n', 'latin1'),
    body,
    Buffer.from('\nET', 'latin1'),
  ]);
  let data: Buffer;
  let name: string;
  switch (filter) {
    case 'flate':
      data = deflateSync(raw, { level: 9 });
      name = '/FlateDecode';
      break;
    case 'lzw':
      data = lzwEncode(raw);
      name = '/LZWDecode';
      break;
    case 'runlength':
      data = runLengthEncode(raw);
      name = '/RunLengthDecode';
      break;
    case 'ascii85+flate':
      data = ascii85Encode(deflateSync(raw, { level: 9 }));
      name = '[/ASCII85Decode /FlateDecode]';
      break;
    case 'asciihex+flate':
      data = hexEncode(deflateSync(raw, { level: 9 }));
      name = '[/ASCIIHexDecode /FlateDecode]';
      break;
    case 'dct':
      data = raw;
      name = '/DCTDecode';
      break;
  }
  const length =
    options.length === 'indirect'
      ? '6 0 R'
      : options.length === 'wrong'
        ? '10'
        : String(data.length);
  const contents = Buffer.concat([
    Buffer.from(`<< /Length ${length} /Filter ${name} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    contents,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...(options.length === 'indirect' ? [String(data.length)] : []),
  ]);
}

/**
 * ASCIIHex as a writer might really produce it: mixed case, folded into
 * lines, closed with `>`. The decoder has a branch for each of those.
 */
function hexEncode(data: Buffer): Buffer {
  const hex = data.toString('hex');
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 64) {
    const line = hex.slice(i, i + 64);
    lines.push((i / 64) % 2 === 0 ? line.toUpperCase() : line);
  }
  return Buffer.from(`${lines.join('\n')}>`, 'latin1');
}

/** Cross-reference table and trailer around a list of object bodies. */
function assemblePdf(objects: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    length += chunk.length;
  });
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    tail += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  tail +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

/**
 * PDF LZW: 9- to 12-bit codes, MSB first, 256 clears, 257 ends, the code
 * width growing one entry early (`EarlyChange` 1, the default). Mirrors what
 * pdf.js decodes, so the extractor's length counter is checked against the
 * real thing rather than against itself.
 *
 * The table is keyed on `prefix code × 256 + byte` rather than on the string
 * the entry stands for. The string form built a new string and hashed it for
 * every input byte, which was fine at forty megabytes without instrumentation
 * and took twelve seconds — past the test timeout — with V8 coverage counting
 * every one of those operations. The numeric form is the same automaton, and
 * the stream it writes is byte-for-byte the same.
 */
function lzwEncode(data: Buffer): Buffer {
  const out: number[] = [];
  let bits = 0;
  let held = 0;
  let width = 9;
  const emit = (code: number): void => {
    bits = (bits << width) | code;
    held += width;
    while (held >= 8) {
      out.push((bits >>> (held - 8)) & 255);
      held -= 8;
      bits &= (1 << held) - 1;
    }
  };

  let table = new Map<number, number>();
  let next = 258;
  emit(256);
  // The code for the sequence read so far: a byte value while it is one byte
  // long, a table entry after that. -1 before the first byte.
  let prefix = -1;
  for (const byte of data) {
    if (prefix < 0) {
      prefix = byte;
      continue;
    }
    const key = prefix * 256 + byte;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix);
    table.set(key, next);
    next += 1;
    // The decoder is one entry behind the encoder, and `EarlyChange` 1 is what
    // lines the two width switches up: the encoder switches on `next` alone.
    if (width < 12 && next >= 1 << width) width += 1;
    if (next >= 4096) {
      emit(256);
      table = new Map();
      next = 258;
      width = 9;
    }
    prefix = byte;
  }
  if (prefix >= 0) emit(prefix);
  emit(257);
  if (held > 0) out.push((bits << (8 - held)) & 255);
  return Buffer.from(out);
}

/** PackBits, as `/RunLengthDecode` reads it: runs and literal batches. */
function runLengthEncode(data: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const byte = data[i] as number;
    let run = 1;
    while (run < 128 && i + run < data.length && data[i + run] === byte)
      run += 1;
    if (run >= 2) {
      out.push(257 - run, byte);
      i += run;
      continue;
    }
    let literal = 1;
    while (
      literal < 128 &&
      i + literal < data.length &&
      !(
        i + literal + 1 < data.length &&
        data[i + literal] === data[i + literal + 1]
      )
    ) {
      literal += 1;
    }
    out.push(literal - 1);
    for (let k = 0; k < literal; k += 1) out.push(data[i + k] as number);
    i += literal;
  }
  out.push(128);
  return Buffer.from(out);
}

function ascii85Encode(data: Buffer): Buffer {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const group = data.subarray(i, i + 4);
    const padded = Buffer.concat([group, Buffer.alloc(4 - group.length)]);
    let value = padded.readUInt32BE(0);
    if (group.length === 4 && value === 0) {
      out += 'z';
      continue;
    }
    const digits: string[] = [];
    for (let k = 0; k < 5; k += 1) {
      digits.unshift(String.fromCharCode(33 + (value % 85)));
      value = Math.floor(value / 85);
    }
    out += digits.slice(0, group.length + 1).join('');
  }
  return Buffer.from(`${out}~>`, 'latin1');
}

/**
 * An .xlsx amplification bomb: one long shared string behind a grid of cells.
 *
 * A shared string is stored once and referenced by index, so a kilobyte of
 * archive stands for `stringChars * rows * cols` characters of output. This is
 * the shape that took the whole process down before the per-row budget.
 */
export function buildXlsxBomb(
  stringChars: number,
  rows: number,
  cols: number
): Buffer {
  let sheet = `${XML}<worksheet><sheetData>`;
  for (let r = 1; r <= rows; r += 1) {
    sheet += `<row r="${r}">`;
    for (let c = 0; c < cols; c += 1) sheet += '<c t="s"><v>0</v></c>';
    sheet += '</row>';
  }
  sheet += '</sheetData></worksheet>';
  return zip({
    'xl/workbook.xml': `${XML}<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `${XML}<sst><si><t>${'A'.repeat(stringChars)}</t></si></sst>`,
    'xl/worksheets/sheet1.xml': sheet,
  });
}

const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A .docx whose body is the given paragraphs. */
export function buildDocx(
  paragraphs: string[],
  options: { vanish?: boolean; fieldCode?: string } = {}
): Buffer {
  const body = paragraphs
    .map(
      (paragraph) =>
        '<w:p><w:r>' +
        (options.vanish ? '<w:rPr><w:vanish/></w:rPr>' : '') +
        `<w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`
    )
    .join('');
  const field =
    options.fieldCode === undefined
      ? ''
      : `<w:p><w:r><w:instrText>${escapeXml(options.fieldCode)}</w:instrText></w:r></w:p>`;
  return zip({
    'word/document.xml': `${XML}<w:document ${W_NS}><w:body>${field}${body}</w:body></w:document>`,
  });
}

/** A .docx carrying a raw `word/document.xml`, for the malformed cases. */
export function buildDocxRaw(documentXml: string): Buffer {
  return zip({ 'word/document.xml': documentXml });
}

interface XlsxOptions {
  /**
   * Put the cell values in `xl/sharedStrings.xml` and reference them by index,
   * which is what Excel itself does. The inline form is legal and much rarer,
   * so both are worth building.
   */
  shared?: boolean;
  /** Omit `xl/_rels/workbook.xml.rels`, forcing the fallback naming. */
  withoutRels?: boolean;
  /** Start each row at this column letter, leaving the ones before it empty. */
  startColumn?: number;
}

/** An .xlsx, with the cells either inline or in the shared-string table. */
export function buildXlsx(
  sheets: { name: string; rows: string[][] }[],
  options: XlsxOptions = {}
): Buffer {
  const files: Record<string, Buffer> = {};
  const relationships: string[] = [];
  const sheetTags: string[] = [];
  const shared: string[] = [];
  const indexOfShared = (value: string): number => {
    const existing = shared.indexOf(value);
    if (existing >= 0) return existing;
    shared.push(value);
    return shared.length - 1;
  };

  sheets.forEach((sheet, index) => {
    const id = `rId${index + 1}`;
    const path = `sheet${index + 1}.xml`;
    relationships.push(
      `<Relationship Id="${id}" Target="worksheets/${path}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>'
    );
    sheetTags.push(
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="${id}"/>`
    );
    const rows = sheet.rows
      .map((cells, rowIndex) => {
        const columns = cells
          .map((value, column) => {
            const reference = `${letter(column + (options.startColumn ?? 0))}${rowIndex + 1}`;
            return options.shared === true
              ? `<c r="${reference}" t="s"><v>${indexOfShared(value)}</v></c>`
              : `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
          })
          .join('');
        return `<row r="${rowIndex + 1}">${columns}</row>`;
      })
      .join('');
    files[`xl/worksheets/${path}`] = Buffer.from(
      `${XML}<worksheet><sheetData>${rows}</sheetData></worksheet>`
    );
  });

  files['xl/workbook.xml'] = Buffer.from(
    `${XML}<workbook><sheets>${sheetTags.join('')}</sheets></workbook>`
  );
  if (options.withoutRels !== true) {
    files['xl/_rels/workbook.xml.rels'] = Buffer.from(
      `${XML}<Relationships>${relationships.join('')}</Relationships>`
    );
  }
  if (options.shared === true) {
    files['xl/sharedStrings.xml'] = Buffer.from(
      `${XML}<sst>${shared
        .map((value) => `<si><t>${escapeXml(value)}</t></si>`)
        .join('')}</sst>`
    );
  }
  return zip(files);
}

/** An .ods with one table. `repeat` sets number-columns-repeated on a cell. */
export function buildOds(
  sheets: { name: string; rows: string[][] }[],
  options: { trailingRepeat?: number } = {}
): Buffer {
  const tables = sheets
    .map((sheet) => {
      const rows = sheet.rows
        .map((cells) => {
          const columns = cells
            .map(
              (value) =>
                `<table:table-cell><text:p>${escapeXml(value)}</text:p></table:table-cell>`
            )
            .join('');
          const padding =
            options.trailingRepeat === undefined
              ? ''
              : `<table:table-cell table:number-columns-repeated="${options.trailingRepeat}"/>`;
          return `<table:table-row>${columns}${padding}</table:table-row>`;
        })
        .join('');
      return `<table:table table:name="${escapeXml(sheet.name)}">${rows}</table:table>`;
    })
    .join('');
  return zip({
    'content.xml': `${XML}<office:document-content>${tables}</office:document-content>`,
  });
}

/** An .odt whose body is the given paragraphs. */
export function buildOdt(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((paragraph) => `<text:p>${escapeXml(paragraph)}</text:p>`)
    .join('');
  return zip({
    'content.xml': `${XML}<office:document-content><office:body>${body}</office:body></office:document-content>`,
  });
}

/** A .pptx with one slide per entry. */
export function buildPptx(slides: string[]): Buffer {
  const files: Record<string, Buffer> = {};
  slides.forEach((text, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = Buffer.from(
      `${XML}<p:sld><p:cSld><p:spTree><p:sp><p:txBody>` +
        `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>` +
        '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
    );
  });
  return zip(files);
}

export function zip(files: Record<string, Buffer | string>): Buffer {
  const data: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    data[name] = typeof content === 'string' ? Buffer.from(content) : content;
  }
  return Buffer.from(zipSync(data));
}

const CENTRAL_DIRECTORY = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/**
 * Rewrites the declared uncompressed size in every central-directory record.
 *
 * This is the number `unzipSync` sizes its output buffer from, and nothing
 * checks it against the data. Patching it is how a three-hundred-byte archive
 * claims to hold four gigabytes.
 */
export function patchDeclaredSize(archive: Buffer, size: number): Buffer {
  const patched = Buffer.from(archive);
  let at = patched.indexOf(CENTRAL_DIRECTORY);
  while (at >= 0) {
    patched.writeUInt32LE(size, at + 24);
    at = patched.indexOf(CENTRAL_DIRECTORY, at + 4);
  }
  return patched;
}

function letter(index: number): string {
  let out = '';
  let n = index;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
