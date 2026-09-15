import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig,saveConfig,type BoardEntry } from "../config.js";
import type { CommandContext } from "./context.js";

export function registerBoardListAliasCommands(program: Command, context: Pick<CommandContext, "initRuntime">) {
  const { initRuntime } = context;
  // ---- boards (alias for board list) ----
  program
    .command("boards")
    .description("List configured boards (alias for: board list)")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (config.boards.length === 0) {
        console.log(chalk.dim("No boards configured. Use: taskify board join <id> --name <name>"));
        process.exit(0);
      }

      const UUID_PREFIX_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
      const stale = config.boards.filter(
        (b) => UUID_PREFIX_RE.test(b.name) || b.name === b.id || b.name === b.id.slice(0, 8),
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
            } catch { /* non-fatal */ }
          }
          await runtime.disconnect();
          await saveConfig(config);
        } catch { /* non-fatal */ }
      }

      for (const b of config.boards) {
        console.log(`  ${chalk.bold(b.name.padEnd(16))} ${chalk.dim(b.id)}`);
      }
      process.exit(0);
    });

}
