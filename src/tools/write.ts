import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { confirmationPrompt, setResourceKey } from 'mcp-approval';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import { buildCanonicalMoveResourceKey } from '../confirmation-store.js';
import {
  addressListParam,
  confirmTokenParam,
  flagListParam,
  mailboxParam,
  optionalMailboxParam,
  uidListParam,
  uidParam,
} from '../schema.js';

import { escapeInvisible, stripInvisible } from '../analyze.js';
import { audit } from '../audit.js';
import type { Config } from '../config.js';
import { ToolInputError } from '../errors.js';
import { ImapClient, withTimeout } from '../imap.js';
import { buildDraft } from '../draft.js';
import { errorResult, jsonResult, run } from '../result.js';

/**
 * A caller-chosen value as the person deciding should see it.
 *
 * mcp-approval already keeps these off the server's own sentence and onto their
 * own labelled line, which answers a name that reads like an instruction. It
 * cannot answer a name that reads like a *different name*: `Archive` and
 * `Archive<U+200B>` occupy the same space on a screen, so a dialog that renders
 * the second one verbatim asks about the folder the person recognises and then
 * acts on the one they do not. Here the invisible characters are removed from
 * what is shown and spelled out beside it, so the answer is to the question
 * that was actually asked.
 */
function shownValue(raw: string): string {
  const visible = stripInvisible(raw);
  return visible === raw
    ? raw
    : `${visible} — as written: ${escapeInvisible(raw)}`;
}

