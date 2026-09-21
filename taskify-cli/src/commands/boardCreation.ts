import chalk from "chalk";
import type { Command } from "commander";
import {
resolveBoardReference
} from "taskify-core";
import { loadConfig } from "../config.js";
import type { CommandContext } from "./context.js";

export function registerBoardCreationCommands(program: Command, context: Pick<CommandContext, "initRuntime">, boardCmd: Command) {
  const { initRuntime } = context;
  // ---- board create ----
  boardCmd
    .command("create <name>")
    .description("Create and publish a new board")
    .option("--kind <lists|week|compound>", "Board kind (default: lists)", "lists")
    .option("--child <id|name>", "Child board id/name (repeatable for compound boards)")
    .option("--relay <url>", "Relay URL hint (informational)")
    .action(async (name: string, opts) => {
      if (!["lists", "week", "compound"].includes(opts.kind)) {
        console.error(chalk.red(`Invalid --kind: "${opts.kind}". Use: lists, week, or compound`));
        process.exit(1);
      }
      const kind = opts.kind as "lists" | "week" | "compound";
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        let columns: { id: string; name: string }[] = [];
        let children: string[] = [];
        if (kind === "lists") {
          const { createInterface } = await import("readline");
          const answer = await new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question("Column names (comma-separated, or blank for none): ", (ans: string) => {
              rl.close();
              resolve(ans.trim());
            });
          });
          if (answer) {
            columns = answer.split(",").map((n) => n.trim()).filter(Boolean).map((n) => ({
              id: crypto.randomUUID(),
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
        process.exit(exitCode);
      }
    });

}
