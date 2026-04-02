import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ReminderPreset } from "./shared/taskTypes.js";

export const CONFIG_DIR = join(homedir(), ".taskify-cli");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export type BoardEntry = {
  id: string;
  name: string;
  relays?: string[];
  kind?: "week" | "lists" | "compound" | "bible";
  columns?: { id: string; name: string }[];
  children?: string[];
  archived?: boolean;
  hidden?: boolean;
  indexCardEnabled?: boolean;
  clearCompletedDisabled?: boolean;
  hideChildBoardNames?: boolean;
  shareSettings?: Record<string, unknown>;
  sortMode?: "manual" | "due" | "priority" | "created" | "alpha";
  sortDirection?: "asc" | "desc";
  eventKeys?: Record<string, string>;
};

export type Contact = {
  pubkey: string;
  npub?: string;
  name?: string;
  username?: string;
  displayName?: string;
  nip05?: string;
  about?: string;
  picture?: string;
  relays?: string[];
  addedAt?: number;
  updatedAt?: number;
};

// Per-profile configuration (stored inside profiles.*)
export type ProfileConfig = {
  nsec?: string;
  relays: string[];
  defaultBoard: string;
  trustedNpubs: string[];
  securityMode: "moderate" | "strict" | "off";
  securityEnabled: boolean;
  boards: BoardEntry[];
  taskReminders: Record<string, ReminderPreset[]>;
  processedInboxRumorIds?: string[];
  contacts?: Contact[];
  agent?: {
    apiKey?: string;
    baseUrl?: string;   // default: https://api.openai.com/v1
    model?: string;     // default: gpt-4o-mini
    defaultBoardId?: string;
  };
};

// What gets stored on disk (new multi-profile format)
type StoredConfig = {
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
};

// What loadConfig() returns: flat profile fields + metadata
export type TaskifyConfig = ProfileConfig & {
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
};

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.solife.me",
];

const DEFAULT_PROFILE: ProfileConfig = {
  relays: [...DEFAULT_RELAYS],
  defaultBoard: "Personal",
  trustedNpubs: [],
  securityMode: "moderate",
  securityEnabled: true,
  boards: [],
  taskReminders: {},
  processedInboxRumorIds: [],
};

function profileDefaults(partial: Partial<ProfileConfig>): ProfileConfig {
  return {
    ...DEFAULT_PROFILE,
    ...partial,
    relays: partial.relays && partial.relays.length > 0 ? partial.relays : [...DEFAULT_RELAYS],
    taskReminders: partial.taskReminders ?? {},
    processedInboxRumorIds: partial.processedInboxRumorIds ?? [],
    trustedNpubs: partial.trustedNpubs ?? [],
    boards: partial.boards ?? [],
    contacts: partial.contacts ?? [],
  };
}

export async function loadConfig(profileName?: string): Promise<TaskifyConfig> {
  let stored: StoredConfig;

  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Migration: detect old flat format (has nsec or relays at top level, no profiles key)
    if (!parsed.profiles && (parsed.nsec !== undefined || Array.isArray(parsed.relays))) {
      const profile = profileDefaults(parsed as Partial<ProfileConfig>);
      stored = {
        activeProfile: "default",
        profiles: { default: profile },
      };
      // Save migrated config
      mkdirSync(CONFIG_DIR, { recursive: true });
      await writeFile(CONFIG_PATH, JSON.stringify(stored, null, 2), "utf-8");
      process.stderr.write("✓ Config migrated to multi-profile format\n");
    } else if (parsed.profiles && parsed.activeProfile) {
      stored = parsed as unknown as StoredConfig;
    } else {
      // New empty or unrecognized config
      stored = {
        activeProfile: "default",
        profiles: { default: { ...DEFAULT_PROFILE } },
      };
    }
  } catch {
    stored = {
      activeProfile: "default",
      profiles: { default: { ...DEFAULT_PROFILE } },
    };
  }

  // Determine which profile to use
  const resolvedProfileName = profileName ?? stored.activeProfile;
  const profile = stored.profiles[resolvedProfileName];

  if (!profile) {
    throw new Error(
      `Profile not found: "${resolvedProfileName}". Available: ${Object.keys(stored.profiles).join(", ")}`,
    );
  }

  const merged = profileDefaults(profile);

  // TASKIFY_NSEC env var overrides nsec for any profile
  if (process.env.TASKIFY_NSEC) {
    merged.nsec = process.env.TASKIFY_NSEC;
    process.stderr.write("\x1b[2m(using TASKIFY_NSEC from env)\x1b[0m\n");
  }

  return {
    ...merged,
    activeProfile: stored.activeProfile,
    profiles: stored.profiles,
  };
}

// Updates the active profile from flat cfg fields, then saves
export async function saveConfig(cfg: TaskifyConfig): Promise<void> {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const profileData: ProfileConfig = {
    nsec: cfg.nsec,
    relays: cfg.relays,
    defaultBoard: cfg.defaultBoard,
    trustedNpubs: cfg.trustedNpubs,
    securityMode: cfg.securityMode,
    securityEnabled: cfg.securityEnabled,
    boards: cfg.boards,
    taskReminders: cfg.taskReminders,
    processedInboxRumorIds: cfg.processedInboxRumorIds,
    contacts: cfg.contacts,
    agent: cfg.agent,
  };
  const stored: StoredConfig = {
    activeProfile: cfg.activeProfile,
    profiles: {
      ...cfg.profiles,
      [cfg.activeProfile]: profileData,
    },
  };
  await writeFile(CONFIG_PATH, JSON.stringify(stored, null, 2), "utf-8");
}

// Save the raw profiles structure (for profile management commands — does NOT rewrite active profile from flat fields)
export async function saveProfiles(
  activeProfile: string,
  profiles: Record<string, ProfileConfig>,
): Promise<void> {
  mkdirSync(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify({ activeProfile, profiles }, null, 2), "utf-8");
}

export function getActiveProfile(cfg: TaskifyConfig): ProfileConfig {
  return cfg.profiles[cfg.activeProfile] ?? { ...DEFAULT_PROFILE };
}

export async function setActiveProfile(cfg: TaskifyConfig, name: string): Promise<void> {
  await saveProfiles(name, cfg.profiles);
}

export function resolveProfile(cfg: TaskifyConfig, name?: string): ProfileConfig {
  const profileName = name ?? cfg.activeProfile;
  return cfg.profiles[profileName] ?? { ...DEFAULT_PROFILE };
}
