import type { Command } from "commander";
import chalk from "chalk";
import { nip19, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Contact } from "../config.js";
import type { CommandContext } from "./context.js";
import { renderJson } from "../render.js";
import { pickLatestEvent } from "../shared/latestEvent.js";
import { sanitizeRemote } from "../shared/displaySafe.js";
import {
  buildNip51PrivateItems,
  decryptNip51PrivateItems,
  encryptNip51PrivateItems,
  extractNip51PrivateContacts,
  mergeNip51PrivateContacts,
  NIP51_CONTACTS_KIND,
  NIP51_LEGACY_CONTACTS_D_TAG,
  NIP51_PRIVATE_CONTACTS_D_TAG,
} from "../shared/nip51Contacts.js";

export function registerContactCommands(program: Command, context: Pick<CommandContext, "loadConfig" | "saveConfig" | "now" | "withStandaloneSession">) {
  const { loadConfig, saveConfig, now, withStandaloneSession } = context;
  // ---- contact command group ----
  const contactCmd = program
    .command("contact")
    .description("Manage contacts");

  function resolveContact(contacts: Contact[], ref: string): Contact | undefined {
    const lower = ref.toLowerCase();
    return contacts.find(
      (c) =>
        c.npub === ref ||
        c.pubkey === ref ||
        c.pubkey.startsWith(lower) ||
        (c.name?.toLowerCase() === lower),
    );
  }

  contactCmd
    .command("list")
    .description("List local contacts")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const contacts = config.contacts ?? [];
      if (opts.json) { renderJson(contacts); return; }
      if (contacts.length === 0) { console.log(chalk.dim("No contacts.")); return; }
      for (const c of contacts) {
        const key = c.npub ?? c.pubkey.slice(0, 12) + "...";
        const label = [c.name, c.nip05].filter(Boolean).join(" / ");
        console.log(`  ${chalk.bold(key)}  ${chalk.dim(label)}`);
      }
      return;
    });

  contactCmd
    .command("show <npubOrId>")
    .description("Show contact details")
    .option("--json", "Output as JSON")
    .action(async (ref: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const contact = resolveContact(config.contacts ?? [], ref);
      if (!contact) { console.error(chalk.red(`Contact not found: ${ref}`)); process.exitCode = 1; return; }
      if (opts.json) { renderJson(contact); return; }
      console.log(chalk.bold("Contact"));
      for (const [k, v] of Object.entries(contact)) {
        if (v !== undefined && v !== null) console.log(`  ${chalk.dim(k + ":")} ${v}`);
      }
      return;
    });

  contactCmd
    .command("add <npub>")
    .description("Add a contact locally")
    .option("--name <name>", "Display name")
    .option("--nip05 <nip05>", "NIP-05 identifier")
    .action(async (npubArg: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      let pubkeyHex: string;
      let npub: string;
      try {
        const decoded = nip19.decode(npubArg);
        if (decoded.type !== "npub") throw new Error("Expected npub");
        pubkeyHex = decoded.data as string;
        npub = npubArg;
      } catch {
        console.error(chalk.red("Invalid npub: " + npubArg));
        process.exitCode = 1; return;
      }
      const contacts = config.contacts ?? [];
      if (contacts.find((c) => c.pubkey === pubkeyHex)) {
        console.log(chalk.yellow("Contact already exists."));
        return;
      }
      const contact: Contact = {
        pubkey: pubkeyHex,
        npub,
        name: opts.name,
        nip05: opts.nip05,
        addedAt: Math.floor(now().getTime() / 1000),
      };
      config.contacts = [...contacts, contact];
      await saveConfig(config);
      console.log(chalk.green(`✓ Added contact: ${opts.name ?? npub}`));
      return;
    });

  contactCmd
    .command("remove <npubOrId>")
    .description("Remove a contact")
    .action(async (ref: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const contacts = config.contacts ?? [];
      const contact = resolveContact(contacts, ref);
      if (!contact) { console.error(chalk.red(`Contact not found: ${ref}`)); process.exitCode = 1; return; }
      config.contacts = contacts.filter((c) => c.pubkey !== contact.pubkey);
      await saveConfig(config);
      console.log(chalk.green(`✓ Removed contact: ${contact.name ?? contact.npub ?? contact.pubkey}`));
      return;
    });

  contactCmd
    .command("fetch <npub>")
    .description("Fetch/refresh NIP-01 kind 0 profile for a contact from relays")
    .action(async (npubArg: string) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      let pubkeyHex: string;
      let npub: string;
      try {
        const decoded = nip19.decode(npubArg);
        if (decoded.type !== "npub") throw new Error("Expected npub");
        pubkeyHex = decoded.data as string;
        npub = npubArg;
      } catch {
        console.error(chalk.red("Invalid npub: " + npubArg));
        process.exitCode = 1; return;
      }
      try {
        process.stderr.write("Fetching kind 0 profile from relays...\n");
        const events = await withStandaloneSession({ relays: config.relays }, (session) =>
          session.fetchVerified({ kinds: [0], authors: [pubkeyHex], limit: 1 }, { timeoutMs: 8_000 }));
        let profileData: Record<string, unknown> = {};
        const signed = pickLatestEvent(events.filter((evt) => evt.kind === 0 && evt.pubkey === pubkeyHex));
        if (signed) {
          try { profileData = sanitizeRemote(JSON.parse(signed.content)); } catch { /* ignore */ }
        }
        const nowSeconds = Math.floor(now().getTime() / 1000);
        const contacts = config.contacts ?? [];
        const idx = contacts.findIndex((c) => c.pubkey === pubkeyHex);
        const existing: Contact = idx >= 0 ? contacts[idx] : { pubkey: pubkeyHex, npub, addedAt: nowSeconds };
        const updated: Contact = {
          ...existing,
          name: (profileData.name as string | undefined) ?? existing.name,
          displayName: (profileData.display_name as string | undefined) ?? existing.displayName,
          nip05: (profileData.nip05 as string | undefined) ?? existing.nip05,
          about: (profileData.about as string | undefined) ?? existing.about,
          picture: (profileData.picture as string | undefined) ?? existing.picture,
          updatedAt: nowSeconds,
        };
        if (idx >= 0) contacts[idx] = updated;
        else contacts.push(updated);
        config.contacts = contacts;
        await saveConfig(config);
        console.log(chalk.green(`✓ Fetched profile for ${updated.name ?? npub}`));
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exitCode = 1; return;
      }
      return;
    });

  contactCmd
    .command("sync")
    .description("Publish/restore NIP-51 kind 30000 encrypted private contacts list to/from relays")
    .option("--pull", "Only pull from relays (default: push and pull)")
    .option("--json", "Output merged contacts as JSON after sync")
    .action(async (opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      if (!config.nsec) {
        console.error(chalk.red("No nsec configured — cannot sync contacts"));
        process.exitCode = 1; return;
      }
      const decoded = nip19.decode(config.nsec);
      if (decoded.type !== "nsec") { console.error(chalk.red("Invalid nsec")); process.exitCode = 1; return; }
      const userSk = decoded.data as Uint8Array;
      const userPk = getPublicKey(userSk);
      const keys = { privateKeyHex: bytesToHex(userSk), publicKeyHex: userPk };
      let contacts = [...(config.contacts ?? [])];
      try {
        await withStandaloneSession({ relays: config.relays, secretKeyHex: keys.privateKeyHex }, async (session) => {
          // The latest encrypted PWA-compatible list, plus the legacy public CLI list for migration.
          const signedLists = (await session.fetchVerified({
            kinds: [NIP51_CONTACTS_KIND],
            authors: [userPk],
            "#d": [NIP51_PRIVATE_CONTACTS_D_TAG, NIP51_LEGACY_CONTACTS_D_TAG],
            limit: 5,
          }, { timeoutMs: 8_000 })).filter((evt) => evt.pubkey === userPk);
          const hasDTag = (evt: { tags?: string[][] }, dTag: string) =>
            Array.isArray(evt.tags) && evt.tags.some((tag) => tag[0] === "d" && tag[1] === dTag);
          const nowSeconds = Math.floor(now().getTime() / 1000);

          const latestPrivate = pickLatestEvent(signedLists.filter((evt) => hasDTag(evt, NIP51_PRIVATE_CONTACTS_D_TAG)));
          if (latestPrivate) {
            try {
              const privateItems = await decryptNip51PrivateItems(latestPrivate.content, keys);
              const privateContacts = extractNip51PrivateContacts(privateItems);
              contacts = mergeNip51PrivateContacts(contacts, privateContacts, latestPrivate.created_at ?? nowSeconds);
            } catch (err) {
              process.stderr.write(chalk.yellow(`Warning: could not decrypt private contacts list: ${String(err)}\n`));
            }
          }

          const latestLegacy = pickLatestEvent(signedLists.filter((evt) => hasDTag(evt, NIP51_LEGACY_CONTACTS_D_TAG)));
          if (latestLegacy) {
            for (const pTag of latestLegacy.tags.filter((t: string[]) => t[0] === "p")) {
              const pk = pTag[1];
              if (pk && !contacts.find((c) => c.pubkey === pk)) {
                contacts.push({
                  pubkey: pk,
                  npub: nip19.npubEncode(pk),
                  relays: pTag[2] ? [pTag[2]] : undefined,
                  name: pTag[3] || undefined,
                  addedAt: latestLegacy.created_at ?? nowSeconds,
                });
              }
            }
          }
          if (!opts.pull && contacts.length > 0) {
            await session.publish({
              kind: NIP51_CONTACTS_KIND,
              content: await encryptNip51PrivateItems(buildNip51PrivateItems(contacts), keys),
              tags: [["d", NIP51_PRIVATE_CONTACTS_D_TAG]],
            });
            console.log(chalk.green(`✓ Published ${contacts.length} encrypted private contacts to relay`));
          }
        });
        config.contacts = contacts;
        await saveConfig(config);
        if (opts.json) renderJson(contacts);
        else console.log(chalk.green(`✓ Synced ${contacts.length} contacts`));
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exitCode = 1; return;
      }
      return;
    });

}
