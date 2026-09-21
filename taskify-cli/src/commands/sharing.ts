import { hexToBytes } from "@noble/hashes/utils.js";
import chalk from "chalk";
import type { Command } from "commander";
import { getPublicKey,nip19 } from "nostr-tools";
import {
buildBoardShareEnvelope,
buildTaskAssignmentResponseEnvelope,
buildTaskShareEnvelope,
resolveBoardReference
} from "taskify-core";
import { loadConfig,saveConfig } from "../config.js";
import { renderJson } from "../render.js";
import { fetchShareInboxNip17,sendShareEnvelopeNip17 } from "../shared/shareTransport.js";
import type { CommandContext } from "./context.js";

export function registerSharingCommands(program: Command, context: Pick<CommandContext, "initRuntime" | "resolveBoardId" | "npubOrHexToHex" | "nsecToHexOrThrow">) {
  const { initRuntime, resolveBoardId, npubOrHexToHex, nsecToHexOrThrow } = context;
  const shareCmd = program
    .command("share")
    .description("Share board/task/event envelopes over NIP-17 and process inbox messages");

  shareCmd
    .command("board <board> <npubOrHex>")
    .description("Share a board envelope over NIP-17 DM")
    .action(async (boardRef: string, npubOrHex: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const entry = resolveBoardReference(config.boards, boardRef);
      if (!entry) {
        console.error(chalk.red(`Board not found: ${boardRef}`));
        process.exit(1);
      }
      try {
        const senderHex = nsecToHexOrThrow(config.nsec);
        const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderHex)));
        const envelope = buildBoardShareEnvelope(entry.id, entry.name, config.relays, { npub: senderNpub });
        await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: npubOrHexToHex(npubOrHex), relays: config.relays });
        console.log(chalk.green("✓ Board share sent."));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });

  shareCmd
    .command("task <taskId> <npubOrHex>")
    .description("Share a task envelope over NIP-17 DM")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--assignment", "Send as assignment request")
    .action(async (taskId: string, npubOrHex: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const task = await runtime.getTask(taskId, opts.board ? await resolveBoardId(opts.board, config) : undefined);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        const senderHex = nsecToHexOrThrow(config.nsec);
        const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderHex)));
        const envelope = buildTaskShareEnvelope({
          type: "task",
          title: task.title,
          note: task.note,
          priority: task.priority,
          dueISO: task.dueISO,
          dueDateEnabled: task.dueDateEnabled,
          dueTimeEnabled: task.dueTimeEnabled,
          recurrence: task.recurrence,
          reminders: task.reminders,
          documents: task.documents,
          sourceTaskId: task.id,
          assignment: opts.assignment === true ? true : undefined,
          assignees: task.assignees?.map((a) => ({ pubkey: a.pubkey })),
          relays: config.relays,
        }, { npub: senderNpub });
        await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: npubOrHexToHex(npubOrHex), relays: config.relays });
        console.log(chalk.green("✓ Task share sent."));
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  shareCmd
    .command("event <eventId> <npubOrHex>")
    .description("Share an event invite envelope over NIP-17 DM")
    .option("--board <id|name>", "Board the event belongs to (optional)")
    .action(async (eventId: string, npubOrHex: string, opts) => {
      await program.parseAsync(["node", "taskify", "event", "invite", eventId, npubOrHex, ...(opts.board ? ["--board", opts.board] : [])], { from: "user" });
    });

  shareCmd
    .command("respond-assignment <taskId> <accepted|declined|tentative> <npubOrHex>")
    .description("Send task assignment response over NIP-17 DM")
    .action(async (taskId: string, status: "accepted" | "declined" | "tentative", npubOrHex: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      try {
        const senderHex = nsecToHexOrThrow(config.nsec);
        const envelope = buildTaskAssignmentResponseEnvelope({ taskId, status, respondedAt: new Date().toISOString() });
        await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: npubOrHexToHex(npubOrHex), relays: config.relays });
        console.log(chalk.green("✓ Assignment response sent."));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });

  shareCmd
    .command("inbox")
    .description("Fetch NIP-17 share inbox messages")
    .option("--apply", "Apply actionable share messages (board join/task create)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const senderHex = nsecToHexOrThrow(config.nsec);
        const inbox = await fetchShareInboxNip17({ recipientSecretHex: senderHex, relays: config.relays, limit: 100 });
        if (opts.apply) {
          const processed = new Set(config.processedInboxRumorIds ?? []);
          for (const item of inbox) {
            if (processed.has(item.rumorId)) continue;
            if (item.envelope.item.type === "board") {
              const boardItem = item.envelope.item as { boardId: string; boardName?: string; relays?: string[] };
              const exists = config.boards.some((b) => b.id === boardItem.boardId);
              if (!exists) {
                config.boards.push({ id: boardItem.boardId, name: boardItem.boardName ?? boardItem.boardId, relays: boardItem.relays ?? config.relays });
              }
            }
            if (item.envelope.item.type === "task") {
              const taskItem = item.envelope.item as { title: string; note?: string; assignees?: Array<{ pubkey: string }> };
              await runtime.createTaskFull({
                boardId: runtime.getDefaultBoardId() ?? config.boards[0]?.id ?? "inbox",
                title: taskItem.title,
                note: taskItem.note ?? "",
                inboxItem: true,
                assignees: taskItem.assignees?.map((a) => ({ pubkey: a.pubkey })),
              });
            }
            if (item.envelope.item.type === "task-assignment-response") {
              await runtime.applyTaskAssignmentResponse(item.envelope.item.taskId, item.senderPubkey, item.envelope.item.status, item.envelope.item.respondedAt);
            }
            if (item.envelope.item.type === "event-rsvp-response") {
              await runtime.applyEventRsvpResponse(item.envelope.item.eventId, item.senderPubkey, item.envelope.item.status, item.envelope.item.respondedAt);
            }
            processed.add(item.rumorId);
          }
          config.processedInboxRumorIds = Array.from(processed).slice(-2000);
          await saveConfig(config);
        }
        if (opts.json) renderJson(inbox);
        else inbox.forEach((m) => console.log(`${chalk.cyan(m.envelope.item.type)} ${chalk.dim(m.senderPubkey.slice(0, 12))}`));
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

}
