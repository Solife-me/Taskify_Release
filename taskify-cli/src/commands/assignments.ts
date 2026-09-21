import { hexToBytes } from "@noble/hashes/utils.js";
import chalk from "chalk";
import type { Command } from "commander";
import { getPublicKey,nip19 } from "nostr-tools";
import {
buildTaskShareEnvelope
} from "taskify-core";
import { loadConfig } from "../config.js";
import { sendShareEnvelopeNip17 } from "../shared/shareTransport.js";
import type { CommandContext } from "./context.js";

export function registerAssignmentsCommands(program: Command, context: Pick<CommandContext, "warnShortTaskId" | "initRuntime" | "resolveBoardId" | "npubOrHexToHex" | "nsecToHexOrThrow">) {
  const { warnShortTaskId, initRuntime, resolveBoardId, npubOrHexToHex, nsecToHexOrThrow } = context;
  // ---- assign ----
  program
    .command("assign <taskId> <npubOrHex>")
    .description("Assign a task to a user (npub or hex pubkey)")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--notify", "Send assignment DM over NIP-17")
    .action(async (taskId: string, npubOrHex: string, opts) => {
      warnShortTaskId(taskId);
      const hex = npubOrHexToHex(npubOrHex);
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const task = await runtime.getTask(taskId, boardId);
        if (!task) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          exitCode = 1;
        } else {
          const existing = task.assignees ?? [];
          if (existing.some((a) => a.pubkey === hex)) {
            console.log(chalk.dim(`Already assigned: ${npubOrHex}`));
          } else {
            const updated = await runtime.updateTask(taskId, boardId, {
              assignees: [...existing, { pubkey: hex }],
            });
            if (!updated) {
              console.error(chalk.red("Failed to update task"));
              exitCode = 1;
            } else {
              console.log(chalk.green(`✓ Assigned to: ${updated.title}`));
              if (opts.notify) {
                const senderHex = nsecToHexOrThrow(config.nsec);
                const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderHex)));
                const envelope = buildTaskShareEnvelope({
                  type: "task",
                  title: updated.title,
                  note: updated.note,
                  priority: updated.priority,
                  dueISO: updated.dueISO,
                  dueDateEnabled: updated.dueDateEnabled,
                  dueTimeEnabled: updated.dueTimeEnabled,
                  sourceTaskId: updated.id,
                  assignment: true,
                  assignees: (updated.assignees ?? []).map((a) => ({ pubkey: a.pubkey })),
                  relays: config.relays,
                }, { npub: senderNpub });
                await sendShareEnvelopeNip17({ envelope, senderSecretHex: senderHex, recipientPubkeyHex: hex, relays: config.relays });
                console.log(chalk.dim("  ↳ assignment request DM sent"));
              }
            }
          }
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  // ---- unassign ----
  program
    .command("unassign <taskId> <npubOrHex>")
    .description("Remove an assignee from a task")
    .option("--board <id|name>", "Board the task belongs to")
    .action(async (taskId: string, npubOrHex: string, opts) => {
      warnShortTaskId(taskId);
      const hex = npubOrHexToHex(npubOrHex);
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const task = await runtime.getTask(taskId, boardId);
        if (!task) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          exitCode = 1;
        } else {
          const filtered = (task.assignees ?? []).filter((a) => a.pubkey !== hex);
          const updated = await runtime.updateTask(taskId, boardId, {
            assignees: filtered,
          });
          if (!updated) {
            console.error(chalk.red("Failed to update task"));
            exitCode = 1;
          } else {
            console.log(chalk.green(`✓ Unassigned from: ${updated.title}`));
          }
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

}
