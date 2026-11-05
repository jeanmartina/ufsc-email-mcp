# Configuration

See the [environment variable reference](/reference/environment) for the full table.

## Connecting

Three variables are required — the host, the user and the password:

```sh
IMAP_HOST=imap.example.net
IMAP_USER=me@example.net
IMAP_PASSWORD=…
```

Where the provider offers **app passwords**, use one. It is scoped to this server
and can be revoked without changing the account password, which matters more than
usual here: a mailbox password is often the account password.

`IMAP_PASSWORD` is deleted from `process.env` as soon as it has been read, so it is
not visible to child processes or in `/proc/<pid>/environ`.

## TLS

`IMAP_TLS` is `implicit` by default, which is port 993 and TLS from the first byte.
`starttls` upgrades a plaintext connection on port 143, and `none` does not encrypt
at all — the server warns loudly about that against anything but a loopback host,
because the password and every message would cross the network in the clear.

`IMAP_INSECURE_TLS=true` accepts a self-signed certificate. It is scoped to this
connection, not `NODE_TLS_REJECT_UNAUTHORIZED`, so validation stays on for
everything else in the process. Prefer adding the CA to the trust store.

## Read-only, and why it is the default

```sh
IMAP_READ_ONLY=false   # registers the five mailbox write tools
```

**It defaults to `true`**, unlike every other server in this family. That is not an
oversight: this variable replaced `IMAP_ALLOW_WRITE`, which was opt-in, and a rename
that quietly flipped the default would have handed write access to every
installation that upgraded without reading the changelog. Only the literal string
`false` turns it off.

An installation that still sets `IMAP_ALLOW_WRITE` **refuses to start**, with a
message naming the replacement. Ignoring it would leave someone believing a
protection is in force when it is not.

<!-- The heading below is fixed: every repository uses "Choosing the tools that
     load", so /guide/configuration#choosing-the-tools-that-load is the same anchor
     everywhere and the README, the FAQ and the tool reference can all link to it.
     Put it directly after the read-only section — they are the same knob family,
     and that adjacency does half the explaining. -->

## Turning the approval dialog off

`delete_messages`, `move_messages` and deleting a folder ask a person through MCP
elicitation before they act. `ELICITATION=false` takes them to the two-call token
instead. It does not remove the guard; there is no setting in which a guarded
call goes unannounced.

The variable deliberately carries no `IMAP_` prefix, which means it reaches every
MCP server in the same environment, and — like `IMAP_TLS`, unlike
`IMAP_READ_ONLY` — a value it does not recognise **stops the server**. See
[Asking a person](/guide/approval).

## Reading documents

Nothing needs to be configured for it: `get_attachments` with `mode: "text"` reads
the text out of a PDF, Word, Excel, PowerPoint or OpenDocument attachment.

It is worth knowing which of the three size limits applies, because they are
separate on purpose. `IMAP_MAX_ATTACHMENT_BYTES` (1 MB) bounds what may come back
inline, `IMAP_MAX_DOWNLOAD_BYTES` (25 MB) bounds what may be written to disk, and
`IMAP_MAX_EXTRACT_BYTES` (10 MB, maximum 64 MB) bounds what is handed to the
parser. Raising one is not a request to raise the others, and the last has a hard
ceiling — a value above it stops the server rather than being quietly clamped.

If you run this server in a container or on another machine, prefer `mode: "text"`
over `IMAP_DOWNLOAD_DIR`. A download directory is a path on the machine the server
runs on; a client somewhere else gets that path back and can do nothing with it.

## Choosing the tools that load

Read-only mode is one cut, along a line this server drew for you — and by default
it has already been made. `IMAP_ALLOW_TOOLS` and `IMAP_DENY_TOOLS` let you draw your
own, on either side of it:

```sh
IMAP_ALLOW_TOOLS=essential
IMAP_ALLOW_TOOLS=list_new_messages,get_message,move_messages
IMAP_DENY_TOOLS=delete_messages
```

One boundary the list cannot draw: `move_messages` copies as well as moves (`mode: "copy"`),
and the two are one tool. Denying `move_messages` removes both; there is no way to keep moving
and forbid copying, or the other way round. Both modes ask for confirmation.

Why bother, when all of them work: a model chooses the right tool far more reliably
from a handful than from a long list, and every tool it can see costs context on
every single request. If this is the only MCP server in a session, the full set is
fine. If it is one of six, it is not.

**The syntax.** Comma-separated entries. An entry is either an exact tool name or a
prefix with a trailing `*` — `list_*` matches every tool whose name starts with
`list_`. Entries are trimmed and case-insensitive, empty ones are ignored, and an
empty value counts as unset. Nothing else is a pattern: `*_thing` and `list_*_x` are
rejected rather than silently matching nothing.

**`essential`** is a curated preset: `list_mailboxes`, `list_new_messages`, `list_messages`, `get_message`, `set_message_flags` and `move_messages`. It is marked per tool in the
[tool reference](/reference/tools), generated from the same constant the filter
reads, so the two cannot drift. It composes — naming a tool alongside it puts that
one back, and `IMAP_DENY_TOOLS` takes one away.

**Both together.** `IMAP_ALLOW_TOOLS` decides what is in;
`IMAP_DENY_TOOLS` is then subtracted from the result. With only a deny
list, everything else stays.

**A name that matches nothing stops the server**, with the offending entry and the
list of real names. That is deliberate: the alternative is a tool quietly missing
from `tools/list`, and nobody traces an absence back to an environment variable. The
same applies to a pattern that matches no tool.

**With read-only mode**, the write tools are not registered at all, so naming one
explicitly in `IMAP_ALLOW_TOOLS` is an error that says so — rather than
calling a tool unknown when it plainly exists. A _pattern_ that covers write tools is
fine and simply contributes nothing, which is what makes `get_*,move_*` a usable
template for both kinds of deployment. `IMAP_ALLOW_TOOLS=essential` narrows to the
read half of the preset — four of its six tools — which is why it stays a working
combination on a server that is read-only unless told otherwise.

::: tip It is the same cut, not a second one
A filtered tool is never registered, so it is absent from `tools/list` and unknown to
`tools/call` alike — exactly what `IMAP_READ_ONLY` does to a write tool.
There is no "hidden but callable" state to reason about.
:::

## What the filter does not cover

Tools. This server also registers **attachment resources**, and `IMAP_ALLOW_TOOLS`
does not touch those — it narrows `tools/list`, not `resources/list`. Worth knowing
before you conclude that a filtered install reaches less of the mailbox than it does.
