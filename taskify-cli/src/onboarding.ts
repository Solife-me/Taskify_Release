#!/usr/bin/env node
import * as readline from "readline";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { loadConfig, saveProfiles, type ProfileConfig } from "./config.js";

// Queue-based readline helper that works correctly with piped stdin
function makeLineQueue(rl: readline.Interface): (prompt: string) => Promise<string> {
  const lineQueue: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  rl.on("line", (line: string) => {
    if (waiters.length > 0) {
      waiters.shift()!(line);
    } else {
      lineQueue.push(line);
    }
  });
  return (prompt: string) => {
    process.stdout.write(prompt);
    return new Promise<string>((resolve) => {
      if (lineQueue.length > 0) {
        resolve(lineQueue.shift()!);
      } else {
        waiters.push(resolve);
      }
    });
  };
}

/**
 * Run the onboarding wizard.
 * @param profileName - If provided, save to this profile name (re-configure).
 *                      If not provided, ask the user for a profile name.
 */
export async function runOnboarding(profileName?: string): Promise<void> {
  console.log();
  console.log("┌─────────────────────────────────────────┐");
  console.log("│  Welcome to taskify-nostr! 🦉           │");
  console.log("│  Nostr-powered task management CLI      │");
  console.log("└─────────────────────────────────────────┘");
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = makeLineQueue(rl);

  const DEFAULT_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.solife.me",
    ];

  let nsec: string | undefined;
  let relays: string[] = [...DEFAULT_RELAYS];

  // Step 1 — Private key
  console.log("Step 1 — Private key");
  const hasKey = await ask("Do you have a Nostr private key (nsec)? [Y/n] ");

  if (hasKey.trim().toLowerCase() !== "n") {
    // User has a key
    while (true) {
      const input = (await ask("Paste your nsec: ")).trim();
      if (input.startsWith("nsec1")) {
        try {
          nip19.decode(input);
          nsec = input;
          break;
        } catch {
          // invalid
        }
      }
      console.log("Invalid nsec. Try again or press Ctrl+C to abort.");
    }
  } else {
    // Generate new keypair
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    nsec = nip19.nsecEncode(sk);
    const npub = nip19.npubEncode(pk);
    console.log();
    console.log("✓ Generated new Nostr identity");
    console.log(`  npub: ${npub}`);
    console.log(`  nsec: ${nsec}  ← KEEP THIS SECRET — it is your password`);
    console.log();
    console.log("Save this nsec somewhere safe. It cannot be recovered if lost.");
    const cont = await ask("Continue? [Y/n] ");
    if (cont.trim().toLowerCase() === "n") {
      rl.close();
      process.exit(0);
    }
  }

  // Step 2 — Default board
  console.log();
  console.log("Step 2 — Default board");
  const joinBoard = await ask("Do you want to join an existing board? [y/N] ");
  let defaultBoard = "Personal";
  if (joinBoard.trim().toLowerCase() === "y") {
    const boardId = (await ask("Board ID (Nostr event id): ")).trim();
    if (boardId) {
      defaultBoard = boardId;
    }
  }

  // Step 3 — Relays
  console.log();
  console.log("Step 3 — Relays");
  const configRelays = await ask("Configure relays? Default relays will be used if skipped. [y/N] ");
  if (configRelays.trim().toLowerCase() === "y") {
    const customRelays: string[] = [];
    while (true) {
      const relay = (await ask("Add relay URL (blank to finish): ")).trim();
      if (!relay) break;
      customRelays.push(relay);
    }
    if (customRelays.length > 0) {
      relays = customRelays;
    }
  }

  // Step 4 — Profile name (only when not re-configuring an existing profile)
  let resolvedProfileName = profileName;
  if (!resolvedProfileName) {
    console.log();
    console.log("Step 4 — Profile name");
    const nameInput = (await ask("What should we name this profile? [default] ")).trim();
    resolvedProfileName = nameInput || "default";
  }

  rl.close();

  // Load full config to preserve other profiles
  const fullCfg = await loadConfig();
  const existingProfile = fullCfg.profiles[resolvedProfileName];

  const newProfile: ProfileConfig = {
    nsec,
    relays,
    boards: existingProfile?.boards ?? [],
    trustedNpubs: existingProfile?.trustedNpubs ?? [],
    securityMode: existingProfile?.securityMode ?? "moderate",
    securityEnabled: existingProfile?.securityEnabled ?? true,
    defaultBoard,
    taskReminders: existingProfile?.taskReminders ?? {},
    agent: existingProfile?.agent,
  };

  const newProfiles = { ...fullCfg.profiles, [resolvedProfileName]: newProfile };
  await saveProfiles(resolvedProfileName, newProfiles);

  // Done
  console.log();
  console.log(`✓ Setup complete! Profile: "${resolvedProfileName}"`);
  console.log("  Run `taskify boards` to see your boards.");
  console.log("  Run `taskify --help` to explore all commands.");
  console.log();
}
