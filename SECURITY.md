# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/imap-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real credentials,
tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published as a new
release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

The credentials this server holds are the mailbox itself. Anyone who obtains them can read
every message the account has ever received — which for most accounts includes password reset
links, invoices, contracts and two-factor codes. Treat `IMAP_PASSWORD` accordingly, prefer an
app-specific password over the account password, and prefer a dedicated account over a personal
one.

Treat every environment variable this server reads as a secret. The MCP client process, and
therefore the model driving it, sees every tool result — do not point this server at a mailbox
whose contents you would not put in a model's context.

## Why there is no send tool

An agent is exploitable by indirect prompt injection when three things are true at once: it can
reach private data, it processes content an attacker controls, and it can send data somewhere.
A mailbox supplies the first two by definition — anyone who knows the address can put text in
it. So the third is the one that can be removed, and removing it is worth more than any amount
of filtering.

This is not hypothetical. [EchoLeak](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711)
(CVE-2025-32711, CVSS 9.3) was a zero-click attack on Microsoft 365 Copilot: a single crafted
email, never opened by the user, caused internal data to be exfiltrated to an attacker's server
during ordinary background processing.

So this server has no SMTP client, no send tool and no way to make an outbound request of any
kind. `save_draft` writes into the mailbox it already has open; the message then sits in Drafts
until a person opens their own mail client and sends it. The human's mail client is the gate,
and it is a gate no text in a message can talk its way past.

**What this does not cover.** The property holds for _this server_, not for the session it runs
in. If the same agent also has a web-fetch tool, a shell, or another MCP server that can post
somewhere, the three conditions are satisfied again at the session level and mail read through
this server can be exfiltrated through that other tool. Nothing here can prevent that; all this
server can do is stop being the third ingredient. Compose accordingly.

## Untrusted content

Message bodies are returned between markers carrying a per-call random nonce, and every line
inside is prefixed with that nonce. Text written before the call cannot predict either, so a
message cannot close the block early and continue in the server's voice. A reminder follows the
block, because without one the last instruction-shaped sentence in the model's context is the
attacker's.

Before that, the text is normalised: hidden HTML elements are dropped, zero-width and
directional-override characters removed, and markdown image syntax — inline, reference and
shortcut style — defused so a rendering client cannot be induced to fetch a URL carrying data
in its query string.

The hidden-HTML pass is best effort, deliberately so. An element hidden inside a nested same-name
tag, hidden via a stylesheet class, or larger than the removal window survives it. That is
acceptable because nothing downstream trusts the stripping: whatever gets through still arrives
inside the fence, marked line by line as untrusted.

It is also a **single forward pass**, and that part is not a matter of taste. This section used to
claim the pass was safe because its scan windows were bounded. They were, and it wasn't: bounding
how far one removal may scan bounds one factor of a product whose other factor is how many
removals an input can start. A body of `'<style '` repeated 73 000 times is 512 000 legal bytes
that start 73 000 bounded scans and finish none of them, and the regex chain that used to sit here
took **33 seconds** on it — on a single-threaded process whose transport is stdio, so the whole
server, not just that call. The command timeout could not help: it wraps IMAP commands, not
parsing, and a `setTimeout` cannot fire on a blocked event loop. Reachable with one ordinary mail
that has a `text/html` part and no `text/plain` one, and again through a `text/html` attachment.
The pass now walks the input once with cursors that never rewind, plus one global budget for the
searches that look for a closing tag, so the number of start tokens no longer multiplies anything.
The same input is now under 20 ms.

The injection heuristics below are held to the same rule, and one of them broke it. The pattern
that looks for a fake delimiter — `---`, `===` or `###` before a word like `system` — began with an
unbounded run and no anchor, so from every position inside a run of hyphens the engine tried
every possible length before giving up: quadratic, 1.5 s on 40 000 hyphens, and the million
characters an extracted document may carry would have taken about a quarter of an hour. That scan
runs in this process on text the parser child has already handed back, so the child's timeout and
memory ceiling were no help, and every size guard passed because a document of hyphens is a few
kilobytes. The pattern is now anchored to the start of a run, which is linear, and
`analyze.test.ts` times every pattern on a million characters of its own trigger. A pattern that
cannot pass that test does not go in the list.

