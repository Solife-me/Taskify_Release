import type { Command } from "commander";
import chalk from "chalk";
import { zshCompletion, bashCompletion, fishCompletion } from "../completions.js";

export function registerCompletionCommands(program: Command): void {
  // ---- completions ----
  program
    .command("completions")
    .description("Generate shell completion scripts")
    .option("--shell <zsh|bash|fish>", "Shell type (defaults to current shell)")
    .action((opts) => {
      let shell = opts.shell as string | undefined;
      if (!shell) {
        const envShell = process.env.SHELL ?? "";
        if (envShell.includes("zsh")) shell = "zsh";
        else if (envShell.includes("bash")) shell = "bash";
        else {
          // Print all three if shell cannot be determined
          process.stdout.write(zshCompletion());
          process.stdout.write("\n");
          process.stdout.write(bashCompletion());
          process.stdout.write("\n");
          process.stdout.write(fishCompletion());
          process.exit(0);
        }
      }
      switch (shell) {
        case "zsh":
          process.stdout.write(zshCompletion());
          break;
        case "bash":
          process.stdout.write(bashCompletion());
          break;
        case "fish":
          process.stdout.write(fishCompletion());
          break;
        default:
          console.error(chalk.red(`Unknown shell: "${shell}". Use: zsh, bash, or fish`));
          process.exit(1);
      }
      process.exit(0);
    });

}
