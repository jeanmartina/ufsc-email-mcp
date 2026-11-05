/**
 * The annotation block every purely reading tool of this server carries, and
 * the rule the others follow.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification says `destructiveHint` and `openWorldHint` both
 * default to **true**, so an omitted field is the *stronger* claim. A tool that
 * says nothing is a destructive tool in an open world.
 *
 * The line this family draws for `destructiveHint`:
 *
 *   **Content that a person wrote, replaced with no way back — destructive.**
 *   **A setting, a state or a marker, changed — not destructive.**
 *
 * A mail flag is a marker and comes back off, which is why `set_message_flags`
 * is not destructive here — and why freshrss-mcp answers the opposite for
 * `mark_articles`. Same shape of operation, different backing store: FreshRSS
 * keeps no record of what was unread, IMAP does.
 *
 * Two tools deliberately do not use this constant, and both are documented at
 * their own annotation: `list_new_messages` writes a flag, and
 * `get_attachments` is only read-only while there is nowhere to write.
 *
 * `openWorldHint: false`: this server talks to the one IMAP account it is
 * configured for.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
