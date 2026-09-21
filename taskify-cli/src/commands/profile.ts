import chalk from "chalk";
import type { Command } from "commander";
import { generateSecretKey,getPublicKey,nip19 } from "nostr-tools";
import { createInterface } from "readline";
import { DEFAULT_RELAYS,loadConfig,saveProfiles,type ProfileConfig } from "../config.js";
import { uploadImageToNip96 } from "../nip96Upload.js";
import { fetchLatestProfileEvent,publishProfile } from "../profileMeta.js";

export function registerProfileCommands(program: Command): void {
  // ---- Helper: readline queue (handles piped stdin correctly) ----
  function makeLineQueue(rl: ReturnType<typeof createInterface>): (prompt: string) => Promise<string> {
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

  // ---- profile command group ----
  const profileCmd = program
    .command("profile")
    .description("Manage named Nostr identity profiles");

  // Helper to get npub string from nsec
  function nsecToNpub(nsec: string): string | null {
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type === "nsec") {
        const pk = getPublicKey(decoded.data as Uint8Array);
        return nip19.npubEncode(pk);
      }
    } catch { /* ignore */ }
    return null;
  }

  profileCmd
    .command("list")
    .description("List all profiles (► marks active)")
    .action(async () => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      for (const [name, profile] of Object.entries(config.profiles)) {
        const isActive = name === config.activeProfile;
        const marker = isActive ? "►" : " ";
        let npubStr = "(no key)";
        if (profile.nsec) {
          const npub = nsecToNpub(profile.nsec);
          if (npub) npubStr = npub.slice(0, 12) + "..." + npub.slice(-4);
        }
        const boardCount = profile.boards?.length ?? 0;
        console.log(
          `  ${marker} ${name.padEnd(14)} ${npubStr.padEnd(22)} ${boardCount} board${boardCount !== 1 ? "s" : ""}`,
        );
      }
      process.exit(0);
    });

  profileCmd
    .command("add <name>")
    .description("Add a new profile (runs mini onboarding for the new identity)")
    .option("--nsec <key>", "Nostr private key (skips interactive prompt)")
    .option("--relay <url>", "Add a relay (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
    .action(async (name: string, opts: { nsec?: string; relay: string[] }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (config.profiles[name]) {
        console.error(chalk.red(`Profile already exists: "${name}"`));
        process.exit(1);
      }

      // Non-interactive mode when --nsec is provided
      if (opts.nsec !== undefined) {
        const nsecInput = opts.nsec.trim();
        if (!nsecInput.startsWith("nsec1")) {
          console.error(chalk.red("Invalid nsec key"));
          process.exit(1);
        }
        try {
          nip19.decode(nsecInput);
        } catch {
          console.error(chalk.red("Invalid nsec key"));
          process.exit(1);
        }
        const relays = opts.relay.length > 0 ? opts.relay : [...DEFAULT_RELAYS];
        const newProfile: ProfileConfig = {
          nsec: nsecInput,
          relays,
          boards: [],
          trustedNpubs: [],
          securityMode: "moderate",
          securityEnabled: true,
          defaultBoard: "Personal",
          taskReminders: {},
        };
        const newProfiles = { ...config.profiles, [name]: newProfile };
        await saveProfiles(config.activeProfile, newProfiles);
        console.log(chalk.green(`✓ Profile '${name}' created.`));
        process.exit(0);
      }

      // Interactive mode
      console.log();
      console.log(chalk.bold(`Setting up profile: ${name}`));
      console.log();

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = makeLineQueue(rl);

      // Key setup
      const hasKey = await ask("Do you have a Nostr private key (nsec)? [Y/n] ");
      let nsec: string | undefined;

      if (hasKey.trim().toLowerCase() !== "n") {
        while (true) {
          const input = (await ask("Paste your nsec: ")).trim();
          if (input.startsWith("nsec1")) {
            try {
              nip19.decode(input);
              nsec = input;
              break;
            } catch { /* invalid */ }
          }
          console.log("Invalid nsec. Try again or press Ctrl+C to abort.");
        }
      } else {
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

      // Relays setup
      console.log();
      let relays = [...DEFAULT_RELAYS];
      const useDefaults = await ask("Use default relays? [Y/n] ");
      if (useDefaults.trim().toLowerCase() === "n") {
        relays = [];
        while (true) {
          const relay = (await ask("Add relay URL (blank to finish): ")).trim();
          if (!relay) break;
          relays.push(relay);
        }
        if (relays.length === 0) relays = [...DEFAULT_RELAYS];
      }

      rl.close();

      const newProfile: ProfileConfig = {
        nsec,
        relays,
        boards: [],
        trustedNpubs: [],
        securityMode: "moderate",
        securityEnabled: true,
        defaultBoard: "Personal",
        taskReminders: {},
      };

      const newProfiles = { ...config.profiles, [name]: newProfile };
      await saveProfiles(config.activeProfile, newProfiles);
      console.log();
      console.log(chalk.green(`✓ Profile '${name}' created. Run: taskify profile use ${name}`));
      process.exit(0);
    });

  profileCmd
    .command("use <name>")
    .description("Switch the active profile")
    .action(async (name: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.profiles[name]) {
        console.error(
          chalk.red(`Profile not found: "${name}". Available: ${Object.keys(config.profiles).join(", ")}`),
        );
        process.exit(1);
      }
      await saveProfiles(name, config.profiles);
      console.log(chalk.green(`✓ Switched to profile: ${name}`));
      process.exit(0);
    });

  profileCmd
    .command("show [name]")
    .description("Show profile details (defaults to active profile)")
    .action(async (name?: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const profileName = name ?? config.activeProfile;
      const profile = config.profiles[profileName];
      if (!profile) {
        console.error(
          chalk.red(`Profile not found: "${profileName}". Available: ${Object.keys(config.profiles).join(", ")}`),
        );
        process.exit(1);
      }
      const isActive = profileName === config.activeProfile;

      console.log(chalk.bold(`Profile: ${profileName}${isActive ? "  ◄ active" : ""}`));

      let npubStr = "(no key)";
      if (profile.nsec) {
        const npub = nsecToNpub(profile.nsec);
        if (npub) npubStr = npub;
      }
      const maskedNsec = profile.nsec ? profile.nsec.slice(0, 8) + "..." : "(not set)";

      console.log(`  nsec:         ${maskedNsec}`);
      console.log(`  npub:         ${npubStr}`);
      console.log(`  relays:       ${(profile.relays ?? []).join(", ")}`);
      console.log(`  boards:       ${profile.boards?.length ?? 0}`);
      console.log(`  trustedNpubs: ${profile.trustedNpubs?.length ?? 0}`);
      process.exit(0);
    });

  profileCmd
    .command("remove <name>")
    .description("Remove a profile")
    .option("--force", "Skip confirmation prompt")
    .action(async (name: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.profiles[name]) {
        console.error(chalk.red(`Profile not found: "${name}"`));
        process.exit(1);
      }
      if (name === config.activeProfile) {
        console.error(
          chalk.red(`Cannot remove active profile: "${name}". Switch first with: taskify profile use <other>`),
        );
        process.exit(1);
      }
      if (Object.keys(config.profiles).length === 1) {
        console.error(chalk.red("Cannot remove the only profile."));
        process.exit(1);
      }

      if (!opts.force) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const confirmed = await new Promise<boolean>((resolve) => {
          rl.question(`Remove profile '${name}'? [y/N] `, (ans: string) => {
            rl.close();
            resolve(ans.toLowerCase() === "y");
          });
        });
        if (!confirmed) {
          console.log("Aborted.");
          process.exit(0);
        }
      }

      const { [name]: _removed, ...rest } = config.profiles;
      await saveProfiles(config.activeProfile, rest);
      console.log(chalk.green(`✓ Profile '${name}' removed.`));
      process.exit(0);
    });

  profileCmd
    .command("rename <old> <new>")
    .description("Rename a profile")
    .action(async (oldName: string, newName: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.profiles[oldName]) {
        console.error(chalk.red(`Profile not found: "${oldName}"`));
        process.exit(1);
      }
      if (config.profiles[newName]) {
        console.error(chalk.red(`Profile already exists: "${newName}"`));
        process.exit(1);
      }
      const { [oldName]: profileData, ...rest } = config.profiles;
      const newProfiles = { ...rest, [newName]: profileData };
      const newActive = config.activeProfile === oldName ? newName : config.activeProfile;
      await saveProfiles(newActive, newProfiles);
      console.log(chalk.green(`✓ Renamed profile '${oldName}' → '${newName}'`));
      process.exit(0);
    });

  profileCmd
    .command("set-meta")
    .description("Update your Nostr profile metadata (kind:0) — only provided fields are updated")
    .option("--name <n>", "Username / handle (name field)")
    .option("--display-name <n>", "Display name (display_name field)")
    .option("--about <text>", "Bio / about")
    .option("--picture <url-or-path>", "Profile picture — URL or local file path (uploaded via NIP-96)")
    .option("--banner <url-or-path>", "Banner image — URL or local file path (uploaded via NIP-96)")
    .option("--nip05 <addr>", "NIP-05 verification address (user@domain.com)")
    .option("--website <url>", "Website URL")
    .option("--lud16 <addr>", "Lightning address (lud16)")
    .option("--nip96-server <url>", "NIP-96 server for image uploads (default: nostr.build)", "https://nostr.build")
    .option("--json", "Output published event as JSON")
    .action(async (opts: {
      name?: string;
      displayName?: string;
      about?: string;
      picture?: string;
      banner?: string;
      nip05?: string;
      website?: string;
      lud16?: string;
      nip96Server: string;
      json?: boolean;
    }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.nsec) {
        console.error(chalk.red("No nsec configured for this profile. Run: taskify setup"));
        process.exit(1);
      }

      // If no fields provided, show current metadata
      const hasChanges = [opts.name, opts.displayName, opts.about, opts.picture, opts.banner, opts.nip05, opts.website, opts.lud16].some(v => v !== undefined);
      if (!hasChanges) {
        console.error(chalk.yellow("No fields specified. Use --name, --display-name, --about, --picture, --banner, --nip05, --website, --lud16"));
        console.error(chalk.dim("  Example: taskify profile set-meta --display-name \"Nathan\" --picture ./avatar.png"));
        process.exit(1);
      }

      // Upload local files via NIP-96 if needed
      const resolveMedia = async (value: string | undefined, label: string): Promise<string | undefined> => {
        if (!value) return undefined;
        if (value.startsWith("http://") || value.startsWith("https://")) return value;
        // Treat as local file path — upload to NIP-96
        console.log(chalk.dim(`  Uploading ${label} via NIP-96...`));
        try {
          const url = await uploadImageToNip96({
            serverUrl: opts.nip96Server,
            filePath: value,
            nsec: config.nsec!,
          });
          console.log(chalk.dim(`  ✓ Uploaded: ${url}`));
          return url;
        } catch (err) {
          console.error(chalk.red(`Failed to upload ${label}: ${String(err)}`));
          process.exit(1);
        }
      };

      const pictureUrl = await resolveMedia(opts.picture, "profile picture");
      const bannerUrl = await resolveMedia(opts.banner, "banner");

      const draft = {
        name: opts.name,
        displayName: opts.displayName,
        about: opts.about,
        picture: pictureUrl,
        banner: bannerUrl,
        nip05: opts.nip05,
        website: opts.website,
        lud16: opts.lud16,
      };

      // Strip undefined so we only update provided fields
      const cleanDraft = Object.fromEntries(
        Object.entries(draft).filter(([, v]) => v !== undefined)
      ) as typeof draft;

      console.log(chalk.dim("  Publishing profile metadata..."));

      try {
        const result = await publishProfile(config.nsec, cleanDraft, config.relays);
        if (opts.json) {
          console.log(JSON.stringify(result.event, null, 2));
        } else {
          console.log(chalk.green(`✓ Profile updated (event: ${result.event.id?.slice(0, 8)}...)`));
          const content = JSON.parse(result.event.content ?? "{}");
          if (content.name) console.log(`  name:         ${content.name}`);
          if (content.display_name) console.log(`  display_name: ${content.display_name}`);
          if (content.about) console.log(`  about:        ${content.about}`);
          if (content.picture) console.log(`  picture:      ${content.picture}`);
          if (content.banner) console.log(`  banner:       ${content.banner}`);
          if (content.nip05) console.log(`  nip05:        ${content.nip05}`);
          if (content.website) console.log(`  website:      ${content.website}`);
          if (content.lud16) console.log(`  lud16:        ${content.lud16}`);
          if (result.deletedIds.length) console.log(chalk.dim(`  (deleted superseded event: ${result.deletedIds[0]?.slice(0, 8)}...)`));
        }
      } catch (err) {
        console.error(chalk.red(`Failed to publish profile: ${String(err)}`));
        process.exit(1);
      }
      process.exit(0);
    });

  profileCmd
    .command("fetch-meta [name]")
    .description("Fetch and display current Nostr profile metadata from relays (defaults to active profile)")
    .option("--json", "Output raw kind:0 event as JSON")
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const profileName = name ?? config.activeProfile;
      const profile = config.profiles[profileName];
      if (!profile) {
        console.error(chalk.red(`Profile not found: "${profileName}"`));
        process.exit(1);
      }
      if (!profile.nsec) {
        console.error(chalk.red("No nsec configured for this profile."));
        process.exit(1);
      }
      const decoded = nip19.decode(profile.nsec);
      if (decoded.type !== "nsec") { console.error(chalk.red("Invalid nsec")); process.exit(1); }
      const pubkeyHex = getPublicKey(decoded.data as Uint8Array);

      console.log(chalk.dim("  Fetching profile metadata from relays..."));
      const { event, metadata } = await fetchLatestProfileEvent(pubkeyHex, profile.relays ?? []);

      if (!event) {
        console.log(chalk.yellow("No kind:0 profile event found on relays."));
        process.exit(0);
      }

      if (opts.json) {
        console.log(JSON.stringify(event, null, 2));
      } else {
        const npub = nip19.npubEncode(pubkeyHex);
        console.log(chalk.bold(`Profile: ${profileName}`));
        console.log(`  npub:         ${npub}`);
        if (metadata.name) console.log(`  name:         ${metadata.name}`);
        if (metadata.displayName || (metadata as any).display_name) console.log(`  display_name: ${metadata.displayName ?? (metadata as any).display_name}`);
        if (metadata.about) console.log(`  about:        ${metadata.about}`);
        if (metadata.picture) console.log(`  picture:      ${metadata.picture}`);
        if (metadata.banner) console.log(`  banner:       ${metadata.banner}`);
        if (metadata.nip05) console.log(`  nip05:        ${metadata.nip05}`);
        if (metadata.website) console.log(`  website:      ${metadata.website}`);
        if (metadata.lud16) console.log(`  lud16:        ${metadata.lud16}`);
        console.log(chalk.dim(`  (event id: ${event.id?.slice(0, 8)}..., created_at: ${new Date((event.created_at ?? 0) * 1000).toISOString()})`));
      }
      process.exit(0);
    });
}
