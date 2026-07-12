// CLI-adapted version of settingsTypes.ts (browser imports removed)

import type { Weekday } from "./taskTypes.js";

// ---- Stubs for types not needed in CLI ----
export type AccentPalette = string;
export type ScriptureMemoryFrequency = string;
export type ScriptureMemorySort = string;

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

export type StartupView = "main" | "wallet" | "upcoming" | "chat";

export type Settings = {
  weekStart: Weekday;
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
  baseFontSize: number | null;
  startBoardByDay: Partial<Record<Weekday, string>>;
  accent: "green" | "blue" | "background";
  backgroundImage?: string | null;
  backgroundAccent?: AccentPalette | null;
  backgroundAccents?: AccentPalette[] | null;
  backgroundAccentIndex?: number | null;
  backgroundBlur: "blurred" | "sharp";
  hideCompletedSubtasks: boolean;
  startupView: StartupView;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  walletSentStateChecksEnabled: boolean;
  walletPaymentRequestsEnabled: boolean;
  walletPaymentRequestsBackgroundChecksEnabled: boolean;
  walletMintBackupEnabled: boolean;
  walletContactsSyncEnabled: boolean;
  fileStorageServer: string;
  npubCashLightningAddressEnabled: boolean;
  npubCashAutoClaim: boolean;
  nostrBackupEnabled: boolean;
  nostrBackupMetadataEnabled: boolean;
  pushNotifications: PushPreferences;
  agentModeEnabled: boolean;
  allowAgentCommands: boolean;
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
