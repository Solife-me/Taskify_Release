import { hexToBytes } from "@noble/hashes/utils.js";
import { nip44 } from "nostr-tools";
import type { WalletSeedBackupPayload } from "./wallet/seed";

export const NOSTR_APP_BACKUP_KIND = 30078;
export const NOSTR_APP_BACKUP_D_TAG = "taskify-app-backup";
export const NOSTR_APP_BACKUP_CLIENT_TAG = "taskify.app";

export type NostrAppBackupBoard = {
  id: string;
  nostrId?: string;
  relays?: string[];
  name?: string;
  kind?: string;
  archived?: boolean;
  hidden?: boolean;
  order?: number;
  columns?: { id: string; name: string }[];
  children?: string[];
  clearCompletedDisabled?: boolean;
  indexCardEnabled?: boolean;
  hideChildBoardNames?: boolean;
};

export type NostrAppBackupPayload = {
  version: 1;
  timestamp: number;
  boards: NostrAppBackupBoard[];
  settings: Record<string, unknown>;
  walletSeed: WalletSeedBackupPayload;
  defaultRelays?: string[];
};

function ensureNip44v2() {
  if (!nip44?.v2) {
    throw new Error("NIP-44 v2 encryption is unavailable.");
  }
  return nip44.v2;
}

export async function encryptNostrBackupPayload(
  payload: NostrAppBackupPayload,
  skHex: string,
  pkHex: string,
): Promise<string> {
  const nip44v2 = ensureNip44v2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(skHex), pkHex);
  return nip44v2.encrypt(JSON.stringify(payload), conversationKey);
}

export async function decryptNostrBackupPayload(
  content: string,
  skHex: string,
  pkHex: string,
): Promise<NostrAppBackupPayload> {
  const nip44v2 = ensureNip44v2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(skHex), pkHex);
  const plaintext = await nip44v2.decrypt(content, conversationKey);
  const parsed = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid backup payload");
  }
  const timestamp = Number((parsed as any).timestamp) || 0;
  const settings = (parsed as any).settings && typeof (parsed as any).settings === "object"
    ? (parsed as any).settings
    : {};
  const boardsRaw = (parsed as any).boards;
  const boards = Array.isArray(boardsRaw)
    ? boardsRaw.filter((b) => b && typeof b === "object")
    : [];
  const defaultRelaysRaw = (parsed as any).defaultRelays;
  const defaultRelays = Array.isArray(defaultRelaysRaw)
    ? defaultRelaysRaw.filter((r) => typeof r === "string" && r.trim())
    : undefined;
  return {
    version: 1,
    timestamp,
    boards,
    settings,
    walletSeed: (parsed as any).walletSeed as WalletSeedBackupPayload,
    defaultRelays,
  };
}
