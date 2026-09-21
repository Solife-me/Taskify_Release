import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { readCache, clearCache, CACHE_TTL_MS } from "../taskCache.js";

export function registerCacheCommands(program: Command) {
  // ---- cache command group ----
  const cacheCmd = program.command("cache").description("Manage task cache");

  cacheCmd
    .command("clear")
    .description("Delete the task cache file")
    .action(() => {
      clearCache();
      console.log(chalk.green("✓ Cache cleared"));
      process.exit(0);
    });

  cacheCmd
    .command("status")
    .description("Show per-board cache age and task count")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const cache = readCache();
      const now = Date.now();
      if (Object.keys(cache.boards).length === 0) {
        console.log(chalk.dim("No cache."));
        process.exit(0);
      }
      for (const board of config.boards) {
        const bc = cache.boards[board.id];
        if (!bc) {
          console.log(`${board.name}: ${chalk.dim("No cache")}`);
          continue;
        }
        const ageMs = now - bc.fetchedAt;
        const ageSec = Math.floor(ageMs / 1000);
        let ageStr: string;
        if (ageSec < 60) {
          ageStr = `${ageSec}s ago`;
        } else if (ageSec < 3600) {
          ageStr = `${Math.floor(ageSec / 60)}m ago`;
        } else {
          ageStr = `${Math.floor(ageSec / 3600)}h ago`;
        }
        const stale = ageMs > CACHE_TTL_MS ? chalk.yellow(" (stale)") : "";
        const openCount = bc.tasks.filter((t) => t.status === "open").length;
        console.log(`${chalk.bold(board.name)}: ${bc.tasks.length} tasks (${openCount} open), cached ${ageStr}${stale}`);
      }
      // Show boards in cache that aren't in config
      for (const [boardId, bc] of Object.entries(cache.boards)) {
        if (!config.boards.find((b) => b.id === boardId)) {
          console.log(chalk.dim(`  [orphan ${boardId.slice(0, 8)}]: ${bc.tasks.length} tasks`));
        }
      }
      process.exit(0);
    });

}
