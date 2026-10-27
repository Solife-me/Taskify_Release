import chalk from "chalk";
import type { Command } from "commander";
import {
resolveBoardReference
} from "taskify-core";
import type { CommandContext } from "./context.js";

export function registerBoardCreationCommands(program: Command, context: Pick<CommandContext, "initRuntime" | "loadConfig" | "randomUUID" | "prompt">, boardCmd: Command) {
  const { initRuntime, loadConfig, randomUUID, prompt } = context;
  // ---- board create ----
  boardCmd
    .command("create <name>")
    .description("Create and publish a new board")
    .option("--kind <lists|week|compound>", "Board kind (default: lists)", "lists")
    .option("--columns <names>", "List names, comma-separated (lists boards; asked for when omitted in a terminal)")
    .option("--child <id|name>", "Child board id/name (repeatable for compound boards)")
    .option("--relay <url>", "Relay URL hint (informational)")
    .action(async (name: string, opts) => {
      if (!["lists", "week", "compound"].includes(opts.kind)) {
        console.error(chalk.red(`Invalid --kind: "${opts.kind}". Use: lists, week, or compound`));
        process.exitCode = 1; return;
      }
      const kind = opts.kind as "lists" | "week" | "compound";
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        let columns: { id: string; name: string }[] = [];
        let children: string[] = [];
        if (kind === "lists") {
          // A script gets a board without lists rather than waiting for an answer.
          const answer = (opts.columns as string | undefined)
            ?? await prompt("Column names (comma-separated, or blank for none): ")
            ?? "";
          if (answer) {
            columns = answer.split(",").map((n) => n.trim()).filter(Boolean).map((n) => ({
              id: randomUUID(),
              name: n,
            }));
          }
        } else if (kind === "compound") {
          const providedChildren = Array.isArray(opts.child) ? opts.child : (opts.child ? [opts.child] : []);
          children = providedChildren.map((ref: string) => resolveBoardReference(config.boards, ref)?.id ?? ref);
        }
        const { boardId } = await runtime.createBoard({ name, kind, columns, children });
        console.log(chalk.green(`✓ Created board: ${name}  [id: ${boardId}]  [kind: ${kind}]`));
        console.log(chalk.dim("  Joined automatically. Run: taskify board sync to confirm."));
      } catch (err) {
        console.error(chalk.red(String(err)));
        exitCode = 1;
      } finally {
        await runtime.disconnect();
        process.exitCode = exitCode;
      }
    });

}
