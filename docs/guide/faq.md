# FAQ & troubleshooting

<!-- Keep this entry. "A tool is missing" is the one question the tool filter
     creates, and the answer people reach for first — a bug — is the wrong one. -->

## One tool I expected is missing

Something narrowed the list. In order of likelihood:

- `IMAP_READ_ONLY` is set, and it is a write tool.
- `IMAP_ALLOW_TOOLS` is set and does not name it — it is an allow list, so
  anything not named is out.
- `IMAP_DENY_TOOLS` names it, possibly through a prefix such as `delete_*`.

A filtered tool is not registered at all, so it is missing from `tools/list` and
answers `tools/call` with "tool not found" — the same as a write tool under
read-only. There is no state where it is hidden but still callable.

What it is _not_ is a typo in one of those variables: an entry that matches no tool
stops the server at startup and says which entry it was. See
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).
