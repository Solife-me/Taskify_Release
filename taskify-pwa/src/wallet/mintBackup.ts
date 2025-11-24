import { mnemonicToSeedSync } from "@scure/bip39";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { getPublicKey, nip44, type EventTemplate } from "nostr-tools";
import { LS_MINT_BACKUP_CACHE } from "../localStorageKeys";
import { sanitizeMintList } from "./storage";

export const MINT_BACKUP_KIND = 30078;
export const MINT_BACKUP_D_TAG = "mint-list";
export const MINT_BACKUP_CLIENT_TAG = "taskify.app";

export type MintBackupPayload = {
  mints: string[];
  timestamp: number;
};

export type DerivedMintBackupKeys = {
  privateKeyHex: string;
  publicKeyHex: string;
};

export function deriveMintBackupKeys(mnemonic: string): DerivedMintBackupKeys {
  const seed: Uint8Array = mnemonicToSeedSync(mnemonic);
  const domainSeparator = new TextEncoder().encode("cashu-mint-backup");
  const combinedData = new Uint8Array(seed.length + domainSeparator.length);
  combinedData.set(seed);
  combinedData.set(domainSeparator, seed.length);

  const privateKeyBytes = sha256(combinedData);
  const privateKeyHex = bytesToHex(privateKeyBytes);
  const publicKeyHex = getPublicKey(privateKeyBytes);

  return { privateKeyHex, publicKeyHex };
}

function ensureNip44() {
  if (!nip44?.v2) {
    throw new Error("NIP-44 v2 encryption is unavailable.");
  }
  return nip44.v2;
}

export async function encryptMintBackupPayload(
  payload: MintBackupPayload,
  keys: DerivedMintBackupKeys,
): Promise<string> {
  const nip44v2 = ensureNip44();
  const conversationKey = nip44v2.utils.getConversationKey(keys.privateKeyHex, keys.publicKeyHex);
  return nip44v2.encrypt(JSON.stringify(payload), conversationKey);
}

export async function decryptMintBackupPayload(
  encryptedContent: string,
  keys: DerivedMintBackupKeys,
): Promise<MintBackupPayload> {
  const nip44v2 = ensureNip44();
  const conversationKey = nip44v2.utils.getConversationKey(keys.privateKeyHex, keys.publicKeyHex);
  const plaintext = await nip44v2.decrypt(encryptedContent, conversationKey);
  const parsed = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid mint backup payload");
  }
  const mints = sanitizeMintList(Array.isArray((parsed as any).mints) ? (parsed as any).mints : []);
  const timestamp = Number((parsed as any).timestamp) || 0;
  return { mints, timestamp };
}

export async function createMintBackupTemplate(
  mints: string[],
  keys: DerivedMintBackupKeys,
  options?: { timestamp?: number; clientTag?: string },
): Promise<EventTemplate> {
  const normalizedMints = sanitizeMintList(mints);
  const timestamp = options?.timestamp ?? Math.floor(Date.now() / 1000);
  const payload: MintBackupPayload = { mints: normalizedMints, timestamp };
  const content = await encryptMintBackupPayload(payload, keys);
  const tags: string[][] = [["d", MINT_BACKUP_D_TAG]];
  if (options?.clientTag) {
    tags.push(["client", options.clientTag]);
  }
  return {
    kind: MINT_BACKUP_KIND,
    content,
    tags,
    created_at: timestamp,
  };
}

export function isMintBackupEvent(event: { kind?: number; tags?: string[][] }): boolean {
  if (!event || typeof event.kind !== "number" || !Array.isArray(event.tags)) return false;
  if (event.kind !== MINT_BACKUP_KIND) return false;
  return event.tags.some((tag) => Array.isArray(tag) && tag[0] === "d" && tag[1] === MINT_BACKUP_D_TAG);
}

export function loadMintBackupCache(): MintBackupPayload | null {
  try {
    const raw = localStorage.getItem(LS_MINT_BACKUP_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.mints)) {
      return {
        mints: parsed.mints,
        timestamp: Number(parsed.timestamp) || 0,
      } as MintBackupPayload;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

export function persistMintBackupCache(payload: MintBackupPayload | null): MintBackupPayload | null {
  try {
    if (!payload) {
      localStorage.removeItem(LS_MINT_BACKUP_CACHE);
      return null;
    }
    localStorage.setItem(
      LS_MINT_BACKUP_CACHE,
      JSON.stringify({ mints: payload.mints ?? [], timestamp: payload.timestamp ?? 0 }),
    );
    return payload;
  } catch {
    return payload ?? null;
  }
}
