import chalk from "chalk";
import type { Command } from "commander";
import {
resolveBoardReference
} from "taskify-core";
import { loadConfig,saveConfig,type BoardEntry } from "../config.js";
import { renderJson } from "../render.js";
import { parseOnOffState } from "../shared/boardState.js";
import type { CommandContext } from "./context.js";

export function registerBoardsCommands(program: Command, context: Pick<CommandContext, "initRuntime">) {
  const { initRuntime } = context;
  // ---- board command group ----
  const boardCmd = program
    .command("board")
    .description("Manage boards");

  boardCmd
    .command("list")
    .description("List all configured boards")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (config.boards.length === 0) {
        console.log(chalk.dim("No boards configured. Use: taskify board join <id> --name <name>"));
        process.exit(0);
      }

      // Auto-sync any board whose stored name looks like a raw UUID prefix
      // (happens when a board was joined without a --name or metadata wasn't fetched).
      // This ensures agents always see human-readable names without a manual board sync step.
      const UUID_PREFIX_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
      const STALE_SYNC_MS = 24 * 60 * 60 * 1000; // 24h TTL for non-stale boards
      const stale = config.boards.filter(
        (b) => {
          // UUID-named boards are always stale
          if (UUID_PREFIX_RE.test(b.name) || b.name === b.id || b.name === b.id.slice(0, 8)) return true;
          // Non-UUID boards: re-sync if last sync was >24h ago (or never synced)
          if (!b.syncedAt) return true;
          return Date.now() - b.syncedAt > STALE_SYNC_MS;
        },
      );

      if (stale.length > 0) {
        process.stderr.write(chalk.dim(`Fetching display names for ${stale.length} board(s)…\n`));
        try {
          const runtime = initRuntime(config);
          for (const b of stale) {
            try {
              const meta = await runtime.syncBoard(b.id);
              if (meta.name) b.name = meta.name;
              if (meta.kind) b.kind = meta.kind as BoardEntry["kind"];
              if (meta.columns) b.columns = meta.columns;
              b.syncedAt = Date.now();
            } catch { /* non-fatal — show whatever name we have */ }
          }
          await runtime.disconnect();
          await saveConfig(config);
        } catch { /* non-fatal */ }
      }

      for (const b of config.boards) {
        const relays = b.relays?.length ? `  [${b.relays.join(", ")}]` : "";
        console.log(`  ${chalk.bold(b.name.padEnd(16))} ${chalk.dim(b.id)}${relays}`);
      }
      process.exit(0);
    });

  boardCmd
    .command("join <boardId>")
    .description("Join a board by its UUID")
    .option("--name <name>", "Human-readable name for this board")
    .option("--relay <url>", "Additional relay URL for this board")
    .action(async (boardId: string, opts) => {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(boardId)) {
        console.warn(chalk.yellow(`Warning: "${boardId}" does not look like a UUID.`));
      }
      const config = await loadConfig(program.opts().profile as string | undefined);
      const existing = config.boards.find((b) => b.id === boardId);
      if (existing) {
        console.log(chalk.dim(`Already on board ${existing.name} (${boardId})`));
        process.exit(0);
      }
      const name = opts.name ?? boardId.slice(0, 8);
      const entry: { id: string; name: string; relays?: string[]; syncedAt?: number } = { id: boardId, name, syncedAt: Date.now() };
      if (opts.relay) {
        entry.relays = [opts.relay];
      }
      config.boards.push(entry);
      await saveConfig(config);
      console.log(chalk.green(`✓ Joined board ${name} (${boardId})`));
      // Auto-sync board metadata immediately after joining
      try {
        const runtime = initRuntime(config);
        const meta = await runtime.syncBoard(boardId);
        if (meta.kind || (meta.columns && meta.columns.length > 0)) {
          const colCount = meta.columns?.length ?? 0;
          console.log(chalk.dim(`  Synced: kind=${meta.kind ?? "?"}, columns=${colCount}`));
        }
        await runtime.disconnect();
      } catch { /* non-fatal if sync fails on join */ }
      process.exit(0);
    });

  boardCmd
    .command("sync [boardId]")
    .description("Sync board metadata (kind, columns) from Nostr")
    .action(async (boardId?: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (config.boards.length === 0) {
        console.error(chalk.red("No boards configured."));
        process.exit(1);
      }
      const toSync = boardId
        ? (() => {
            const entry = resolveBoardReference(config.boards, boardId);
            if (!entry) {
              console.error(chalk.red(`Board not found: "${boardId}"`));
              process.exit(1);
            }
            return [entry];
          })()
        : config.boards;
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        for (const entry of toSync) {
          try {
            const meta = await runtime.syncBoard(entry.id);
            const colCount = meta.columns?.length ?? 0;
            const kindStr = meta.kind ?? "unknown";
            const reloadedEntry = (await loadConfig(program.opts().profile as string | undefined)).boards.find((b) => b.id === entry.id);
            const childrenCount = reloadedEntry?.children?.length ?? 0;
            const childrenStr = kindStr === "compound" ? `, children: ${childrenCount}` : "";
            console.log(chalk.green(`✓ Synced: ${entry.name} (kind: ${kindStr}, columns: ${colCount}${childrenStr})`));
          } catch (err) {
            console.error(chalk.red(`  ✗ Failed to sync ${entry.name}: ${String(err)}`));
            exitCode = 1;
          }
        }
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

  boardCmd
    .command("leave <boardId>")
    .description("Remove a board from config")
    .action(async (boardId: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const before = config.boards.length;
      config.boards = config.boards.filter((b) => b.id !== boardId);
      if (config.boards.length === before) {
        console.error(chalk.red(`Board not found: ${boardId}`));
        process.exit(1);
      }
      await saveConfig(config);
      console.log(chalk.green(`✓ Left board ${boardId}`));
      process.exit(0);
    });

  boardCmd
    .command("column-default <board> <columnIdOrName>")
    .description("Set the default column for new tasks on the selected profile")
    .action(async (boardArg: string, colArg: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const entry = resolveBoardReference(config.boards, boardArg);
      if (!entry) {
        console.error(chalk.red(`Board not found: "${boardArg}"`));
        process.exit(1);
      }
      // Resolve column name to ID if needed
      let colId = colArg;
      if (entry.columns) {
        const matched = entry.columns.find(c => c.id === colArg || c.name.toLowerCase() === colArg.toLowerCase());
        if (matched) colId = matched.id;
        else {
          console.error(chalk.red(`Column "${colArg}" not found in board "${entry.name}"`));
          process.exit(1);
        }
      }
      // Store on the selected profile (local only)
      const profileCfg = config.profiles?.[config.selectedProfile];
      if (profileCfg) {
        profileCfg.defaultColumn = colId;
        profileCfg.defaultBoard = entry.id;
        profileCfg.defaultLocation = { boardId: entry.id, listId: colId };
      }
      config.defaultBoard = entry.id;
      config.defaultColumn = colId;
      config.defaultLocation = { boardId: entry.id, listId: colId };
      await saveConfig(config);
      console.log(chalk.green(`✓ Default column for profile "${config.selectedProfile}" → "${entry.name}": ${colId}`));
      process.exit(0);
    });

  boardCmd
    .command("default [boardIdOrName]")
    .description("Set a board as the default for new tasks")
    .option("--clear", "Clear the default board")
    .action(async (boardArg: string | undefined, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (opts.clear) {
        // Clear defaultBoard reference on all boards (set to empty list or remove defaultBoard setting)
        const profileCfg = config.profiles?.[config.selectedProfile];
        if (profileCfg) {
          delete (profileCfg as any).defaultBoard;
          delete profileCfg.defaultLocation;
        }
        delete (config as any).defaultBoard;
        delete config.defaultLocation;
        await saveConfig(config);
        console.log(chalk.green("✓ Default board cleared — you'll be prompted to select one when needed"));
        process.exit(0);
      }
      if (!boardArg) {
        console.error(chalk.red("Provide a board id/name, or use --clear to remove the default board."));
        process.exit(1);
      }
      const entry = resolveBoardReference(config.boards, boardArg);
      if (!entry) {
        console.error(chalk.red(`Board not found: "${boardArg}"`));
        process.exit(1);
      }
      // Store as profile-level defaultBoard so add/list commands auto-resolve to this board
      const profileCfg = config.profiles?.[config.selectedProfile];
      if (profileCfg) {
        profileCfg.defaultBoard = entry.id;
        profileCfg.defaultLocation = { boardId: entry.id };
      }
      config.defaultBoard = entry.id;
      config.defaultLocation = { boardId: entry.id };
      await saveConfig(config);
      console.log(chalk.green(`✓ Default board set to "${entry.name}" (${entry.id})`));
      process.exit(0);
    });

  boardCmd
    .command("defaults")
    .description("Show all defaults for the selected profile (boards, columns)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const profileCfg = config.profiles?.[config.selectedProfile];
      if (!profileCfg) {
        console.error(chalk.red("No selected profile found."));
        process.exit(1);
      }

      // Resolve default board name
      const defaultBoardId = profileCfg.defaultBoard;
      const defaultBoard = defaultBoardId ? config.boards.find(b => b.id === defaultBoardId) : undefined;

      // Resolve default column name (if set on profile)
      const defaultColumnId = profileCfg.defaultColumn;
      let defaultColumnName: string | undefined;
      let defaultColumnBoard: string | undefined;
      if (defaultColumnId) {
        // Find which board this column belongs to
        for (const board of config.boards) {
          const col = board.columns?.find(c => c.id === defaultColumnId);
          if (col) {
            defaultColumnName = col.name;
            defaultColumnBoard = board.name;
            break;
          }
        }
      }

      if (opts.json) {
        renderJson({
          activeProfile: config.activeProfile,
          selectedProfile: config.selectedProfile,
          defaultBoard: defaultBoardId ? { id: defaultBoardId, name: defaultBoard?.name } : null,
          defaultColumn: defaultColumnId ? {
            board: defaultColumnBoard,
            id: defaultColumnId,
            name: defaultColumnName,
          } : null,
        });
        process.exit(0);
      }

      console.log(chalk.bold(`Selected profile: ${config.selectedProfile}${config.selectedProfile === config.activeProfile ? " (active)" : ""}`));
      console.log("");

      if (defaultBoardId) {
        console.log(chalk.cyan(`Default board: ${defaultBoard?.name ?? "(unresolved)"}`));
        console.log(`  → New tasks will go to: ${defaultBoard?.id ?? "(unresolved)"}`);
      } else {
        console.log(chalk.yellow("Default board: (none — you'll be prompted to select one when needed)"));
      }

      console.log("");
      if (defaultColumnId) {
        console.log(chalk.cyan(`Default column: ${defaultColumnName ?? "(unresolved)"}`));
        console.log(`  → Column ID: ${defaultColumnId}`);
        console.log(`  → In board: ${defaultColumnBoard ?? "(unresolved)"}`);
        console.log(chalk.dim("  → Used as fallback when no --column is specified."));
      } else {
        console.log(chalk.yellow("Default column: (none set — you'll be prompted to select one when needed)"));
        console.log(chalk.dim("  Use: taskify board column-default <board> <column>"));
      }
      process.exit(0);
    });

  boardCmd
    .command("columns [board]")
    .description("List columns for a board")
    .option("--json", "Output as JSON")
    .action(async (boardArg: string | undefined, opts: { json?: boolean }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const entry = boardArg
        ? resolveBoardReference(config.boards, boardArg)
        : config.defaultBoard
          ? resolveBoardReference(config.boards, config.defaultBoard)
          : null;
      if (!entry) {
        const hint = config.boards.length > 0
          ? `Known boards: ${config.boards.map(b => b.name).join(', ')}`
          : 'No boards configured. Use: taskify board join <id> --name <name>';
        console.error(chalk.red(`Board not found: "${boardArg ?? config.defaultBoard}". ${hint}`));
        process.exit(1);
      }

      const runtime = initRuntime(config);
      let columns = entry.columns ?? [];
      try {
        const meta = await runtime.syncBoard(entry.id);
        columns = meta.columns ?? columns;
      } catch {
        // Use cached columns when relay metadata is unavailable.
      }

      if (opts.json) {
        renderJson({
          board: { id: entry.id, name: entry.name, kind: entry.kind ?? "lists" },
          columns,
        });
      } else if (columns.length === 0) {
        console.log(chalk.dim(`No columns found for ${entry.name}.`));
      } else {
        console.log(chalk.bold(`Columns for ${entry.name}`));
        for (const col of columns) {
          console.log(`  ${chalk.bold(col.name.padEnd(18))} ${chalk.dim(col.id)}`);
        }
      }

      await runtime.disconnect();
      process.exit(0);
    });

  boardCmd
    .command("overview [board]")
    .description("Display board column counts (tasks per column)")
    .option("--json", "Output as JSON")
    .action(async (boardArg: string | undefined, opts: { json?: boolean }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const entry = resolveBoardReference(config.boards, boardArg ?? config.defaultBoard);
      if (!entry) {
        const hint = config.boards.length > 0
          ? `Known boards: ${config.boards.map(b => b.name).join(', ')}`
          : 'No boards configured. Use: taskify board join <id> --name <name>';
        console.error(chalk.red(`Board not found: "${boardArg ?? config.defaultBoard}". ${hint}`));
        process.exit(1);
      }

      // Sync columns from Nostr if needed
      const runtime = initRuntime(config);
      const syncedAt = entry.syncedAt ?? 0;
      const THIRTY_MIN_MS = 30 * 60 * 1000;
      if (!entry.columns || Date.now() - syncedAt > THIRTY_MIN_MS) {
        try {
          await runtime.syncBoard(entry.id);
        } catch { /* non-fatal */ }
      }

      // Get fresh board data from runtime
      let boardColumns = entry.columns || [];
      try {
        const fresh = await runtime.syncBoard(entry.id);
        if (fresh.columns && fresh.columns.length > 0) {
          boardColumns = fresh.columns;
        }
      } catch { /* use cached */ }

      // Fetch all tasks to count per column (batch to avoid many relay calls)
      const allTasks = await runtime.listTasks({ boardId: entry.id, status: "any" });

      if (opts.json) {
        const overview: Record<string, { open: number; total: number }> = {};
        for (const col of boardColumns) {
          const colTasks = allTasks.filter((t) => t.column === col.id);
          overview[col.name] = {
            open: colTasks.filter((t) => !t.completed).length,
            total: colTasks.length,
          };
        }
        renderJson({ boardName: entry.name, overview });
        await runtime.disconnect();
        process.exit(0);
      }

      console.log(chalk.bold(`Board: ${entry.name}`));
      console.log(chalk.dim(`  ID: ${entry.id}`));
      const nameLen = Math.max(20, ...boardColumns.map(c => c.name.length));

      for (const col of boardColumns) {
        const colTasks = allTasks.filter((t) => t.column === col.id);
        const open = colTasks.filter((t) => !t.completed).length;
        const total = colTasks.length;
        const openDim = chalk.dim(`${String(open).padStart(5)} open`);
        const totalDim = chalk.dim(`${String(total).padStart(5)} total`);
        console.log(`  ${chalk.bold(col.name.padEnd(nameLen))}  ${openDim}  ${totalDim}`);
      }
      await runtime.disconnect();
      process.exit(0);
    });

  boardCmd
    .command("children <board>")
    .description("List children of a compound board")
    .action(async (boardArg: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const entry = resolveBoardReference(config.boards, boardArg);
      if (!entry) {
        console.error(chalk.red(`Board not found: "${boardArg}"`));
        process.exit(1);
      }
      if (entry.kind !== "compound") {
        console.log(chalk.dim(`Board is not a compound board (kind: ${entry.kind ?? "unknown"})`));
        process.exit(0);
      }
      if (!entry.children || entry.children.length === 0) {
        console.log(chalk.dim("No children cached — run: taskify board sync"));
        process.exit(0);
      }
      console.log(chalk.bold(`Children of ${entry.name}:`));
      for (const childId of entry.children) {
        const childEntry = config.boards.find((b) => b.id === childId);
        if (childEntry) {
          console.log(`  ${chalk.cyan(childEntry.name.padEnd(16))} ${chalk.dim(childId)}`);
        } else {
          console.log(`  ${chalk.dim(childId)} ${chalk.yellow("(not in local config)")}`);
        }
      }
      process.exit(0);
    });

  boardCmd
    .command("column-add <board> <name>")
    .description("Add a list column")
    .action(async (boardArg: string, name: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const entry = resolveBoardReference(config.boards, boardArg);
        if (!entry) throw new Error(`Board not found: "${boardArg}"`);
        if (entry.kind !== "lists") throw new Error("Column operations are only supported for list boards");
        const next = [...(entry.columns ?? []), { id: crypto.randomUUID(), name }];
        const updated = await runtime.updateBoard(entry.id, { columns: next });
        if (!updated) throw new Error("Failed to update board");
        console.log(chalk.green(`✓ Added column \"${name}\"`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally { await runtime.disconnect(); }
    });

  boardCmd
    .command("column-rename <board> <columnRef> <name>")
    .description("Rename a list column by id or name")
    .action(async (boardArg: string, columnRef: string, name: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const entry = resolveBoardReference(config.boards, boardArg);
        if (!entry || entry.kind !== "lists") throw new Error("List board not found");
        const columns = [...(entry.columns ?? [])];
        const idx = columns.findIndex((c) => c.id === columnRef || c.name.toLowerCase() === columnRef.toLowerCase());
        if (idx === -1) throw new Error(`Column not found: ${columnRef}`);
        columns[idx] = { ...columns[idx], name };
        await runtime.updateBoard(entry.id, { columns });
        console.log(chalk.green(`✓ Renamed column to \"${name}\"`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally { await runtime.disconnect(); }
    });

  boardCmd
    .command("column-delete <board> <columnRef>")
    .description("Delete a list column by id or name")
    .action(async (boardArg: string, columnRef: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const entry = resolveBoardReference(config.boards, boardArg);
        if (!entry || entry.kind !== "lists") throw new Error("List board not found");
        const before = entry.columns ?? [];
        const after = before.filter((c) => !(c.id === columnRef || c.name.toLowerCase() === columnRef.toLowerCase()));
        if (after.length === before.length) throw new Error(`Column not found: ${columnRef}`);
        await runtime.updateBoard(entry.id, { columns: after });
        console.log(chalk.green(`✓ Deleted column: ${columnRef}`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally { await runtime.disconnect(); }
    });

  boardCmd
    .command("column-reorder <board> <columnRef> <position>")
    .description("Reorder a list column by id or name to 1-based position")
    .action(async (boardArg: string, columnRef: string, positionRaw: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const pos = Number.parseInt(positionRaw, 10);
        if (!Number.isFinite(pos) || pos < 1) throw new Error("Position must be >= 1");
        const entry = resolveBoardReference(config.boards, boardArg);
        if (!entry || entry.kind !== "lists") throw new Error("List board not found");
        const columns = [...(entry.columns ?? [])];
        const idx = columns.findIndex((c) => c.id === columnRef || c.name.toLowerCase() === columnRef.toLowerCase());
        if (idx === -1) throw new Error(`Column not found: ${columnRef}`);
        const [moved] = columns.splice(idx, 1);
        const target = Math.min(columns.length, pos - 1);
        columns.splice(target, 0, moved);
        await runtime.updateBoard(entry.id, { columns });
        console.log(chalk.green(`✓ Reordered column: ${moved.name} -> ${target + 1}`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally { await runtime.disconnect(); }
    });

  boardCmd
    .command("rename <board> <name>")
    .description("Rename board")
    .action(async (boardArg: string, name: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const entry = resolveBoardReference(config.boards, boardArg);
        if (!entry) throw new Error(`Board not found: ${boardArg}`);
        await runtime.updateBoard(entry.id, { name });
        console.log(chalk.green(`✓ Renamed board to ${name}`));
        process.exit(0);
      } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
    });

  boardCmd.command("archive <board>").description("Archive board").action(async (boardArg: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { archived: true }); console.log(chalk.green("✓ Board archived")); process.exit(0); }
    catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  boardCmd.command("unarchive <board>").description("Unarchive board").action(async (boardArg: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { archived: false }); console.log(chalk.green("✓ Board unarchived")); process.exit(0); }
    catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  boardCmd.command("hide <board>").description("Hide board").action(async (boardArg: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { hidden: true }); console.log(chalk.green("✓ Board hidden")); process.exit(0); }
    catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  boardCmd.command("unhide <board>").description("Unhide board").action(async (boardArg: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { hidden: false }); console.log(chalk.green("✓ Board visible")); process.exit(0); }
    catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  boardCmd.command("index-card <board> <state>").description("Set index-card mode on/off").action(async (boardArg: string, state: string) => {
    const enabled = parseOnOffState(state);
    if (enabled === null) {
      console.error(chalk.red(`Invalid state: "${state}". Use on/off, true/false, yes/no, or 1/0.`));
      process.exit(1);
    }
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); await runtime.updateBoard(entry.id, { indexCardEnabled: enabled }); console.log(chalk.green(`✓ Index-card ${enabled ? "enabled" : "disabled"}`)); process.exit(0); }
    catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  boardCmd.command("clear-completed <board>").description("Delete completed tasks in board").action(async (boardArg: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try { const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`); const count = await runtime.clearCompleted(entry.id); console.log(chalk.green(`✓ Cleared ${count} completed task(s)`)); process.exit(0); }
    catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  boardCmd.command("share-settings <board> <json>").description("Update board share settings (JSON object)").action(async (boardArg: string, jsonRaw: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try {
      const entry = resolveBoardReference(config.boards, boardArg); if (!entry) throw new Error(`Board not found: ${boardArg}`);
      const parsed = JSON.parse(jsonRaw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("share-settings must be a JSON object");
      await runtime.updateBoard(entry.id, { shareSettings: parsed as Record<string, unknown> });
      console.log(chalk.green("✓ Updated share settings")); process.exit(0);
    } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  boardCmd
    .command("sort <board> [mode] [direction]")
    .description("Get or set board sort settings (modes: manual|due|priority|created|alpha, directions: asc|desc)")
    .action(async (boardArg: string, mode?: string, direction?: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const entry = resolveBoardReference(config.boards, boardArg);
      if (!entry) {
        console.error(chalk.red(`Board not found: "${boardArg}"`));
        process.exit(1);
      }
      if (!mode) {
        console.log(`Sort mode:      ${entry.sortMode ?? "manual (default)"}`);
        console.log(`Sort direction: ${entry.sortDirection ?? "asc (default)"}`);
        process.exit(0);
      }
      const VALID_MODES = ["manual", "due", "priority", "created", "alpha"];
      const VALID_DIRS = ["asc", "desc"];
      if (!VALID_MODES.includes(mode)) {
        console.error(chalk.red(`Invalid sort mode. Use: ${VALID_MODES.join(", ")}`));
        process.exit(1);
      }
      if (direction && !VALID_DIRS.includes(direction)) {
        console.error(chalk.red(`Invalid direction. Use: asc, desc`));
        process.exit(1);
      }
      const runtime = initRuntime(config);
      try {
        await runtime.updateBoard(entry.id, {
          sortMode: mode as BoardEntry["sortMode"],
          sortDirection: ((direction ?? "asc") as BoardEntry["sortDirection"]),
        });
        console.log(chalk.green(`✓ Sort set: ${mode} ${direction ?? "asc"}`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

  boardCmd.command("child-add <board> <child>").description("Add child board to a compound board").action(async (boardArg: string, childArg: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try {
      const entry = resolveBoardReference(config.boards, boardArg); if (!entry || entry.kind !== "compound") throw new Error("Compound board not found");
      const child = resolveBoardReference(config.boards, childArg); const childId = child?.id ?? childArg;
      const children = [...(entry.children ?? [])]; if (!children.includes(childId)) children.push(childId);
      await runtime.updateBoard(entry.id, { children }); console.log(chalk.green(`✓ Added child: ${childId}`)); process.exit(0);
    } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  boardCmd.command("child-remove <board> <child>").description("Remove child board from a compound board").action(async (boardArg: string, childArg: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try {
      const entry = resolveBoardReference(config.boards, boardArg); if (!entry || entry.kind !== "compound") throw new Error("Compound board not found");
      const child = resolveBoardReference(config.boards, childArg); const childId = child?.id ?? childArg;
      const children = (entry.children ?? []).filter((id) => id !== childId);
      await runtime.updateBoard(entry.id, { children }); console.log(chalk.green(`✓ Removed child: ${childId}`)); process.exit(0);
    } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  boardCmd.command("child-reorder <board> <child> <position>").description("Reorder child board in a compound board").action(async (boardArg: string, childArg: string, positionRaw: string) => {
    const config = await loadConfig(program.opts().profile as string | undefined); const runtime = initRuntime(config);
    try {
      const pos = Number.parseInt(positionRaw, 10); if (!Number.isFinite(pos) || pos < 1) throw new Error("Position must be >= 1");
      const entry = resolveBoardReference(config.boards, boardArg); if (!entry || entry.kind !== "compound") throw new Error("Compound board not found");
      const child = resolveBoardReference(config.boards, childArg); const childId = child?.id ?? childArg;
      const children = [...(entry.children ?? [])]; const idx = children.indexOf(childId); if (idx === -1) throw new Error(`Child not found: ${childId}`);
      const [moved] = children.splice(idx, 1); const target = Math.min(children.length, pos - 1); children.splice(target, 0, moved);
      await runtime.updateBoard(entry.id, { children }); console.log(chalk.green(`✓ Reordered child: ${childId} -> ${target + 1}`)); process.exit(0);
    } catch (err) { console.error(chalk.red(String(err))); process.exit(1); } finally { await runtime.disconnect(); }
  });

  return boardCmd;
}
