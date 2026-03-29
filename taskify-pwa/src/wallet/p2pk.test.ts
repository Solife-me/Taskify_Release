import { test, describe, expect } from "vitest";

import { extractPubkeysFromP2PKSecret, proofIsLockedToPubkey } from "./p2pk.ts";

const COMPRESSED_A = "02" + "11".repeat(32);
const COMPRESSED_B = "03" + "22".repeat(32);
const X_ONLY = "33".repeat(32);
const UNCOMPRESSED = "04" + "44".repeat(64);

function makeSecret(payload: unknown): string {
  return JSON.stringify(["P2PK", payload]);
}

test("extractPubkeysFromP2PKSecret returns empty on invalid JSON", () => {
  expect(extractPubkeysFromP2PKSecret("not-json")).toEqual([]);
});

test("extractPubkeysFromP2PKSecret collects data + tags and dedupes", () => {
  const secret = makeSecret({
    data: COMPRESSED_A,
    tags: [
      ["pubkeys", COMPRESSED_A, COMPRESSED_B],
      ["refund", X_ONLY],
      ["pubkeys", COMPRESSED_B],
    ],
  });

  const keys = extractPubkeysFromP2PKSecret(secret);
  expect(keys.length).toBe(3);
  expect(keys.includes(COMPRESSED_A.toLowerCase())).toBe(true);
  expect(keys.includes(COMPRESSED_B.toLowerCase())).toBe(true);
  // x-only is normalized to compressed with 02 prefix
  expect(keys.includes(("02" + X_ONLY).toLowerCase())).toBe(true);
});

test("extractPubkeysFromP2PKSecret normalizes uncompressed pubkeys", () => {
  const secret = makeSecret({ data: UNCOMPRESSED });
  const keys = extractPubkeysFromP2PKSecret(secret);
  expect(keys.length).toBe(1);
  expect(keys[0]).toBe(("02" + "44".repeat(32)).toLowerCase());
});

test("proofIsLockedToPubkey returns true when target key is present", () => {
  const secret = makeSecret({
    data: COMPRESSED_A,
    tags: [["pubkeys", COMPRESSED_B]],
  });
  const proof: any = { secret };

  expect(proofIsLockedToPubkey(proof, COMPRESSED_A)).toBe(true);
  expect(proofIsLockedToPubkey(proof, COMPRESSED_B)).toBe(true);
});

test("proofIsLockedToPubkey returns false for missing/invalid key", () => {
  const secret = makeSecret({ data: COMPRESSED_A });
  const proof: any = { secret };

  expect(proofIsLockedToPubkey(proof, COMPRESSED_B)).toBe(false);
  expect(proofIsLockedToPubkey(proof, "not-a-key")).toBe(false);
});
