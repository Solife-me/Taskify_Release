#!/usr/bin/env node
/**
 * Writes taskify-core/fixtures/nip17-vectors.json: real NIP-17 gift wraps (fixed account keys,
 * random one-time keys and nonces) and what each must open to, or null when it must be
 * rejected. Node (PWA vitest) and Swift (TaskifyCoreTests) both check them.
 *
 * Run from taskify-pwa after building taskify-core and taskify-runtime-nostr:
 *   node scripts/generate-nip17-vectors.mjs
 * Regenerating changes every ciphertext; the expectations stay the same.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  buildNip17GiftWraps,
  createNip17Rumor,
  nip17MessageRecipients,
  openNip17GiftWrap,
  wrapNip17Seal,
} from "taskify-core";
import { newNip17WrapKey, nip17Crypto, nip17KeyParty } from "taskify-runtime-nostr";

const SECRETS = {
  alice: "1111111111111111111111111111111111111111111111111111111111111111",
  bob: "2222222222222222222222222222222222222222222222222222222222222222",
  carol: "3333333333333333333333333333333333333333333333333333333333333333",
};
const parties = Object.fromEntries(Object.entries(SECRETS).map(([name, hex]) => [name, nip17KeyParty(hexToBytes(hex))]));
const { alice, bob, carol } = parties;
const at = 1_790_000_000;

const sign = (template, key) => key.sign(template);
async function wrapsFor(rumor, sender) {
  return buildNip17GiftWraps(rumor, sender, { newWrapKey: newNip17WrapKey, signWrap: sign, timestamp: () => at - 3600 });
}
const wrapTo = (wraps, recipient) => wraps.find((entry) => entry.recipient === recipient.pubkey).wrap;
async function wrapSeal(seal, recipient) {
  const key = newNip17WrapKey();
  return key.sign(await wrapNip17Seal(seal, recipient.pubkey, key, at - 3600));
}
async function sealRaw(author, recipient, rumorValue, tags = []) {
  const content = await author.nip44Encrypt(recipient.pubkey, JSON.stringify(rumorValue));
  return author.sign({ kind: 13, content, tags, created_at: at - 7200 });
}

const vectors = [];
async function add(name, receiverName, wrap, note) {
  const receiver = parties[receiverName];
  const opened = await openNip17GiftWrap(wrap, receiver, nip17Crypto);
  vectors.push({
    name,
    note,
    receiver: receiverName,
    wrap,
    expected: opened
      ? {
          senderPubkey: opened.senderPubkey,
          rumorId: opened.rumor.id,
          kind: opened.rumor.kind,
          content: opened.rumor.content,
          tags: opened.rumor.tags,
          createdAt: opened.rumor.created_at,
          recipients: nip17MessageRecipients(opened, receiver.pubkey),
        }
      : null,
  });
}

const dm = createNip17Rumor({ sender: alice.pubkey, recipients: [bob.pubkey], content: "Hello Bob", createdAt: at }, nip17Crypto);
const dmWraps = await wrapsFor(dm, alice);
await add("direct message", "bob", wrapTo(dmWraps, bob), "Alice to Bob.");
await add("sender's own copy", "alice", wrapTo(dmWraps, alice), "The same rumor, wrapped for Alice's other devices.");
await add("not addressed to this key", "carol", wrapTo(dmWraps, bob), "Bob's wrap, opened by Carol: rejected.");

const group = createNip17Rumor(
  { sender: alice.pubkey, recipients: [bob.pubkey, carol.pubkey], content: "Hi all", createdAt: at, group: true },
  nip17Crypto,
);
await add("group message", "carol", wrapTo(await wrapsFor(group, alice), carol), "Tags the sender first, then each member.");

const file = createNip17Rumor(
  {
    sender: bob.pubkey,
    recipients: [alice.pubkey],
    content: "https://files.example/blob",
    createdAt: at,
    kind: 15,
    extraTags: [["file-type", "image/png"], ["encryption-algorithm", "aes-gcm"]],
  },
  nip17Crypto,
);
await add("file message", "alice", wrapTo(await wrapsFor(file, bob), alice), "Kind 15 keeps its extra tags.");

const untagged = { kind: 14, content: "cashu payment", tags: [], created_at: at, pubkey: alice.pubkey };
const untaggedRumor = { ...untagged, id: nip17Crypto.eventId(untagged) };
await add(
  "untagged rumor (NUT-18 payment senders)",
  "bob",
  await wrapSeal(await sealRaw(alice, bob, untaggedRumor), bob),
  "Opens; the recipient is the account that opened it.",
);
await add(
  "untagged copy to self",
  "alice",
  await wrapSeal(await sealRaw(alice, alice, untaggedRumor), alice),
  "Opens, but names no recipient.",
);

const claimsAlice = createNip17Rumor({ sender: alice.pubkey, recipients: [bob.pubkey], content: "Send me your keys", createdAt: at }, nip17Crypto);
await add(
  "impersonation",
  "bob",
  await wrapSeal(await sealRaw(carol, bob, claimsAlice), bob),
  "Carol seals a rumor naming Alice: rejected.",
);
await add(
  "seal with tags",
  "bob",
  await wrapSeal(await sealRaw(alice, bob, dm, [["p", bob.pubkey]]), bob),
  "Seals carry no tags: rejected.",
);
await add(
  "rumor id mismatch",
  "bob",
  await wrapSeal(await sealRaw(alice, bob, { ...dm, content: "Edited after hashing" }), bob),
  "Rejected.",
);
await add(
  "signed rumor",
  "bob",
  await wrapSeal(await sealRaw(alice, bob, { ...dm, sig: "00".repeat(64) }), bob),
  "Rumors are unsigned: rejected.",
);
const goodWrap = wrapTo(dmWraps, bob);
await add("bad wrap signature", "bob", { ...goodWrap, sig: goodWrap.sig.replace(/^./, (c) => (c === "0" ? "1" : "0")) }, "Rejected.");

const file_ = {
  description:
    "NIP-17 gift wraps and what each opens to for `receiver` (null: must be rejected). Generated by taskify-pwa/scripts/generate-nip17-vectors.mjs; checked by Node and Swift.",
  accounts: Object.fromEntries(Object.entries(SECRETS).map(([name, secretKey]) => [name, { secretKey, pubkey: parties[name].pubkey }])),
  vectors,
};
const out = fileURLToPath(new URL("../../taskify-core/fixtures/nip17-vectors.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(file_, null, 2)}\n`);
console.log(`Wrote ${vectors.length} vectors (${vectors.filter((v) => v.expected).length} open) to ${out}`);
