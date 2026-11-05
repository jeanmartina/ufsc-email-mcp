import type { MessageStructureObject } from 'imapflow';

import { defuseAutoFetch, stripInvisible } from './analyze.js';

/** How deep the MIME tree is walked. Forwarded mail nests; a loop does not. */
const MAX_DEPTH = 5;
/** Upper bound on how many parts one listing may describe. */
const MAX_ATTACHMENTS = 50;
const MAX_FILENAME_LENGTH = 120;

/**
 * Extensions that are executable somewhere. The list is long on purpose: this
 * is a refusal list applied on top of the content-type allowlist, and the cost
 * of an extra entry is one unusual attachment that has to be fetched by other
 * means.
 *
 * Exported so a test can walk it. An entry {@link extensionOf} cannot produce
 * is not a stricter list, it is a longer one that refuses less — and nothing
 * about reading the two declarations side by side says which is which.
 */
export const EXECUTABLE_EXTENSIONS = new Set([
  'ade',
  'adp',
  'app',
  'appimage',
  'application',
  'appref-ms',
  'asp',
  'aspx',
  'bas',
  'bat',
  'cer',
  'chm',
  'cmd',
  'com',
  'cpl',
  'crt',
  'csh',
  'deb',
  'dll',
  'dmg',
  'exe',
  'fxp',
  'gadget',
  'hlp',
  'hta',
  'inf',
  'ins',
  'iso',
  'isp',
  'its',
  'jar',
  'js',
  'jse',
  'ksh',
  'lnk',
  'mad',
  'maf',
  'mag',
  'mam',
  'maq',
  'mar',
  'mas',
  'mat',
  'mau',
  'mav',
  'maw',
  'mda',
  'mdb',
  'mde',
  'mdt',
  'mdw',
  'mdz',
  'msc',
  'msh',
  'msh1',
  'msh2',
  'mshxml',
  'msi',
  'msp',
  'mst',
  'ops',
  'pcd',
  'pif',
  'pkg',
  'pl',
  'plg',
  'prf',
  'prg',
  'ps1',
  'ps2',
  'psc1',
  'psc2',
  'py',
  'pyc',
  'pyo',
  'rb',
  'reg',
  'rpm',
  'scf',
  'scr',
  'sct',
  'sh',
  'shb',
  'shs',
  'url',
  'vb',
  'vbe',
  'vbs',
  'vsmacros',
  'vsw',
  'ws',
  'wsc',
  'wsf',
  'wsh',
  'xll',
]);

/**
 * A filename ending in something that looks like a document extension followed
 * by an executable one — `invoice.pdf.exe`. Mail clients that hide known
 * extensions render it as `invoice.pdf`.
 */
const DOUBLE_EXTENSION_BAIT =
  /\.(pdf|docx?|xlsx?|pptx?|txt|csv|jpe?g|png|gif|zip|rtf|odt|ods)\.[a-z0-9]{1,5}$/i;

/**
 * The shape of a media type — RFC 6838's token characters, bounded on both
 * sides of the slash.
 *
 * The declared type of a part is the sender's string, and it used to travel
 * as it came: into `content_type`, into the refusal note that quotes it, and
 * from there into the `get_message` metadata block outside the fence and into
 * error results the budget never measures. A hundred kilobytes of it in one
 * `Content-Type` header made the message unreadable. Anything that does not
 * match here is not a media type, is never on the allowlist, and is reported
 * as `application/octet-stream` with a note that says so without quoting it.
 */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;

export function isMediaType(value: string): boolean {
  return MEDIA_TYPE.test(value);
}

export interface AttachmentCandidate {
  partId: string;
  filename: string;
  contentType: string;
  /** Size as declared by the server; not yet verified against the bytes. */
  size: number | undefined;
  disposition: string | undefined;
  /** True when nothing in the *declaration* disqualifies it. */
  allowed: boolean;
  /** Why it was refused, or what looks off about it. */
  notes: string[];
}

export interface AttachmentPolicy {
  allowedTypes: string[];
  /**
   * Size ceiling for the destination this check is for.
   *
   * Per destination, because there are three of them and they answer different
   * questions: what may enter the model's context, what may be written to disk,
   * what a parser may be handed. The caller picks the number; naming it here
   * keeps the refusal pointing at the variable an operator would actually
   * change.
   */
  maxBytes: number;
  /** Environment variable behind {@link maxBytes}, for the refusal text. */
  maxBytesName: string;
}

