import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import { registerAgentCommands } from "./commands/agent.js";
import { registerAssignmentsCommands } from "./commands/assignments.js";
import { registerAttachmentsCommands } from "./commands/attachments.js";
import { registerBackupCommands } from "./commands/backup.js";
import { registerBoardCreationCommands } from "./commands/boardCreation.js";
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
import { loadConfig, saveConfig } from "./config.js";
import { createNostrRuntime } from "./nostrRuntime.js";
import { runOnboarding } from "./onboarding.js";
import { checkRelay } from "./relayDiagnostics.js";
import type { AgentIdempotencyStore } from "./shared/agentIdempotency.js";
import type { writeAgentJson } from "./shared/agentOutput.js";
import type { CommandContextDependencies, ShareTransport } from "./commands/context.js";

const require = createRequire(import.meta.url);
const packageVersion = (require("../package.json") as { version: string }).version;

export type CliDependencies = {
  createRuntime?: typeof createNostrRuntime;
  checkRelay?: typeof checkRelay;
  loadConfig?: typeof loadConfig;
  saveConfig?: typeof saveConfig;
  runOnboarding?: typeof runOnboarding;
  randomUUID?: () => string;
  createIdempotencyStore?: () => AgentIdempotencyStore;
  writeAgentJson?: typeof writeAgentJson;
  /** The command clock, for date-relative views such as `upcoming`. */
  now?: () => Date;
  /** Asks the user a question; null when stdin isn't a terminal. */
  prompt?: (question: string) => Promise<string | null>;
  /** NIP-17 share delivery and inbox reads. */
  shareTransport?: ShareTransport;
  /** One-off relay sessions (profiles, contacts, bot command lists). */
  withStandaloneSession?: CommandContextDependencies["withStandaloneSession"];
  version?: string;
};

function composeProgram(dependencies: CliDependencies = {}) {
  const program = new Command();
  program
    .name("taskify")
    .version(dependencies.version ?? packageVersion)
    .description("Taskify CLI — manage tasks over Nostr")
    .option("-P, --profile <name>", "Use a specific profile for this command (does not change active profile)")
    .option("--human", "Render core commands for a human instead of JSON")
    .option("--verbose", "Write transport diagnostics to stderr")
    .exitOverride();

  const context = createCommandContext(program, {
    createRuntime: dependencies.createRuntime,
    loadConfig: dependencies.loadConfig,
    saveConfig: dependencies.saveConfig,
    randomUUID: dependencies.randomUUID,
    createIdempotencyStore: dependencies.createIdempotencyStore,
    writeAgentJson: dependencies.writeAgentJson,
    now: dependencies.now,
    prompt: dependencies.prompt,
    shareTransport: dependencies.shareTransport,
    withStandaloneSession: dependencies.withStandaloneSession,
  });
  const initRuntime = context.initRuntime;
  const relayCheck = dependencies.checkRelay ?? checkRelay;

  registerDiscoveryCommands(program, context);
  const boardCmd = registerBoardsCommands(program, context);
  registerEventsCommands(program, context);
  registerSharingCommands(program, context);
  registerTaskQueriesCommands(program, context);
  registerTaskMutationsCommands(program, context);
  registerAttachmentsCommands(program, context);
  registerTrustCommands(program);
  registerRelayCommands(program, initRuntime, relayCheck);
  registerCacheCommands(program);
  registerConfigCommands(program, initRuntime, relayCheck);
  registerCompletionCommands(program);
  registerAgentCommands(program, context);
  registerTransferCommands(program, context);
  registerBackupCommands(program, context);
  registerInboxCommands(program, context);
  registerBoardCreationCommands(program, context, boardCmd);
  registerAssignmentsCommands(program, context);
  registerProfileCommands(program, context);
  registerBotCommands(program, context);
  registerContactCommands(program, context);
  registerSetupCommands(program);

  return { program, context };
}

/** Build the real Commander tree without parsing argv or terminating the process. */
export function buildProgram(dependencies: CliDependencies = {}): Command {
  return composeProgram(dependencies).program;
}

/** Run one CLI invocation and return its status. The executable decides whether to exit. */
export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let status = 0;
  const { program, context } = composeProgram(dependencies);

  try {
    if (argv.length <= 2) {
      const readConfig = dependencies.loadConfig ?? loadConfig;
      const cfg = await readConfig();
      const hasAnyNsec = Object.values(cfg.profiles).some((profile) => profile.nsec);
      if (!hasAnyNsec) await (dependencies.runOnboarding ?? runOnboarding)();
      else program.outputHelp();
    } else {
      await program.parseAsync(argv);
    }
    status = process.exitCode ?? 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      status = error.exitCode;
    } else {
      status = context.writeCoreFailure("taskify", error, Boolean(program.opts().human));
    }
  } finally {
    process.exitCode = previousExitCode;
  }

  return status;
}
