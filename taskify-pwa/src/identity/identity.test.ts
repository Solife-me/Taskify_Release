// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const idbValues = new Map<string, unknown>();
vi.mock("../storage/idbStorage", () => ({
  idbStorage: {
    get: vi.fn(async (_db: unknown, _store: string, key: string) => idbValues.get(key)),
    put: vi.fn(async (_db: unknown, _store: string, value: unknown, key: string) => {
      idbValues.set(key, value);
    }),
    delete: vi.fn(async (_db: unknown, _store: string, key: string) => {
      idbValues.delete(key);
    }),
  },
}));
vi.mock("../storage/taskifyDb", async () => {
  const actual = await vi.importActual<typeof import("../storage/taskifyDb")>("../storage/taskifyDb");
  return { ...actual, getTaskifyDb: vi.fn(async () => ({} as IDBDatabase)) };
});

import { getPublicKey, verifyEvent } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";
import { __resetForTests, init, setSk } from "../lib/nostrSkStore";
import {
  adoptLocalSecretKey,
  currentIdentity,
  currentPubkey,
  resetIdentityForTests,
  revealLocalSecretKey,
  signOut,
} from "./identity";
import { LocalKeySigner } from "./signer";

const ALICE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BOB = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

afterEach(() => {
  idbValues.clear();
  __resetForTests();
  resetIdentityForTests();
  localStorage.clear();
});

describe("LocalKeySigner", () => {
  it("signs verifiable events for its key and round-trips NIP-44 and NIP-04 with a peer", async () => {
    const alice = new LocalKeySigner(ALICE);
    const bob = new LocalKeySigner(BOB);
    expect(alice.pubkey).toBe(getPublicKey(hexToBytes(ALICE)));
    const event = await alice.sign({ kind: 1, tags: [], content: "hi", created_at: 1 });
    expect(event.pubkey).toBe(alice.pubkey);
    expect(verifyEvent(event as never)).toBe(true);
    expect(await bob.nip44Decrypt(alice.pubkey, await alice.nip44Encrypt(bob.pubkey, "secret"))).toBe("secret");
    expect(await bob.nip04Decrypt(alice.pubkey, await alice.nip04Encrypt(bob.pubkey, "legacy"))).toBe("legacy");
  });

  it("rejects malformed keys", () => {
    expect(() => new LocalKeySigner("nope")).toThrow();
  });
});

describe("identity", () => {
  it("loads the stored key, and fills in when first asked before the key store loaded", async () => {
    await setSk(ALICE);
    __resetForTests();
    resetIdentityForTests();
    expect(currentPubkey()).toBeNull();
    await init();
    await vi.waitFor(() => expect(currentPubkey()).toBe(getPublicKey(hexToBytes(ALICE))));
  });

  it("adopts a new key, exposes it only through the named accessor, and signs out", async () => {
    await init();
    const identity = await adoptLocalSecretKey(BOB.toUpperCase());
    expect(currentIdentity()).toBe(identity);
    expect(identity.signer.kind).toBe("local");
    expect(revealLocalSecretKey()).toBe(BOB);
    await signOut();
    expect(currentPubkey()).toBeNull();
    expect(revealLocalSecretKey()).toBeNull();
  });

  it("refuses an invalid key without changing the identity", async () => {
    await init();
    await adoptLocalSecretKey(ALICE);
    await expect(adoptLocalSecretKey("not-a-key")).rejects.toThrow();
    expect(currentPubkey()).toBe(getPublicKey(hexToBytes(ALICE)));
  });
});
