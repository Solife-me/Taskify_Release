import type { Command } from "commander";
import chalk from "chalk";
import { readFile } from "fs/promises";
import { nip19, getPublicKey } from "nostr-tools";
import { loadConfig } from "../config.js";
import {
  fetchBotCommands,
  fetchInboxRelays,
  parsePubkey,
  publishBotCommands,
  validateBotCommandsDraft,
} from "../shared/botCommands.js";

export function registerBotCommands(program: Command) {
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
        process.exit(1);
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
        process.exit(1);
      }

      let commands: { name: string; description: string }[];
      try {
        commands = validateBotCommandsDraft(parsed);
      } catch (err) {
        console.error(chalk.red(String(err instanceof Error ? err.message : err)));
        process.exit(1);
      }

      const decoded = nip19.decode(config.nsec);
      if (decoded.type !== "nsec") { console.error(chalk.red("Invalid nsec")); process.exit(1); }
      const pubkeyHex = getPublicKey(decoded.data as Uint8Array);

      const inboxRelays = await fetchInboxRelays(pubkeyHex, config.relays);
      const publishRelays = Array.from(new Set([...config.relays, ...inboxRelays]));
      console.error(chalk.dim(`  Publishing ${commands.length} command${commands.length === 1 ? "" : "s"} to ${publishRelays.length} relay${publishRelays.length === 1 ? "" : "s"}...`));

      try {
        const { event } = await publishBotCommands(config.nsec, commands, publishRelays);
        if (opts.json) {
          console.log(JSON.stringify(event, null, 2));
        } else {
          console.log(chalk.green(`✓ Bot commands published (event: ${event.id?.slice(0, 8)}...)`));
          for (const command of commands) console.log(`  /${command.name}  ${command.description}`);
          console.log(chalk.dim(`  npub: ${nip19.npubEncode(pubkeyHex)}`));
        }
      } catch (err) {
        console.error(chalk.red(`Failed to publish bot commands: ${String(err)}`));
        process.exit(1);
      }
      process.exit(0);
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
          process.exit(1);
        }
      } else {
        if (!config.nsec) {
          console.error(chalk.red("No nsec configured and no npub given."));
          process.exit(1);
        }
        const decoded = nip19.decode(config.nsec);
        if (decoded.type !== "nsec") { console.error(chalk.red("Invalid nsec")); process.exit(1); }
        peerHex = getPublicKey(decoded.data as Uint8Array);
      }

      const inboxRelays = await fetchInboxRelays(peerHex, config.relays);
      const relays = Array.from(new Set([...config.relays, ...inboxRelays]));
      console.error(chalk.dim("  Fetching bot commands from relays..."));
      const { event, commands } = await fetchBotCommands(peerHex, relays);

      if (!event) {
        if (opts.json) {
          console.log(JSON.stringify({ npub: nip19.npubEncode(peerHex), eventId: null, commands: [] }));
        } else {
          console.log(chalk.yellow("No bot commands list found for this npub."));
        }
        process.exit(0);
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
      process.exit(0);
    });

}
