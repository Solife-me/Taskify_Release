import chalk from "chalk";
import type { Command } from "commander";
import { resolveBoardReference } from "taskify-core";
import { loadConfig,redactConfig,saveConfig } from "../config.js";
import type { createNostrRuntime } from "../nostrRuntime.js";
import { formatAvailableColumns,resolveBoardColumn } from "../shared/columnResolution.js";

export function registerConfigCommands(program: Command, initRuntime: typeof createNostrRuntime, checkRelay: (url: string) => Promise<boolean>): void {
  // ---- config ----
  const configCmd = program.command("config").description("Manage CLI config");

  const configSet = configCmd.command("set").description("Set config values");

  configSet
    .command("nsec <nsec>")
    .description("Set your nsec private key")
    .action(async (nsec: string) => {
      if (!nsec.startsWith("nsec1")) {
        console.error(chalk.red(`Invalid nsec: must start with "nsec1".`));
        process.exit(1);
      }
      const config = await loadConfig(program.opts().profile as string | undefined);
      config.nsec = nsec;
      await saveConfig(config);
      console.log(chalk.green("✓ nsec saved"));
      process.exit(0);
    });

  configSet
    .command("relay <url>")
    .description("Add a relay URL")
    .action(async (url: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.relays.includes(url)) {
        config.relays.push(url);
      }
      await saveConfig(config);
      console.log(chalk.green("✓ Relay added"));
      process.exit(0);
    });

  configSet
    .command("file-server <url>")
    .description("Set default public file server URL")
    .action(async (url: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      config.fileStorageServer = url.trim();
      await saveConfig(config);
      console.log(chalk.green(`✓ Public file server set to ${config.fileStorageServer}`));
      process.exit(0);
    });

  configSet
    .command("encrypted-file-server <url>")
    .description("Set default encrypted file server URL")
    .action(async (url: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      config.encryptedFileStorageServer = url.trim();
      await saveConfig(config);
      console.log(chalk.green(`✓ Encrypted file server set to ${config.encryptedFileStorageServer}`));
      process.exit(0);
    });

  // default-list: set the default board + column for this profile
  configSet
    .command("default-list <board> <list>")
    .description("Set default board + list for this profile")
    .action(async (board: string, list: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const resolvedBoard = resolveBoardReference(config.boards, board);
      if (!resolvedBoard) {
        const hint = config.boards.length > 0
          ? `Known boards: ${config.boards.map(b => b.name).join(', ')}`
          : 'No boards configured yet.';
        console.error(chalk.red(`Board not found: "${board}". ${hint}`));
        process.exit(1);
      }
      // Validate list name against board columns
      const runtime = initRuntime(config);
      const syncedAt = resolvedBoard.syncedAt ?? 0;
      const THIRTY_MIN_MS = 30 * 60 * 1000;
      if (!resolvedBoard.columns || Date.now() - syncedAt > THIRTY_MIN_MS) {
        try {
          await runtime.syncBoard(resolvedBoard.id);
        } catch { // non-fatal
        }
      }
      const resolvedList = resolveBoardColumn(resolvedBoard, list);
      if (!resolvedList.ok) {
        console.error(chalk.red(`List not found: "${list}" on "${resolvedBoard.name}".`));
        console.error(chalk.dim(`Available lists:\n${formatAvailableColumns(resolvedList.available)}`));
        await runtime.disconnect();
        process.exit(1);
      }
      const profileCfg = config.profiles?.[config.selectedProfile];
      if (!profileCfg) {
        console.error(chalk.red("No selected profile found."));
        process.exit(1);
      }
      config.defaultBoard = resolvedBoard.id;
      config.defaultColumn = resolvedList.column.id;
      config.defaultLocation = { boardId: resolvedBoard.id, listId: resolvedList.column.id };
      config.defaultList = `${resolvedBoard.name}/${resolvedList.column.name}`;
      profileCfg.defaultBoard = config.defaultBoard;
      profileCfg.defaultColumn = config.defaultColumn;
      profileCfg.defaultLocation = config.defaultLocation;
      profileCfg.defaultList = config.defaultList;
      await saveConfig(config);
      console.log(chalk.green(`✓ Default list set: "${resolvedBoard.name}" → ${resolvedList.column.name}`));
      console.log(chalk.dim(`  In this profile, "taskify list" will now show the "${resolvedList.column.name}" list.`));
      await runtime.disconnect();
      process.exit(0);
    });



  configCmd
    .command("show")
    .description("Show current config")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const display = redactConfig(config);
      console.log(JSON.stringify(display, null, 2));

      console.log("\nChecking relays...");
      for (const relay of config.relays) {
        const ok = await checkRelay(relay);
        if (ok) {
          console.log(chalk.green(`✓ ${relay}`) + chalk.dim("  (connected)"));
        } else {
          console.log(chalk.red(`✗ ${relay}`) + chalk.dim("  (timeout)"));
        }
      }
      process.exit(0);
    });
}
