# Environment variables

All configuration is by environment variable; there is no config file.

| Variable            | Required | Default    | Description                                                                   |
| ------------------- | -------- | ---------- | ----------------------------------------------------------------------------- |
| `IMAP_HOST`         | yes      | —          | Hostname of the IMAP server, e.g. `imap.example.net`                          |
| `IMAP_USER`         | yes      | —          | Mailbox user name                                                             |
| `IMAP_PASSWORD`     | yes      | —          | Mailbox password, or an app password where the provider offers one            |
| `IMAP_PORT`         | no       | 993 or 143 | 993 with implicit TLS, 143 otherwise                                          |
| `IMAP_TLS`          | no       | `implicit` | `implicit`, `starttls` or `none`                                              |
| `IMAP_MAILBOX`      | no       | `INBOX`    | The mailbox the tools work in unless one is named                             |
| `IMAP_SEEN_KEYWORD` | no       | `AiSeen`   | IMAP keyword marking what the assistant has already seen                      |
| `IMAP_READ_ONLY`    | no       | **`true`** | `false` registers the mailbox write tools. Note the default                   |
| `IMAP_ALLOW_TOOLS`  | no       | —          | Tool names, `list_*` prefixes or `essential`; only these register             |
| `IMAP_DENY_TOOLS`   | no       | —          | Same syntax; subtracted from whatever the allow list left                     |
| `IMAP_DOWNLOAD_DIR` | no       | —          | Where attachments may be written. Unset means the filesystem is never touched |
| `IMAP_INSECURE_TLS` | no       | `false`    | `true` accepts self-signed certificates, scoped to this connection            |
| `IMAP_TRUSTED_AUTHSERV_ID` | no | —      | The authserv-id your provider stamps; without it every verdict is forgeable   |
| `ELICITATION`       | no       | `true`     | `false` replaces the approval dialog with the two-call token. **Not prefixed** |

There are also `IMAP_MAX_MESSAGES`, `IMAP_MAX_ATTACHMENT_BYTES`,
`IMAP_MAX_DOWNLOAD_BYTES`, `IMAP_MAX_EXTRACT_BYTES` and `IMAP_DRAFTS_MAILBOX` for the
limits and the drafts folder; the defaults are 100 messages, 1 MB inline, 25 MB to
disk, 10 MB into the text extractor, and whichever folder the server flags as
`\Drafts`.

The three size limits are separate because they answer three different questions.
`IMAP_MAX_ATTACHMENT_BYTES` bounds what may enter the model's context;
`IMAP_MAX_DOWNLOAD_BYTES` bounds what may be written to your disk;
`IMAP_MAX_EXTRACT_BYTES` bounds how much input one parser is handed, which is a
memory question and neither of the other two. Raising one is not a request to raise
the others. `IMAP_MAX_EXTRACT_BYTES` is the one with a hard ceiling — 64 MB — and a
value above it refuses to start rather than being clamped: the other two buy a big
answer, this one buys a buffer inside a parser working on bytes a stranger chose, so
a typo there would leave you believing there is a limit.

## `IMAP_TRUSTED_AUTHSERV_ID` and the `forgeable` flag

`get_message` reports the SPF, DKIM and DMARC verdicts from the message's
`Authentication-Results` header, together with a `forgeable` flag. By default that
flag is always `true`, and that is not a bug.

Anyone can put an `Authentication-Results` header in a message they send. Your
provider normally adds its own and prepends it, so reading only the topmost header
ignores a forged copy underneath — but if your provider adds none at all, which is
common on small Postfix/Dovecot setups and on any mailbox where filtering happens
somewhere else, the sender's header is the topmost one. Nothing inside the message
tells the two apart.

Set this to the id your provider stamps and only that id is treated as authentic:

```sh
IMAP_TRUSTED_AUTHSERV_ID=mx.example.net
```

It is the first token of the header, before the first semicolon. Open any message you
already trust and read it off. The comparison is case-insensitive and exact — a
subdomain of the configured id does not match, because `evil.mx.example.net` is a
different host and a sender can choose it.

