import type { Command } from "commander";
import chalk from "chalk";
import { normalizeRelayUrls, type RelayRuntimeStatus } from "taskify-runtime-nostr";
import { loadConfig, saveConfig } from "../config.js";
import type { createNostrRuntime } from "../nostrRuntime.js";
import { fetchRelayInformation, type RelayInformation } from "../shared/relayInformation.js";
import { renderJson } from "../render.js";

/** The canonical form of a relay URL, or null when it isn't a ws:// or wss:// URL. */
export function normalizeRelayInput(url: string): string | null {
  return normalizeRelayUrls([url])[0] ?? null;
}

function sameRelay(left: string, right: string): boolean {
  return (normalizeRelayInput(left) ?? left) === (normalizeRelayInput(right) ?? right);
}

function powLabel(difficulty: number): string {
  return difficulty > 0 ? `PoW ${difficulty}` : "";
}

function authLabel(status: RelayRuntimeStatus): string {
  const auth = status.auth;
  if (auth?.state === "authenticated") return chalk.green(auth.ephemeral ? "authenticated (anonymous)" : "authenticated");
  if (auth?.state === "failed") return chalk.red(`auth refused${auth.reason ? `: ${auth.reason}` : ""}`);
  if (auth?.state === "no-key") return chalk.yellow("auth needed, no key");
  return status.authRequired ? chalk.yellow("auth required") : "";
}

function accessSummary(info: RelayInformation): string {
  const parts = [
    info.authRequired ? "auth required" : "",
    powLabel(Math.max(info.minPowDifficulty, info.learnedPowDifficulty)),
    info.paymentRequired ? "paid" : "",
    info.restrictedWrites ? "restricted writes" : "",
  ].filter(Boolean);
  return parts.join(", ");
}

export function registerRelayCommands(program: Command, initRuntime: typeof createNostrRuntime, checkRelay: (url: string) => Promise<boolean>) {
  const relayCmd = program.command("relay").description("Manage relay connections");

  relayCmd
    .command("status")
    .description("Connect to the profile's relays and show connection, NIP-42 auth and NIP-13 PoW state")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      let exitCode = 0;
      try {
        const statuses = await runtime.getRelayStatus();
        if (opts.json) {
          renderJson(statuses);
        } else if (statuses.length === 0) {
          console.log(chalk.dim("No relays configured."));
        } else {
          for (const status of statuses) {
            const details = [authLabel(status), powLabel(status.minPowDifficulty)].filter(Boolean).join(chalk.dim(" · "));
            const head = status.connected ? chalk.green(`✓ ${status.url}`) + chalk.dim("  connected") : chalk.red(`✗ ${status.url}`) + chalk.dim("  disconnected");
            console.log(details ? `${head}${chalk.dim("  ·  ")}${details}` : head);
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
    .description("Show configured relays with a live connection check and their access requirements")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (config.relays.length === 0) {
        if (opts.json) renderJson([]);
        else console.log(chalk.dim("No relays configured."));
        process.exit(0);
      }
      if (!opts.json) console.log(chalk.dim(`Checking ${config.relays.length} relay(s)...`));
      const rows = await Promise.all(config.relays.map(async (relay) => {
        const [connected, info] = await Promise.all([checkRelay(relay), fetchRelayInformation(relay)]);
        return { relay, connected, info };
      }));
      if (opts.json) {
        renderJson(rows.map(({ relay, connected, info }) => ({
          url: relay,
          connected,
          authRequired: info.authRequired,
          minPowDifficulty: Math.max(info.minPowDifficulty, info.learnedPowDifficulty),
          paymentRequired: info.paymentRequired,
          restrictedWrites: info.restrictedWrites,
        })));
        process.exit(0);
      }
      for (const { relay, connected, info } of rows) {
        const summary = accessSummary(info);
        const head = connected ? chalk.green(`✓ ${relay}`) + chalk.dim("  connected") : chalk.red(`✗ ${relay}`) + chalk.dim("  disconnected");
        console.log(summary ? `${head}${chalk.dim(`  ·  ${summary}`)}` : head);
      }
      process.exit(0);
    });

  relayCmd
    .command("info <url>")
    .description("Show a relay's NIP-11 details, including NIP-42 auth and NIP-13 PoW requirements")
    .option("--json", "Output as JSON")
    .action(async (url: string, opts: { json?: boolean }) => {
      const normalized = normalizeRelayInput(url);
      if (!normalized) {
        console.error(chalk.red(`Not a relay URL: ${url} (expected wss://… or ws://…)`));
        process.exit(1);
      }
      const [connected, info] = await Promise.all([checkRelay(normalized), fetchRelayInformation(normalized)]);
      if (opts.json) {
        renderJson({ ...info, connected });
        process.exit(0);
      }
      const yesNo = (value: boolean) => (value ? chalk.yellow("yes") : "no");
      console.log(chalk.bold(info.name ?? normalized));
      console.log(`  URL:               ${normalized}`);
      console.log(`  Connection:        ${connected ? chalk.green("ok") : chalk.red("failed")}`);
      if (info.software) console.log(`  Software:          ${info.software}${info.version ? ` ${info.version}` : ""}`);
      if (!info.nip11) console.log(`  NIP-11:            ${chalk.yellow(`unavailable${info.error ? ` (${info.error})` : ""}`)}`);
      else {
        const nips = info.supportedNips;
        console.log(`  Supported NIPs:    ${nips.length ? nips.join(", ") : chalk.dim("not listed")}`);
        console.log(`  Auth (NIP-42):     ${info.authRequired ? chalk.yellow("required") : nips.includes(42) ? "supported" : "not required"}`);
        console.log(`  PoW (NIP-13):      ${info.minPowDifficulty > 0 ? chalk.yellow(`difficulty ${info.minPowDifficulty}`) : "none advertised"}`);
        console.log(`  Payment required:  ${yesNo(info.paymentRequired)}`);
        console.log(`  Restricted writes: ${yesNo(info.restrictedWrites)}`);
      }
      if (info.learnedPowDifficulty > info.minPowDifficulty) {
        console.log(`  Learned PoW:       ${chalk.yellow(`difficulty ${info.learnedPowDifficulty}`)} ${chalk.dim("(from the relay's own rejections)")}`);
      }
      process.exit(0);
    });

  relayCmd
    .command("add <url>")
    .description("Add a relay URL to config")
    .action(async (url: string) => {
      const normalized = normalizeRelayInput(url);
      if (!normalized) {
        console.error(chalk.red(`Not a relay URL: ${url} (expected wss://… or ws://…)`));
        process.exit(1);
      }
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.relays.some((relay) => sameRelay(relay, normalized))) {
        config.relays.push(normalized);
        await saveConfig(config);
        console.log(chalk.green(`✓ Relay added: ${normalized}`));
      } else {
        console.log(chalk.dim(`Relay already configured: ${normalized}`));
      }
      process.exit(0);
    });

  relayCmd
    .command("remove <url>")
    .description("Remove a relay URL from config")
    .action(async (url: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const before = config.relays.length;
      config.relays = config.relays.filter((r) => r !== url && !sameRelay(r, url));
      if (config.relays.length === before) {
        console.error(chalk.red(`Relay not found in config: ${url}`));
        process.exit(1);
      }
      await saveConfig(config);
      console.log(chalk.green(`✓ Relay removed: ${url}`));
      process.exit(0);
    });

}
