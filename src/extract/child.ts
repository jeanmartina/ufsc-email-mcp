import type { ExtractRequest, ExtractResponse } from './types.js';

/**
 * The extraction child: the only code in this server that parses a binary a
 * stranger sent, and the reason it runs in a process of its own.
 *
 * A process rather than a worker thread, and that was a lesson rather than a
 * preference. A worker's `resourceLimits` promise to turn a runaway parse into
 * `ERR_WORKER_OUT_OF_MEMORY`, and for most allocation patterns they do; for
 * the one a 3 kB spreadsheet produced they did not, and the whole server died
 * with `FATAL ERROR: Reached heap limit`. A thread also cannot give back the
 * memory a terminated parse left behind — a gigabyte stayed resident after
 * `terminate()`. A process that is killed takes its memory with it, whatever
 * it was doing, and a process that aborts aborts alone.
 *
 * Read the import rules before editing this file. It is started from its own
 * source — `child.ts` under vitest, which Node runs with type stripping, and
 * `child.js` from `dist/` in production — so Node loads it and everything it
 * reaches, without vitest's resolver. Node strips types; it does not rewrite a
 * `./x.js` specifier to the `./x.ts` sitting beside it. So:
 *
 * - static imports here may only be bare specifiers (`node:*`, a package) or
 *   `import type`, which is erased before it can fail to resolve;
 * - anything relative is loaded through {@link sibling}, which picks the
 *   extension from this module's own;
 * - no enums, no namespaces, no parameter properties — type stripping cannot
 *   erase syntax that emits code.
 *
 * Get this wrong in one direction and every test fails while the build stays
 * green; get it wrong in the other and every test passes while the published
 * package throws on first use. The second is why `npm run build` is followed by
 * a real extraction against `dist/`.
 */
const EXTENSION = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

function sibling(path: string): string {
  return new URL(`${path}.${EXTENSION}`, import.meta.url).href;
}

async function run(request: ExtractRequest): Promise<ExtractResponse> {
  if (request.kind === 'pdf') {
    const { extractPdf } = (await import(
      sibling('./pdf')
    )) as typeof import('./pdf.js');
    return extractPdf(request.bytes, request.maxChars);
  }
  const [{ extractZipDocument }, { htmlToText }] = await Promise.all([
    import(sibling('./ooxml')) as Promise<typeof import('./ooxml.js')>,
    import(sibling('../analyze')) as Promise<typeof import('../analyze.js')>,
  ]);
  return extractZipDocument(
    request.kind,
    request.bytes,
    request.maxChars,
    htmlToText
  );
}

/** A code for the log, never a message: the message quotes the document. */
function codeOf(error: unknown): string {
  const value = error as { code?: unknown; name?: unknown } | null;
  if (typeof value?.code === 'string') return value.code;
  if (typeof value?.name === 'string') return value.name;
  return 'unknown';
}

const send = process.send?.bind(process);
if (send !== undefined) {
  // The parent is gone: nothing is waiting for an answer, and a parse that
  // outlives the server it was started by is a parse nobody asked for.
  process.on('disconnect', () => {
    process.exit(0);
  });
  process.once('message', (request: ExtractRequest) => {
    run(request).then(
      (response) => {
        send(response, () => {
          process.exit(0);
        });
      },
      (error: unknown) => {
        // Never the caught error. pdf.js and fflate quote the document in
        // their exception messages — byte offsets, object fragments, what they
        // found where they expected something else. That is text a stranger
        // wrote, and an error message is read as the server's own voice,
        // outside the fence every other piece of message content passes
        // through. A code crosses; the words are the host's.
        console.error(`imap-mcp: extraction failed: ${codeOf(error)}`);
        send(
          { ok: false, reason: 'internal' } satisfies ExtractResponse,
          () => {
            process.exit(0);
          }
        );
      }
    );
  });
}