::: tip Why not guess it
An earlier version compared the authserv-id against your own account's domain and
called a match authentic. A sender knows your domain — they just addressed mail to
you — so `Authentication-Results: mail.yourdomain.example; spf=pass; dkim=pass` was
enough to have this server vouch for a spoofed message. The heuristic gave its
strongest answer in exactly the case it could not verify.
:::

## `ELICITATION`

Whether a client that *can* show a dialog is asked before `delete_messages`,
`move_messages` or deleting a folder acts. Default `true`. `false` takes the
two-call-token path instead — it does not remove the guard, and a server started
with it off prints one line saying so.

Two ways it differs from every other variable here:

- **No prefix.** One `export ELICITATION=false` reaches every MCP server in the
  same environment, not just this one. That is the point of it and also its risk;
  see [Asking a person](/guide/approval).
- **Fatal on anything else.** Like `IMAP_TLS`, and unlike `IMAP_READ_ONLY`: `1`,
  `off` or a typo stop the server with exit code 1. It is the only variable of
  this family that defaults to *on*, and a typo that fell back would leave the
  dialog running while you believed it was off.

Values are trimmed and matched case-insensitively. It is read *after*
`IMAP_PASSWORD` is deleted from `process.env`, so the fatal path cannot leave the
password sitting there for a crash reporter.

## `IMAP_READ_ONLY` defaults to `true`

This is the one place this server differs from the rest of the family, and it is
deliberate. Everywhere else `<PREFIX>_READ_ONLY` defaults to `false` and you switch
it on. Here the variable replaced `IMAP_ALLOW_WRITE`, which was **opt-in** — setting
nothing meant no write access to a mailbox. Renaming it without keeping that default
would have handed write access to every installation that upgraded without reading
the changelog.

Only the literal string `false` turns it off. `False`, `0` and `no` all leave the
write tools unregistered, so a typo fails closed.

::: danger IMAP_ALLOW_WRITE is gone
An installation that still sets it **will not start**. Silently ignoring a removed
security variable is worse than refusing: whoever set it once believes it is still in
force. Set `IMAP_READ_ONLY=false` instead, or unset it and keep the read-only default.
:::

## Narrowing the tool list

`IMAP_ALLOW_TOOLS` and `IMAP_DENY_TOOLS` are comma-separated. Each entry is either an
exact tool name or a prefix with a single trailing `*`:

| Value                           | Registers                                                         |
| ------------------------------- | ----------------------------------------------------------------- |
| `essential`                     | the curated six, marked in the [tool reference](/reference/tools) |
| `list_new_messages,get_message` | exactly those two                                                 |
| `list_*`                        | `list_mailboxes`, `list_messages`, `list_new_messages`            |
| `essential,get_attachments`     | the preset plus one more                                          |
| `*`                             | everything — the same as leaving it unset                         |

Entries are trimmed and matched case-insensitively; empty entries are ignored, and a
value that is empty or only whitespace counts as unset — `IMAP_ALLOW_TOOLS=` in a
compose file does not mean "allow nothing". `essential` is recognised only in the
allow list.

**An entry that matches no tool aborts startup**, naming the entry and listing the
valid names, as does a malformed pattern such as `*_messages` or `list_*_x`. The
alternative — ignoring the entry — leaves a tool missing from `tools/list` with
nothing pointing at the cause. If both lists together remove everything, the server
refuses to start rather than offering an empty tool list.

Under the read-only default, an exact write-tool name in the allow list is an error
naming `IMAP_READ_ONLY` rather than "unknown tool" — which matters more here than
elsewhere, because read-only is the default rather than something you remember
switching on. A pattern covering write tools is accepted and merely contributes
nothing, with a warning on stderr. Deny entries are exempt: denying an
already-suppressed tool is how a defensive list is written.

## What the filter does not cover

Tools. This server also exposes **attachment resources**, and those are not filtered:
`IMAP_ALLOW_TOOLS` narrows `tools/list`, not `resources/list`. `IMAP_DOWNLOAD_DIR`
and the attachment type allowlist are what constrain those.

## Credentials in the environment

`IMAP_PASSWORD` is read once and then deleted from `process.env`, so it is not visible
to child processes or in `/proc/<pid>/environ`, and a later crash report cannot carry
it.