**Folder names are mailbox content too.** On a shared account, a public namespace or any mailbox
somebody else can create a folder in, the name is chosen by whoever created it — and it reaches the
model through `list_mailboxes` long before anyone opens a message. It used to reach it raw: not
`sanitizeText`, not `sanitizeFilename`, nothing. So `list_mailboxes` now returns two strings per
folder. `path` is verbatim, because it is the argument every other tool takes and a cleaned-up copy
would name a folder the server does not have; `display_name` is the copy that is safe to read and
to quote, and where the two differ the entry says so and spells out the difference. The mailbox
parameter refuses C0/C1 control characters outright. It does not refuse zero-width or
directional-override characters: a folder with those in its name exists, and a parameter that
rejected it would leave it unreadable and undeletable through this server.

**Results have a stated size and now keep to it.** `MAX_RESULT_BYTES` used to be enforced only where
a result was JSON. Everything else grows on the way out — defusing an image rewrites four characters
into forty-four, the per-line datamarks add ten characters a line, and a thread listing carries up
to fifty subjects and address lists the senders chose. `get_message(include_thread: true)` came to
570 000 characters against a stated 200 000. The check now runs on the assembled text.

The SPF/DKIM/DMARC verdicts are read from the topmost `Authentication-Results` header only —
a receiving server that adds one prepends it — and come with the authserv-id and a `forgeable`
flag. Senders can include such a header themselves, and not every receiving server filters
inbound copies; when the authserv-id cannot be related to the account's own domain, the flag
says so rather than letting a forged "pass" read like the real thing.

The injection patterns the server recognises are reported as a **signal**, never used to drop a
message silently. A filter that appeared to work would be an argument for trusting whatever got
through, which is precisely the wrong conclusion: an attacker who can iterate will find a
phrasing the patterns do not match.

**Be clear about what framing buys.** Measured across models, delimiting untrusted content
takes resistance to injection from roughly 61% to roughly 90% — a real improvement, and nowhere
near a guarantee, with the weakest models benefiting least. Against an attacker who adapts to
the defence, prompt-level measures fail. They are a speed bump. The architecture above is the
wall.

## Confirmation

Deleting messages, moving or copying them, and deleting a folder ask the person at the
keyboard, using MCP elicitation.
That matters because the older mechanism — returning a token the caller must send back — is
**not** a human-in-the-loop gate: the token appears in a tool result, so the model reads it and
can call again in the same turn without anyone seeing anything. It still prevents a target set
from being widened between the two calls, which is why it remains the fallback where a client
cannot show a dialog, and why the result says so plainly instead of implying an approval that
did not happen.

Tokens are random, single-use, expire after five minutes, and are bound to a SHA-256
fingerprint of the sorted target set: a confirmation obtained for one message cannot be
replayed for a longer list.

The key also names the mailboxes, and how it names them matters. It used to join source and
destination with `:`, and a mailbox name may contain one — the parameter allows it on purpose,
because a folder somebody else created may have one. So `("Inbox:Old" → "Archive")` and
`("Inbox" → "Old:Archive")` were the same key for the same messages, and a token or an accepted
dialog for the first pair executed the second, a pair nobody had been asked about. The names are
JSON-encoded now, for the move, the copy and the rename, and a test holds the two pairs apart.

`ELICITATION=false` moves a capable client onto that fallback deliberately, for a scheduled
job or a test harness. It does not remove the guard — there is no setting in which a guarded
call goes unannounced — and the server prints one line at startup saying it is off.

Confirmation text never quotes a subject, sender or body. That text is read by a human and by a
model, and putting attacker-chosen prose into it would hand the attacker the last word at
exactly the wrong moment. A folder name has to appear — it is what the person is deciding about —
so it appears on its own labelled line, with its invisible characters removed and spelled out
beside it. `Archive` and `Archive<U+200B>` are the same pixels; a dialog that renders the second
one verbatim asks about the folder the reader recognises and acts on the one they do not.

### What a confirmation binds

