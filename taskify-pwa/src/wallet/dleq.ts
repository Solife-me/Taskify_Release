import type { Proof } from "@cashu/cashu-ts";
import { verifyDLEQProof_reblind } from "@cashu/crypto/modules/client/NUT12";
import { pointFromHex } from "@cashu/crypto/modules/common";
import { hexToBytes } from "@noble/hashes/utils.js";

type ProofMintPubkeyResolver = (proof: Proof) => string | null;

function stripHexPrefix(input: string): string {
  return input.toLowerCase().startsWith("0x") ? input.slice(2) : input;
}

function parseHexBytes(input: string, label: string): Uint8Array {
  const cleaned = stripHexPrefix(input.trim());
  if (!/^[0-9a-f]+$/i.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new Error(`Invalid ${label} hex`);
  }
  return hexToBytes(cleaned);
}

function parseHexBigint(input: string, label: string): bigint {
  const cleaned = stripHexPrefix(input.trim());
  if (!cleaned || !/^[0-9a-f]+$/i.test(cleaned)) {
    throw new Error(`Invalid ${label} hex`);
  }
  return BigInt(`0x${cleaned}`);
}

export function verifyProofDleq(proof: Proof, mintPubkeyHex: string): boolean {
  if (!proof?.dleq) return true;
  const dleq = proof.dleq;
  if (typeof dleq.e !== "string" || typeof dleq.s !== "string") {
    throw new Error("Invalid DLEQ proof encoding");
  }
  if (typeof dleq.r !== "string" || !dleq.r.trim()) {
    throw new Error("Missing blinding factor in included DLEQ proof");
  }
  if (typeof proof.secret !== "string" || !proof.secret.trim()) {
    throw new Error("Missing proof secret");
  }
  if (typeof proof.C !== "string" || !proof.C.trim()) {
    throw new Error("Missing proof signature");
  }
  if (typeof mintPubkeyHex !== "string" || !mintPubkeyHex.trim()) {
    throw new Error("Missing mint pubkey for DLEQ verification");
  }

  const secretBytes = new TextEncoder().encode(proof.secret);
  const C = pointFromHex(proof.C);
  const A = pointFromHex(mintPubkeyHex);
  const eBytes = parseHexBytes(dleq.e, "DLEQ.e");
  const sBytes = parseHexBytes(dleq.s, "DLEQ.s");
  const rBigint = parseHexBigint(dleq.r, "DLEQ.r");

  return verifyDLEQProof_reblind(secretBytes, { e: eBytes, s: sBytes, r: rBigint }, C, A);
}

export function assertValidProofsDleq(proofs: Proof[], resolveMintPubkey: ProofMintPubkeyResolver) {
  if (!Array.isArray(proofs) || proofs.length === 0) return;
  for (const proof of proofs) {
    if (!proof?.dleq) continue;
    const pubkey = resolveMintPubkey(proof);
    if (!pubkey) {
      throw new Error(`Missing mint pubkey for keyset ${proof?.id ?? ""} amount ${proof?.amount ?? 0}`);
    }
    const valid = verifyProofDleq(proof, pubkey);
    if (!valid) {
      throw new Error("Invalid DLEQ proof");
    }
  }
}

