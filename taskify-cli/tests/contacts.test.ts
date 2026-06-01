import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI = readFileSync(path.resolve(import.meta.dirname, "../src/index.ts"), "utf8");
const CONFIG = readFileSync(path.resolve(import.meta.dirname, "../src/config.ts"), "utf8");
const NIP51 = readFileSync(path.resolve(import.meta.dirname, "../src/shared/nip51Contacts.ts"), "utf8");

test("Contact type is exported from config.ts", () => {
  assert.match(CONFIG, /export type Contact = \{/);
  assert.match(CONFIG, /pubkey: string/);
  assert.match(CONFIG, /npub\?: string/);
  assert.match(CONFIG, /name\?: string/);
  assert.match(CONFIG, /nip05\?: string/);
});

test("ProfileConfig has contacts array", () => {
  assert.match(CONFIG, /contacts\?: Contact\[\]/);
});

test("profileDefaults initializes contacts to empty array", () => {
  assert.match(CONFIG, /contacts: partial\.contacts \?\? \[\]/);
});

test("saveConfig persists contacts field", () => {
  assert.match(CONFIG, /contacts: cfg\.contacts/);
});

test("saveConfig writes flat mutations back to selected profile", () => {
  assert.match(CONFIG, /selectedProfile: string/);
  assert.match(CONFIG, /selectedProfile: resolvedProfileName/);
  assert.match(CONFIG, /const targetProfile = cfg\.selectedProfile \?\? cfg\.activeProfile/);
  assert.match(CONFIG, /\[targetProfile\]: profileData/);
});

test("contact command group is registered", () => {
  assert.match(CLI, /contactCmd = program\s*\n?\s*\.command\("contact"\)/);
});

test("contact list subcommand exists", () => {
  assert.match(CLI, /contactCmd[\s\S]*?\.command\("list"\)/);
});

test("contact show subcommand exists", () => {
  assert.match(CLI, /contactCmd[\s\S]*?\.command\("show <npubOrId>"\)/);
});

test("contact add subcommand exists with --name and --nip05 flags", () => {
  assert.match(CLI, /contactCmd[\s\S]*?\.command\("add <npub>"\)/);
  assert.match(CLI, /--name <name>/);
  assert.match(CLI, /--nip05 <nip05>/);
});

test("contact remove subcommand exists", () => {
  assert.match(CLI, /contactCmd[\s\S]*?\.command\("remove <npubOrId>"\)/);
});

test("contact fetch subcommand exists", () => {
  assert.match(CLI, /contactCmd[\s\S]*?\.command\("fetch <npub>"\)/);
});

test("contact sync subcommand exists", () => {
  assert.match(CLI, /contactCmd[\s\S]*?\.command\("sync"\)/);
});

test("resolveContact helper function is defined", () => {
  assert.match(CLI, /function resolveContact\(/);
});

test("contact add decodes npub via nip19", () => {
  assert.match(CLI, /nip19\.decode\(npubArg\)/);
});

test("contact fetch fetches kind 0 profile from relays", () => {
  assert.match(CLI, /kinds: \[0\].*authors: \[pubkeyHex\]|kinds.*0.*authors.*pubkeyHex/);
});

test("contact sync publishes encrypted private kind 30000 NIP-51 event", () => {
  assert.match(NIP51, /NIP51_CONTACTS_KIND = 30000/);
  assert.match(NIP51, /NIP51_PRIVATE_CONTACTS_D_TAG = "Chat-Friends"/);
  assert.match(NIP51, /encryptNip51PrivateItems/);
  assert.match(CLI, /syncEvent\.content = await encryptNip51PrivateItems/);
  assert.match(CLI, /syncEvent\.tags = \[\["d", NIP51_PRIVATE_CONTACTS_D_TAG\]\]/);
  assert.doesNotMatch(CLI, /\.\.\.contacts\.map\(\(c\): string\[\] => \["p"/);
});
