import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../config.js";
import type { createNostrRuntime } from "../nostrRuntime.js";

export function registerRelayCommands(program: Command, initRuntime: typeof createNostrRuntime, checkRelay: (url: string) => Promise<boolean>) {
  // ---- relay command group ----
  const relayCmd = program.command("relay").description("Manage relay connections");

  relayCmd
    .command("status")
    .description("Show connection status of relays in the NDK pool")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const statuses = await runtime.getRelayStatus();
        if (statuses.length === 0) {
          console.log(chalk.dim("No relays configured."));
        } else {
          for (const { url, connected } of statuses) {
            if (connected) {
              console.log(chalk.green(`✓ ${url}`) + chalk.dim("  connected"));
            } else {
              console.log(chalk.red(`✗ ${url}`) + chalk.dim("  disconnected"));
            }
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

  relayCmd
    .command("list")
    .description("Show configured relays with live connection check")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (config.relays.length === 0) {
        console.log(chalk.dim("No relays configured."));
        process.exit(0);
      }
      console.log(chalk.dim(`Checking ${config.relays.length} relay(s)...`));
      for (const relay of config.relays) {
        const ok = await checkRelay(relay);
        if (ok) {
          console.log(chalk.green(`✓ ${relay}`) + chalk.dim("  connected"));
        } else {
          console.log(chalk.red(`✗ ${relay}`) + chalk.dim("  disconnected"));
        }
      }
      process.exit(0);
    });

  relayCmd
    .command("add <url>")
    .description("Add a relay URL to config")
    .action(async (url: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.relays.includes(url)) {
        config.relays.push(url);
        await saveConfig(config);
        console.log(chalk.green(`✓ Relay added: ${url}`));
      } else {
        console.log(chalk.dim(`Relay already configured: ${url}`));
      }
      process.exit(0);
    });

  relayCmd
    .command("remove <url>")
    .description("Remove a relay URL from config")
    .action(async (url: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const before = config.relays.length;
      config.relays = config.relays.filter((r) => r !== url);
      if (config.relays.length === before) {
        console.error(chalk.red(`Relay not found in config: ${url}`));
        process.exit(1);
      }
      await saveConfig(config);
      console.log(chalk.green(`✓ Relay removed: ${url}`));
      process.exit(0);
    });

}