/**
 * Strips a filename down to something safe to print and to reason about.
 *
 * The name is never used to open a file — nothing here writes to disk — but it
 * does reach the model, and a name carrying directional overrides or path
 * separators is trying to be read as something it is not.
 */
export function sanitizeFilename(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return '(unnamed)';
  // Two orderings matter here, and both were wrong.
  //
  // The trim runs *before* the leading dots are taken off, and again after. The
  // other way round, one space defeated the rule: ` .bashrc` has no dot in
  // first position when the strip runs, and the trim that followed exposed it,
  // so the name reached the model looking like a dotfile after all.
  //
  // And the strip never takes the dot that carries the extension. It used to:
  // `.exe` came out as `exe`, `extensionOf` then answered `''`, and an empty
  // extension makes `checkPolicy` skip the executable check entirely rather
  // than fail it — so the blocklist was bypassed by naming the attachment
  // `.exe`. That is the same failure `appref-ms` caused, reached by a different
  // route. The lookahead keeps the leading dots whenever removing them would
  // consume the last one; a name that has another dot further along loses them
  // as before.
  const cleaned = defuseAutoFetch(stripInvisible(raw.normalize('NFKC')))
    .replace(/[/\\]/g, '_')
    .trim()
    .replace(/^\.+(?=.*\.)/, '')
    .trim();
  // A name of nothing but dots is not a name. It carries no extension either,
  // so keeping it buys the check above nothing and only puts `...` in front of
  // a reader.
  if (cleaned === '' || /^\.+$/.test(cleaned)) return '(unnamed)';
  return cleaned.length > MAX_FILENAME_LENGTH
    ? `${cleaned.slice(0, MAX_FILENAME_LENGTH)}…`
    : cleaned;
}

/**
 * The trailing extension of a filename, lowercased, or `''`.
 *
 * The character class and the length have to cover every entry of
 * {@link EXECUTABLE_EXTENSIONS}, or the blocklist has entries that can never be
 * read out of a name. Both used to be too narrow: `appref-ms` carries a hyphen
 * and `application` is eleven characters, so both returned `''` — and an empty
 * extension makes {@link checkPolicy} skip the executable check entirely rather
 * than fail it. `Rechnung-2026.appref-ms` declared as `application/xml` (which
 * is in the default type allowlist, and which a ClickOnce manifest genuinely
 * is) therefore reached the download directory under its own name with no note
 * against it. The property test over the whole set is what keeps the two in
 * step from here on.
 */
export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9-]{1,16})$/.exec(filename);
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * Walks the MIME tree and returns every part that is an attachment.
 *
 * Parts inside a forwarded `message/rfc822` are included: an attachment that
 * arrives one level deeper is exactly as dangerous, and a listing that stops at
 * the outer envelope would report "no attachments" for the most common way of
 * passing a file along.
 */
export function collectAttachments(
  structure: MessageStructureObject | undefined
): AttachmentCandidate[] {
  const found: AttachmentCandidate[] = [];
  walk(structure, 0, found);
  return found.slice(0, MAX_ATTACHMENTS);
}

function walk(
  node: MessageStructureObject | undefined,
  depth: number,
  found: AttachmentCandidate[]
): void {
  if (
    node === undefined ||
    depth > MAX_DEPTH ||
    found.length >= MAX_ATTACHMENTS
  )
    return;

  if (node.childNodes !== undefined && node.childNodes.length > 0) {
    for (const child of node.childNodes) walk(child, depth + 1, found);
    return;
  }

  const declaredType = (node.type ?? 'application/octet-stream').toLowerCase();
  const type = isMediaType(declaredType)
    ? declaredType
    : 'application/octet-stream';
  const disposition = node.disposition?.toLowerCase();
  const declaredName =
    node.dispositionParameters?.filename ?? node.parameters?.name;

  // A part is an attachment when it says so, or when it carries a filename, or
  // when it is simply not one of the two body types. Inline images count: they
  // are still bytes from a stranger.
  const isBody =
    (type === 'text/plain' || type === 'text/html') &&
    disposition !== 'attachment' &&
    declaredName === undefined;
  if (isBody || node.part === undefined) return;

  const filename = sanitizeFilename(declaredName);
  const notes: string[] = [];
  if (type !== declaredType) {
    notes.push(
      'the declared content type is not a valid media type and is reported as application/octet-stream'
    );
  }
  if (declaredName !== undefined && DOUBLE_EXTENSION_BAIT.test(declaredName)) {
    notes.push(
      'filename has a double extension — it renders as a document but is not one'
    );
  }
  found.push({
    partId: node.part,
    filename,
    contentType: type,
    // imapflow reads the size with `Number(value) || 0`, so a server that
    // writes `1e400` hands over Infinity — which JSON renders as null, and
    // null fails the `size: number` the output schema promises for the whole
    // listing. A size that is not a safe non-negative integer is unknown.
    size:
      Number.isSafeInteger(node.size) && (node.size as number) >= 0
        ? node.size
        : undefined,
    disposition,
    allowed: true,
    notes,
  });
}