An approval here binds an answer to **this question** — the sealed state carries the resource key,
the operation plus a fingerprint of the exact target set, and the library verifies both — and,
since mcp-approval 0.8.1, to **this moment**: the state carries a nonce that is spent on the first
answer, accepted or declined, so the same sealed state presented again is refused rather than
honoured. Both revisions of the protocol reach that code. `src/index.ts` serves through
`serveStdio`, which negotiates `2025-11-25` or `2026-07-28` per connection; on the older revision
the question never leaves the process, on the newer one it travels through the client as a return
value and comes back with the answer, and the nonce is what makes the second trip worthless.

An earlier version of this section said the newer revision was not reachable, because the server
then used a `StdioServerTransport` pinned to 2025. That stopped being true in 0.3.0, and the
sentence outlived the code by two releases — which is why this file is now read against `src/`
claim by claim in every review.

What is left, stated honestly: the record of spent nonces is per process. A restart forgets it, so
a sealed answer captured before a restart and presented within its lifetime afterwards is accepted
once more. The two-call token — the fallback for clients that cannot show a dialog — is single-use
and spent by `consume`, with the same per-process caveat.

### Where a confirmation is not asked

`get_attachments` with `mode: "file"` writes bytes a stranger sent onto the operator's disk without
a dialog. The tool is registered under `IMAP_READ_ONLY`, annotated `destructiveHint: true` whenever
`IMAP_DOWNLOAD_DIR` is set, and guarded by everything below — allowlist, extension refusal,
magic-byte check, `wx` and mode `0600`, a directory that only the operator names and that has to
exist before the server starts. It is not guarded by a person saying yes. That is a known gap,
kept on purpose for now: the directory is the operator's opt-in, and the file cannot run, overwrite
or escape. Whether that is enough is a judgement, and it is written here so it is judged rather
than assumed.

## Configuration

Every variable this server reads sits within a few lines of `IMAP_PASSWORD` in every compose file,
and the value that fails a shape check is the one most likely to be the password pasted onto the
wrong line. So a refusal describes the value by its length and never quotes it — `ELICITATION` used
to print `got "…"` — and every value that is later answered to a client has a shape it must fit
first: `IMAP_DOWNLOAD_DIR` must name an existing directory and is stored as its real path;
`IMAP_ATTACHMENT_TYPES` entries must be media types; `IMAP_MAILBOX` and `IMAP_DRAFTS_MAILBOX`
follow the mailbox parameter's rule; `IMAP_HOST` and `IMAP_TRUSTED_AUTHSERV_ID` are bounded to a
hostname; `IMAP_USER` is one line; `IMAP_SEEN_KEYWORD` is an atom of at most 64 characters.

A refused connection is answered from memory for ten seconds. Every tool call opens the connection
lazily, a failed one is not kept, and "check IMAP_USER and IMAP_PASSWORD" is precisely the answer a
model retries — so before this, one wrong password and a diligent model were enough to have a
provider lock the account. The remembered refusal says so, and says when the next real attempt is
possible.

`list_mailboxes` on a server without LIST-STATUS fetches counters for at most 100 folders within a
20-second budget and lists the rest without them, counted in the answer. imapflow's own fallback is
one STATUS per folder with no ceiling, and the command timeout around the call does not stop the
commands: they run to the end of the list on the same connection, and every later call waits.

## Attachments

Attachments pass a declaration check — content-type allowlist, executable-extension refusal,
size ceiling — and then a magic-byte check on the bytes themselves. The second one is the one
that cannot be lied to: a Windows executable renamed `invoice.pdf` and declared
`application/pdf` clears every other gate and fails there. The same applies when writing to
disk, where a disguised binary is more dangerous than in a transcript, not less.

The extension refusal is only as long as the extractor that feeds it. `appref-ms` and `application`
sat in the blocklist while the pattern reading an extension out of a filename accepted neither a
hyphen nor eleven characters, so both read as no extension at all — which makes the check skip
rather than fail. A ClickOnce manifest declared `application/xml` is valid XML by every check that
looks at bytes, so nothing else stopped it. A test now walks the whole blocklist and requires each
entry to be refused, because two declarations that have to agree do not announce when they stop
agreeing.

Writing to disk happens only when `IMAP_DOWNLOAD_DIR` is set. The directory comes solely from
that variable, never from a tool argument; filenames are stripped of separators and directional
overrides; the resolved path is checked against the directory again; and the file is opened with
`wx` and mode `0600`, so an existing file is never overwritten and a symlink planted under a
predictable attachment name is never followed.

