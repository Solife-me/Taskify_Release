import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { renderTable } from "../render.js";
import type { CommandContext } from "./context.js";

export function registerInboxCommands(program: Command, context: Pick<CommandContext, "validateDue" | "validatePriority" | "warnShortTaskId" | "initRuntime" | "resolveBoardId" | "resolveColumnOrExit">) {
  const { validateDue, validatePriority, warnShortTaskId, initRuntime, resolveBoardId, resolveColumnOrExit } = context;
  // ---- inbox ----
  const inboxCmd = program
    .command("inbox")
    .description("Manage inbox tasks (quick capture and triage)");

  inboxCmd
    .command("list")
    .description("List inbox tasks (inboxItem: true)")
    .option("--board <id|name>", "Board to list from")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const tasks = await runtime.listTasks({ boardId, status: "open" });
        const inboxTasks = tasks.filter((t) => t.inboxItem === true);
        if (inboxTasks.length === 0) {
          console.log(chalk.dim("No inbox tasks."));
        } else {
          renderTable(inboxTasks, config.trustedNpubs);
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  inboxCmd
    .command("add <title>")
    .description("Capture a task to inbox (inboxItem: true)")
    .option("--board <id|name>", "Board to add to")
    .action(async (title: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const boardEntry = config.boards.find((b) => b.id === boardId)!;
      if (boardEntry.kind === "compound") {
        console.error(chalk.red("Cannot add tasks to a compound board."));
        process.exit(1);
      }
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        await runtime.createTaskFull({
          title,
          note: "",
          boardId,
          inboxItem: true,
        });
        console.log(chalk.green(`✓ Inbox: ${title}`));
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  inboxCmd
    .command("triage <taskId>")
    .description("Triage an inbox task: assign column, priority, due date")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--column <id|name>", "Column to assign")
    .option("--priority <1|2|3>", "Priority")
    .option("--due <YYYY-MM-DD>", "Due date")
    .option("--yes", "Apply flags directly without prompting")
    .action(async (taskId: string, opts) => {
      validateDue(opts.due);
      validatePriority(opts.priority);
      warnShortTaskId(taskId);
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const boardEntry = config.boards.find((b) => b.id === boardId)!;
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const task = await runtime.getTask(taskId, boardId);
        if (!task) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          exitCode = 1;
        } else {
          // Show task details
          console.log(chalk.bold(`\nTask: ${task.title}`));
          if (task.note) console.log(`  Note:     ${task.note}`);
          if (task.priority) console.log(`  Priority: ${task.priority}`);
          if (task.dueISO) console.log(`  Due:      ${task.dueISO.slice(0, 10)}`);
          console.log();

          let colId: string | null = null;
          let colName: string | null = null;
          let priority: 1 | 2 | 3 | null = null;
          let dueISO: string | null = null;

          if (opts.yes) {
            // Apply flags directly
            if (opts.column) {
              const col = resolveColumnOrExit(boardEntry, opts.column);
              if (col) { colId = col.id; colName = col.name; }
            }
            if (opts.priority) priority = parseInt(opts.priority, 10) as 1 | 2 | 3;
            if (opts.due) dueISO = opts.due;
          } else {
            const { createInterface } = await import("readline");
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const ask = (q: string): Promise<string> =>
              new Promise((resolve) => rl.question(q, (ans: string) => resolve(ans.trim())));

            const currentCol = task.column
              ? (boardEntry.columns?.find((c) => c.id === task.column)?.name ?? task.column)
              : "none";
            const colAns = await ask(`Column [${currentCol}]: `);
            if (colAns) {
              const col = resolveColumnOrExit(boardEntry, colAns);
              if (col) { colId = col.id; colName = col.name; }
              else process.stderr.write(`⚠ Column not found — skipping column change\n`);
            }

            const priAns = await ask(`Priority [${task.priority ?? "none"}]: `);
            if (priAns && ["1", "2", "3"].includes(priAns)) {
              priority = parseInt(priAns, 10) as 1 | 2 | 3;
            }

            const dueAns = await ask(`Due date [${task.dueISO ? task.dueISO.slice(0, 10) : "none"}]: `);
            if (dueAns && /^\d{4}-\d{2}-\d{2}$/.test(dueAns)) {
              dueISO = dueAns;
            } else if (dueAns) {
              process.stderr.write(`⚠ Invalid due date format — skipping\n`);
            }

            rl.close();
          }

          const patch: Record<string, unknown> = { inboxItem: false };
          if (colId !== null) patch.columnId = colId;
          if (priority !== null) patch.priority = priority;
          if (dueISO !== null) patch.dueISO = dueISO;

          const updated = await runtime.updateTask(taskId, boardId, patch);
          if (!updated) {
            console.error(chalk.red("Failed to update task"));
            exitCode = 1;
          } else {
            const parts: string[] = [];
            if (colName) parts.push(`column: ${colName}`);
            if (priority) parts.push(`priority: ${priority}`);
            if (dueISO) parts.push(`due: ${dueISO}`);
            const detail = parts.length > 0 ? `  → ${parts.join(", ")}` : "";
            console.log(chalk.green(`✓ Triaged: ${updated.title}${detail}`));
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
