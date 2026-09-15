import type { Command } from "commander";
import { createInterface } from "readline";
import { loadConfig } from "../config.js";
import { runOnboarding } from "../onboarding.js";

export function registerSetupCommands(program: Command) {
  // ---- setup ----
  program
    .command("setup")
    .description("Run the first-run onboarding wizard (re-configure a profile)")
    .option("--profile <name>", "Profile to configure (defaults to active profile)")
    .action(async (opts) => {
      // --profile on setup subcommand takes precedence over global --profile
      const targetProfile = opts.profile ?? (program.opts().profile as string | undefined);
      const existing = await loadConfig(targetProfile);
      if (existing.nsec) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = await new Promise<string>((resolve) => {
          rl.question(
            `⚠ Profile "${existing.selectedProfile}" already has a private key. This will replace it.\nContinue? [Y/n] `,
            resolve,
          );
        });
        rl.close();
        if (ans.trim().toLowerCase() === "n") {
          process.exit(0);
        }
      }
      await runOnboarding(targetProfile ?? existing.selectedProfile);
    });

}
