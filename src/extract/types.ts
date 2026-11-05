/**
 * The vocabulary shared between the extraction host and the worker.
 *
 * Types only, and that is a constraint rather than a preference. The child
 * process is started from its own source file — `child.ts` under vitest,
 * `child.js` from `dist/` — so everything it reaches is loaded by Node
 * directly, and Node's type stripping does not rewrite a `./x.js` specifier to
 * the `./x.ts` that exists next to it. A type-only import is erased before that can matter. A value
 * exported from here would not be, and would break `npm test` while leaving the
 * build green.
 */

/** A document format this server can read text out of. */
export type ExtractKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods';

/**
 * Why an extraction produced nothing.
 *
 * A code, never a message. The parsers quote the document in their exceptions —
 * pdf.js names byte offsets and object fragments, fflate echoes what it found —
 * and that is text a stranger wrote arriving in the model's context outside the
 * fence. The host turns these into sentences it wrote itself.
 */
export type ExtractReason =
  | 'no-text-layer'
  | 'encrypted'
  | 'corrupt'
  | 'not-a-document'
  | 'too-many-parts'
  // A document whose compressed parts expand far beyond any honest document:
  // decided before a parser sees them, by the size the expansion would reach.
  | 'too-large'
  // The next three are written by the host, not by a parser: the child that
  // would have reported them is the one that was stopped, or never started.
  | 'timeout'
  | 'out-of-memory'
  | 'busy'
  | 'internal';

export interface ExtractRequest {
  kind: ExtractKind;
  bytes: Uint8Array;
  /** Hard cap on the characters the worker may return. */
  maxChars: number;
}

export interface ExtractOk {
  ok: true;
  text: string;
  /** What `unitCount` counts, when the format has such a thing. */
  unitLabel?: 'pages' | 'slides' | 'sheets';
  unitCount?: number;
  /**
   * What the document declared, when the walk stopped short of it. A PDF may
   * claim more pages than were read; the difference is reported rather than
   * hidden, so a short answer is never mistaken for a short document.
   */
  declaredUnitCount?: number;
  /** True when `maxChars` cut the document short inside the worker. */
  clipped: boolean;
  /**
   * Text runs drawn where a reader cannot see them: outside the page box or
   * below two points in a PDF; marked hidden, set below two points or coloured
   * white in a Word document. A count, never a filter — see the note in
   * `pdf.ts`.
   */
  hiddenRuns?: number;
  totalRuns?: number;
}

export interface ExtractFailed {
  ok: false;
  reason: ExtractReason;
}

export type ExtractResponse = ExtractOk | ExtractFailed;
