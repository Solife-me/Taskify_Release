// Settings types extracted from App.tsx

import type { AccentPalette } from "../../theme/palette";
import type { Weekday } from "./taskTypes";
import type { ScriptureMemoryFrequency, ScriptureMemorySort } from "../scripture/scriptureTypes";

// ---- Push notifications ----

export type PushPlatform = "ios" | "android";

export type PushPreferences = {
  enabled: boolean;
  platform: PushPlatform;
  deviceId?: string;
  subscriptionId?: string;
  permission?: NotificationPermission;
};

// ---- Fasting reminders ----

export type FastingRemindersMode = "weekday" | "random";

// ---- Settings ----

export type Settings = {
  weekStart: Weekday; // 0=Sun, 1=Mon, 6=Sat
  newTaskPosition: "top" | "bottom";
  streaksEnabled: boolean;
  completedTab: boolean;
  bibleTrackerEnabled: boolean;
  scriptureMemoryEnabled: boolean;
  scriptureMemoryBoardId?: string | null;
  scriptureMemoryFrequency: ScriptureMemoryFrequency;
  scriptureMemorySort: ScriptureMemorySort;
  fastingRemindersEnabled: boolean;
  fastingRemindersMode: FastingRemindersMode;
  fastingRemindersPerMonth: number;
  fastingRemindersWeekday: Weekday;
  fastingRemindersRandomSeed: string;
  showFullWeekRecurring: boolean;
  // Base UI font size in pixels; null uses the OS preferred size
  baseFontSize: number | null;
  startBoardByDay: Partial<Record<Weekday, string>>;
  accent: "green" | "blue" | "background";
  backgroundImage?: string | null;
  backgroundAccent?: AccentPalette | null;
  backgroundAccents?: AccentPalette[] | null;
  backgroundAccentIndex?: number | null;
  backgroundBlur: "blurred" | "sharp";
  hideCompletedSubtasks: boolean;
  startupView: "main" | "wallet";
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  walletSentStateChecksEnabled: boolean;
  walletPaymentRequestsEnabled: boolean;
  walletPaymentRequestsBackgroundChecksEnabled: boolean;
  walletMintBackupEnabled: boolean;
  walletContactsSyncEnabled: boolean;
  fileStorageServer: string;
  encryptedFileStorageServer: string;
  fileServers: string; // JSON-serialized FileServerEntry[]
  encryptedFileServers: string; // JSON-serialized FileServerEntry[]
  npubCashLightningAddressEnabled: boolean;
  npubCashAutoClaim: boolean;
  cloudBackupsEnabled: boolean;
  nostrBackupEnabled: boolean;
  // Metadata sync is controlled by nostrBackupEnabled; kept for backwards compat
  nostrBackupMetadataEnabled: boolean;
  pushNotifications: PushPreferences;
  // Legacy Agent Mode toggle; panel access is now controlled by ?agent=1.

  // Legacy no-op permission flag kept only for backwards compatibility with stored settings.

};

// ---- Accent choices ----

export type AccentChoice = {
  id: "blue" | "green";
  label: string;
  fill: string;
  ring: string;
  border: string;
  borderActive: string;
  shadow: string;
  shadowActive: string;
};

export const ACCENT_CHOICES: AccentChoice[] = [
  {
    id: "blue",
    label: "iMessage blue",
    fill: "#0a84ff",
    ring: "rgba(64, 156, 255, 0.32)",
    border: "rgba(64, 156, 255, 0.38)",
    borderActive: "rgba(64, 156, 255, 0.88)",
    shadow: "0 12px 26px rgba(10, 132, 255, 0.32)",
    shadowActive: "0 18px 34px rgba(10, 132, 255, 0.42)",
  },
  {
    id: "green",
    label: "Mint green",
    fill: "#34c759",
    ring: "rgba(52, 199, 89, 0.28)",
    border: "rgba(52, 199, 89, 0.36)",
    borderActive: "rgba(52, 199, 89, 0.86)",
    shadow: "0 12px 24px rgba(52, 199, 89, 0.28)",
    shadowActive: "0 18px 32px rgba(52, 199, 89, 0.38)",
  },
];
