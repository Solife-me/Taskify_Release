import { hexToBytes } from "@noble/hashes/utils.js";
import chalk from "chalk";
import type { Command } from "commander";
import { getPublicKey,nip19 } from "nostr-tools";
import {
buildCalendarEventInviteEnvelope,
buildEventRsvpResponseEnvelope,
normalizeTaskRecurrence,
normalizeTaskReminders
} from "taskify-core";
import { loadConfig } from "../config.js";
import { renderJson } from "../render.js";
import { buildCalendarEventDraft } from "../shared/eventDraft.js";
import { sendShareEnvelopeNip17 } from "../shared/shareTransport.js";
import type { CommandContext } from "./context.js";

export function registerEventsCommands(program: Command, context: Pick<CommandContext, "parseJsonOption" | "parseReminderOption" | "normalizeAssigneeArgs" | "initRuntime" | "resolveBoardId" | "mergeAttachmentDocuments" | "resolveAttachmentDocuments" | "resolveColumnOrExit" | "npubOrHexToHex" | "nsecToHexOrThrow">) {
  const { parseJsonOption, parseReminderOption, normalizeAssigneeArgs, initRuntime, resolveBoardId, mergeAttachmentDocuments, resolveAttachmentDocuments, resolveColumnOrExit, npubOrHexToHex, nsecToHexOrThrow } = context;
  // ---- event command group ----
  const eventCmd = program
    .command("event")
    .description("Manage calendar events");

  eventCmd
    .command("list")
    .description("List events")
    .option("--board <id|name>", "Filter by board")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
        const events = await runtime.listEvents({ boardId });
        if (opts.json) {
          renderJson(events);
        } else if (events.length === 0) {
          console.log(chalk.dim("No events found."));
        } else {
          const showBoard = !boardId;
          for (const e of events) {
            const when = e.kind === "time"
              ? `${e.startISO ?? ""}${e.endISO ? ` → ${e.endISO}` : ""}`
              : `${e.startDate ?? ""}${e.endDate ? ` → ${e.endDate}` : ""}`;
            const boardLabel = showBoard ? ` ${chalk.dim(`[${e.boardName ?? e.boardId}]`)}` : "";
            console.log(`${chalk.cyan(e.id.slice(0, 8))}  ${e.title}${boardLabel}  ${chalk.dim(when)}`);
          }
        }
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

  eventCmd
    .command("add <title>")
    .description("Create an event")
    .option("--board <id|name>", "Board to add to (required if multiple boards configured)")
    .option("--date <YYYY-MM-DD>", "Start date (required)")
    .option("--end-date <YYYY-MM-DD>", "End date for all-day range")
    .option("--time <HH:mm>", "Start time for timed event")
    .option("--end-time <HH:mm>", "End time for timed event")
    .option("--tz <iana>", "Timezone for timed event")
    .option("--description <text>", "Optional description")
    .option("--column <id|name>", "List column placement")
    .option("--recurrence-json <json>", "Recurrence object JSON")
    .option("--reminders <csv>", "Reminder presets csv (e.g. 15m,1h)")
    .option("--invitee <npubOrHex>", "Invitee pubkey/npub (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--documents-json <json>", "Documents/attachments array JSON")
    .option("--attach <path>", "Attach local file/image (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--file-server <url>", "Encrypted file server override for shared attachment uploads")
    .option("--json", "Output as JSON")
    .action(async (title: string, opts) => {
      if (!opts.date) {
        console.error(chalk.red("--date is required (YYYY-MM-DD)"));
        process.exit(1);
      }
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const runtime = initRuntime(config);
      try {
        const draft = buildCalendarEventDraft({
          boardId,
          title,
          date: opts.date,
          endDate: opts.endDate,
          time: opts.time,
          endTime: opts.endTime,
          timeZone: opts.tz,
        });
        const boardEntry = config.boards.find((b) => b.id === boardId)!;
        if (boardEntry.kind === "lists" && (!boardEntry.columns || boardEntry.columns.length === 0)) {
          throw new Error(`Board "${boardEntry.name}" has no columns/lists yet. Add one first.`);
        }
        const resolvedColumn = opts.column ? resolveColumnOrExit(boardEntry, opts.column) : null;
        const recurrence = normalizeTaskRecurrence(parseJsonOption("--recurrence-json", opts.recurrenceJson));
        const reminders = normalizeTaskReminders(parseReminderOption(opts.reminders));
        const documents = await resolveAttachmentDocuments({ files: opts.attach as string[], boardId, config, fileServer: opts.fileServer, documentsJson: opts.documentsJson });
        const invitees = normalizeAssigneeArgs(opts.invitee as string[])?.map((a) => ({ pubkey: a.pubkey, relay: a.relay }));
        const created = await runtime.createEvent({
          ...draft,
          description: opts.description,
          columnId: resolvedColumn?.id,
          recurrence: recurrence as any,
          reminders: reminders as any,
          participants: invitees,
          documents: documents as any,
        });
        if (opts.json) renderJson(created);
        else console.log(chalk.green(`✓ Created event: ${created.title} (${created.id.slice(0, 8)})`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

  eventCmd
    .command("show <eventId>")
    .description("Show event details")
    .option("--board <id|name>", "Board to search in")
    .option("--json", "Output as JSON")
    .action(async (eventId: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
        const event = await runtime.getEvent(eventId, boardId);
        if (!event) {
          console.error(chalk.red(`Event not found: ${eventId}`));
          process.exit(1);
        }
        if (opts.json) renderJson(event);
        else {
          console.log(chalk.bold(event.title));
          console.log(`id: ${event.id}`);
          console.log(`board: ${event.boardName ?? event.boardId}`);
          console.log(`kind: ${event.kind}`);
          if (event.kind === "time") console.log(`when: ${event.startISO}${event.endISO ? ` → ${event.endISO}` : ""}`);
          else console.log(`when: ${event.startDate}${event.endDate ? ` → ${event.endDate}` : ""}`);
          if (event.description) console.log(`description: ${event.description}`);
          if (event.recurrence) console.log(`recurrence: ${JSON.stringify(event.recurrence)}`);
          if (Array.isArray(event.reminders) && event.reminders.length > 0) console.log(`reminders: ${event.reminders.join(", ")}`);
          if (Array.isArray(event.participants) && event.participants.length > 0) {
            console.log(`invitees: ${event.participants.length}`);
            event.participants.forEach((p) => console.log(`  - ${p.pubkey}${p.role ? ` (${p.role})` : ""}`));
          }
          if (Array.isArray(event.documents) && event.documents.length > 0) {
            console.log(`documents: ${event.documents.length}`);
            event.documents.forEach((doc: any, idx: number) => {
              const name = typeof doc?.name === "string" ? doc.name : `document-${idx + 1}`;
              const url = typeof doc?.remoteUrl === "string" ? doc.remoteUrl : (typeof doc?.url === "string" ? doc.url : "");
              const flags = [doc?.encrypted === true ? "encrypted" : null, typeof doc?.kind === "string" ? doc.kind : null].filter(Boolean).join(", ");
              console.log(`  - ${name}${flags ? ` [${flags}]` : ""}${url ? ` (${url})` : ""}`);
            });
          }
          if (event.columnId) console.log(`column: ${event.columnId}`);
          if (event.rsvpStatus) console.log(`rsvp status: ${event.rsvpStatus}`);
        }
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

  eventCmd
    .command("update <eventId>")
    .description("Update an event")
    .option("--board <id|name>", "Board the event belongs to (optional; scans all if omitted)")
    .option("--title <text>", "Update title")
    .option("--description <text>", "Update description")
    .option("--start-date <YYYY-MM-DD>", "Update date event start")
    .option("--end-date <YYYY-MM-DD>", "Update date event end")
    .option("--start-iso <iso>", "Update timed event start ISO")
    .option("--end-iso <iso>", "Update timed event end ISO")
    .option("--tz <iana>", "Update timed event timezone")
    .option("--column <id|name>", "Update list column placement")
    .option("--recurrence-json <json>", "Update recurrence object JSON")
    .option("--reminders <csv>", "Update reminder presets csv")
    .option("--invitee <npubOrHex>", "Replace invitees (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--documents-json <json>", "Replace documents/attachments with array JSON")
    .option("--attach <path>", "Append local file/image attachment (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--remove-attachment <ref>", "Remove attachment by 1-based index or partial name (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--replace-attachments", "Replace all existing attachments with provided attachment inputs")
    .option("--file-server <url>", "Encrypted file server override for shared attachment uploads")
    .option("--json", "Output as JSON")
    .action(async (eventId: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
        const boardEntry = boardId ? config.boards.find((b) => b.id === boardId) : undefined;
        const resolvedColumn = opts.column && boardEntry ? resolveColumnOrExit(boardEntry, opts.column) : null;
        const recurrence = opts.recurrenceJson !== undefined ? normalizeTaskRecurrence(parseJsonOption("--recurrence-json", opts.recurrenceJson)) ?? null : undefined;
        const reminders = opts.reminders !== undefined ? normalizeTaskReminders(parseReminderOption(opts.reminders)) ?? null : undefined;
        let documents = undefined;
        if (opts.documentsJson !== undefined || ((opts.attach as string[]).length > 0) || ((opts.removeAttachment as string[]).length > 0) || opts.replaceAttachments) {
          const existingEvent = await runtime.getEvent(eventId, boardId);
          if (!existingEvent) {
            console.error(chalk.red(`Event not found: ${eventId}`));
            process.exit(1);
          }
          documents = await mergeAttachmentDocuments({
            existing: existingEvent.documents as Record<string, unknown>[] | undefined,
            files: opts.attach as string[],
            boardId: (boardId || existingEvent.boardId),
            config,
            fileServer: opts.fileServer,
            documentsJson: opts.documentsJson,
            removeRefs: opts.removeAttachment as string[],
            replace: !!opts.replaceAttachments,
          }) ?? null;
        }
        const invitees = (opts.invitee as string[]).length > 0
          ? normalizeAssigneeArgs(opts.invitee as string[])?.map((a) => ({ pubkey: a.pubkey, relay: a.relay })) ?? []
          : undefined;
        const updated = await runtime.updateEvent(eventId, boardId, {
          title: opts.title,
          description: opts.description,
          startDate: opts.startDate,
          endDate: opts.endDate,
          startISO: opts.startIso,
          endISO: opts.endIso,
          startTzid: opts.tz,
          endTzid: opts.tz,
          columnId: resolvedColumn?.id,
          recurrence: recurrence as any,
          reminders: reminders as any,
          participants: invitees,
          documents: documents as any,
        });
        if (!updated) {
          console.error(chalk.red(`Event not found: ${eventId}`));
          process.exit(1);
        }
        if (opts.json) renderJson(updated);
        else console.log(chalk.green(`✓ Updated event: ${updated.title}`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

  eventCmd
    .command("delete <eventId>")
    .description("Delete an event")
    .option("--board <id|name>", "Board the event belongs to (optional; scans all if omitted)")
    .option("--json", "Output as JSON")
    .action(async (eventId: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
        const deleted = await runtime.deleteEvent(eventId, boardId);
        if (!deleted) {
          console.error(chalk.red(`Event not found: ${eventId}`));
          process.exit(1);
        }
        if (opts.json) renderJson(deleted);
        else console.log(chalk.green(`✓ Deleted event: ${deleted.title}`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

  eventCmd
    .command("invite <eventId> <npubOrHex>")
    .description("Share an event invite over NIP-17 DM")
    .option("--board <id|name>", "Board the event belongs to (optional; scans all if omitted)")
    .action(async (eventId: string, npubOrHex: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const recipient = npubOrHexToHex(npubOrHex);
        const event = await runtime.getEvent(eventId, opts.board ? await resolveBoardId(opts.board, config) : undefined);
        if (!event) throw new Error(`Event not found: ${eventId}`);
        const senderHex = nsecToHexOrThrow(config.nsec);
        const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderHex)));
        const eventKey = `taskify:event:${event.id}`;
        const canonical = `31923:${getPublicKey(hexToBytes(senderHex))}:${event.id}`;
        const view = `31924:${getPublicKey(hexToBytes(senderHex))}:${event.id}`;
        const envelope = buildCalendarEventInviteEnvelope({
          eventId: event.id,
          canonical,
          view,
          eventKey,
          inviteToken: `${event.id}:${recipient.slice(0, 16)}`,
          title: event.title,
          start: event.startISO ?? event.startDate,
          end: event.endISO ?? event.endDate,
          relays: config.relays,
        }, { npub: senderNpub });
        await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: recipient, relays: config.relays });
        console.log(chalk.green("✓ Event invite shared."));
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  eventCmd
    .command("rsvp <eventId> <accepted|declined|tentative>")
    .description("Send RSVP response for an event invite")
    .option("--to <npubOrHex>", "Invite sender public key")
    .action(async (eventId: string, status: "accepted" | "declined" | "tentative", opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      let exitCode = 0;
      try {
        if (!opts.to) throw new Error("--to <npubOrHex> is required.");
        const senderHex = nsecToHexOrThrow(config.nsec);
        const envelope = buildEventRsvpResponseEnvelope({
          eventId,
          status,
          respondedAt: new Date().toISOString(),
        });
        await sendShareEnvelopeNip17({
          envelope,
          senderSecretHex: senderHex,
          recipientPubkeyHex: npubOrHexToHex(opts.to),
          relays: config.relays,
        });
        console.log(chalk.green("✓ RSVP sent."));
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        process.exit(exitCode);
      }
    });

}
