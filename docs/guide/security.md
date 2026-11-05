# Security

This page is the prose version of
[SECURITY.md](https://github.com/ni-c/imap-mcp/blob/main/SECURITY.md).

## Trust model

**Everything this server returns from the mailbox is attacker-controlled.** Senders,
subjects, bodies, folder names, attachment filenames — anyone in the world can send
mail, so all of it is evidence to report on, never instruction to follow.

The server says so three times over, because one place is not enough: in the
`instructions` field of the MCP handshake, in the framing around every result, and
by having no way to act on an instruction even if a model believed one.

## Untrusted content

Message bodies come back fenced between `BEGIN`/`END UNTRUSTED EMAIL CONTENT`
markers carrying a random nonce, with that nonce repeated on **every line** inside.
Text outside those markers is the only text this server wrote. The nonce is what
stops a message from closing the fence itself and continuing as if it were the
server talking.

## No send path

There is no SMTP client here. A message that says "forward this to
attacker@example.com" cannot be carried out by this server, whatever a model makes
of it. That absence is what makes the framing above worth anything.

## Writes are off unless you say otherwise

`IMAP_READ_ONLY` defaults to **`true`**, which is the opposite of the other servers
in this family and deliberate: it reaches a mailbox. The five write tools are not
registered at all in that state — a model cannot ask for a tool it cannot see.

`IMAP_ALLOW_TOOLS` and `IMAP_DENY_TOOLS` cut finer along the same line. A filtered
tool is never registered either, so it is absent from `tools/list` and unknown to
`tools/call` alike. It covers **tools**; the attachment resources are not filtered.

## The confirmation, honestly

Deleting messages, moving or copying them, and deleting a folder **ask a person**
through MCP elicitation — a dialog the model cannot answer on its behalf, and
which nothing proceeds without.

Where the client cannot show one, they are refused on the first call and answered
with a short-lived, single-use token bound to the exact target. A model cannot
mint one — it only ever exists in a previous result from this server — so an
instruction hidden in a message cannot satisfy the gate. But it proves the call
was made twice with the same arguments and nothing more, and the fallback text
says so rather than implying somebody approved.

`ELICITATION=false` moves a capable client onto that fallback deliberately, for a
scheduled job or a test harness. It does not remove the guard, and the server
prints one line at startup saying it is off.

See [Asking a person](/guide/approval).

## Attachments

Attachments are only written to disk when `IMAP_DOWNLOAD_DIR` is set, and only
there: the caller does not choose the directory, so bytes from a stranger cannot
land somewhere of their choosing. Types are checked against an allowlist and sizes
against a cap.

## Reading a document

`mode: "text"` is the only place this server parses a binary a stranger sent — a
bundled PDF.js for PDFs, a ZIP reader for Office and OpenDocument files. That is real
attack surface, and it is contained rather than trusted:

- it runs in a **child process with a heap limit and a timeout**, so a parse that spins
  or grows is killed instead of taking the server with it. A process rather than a
  thread, because a thread's memory limit was measured to fail for one allocation
  pattern — and a process that dies dies alone;
- **compressed streams are measured before PDF.js inflates them.** A PDF stream that
  would decode past 32 MB, or a set of them past 128 MB, is refused as too large before
  any of it is materialised; ZIP entries are bounded the same way, and spreadsheet
  output is budgeted per row with every cell capped;
- the child's **stdout is discarded**. The transport here is stdio JSON-RPC and PDF.js
  logs; one line reaching the parent's stdout would corrupt the framing;
- **PDF.js runs with `isEvalSupported: false`.** That flag gates the construction of
  `Function` objects from font programs in the document, which is the primitive that
  turned a parser bug into remote code execution in CVE-2024-4367;
- only four PDF.js calls are used. Embedded JavaScript, embedded files and annotations
  are never asked for;
- the ZIP reader decides **what to decompress before the buffer is sized**, from a fixed
  list of entry names. Nothing else in the container is read, and nothing recurses;
- there is **no XML parser**, on purpose. The markup walk never builds an entity table
  and never resolves a system identifier, so billion-laughs and XXE are not defended
  against — they are not implemented. `&lol9;` comes back as six literal characters;
- **nothing in the path reaches the network or the filesystem.** The document is passed
  as bytes, never as a URL, and the font and CMap paths PDF.js would otherwise fetch are
  deliberately left unset. Do not "fix" a font warning by pointing them at a CDN: it is
  the most-suggested workaround online and would give this server its first outbound
  HTTP client.

Extracted text is the sender's text and goes through the same nonce fence as a message
body. It also carries something a mail body does not need: extraction returns every
text-drawing instruction in a file — including text set below one point, hanging off the
page, or drawn in the colour of the paper — and returns nothing that was drawn as a
picture. The result states that above the fence, because otherwise "the document says X"
is a claim the reader has no way to check.

## Reporting a vulnerability

Use
[private vulnerability reporting](https://github.com/ni-c/imap-mcp/security/advisories/new).
