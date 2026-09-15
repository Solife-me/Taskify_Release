import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig,saveConfig } from "../config.js";
import { renderJson } from "../render.js";
import type { CommandContext } from "./context.js";

export function registerAgentCommands(program: Command, context: Pick<CommandContext, "initRuntime" | "resolveBoardId" | "resolveColumnOrExit">) {
  const { initRuntime, resolveBoardId, resolveColumnOrExit } = context;
  // ---- agent command group ----
  const agentCmd = program
    .command("agent")
    .description("Legacy LLM-assisted helpers (external agents should use root task commands)");

  const agentConfigCmd = agentCmd
    .command("config")
    .description("Manage agent AI configuration");

  agentConfigCmd
    .command("set-key <key>")
    .description("Set the AI API key")
    .action(async (key: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.agent) config.agent = {};
      config.agent.apiKey = key;
      await saveConfig(config);
      console.log(chalk.green("✓ Agent API key saved"));
      process.exit(0);
    });

  agentConfigCmd
    .command("set-model <model>")
    .description("Set the AI model")
    .action(async (model: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.agent) config.agent = {};
      config.agent.model = model;
      await saveConfig(config);
      console.log(chalk.green(`✓ Agent model set to: ${model}`));
      process.exit(0);
    });

  agentConfigCmd
    .command("set-url <url>")
    .description("Set the AI base URL (OpenAI-compatible)")
    .action(async (url: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.agent) config.agent = {};
      config.agent.baseUrl = url;
      await saveConfig(config);
      console.log(chalk.green(`✓ Agent base URL set to: ${url}`));
      process.exit(0);
    });

  agentConfigCmd
    .command("show")
    .description("Show current agent config (masks API key)")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const ag = config.agent ?? {};
      const rawKey = ag.apiKey ?? process.env.TASKIFY_AGENT_API_KEY ?? "";
      let maskedKey = "(not set)";
      if (rawKey.length > 7) {
        maskedKey = rawKey.slice(0, 3) + "..." + rawKey.slice(-3);
      } else if (rawKey.length > 0) {
        maskedKey = "***";
      }
      console.log(`  apiKey:         ${maskedKey}`);
      console.log(`  baseUrl:        ${ag.baseUrl ?? "https://api.openai.com/v1"}`);
      console.log(`  model:          ${ag.model ?? "gpt-4o-mini"}`);
      console.log(`  defaultBoardId: ${ag.defaultBoardId ?? "(not set)"}`);
      process.exit(0);
    });

  agentCmd
    .command("add <description>")
    .description("AI-powered task creation from natural language")
    .option("--board <id|name>", "Target board")
    .option("--yes", "Skip confirmation prompt")
    .option("--dry-run", "Show extracted fields without creating")
    .option("--json", "Output created task as JSON")
    .action(async (description: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const apiKey = config.agent?.apiKey ?? process.env.TASKIFY_AGENT_API_KEY ?? "";
      if (!apiKey) {
        console.error(chalk.red("No AI API key configured. Run: taskify agent config set-key <key>"));
        console.error(chalk.dim("  or set TASKIFY_AGENT_API_KEY environment variable"));
        process.exit(1);
      }
      const baseUrl = config.agent?.baseUrl ?? "https://api.openai.com/v1";
      const model = config.agent?.model ?? "gpt-4o-mini";
      const boardId = await resolveBoardId(opts.board ?? config.agent?.defaultBoardId, config);
      const boardEntry = config.boards.find((b) => b.id === boardId)!;

      if (boardEntry.kind === "compound") {
        const childNames = (boardEntry.children ?? []).map((cid) => {
          const ce = config.boards.find((b) => b.id === cid);
          return ce ? `  ${ce.name} (${cid})` : `  ${cid}`;
        }).join("\n");
        console.error(chalk.red("Cannot add tasks directly to a compound board. Use one of its child boards:"));
        if (childNames) console.error(childNames);
        process.exit(1);
      }

      const today = new Date().toISOString().slice(0, 10);
      const { callAI } = await import("../aiClient.js");

      const SYSTEM_PROMPT = `You are a task extraction assistant. Extract fields from the description.
Return ONLY valid JSON (no markdown, no explanation):
{
  "title": "concise task title (max 80 chars)",
  "note": "additional detail or empty string",
  "priority": 1|2|3|null,
  "dueISO": "YYYY-MM-DD"|null,
  "column": "column name/id hint or null",
  "subtasks": ["subtask 1", "subtask 2"] or []
}
Today is ${today}.`;

      let extracted: {
        title: string;
        note: string;
        priority: 1 | 2 | 3 | null;
        dueISO: string | null;
        column: string | null;
        subtasks: string[];
      };

      console.log(chalk.dim("Calling AI..."));
      try {
        const raw = await callAI({ apiKey, baseUrl, model, systemPrompt: SYSTEM_PROMPT, userMessage: description });
        // Strip markdown code fences if present
        const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        extracted = JSON.parse(cleaned);
      } catch (err) {
        console.error(chalk.red(`AI extraction failed: ${String(err)}`));
        process.exit(1);
      }

      // Resolve column hint
      let resolvedColumnId: string | undefined;
      let resolvedColumnName: string | undefined;
      if (extracted.column) {
        const col = resolveColumnOrExit(boardEntry, extracted.column);
        if (col) {
          resolvedColumnId = col.id;
          resolvedColumnName = col.name;
        }
      }

      // Print extracted fields
      console.log(chalk.bold("\nExtracted task:"));
      console.log(`  title:    ${extracted.title}`);
      if (extracted.note) console.log(`  note:     ${extracted.note}`);
      if (extracted.priority) console.log(`  priority: ${extracted.priority}`);
      if (extracted.dueISO) console.log(`  due:      ${extracted.dueISO}`);
      if (resolvedColumnName) console.log(`  column:   ${resolvedColumnName}`);
      if (extracted.subtasks?.length > 0) {
        console.log(`  subtasks: ${extracted.subtasks.join(", ")}`);
      }

      if (opts.dryRun) {
        console.log(chalk.dim("\n[dry-run] No task created."));
        process.exit(0);
      }

      if (!opts.yes) {
        const { createInterface } = await import("readline");
        const confirmed = await new Promise<boolean>((resolve) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.question("\nCreate this task? [Y/n] ", (ans: string) => {
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
      try {
        const subtasks = (extracted.subtasks ?? []).map((text) => ({
          id: crypto.randomUUID(),
          title: text,
          completed: false,
        }));
        const task = await runtime.createTaskFull({
          title: extracted.title,
          note: extracted.note ?? "",
          boardId,
          dueISO: extracted.dueISO ?? undefined,
          priority: extracted.priority ?? undefined,
          columnId: resolvedColumnId,
          subtasks: subtasks.length > 0 ? subtasks : undefined,
        });
        if (opts.json) {
          renderJson(task);
        } else {
          const colStr = task.column ? chalk.dim(`  [col: ${resolvedColumnName ?? task.column}]`) : "";
          console.log(chalk.green(`✓ Created: ${task.title}`) + colStr);
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
      process.exit(0);
    });

  agentCmd
    .command("triage")
    .description("AI-powered task prioritization suggestions")
    .option("--board <id|name>", "Target board")
    .option("--yes", "Apply changes without confirmation")
    .option("--dry-run", "Show suggestions without applying")
    .option("--json", "Output suggestions as JSON")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const apiKey = config.agent?.apiKey ?? process.env.TASKIFY_AGENT_API_KEY ?? "";
      if (!apiKey) {
        console.error(chalk.red("No AI API key configured. Run: taskify agent config set-key <key>"));
        process.exit(1);
      }
      const baseUrl = config.agent?.baseUrl ?? "https://api.openai.com/v1";
      const model = config.agent?.model ?? "gpt-4o-mini";
      const boardId = await resolveBoardId(opts.board ?? config.agent?.defaultBoardId, config);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const tasks = await runtime.listTasks({ boardId, status: "open" });
        if (tasks.length === 0) {
          console.log(chalk.dim("No open tasks to triage."));
          process.exit(0);
        }

        const { callAI } = await import("../aiClient.js");

        const SYSTEM_PROMPT = `You are a task prioritization assistant. Given open tasks, suggest priority (1=low, 2=medium, 3=high) for each.
Return ONLY a valid JSON array (no markdown):
[{"id":"<taskId>","priority":1|2|3,"reason":"one sentence"}]`;

        const taskList = tasks.map((t) => ({
          id: t.id,
          title: t.title,
          note: t.note || undefined,
          dueISO: t.dueISO || undefined,
          currentPriority: t.priority,
        }));

        console.log(chalk.dim(`Analyzing ${tasks.length} tasks...`));
        let suggestions: Array<{ id: string; priority: 1 | 2 | 3; reason: string }>;
        try {
          const raw = await callAI({
            apiKey, baseUrl, model,
            systemPrompt: SYSTEM_PROMPT,
            userMessage: `Tasks: ${JSON.stringify(taskList)}`,
          });
          const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
          suggestions = JSON.parse(cleaned);
        } catch (err) {
          console.error(chalk.red(`AI triage failed: ${String(err)}`));
          process.exit(1);
        }

        // Filter to only changes
        const changes = suggestions.filter((s) => {
          const task = tasks.find((t) => t.id === s.id);
          return task && task.priority !== s.priority;
        });

        if (opts.json) {
          renderJson(suggestions);
          process.exit(0);
        }

        if (changes.length === 0) {
          console.log(chalk.dim("No priority changes suggested."));
          process.exit(0);
        }

        console.log(chalk.bold("\nSuggested priority changes:"));
        const PRIO_LABELS: Record<number, string> = { 1: "low", 2: "medium", 3: "high" };
        for (const s of changes) {
          const task = tasks.find((t) => t.id === s.id);
          const oldPrio = task?.priority ? PRIO_LABELS[task.priority] : "none";
          const newPrio = PRIO_LABELS[s.priority] ?? String(s.priority);
          console.log(`  ${s.id.slice(0, 8)}  ${(task?.title ?? "").slice(0, 40).padEnd(40)}  ${oldPrio} → ${newPrio}`);
          console.log(chalk.dim(`           ${s.reason}`));
        }

        if (opts.dryRun) {
          console.log(chalk.dim("\n[dry-run] No changes applied."));
          process.exit(0);
        }

        if (!opts.yes) {
          const { createInterface } = await import("readline");
          const confirmed = await new Promise<boolean>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question("\nApply these priority changes? [Y/n] ", (ans: string) => {
              rl.close();
              resolve(ans === "" || ans.toLowerCase() === "y");
            });
          });
          if (!confirmed) {
            console.log("Aborted.");
            process.exit(0);
          }
        }

        for (const s of changes) {
          await runtime.updateTask(s.id, boardId, { priority: s.priority });
        }
        console.log(chalk.green(`✓ Applied ${changes.length} priority update(s)`));
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exit(exitCode);
      }
    });

}
