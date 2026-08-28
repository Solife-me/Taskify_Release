import { chmod, mkdir, open, readFile, rename, unlink } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type { ReminderPreset } from "./shared/taskTypes.js";

export const DEFAULT_PUBLIC_FILE_STORAGE_SERVER = "https://nostr.build";
export const DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER = "https://originless.solife.me";

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
  syncedAt?: number;
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
  /** @deprecated Use defaultList instead */
  defaultColumn?: string;
  /** "boardName listName" — the "home list" (column) for this profile */
  defaultList?: string;
  /** Canonical default used by non-interactive clients. */
  defaultLocation?: { boardId: string; listId?: string };
  trustedNpubs: string[];
  securityMode: "moderate" | "strict" | "off";
  securityEnabled: boolean;
  boards: BoardEntry[];
  taskReminders: Record<string, ReminderPreset[]>;
  processedInboxRumorIds?: string[];
  contacts?: Contact[];
  fileStorageServer?: string;
  encryptedFileStorageServer?: string;
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
  selectedProfile: string;
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
  fileStorageServer: DEFAULT_PUBLIC_FILE_STORAGE_SERVER,
  encryptedFileStorageServer: DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER,
};

function profileDefaults(partial: Partial<ProfileConfig>): ProfileConfig {
  const boards = partial.boards ?? [];
  return {
    ...DEFAULT_PROFILE,
    ...partial,
    relays: partial.relays && partial.relays.length > 0 ? partial.relays : [...DEFAULT_RELAYS],
    taskReminders: partial.taskReminders ?? {},
    processedInboxRumorIds: partial.processedInboxRumorIds ?? [],
    trustedNpubs: partial.trustedNpubs ?? [],
    boards,
    defaultColumn: partial.defaultColumn,
    defaultList: partial.defaultList,
    defaultLocation: normalizeDefaultLocation(partial, boards),
    contacts: partial.contacts ?? [],
    fileStorageServer: partial.fileStorageServer ?? DEFAULT_PUBLIC_FILE_STORAGE_SERVER,
    encryptedFileStorageServer: partial.encryptedFileStorageServer ?? DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER,
  };
}

function findBoard(boards: BoardEntry[], reference: string | undefined): BoardEntry | undefined {
  const ref = reference?.trim();
  if (!ref) return undefined;
  const exact = boards.find((board) => board.id === ref);
  if (exact) return exact;
  const lower = ref.toLocaleLowerCase();
  return boards.find((board) => board.name.toLocaleLowerCase() === lower);
}

function findList(board: BoardEntry | undefined, reference: string | undefined): { id: string; name: string } | undefined {
  const ref = reference?.trim();
  if (!board || !ref) return undefined;
  const exact = board.columns?.find((list) => list.id === ref);
  if (exact) return exact;
  const lower = ref.toLocaleLowerCase();
  return board.columns?.find((list) => list.name.toLocaleLowerCase() === lower);
}

function parseLegacyDefaultList(
  raw: string | undefined,
  boards: BoardEntry[],
): { board: BoardEntry; listRef: string } | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) {
    const board = findBoard(boards, value.slice(0, slash));
    if (board) return { board, listRef: value.slice(slash + 1).trim() };
  }

  const references = boards.flatMap((board) => [
    { board, value: board.id },
    { board, value: board.name },
  ]).sort((left, right) => right.value.length - left.value.length);
  const lower = value.toLocaleLowerCase();
  for (const candidate of references) {
    const prefix = `${candidate.value.toLocaleLowerCase()} `;
    if (lower.startsWith(prefix)) {
      return { board: candidate.board, listRef: value.slice(candidate.value.length).trim() };
    }
  }
  return undefined;
}

