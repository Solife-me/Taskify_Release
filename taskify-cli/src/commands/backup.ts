import chalk from "chalk";
import type { Command } from "commander";
import { readFile } from "fs/promises";
import { loadConfig,saveConfig } from "../config.js";
import { mergeBoardsFromBackup,mergeRelaysFromBackup,parseBackupSnapshot } from "../shared/backupSync.js";

export function registerBackupCommands(program: Command) {
  // ---- backup snapshot ----
  const backupCmd = program
    .command("backup")
    .description("Inspect and apply Taskify backup snapshot metadata");

  backupCmd
    .command("inspect <file>")
    .description("Inspect snapshot metadata (boards/default relays/settings keys)")
    .action(async (file: string) => {
      let raw = "";
      try {
        raw = await readFile(file, "utf-8");
      } catch {
        console.error(chalk.red(`Cannot read file: ${file}`));
        process.exit(1);
      }

      try {
        const snapshot = parseBackupSnapshot(raw);
        console.log(chalk.bold("Backup snapshot summary"));
        console.log(`  boards:         ${snapshot.boards.length}`);
        console.log(`  default relays: ${snapshot.defaultRelays.length}`);
        console.log(`  settings keys:  ${Object.keys(snapshot.settings).length}`);
        console.log(`  wallet seed:    ${Object.keys(snapshot.walletSeed).length > 0 ? "present" : "empty"}`);
        if (snapshot.defaultRelays.length > 0) {
          console.log(chalk.dim(`  relays: ${snapshot.defaultRelays.join(", ")}`));
        }
        if (snapshot.boards.length > 0) {
          console.log(chalk.bold("\nBoards:"));
          for (const board of snapshot.boards) {
            const boardKind = board.kind ?? "lists";
            const relayCount = Array.isArray(board.relays) ? board.relays.length : 0;
            console.log(`  - ${board.name ?? board.id} (${boardKind}) [nostrId: ${board.nostrId}] relays=${relayCount}`);
          }
        }
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });

  backupCmd
    .command("merge-boards <file>")
    .description("Merge backup board metadata into local CLI board config")
    .option("--dry-run", "Preview merge without saving")
    .action(async (file: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);

      let raw = "";
      try {
        raw = await readFile(file, "utf-8");
      } catch {
        console.error(chalk.red(`Cannot read file: ${file}`));
        process.exit(1);
      }

      try {
        const snapshot = parseBackupSnapshot(raw);
        const merged = mergeBoardsFromBackup(config.boards, snapshot.boards, snapshot.defaultRelays);
        const changedCount = merged.filter((board, idx) => JSON.stringify(board) !== JSON.stringify(config.boards[idx])).length;
        if (changedCount === 0 && merged.length === config.boards.length) {
          console.log(chalk.dim("No board changes to apply."));
          process.exit(0);
        }

        console.log(chalk.bold(`Board merge preview: ${config.boards.length} → ${merged.length}`));
        console.log(`  changed/new boards: ${changedCount}`);

        if (opts.dryRun) {
          console.log(chalk.dim("[dry-run] No config written."));
          process.exit(0);
        }

        config.boards = merged;
        await saveConfig(config);
        console.log(chalk.green(`✓ Applied board merge (${changedCount} changed/new)`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });

  backupCmd
    .command("merge-relays <file>")
    .description("Apply backup default relays to local CLI relay config")
    .option("--dry-run", "Preview relay changes without saving")
    .action(async (file: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);

      let raw = "";
      try {
        raw = await readFile(file, "utf-8");
      } catch {
        console.error(chalk.red(`Cannot read file: ${file}`));
        process.exit(1);
      }

      try {
        const snapshot = parseBackupSnapshot(raw);
        const mergedRelays = mergeRelaysFromBackup(config.relays, snapshot.defaultRelays);
        const changed = JSON.stringify(mergedRelays) !== JSON.stringify(config.relays);
        if (!changed) {
          console.log(chalk.dim("No relay changes to apply."));
          process.exit(0);
        }

        console.log(chalk.bold("Relay merge preview"));
        console.log(`  current relays: ${config.relays.length}`);
        console.log(`  backup relays:  ${snapshot.defaultRelays.length}`);
        console.log(`  merged relays:  ${mergedRelays.length}`);

        if (opts.dryRun) {
          console.log(chalk.dim("[dry-run] No config written."));
          process.exit(0);
        }

        config.relays = mergeRelaysFromBackup(config.relays, snapshot.defaultRelays);
        await saveConfig(config);
        console.log(chalk.green(`✓ Applied relay merge (${config.relays.length} relay${config.relays.length === 1 ? "" : "s"})`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });

}