/**
 * Applies the declaration-level policy.
 *
 * Everything checked here comes from the sender, so a pass means only "nothing
 * in what it claims about itself disqualifies it". The bytes are checked
 * separately in {@link sniffContent} when they are actually fetched.
 */
export function checkPolicy(
  candidate: AttachmentCandidate,
  policy: AttachmentPolicy
): AttachmentCandidate {
  const notes = [...candidate.notes];
  let allowed = true;

  const extension = extensionOf(candidate.filename);
  if (extension !== '' && EXECUTABLE_EXTENSIONS.has(extension)) {
    allowed = false;
    notes.push(`refused: .${extension} is an executable file type`);
  }
  if (!policy.allowedTypes.includes(candidate.contentType)) {
    allowed = false;
    notes.push(
      `refused: content type ${candidate.contentType} is not in the allowlist (IMAP_ATTACHMENT_TYPES)`
    );
  }
  if (candidate.size !== undefined && candidate.size > policy.maxBytes) {
    allowed = false;
    notes.push(
      `refused: declared size ${candidate.size} exceeds ${policy.maxBytesName} (${policy.maxBytes})`
    );
  }

  return { ...candidate, allowed, notes };
}

export interface ContentVerdict {
  executable: boolean;
  detectedType: string | undefined;
}

/**
 * Identifies content by its leading bytes.
 *
 * The declared content type is a claim by the sender; this is the only check
 * that looks at what was actually sent. An executable renamed to `.txt` and
 * declared as `text/plain` passes every other gate and fails here.
 */
export function sniffContent(buffer: Buffer): ContentVerdict {
  const byte = (i: number): number => buffer[i] ?? -1;

  if (byte(0) === 0x4d && byte(1) === 0x5a) {
    return { executable: true, detectedType: 'application/x-msdownload' };
  }
  if (
    byte(0) === 0x7f &&
    byte(1) === 0x45 &&
    byte(2) === 0x4c &&
    byte(3) === 0x46
  ) {
    return { executable: true, detectedType: 'application/x-elf' };
  }
  // `>>> 0` is load-bearing: JS bitwise operators produce a *signed* 32-bit
  // result, so without it 0xfeedface arrives as a negative number and none of
  // the Mach-O comparisons below can ever match.
  const magic32 =
    ((byte(0) << 24) | (byte(1) << 16) | (byte(2) << 8) | byte(3)) >>> 0;
  if (
    magic32 === 0xfeedface ||
    magic32 === 0xfeedfacf ||
    magic32 === 0xcafebabe
  ) {
    return { executable: true, detectedType: 'application/x-mach-binary' };
  }
  if (byte(0) === 0x23 && byte(1) === 0x21) {
    return { executable: true, detectedType: 'text/x-shellscript' };
  }

  const starts = (signature: number[]): boolean =>
    signature.every((value, index) => byte(index) === value);

  if (starts([0x25, 0x50, 0x44, 0x46])) {
    return { executable: false, detectedType: 'application/pdf' };
  }
  if (starts([0x89, 0x50, 0x4e, 0x47])) {
    return { executable: false, detectedType: 'image/png' };
  }
  if (starts([0xff, 0xd8, 0xff])) {
    return { executable: false, detectedType: 'image/jpeg' };
  }
  if (starts([0x47, 0x49, 0x46, 0x38])) {
    return { executable: false, detectedType: 'image/gif' };
  }
  if (
    starts([0x52, 0x49, 0x46, 0x46]) &&
    byte(8) === 0x57 &&
    byte(9) === 0x45 &&
    byte(10) === 0x42 &&
    byte(11) === 0x50
  ) {
    return { executable: false, detectedType: 'image/webp' };
  }
  if (starts([0x50, 0x4b, 0x03, 0x04])) {
    // Also every modern Office and OpenDocument file.
    return { executable: false, detectedType: 'application/zip' };
  }
  return { executable: false, detectedType: undefined };
}
