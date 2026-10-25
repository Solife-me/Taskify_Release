import type { Command } from "commander";
import { sanitizeRemote } from "../shared/displaySafe.js";
import chalk from "chalk";
import { readFile } from "fs/promises";
import { nip19, getPublicKey } from "nostr-tools";
import {
  fetchBotCommands,
  fetchInboxRelays,
  parsePubkey,
  publishBotCommands,
  validateBotCommandsDraft,
} from "../shared/botCommands.js";
import type { CommandContext } from "./context.js";

export function registerBotCommands(program: Command, context: Pick<CommandContext, "loadConfig" | "withStandaloneSession">) {
  const { loadConfig, withStandaloneSession } = context;
  // ---- bot command group (NIP-51 bot commands list — docs/reference/bot-command-lists.md) ----
  const botCmd = program
    .command("bot")
    .description("Publish and inspect the NIP-51 bot commands list (kind 30078, d-tag taskify-bot-commands)");

  botCmd
    .command("publish-commands [file]")
    .description("Publish the bot commands list from a JSON file (array of {name, description}); use \"-\" for stdin")
    .option("--json", "Output the signed event as JSON")
    .action(async (file: string | undefined, opts: { json?: boolean }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.nsec) {
        console.error(chalk.red("No nsec configured. Run `taskify setup` or set TASKIFY_NSEC."));
        process.exitCode = 1; return;
      }

      let raw: string;
      if (!file || file === "-") {
        raw = await new Promise<string>((resolve, reject) => {
          let data = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => { data += chunk; });
          process.stdin.on("end", () => resolve(data));
          process.stdin.on("error", reject);
        });
      } else {
        raw = await readFile(file, "utf8");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.error(chalk.red(`Invalid JSON: ${String(err)}`));
        process.exitCode = 1; return;
      }

      let commands: { name: string; description: string }[];
      try {
        commands = validateBotCommandsDraft(parsed);
      } catch (err) {
        console.error(chalk.red(String(err instanceof Error ? err.message : err)));
        process.exitCode = 1; return;
      }

      const decoded = nip19.decode(config.nsec);
      if (decoded.type !== "nsec") { console.error(chalk.red("Invalid nsec")); process.exitCode = 1; return; }
      const pubkeyHex = getPublicKey(decoded.data as Uint8Array);

      const inboxRelays = await fetchInboxRelays(pubkeyHex, config.relays, { withSession: withStandaloneSession });
      const publishRelays = Array.from(new Set([...config.relays, ...inboxRelays]));
      console.error(chalk.dim(`  Publishing ${commands.length} command${commands.length === 1 ? "" : "s"} to ${publishRelays.length} relay${publishRelays.length === 1 ? "" : "s"}...`));

      try {
        const { event } = await publishBotCommands(config.nsec, commands, publishRelays, { withSession: withStandaloneSession });
        if (opts.json) {
          console.log(JSON.stringify(event, null, 2));
        } else {
          console.log(chalk.green(`✓ Bot commands published (event: ${event.id?.slice(0, 8)}...)`));
          for (const command of commands) console.log(`  /${command.name}  ${command.description}`);
          console.log(chalk.dim(`  npub: ${nip19.npubEncode(pubkeyHex)}`));
        }
      } catch (err) {
        console.error(chalk.red(`Failed to publish bot commands: ${String(err)}`));
        process.exitCode = 1; return;
      }
      return;
    });

  botCmd
    .command("show-commands [npub]")
    .description("Fetch and display a peer's published bot commands list (defaults to active profile)")
    .option("--json", "Output the parsed commands as JSON")
    .action(async (npub: string | undefined, opts: { json?: boolean }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      let peerHex: string | null = null;
      if (npub) {
        peerHex = parsePubkey(npub);
        if (!peerHex) {
          console.error(chalk.red("Invalid npub or hex pubkey."));
          process.exitCode = 1; return;
        }
      } else {
        if (!config.nsec) {
          console.error(chalk.red("No nsec configured and no npub given."));
          process.exitCode = 1; return;
        }
        const decoded = nip19.decode(config.nsec);
        if (decoded.type !== "nsec") { console.error(chalk.red("Invalid nsec")); process.exitCode = 1; return; }
        peerHex = getPublicKey(decoded.data as Uint8Array);
      }

      const inboxRelays = await fetchInboxRelays(peerHex, config.relays, { withSession: withStandaloneSession });
      const relays = Array.from(new Set([...config.relays, ...inboxRelays]));
      console.error(chalk.dim("  Fetching bot commands from relays..."));
      const fetched = await fetchBotCommands(peerHex, relays, { withSession: withStandaloneSession });
      const event = fetched.event;
      // The bot writes these names and descriptions; they are shown in the terminal.
      const commands = sanitizeRemote(fetched.commands);

      if (!event) {
        if (opts.json) {
          console.log(JSON.stringify({ npub: nip19.npubEncode(peerHex), eventId: null, commands: [] }));
        } else {
          console.log(chalk.yellow("No bot commands list found for this npub."));
        }
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify({
          npub: nip19.npubEncode(peerHex),
          eventId: event.id,
          createdAt: event.created_at,
          commands,
        }, null, 2));
      } else {
        console.log(chalk.bold(`Bot commands: ${nip19.npubEncode(peerHex)}`));
        for (const command of commands) console.log(`  /${command.name}  ${command.description}`);
        console.log(chalk.dim(`  (event id: ${event.id?.slice(0, 8)}..., created_at: ${new Date((event.created_at ?? 0) * 1000).toISOString()})`));
      }
      return;
    });

}
