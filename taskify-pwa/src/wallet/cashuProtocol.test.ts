import { describe, expect, test } from "vitest";
import { getDecodedToken, getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { getCashuTokenMetadata } from "./cashuTokenMetadata";

import { applyBackupDataToStorage } from "../domains/backup/backupUtils.ts";
import type { TaskifyBackupPayload } from "../domains/backup/backupTypes.ts";
import { assertValidProofsDleq } from "./dleq.ts";
import {
  getLockedMintQuote,
  getPendingMelt,
  type LockedMintQuotePayload,
  loadStore,
  removeLockedMintQuote,
  removePendingMelt,
  saveStore,
  upsertLockedMintQuote,
  upsertPendingMelt,
} from "./storage.ts";
import {
  assembleNut16FromText,
  combineNut16Frames,
  createNut16Animation,
} from "./nut16.ts";

const MINT = "https://mint.example.com";
const KEYSET_ID = "009a1f293253e41e";
const VALID_C = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const VALID_MINT_PUBKEY = "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

function amountToNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number.parseFloat(value);
  const amountLike = value as { toNumber?: () => number; toNumberUnsafe?: () => number; toString?: () => string };
  if (typeof amountLike?.toNumber === "function") return amountLike.toNumber();
  if (typeof amountLike?.toNumberUnsafe === "function") return amountLike.toNumberUnsafe();
  return Number(amountLike?.toString?.() ?? value);
}

function proof(overrides: Partial<Proof> = {}): Proof {
  return {
    amount: 2 as any,
    id: KEYSET_ID,
    secret: `secret-${Math.random().toString(16).slice(2)}`,
    C: VALID_C,
    ...overrides,
  } as Proof;
}

describe("Cashu token protocol compatibility", () => {
  test("encodes and decodes current Cashu tokens with metadata amount", () => {
    const proofs = [proof({ amount: 2 as any }), proof({ amount: 4 as any })];
    const token = getEncodedToken({ mint: MINT, proofs, unit: "sat" });

    const metadata = getCashuTokenMetadata(token);
    expect(metadata.mint).toBe(MINT);
    expect(metadata.unit).toBe("sat");
    expect(amountToNumber(metadata.amount)).toBe(6);

    const decoded = getDecodedToken(token, []);
    expect(decoded.mint).toBe(MINT);
    expect(decoded.unit).toBe("sat");
    expect(decoded.proofs).toHaveLength(2);
    expect(decoded.proofs.map((entry) => amountToNumber(entry.amount))).toEqual([2, 4]);
  });

  test("round-trips animated NUT-16 frames back into a spendable token string", () => {
    const token = getEncodedToken({ mint: MINT, proofs: [proof()], unit: "sat" });
    const animation = createNut16Animation(token, { chunkSize: 30 });

    expect(animation).not.toBeNull();
    expect(animation!.frames.length).toBeGreaterThan(1);
    expect(combineNut16Frames(animation!.frames)).toBe(token);
    expect(assembleNut16FromText(animation!.frames.map((frame) => frame.value).join("\n")).token).toBe(token);
  });
});

describe("Cashu proof hardening", () => {
  test("rejects included DLEQ proofs when the mint key cannot be resolved", () => {
    const proofs = [
      proof({
        dleq: { e: "01", s: "02", r: "03" },
      } as Partial<Proof>),
    ];

    expect(() => assertValidProofsDleq(proofs, () => null)).toThrow(/missing mint pubkey/i);
  });

  test("rejects malformed DLEQ encodings before accepting received proofs", () => {
    const proofs = [
      proof({
        dleq: { e: "not-hex", s: "02", r: "03" },
      } as Partial<Proof>),
    ];

    expect(() => assertValidProofsDleq(proofs, () => VALID_MINT_PUBKEY)).toThrow(/invalid dleq\.e hex/i);
  });

  test("sanitizes malformed Cashu proof stores during backup restore", () => {
    saveStore({});

    const cashuBackup = {
      proofs: {
        [`${MINT}/`]: [
          { amount: "8", id: KEYSET_ID, secret: "valid-secret", C: VALID_C },
          { amount: 0, id: KEYSET_ID, secret: "zero-amount", C: VALID_C },
          { amount: 1, id: KEYSET_ID, C: VALID_C },
          { amount: 1, id: KEYSET_ID, secret: "missing-c" },
        ],
        "not-array": { amount: 1 },
      },
    } as Partial<TaskifyBackupPayload["cashu"]> as TaskifyBackupPayload["cashu"];

    applyBackupDataToStorage({
      cashu: cashuBackup,
    });

    const restored = loadStore();
    expect(Object.keys(restored)).toEqual([MINT]);
    expect(restored[MINT]).toHaveLength(1);
    expect(restored[MINT]?.[0]?.secret).toBe("valid-secret");
    expect(amountToNumber(restored[MINT]?.[0]?.amount)).toBe(8);
  });
});

describe("Cashu pending state storage", () => {
  test("stores and retrieves NUT-20 locked mint quotes only when key material is complete", () => {
    const quoteId = `quote-${Date.now()}`;
    const invalid = upsertLockedMintQuote({
      quoteId: `${quoteId}-invalid`,
      mint: MINT,
      quote: { request: "lnbc1..." } as unknown as LockedMintQuotePayload,
      pubkey: VALID_MINT_PUBKEY,
      privkey: "ab".repeat(32),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(invalid).toBeNull();

    const saved = upsertLockedMintQuote({
      quoteId,
      mint: `${MINT}/`,
      quote: { quote: quoteId, request: "lnbc1...", unit: "sat", amount: 21, pubkey: VALID_MINT_PUBKEY },
      pubkey: VALID_MINT_PUBKEY,
      privkey: "ab".repeat(32),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(saved?.mint).toBe(MINT);
    expect(getLockedMintQuote(MINT, quoteId)?.privkey).toBe("ab".repeat(32));
    removeLockedMintQuote(MINT, quoteId);
  });

  test("keeps pending melt previews needed to recover paid-change proofs", () => {
    const quoteId = `melt-${Date.now()}`;
    removePendingMelt(MINT, quoteId);

    upsertPendingMelt({
      quoteId,
      mint: `${MINT}/`,
      quote: {
        quote: quoteId,
        request: "lnbc1...",
        amount: 10,
        fee_reserve: 1,
        state: "PENDING",
        expiry: Math.floor(Date.now() / 1000) + 600,
        payment_preimage: null,
        unit: "sat",
      },
      keep: [proof({ secret: "keep" })],
      send: [proof({ secret: "send" })],
      preview: {
        method: "bolt11",
        inputs: [proof({ secret: "input" })],
        outputData: [
          {
            blindedMessage: { B_: VALID_C },
            blindingFactor: "123",
            secret: "abcd",
          },
        ],
        keysetId: KEYSET_ID,
        quote: {
          quote: quoteId,
          request: "lnbc1...",
          amount: 10,
          fee_reserve: 1,
          state: "PENDING",
          expiry: Math.floor(Date.now() / 1000) + 600,
          payment_preimage: null,
          unit: "sat",
        },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const restored = getPendingMelt(MINT, quoteId);
    expect(restored?.mint).toBe(MINT);
    expect(restored?.keep).toHaveLength(1);
    expect(restored?.send).toHaveLength(1);
    expect(restored?.preview?.outputData).toHaveLength(1);
    removePendingMelt(MINT, quoteId);
  });
});
