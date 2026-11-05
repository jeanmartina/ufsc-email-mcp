import { fork } from 'node:child_process';
import { once } from 'node:events';

import type { ExtractKind, ExtractRequest, ExtractResponse } from './types.js';

export type {
  ExtractKind,
  ExtractReason,
  ExtractRequest,
  ExtractResponse,
} from './types.js';

/**
 * How long a document may be parsed before the process doing it is killed.
 *
 * Generous next to the five seconds a regular expression gets in the sibling
 * servers, because a hundred-page PDF is honest work — and finite, because a
 * document that has not finished by now is not going to.
 */
export const EXTRACT_TIMEOUT_MS = 20_000;

/**
 * Characters the child may return, before any of the paging below.
 *
 * Not a context budget — that is `max_chars` at the tool, and it is much
 * smaller. This is the ceiling on what is held in memory and paged through,
 * and the child enforces it for every format: nothing larger is ever built
 * there, let alone sent back.
 */
export const MAX_EXTRACT_CHARS = 1_000_000;

/**
 * V8 heap the parsing process may use.
 *
 * Best effort, and named as such. It bounds a pathological object graph, and
 * when it fires the child aborts — on its own, which is the whole reason the
 * parse is in a process. It does not bound typed arrays, which are external
 * memory; the deflate pre-scan in `pdf.ts` and the entry caps in `ooxml.ts`
 * are what cover those.
 */
const CHILD_MEMORY_MB = 256;

/**
 * Requests admitted at once, running and waiting together.
 *
 * Extractions run one at a time (see {@link queue}), so a request that arrives
 * behind seven others would wait up to seven timeouts for its turn, holding
 * its mailbox lock throughout. Past this many it is refused outright, which is
 * an answer the caller can act on.
 */
const MAX_IN_FLIGHT = 8;

/** Content types this server can read text out of, and what each one is. */
const EXTRACTABLE = new Map<string, ExtractKind>([
  ['application/pdf', 'pdf'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pptx',
  ],
  ['application/vnd.oasis.opendocument.text', 'odt'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
]);

/** The same set as content types, for `get_server_info`. */
export const EXTRACTABLE_TYPES: string[] = [...EXTRACTABLE.keys()];

/** Prose for the refusals, so every one of them names the same set. */
export const EXTRACTABLE_TYPE_NAMES =
  'PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and OpenDocument text ' +
  'and spreadsheets (.odt, .ods)';

export function extractKindOf(contentType: string): ExtractKind | undefined {
  return EXTRACTABLE.get(contentType.toLowerCase());
}

export function isExtractable(contentType: string): boolean {
  return EXTRACTABLE.has(contentType.toLowerCase());
}

/** The magic-byte verdict an honest container of this kind produces. */
export function expectedSignature(kind: ExtractKind): string {
  // Every OOXML and OpenDocument file is a zip, which is why `sniffContent`
  // reports one for all five of them.
  return kind === 'pdf' ? 'application/pdf' : 'application/zip';
}

/**
 * Serialises extractions.
 *
 * One process per call and no limit would mean N concurrent tool calls holding
 * N processes of {@link CHILD_MEMORY_MB} each, which is a memory limit that
 * multiplies by a number the caller chooses. The queue is the whole mechanism:
 * the next extraction starts when the previous process is gone.
 */
let queue: Promise<unknown> = Promise.resolve();
let inFlight = 0;

export async function extractDocumentText(
  request: ExtractRequest,
  limits: ChildLimits = {}
): Promise<ExtractResponse> {
  if (inFlight >= MAX_IN_FLIGHT) return { ok: false, reason: 'busy' };
  inFlight += 1;
  try {
    const run = queue.then(
      () => runInChild(request, limits),
      () => runInChild(request, limits)
    );
    queue = run.catch(() => undefined);
    return await run;
  } finally {
    inFlight -= 1;
  }
}

/**
 * Narrowed by the tests, never by the server.
 *
 * The timeout and the memory ceiling are the two guards whose whole purpose is
 * what happens when they fire, and neither can be reached in a test at its real
 * value without a document engineered to spend twenty seconds or a quarter of a
 * gigabyte. Making them arguments is what lets the failure paths be exercised
 * in milliseconds; nothing in `src/` passes them.
 */
export interface ChildLimits {
  timeoutMs?: number;
  memoryMb?: number;
}

/** A code for the log, never a message. */
function codeOf(error: unknown): string {
  const value = error as { code?: unknown; name?: unknown } | null;
  if (typeof value?.code === 'string') return value.code;
  if (typeof value?.name === 'string') return value.name;
  return 'unknown';
}

async function runInChild(
  request: ExtractRequest,
  limits: ChildLimits = {}
): Promise<ExtractResponse> {
  const timeoutMs = limits.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const memoryMb = limits.memoryMb ?? CHILD_MEMORY_MB;

  const child = fork(
    new URL(
      import.meta.url.endsWith('.ts') ? './child.ts' : './child.js',
      import.meta.url
    ),
    [],
    {
      // Stated rather than inherited. The parent's own flags may be ones a
      // child cannot take — `--input-type` is one — and an inherited flag that
      // fails to parse would turn every extraction into a silent `internal`.
      execArgv: [`--max-old-space-size=${memoryMb}`],
      // Not tidiness — correctness. The parent's stdout is this server's
      // JSON-RPC transport, and pdf.js logs. One line from inside the parser
      // would corrupt the framing and hang the session. Discarded; stderr is
      // shared, because that is where every other diagnostic in this server
      // already goes.
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      // Structured clone rather than JSON: the request carries the document as
      // a typed array, and JSON would turn it into an array of numbers ten
      // times its size.
      serialization: 'advanced',
    }
  );

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ExtractResponse>((resolve) => {
      // The first answer wins. Everything after it — the exit of a child that
      // was killed because it had already answered, most of all — is silence,
      // not a second verdict.
      let settled = false;
      const settle = (value: ExtractResponse): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      timer = setTimeout(() => {
        settle({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      child.once('message', (value) => {
        settle(value as ExtractResponse);
      });
      child.once('error', (error) => {
        if (settled) return;
        console.error(`imap-mcp: extraction process failed: ${codeOf(error)}`);
        settle({ ok: false, reason: 'internal' });
      });
      child.once('exit', (code, signal) => {
        // Only reached when the child left without answering. An abort is what
        // V8 does when the heap limit is hit — and what the process does
        // *instead of* taking the server with it, which is the property being
        // bought here.
        if (settled) return;
        if (signal === 'SIGABRT' || code === 134) {
          settle({ ok: false, reason: 'out-of-memory' });
          return;
        }
        console.error(
          `imap-mcp: extraction process exited early: ${signal ?? `code ${code}`}`
        );
        settle({ ok: false, reason: 'internal' });
      });
      try {
        child.send(request);
      } catch (error) {
        console.error(`imap-mcp: extraction request failed: ${codeOf(error)}`);
        settle({ ok: false, reason: 'internal' });
      }
    });
  } finally {
    if (timer) clearTimeout(timer);
    // Unconditional: on the timeout path the process is still inside the parse
    // and will never exit on its own. SIGKILL, because a parser stuck in native
    // code does not check for anything gentler — and because a process, unlike
    // a thread, can be killed from outside whatever it is doing.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
}
