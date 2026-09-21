import chalk from "chalk";
import type { Command } from "commander";
import { readFile,writeFile } from "fs/promises";
import { loadConfig } from "../config.js";
import { csvEscape,parseCSV } from "../csv.js";
import type { CommandContext } from "./context.js";

export function registerTransferCommands(program: Command, context: Pick<CommandContext, "initRuntime" | "resolveBoardId" | "resolveColumnOrExit">) {
  const { initRuntime, resolveBoardId, resolveColumnOrExit } = context;
  // ---- export ----
  program
    .command("export")
    .description("Export tasks to JSON, CSV, or Markdown")
    .option("--board <id|name>", "Board to export from")
    .option("--format <json|csv|md>", "Output format (default: json)", "json")
    .option("--status <open|done|any>", "Status filter (default: open)", "open")
    .option("--output <file>", "Write to file instead of stdout")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const tasks = await runtime.listTasks({
          boardId,
          status: opts.status as "open" | "done" | "any",
          refresh: false,
        });
        const boardEntry = config.boards.find((b) => b.id === boardId);

        let output = "";

        if (opts.format === "json") {
          output = JSON.stringify(tasks, null, 2);
        } else if (opts.format === "csv") {
          const CSV_HEADER = "id,title,status,priority,dueISO,column,boardName,note,subtasks,createdAt";
          const rows = tasks.map((t) => {
            const subtaskStr = (t.subtasks ?? []).map((s) => s.title).join("|");
            return [
              csvEscape(t.id),
              csvEscape(t.title),
              csvEscape(t.completed ? "done" : "open"),
              csvEscape(t.priority ? String(t.priority) : ""),
              csvEscape(t.dueISO ? t.dueISO.slice(0, 10) : ""),
              csvEscape(t.column ?? ""),
              csvEscape(t.boardName ?? ""),
              csvEscape(t.note ?? ""),
              csvEscape(subtaskStr),
              csvEscape(t.createdAt ? String(t.createdAt) : ""),
            ].join(",");
          });
          output = [CSV_HEADER, ...rows].join("\n") + "\n";
        } else if (opts.format === "md") {
          const boardName = boardEntry?.name ?? boardId.slice(0, 8);
          const statusLabel = opts.status === "done" ? "Done Tasks" : opts.status === "any" ? "All Tasks" : "Open Tasks";
          const lines: string[] = [`## ${statusLabel} — ${boardName}`, ""];
          // Group by column
          const byColumn = new Map<string, typeof tasks>();
          for (const t of tasks) {
            const colId = t.column ?? "";
            const group = byColumn.get(colId) ?? [];
            group.push(t);
            byColumn.set(colId, group);
          }
          for (const [colId, colTasks] of byColumn) {
            let colName = colId;
            if (boardEntry?.columns) {
              const col = boardEntry.columns.find((c) => c.id === colId);
              if (col) colName = col.name;
            }
            if (!colId) colName = "No Column";
            lines.push(`### ${colName}`, "");
            for (const t of colTasks) {
              const check = t.completed ? "x" : " ";
              const meta: string[] = [];
              if (t.priority) meta.push(`priority: ${t.priority === 3 ? "high" : t.priority === 2 ? "medium" : "low"}`);
              if (t.dueISO) meta.push(`due: ${t.dueISO.slice(0, 10)}`);
              const metaStr = meta.length > 0 ? ` *(${meta.join(", ")})*` : "";
              lines.push(`- [${check}] ${t.title}${metaStr}`);
              for (const s of t.subtasks ?? []) {
                const sc = s.completed ? "x" : " ";
                lines.push(`    - [${sc}] ${s.title}`);
              }
            }
            lines.push("");
          }
          output = lines.join("\n");
        } else {
          console.error(chalk.red(`Unknown format: "${opts.format}". Use: json, csv, md`));
          exitCode = 1;
        }

        if (exitCode === 0) {
          if (opts.output) {
            await writeFile(opts.output, output, "utf-8");
            process.stderr.write(`✓ Exported ${tasks.length} tasks → ${opts.output}\n`);
          } else {
            process.stdout.write(output);
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

  // ---- import ----
  program
    .command("import <file>")
    .description("Import tasks from a JSON or CSV file")
    .option("--board <id|name>", "Board to import into")
    .option("--dry-run", "Print preview but do not create tasks")
    .option("--yes", "Skip confirmation prompt")
    .action(async (file: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);

      let raw: string;
      try {
        raw = await readFile(file, "utf-8");
      } catch {
        console.error(chalk.red(`Cannot read file: ${file}`));
        process.exit(1);
      }

      type ImportRow = {
        title: string;
        note?: string;
        priority?: 1 | 2 | 3;
        dueISO?: string;
        column?: string;
        subtasks?: string[];
      };

      let rows: ImportRow[] = [];
      const ext = file.split(".").pop()?.toLowerCase();

      if (ext === "json") {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch {
          console.error(chalk.red("Invalid JSON file")); process.exit(1);
        }
        if (!Array.isArray(parsed)) {
          console.error(chalk.red("JSON file must be an array of objects")); process.exit(1);
        }
        rows = (parsed as Record<string, unknown>[]).map((obj) => ({
          title: String(obj.title ?? ""),
          note: obj.note ? String(obj.note) : undefined,
          priority: [1, 2, 3].includes(Number(obj.priority)) ? Number(obj.priority) as 1 | 2 | 3 : undefined,
          dueISO: obj.dueISO ? String(obj.dueISO) : undefined,
          column: obj.column ? String(obj.column) : undefined,
          subtasks: Array.isArray(obj.subtasks)
            ? (obj.subtasks as unknown[]).map((s) => typeof s === "string" ? s : (s as Record<string, unknown>).title ? String((s as Record<string, unknown>).title) : "").filter(Boolean)
            : undefined,
        }));
      } else if (ext === "csv") {
        const csvRows = parseCSV(raw);
        rows = csvRows.map((r) => ({
          title: r.title ?? "",
          note: r.note || undefined,
          priority: [1, 2, 3].includes(Number(r.priority)) ? Number(r.priority) as 1 | 2 | 3 : undefined,
          dueISO: r.dueISO || undefined,
          column: r.column || undefined,
          subtasks: r.subtasks ? r.subtasks.split("|").map((s) => s.trim()).filter(Boolean) : undefined,
        }));
      } else {
        console.error(chalk.red(`Unsupported file extension: .${ext}. Use .json or .csv`));
        process.exit(1);
      }

      // Validate: check for missing titles
      const invalid = rows.map((r, i) => ({ i, r })).filter(({ r }) => !r.title.trim());
      if (invalid.length > 0) {
        console.error(chalk.red(`Invalid rows (missing title): ${invalid.map(({ i }) => i + 1).join(", ")}`));
        process.exit(1);
      }

      if (rows.length === 0) {
        console.log(chalk.dim("No rows to import."));
        process.exit(0);
      }

      // Print preview table
      console.log(chalk.bold(`\nImport preview (${rows.length} tasks):`));
      console.log(chalk.dim(`  ${"TITLE".padEnd(36)}  ${"PRI".padEnd(4)}  ${"DUE".padEnd(12)}  COLUMN`));
      for (const r of rows) {
        const t = (r.title.length > 36 ? r.title.slice(0, 35) + "…" : r.title).padEnd(36);
        const p = (r.priority ? String(r.priority) : "-").padEnd(4);
        const d = (r.dueISO ? r.dueISO.slice(0, 10) : "").padEnd(12);
        const c = r.column ?? "";
        console.log(`  ${t}  ${p}  ${d}  ${c}`);
      }

      if (opts.dryRun) {
        console.log(chalk.dim("\n[dry-run] No tasks created."));
        process.exit(0);
      }

      if (!opts.yes) {
        const { createInterface } = await import("readline");
        const confirmed = await new Promise<boolean>((resolve) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.question("\nProceed? [Y/n] ", (ans: string) => {
            rl.close();
            resolve(ans === "" || ans.toLowerCase() === "y");
          });
        });
        if (!confirmed) {
          console.log("Aborted.");
          process.exit(0);
        }
      }

      const runtime = initRuntime(config);
      const boardEntry = config.boards.find((b) => b.id === boardId)!;
      let exitCode = 0;
      try {
        // Check existing tasks to detect duplicates
        const existing = await runtime.listTasks({ boardId, status: "any" });
        const existingTitles = new Set(existing.map((t) => t.title.toLowerCase()));

        let created = 0;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (existingTitles.has(r.title.toLowerCase())) {
            console.log(chalk.yellow(`⚠ Skipping duplicate: ${r.title}`));
            continue;
          }
          // Resolve column
          let colId: string | undefined;
          if (r.column) {
            const col = resolveColumnOrExit(boardEntry, r.column);
            if (col) colId = col.id;
          }
          const subtasks = (r.subtasks ?? []).map((text) => ({
            id: crypto.randomUUID(),
            title: text,
            completed: false,
          }));
          await runtime.createTaskFull({
            title: r.title,
            note: r.note ?? "",
            boardId,
            dueISO: r.dueISO,
            priority: r.priority,
            columnId: colId,
            subtasks: subtasks.length > 0 ? subtasks : undefined,
          });
          created++;
          console.log(chalk.green(`  [${created}/${rows.length}] ✓ ${r.title}`));
        }
        console.log(chalk.green(`✓ Imported ${created}/${rows.length} tasks`));
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

}
