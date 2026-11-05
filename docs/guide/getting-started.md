# Getting started

## Requirements

- Node.js ≥ 22
- An IMAP mailbox, and credentials for it. Where the provider offers **app
  passwords**, use one: it is scoped to this server and revocable on its own.

## Run it

```sh
IMAP_HOST=imap.example.net IMAP_USER=me@example.net IMAP_PASSWORD=… \
  npx -y @ni-c/imap-mcp
```

That is a **read-only** server: `IMAP_READ_ONLY` defaults to `true`, so the five
mailbox write tools are not registered at all. Add `IMAP_READ_ONLY=false` when you
want them — see [Configuration](/guide/configuration#read-only-and-why-it-is-the-default).

Without credentials the server still starts and lists its tools, so registries and
inspectors can introspect it; every call then fails with setup instructions instead
of reaching the mailbox.

## The first question worth asking

```
Anything new in my mail?
```

`list_new_messages` answers it with its own IMAP keyword rather than the `\Seen`
flag, so it does not depend on whether you have read the mail yourself — and
reading it here does not mark it read in your own client.
