import { hexToBytes } from "@noble/hashes/utils.js";
import chalk from "chalk";
import type { Command } from "commander";
import { getPublicKey,nip19 } from "nostr-tools";
import { deriveBoardKeyPair } from "taskify-runtime-nostr";
import {
buildCalendarEventInviteEnvelope,
calendarAddress,
deriveBoardRsvpToken,
normalizeTaskRecurrence,
normalizeTaskReminders,
planCalendarRsvp,
resolveIdentifierReference,
TASKIFY_CALENDAR_EVENT_KIND,
TASKIFY_CALENDAR_RSVP_KIND,
type CalendarRsvpStatus
} from "taskify-core";
import { encryptCalendarRsvpForBoard } from "../calendarCrypto.js";
import { renderJson } from "../render.js";
import { buildCalendarEventDraft } from "../shared/eventDraft.js";
import { rethrowReportedError, type CommandContext } from "./context.js";

export function registerEventsCommands(program: Command, context: Pick<CommandContext, "loadConfig" | "parseJsonOption" | "parseReminderOption" | "normalizeAssigneeArgs" | "initRuntime" | "resolveBoardId" | "mergeAttachmentDocuments" | "resolveAttachmentDocuments" | "resolveColumnOrExit" | "npubOrHexToHex" | "nsecToHexOrThrow" | "now" | "shareTransport" | "withStandaloneSession">) {
  const { loadConfig, parseJsonOption, parseReminderOption, normalizeAssigneeArgs, initRuntime, resolveBoardId, mergeAttachmentDocuments, resolveAttachmentDocuments, resolveColumnOrExit, nsecToHexOrThrow, now, shareTransport, withStandaloneSession } = context;
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
      } catch (err) {
        rethrowReportedError(err);
        console.error(chalk.red(String(err)));
        process.exitCode = 1;
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
        process.exitCode = 1;
        return;
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
      } catch (err) {
        rethrowReportedError(err);
        console.error(chalk.red(String(err)));
        process.exitCode = 1;
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
          process.exitCode = 1;
          return;
        }
        const rsvps = await runtime.listEventRsvps(event.id, event.boardId) ?? [];
        if (opts.json) renderJson({ ...event, rsvps });
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
          if (rsvps.length > 0) {
            console.log(`responses: ${rsvps.length}`);
            rsvps.forEach((rsvp) => {
              const details = [rsvp.status, rsvp.fb].filter(Boolean).join(", ");
              console.log(`  - ${rsvp.attendeePubkey}: ${details}${rsvp.note ? ` — ${rsvp.note}` : ""}`);
            });
          }
        }
      } catch (err) {
        rethrowReportedError(err);
        console.error(chalk.red(String(err)));
        process.exitCode = 1;
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
            process.exitCode = 1;
            return;
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
          process.exitCode = 1;
          return;
        }
        if (opts.json) renderJson(updated);
        else console.log(chalk.green(`✓ Updated event: ${updated.title}`));
      } catch (err) {
        rethrowReportedError(err);
        console.error(chalk.red(String(err)));
        process.exitCode = 1;
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
          process.exitCode = 1;
          return;
        }
        if (opts.json) renderJson(deleted);
        else console.log(chalk.green(`✓ Deleted event: ${deleted.title}`));
      } catch (err) {
        rethrowReportedError(err);
        console.error(chalk.red(String(err)));
        process.exitCode = 1;
      } finally {
        await runtime.disconnect();
      }
    });

  eventCmd
    .command("invite <eventId> <npubOrHex>")
    .description("Share an event invite over NIP-17 DM")
    .option("--board <id|name>", "Board the event belongs to (optional; scans all if omitted)")
    .action(eventInviteAction(program, context));

  eventCmd
    .command("rsvp <eventId> <accepted|declined|tentative>")
    .description("Answer an event invitation: publishes your RSVP (kind 30312) for the event's board to read")
    .option("--board <id|name>", "Answer an event on one of your boards rather than an invitation in your inbox")
    .option("--fb <free|busy>", "Whether the time is free or busy for you")
    .option("--note <text>", "A note for the organizer")
    .option("--to <npubOrHex>", "No longer needed: the answer goes to the event's board (ignored)")
    .option("--json", "Output the published RSVP as JSON")
    .action(async (eventId: string, status: CalendarRsvpStatus, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      let exitCode = 0;
      try {
        const secretHex = nsecToHexOrThrow(config.nsec);
        const attendeePubkey = getPublicKey(hexToBytes(secretHex));
        const target = opts.board
          ? await boardEventRsvpTarget(eventId, opts.board, attendeePubkey, config)
          : await invitationRsvpTarget(eventId, secretHex, config);
        const plan = planCalendarRsvp({
          canonical: target.canonical,
          eventId: target.eventId,
          attendeePubkey,
          status,
          inviteToken: target.inviteToken,
          fb: opts.fb,
          note: opts.note,
        });
        if (plan.kind === "invalid") throw new Error(plan.error);
        const content = await encryptCalendarRsvpForBoard(plan.payload, secretHex, plan.boardPubkey);
        const { event, relays } = await withStandaloneSession(
          { relays: target.relays, secretKeyHex: secretHex },
          (session) => session.publish({
            kind: TASKIFY_CALENDAR_RSVP_KIND,
            content,
            tags: plan.tags,
            created_at: Math.floor(now().getTime() / 1000),
          }),
        );
        if (opts.json) renderJson({ eventId: target.eventId, status, canonical: plan.canonicalAddress, rsvpEventId: event.id, relays });
        else console.log(chalk.green(`✓ RSVP sent: ${status}`));
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        process.exitCode = exitCode;
      }
    });

  type RsvpTarget = { eventId: string; canonical: string; inviteToken: string | undefined; relays: string[] };

  /** The newest invitation to `eventRef` (an id or its prefix) among the shares in the inbox. */
  async function invitationRsvpTarget(eventRef: string, secretHex: string, config: Awaited<ReturnType<typeof loadConfig>>): Promise<RsvpTarget> {
    const inbox = await shareTransport.fetchInbox({ recipientSecretHex: secretHex, relays: config.relays, limit: 100 });
    const invitations = inbox.flatMap((share) => (share.envelope.item.type === "event" ? [{ ...share.envelope.item, id: share.envelope.item.eventId }] : []));
    const invitation = resolveIdentifierReference(invitations, eventRef);
    if (!invitation) {
      throw new Error(`No invitation to event ${eventRef} in your inbox; for an event on one of your boards, pass --board.`);
    }
    return {
      eventId: invitation.eventId,
      canonical: invitation.canonical,
      inviteToken: invitation.inviteToken,
      relays: invitation.relays?.length ? invitation.relays : config.relays,
    };
  }

  /** An event on one of the user's boards: their own token if it names one, else the board's. */
  async function boardEventRsvpTarget(eventRef: string, board: string, attendeePubkey: string, config: Awaited<ReturnType<typeof loadConfig>>): Promise<RsvpTarget> {
    const boardId = await resolveBoardId(board, config);
    const runtime = initRuntime(config);
    try {
      const event = await runtime.getEvent(eventRef, boardId);
      if (!event) throw new Error(`Event not found: ${eventRef}`);
      const entry = config.boards.find((candidate) => candidate.id === event.boardId);
      return {
        eventId: event.id,
        canonical: calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, deriveBoardKeyPair(event.boardId).pk, event.id),
        inviteToken: event.inviteTokens?.[attendeePubkey] ?? await deriveBoardRsvpToken(event.boardId, attendeePubkey),
        relays: entry?.relays?.length ? entry.relays : config.relays,
      };
    } finally {
      await runtime.disconnect();
    }
  }

}