Images are returned as images, with a warning. Text rendered inside a picture is still text a
stranger wrote, and no amount of sanitising reaches it — the warning is the only honest answer.

### Parsing a document

`mode: "text"` reads the text of a PDF, Office or OpenDocument attachment. It is the third
thing that happens to an attachment here, and unlike the other two it _parses_ the bytes: a
bundled PDF.js and a ZIP reader, both fed by a stranger. That is a genuinely new attack
surface for this server, and the answer is containment rather than trust.

**Where it runs.** A child process of its own, with a V8 heap limit, a twenty-second timeout,
and an unconditional `SIGKILL` in a `finally`. A process rather than a worker thread, and that
was measured rather than chosen: a worker's `resourceLimits` promise to turn a runaway parse
into `ERR_WORKER_OUT_OF_MEMORY`, and for the allocation pattern a three-kilobyte spreadsheet
produced they did not — the whole server died with `FATAL ERROR: Reached heap limit`. A thread
also cannot give back what a terminated parse left behind; a gigabyte stayed resident after
`terminate()`. A killed process takes its memory with it, and a process that aborts aborts
alone: the server answers "out of memory" and carries on. Without the timeout a parse that
spins is a server that stops answering with nothing in the log. One extraction runs at a time,
because a per-call memory ceiling that multiplies by a number the caller chooses is not a
ceiling, and past eight requests in flight the ninth is refused rather than queued behind seven
timeouts.

**The heap limit is best effort, and the guards that matter sit in front of it.** It bounds a
pathological object graph; it does not bound a typed array, which is external memory, and both
parsers produce those. The ceilings below — on what a ZIP entry may inflate to, on what a PDF
stream may decode to, and on the characters the child may build for any format — are what
bound memory. The process boundary is what bounds the damage if one of them is wrong.

**Its stdout is discarded.** The transport is stdio JSON-RPC and PDF.js logs. One line from
inside the parser reaching the parent's stdout would corrupt the framing and hang the session,
so the child is started without one. PDF.js is also run at `verbosity: 0`; one guard is not a
guard. Its flags are stated rather than inherited, because a flag the parent was started with
and a child cannot take would turn every extraction into a silent failure.

**What crosses back is a code, never a message.** PDF.js and fflate quote the document in their
exceptions — byte offsets, object fragments, what they found where they expected something
else. An error message is read in the server's own voice, outside the fence every other piece
of message content passes through, so the child returns a reason code and the sentences are
written here. The code — never the message — also goes to stderr, so an extraction that fails
for a reason nobody anticipated leaves one line an operator can act on.

**PDF.js runs with `isEvalSupported: false`**, which gates its construction of `Function`
objects from font and calculator programs taken from the document — the primitive that turned a
parser bug into remote code execution in CVE-2024-4367. `enableXfa`, `useSystemFonts` and font
faces are off for the same reason. Four calls are used — `getDocument`, `getPage`,
`getTextContent`, `destroy` — and that is enforced by nothing but this paragraph and the
comment beside them: `getJSActions` surfaces the document's own JavaScript, `getAttachments`
returns embedded files, which is how a PDF can carry an executable past a magic-byte check that
only ever looks at the outer `%PDF`. The page loop is sequential and capped, because the page
count is a number the sender wrote.

**PDF streams are measured before PDF.js inflates them.** PDF.js decodes a stream into memory
in full, that memory is a typed array no heap limit sees, and Deflate reaches a thousand to one
on repetitive input — so a 3.4 MB attachment whose one content stream inflates to a gigabyte
took the process to 2.1 GB resident within a second, and the timeout only decided when that
stopped growing. A linear pass over the file now decodes every Flate, LZW and RunLength stream
(behind an ASCIIHex or ASCII85 wrapper or not) only as far as a ceiling — 32 MB for one
stream, 128 MB for all of them — and refuses the document as "too large" the moment one
crosses it. The work that costs is bounded by the ceiling, whatever the file holds. Streams are
delimited the way PDF.js delimits them, by a `/Length` that lands on `endstream` and by the
keyword otherwise, so a sender cannot end the measurement early by writing the keyword inside
their own compressed bytes. Image codecs are not measured, because text extraction never
decodes them either.

