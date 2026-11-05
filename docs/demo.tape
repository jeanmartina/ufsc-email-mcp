# vhs script for the demo GIF: `cd docs && vhs demo.tape` writes public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * the server built: `npm run build` in the repository root
#   * a throwaway IMAP server with the demo mail in it. Never record against a
#     real mailbox — the frames are published:
#
#       docker run -d --name imap-mcp-demo -p 3143:3143 -p 3025:3025 \
#         -e GREENMAIL_OPTS='-Dgreenmail.setup.test.imap -Dgreenmail.setup.test.smtp
#                            -Dgreenmail.hostname=0.0.0.0
#                            -Dgreenmail.users=demo:demo@example.net' \
#         greenmail/standalone:latest
#
#     then seed it with docs/demo-seed.mjs, which sends five invented messages
#     over plain SMTP — four ordinary ones and the phishing attempt this demo is
#     built around:
#
#       node docs/demo-seed.mjs
#
# Rules learned the hard way:
#   * inside Hide blocks use vhs's own `Sleep`, never the shell's — shell sleep
#     blocks and the tape ends before any output is recorded
#   * the MCP Inspector CLI does NOT inherit the environment. Every variable has
#     to be passed with its own `-e` flag or the server starts unconfigured and
#     every call fails with the setup instructions
#   * start from the running server, do not record the setup

Output public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Catppuccin Mocha"
# The default 50ms/char spends most of the recording watching a long command
# appear. The commands here are the point, not the typing of them.
Set TypingSpeed 15ms

Hide
Type "cd .." Enter
# Warm the npx cache, or the first visible call spends its Sleep resolving a
# package instead of showing output.
Type "npx -y @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list > /dev/null 2>&1" Enter
Sleep 25s
Type "alias imap-mcp='npx -y @modelcontextprotocol/inspector --cli node dist/index.js -e IMAP_HOST=127.0.0.1 -e IMAP_PORT=3143 -e IMAP_TLS=none -e IMAP_USER=demo -e IMAP_PASSWORD=demo'" Enter
Type "clear" Enter
Sleep 500ms
Show

Type "# what does it expose, under the read-only default?" Enter
Sleep 1s
Type "imap-mcp --method tools/list | jq -r '.tools[].name'" Enter
Sleep 12s

Type "clear" Enter
Type "# anything new in the inbox?" Enter
Sleep 1s
Type "imap-mcp --method tools/call --tool-name list_messages | jq -r '.content[0].text' | grep -E 'subject|from'" Enter
Sleep 13s

Type "clear" Enter
Type "# one of them is phishing. read it — and watch what the server says first." Enter
Sleep 1s
# head -8, not -32: the assessment JSON and the fenced body push the WARNING off
# the top of an 800px terminal, and the warning coming FIRST is the claim this
# beat is making. The fence gets its own beat below.
Type "imap-mcp --method tools/call --tool-name get_message --tool-arg uid=5 | jq -r '.content[0].text' | head -8" Enter
Sleep 12s

Type "clear" Enter
Type "# and the message body arrives fenced, every line marked as data" Enter
Sleep 1s
Type "imap-mcp --method tools/call --tool-name get_message --tool-arg uid=5 | jq -r '.content[0].text' | sed -n '/BEGIN UNTRUSTED/,/END UNTRUSTED/p' | head -16" Enter
Sleep 14s
