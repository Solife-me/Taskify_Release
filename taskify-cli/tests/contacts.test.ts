import test from "node:test";
import assert from "node:assert/strict";
import { NIP51_CONTACTS_KIND, NIP51_PRIVATE_CONTACTS_D_TAG } from "../src/shared/nip51Contacts.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

const CONTACTS = readFileSync(path.resolve(import.meta.dirname, "../src/commands/contact.ts"), "utf8");
const NIP51 = readFileSync(path.resolve(import.meta.dirname, "../src/shared/nip51Contacts.ts"), "utf8");

test("contact fetch fetches kind 0 profile from relays", () => {
  assert.match(CONTACTS, /kinds: \[0\].*authors: \[pubkeyHex\]|kinds.*0.*authors.*pubkeyHex/);
});

test("contact sync publishes encrypted private kind 30000 NIP-51 event", () => {
  assert.equal(NIP51_CONTACTS_KIND, 30000);
  assert.equal(NIP51_PRIVATE_CONTACTS_D_TAG, "Chat-Friends");
  assert.match(NIP51, /encryptNip51PrivateItems/);
  assert.match(CONTACTS, /syncEvent\.content = await encryptNip51PrivateItems/);
  assert.match(CONTACTS, /syncEvent\.tags = \[\["d", NIP51_PRIVATE_CONTACTS_D_TAG\]\]/);
  assert.doesNotMatch(CONTACTS, /\.\.\.contacts\.map\(\(c\): string\[\] => \["p"/);
});