function normalizeDefaultLocation(
  partial: Partial<ProfileConfig>,
  boards: BoardEntry[],
): { boardId: string; listId?: string } | undefined {
  if (partial.defaultLocation?.boardId?.trim()) {
    const board = findBoard(boards, partial.defaultLocation.boardId);
    const list = findList(board, partial.defaultLocation.listId);
    return {
      boardId: board?.id ?? partial.defaultLocation.boardId.trim(),
      ...(partial.defaultLocation.listId
        ? { listId: list?.id ?? partial.defaultLocation.listId.trim() }
        : {}),
    };
  }

  const legacyList = parseLegacyDefaultList(partial.defaultList, boards);
  if (legacyList) {
    const list = findList(legacyList.board, legacyList.listRef);
    if (list) return { boardId: legacyList.board.id, listId: list.id };
  }

  const board = findBoard(boards, partial.defaultBoard);
  if (!board) return undefined;
  const list = findList(board, partial.defaultColumn);
  return { boardId: board.id, ...(list ? { listId: list.id } : {}) };
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function ensurePrivateConfigDirectory(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await chmod(CONFIG_DIR, 0o700);
}

async function writeStoredConfig(stored: StoredConfig): Promise<void> {
  await ensurePrivateConfigDirectory();
  const tempPath = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(stored, null, 2), "utf-8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, CONFIG_PATH);
    await chmod(CONFIG_PATH, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function loadConfig(profileName?: string): Promise<TaskifyConfig> {
  let stored: StoredConfig;

  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Config file is malformed; refusing to overwrite ${CONFIG_PATH}`, { cause: error });
    }
    // Migration: detect old flat format (has nsec or relays at top level, no profiles key)
    if (!parsed.profiles && (parsed.nsec !== undefined || Array.isArray(parsed.relays))) {
      const profile = profileDefaults(parsed as Partial<ProfileConfig>);
      stored = {
        activeProfile: "default",
        profiles: { default: profile },
      };
      // Migrate in memory. A later explicit save persists the new shape; reads stay read-only.
    } else if (parsed.profiles && parsed.activeProfile) {
      stored = parsed as unknown as StoredConfig;
    } else {
      // New empty or unrecognized config
      stored = {
        activeProfile: "default",
        profiles: { default: { ...DEFAULT_PROFILE } },
      };
    }
  } catch (error) {
    if (!isFileSystemError(error) || error.code !== "ENOENT") {
      throw error;
    }
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
    selectedProfile: resolvedProfileName,
    profiles: stored.profiles,
  };
}

// Updates the selected profile from flat cfg fields, then saves.
export async function saveConfig(cfg: TaskifyConfig): Promise<void> {
  const targetProfile = cfg.selectedProfile ?? cfg.activeProfile;
  const profileData: ProfileConfig = {
    nsec: cfg.nsec,
    relays: cfg.relays,
    defaultBoard: cfg.defaultBoard,
    defaultColumn: cfg.defaultColumn,
    defaultList: cfg.defaultList,
    defaultLocation: cfg.defaultLocation,
    trustedNpubs: cfg.trustedNpubs,
    securityMode: cfg.securityMode,
    securityEnabled: cfg.securityEnabled,
    boards: cfg.boards,
    taskReminders: cfg.taskReminders,
    processedInboxRumorIds: cfg.processedInboxRumorIds,
    contacts: cfg.contacts,
    fileStorageServer: cfg.fileStorageServer,
    encryptedFileStorageServer: cfg.encryptedFileStorageServer,
    agent: cfg.agent,
  };
  const stored: StoredConfig = {
    activeProfile: cfg.activeProfile,
    profiles: {
      ...cfg.profiles,
      [targetProfile]: profileData,
    },
  };
  await writeStoredConfig(stored);
}

// Save the raw profiles structure (for profile management commands — does NOT rewrite active profile from flat fields)
export async function saveProfiles(
  activeProfile: string,
  profiles: Record<string, ProfileConfig>,
): Promise<void> {
  await writeStoredConfig({ activeProfile, profiles });
}

export function getActiveProfile(cfg: TaskifyConfig): ProfileConfig {
  return cfg.profiles[cfg.activeProfile] ?? { ...DEFAULT_PROFILE };
}

export async function setActiveProfile(cfg: TaskifyConfig, name: string): Promise<void> {
  await saveProfiles(name, cfg.profiles);
}

export function redactConfig<T>(value: T): T {
  const visit = (current: unknown, key = ""): unknown => {
    if (/^(nsec|apiKey|secretKey|walletSeed|mnemonic)$/i.test(key) && current !== undefined) {
      return "[redacted]";
    }
    if (Array.isArray(current)) return current.map((entry) => visit(entry));
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>)
        .map(([childKey, childValue]) => [childKey, visit(childValue, childKey)]),
    );
  };
  return visit(value) as T;
}

export function resolveProfile(cfg: TaskifyConfig, name?: string): ProfileConfig {
  const profileName = name ?? cfg.activeProfile;
  return cfg.profiles[profileName] ?? { ...DEFAULT_PROFILE };
}
