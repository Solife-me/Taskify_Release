/**
 * The NIP-17 rules with a stand-in cipher: a message opens only for the key pair it was
 * encrypted between, and signatures are checkable. Real-crypto vectors shared with Swift run in
 * taskify-runtime-nostr (`tests/nip17-vectors.test.ts`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createNip17Rumor,
  nip17MessageRecipients,
  nip17Timestamp,
  nip17WrapRecipients,
  openNip17GiftWrap,
  sealNip17Rumor,
  wrapNip17Seal,
} from "../dist/index.js";

type Template = { kind: number; content: string; tags: string[][]; created_at: number };
type Signed = Template & { id: string; pubkey: string; sig: string };

const eventId = (event: Template & { pubkey: string }) =>
  createHash("sha256")
    .update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
    .digest("hex");
const crypto = {
  eventId,
  verifyEvent: (event: Signed) => event.id === eventId(event) && event.sig === `sig:${event.pubkey}:${event.id}`,
};

function party(name: string) {
  const pubkey = createHash("sha256").update(name).digest("hex");
  const pair = (peer: string) => [pubkey, peer].sort().join(":");
  return {
    pubkey,
    async sign(template: Template): Promise<Signed> {
      const id = eventId({ ...template, pubkey });
      return { ...template, pubkey, id, sig: `sig:${pubkey}:${id}` };
    },
    async nip44Encrypt(peer: string, plaintext: string) {
      return JSON.stringify({ pair: pair(peer), plaintext });
    },
    async nip44Decrypt(peer: string, ciphertext: string) {
      const parsed = JSON.parse(ciphertext);
      if (parsed.pair !== pair(peer)) throw new Error("bad MAC");
      return parsed.plaintext as string;
    },
  };
}

const alice = party("alice");
const bob = party("bob");
const carol = party("carol");

async function send(from: ReturnType<typeof party>, rumor: ReturnType<typeof createNip17Rumor>, to: string) {
  const wrapKey = party(`wrap-${to}-${Math.random()}`);
  const seal = await sealNip17Rumor(rumor, to, from, 1000);
  const template = await wrapNip17Seal(seal, to, wrapKey, 1000);
  return wrapKey.sign(template);
}

test("a message opens for its recipient and the sender's own copy, with the same rumor", async () => {
  const rumor = createNip17Rumor({ sender: alice.pubkey, recipients: [bob.pubkey], content: "hi", createdAt: 500 }, crypto);
  assert.deepEqual(nip17WrapRecipients(rumor), [bob.pubkey, alice.pubkey]);
  const toBob = await send(alice, rumor, bob.pubkey);
  const toSelf = await send(alice, rumor, alice.pubkey);
  const opened = await openNip17GiftWrap(toBob, bob, crypto);
  assert.equal(opened?.senderPubkey, alice.pubkey);
  assert.equal(opened?.rumor.content, "hi");
  assert.equal(opened?.rumor.id, rumor.id);
  assert.equal((await openNip17GiftWrap(toSelf, alice, crypto))?.rumor.id, rumor.id);
  assert.notEqual(toBob.id, toSelf.id);
});

test("a wrap does not open for anyone else", async () => {
  const rumor = createNip17Rumor({ sender: alice.pubkey, recipients: [bob.pubkey], content: "hi", createdAt: 500 }, crypto);
  assert.equal(await openNip17GiftWrap(await send(alice, rumor, bob.pubkey), carol, crypto), null);
});

test("a rumor naming someone other than the seal's author is rejected (impersonation)", async () => {
  // Carol seals a rumor that claims Alice wrote it.
  const forged = createNip17Rumor({ sender: alice.pubkey, recipients: [bob.pubkey], content: "from alice?", createdAt: 500 }, crypto);
  const seal = await carol.sign({ kind: 13, content: await carol.nip44Encrypt(bob.pubkey, JSON.stringify(forged)), tags: [], created_at: 1 });
  const wrapKey = party("w");
  const wrap = await wrapKey.sign(await wrapNip17Seal(seal, bob.pubkey, wrapKey, 1));
  assert.equal(await openNip17GiftWrap(wrap, bob, crypto), null);
  await assert.rejects(sealNip17Rumor(forged, bob.pubkey, carol, 1));
});

test("tampered or malformed layers are rejected", async () => {
  const rumor = createNip17Rumor({ sender: alice.pubkey, recipients: [bob.pubkey], content: "hi", createdAt: 500 }, crypto);
  const good = await send(alice, rumor, bob.pubkey);
  assert.equal(await openNip17GiftWrap({ ...good, sig: "bad" }, bob, crypto), null, "unsigned wrap");
  assert.equal(await openNip17GiftWrap({ ...good, tags: [["p", carol.pubkey]] }, bob, crypto), null, "wrap tags someone else");

  const wrapWith = async (seal: Signed) => {
    const key = party("k");
    return key.sign(await wrapNip17Seal(seal, bob.pubkey, key, 1));
  };
  const sealOf = (content: string, tags: string[][] = []) => alice.sign({ kind: 13, content, tags, created_at: 1 });
  const enc = (value: unknown) => alice.nip44Encrypt(bob.pubkey, JSON.stringify(value));

  assert.equal(await openNip17GiftWrap(await wrapWith(await sealOf(await enc(rumor), [["p", bob.pubkey]])), bob, crypto), null, "seal with tags");
  assert.equal(await openNip17GiftWrap(await wrapWith(await sealOf(await enc({ ...rumor, content: "edited" }))), bob, crypto), null, "rumor id mismatch");
  assert.equal(await openNip17GiftWrap(await wrapWith(await sealOf(await enc({ ...rumor, sig: "x" }))), bob, crypto), null, "signed rumor");
  assert.equal(await openNip17GiftWrap(await wrapWith(await sealOf("not json")), bob, crypto), null, "garbage");
});

test("group rumors tag the sender first, then each member once", () => {
  const rumor = createNip17Rumor(
    { sender: alice.pubkey, recipients: [bob.pubkey, carol.pubkey, alice.pubkey, bob.pubkey], content: "g", createdAt: 1, group: true },
    crypto,
  );
  assert.deepEqual(rumor.tags, [["p", alice.pubkey], ["p", bob.pubkey], ["p", carol.pubkey]]);
});

test("recipients: untagged payment rumors are for this account; an untagged self copy names no one", async () => {
  const untagged = { wrapId: "w", senderPubkey: alice.pubkey, rumor: { id: "r", pubkey: alice.pubkey, kind: 14, content: "", tags: [], created_at: 1 } };
  assert.deepEqual(nip17MessageRecipients(untagged, bob.pubkey), [bob.pubkey]);
  assert.equal(nip17MessageRecipients(untagged, alice.pubkey), null);
});

test("timestamps are now or up to two days back", () => {
  assert.equal(nip17Timestamp(1_000_000, null), 1_000_000);
  assert.equal(nip17Timestamp(1_000_000, () => 0.5), 1_000_000 - 86_400);
});
