#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "module";
import { registerAgentCommands } from "./commands/agent.js";
import { registerAssignmentsCommands } from "./commands/assignments.js";
import { registerAttachmentsCommands } from "./commands/attachments.js";
import { registerBackupCommands } from "./commands/backup.js";
import { registerBoardCreationCommands } from "./commands/boardCreation.js";
import { registerBoardListAliasCommands } from "./commands/boardListAlias.js";
import { registerBoardsCommands } from "./commands/boards.js";
import { registerBotCommands } from "./commands/bot.js";
import { registerCacheCommands } from "./commands/cache.js";
import { registerCompletionCommands } from "./commands/completions.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerContactCommands } from "./commands/contact.js";
import { createCommandContext } from "./commands/context.js";
import { registerDiscoveryCommands } from "./commands/discovery.js";
import { registerEventsCommands } from "./commands/events.js";
import { registerInboxCommands } from "./commands/inbox.js";
import { registerProfileCommands } from "./commands/profile.js";
import { registerRelayCommands } from "./commands/relay.js";
import { registerSetupCommands } from "./commands/setup.js";
import { registerSharingCommands } from "./commands/sharing.js";
import { registerTaskMutationsCommands } from "./commands/taskMutations.js";
import { registerTaskQueriesCommands } from "./commands/taskQueries.js";
import { registerTransferCommands } from "./commands/transfer.js";
import { registerTrustCommands } from "./commands/trust.js";
import { loadConfig } from "./config.js";
import { runOnboarding } from "./onboarding.js";
import { checkRelay } from "./relayDiagnostics.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const program = new Command();

program
  .name("taskify")
  .version(version)
  .description("Taskify CLI — manage tasks over Nostr")
  .option("-P, --profile <name>", "Use a specific profile for this command (does not change active profile)")
  .option("--human", "Render core commands for a human instead of JSON")
  .option("--verbose", "Write transport diagnostics to stderr");

const context = createCommandContext(program);
const { initRuntime, writeCoreFailure } = context;

registerDiscoveryCommands(program, context);

const boardCmd = registerBoardsCommands(program, context);

registerBoardListAliasCommands(program, context);

registerEventsCommands(program, context);

registerSharingCommands(program, context);

registerTaskQueriesCommands(program, context);

registerTaskMutationsCommands(program, context);

registerAttachmentsCommands(program, context);

registerTrustCommands(program);

registerRelayCommands(program, initRuntime, checkRelay);

registerCacheCommands(program);

registerConfigCommands(program, initRuntime, checkRelay);

registerCompletionCommands(program);

registerAgentCommands(program, context);

registerTransferCommands(program, context);

registerBackupCommands(program);

registerInboxCommands(program, context);

registerBoardCreationCommands(program, context, boardCmd);

registerAssignmentsCommands(program, context);

registerProfileCommands(program);

registerBotCommands(program);
registerContactCommands(program, initRuntime);

registerSetupCommands(program);

// ---- auto-onboarding trigger + parse ----
// Commands (including --help) load configuration only inside their actions.
// This keeps read-only invocations usable in sandboxes and mounted home dirs.
try {
  if (process.argv.length <= 2) {
    const cfg = await loadConfig();
    const hasAnyNsec = Object.values(cfg.profiles).some((profile) => profile.nsec);
    if (!hasAnyNsec) await runOnboarding();
    else program.outputHelp();
  } else {
    await program.parseAsync(process.argv);
    // NDK relay objects maintain long-lived housekeeping timers by design.
    // Command actions have already awaited persistence and transport shutdown,
    // so terminate the one-shot CLI explicitly instead of keeping agents open.
    process.exit(process.exitCode ?? 0);
  }
} catch (error) {
  process.exitCode = writeCoreFailure("taskify", error, Boolean(program.opts().human));
  process.exit(process.exitCode);
}
