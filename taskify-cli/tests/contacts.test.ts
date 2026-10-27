import test from "node:test";
import assert from "node:assert/strict";
import { NIP51_CONTACTS_KIND, NIP51_PRIVATE_CONTACTS_D_TAG } from "../src/shared/nip51Contacts.ts";

// Contact fetch and sync behaviour is in standalone-commands.test.ts; local contact actions are in
// command-registration.test.ts.

test("the private contacts list uses the PWA's NIP-51 address", () => {
  assert.equal(NIP51_CONTACTS_KIND, 30000);
  assert.equal(NIP51_PRIVATE_CONTACTS_D_TAG, "Chat-Friends");
});