/** `event invite` and `share event`: invite someone to a calendar event over NIP-17. */
export function eventInviteAction(
  program: Command,
  context: Pick<CommandContext, "loadConfig" | "initRuntime" | "resolveBoardId" | "npubOrHexToHex" | "nsecToHexOrThrow" | "shareTransport">,
) {
  const { loadConfig, initRuntime, resolveBoardId, npubOrHexToHex, nsecToHexOrThrow, shareTransport } = context;
  return async (eventId: string, npubOrHex: string, opts: { board?: string }) => {
    const config = await loadConfig(program.opts().profile as string | undefined);
    const runtime = initRuntime(config);
    let exitCode = 0;
    try {
      const recipient = npubOrHexToHex(npubOrHex);
      // The runtime adds the invitee, gives them their own token and republishes the event, so
      // the invitee can open its view copy.
      const invitation = await runtime.inviteToEvent(eventId, opts.board ? await resolveBoardId(opts.board, config) : undefined, recipient);
      if (!invitation) throw new Error(`Event not found: ${eventId}`);
      const { event } = invitation;
      const senderHex = nsecToHexOrThrow(config.nsec);
      const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderHex)));
      const envelope = buildCalendarEventInviteEnvelope({
        eventId: event.id,
        canonical: invitation.canonical,
        view: invitation.view,
        eventKey: event.eventKey,
        inviteToken: invitation.inviteToken,
        title: event.title,
        start: event.kind === "date" ? event.startDate : event.startISO,
        end: event.kind === "date" ? event.endDate : event.endISO,
        relays: invitation.relays,
      }, { npub: senderNpub });
      // Sent over the board's relays and this profile's, as the PWA sends invites.
      const sendRelays = Array.from(new Set([...invitation.relays, ...config.relays]));
      await shareTransport.send({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: recipient, relays: sendRelays });
      console.log(chalk.green("✓ Event invite shared."));
    } catch (err) {
      rethrowReportedError(err);
      console.error(chalk.red(String(err)));
      exitCode = 1;
    } finally {
      await runtime.disconnect();
      process.exitCode = exitCode;
    }
  };
}