**The ZIP reader decides before it allocates.** `unzipSync` sizes an entry's output buffer from
the _declared_ uncompressed size in the central directory, checked against nothing, so the
filter callback — the last point before that allocation — carries every guard: a fixed
allowlist of entry names, a count of the entries that allowlist admits, a per-entry and a
cumulative size ceiling, and a refusal of anything but stored and deflate. Nothing outside the
allowlist is ever decompressed, which is also why a nested archive is not descended into, an
entry called `__proto__` is never used as a key, and six hundred embedded pictures are neither
read nor counted against a report. Measured on fflate 0.8.3: a declared size below the real one
truncates rather than grows, so lying in either direction buys nothing.

**Spreadsheets are budgeted per row, and every cell is capped.** A shared string is stored once
and referenced by index, so one long string behind a grid of cells is a kilobyte of archive
standing for gigabytes of output; a repeated cell in an OpenDocument sheet is the same trick in
a different syntax. The character budget is charged row by row and stops the walk, no cell may
exceed four kilobytes, and nothing larger than the character ceiling is ever built in the
child — the contract "the child returns at most a million characters" holds for every format,
not most of them.

**There is no XML parser, and that is the defence.** A real one resolves entities, which would
hand a mail attachment billion-laughs expansion and an `<!ENTITY … SYSTEM "file:///etc/passwd">`
that reads a file. The markup walk builds no entity table and resolves no system identifier, so
those are not defended against — they are not implemented, and `&lol9;` comes back as six
literal characters. The walk itself is the one already used for HTML mail: a single forward-only
pass with a global closing-tag budget. The obvious alternative, `/<w:t[^>]*>([\s\S]*?)<\/w:t>/g`,
is the exact shape of the 33-second denial of service recorded above.

**Nothing in the path reaches the network or the filesystem.** The document is passed as bytes,
never as a URL, so PDF.js never constructs its network stream; the standard-font and CMap URLs
it would otherwise fetch stay unset, because `pdfjs-dist` is not resolvable in this tree.
Pointing them at a CDN is the most-suggested workaround online for the resulting font warnings
and would give this server its first outbound HTTP client. The known cost is stated instead: a
PDF needing a predefined CJK CMap does not extract.

**Extracted text is fenced like a message body**, and carries one thing a body does not need.
Extraction returns every text-drawing instruction in the file — including text set below one
point, hanging off the page, or drawn in the colour of the paper — and returns nothing that was
drawn as a picture. The set the model reads and the set the user sees are different sets, in
both directions. Fill colour is not exposed by the text API at all, and text render mode 3 is
how every OCR'd scan stores its text layer, so filtering is not available; the count of runs
placed where a reader cannot see them is reported as a signal, and the result states plainly
above the fence that "the document says X" is not a claim the user can check.

**One supply-chain consequence, stated rather than discovered.** `unpdf` vendors PDF.js into its
own published bundle, so `pdfjs-dist` does not appear in this package's dependency tree — and
`npm audit`, Dependabot and the Trivy job all resolve the tree. **A PDF.js advisory does not raise
an alert on this repository.** Watching PDF.js releases is manual, and an `unpdf` version bump is a
security bump.

That happened. **CVE-2026-16633** (GHSA-hq66-cqwq-w95j, high): PDF.js from 5.6.83 before 6.2.108
executes attacker-controlled JavaScript on opening a malicious PDF when `enableScripting` is on,
which it is by default. unpdf 1.8.1 — the current release — bundles PDF.js 6.1.200, inside that
range, and no scanner said so. The vulnerable path is the annotation layer: it binds a form field's
JavaScript actions to DOM events and dispatches them into the viewer's sandbox, gated by
`enableScripting` and `hasJSActions`. This server renders no annotation layer, no form and no DOM;
it calls the five functions named above and nothing else, and `test/review.test.ts` now holds
`src/extract/pdf.ts` to that set — no `getAnnotations`, `getJSActions`, `AnnotationLayer`,
`enableScripting` or `render`. The same test pins the bundled PDF.js version, so the next unpdf
release fails it and this paragraph is revisited rather than outlived. Until unpdf moves to
6.2.108 or later, the reasoning above is the whole defence, and it is written down so it can be
checked.
