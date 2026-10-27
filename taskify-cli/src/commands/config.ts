import chalk from "chalk";
import { readSecret } from "../shared/readSecret.js";
import type { Command } from "commander";
import { resolveBoardReference } from "taskify-core";
import { loadConfig,redactConfig,saveConfig } from "../config.js";
import type { createNostrRuntime } from "../nostrRuntime.js";
import { formatAvailableColumns,resolveBoardColumn } from "../shared/columnResolution.js";
import { MAX_PROOF_OF_WORK_DIFFICULTY } from "taskify-runtime-nostr";
import { parsePowDifficulty } from "../shared/relaySettings.js";
import { normalizeRelayInput } from "./relay.js";

export function registerConfigCommands(program: Command, initRuntime: typeof createNostrRuntime, checkRelay: (url: string) => Promise<boolean>): void {
  // ---- config ----
  const configCmd = program.command("config").description("Manage CLI config");

  const configSet = configCmd.command("set").description("Set config values");

  configSet
    .command("nsec [nsec]")
    .description("Set your nsec private key (omit it to be prompted, or pass - to read standard input)")
    .action(async (provided: string | undefined) => {
      const nsec = await readSecret(provided, "nsec: ");
      if (!nsec.startsWith("nsec1")) {
        console.error(chalk.red(`Invalid nsec: must start with "nsec1".`));
        process.exitCode = 1; return;
      }
      const config = await loadConfig(program.opts().profile as string | undefined);
      config.nsec = nsec;
      await saveConfig(config);
      console.log(chalk.green("✓ nsec saved"));
      return;
    });

  configSet
    .command("relay <url>")
    .description("Add a relay URL")
    .action(async (url: string) => {
      const normalized = normalizeRelayInput(url);
      if (!normalized) {
        console.error(chalk.red(`Not a relay URL: ${url} (expected wss://… or ws://…)`));
        process.exitCode = 1; return;
      }
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.relays.some((relay) => normalizeRelayInput(relay) === normalized)) {
        config.relays.push(normalized);
      }
      await saveConfig(config);
      console.log(chalk.green("✓ Relay added"));
      return;
    });

  configSet
    .command("pow <difficulty>")
    .description(`Mine NIP-13 proof of work of at least this difficulty into every write (0-${MAX_PROOF_OF_WORK_DIFFICULTY}; 0 = only what relays require)`)
    .action(async (raw: string) => {
      const difficulty = parsePowDifficulty(raw);
      if (difficulty === null) {
        console.error(chalk.red(`Invalid difficulty: "${raw}". Use a whole number from 0 to ${MAX_PROOF_OF_WORK_DIFFICULTY}.`));
        process.exitCode = 1; return;
      }
      const config = await loadConfig(program.opts().profile as string | undefined);
      config.powDifficulty = difficulty || undefined;
      await saveConfig(config);
      console.log(chalk.green(difficulty
        ? `✓ Writes will carry at least difficulty ${difficulty} proof of work`
        : "✓ Proof of work only where relays require it"));
      if (difficulty >= 22) console.log(chalk.dim("  High difficulties can take a minute or more to mine per write."));
      return;
    });

  configSet
    .command("file-server <url>")
    .description("Set default public file server URL")
    .action(async (url: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      config.fileStorageServer = url.trim();
      await saveConfig(config);
      console.log(chalk.green(`✓ Public file server set to ${config.fileStorageServer}`));
      return;
    });

  configSet
    .command("encrypted-file-server <url>")
    .description("Set default encrypted file server URL")
    .action(async (url: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      config.encryptedFileStorageServer = url.trim();
      await saveConfig(config);
      console.log(chalk.green(`✓ Encrypted file server set to ${config.encryptedFileStorageServer}`));
      return;
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
        process.exitCode = 1; return;
      }
      // Validate list name against board columns
      const runtime = initRuntime(config);
      try {
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
          process.exitCode = 1;
          return;
        }
        const profileCfg = config.profiles?.[config.selectedProfile];
        if (!profileCfg) {
          console.error(chalk.red("No selected profile found."));
          process.exitCode = 1;
          return;
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
      } finally {
        await runtime.disconnect();
      }
    });



  configCmd
    .command("show")
    .description("Show current config")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const display = redactConfig(config);
      console.log(JSON.stringify(display, null, 2));

      console.log("\nChecking relays...");
      const results = await Promise.all(config.relays.map(async (relay) => ({ relay, ok: await checkRelay(relay) })));
      for (const { relay, ok } of results) {
        if (ok) {
          console.log(chalk.green(`✓ ${relay}`) + chalk.dim("  (connected)"));
        } else {
          console.log(chalk.red(`✗ ${relay}`) + chalk.dim("  (timeout)"));
        }
      }
      return;
    });
}