export function registerWriteTools(
  server: McpServer,
  client: ImapClient,
  config: Config,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'set_message_flags',
    {
      title: 'Add or remove message flags',
      description:
        'Adds or removes IMAP flags and keywords on one or more messages: ' +
        '\\Seen to mark read or unread, \\Flagged to star, \\Answered, \\Draft, ' +
        'or any custom keyword the server accepts. Reversible, so no ' +
        'confirmation is required — which is why \\Deleted cannot be added ' +
        'here; use delete_messages, which asks first. Removing \\Deleted is ' +
        'allowed, since that undoes one. Removing the new-mail keyword makes ' +
        'those messages show up in list_new_messages again.',
      inputSchema: z.object({
        uids: uidListParam,
        mailbox: optionalMailboxParam,
        add: flagListParam.optional().describe('Flags or keywords to set.'),
        remove: flagListParam
          .optional()
          .describe('Flags or keywords to clear.'),
      }),
      annotations: {
        // A flag is a marker and comes back off, so this is not destructive.
        // freshrss-mcp answers the opposite for mark_articles and is right
        // to: FreshRSS keeps no record of what was unread, IMAP does.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        mailbox: z.string(),
        uids: z.array(z.number().int()),
        added: z.array(z.string()),
        removed: z.array(z.string()),
      }),
    },
    async ({ uids, mailbox, add, remove }) =>
      run(async () => {
        if (add === undefined && remove === undefined) {
          throw new ToolInputError(
            'imap-mcp: give at least one of "add" or "remove".'
          );
        }
        // \Deleted is not a flag like the others: it is half of a deletion.
        // This tool has no confirmation and is annotated destructiveHint:false
        // on the grounds that everything it does can be undone — true of \Seen
        // and \Flagged, not of a flag that the next client to close the folder,
        // or any server with autoexpunge, turns into a permanent removal. Left
        // open it is delete_messages without the dialog, reachable in one call
        // and present in the `essential` preset.
        if (add?.some((flag) => flag.toLowerCase() === '\\deleted')) {
          throw new ToolInputError(
            'imap-mcp: \\Deleted cannot be added here — it marks messages for ' +
              'permanent removal, which the next client to close the mailbox ' +
              'may carry out. Use delete_messages, which asks for confirmation. ' +
              'Moving them to a Trash folder with move_messages is usually what ' +
              'is meant instead.'
          );
        }
        return client.withMailbox(mailbox, false, async (connection) => {
          if (add !== undefined) {
            await withTimeout(
              connection.messageFlagsAdd(uids, add, { uid: true }),
              'STORE'
            );
          }
          if (remove !== undefined) {
            await withTimeout(
              connection.messageFlagsRemove(uids, remove, { uid: true }),
              'STORE'
            );
          }
          const source = mailbox ?? client.defaultMailbox;
          audit('set_flags', {
            mailbox: source,
            uids,
            added: add,
            removed: remove,
          });
          return jsonResult({
            mailbox: source,
            uids,
            added: add ?? [],
            removed: remove ?? [],
          });
        });
      })
  );

  server.registerTool(
    'mark_messages_read',
    {
      title: 'Mark messages as read or unread',
      description:
        'Marks one or more messages as read (\\Seen) or unread by UID in the given mailbox. ' +
        'Uses IMAP UID STORE (+FLAGS.SILENT or -FLAGS.SILENT), is idempotent, preserves all other flags, ' +
        'and reports per-message results including partial failures after verifying the final flags on the server.',
      inputSchema: z.object({
        uids: uidListParam,
        mailbox: optionalMailboxParam,
        seen: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'true (default) to mark messages as read (\\Seen), false to mark as unread.'
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        mailbox: z.string(),
        seen: z.boolean(),
        messages: z.array(
          z.object({
            uid: z.number().int(),
            success: z.boolean(),
            seen: z.boolean().optional(),
            flags: z.array(z.string()).optional(),
            error: z.string().optional(),
          })
        ),
        updated: z.array(z.number().int()),
        failed: z.array(z.number().int()),
      }),
    },
    async ({ uids, mailbox, seen = true }) =>
      run(async () => {
        const targetSeen = seen ?? true;
        return client.withMailbox(mailbox, false, async (connection) => {
          const source = mailbox ?? client.defaultMailbox;

          // 1. Fetch current messages and flags in the explicitly selected mailbox
          const existingMessages = new Map<number, Set<string>>();
          for await (const msg of connection.fetch(
            uids,
            { flags: true, uid: true },
            { uid: true }
          )) {
            existingMessages.set(msg.uid, new Set(msg.flags));
          }

          const messagesResult: Array<{
            uid: number;
            success: boolean;
            seen?: boolean | undefined;
            flags?: string[] | undefined;
            error?: string | undefined;
          }> = [];
          const updated: number[] = [];
          const failed: number[] = [];

          const existingUids: number[] = [];
          for (const uid of uids) {
            if (!existingMessages.has(uid)) {
              failed.push(uid);
              messagesResult.push({
                uid,
                success: false,
                error: `Message with UID ${uid} not found in mailbox ${source}`,
              });
            } else {
              existingUids.push(uid);
            }
          }

          // 2. Apply UID STORE +FLAGS.SILENT (\Seen) or -FLAGS.SILENT (\Seen)
          if (existingUids.length > 0) {
            if (targetSeen) {
              await withTimeout(
                connection.messageFlagsAdd(existingUids, ['\\Seen'], {
                  uid: true,
                  silent: true,
                }),
                'STORE'
              );
            } else {
              await withTimeout(
                connection.messageFlagsRemove(existingUids, ['\\Seen'], {
                  uid: true,
                  silent: true,
                }),
                'STORE'
              );
            }

            // 3. Verify final state of flags on the server
            const finalFlagsMap = new Map<number, Set<string>>();
            for await (const msg of connection.fetch(
              existingUids,
              { flags: true, uid: true },
              { uid: true }
            )) {
              finalFlagsMap.set(msg.uid, new Set(msg.flags));
            }

            for (const uid of existingUids) {
              const flags = finalFlagsMap.get(uid);
              if (!flags) {
                failed.push(uid);
                messagesResult.push({
                  uid,
                  success: false,
                  error: `Message with UID ${uid} disappeared from mailbox ${source}`,
                });
                continue;
              }

              const isSeen = flags.has('\\Seen');
              if (isSeen === targetSeen) {
                updated.push(uid);
                messagesResult.push({
                  uid,
                  success: true,
                  seen: isSeen,
                  flags: Array.from(flags),
                });
              } else {
                failed.push(uid);
                messagesResult.push({
                  uid,
                  success: false,
                  seen: isSeen,
                  flags: Array.from(flags),
                  error: `Flag \\Seen was not updated to ${targetSeen} on the server`,
                });
              }
            }
          }

          (
            client as unknown as { invalidateMailboxCache?: () => void }
          ).invalidateMailboxCache?.();

          audit('mark_messages_read', {
            mailbox: source,
            uids,
            updated,
            failed,
            seen: targetSeen,
          });

          return jsonResult({
            mailbox: source,
            seen: targetSeen,
            messages: messagesResult,
            updated,
            failed,
          });
        });
      })
  );

  server.registerTool(
    'move_messages',
    {
      title: 'Move or copy messages',
      description:
        'Moves messages to another mailbox, or copies them when mode is ' +
        '"copy". Both ask the user to confirm; where the client cannot show a ' +
        'prompt, they fall back to a two-call token — call once to receive it, ' +
        'then again with that token and the same UID list and destination. ' +
        'Supports optional "mark_as_read" to mark as read before moving, and "moves" for batch operations.',
      inputSchema: z.object({
        uids: uidListParam.optional(),
        destination: mailboxParam
          .optional()
          .describe(
            'Mailbox the messages end up in, exactly as listed by list_mailboxes.'
          ),
        mailbox: optionalMailboxParam,
        mode: z
          .enum(['move', 'copy'])
          .optional()
          .describe(
            '"move" (default) removes the originals, "copy" keeps them.'
          ),
        mark_as_read: z
          .boolean()
          .optional()
          .describe(
            'When true, confirms messages exist in source, marks them as read (\\Seen), verifies the flag on the server, and only then moves them.'
          ),
        moves: z
          .array(
            z.object({
              uids: uidListParam,
              destination: mailboxParam.describe(
                'Destination mailbox for this batch.'
              ),
            })
          )
          .optional()
          .describe(
            'Batch moves to multiple destinations. Can be used instead of top-level uids/destination.'
          ),
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        // Destructive: the messages keep their content but get new UIDs, so
        // every reference to the old ones stops working. Copying into a shared
        // folder is the irreversible half — it cannot be unread.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: z.object({
        status: z.enum(['confirmation_required', 'completed']).optional(),
        confirm_token: z.string().optional(),
        expires_in_seconds: z.number().int().optional(),
        operation_summary: z
          .object({
            mode: z.enum(['move', 'copy']),
            source: z.string(),
            message_count: z.number().int(),
            destinations: z.array(z.string()),
          })
          .optional(),
        action: z.enum(['moved', 'copied']).optional(),
        source: z.string().optional(),
        destination: z.string().optional(),
        destinations: z.array(z.string()).optional(),
        uids: z.array(z.number().int()).optional(),
        mark_as_read: z.boolean().optional(),
        messages: z
          .array(
            z.object({
              uid: z.number().int(),
              destination: z.string(),
              dest_uid: z.number().int().optional(),
              seen: z.boolean().optional(),
              success: z.boolean(),
              error: z.string().optional(),
            })
          )
          .optional(),
        failed: z
          .array(
            z.object({
              uid: z.number().int(),
              destination: z.string().optional(),
              reason: z.string(),
            })
          )
          .optional(),
      }),
    },
    async (
      { uids, destination, mailbox, mode, mark_as_read, moves, confirm_token },
      mcp
    ) =>
      run(async () => {
        if (!moves && (!destination || !uids)) {
          throw new ToolInputError(
            'imap-mcp: give either "destination" and "uids", or "moves".'
          );
        }
        const targets: Array<{ uids: number[]; destination: string }> =
          moves ?? [{ uids: uids!, destination: destination! }];
        const copying = mode === 'copy';
        const source = mailbox ?? client.defaultMailbox;

        const allUids = Array.from(new Set(targets.flatMap((t) => t.uids)));
        const allDestinations = Array.from(
          new Set(targets.map((t) => t.destination))
        );

        const resourceKey = buildCanonicalMoveResourceKey({
          source,
          mode,
          markAsRead: mark_as_read,
          uids,
          destination,
          moves,
        });

        const details = [
          { label: 'From', value: shownValue(source) },
          { label: 'To', value: allDestinations.map(shownValue).join(', ') },
        ];
        if (mark_as_read) {
          details.push({ label: 'Mark as read', value: 'Yes (\\Seen)' });
        }

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `${copying ? 'copy' : 'move'} ${allUids.length} message(s) between mailboxes`,
            consequence: copying
              ? 'Everyone with access to the destination can read the copies, and taking them back does not unsee them.'
              : 'The messages keep their content but get new UIDs, so the current ones stop working.',
            resourceKey,
            token: confirm_token,
            details,
            toolName: 'move_messages',
          }
        );
        if (outcome.decision === 'rejected') {
          throw new ToolInputError(`imap-mcp: ${outcome.reason}`);
        }
        if (outcome.decision === 'declined') {
          throw new ToolInputError(
            'imap-mcp: the user declined. Nothing was moved.'
          );
        }
        if (outcome.decision === 'pending') {
          const res = outcome.result;
          if ('content' in res && Array.isArray(res.content) && res.content.length > 0) {
            const firstPart = res.content[0];
            const text =
              firstPart &&
              typeof firstPart === 'object' &&
              'text' in firstPart &&
              typeof firstPart.text === 'string'
                ? firstPart.text
                : '';
            const match = /confirm_token="([0-9a-f]+)"/.exec(text);
            if (match?.[1]) {
              const token = match[1];
              const structuredSummary = {
                status: 'confirmation_required',
                confirm_token: token,
                expires_in_seconds: confirmations.ttlMinutes * 60,
                operation_summary: {
                  mode: copying ? 'copy' : 'move',
                  source: escapeInvisible(source),
                  message_count: allUids.length,
                  destinations: allDestinations.map(escapeInvisible),
                },
              };
              return {
                ...res,
                content: [
                  {
                    type: 'text' as const,
                    text: `${text}\n\n${JSON.stringify(structuredSummary, null, 2)}`,
                  },
                ],
              };
            }
          }
          return outcome.result;
        }

        return client.withMailbox(mailbox, false, async (connection) => {
          const messageResults: Array<{
            uid: number;
            destination: string;
            dest_uid?: number | undefined;
            seen?: boolean | undefined;
            success: boolean;
            error?: string | undefined;
          }> = [];
          const failures: Array<{
            uid: number;
            destination: string;
            reason: string;
          }> = [];
          const successfullyMoved: number[] = [];

          for (const target of targets) {
            const targetUids = target.uids;
            const targetDest = target.destination;

            if (mark_as_read) {
              // 1. Confirm UIDs exist in source mailbox
              const foundMessages = new Map<number, Set<string>>();
              for await (const msg of connection.fetch(
                targetUids,
                { flags: true, uid: true },
                { uid: true }
              )) {
                foundMessages.set(msg.uid, new Set(msg.flags));
              }

              const existingUids: number[] = [];
              for (const uid of targetUids) {
                if (!foundMessages.has(uid)) {
                  failures.push({
                    uid,
                    destination: targetDest,
                    reason: `Message with UID ${uid} not found in source mailbox ${source}`,
                  });
                  messageResults.push({
                    uid,
                    destination: targetDest,
                    success: false,
                    error: `Message with UID ${uid} not found in source mailbox ${source}`,
                  });
                } else {
                  existingUids.push(uid);
                }
              }

              // 2. Mark messages as read
              if (existingUids.length > 0) {
                await withTimeout(
                  connection.messageFlagsAdd(existingUids, ['\\Seen'], {
                    uid: true,
                    silent: true,
                  }),
                  'STORE'
                );

                // 3. Verify \Seen was applied on the server
                const verifiedFlags = new Map<number, Set<string>>();
                for await (const msg of connection.fetch(
                  existingUids,
                  { flags: true, uid: true },
                  { uid: true }
                )) {
                  verifiedFlags.set(msg.uid, new Set(msg.flags));
                }

                const readyToMove: number[] = [];
                for (const uid of existingUids) {
                  const flags = verifiedFlags.get(uid);
                  if (flags && flags.has('\\Seen')) {
                    readyToMove.push(uid);
                  } else {
                    failures.push({
                      uid,
                      destination: targetDest,
                      reason: `Failed to verify \\Seen flag for message with UID ${uid}`,
                    });
                    messageResults.push({
                      uid,
                      destination: targetDest,
                      seen: false,
                      success: false,
                      error: `Failed to verify \\Seen flag on server`,
                    });
                  }
                }

                // 4. Somente então executar a movimentação
                if (readyToMove.length > 0) {
                  const rawRes = copying
                    ? await withTimeout(
                        connection.messageCopy(readyToMove, targetDest, {
                          uid: true,
                        }),
                        'COPY'
                      )
                    : await withTimeout(
                        connection.messageMove(readyToMove, targetDest, {
                          uid: true,
                        }),
                        'MOVE'
                      );

                  const moveRes = rawRes as
                    { uidMap?: Map<number, number> } | false | undefined;
                  const uidMap =
                    moveRes && moveRes.uidMap instanceof Map
                      ? moveRes.uidMap
                      : undefined;

                  for (const uid of readyToMove) {
                    const destUid = uidMap?.get(uid);
                    successfullyMoved.push(uid);
                    messageResults.push({
                      uid,
                      destination: targetDest,
                      dest_uid: destUid,
                      seen: true,
                      success: true,
                    });
                  }
                }
              }
            } else {
              // Classic move/copy without mark_as_read
              const rawRes = copying
                ? await withTimeout(
                    connection.messageCopy(targetUids, targetDest, {
                      uid: true,
                    }),
                    'COPY'
                  )
                : await withTimeout(
                    connection.messageMove(targetUids, targetDest, {
                      uid: true,
                    }),
                    'MOVE'
                  );

              const moveRes = rawRes as
                { uidMap?: Map<number, number> } | false | undefined;
              const uidMap =
                moveRes && moveRes.uidMap instanceof Map
                  ? moveRes.uidMap
                  : undefined;

              for (const uid of targetUids) {
                const destUid = uidMap?.get(uid);
                successfullyMoved.push(uid);
                messageResults.push({
                  uid,
                  destination: targetDest,
                  dest_uid: destUid,
                  success: true,
                });
              }
            }
          }

          (
            client as unknown as { invalidateMailboxCache?: () => void }
          ).invalidateMailboxCache?.();

          audit(copying ? 'copy' : 'move', {
            from: source,
            to:
              allDestinations.length === 1
                ? allDestinations[0]
                : allDestinations,
            uids: successfullyMoved,
            mark_as_read: mark_as_read ?? false,
            failures:
              failures.length > 0 ? failures.map((f) => f.uid) : undefined,
          });

          return jsonResult({
            status: 'completed',
            action: copying ? 'copied' : 'moved',
            source,
            destination:
              destination ??
              (allDestinations.length === 1 ? allDestinations[0] : undefined),
            destinations: allDestinations,
            uids: successfullyMoved,
            mark_as_read: mark_as_read ?? false,
            messages: messageResults,
            failed: failures.length > 0 ? failures : undefined,
          });
        });
      })
  );

  server.registerTool(
    'delete_messages',
    {
      title: 'Delete messages',
      description:
        'Permanently deletes messages: sets \\Deleted and expunges them. On ' +
        'most servers this does not go to Trash — move them there instead if ' +
        'that is what is meant. Asks the user to confirm; where the client ' +
        'cannot show a prompt, it falls back to a two-call token.',
      inputSchema: z.object({
        uids: uidListParam,
        mailbox: optionalMailboxParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        // Expunged, not moved to Trash. Idempotent by the specification's
        // wording — the second call finds nothing, and the world is the same.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        action: z.literal('deleted'),
        mailbox: z.string(),
        uids: z.array(z.number().int()),
      }),
    },
    async ({ uids, mailbox, confirm_token }, mcp) =>
      run(async () => {
        const source = mailbox ?? client.defaultMailbox;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `Permanently delete ${uids.length} message(s) (UIDs ${uids.slice(0, 20).join(', ')}${uids.length > 20 ? ', …' : ''})`,
            consequence:
              'The messages are expunged, not moved to Trash. They cannot be recovered from here.',
            resourceKey: setResourceKey(
              `delete_messages:${source}`,
              uids.map(String)
            ),
            token: confirm_token,
            toolName: 'delete_messages',
            details: [{ label: 'Mailbox', value: shownValue(source) }],
          }
        );
        if (outcome.decision === 'rejected') {
          throw new ToolInputError(`imap-mcp: ${outcome.reason}`);
        }
        if (outcome.decision === 'declined') {
          throw new ToolInputError(
            'imap-mcp: the user declined. Nothing was changed.'
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        return client.withMailbox(mailbox, false, async (connection) => {
          await withTimeout(
            connection.messageDelete(uids, { uid: true }),
            'EXPUNGE'
          );
          audit('delete', { mailbox: source, uids });
          return jsonResult({ action: 'deleted', mailbox: source, uids });
        });
      })
  );

  server.registerTool(
    'manage_mailbox',
    {
      title: 'Create, rename or delete a mailbox',
      description:
        'Creates a folder, renames one, or deletes one. Deleting asks the user ' +
        'to confirm and takes every message in the folder with it; renaming ' +
        'uses the two-call token because it is reversible.',
      inputSchema: z.object({
        action: z
          .enum(['create', 'rename', 'delete'])
          .describe('What to do with the mailbox.'),
        mailbox: mailboxParam.describe(
          'The mailbox to create, rename or delete.'
        ),
        new_name: mailboxParam
          .optional()
          .describe('Required for "rename": the full new path.'),
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        // Destructive in its delete mode, which takes every message in the
        // folder; create and rename are the additive ones. One tool, so the
        // annotation has to describe its strongest mode.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        action: z.enum(['create', 'rename', 'delete']),
        mailbox: z.string(),
        new_name: z.string().optional(),
      }),
    },
    async ({ action, mailbox, new_name, confirm_token }, mcp) =>
      run(async () => {
        if (action === 'rename' && new_name === undefined) {
          throw new ToolInputError(
            'imap-mcp: "rename" needs new_name — the full new mailbox path.'
          );
        }

        if (action === 'delete') {
          const outcome = await approval.requestApproval(
            server,
            mcp,
            confirmations,
            {
              what: 'Delete a mailbox',
              consequence:
                'Every message in the folder is deleted with it, and it cannot be recovered from here.',
              resourceKey: `manage_mailbox:delete:${mailbox}`,
              token: confirm_token,
              toolName: 'manage_mailbox',
              details: [{ label: 'Mailbox', value: shownValue(mailbox) }],
            }
          );
          if (outcome.decision === 'rejected') {
            throw new ToolInputError(`imap-mcp: ${outcome.reason}`);
          }
          if (outcome.decision === 'declined') {
            throw new ToolInputError(
              'imap-mcp: the user declined. Nothing was changed.'
            );
          }
          if (outcome.decision === 'pending') return outcome.result;
        } else if (action === 'rename') {
          // JSON-encoded for the same reason as the move key above: a ':' in
          // either name must not let two different renames share a token.
          const key = `manage_mailbox:rename:${JSON.stringify([mailbox, new_name ?? ''])}`;
          if (!confirmations.consume(key, confirm_token)) {
            // An error result, like `mcp-approval`'s own prompt: the rename
            // was asked for and did not happen. It is also what lets this tool
            // declare an output schema — the SDK requires `structuredContent`
            // from a tool that has one, and a prompt has none to give.
            return errorResult(
              confirmationPrompt({
                what: 'rename a mailbox',
                token: confirmations.issue(key),
                ttlMinutes: confirmations.ttlMinutes,
                consequence:
                  'Clients that cached the old path will have to resynchronise.',
                details: [
                  { label: 'Mailbox', value: shownValue(mailbox) },
                  { label: 'New name', value: shownValue(new_name ?? '') },
                ],
                toolName: 'manage_mailbox',
              })
            );
          }
        }

        return client.withConnection(async (connection) => {
          if (action === 'create') {
            await withTimeout(connection.mailboxCreate(mailbox), 'CREATE');
          } else if (action === 'rename') {
            await withTimeout(
              connection.mailboxRename(mailbox, new_name as string),
              'RENAME'
            );
          } else {
            await withTimeout(connection.mailboxDelete(mailbox), 'DELETE');
          }
          audit(`mailbox_${action}`, { mailbox, new_name });
          return jsonResult({
            action,
            mailbox,
            ...(new_name === undefined ? {} : { new_name }),
          });
        });
      })
  );

  server.registerTool(
    'save_draft',
    {
      title: 'Save a draft',
      description:
        'Composes a plain-text message and stores it in the Drafts folder. ' +
        'This server cannot send mail — the draft waits in the mailbox until a ' +
        'person opens it in their own mail client and sends it from there. ' +
        'That is deliberate: it keeps the composing useful while leaving the ' +
        'decision to send with a human.',
      inputSchema: z.object({
        to: addressListParam,
        cc: addressListParam.optional(),
        bcc: addressListParam.optional(),
        subject: z
          .string()
          .max(500)
          .refine((v) => !/[\r\n]/.test(v), 'must not contain line breaks')
          .describe('Subject line.'),
        body: z
          .string()
          .min(1)
          .max(100_000)
          .describe('Plain-text body of the message.'),
        reply_to_uid: uidParam
          .optional()
          .describe(
            'UID of the message being answered; threads the draft through In-Reply-To and References.'
          ),
        mailbox: optionalMailboxParam.describe(
          'Where to look for reply_to_uid. Defaults to the configured mailbox.'
        ),
      }),
      annotations: {
        // Additive: it appends a message to the drafts folder. Two calls
        // leave two drafts.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: z.object({
        action: z.literal('draft_saved'),
        mailbox: z.string().describe('The Drafts folder this server found.'),
        recipients: z.array(z.string()),
        note: z.string(),
      }),
    },
    async ({ to, cc, bcc, subject, body, reply_to_uid, mailbox }) =>
      run(async () => {
        const thread =
          reply_to_uid === undefined
            ? undefined
            : await client.threadHeaders(mailbox, reply_to_uid);

        const draft = buildDraft({
          from: client.user,
          to,
          ...(cc === undefined ? {} : { cc }),
          ...(bcc === undefined ? {} : { bcc }),
          subject,
          body,
          ...(thread === undefined ? {} : { thread }),
        });

        const folder = await resolveDraftsMailbox(client, config);
        await client.withConnection(async (connection) => {
          await withTimeout(
            connection.append(folder, draft, ['\\Draft', '\\Seen']),
            'APPEND'
          );
        });
        audit('save_draft', {
          mailbox: folder,
          recipients: to.length + (cc?.length ?? 0) + (bcc?.length ?? 0),
          in_reply_to: thread?.messageId,
        });
        return jsonResult({
          action: 'draft_saved',
          mailbox: folder,
          recipients: [...to, ...(cc ?? []), ...(bcc ?? [])],
          note: 'The draft is stored but not sent. This server has no way to send mail; open it in your mail client to send it.',
        });
      })
  );
}

/**
 * Finds the Drafts folder.
 *
 * The `\Drafts` special-use flag is the right answer where the server reports
 * it, because folder names are localised — "Entwürfe", "Brouillons" — and
 * guessing wrong creates a stray folder rather than failing loudly.
 */
async function resolveDraftsMailbox(
  client: ImapClient,
  config: Config
): Promise<string> {
  if (config.imap.draftsMailbox !== undefined) {
    return config.imap.draftsMailbox;
  }
  const { mailboxes } = await client.listMailboxes();
  const found = mailboxes.find((box) => box.specialUse === '\\Drafts');
  if (found === undefined) {
    throw new ToolInputError(
      'imap-mcp: this account does not advertise a \\Drafts folder. Call ' +
        'list_mailboxes to find the right one and set IMAP_DRAFTS_MAILBOX to it.'
    );
  }
  return found.path;
}
