import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../config.js";

export function registerTrustCommands(program: Command) {
  // ---- trust ----
  const trust = program.command("trust").description("Manage trusted npubs");

  trust
    .command("add <npub>")
    .description("Add a trusted npub")
    .action(async (npub: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.trustedNpubs.includes(npub)) {
        config.trustedNpubs.push(npub);
      }
      await saveConfig(config);
      console.log(chalk.green("✓ Added"));
      process.exit(0);
    });

  trust
    .command("remove <npub>")
    .description("Remove a trusted npub")
    .action(async (npub: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      config.trustedNpubs = config.trustedNpubs.filter((n) => n !== npub);
      await saveConfig(config);
      console.log(chalk.green("✓ Removed"));
      process.exit(0);
    });

  trust
    .command("list")
    .description("List trusted npubs")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (config.trustedNpubs.length === 0) {
        console.log(chalk.dim("No trusted npubs."));
      } else {
        for (const npub of config.trustedNpubs) {
          console.log(npub);
        }
      }
      process.exit(0);
    });

}
