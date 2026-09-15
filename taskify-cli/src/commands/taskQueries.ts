import chalk from "chalk";
import type { Command } from "commander";
import { createInterface } from "readline";
import {
resolveBoardReference
} from "taskify-core";
import { loadConfig,type BoardEntry } from "../config.js";
import { renderJson,renderTable,renderTaskCard } from "../render.js";
import { agentSuccess,writeAgentJson } from "../shared/agentOutput.js";
import { resolveCliLocation } from "../shared/cliLocation.js";
import { formatAvailableColumns,resolveBoardColumn } from "../shared/columnResolution.js";
import type { CommandContext } from "./context.js";

export function registerTaskQueriesCommands(program: Command, context: Pick<CommandContext, "warnShortTaskId" | "initRuntime" | "resolveBoardId" | "useHumanOutput" | "CliCommandError" | "writeCoreFailure" | "profilePubkey" | "resolveColumnOrExit">) {
  const { warnShortTaskId, initRuntime, resolveBoardId, useHumanOutput, CliCommandError, writeCoreFailure, profilePubkey, resolveColumnOrExit } = context;
  // ---- list ----
  program
    .command("list")
    .description("List tasks (use --all to see full board)")
    .option("--in <Board/List>", "Board or Board/List path")
    .option("--board <id|name>", "Filter by board (UUID or name)")
    .option("--status <status>", "Filter: open (default), done, or any", "open")
    .option("--column <id|name>", "Filter by column id or name (use day names for week boards)")
    .option("--refresh", "Bypass cache and fetch live from relay")
    .option("--no-cache", "Do not fall back to stale cache if relay returns empty")
    .option("--json", "Output as JSON")
    .option("--human", "Render a table instead of JSON")
    .option("--mine", "Only tasks assigned to the active profile")
    .option("--all", "Show all columns on the board")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      const human = useHumanOutput(opts);
      const coreMode = !human || Boolean(opts.in || opts.mine);
      let exitCode = 0;
      try {
        if (coreMode) {
          if (!["open", "done", "any"].includes(opts.status)) {
            throw new CliCommandError(
              "VALIDATION_ERROR",
              `Invalid --status: "${opts.status}". Must be open, done, or any.`,
            );
          }
          const location = resolveCliLocation(config, {
            in: opts.in,
            board: opts.board,
            list: opts.column,
            intent: "read",
            ignoreDefaultList: Boolean(opts.all),
          });
          let tasks = await runtime.listTasks({
            boardId: location.boardId,
            status: opts.status as "open" | "done" | "any",
            columnId: opts.all ? undefined : location.listId,
            refresh: Boolean(opts.refresh),
            noCache: !opts.cache,
          });
          if (opts.mine) {
            const identity = profilePubkey(config);
            if (!identity) throw new Error("The active profile has no valid Nostr identity for --mine.");
            tasks = tasks.filter((task) => (task.assignees ?? []).some((assignee) =>
              (typeof assignee === "string" ? assignee : assignee.pubkey).toLocaleLowerCase() === identity.hex));
          }
          if (!human) {
            writeAgentJson(agentSuccess("task.list", {
              tasks,
              count: tasks.length,
              location,
            }, { profile: config.selectedProfile, filters: { status: opts.status, mine: Boolean(opts.mine) } }));
          } else if (tasks.length === 0) {
            console.log(chalk.dim("No tasks found."));
          } else {
            const board = config.boards.find((candidate) => candidate.id === location.boardId);
            renderTable(tasks, config.trustedNpubs, location.listName, board?.columns);
          }
          return;
        }
        let columnId: string | undefined;
        let columnName: string | undefined;
        let resolvedBoardId: string | undefined;
        let boardEntry: BoardEntry | undefined;

        // Resolve board
        if (opts.board) {
          resolvedBoardId = await resolveBoardId(opts.board, config);
          boardEntry = config.boards.find((b) => b.id === resolvedBoardId);
        } else if (config.boards.length === 1) {
          resolvedBoardId = config.boards[0].id;
          boardEntry = config.boards[0];
        } else if (config.defaultBoard) {
          // Try to resolve defaultBoard
          const defaultEntry = resolveBoardReference(config.boards, config.defaultBoard);
          if (defaultEntry) {
            resolvedBoardId = defaultEntry.id;
            boardEntry = defaultEntry;
          }
        }

        // Priority: explicit --column > --all > defaultList > interactive
        if (opts.column) {
          // Option A: explicit --column override (highest priority)
          const singleBoardId = resolvedBoardId
            ?? (config.boards.length === 1 ? config.boards[0].id : undefined);
          if (!singleBoardId) {
            console.error(chalk.red("--column requires --board when multiple boards are configured"));
            process.exit(1);
          }
          const be = config.boards.find((b) => b.id === singleBoardId)!;
          const resolved = resolveColumnOrExit(be, opts.column);
          columnId = resolved.id;
          columnName = resolved.name;
        } else if (opts.all) {
          // Option B: --all flag → no column filter
          // resolvedBoardId stays as-is, no columnId set
        } else if (config.defaultList) {
          // Option C: use defaultList from profile config
          const parts = config.defaultList.trim().split(/\s+/);
          if (parts.length >= 2) {
            const listBoardName = parts[0];
            const listName = parts.slice(1).join(" ");
            // Resolve the board
            if (!resolvedBoardId || !boardEntry) {
              const match = resolveBoardReference(config.boards, listBoardName);
              if (match) {
                resolvedBoardId = match.id;
                boardEntry = match;
              }
            }
            if (!boardEntry) {
              console.error(chalk.red(`Could not resolve board "${listBoardName}" from defaultList.`));
              process.exit(1);
            }
            if (!config.boards.some(b => b.id === boardEntry!.id)) {
              console.error(chalk.red(`Board "${boardEntry!.name}" not found in local config.`));
              process.exit(1);
            }
            // Sync columns if needed
            const syncedAt = boardEntry.syncedAt ?? 0;
            if (!boardEntry.columns || Date.now() - syncedAt > 30 * 60 * 1000) {
              try {
                await runtime.syncBoard(boardEntry.id);
                // Refresh boardEntry from config after sync
                boardEntry = config.boards.find(b => b.id === boardEntry!.id) ?? boardEntry;
              } catch { /* non-fatal */ }
            }
            const resolved = resolveBoardColumn(boardEntry, listName);
            if (resolved.ok) {
              columnId = resolved.column.id;
              columnName = resolved.column.name;
            } else {
              console.error(chalk.red(`Column "${listName}" not found on "${boardEntry.name}".`));
              console.error(chalk.dim(`Available columns: ${formatAvailableColumns(boardEntry.columns || [])}`));
              process.exit(1);
            }
          }
        } else if (boardEntry) {
          // Option D: interactive selector
          // Ensure columns are available
          let columns = boardEntry.columns;
          const syncedAt = boardEntry.syncedAt ?? 0;
          if (!columns || Date.now() - syncedAt > 30 * 60 * 1000) {
            try {
              await runtime.syncBoard(boardEntry.id);
              boardEntry = config.boards.find(b => b.id === boardEntry!.id) ?? boardEntry;
              columns = boardEntry.columns;
            } catch { /* use whatever we have */ }
          }

          // Quick fetch task counts per column for display
          const tempColCounts: { id: string; name: string; openCount: number; totalCount: number }[] = [];
          const sampleTasks = await runtime.listTasks({ boardId: boardEntry.id, status: "any" });

          if (columns && columns.length > 0) {
            for (const col of columns) {
              const colTasks = sampleTasks.filter(t => t.column === col.id);
              tempColCounts.push({
                id: col.id,
                name: col.name,
                openCount: colTasks.filter(t => !t.completed).length,
                totalCount: colTasks.length,
              });
            }

            console.log(`\nAvailable columns on ${chalk.bold(boardEntry.name)}:`);
            tempColCounts.forEach((c, i) => {
              console.log(`  ${chalk.cyan(`${i + 1}.`)} ${chalk.bold(c.name.padEnd(18))}`
                + ` ${chalk.dim(`open: ${String(c.openCount).padStart(3)}  total: ${String(c.totalCount).padStart(3)}`)}`);
            });
            console.log(`  ${chalk.cyan(`${tempColCounts.length + 1}.`)} all (show entire board)`);

            // Interactive prompt
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer: string = await new Promise((resolve) => {
                rl.question(chalk.dim("Select column (number, name, or 'all'): "), (ans) => resolve(ans.trim()));
              });

              if (answer.toLowerCase() === "all") {
                // All columns — no columnId
              } else {
                const num = parseInt(answer, 10);
                if (!isNaN(num) && num >= 1 && num <= tempColCounts.length) {
                  const selected = tempColCounts[num - 1];
                  columnId = selected.id;
                  columnName = selected.name;
                } else {
                  // Try matching by name
                  const match = tempColCounts.find(c => c.name.toLowerCase() === answer.toLowerCase());
                  if (match) {
                    columnId = match.id;
                    columnName = match.name;
                  } else {
                    console.error(chalk.red(`Could not resolve column "${answer}".`));
                    process.exit(1);
                  }
                }
              }
            } finally {
              rl.close();
            }
          } else {
            // No columns cached — use defaultBoard's raw approach
            // Fetch all tasks on the default board
            if (resolvedBoardId) {
              // no column filter
            }
          }
        }

        const tasks = await runtime.listTasks({
          boardId: resolvedBoardId,
          status: opts.status as "open" | "done" | "any",
          columnId,
          refresh: !!opts.refresh,
          noCache: !opts.cache,
        });
        if (opts.json) {
          renderJson(tasks);
        } else {
          if (tasks.length === 0) {
            console.log(chalk.dim("No tasks found."));
          } else {
            renderTable(tasks, config.trustedNpubs, columnName, boardEntry?.columns);
          }
        }
      } catch (err) {
        exitCode = coreMode ? writeCoreFailure("task.list", err, human) : 1;
        if (!coreMode) console.error(chalk.red(String(err)));
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  // ---- upcoming ----
  program
    .command("upcoming")
    .description("Show open tasks due within N days")
    .option("--days <n>", "Number of days ahead (default: 14)")
    .option("--board <id|name>", "Filter to a specific board")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const days = opts.days ? parseInt(opts.days, 10) : 14;
        const resolvedBoardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
        const allTasks = await runtime.listTasks({ boardId: resolvedBoardId, status: "open" });

        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        const upcoming = allTasks.filter(
          (t) => t.dueDateEnabled === true && t.dueISO && t.dueISO >= todayStr && t.dueISO <= cutoffStr,
        );

        // Sort: primary = dueISO asc, secondary = priority desc (3=high)
        upcoming.sort((a, b) => {
          if (a.dueISO < b.dueISO) return -1;
          if (a.dueISO > b.dueISO) return 1;
          return (a.priority ?? 0) === (b.priority ?? 0) ? 0 : (b.priority ?? 0) - (a.priority ?? 0);
        });

        if (opts.json) {
          renderJson(upcoming);
        } else if (upcoming.length === 0) {
          console.log(chalk.dim(`No tasks due in the next ${days} days.`));
        } else {
          // Group by dueISO date prefix
          const groups = new Map<string, typeof upcoming>();
          for (const t of upcoming) {
            const day = t.dueISO.slice(0, 10);
            if (!groups.has(day)) groups.set(day, []);
            groups.get(day)!.push(t);
          }
          for (const [day, tasks] of groups) {
            console.log(chalk.bold(`\n${day}`));
            renderTable(tasks, config.trustedNpubs);
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

  // ---- show ----
  program
    .command("show <taskId>")
    .description("Show full task details (accepts 8-char prefix or full UUID)")
    .option("--in <Board/List>", "Board or Board/List path")
    .option("--board <id|name>", "Board to search in (optional; scans all if omitted)")
    .option("--json", "Output raw task fields as JSON")
    .option("--human", "Render a task card instead of JSON")
    .action(async (taskId: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const human = useHumanOutput(opts);
      if (human) warnShortTaskId(taskId);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const location = opts.in || opts.board
          ? resolveCliLocation(config, { in: opts.in, board: opts.board, intent: "read", ignoreDefaultList: true })
          : null;
        const task = await runtime.getTask(taskId, location?.boardId);
        if (!task) {
          throw new Error(`Task not found: ${taskId}`);
        } else if (!human) {
          const board = config.boards.find((candidate) => candidate.id === task.boardId);
          const list = board?.columns?.find((candidate) => candidate.id === task.column);
          writeAgentJson(agentSuccess("task.get", {
            task,
            location: {
              boardId: task.boardId,
              boardName: board?.name ?? task.boardName ?? null,
              listId: task.column ?? null,
              listName: list?.name ?? null,
            },
          }, { profile: config.selectedProfile }));
        } else {
          const localReminders = runtime.getLocalReminders(task.id);
          renderTaskCard(task, config.trustedNpubs, localReminders);
        }
      } catch (err) {
        exitCode = writeCoreFailure("task.get", err, human);
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  // ---- search ----
  program
    .command("search <query>")
    .description("Full-text search tasks by title or note across all configured boards")
    .option("--in <Board/List>", "Limit to a Board or Board/List path")
    .option("--board <id|name>", "Limit to a specific board")
    .option("--mine", "Only tasks assigned to the active profile")
    .option("--json", "Output as JSON")
    .option("--human", "Render a table instead of JSON")
    .action(async (query: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const human = useHumanOutput(opts);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const location = opts.in || opts.board
          ? resolveCliLocation(config, { in: opts.in, board: opts.board, intent: "read" })
          : null;
        let allTasks = await runtime.listTasks({
          boardId: location?.boardId,
          status: "any",
          columnId: location?.listId,
        });
        if (opts.mine) {
          const identity = profilePubkey(config);
          if (!identity) throw new Error("The active profile has no valid Nostr identity for --mine.");
          allTasks = allTasks.filter((task) => (task.assignees ?? []).some((assignee) =>
            (typeof assignee === "string" ? assignee : assignee.pubkey).toLocaleLowerCase() === identity.hex));
        }
        const q = query.toLowerCase();
        const matched = allTasks.filter((t) => {
          const inTitle = t.title.toLowerCase().includes(q);
          const inNote = t.note ? t.note.toLowerCase().includes(q) : false;
          return inTitle || inNote;
        });
        if (!human) {
          writeAgentJson(agentSuccess("task.search", {
            tasks: matched,
            count: matched.length,
            query,
            location,
          }, { profile: config.selectedProfile, filters: { mine: Boolean(opts.mine) } }));
        } else {
          if (matched.length === 0) {
            console.log(chalk.dim(`No tasks matching "${query}".`));
          } else {
            renderTable(matched, config.trustedNpubs);
          }
        }
      } catch (err) {
        exitCode = writeCoreFailure("task.search", err, human);
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

}
