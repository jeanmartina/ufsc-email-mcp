# Tools

Twelve tools: six read, six write. The write tools are **not registered** unless
`IMAP_READ_ONLY=false` — and it defaults to `true`, so an unconfigured server offers
the six read tools alone.

Beyond that, `IMAP_ALLOW_TOOLS` and `IMAP_DENY_TOOLS` narrow the list further, and
`IMAP_ALLOW_TOOLS=essential` selects the six marked **essential** below — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

## Read tools

Registered always.

| Tool                | Description                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `list_mailboxes`    | The folder tree, with the special-use flags the server reports (`\Drafts`, `\Sent`, …). **essential**     |
| `list_new_messages` | What the assistant has not seen yet, tracked with its own IMAP keyword rather than `\Seen`. **essential** |
| `list_messages`     | Search and list a mailbox: by sender, subject, date range, flags. **essential**                           |
| `get_message`       | One message, body fenced as untrusted content. **essential**                                             |
| `get_attachments`   | Attachment metadata, small ones inline, and the text of a PDF or Office file with `mode: "text"`         |
| `get_server_info`   | Capabilities, the mailbox in use, and whether the write tools are registered                             |

## Write tools

Registered only when `IMAP_READ_ONLY=false`.

| Tool                   | Description                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `set_message_flags`    | Set or clear flags and keywords — read, flagged, and the assistant's own. **essential**  |
| `mark_messages_read`   | Mark messages as read (\Seen) or unread by UID with server verification.                 |
| `move_messages` 👤     | Move or copy messages between folders. **essential**                                     |
| `delete_messages` 👤   | Delete: sets `\Deleted` and expunges. Not the same as moving to Trash                    |
| `save_draft`           | Append a draft to the drafts folder. This server never **sends** anything                |
| `manage_mailbox` 👤    | Create, rename and delete folders — 👤 for `delete`, 🔒 for `rename`, nothing for `create` |

👤 **asks a person** through MCP elicitation, a dialog the model cannot answer on its
behalf. 🔒 uses the two-call `confirm_token` only. Where a 👤 tool's client cannot show
a dialog it falls back to 🔒, and `ELICITATION=false` takes that fallback deliberately.
See [Asking a person](/guide/approval).

Every tool declares an `outputSchema` and answers with `structuredContent` beside
the text block, so a client can use a result without parsing prose. Every tool
that reports anything out of the mailbox carries `untrusted: true` and
`source: "imap"` as fields — only `get_server_info` and the six write tools are
without it. `get_message` and a text attachment keep the nonce fence in the text
block and state the same fields in the structured half; an image attachment
keeps its bytes in the content block rather than repeating the base64.

Every tool declares all four MCP annotations — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`. `get_attachments` carries the only *computed* one in
the family: it is `readOnlyHint: true` until `IMAP_DOWNLOAD_DIR` is set, because from
then on it writes files.

## Reading a document

`get_attachments` takes a `mode`. `auto` reads small text and images inline, saves to
disk where `IMAP_DOWNLOAD_DIR` is set, and otherwise extracts the text of a PDF, Word,
Excel, PowerPoint or OpenDocument file. `inline` always returns the content, `file`
always saves it, and `text` always extracts.

`mode: "text"` is the only way to read a document from a client that cannot reach this
server's filesystem — which is every remote one. It returns the text fenced as untrusted
content, with `offset` and `max_chars` to page through anything longer than one result
can hold; the answer carries `next_offset`, `total_chars` and `returned_chars`, and the
notes spell out the exact follow-up call. The listing marks each part `extractable`, so
the choice can be made before anything is fetched.

Spreadsheets come back as tab-separated values with a `== Sheet: name ==` heading per
tab; presentations get a heading per slide.

There is no OCR. A scanned PDF has no text layer, and the refusal says so and names the
two ways to get the bytes instead — rather than returning an empty string that reads
like an empty document.

## Resources, which the filter does not cover

Attachments are also exposed as MCP **resources**. `IMAP_ALLOW_TOOLS` narrows
`tools/list`, not `resources/list`, so a filtered server still serves those.
`IMAP_DOWNLOAD_DIR` and the attachment type allowlist are what constrain them. Note that
resources carry the raw bytes: the text extraction above is on the tool only, because
extracted text is the sender's text and belongs inside the nonce fence, which a resource
has nowhere to put.
