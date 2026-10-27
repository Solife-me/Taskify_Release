// Backup and filter-related types extracted from App.tsx

import type { Settings } from "../tasks/settingsTypes";
import type { NostrAppBackupBoard } from "../../nostrBackup";
import type { WalletSeedBackupPayload } from "../../wallet/seed";
import type { PendingTokenEntry } from "../../wallet/storage";

// ---- Upcoming filter types ----

export type UpcomingFilterOption = {
  id: string;
  label: string;
  boardId: string;
  columnId?: string;
};

export type UpcomingFilterGroup = {
  id: string;
  label: string;
  boardId: string;
  boardOption: UpcomingFilterOption;
  listOptions: UpcomingFilterOption[];
};

export type UpcomingFilterPreset = {
  id: string;
  name: string;
  selection: string[];
};

// ---- Nostr backup state ----

export type NostrBackupState = {
  lastEventId: string | null;
  lastTimestamp: number;
  pubkey: string | null;
};

export type NostrBackupSnapshot = {
  boards: NostrAppBackupBoard[];
  settings: Partial<Settings>;
  walletSeed?: WalletSeedBackupPayload | null;
  defaultRelays: string[];
};

// ---- Wallet history ----

export type WalletHistoryEntryKind = "bounty-attachment";

export type WalletHistoryLogEntry = {
  id?: string;
  summary: string;
  type: "lightning" | "ecash";
  direction: "in" | "out";
  amountSat?: number;
  detail?: string;
  detailKind?: "token" | "invoice" | "note";
  mintUrl?: string;
  feeSat?: number;
  entryKind?: WalletHistoryEntryKind;
  relatedTaskTitle?: string;
};

// ---- Full backup payload ----

export type TaskifyBackupPayload = {
  tasks: unknown;
  calendarEvents: unknown;
  externalCalendarEvents?: unknown;
  boards: unknown;
  settings: unknown;
  scriptureMemory: unknown;
  bibleTracker: unknown;
  defaultRelays: unknown;
  contacts: unknown;
  contactsSyncMeta?: unknown;
  nostrSk: string;
  cashu: {
    proofs: unknown;
    activeMint: string | null;
    history: unknown;
    trackedMints: string[];
    pendingTokens: PendingTokenEntry[];
    walletSeed?: WalletSeedBackupPayload;
  };
};
