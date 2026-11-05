# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/imap-mcp.git && cd imap-mcp
npm install
npm test          # 400+ tests against an in-memory IMAP fake, no network
npm run build
```

## Running the integration suite

The unit tests drive an in-memory fake, so they establish that this server
handles the IMAP responses its author expected. The integration suite spawns
the built server over stdio against a throwaway
[GreenMail](https://greenmail-mail-test.github.io/greenmail/) and calls **every
tool in the catalogue** — so what the read tools parse is an actual RFC 5322
message with actual MIME parts, and the write tools talk to a server with its
own opinions about flags, expunging and mailbox names.

```sh
npm run build     # the suite runs dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d
npm run test:integration
docker compose -f test/integration/compose.yml down
```

`down` rather than `down -v`: GreenMail keeps everything in memory and has no
volume, so stopping the container is the whole reset. That is also why the
suite needs a fresh one — it deletes and expunges.

Three things about GreenMail that are not obvious and each cost a session:

- **`-Dgreenmail.hostname=0.0.0.0` is required.** By default every listener
  binds `127.0.0.1` _inside the container_, so the published port reaches
  nothing and every tool eventually fails with "Unexpected close" after a
  connection timeout — which reads like a bug in the IMAP client. Binding
  `0.0.0.0` inside a container namespace is not exposure; the `ports` list is
  what decides who can reach it, and it says `127.0.0.1`.
- **There is no seeding and no import.** The only way to put a message into
  GreenMail is to deliver one over SMTP, which is why the compose file
  publishes 3025 as well and why `bootstrap.ts` speaks a short SMTP dialogue.
  It is also the better fixture: the messages arrived the way real ones do.
- **The account is created at startup by `-Dgreenmail.users` and cannot be
  added afterwards**, so the credentials live in `compose.yml`.

Never point a development run at a mailbox you care about. `IMAP_READ_ONLY`
defaults to `true`, but the whole point of testing the write tools is turning
that off — and the harness refuses any backend that is not on this machine.

For poking at one tool by hand, the inspector against the same stack:

```sh
docker compose -f test/integration/compose.yml up -d
IMAP_HOST=127.0.0.1 IMAP_PORT=3143 IMAP_TLS=none \
IMAP_USER=integration IMAP_PASSWORD=integration-not-a-secret \
npx @modelcontextprotocol/inspector node dist/index.js
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the full suite on Node 22 and 24, plus `npm audit`,
  CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, the untrusted-content
  fencing, attachment gates, anything that builds an IMAP command or a mail header):
  please describe the attack you are defending against, or the one your change might
  open, in the PR text.
- **The server must not gain the ability to send mail.** That absence is the security
  argument this project rests on; a patch adding SMTP will be declined regardless of how
  it is written. `save_draft` writing into the Drafts folder is the supported shape.
- **Mail is untrusted input.** Anything that puts message content into a tool result has
  to keep it inside the nonce fencing, and anything that puts message content into text a
  model treats as instruction — a confirmation prompt, an error message — is a bug.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- **`unpdf` bumps are security bumps.** It vendors PDF.js into its own published bundle,
  so `pdfjs-dist` is not in this package's dependency tree — and `npm audit`, Dependabot
  and Trivy all resolve the tree. A PDF.js advisory raises no alert here. Watch
  [PDF.js releases](https://github.com/mozilla/pdf.js/releases) and treat an `unpdf`
  update as one, not as a routine minor.
- **`src/extract/child.ts` and everything it reaches may not use relative value
  imports.** The child is started from its own source file — `.ts` under vitest, `.js`
  from `dist/` — so Node loads it directly, and Node's type stripping does not rewrite a
  `./x.js` specifier to the `.ts` beside it. `import type` is erased and is fine; a value
  import is not. Getting this wrong in one direction fails every test, and in the other
  it passes every test and ships a broken package, so `npm run build` is followed by a
  real extraction against `dist/`.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/imap-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/imap-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/imap-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
