import chalk from "chalk";
import type { Command } from "commander";
import { join } from "node:path";
import {
normalizeTaskRecurrence,
normalizeTaskReminders
} from "taskify-core";
import { CONFIG_DIR,loadConfig } from "../config.js";
import { renderJson } from "../render.js";
import { createFileAgentIdempotencyStore } from "../shared/agentIdempotency.js";
import { agentSuccess,writeAgentJson } from "../shared/agentOutput.js";
import { resolveCliLocation } from "../shared/cliLocation.js";
import type { CommandContext } from "./context.js";

export function registerTaskMutationsCommands(program: Command, context: Pick<CommandContext, "warnShortTaskId" | "resolveTaskIdByTitle" | "VALID_REMINDER_PRESETS" | "parseJsonOption" | "parseReminderOption" | "normalizeAssigneeArgs" | "initRuntime" | "resolveBoardId" | "mergeAttachmentDocuments" | "resolveAttachmentDocuments" | "useHumanOutput" | "CliCommandError" | "requireWriteIdentity" | "validateCoreDue" | "validateCorePriority" | "writeCoreFailure" | "profilePubkey">) {
  const { warnShortTaskId, resolveTaskIdByTitle, VALID_REMINDER_PRESETS, parseJsonOption, parseReminderOption, normalizeAssigneeArgs, initRuntime, resolveBoardId, mergeAttachmentDocuments, resolveAttachmentDocuments, useHumanOutput, CliCommandError, requireWriteIdentity, validateCoreDue, validateCorePriority, writeCoreFailure, profilePubkey } = context;
  // ---- remind ----
  program
    .command("remind <taskId> <presets...>")
    .description("Set device-local reminders on a task. Presets: 0h, 5m, 15m, 30m, 1h, 1d, 1w")
    .option("--board <id|name>", "Board the task belongs to")
    .action(async (taskId: string, presets: string[], opts) => {
      warnShortTaskId(taskId);
      const invalid = presets.filter((p) => !VALID_REMINDER_PRESETS.has(p));
      if (invalid.length > 0) {
        console.error(
          chalk.red(
            `Invalid reminder preset(s): ${invalid.join(", ")}. Valid: ${[...VALID_REMINDER_PRESETS].join(", ")}`,
          ),
        );
        process.exit(1);
      }
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        // Try to fetch task title for a nicer success message
        let title = taskId.slice(0, 8);
        try {
          const hasSingleOrSpecifiedBoard = opts.board || config.boards.length === 1;
          if (hasSingleOrSpecifiedBoard) {
            const boardId = await resolveBoardId(opts.board, config);
            const task = await runtime.getTask(taskId, boardId);
            if (task?.title) title = task.title;
          }
        } catch { /* title lookup is best-effort */ }
        await runtime.remindTask(taskId, presets as Parameters<typeof runtime.remindTask>[1]);
        console.log(
          chalk.green(`✓ Reminders set for ${title}: ${presets.join(", ")} (device-local only, will not sync)`),
        );
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  // ---- add ----
  program
    .command("add <title>")
    .description("Create a new task")
    .option("--in <Board/List>", "Board or Board/List path")
    .option("--board <id|name>", "Board to add to (required if multiple boards configured)")
    .option("--due <YYYY-MM-DD>", "Due date")
    .option("--priority <1|2|3>", "Priority (1=low, 3=high)")
    .option("--note <text>", "Note")
    .option(
      "--subtask <text>",
      "Add a subtask (repeatable)",
      (val: string, arr: string[]) => [...arr, val],
      [] as string[],
    )
    .option("--column <id|name>", "Column to place task in")
    .option("--recurrence-json <json>", "Recurrence object JSON (shared contract shape)")
    .option("--reminders <csv>", "Reminder presets csv (e.g. 15m,1h)")
    .option("--assignee <npubOrHex>", "Assign to pubkey/npub (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--assign-me", "Assign the task to the active profile")
    .option("--documents-json <json>", "Documents/attachments array JSON")
    .option("--attach <path>", "Attach local file/image (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--file-server <url>", "Encrypted file server override for shared attachment uploads")
    .option("--due-time <HH:MM>", "Due time (combine with --due to form ISO datetime, sets dueTimeEnabled)")
    .option("--timezone <iana>", "IANA timezone for due time (e.g. America/New_York)")
    .option("--hidden-until <ISO>", "Hide task until this ISO datetime")
    .option("--idempotency-key <key>", "Stable retry key; repeated calls return the original task")
    .option("--json", "Output created task as JSON")
    .option("--human", "Render readable text instead of JSON")
    .action(async (title: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const human = useHumanOutput(opts);
      let location: ReturnType<typeof resolveCliLocation>;
      try {
        if (!title.trim()) throw new CliCommandError("VALIDATION_ERROR", "Task title cannot be empty.");
        validateCoreDue(opts.due);
        validateCorePriority(opts.priority);
        location = resolveCliLocation(config, {
          in: opts.in,
          board: opts.board,
          list: opts.column,
          intent: "write",
        });
        requireWriteIdentity(config);
      } catch (error) {
        process.exitCode = writeCoreFailure("task.create", error, human);
        return;
      }
      const boardId = location.boardId;
      const boardEntry = config.boards.find((b) => b.id === boardId)!;

      if (boardEntry.kind === "compound") {
        process.exitCode = writeCoreFailure("task.create", new Error("Compound boards are read-only; choose a child board."), human);
        return;
      }

      if (boardEntry.kind === "lists" && (!boardEntry.columns || boardEntry.columns.length === 0)) {
        process.exitCode = writeCoreFailure("task.create", new Error(`Board "${boardEntry.name}" has no lists yet.`), human);
        return;
      }

      if (boardEntry.kind === "week" && !opts.due) {
        process.exitCode = writeCoreFailure("task.create", new Error(`Week board "${boardEntry.name}" requires --due <YYYY-MM-DD>.`), human);
        return;
      }

      const resolvedColumnId = location.listId;
      const resolvedColumnName = location.listName;

      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const idempotencyStore = createFileAgentIdempotencyStore(join(CONFIG_DIR, "idempotency.json"));
        const idempotencyKey = opts.idempotencyKey
          ? `${config.selectedProfile}:${boardId}:${String(opts.idempotencyKey).trim()}`
          : undefined;
        let reservedTaskId: string | undefined;
        if (idempotencyKey) {
          const reservation = await idempotencyStore.reserve(idempotencyKey, crypto.randomUUID());
          reservedTaskId = reservation.taskId;
          if (!reservation.created) {
            const existing = await runtime.getTask(reservation.taskId, boardId);
            if (existing) {
              if (!human) {
                writeAgentJson(agentSuccess("task.create", {
                  task: existing,
                  location,
                  idempotentReplay: true,
                }, { profile: config.selectedProfile }));
              } else {
                console.log(chalk.green(`✓ Already created: ${existing.title} (${existing.id})`));
              }
              return;
            }
          }
        }
        const subtasks = (opts.subtask as string[]).map((text) => ({
          id: crypto.randomUUID(),
          title: text,
          completed: false,
        }));
        const recurrence = normalizeTaskRecurrence(parseJsonOption("--recurrence-json", opts.recurrenceJson));
        const reminders = normalizeTaskReminders(parseReminderOption(opts.reminders));
        const documents = await resolveAttachmentDocuments({ files: opts.attach as string[], boardId, config, fileServer: opts.fileServer, documentsJson: opts.documentsJson });
        const assigneeArgs = [...(opts.assignee as string[])];
        if (opts.assignMe) {
          const identity = profilePubkey(config);
          if (!identity) throw new Error("The active profile has no valid Nostr identity for --assign-me.");
          assigneeArgs.push(identity.hex);
        }
        const assignees = normalizeAssigneeArgs(assigneeArgs);
        let dueISO = opts.due as string | undefined;
        let dueTimeEnabled: boolean | undefined;
        if (opts.dueTime) {
          if (dueISO) {
            dueISO = `${dueISO}T${opts.dueTime}:00`;
          }
          dueTimeEnabled = true;
        }
        const task = await runtime.createTaskFull({
          taskId: reservedTaskId,
          title,
          note: opts.note ?? "",
          boardId,
          dueISO,
          priority: opts.priority ? (parseInt(opts.priority, 10) as 1 | 2 | 3) : undefined,
          subtasks: subtasks.length > 0 ? subtasks : undefined,
          columnId: resolvedColumnId,
          recurrence,
          reminders: reminders as any,
          documents: documents as any,
          assignees,
          dueTimeEnabled,
          dueTimeZone: opts.timezone,
          hiddenUntilISO: opts.hiddenUntil,
        });
        if (!human) {
          writeAgentJson(agentSuccess("task.create", {
            task,
            location,
            idempotentReplay: false,
          }, { profile: config.selectedProfile }));
        } else {
          const colStr = task.column
            ? chalk.dim(`  [col: ${task.column}${resolvedColumnName ? ` (${resolvedColumnName})` : ""}]`)
            : "";
          console.log(
            chalk.green(`✓ Created: ${task.title}`) + colStr,
          );
          if (subtasks.length > 0) {
            console.log(chalk.dim(`  Subtasks: ${subtasks.map((s) => s.title).join(", ")}`));
          }
        }
      } catch (err) {
        exitCode = writeCoreFailure("task.create", err, human);
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  // ---- done ----
  program
    .command("done [taskId]")
    .description("Mark a task as done (accepts 8-char prefix, full UUID, or full recurring instance ID)")
    .option("--in <Board/List>", "Board or Board/List path")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--title <title>", "Resolve task by title match (use with --due for recurring instances)")
    .option("--due <YYYY-MM-DD>", "Filter by due date when resolving by title")
    .option("--json", "Output updated task as JSON")
    .option("--human", "Render readable text instead of JSON")
    .action(async (taskId: string | undefined, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const human = useHumanOutput(opts);
      let location: ReturnType<typeof resolveCliLocation>;
      try {
        location = resolveCliLocation(config, {
          in: opts.in,
          board: opts.board,
          intent: "read",
          ignoreDefaultList: true,
        });
        validateCoreDue(opts.due);
        requireWriteIdentity(config);
      } catch (error) {
        process.exitCode = writeCoreFailure("task.done", error, human);
        return;
      }
      const boardId = location.boardId;
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        let resolvedId = taskId;
        if (!resolvedId) {
          if (!opts.title) {
            throw new Error("Provide a taskId or --title to identify the task.");
          }
          resolvedId = await resolveTaskIdByTitle(runtime, opts.title, opts.due, boardId, config);
        } else {
          if (human) warnShortTaskId(resolvedId);
        }
        const task = await runtime.setTaskStatus(resolvedId, "done", boardId);
        if (!task) {
          throw new Error(`Task not found: ${resolvedId}`);
        } else if (!human) {
          writeAgentJson(agentSuccess("task.done", { task, location }, { profile: config.selectedProfile }));
        } else {
          console.log(chalk.green(`✓ Marked done: ${task.title}`));
        }
      } catch (err) {
        exitCode = writeCoreFailure("task.done", err, human);
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  // ---- reopen ----
  program
    .command("reopen [taskId]")
    .description("Reopen a completed task (accepts 8-char prefix, full UUID, or full recurring instance ID)")
    .option("--in <Board/List>", "Board or Board/List path")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--title <title>", "Resolve task by title match (use with --due for recurring instances)")
    .option("--due <YYYY-MM-DD>", "Filter by due date when resolving by title")
    .option("--json", "Output updated task as JSON")
    .option("--human", "Render readable text instead of JSON")
    .action(async (taskId: string | undefined, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const human = useHumanOutput(opts);
      let location: ReturnType<typeof resolveCliLocation>;
      try {
        location = resolveCliLocation(config, {
          in: opts.in,
          board: opts.board,
          intent: "read",
          ignoreDefaultList: true,
        });
        validateCoreDue(opts.due);
        requireWriteIdentity(config);
      } catch (error) {
        process.exitCode = writeCoreFailure("task.reopen", error, human);
        return;
      }
      const boardId = location.boardId;
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        let resolvedId = taskId;
        if (!resolvedId) {
          if (!opts.title) {
            throw new Error("Provide a taskId or --title to identify the task.");
          }
          resolvedId = await resolveTaskIdByTitle(runtime, opts.title, opts.due, boardId, config);
        } else {
          if (human) warnShortTaskId(resolvedId);
        }
        const task = await runtime.setTaskStatus(resolvedId, "open", boardId);
        if (!task) {
          throw new Error(`Task not found: ${resolvedId}`);
        } else if (!human) {
          writeAgentJson(agentSuccess("task.reopen", { task, location }, { profile: config.selectedProfile }));
        } else {
          console.log(chalk.green(`✓ Reopened: ${task.title}`));
        }
      } catch (err) {
        exitCode = writeCoreFailure("task.reopen", err, human);
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  // ---- delete ----
  program
    .command("delete <taskId>")
    .description("Delete a task (publishes status=deleted to Nostr; accepts 8-char prefix or full UUID)")
    .option("--in <Board/List>", "Board or Board/List path")
    .option("--board <id|name>", "Board the task belongs to")
    .option("-y, --force", "Confirm deletion without a prompt")
    .option("--json", "Output deleted task as JSON")
    .option("--human", "Render readable text instead of JSON")
    .action(async (taskId: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const human = useHumanOutput(opts);
      if (human) warnShortTaskId(taskId);
      let location: ReturnType<typeof resolveCliLocation>;
      try {
        location = resolveCliLocation(config, {
          in: opts.in,
          board: opts.board,
          intent: "read",
          ignoreDefaultList: true,
        });
        requireWriteIdentity(config);
        if (!human && !opts.force) {
          throw new CliCommandError(
            "CONFIRMATION_REQUIRED",
            "Deletion requires explicit confirmation. Retry with --force.",
          );
        }
      } catch (error) {
        process.exitCode = writeCoreFailure("task.delete", error, human);
        return;
      }
      const boardId = location.boardId;
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        // Fetch task first so we can show the title in the prompt
        const task = await runtime.getTask(taskId, boardId);
        if (!task) {
          throw new Error(`Task not found: ${taskId}`);
        } else {
          if (!opts.force) {
            const { createInterface } = await import("readline");
            const confirmed = await new Promise<boolean>((resolve) => {
              const rl = createInterface({ input: process.stdin, output: process.stdout });
              rl.question(
                `Delete task: ${task.title} (${task.id.slice(0, 8)})? [y/N] `,
                (ans: string) => {
                  rl.close();
                  resolve(ans === "y" || ans === "Y");
                },
              );
            });
            if (!confirmed) {
              console.log("Aborted.");
              await runtime.disconnect();
              process.exit(0);
            }
          }
          const deleted = await runtime.deleteTask(taskId, boardId);
          if (!deleted) {
            throw new Error(`Task not found: ${taskId}`);
          } else if (!human) {
            writeAgentJson(agentSuccess("task.delete", { task: deleted, location }, { profile: config.selectedProfile }));
          } else {
            console.log(chalk.green(`✓ Deleted: ${deleted.title}`));
          }
        }
      } catch (err) {
        exitCode = writeCoreFailure("task.delete", err, human);
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  // ---- subtask ----
  program
    .command("subtask <taskId> <subtaskRef>")
    .description(
      "Toggle a subtask done/incomplete. subtaskRef can be a 1-based index or partial title match.",
    )
    .option("--board <id|name>", "Board the task belongs to")
    .option("--done", "Mark subtask completed")
    .option("--reopen", "Mark subtask incomplete")
    .option("--json", "Output updated full task as JSON")
    .action(async (taskId: string, subtaskRef: string, opts) => {
      if (!opts.done && !opts.reopen) {
        console.error(chalk.red("Specify --done or --reopen."));
        process.exit(1);
      }
      if (opts.done && opts.reopen) {
        console.error(chalk.red("Specify only one of --done or --reopen."));
        process.exit(1);
      }
      warnShortTaskId(taskId);
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const completed = !!opts.done;
        const task = await runtime.toggleSubtask(taskId, boardId, subtaskRef, completed);
        if (!task) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          exitCode = 1;
        } else if (opts.json) {
          renderJson(task);
        } else {
          // Find the subtask that was toggled (by ref) to display its title
          const subtasks = task.subtasks ?? [];
          const indexNum = parseInt(subtaskRef, 10);
          let found: { title: string; completed?: boolean } | undefined;
          if (!isNaN(indexNum) && indexNum >= 1 && indexNum <= subtasks.length) {
            found = subtasks[indexNum - 1];
          } else {
            const lower = subtaskRef.toLowerCase();
            found = subtasks.find((s) => s.title.toLowerCase().includes(lower));
          }
          const check = completed ? "x" : " ";
          const stitle = found?.title ?? subtaskRef;
          console.log(chalk.green(`✓ Subtask [${check}] ${stitle}  (task: ${task.title})`));
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  // ---- update ----
  program
    .command("update <taskId>")
    .description("Update task fields (accepts 8-char prefix or full UUID)")
    .option("--in <Board/List>", "Board or Board/List path")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--title <t>", "New title")
    .option("--due <d>", "New due date")
    .option("--priority <p>", "New priority")
    .option("--note <n>", "New note")
    .option("--column <id|name>", "Move task to a different column")
    .option("--recurrence-json <json>", "Recurrence object JSON (shared contract shape)")
    .option("--reminders <csv>", "Reminder presets csv (e.g. 15m,1h)")
    .option("--assignee <npubOrHex>", "Replace assignees with pubkey/npub values (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--documents-json <json>", "Replace documents/attachments with array JSON")
    .option("--attach <path>", "Append local file/image attachment (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--remove-attachment <ref>", "Remove attachment by 1-based index or partial name (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--replace-attachments", "Replace all existing attachments with provided attachment inputs")
    .option("--file-server <url>", "Encrypted file server override for shared attachment uploads")
    .option("--due-time <HH:MM>", "Due time (combine with --due to form ISO datetime, sets dueTimeEnabled)")
    .option("--timezone <iana>", "IANA timezone for due time (e.g. America/New_York)")
    .option("--hidden-until <ISO>", "Hide task until this ISO datetime")
    .option("--json", "Output updated task as JSON")
    .option("--human", "Render readable text instead of JSON")
    .action(async (taskId: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const human = useHumanOutput(opts);
      if (human) warnShortTaskId(taskId);
      let location: ReturnType<typeof resolveCliLocation>;
      try {
        validateCoreDue(opts.due);
        validateCorePriority(opts.priority);
        location = resolveCliLocation(config, {
          in: opts.in,
          board: opts.board,
          list: opts.column,
          intent: opts.column || opts.in?.includes("/") ? "write" : "read",
          ignoreDefaultList: !opts.column && !opts.in?.includes("/"),
        });
        requireWriteIdentity(config);
      } catch (error) {
        process.exitCode = writeCoreFailure("task.update", error, human);
        return;
      }
      const boardId = location.boardId;
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const patch: Record<string, unknown> = {};
        if (opts.title !== undefined) patch.title = opts.title;
        if (opts.priority !== undefined) patch.priority = parseInt(opts.priority, 10);
        if (opts.note !== undefined) patch.note = opts.note;
        if (opts.recurrenceJson !== undefined) patch.recurrence = normalizeTaskRecurrence(parseJsonOption("--recurrence-json", opts.recurrenceJson)) ?? null;
        if (opts.reminders !== undefined) patch.reminders = normalizeTaskReminders(parseReminderOption(opts.reminders)) ?? null;
        if (opts.documentsJson !== undefined || ((opts.attach as string[]).length > 0) || ((opts.removeAttachment as string[]).length > 0) || opts.replaceAttachments) {
          const existingTask = await runtime.getTask(taskId, boardId);
          if (!existingTask) {
            throw new Error(`Task not found: ${taskId}`);
          }
          patch.documents = await mergeAttachmentDocuments({
            existing: existingTask.documents as Record<string, unknown>[] | undefined,
            files: opts.attach as string[],
            boardId,
            config,
            fileServer: opts.fileServer,
            documentsJson: opts.documentsJson,
            removeRefs: opts.removeAttachment as string[],
            replace: !!opts.replaceAttachments,
          }) ?? null;
        }
        if ((opts.assignee as string[]).length > 0) patch.assignees = normalizeAssigneeArgs(opts.assignee as string[]) ?? [];
        if (opts.column !== undefined || opts.in?.includes("/")) patch.columnId = location.listId;
        // due / due-time combination
        let dueISO = opts.due as string | undefined;
        if (opts.dueTime) {
          if (dueISO) {
            dueISO = `${dueISO}T${opts.dueTime}:00`;
          }
          patch.dueTimeEnabled = true;
        }
        if (dueISO !== undefined) patch.dueISO = dueISO;
        if (opts.timezone !== undefined) patch.dueTimeZone = opts.timezone;
        if (opts.hiddenUntil !== undefined) patch.hiddenUntilISO = opts.hiddenUntil;
        const task = await runtime.updateTask(taskId, boardId, patch);
        if (!task) {
          throw new Error(`Task not found: ${taskId}`);
        } else if (!human) {
          writeAgentJson(agentSuccess("task.update", { task, location }, { profile: config.selectedProfile }));
        } else {
          console.log(chalk.green(`✓ Updated: ${task.id.slice(0, 8)}  ${task.title}  ${task.boardId}`));
        }
      } catch (err) {
        exitCode = writeCoreFailure("task.update", err, human);
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });


}
