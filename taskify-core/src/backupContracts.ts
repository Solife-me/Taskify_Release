export type NostrAppBackupBoard = {
  id: string;
  nostrId?: string;
  relays?: string[];
  name?: string;
  kind?: "week" | "lists" | "compound" | "bible";
  archived?: boolean;
  hidden?: boolean;
  order?: number;
  columns?: { id: string; name: string }[];
  children?: string[];
  clearCompletedDisabled?: boolean;
  indexCardEnabled?: boolean;
  hideChildBoardNames?: boolean;
};

export type WalletSeedBackupPayload = {
  type: "nut13-wallet-backup";
  version: 1;
  mnemonic: string;
  createdAt?: string;
  counters: Record<string, Record<string, number>>;
};

type RelayNormalizer = (relays: string[] | null | undefined) => string[];

export type BackupBoardLike = {
  id: string;
  name: string;
  kind: "week" | "lists" | "compound" | "bible";
  nostr?: { boardId: string; relays: string[] };
  archived?: boolean;
  hidden?: boolean;
  clearCompletedDisabled?: boolean;
  order?: number;
  indexCardEnabled?: boolean;
  hideChildBoardNames?: boolean;
  columns?: { id: string; name: string }[];
  children?: string[];
};

export type NostrBackupSnapshot<TSettings> = {
  boards: NostrAppBackupBoard[];
  settings: Partial<TSettings>;
  /** Only when the device has a wallet seed; a backup never creates one. */
  walletSeed?: WalletSeedBackupPayload | null;
  defaultRelays: string[];
};

function normalizeColumns(raw: unknown): { id: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((column): column is { id: string; name: string } => !!column && typeof (column as any).id === "string" && typeof (column as any).name === "string").map((column) => ({ id: column.id, name: column.name }));
}

function normalizeChildren(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((child): child is string => typeof child === "string" && !!child.trim());
}

function normalizeOrder(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

export function sanitizeSettingsForNostrBackup<TSettings extends Record<string, unknown>>(raw: TSettings | Record<string, unknown>, defaultPushPreferences: Record<string, unknown>): Partial<TSettings> {
  const clone: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  delete clone.backgroundImage;
  delete clone.backgroundAccent;
  delete clone.backgroundAccents;
  delete clone.backgroundAccentIndex;
  delete clone.accent;
  if (clone.pushNotifications && typeof clone.pushNotifications === "object") {
    const pushNotifications = { ...(clone.pushNotifications as Record<string, unknown>) };
    delete pushNotifications.deviceId;
    delete pushNotifications.subscriptionId;
    clone.pushNotifications = { ...defaultPushPreferences, ...pushNotifications };
  }
  return clone as Partial<TSettings>;
}

export function buildNostrBackupSnapshot<TBoard extends BackupBoardLike, TSettings extends Record<string, unknown>>(options: {
  boards: TBoard[];
  settings: TSettings;
  includeMetadata: boolean;
  defaultRelays: string[];
  fallbackRelays: string[];
  normalizeRelayList: RelayNormalizer;
  sanitizeSettingsForBackup: (raw: TSettings | Record<string, unknown>) => Partial<TSettings>;
  /** Only when the device has a wallet seed; a backup never creates one. */
  walletSeed?: WalletSeedBackupPayload | null;
}): NostrBackupSnapshot<TSettings> {
  const { boards, settings, includeMetadata, defaultRelays, fallbackRelays, normalizeRelayList, sanitizeSettingsForBackup, walletSeed } = options;
  const relayFallback = defaultRelays.length ? defaultRelays : fallbackRelays;
  const defaultRelayList = includeMetadata ? normalizeRelayList(relayFallback) : [];
  const boardsPayload: NostrAppBackupBoard[] = includeMetadata
    ? boards.filter((board) => !!board.nostr?.boardId).map((board, index) => {
        const nostrId = board.nostr?.boardId?.trim();
        if (!nostrId) return null;
        const relays = normalizeRelayList(board.nostr?.relays?.length ? board.nostr.relays : relayFallback);
        return {
          id: board.id, nostrId, relays, name: board.name, kind: board.kind, archived: !!board.archived, hidden: !!board.hidden, order: normalizeOrder(board.order) ?? index,
          columns: board.kind === "lists" ? (board.columns ?? []).map((column) => ({ id: column.id, name: column.name })) : undefined,
          children: board.kind === "compound" ? (board.children ?? []).slice() : undefined,
          clearCompletedDisabled: !!board.clearCompletedDisabled,
          indexCardEnabled: board.kind === "lists" || board.kind === "compound" ? !!board.indexCardEnabled : undefined,
          hideChildBoardNames: board.kind === "compound" ? !!board.hideChildBoardNames : undefined,
        } as NostrAppBackupBoard;
      }).filter((board): board is NostrAppBackupBoard => !!board).sort((a, b) => (normalizeOrder(a.order) ?? 0) - (normalizeOrder(b.order) ?? 0) || a.id.localeCompare(b.id))
    : [];
  const settingsPayload = includeMetadata ? sanitizeSettingsForBackup(settings) : {};
  return { boards: boardsPayload, settings: settingsPayload, ...(walletSeed ? { walletSeed } : {}), defaultRelays: defaultRelayList };
}

export function mergeBackupBoards<TBoard extends BackupBoardLike>(options: {
  currentBoards: TBoard[];
  incomingBoards: NostrAppBackupBoard[];
  baseRelays: string[];
  normalizeRelayList: RelayNormalizer;
  createId: () => string;
}): TBoard[] {
  const { currentBoards, incomingBoards, baseRelays, normalizeRelayList, createId } = options;
  let next = currentBoards.slice();
  let changed = false;
  let hasIncomingOrder = false;
  const normalizeForBoard = (relays?: string[]) => {
    const normalized = normalizeRelayList(relays);
    return normalized.length ? normalized : baseRelays;
  };
  incomingBoards.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const incomingOrder = normalizeOrder(entry.order);
    if (incomingOrder !== undefined) hasIncomingOrder = true;
    const entryId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
    const nostrIdRaw = entry.nostrId || (entry as any)?.nostr?.boardId;
    const nostrId = typeof nostrIdRaw === "string" && nostrIdRaw.trim() ? nostrIdRaw.trim() : undefined;
    if (!nostrId) return;
    const relays = normalizeForBoard(entry.relays);
    const existingIndex = next.findIndex((board) => (board.nostr?.boardId && board.nostr.boardId === nostrId) || board.id === entryId);
    const currentRelays = normalizeRelayList(existingIndex >= 0 ? next[existingIndex].nostr?.relays : []);
    if (existingIndex >= 0) {
      const existing = next[existingIndex];
      const relaysChanged = relays.join("|") !== currentRelays.join("|");
      const patched = { ...existing, id: existing.id || entryId || nostrId || existing.nostr?.boardId || existing.id, nostr: { boardId: existing.nostr?.boardId || nostrId, relays } } as TBoard;
      if (incomingOrder !== undefined) patched.order = incomingOrder;
      if (typeof entry.archived === "boolean") patched.archived = entry.archived;
      if (typeof entry.hidden === "boolean") patched.hidden = entry.hidden;
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (name && existing.name === "Shared Board") patched.name = name;
      if (Array.isArray(entry.columns) && patched.kind === "lists") {
        const columns = normalizeColumns(entry.columns); if (columns.length) (patched as any).columns = columns;
      }
      if (Array.isArray(entry.children) && patched.kind === "compound") (patched as any).children = normalizeChildren(entry.children);
      if (typeof entry.clearCompletedDisabled === "boolean") patched.clearCompletedDisabled = !!entry.clearCompletedDisabled;
      if (typeof entry.indexCardEnabled === "boolean" && (patched.kind === "lists" || patched.kind === "compound")) patched.indexCardEnabled = !!entry.indexCardEnabled;
      if (typeof entry.hideChildBoardNames === "boolean" && patched.kind === "compound") patched.hideChildBoardNames = !!entry.hideChildBoardNames;
      if (!existing.nostr || relaysChanged || patched.name !== existing.name || patched.archived !== existing.archived || patched.hidden !== existing.hidden || patched.order !== existing.order) {
        next[existingIndex] = patched; changed = true;
      }
      return;
    }
    const kindRaw = entry.kind;
    const kind: TBoard["kind"] = (kindRaw === "week" || kindRaw === "compound" || kindRaw === "bible" ? kindRaw : "lists") as TBoard["kind"];
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "Shared Board";
    const boardId = entryId || nostrId || createId();
    const orderPatch = incomingOrder !== undefined ? { order: incomingOrder } : {};
    const base: TBoard = kind === "week" ? ({ id: boardId, name, kind: "week", nostr: { boardId: nostrId, relays }, archived: !!entry.archived, hidden: !!entry.hidden, clearCompletedDisabled: !!entry.clearCompletedDisabled, ...orderPatch } as TBoard)
      : kind === "compound" ? ({ id: boardId, name, kind: "compound", children: normalizeChildren(entry.children), nostr: { boardId: nostrId, relays }, archived: !!entry.archived, hidden: !!entry.hidden, clearCompletedDisabled: !!entry.clearCompletedDisabled, indexCardEnabled: typeof entry.indexCardEnabled === "boolean" ? !!entry.indexCardEnabled : false, hideChildBoardNames: typeof entry.hideChildBoardNames === "boolean" ? !!entry.hideChildBoardNames : false, ...orderPatch } as TBoard)
      : ({ id: boardId, name, kind: "lists", columns: (() => { const columns = normalizeColumns(entry.columns); return columns.length ? columns : [{ id: createId(), name: "Items" }]; })(), nostr: { boardId: nostrId, relays }, archived: !!entry.archived, hidden: !!entry.hidden, clearCompletedDisabled: !!entry.clearCompletedDisabled, indexCardEnabled: typeof entry.indexCardEnabled === "boolean" ? !!entry.indexCardEnabled : false, ...orderPatch } as TBoard);
    next = [...next, base]; changed = true;
  });
  if (hasIncomingOrder) {
    const currentIndex = new Map(next.map((board, index) => [board.id, index]));
    const sorted = next.slice().sort((left, right) => {
      const leftOrder = normalizeOrder(left.order) ?? currentIndex.get(left.id) ?? 0;
      const rightOrder = normalizeOrder(right.order) ?? currentIndex.get(right.id) ?? 0;
      return leftOrder - rightOrder || (currentIndex.get(left.id) ?? 0) - (currentIndex.get(right.id) ?? 0);
    });
    if (sorted.some((board, index) => board !== next[index])) {
      next = sorted;
      changed = true;
    }
  }
  return changed ? next : currentBoards;
}

/** A backup as it is published and read. */
export type NostrBackupContent = {
  boards: NostrAppBackupBoard[];
  settings: Record<string, unknown>;
  walletSeed?: WalletSeedBackupPayload | null;
  defaultRelays?: string[];
  printJobs?: NostrPrintJobManifest[];
};

/** A portable, encrypted print manifest shared by the PWA and native clients. */
export type NostrPrintJobManifest = {
  version: 1;
  layoutVersion: string;
  id: string;
  ownerId: string;
  title: string;
  createdAt: number;
  paper: "letter" | "a4" | "a6";
  format: "taskList" | "bibleChapters";
  items: Array<{
    id: string;
    title: string;
    section?: string;
    filled?: boolean;
  }>;
};

const MAX_SYNCED_PRINT_JOBS = 20;

function validPrintJob(job: NostrPrintJobManifest | null | undefined): job is NostrPrintJobManifest {
  return !!job && job.version === 1 && !!job.id && !!job.ownerId && Number.isFinite(job.createdAt)
    && Array.isArray(job.items);
}

/** Newest manifest wins per stable board/tracker owner; cap history to keep the event bounded. */
export function mergeNostrPrintJobs(
  remote: NostrPrintJobManifest[] | null | undefined,
  local: NostrPrintJobManifest[] | null | undefined,
): NostrPrintJobManifest[] {
  const newest = new Map<string, NostrPrintJobManifest>();
  for (const job of [...(remote ?? []), ...(local ?? [])]) {
    if (!validPrintJob(job)) continue;
    const current = newest.get(job.ownerId);
    if (!current || job.createdAt > current.createdAt || (job.createdAt === current.createdAt && job.id > current.id)) {
      newest.set(job.ownerId, job);
    }
  }
  return [...newest.values()]
    .sort((a, b) => b.createdAt - a.createdAt || a.ownerId.localeCompare(b.ownerId))
    .slice(0, MAX_SYNCED_PRINT_JOBS);
}

/**
 * The backup to publish: the latest one on the relays, updated with this device's snapshot. The
 * same rule as iOS (`updatingNativeBoards`), and the only safe one for a backup several devices
 * write:
 *
 * - never build a backup without having read the remote one (`remote` null only when the relays
 *   confirmed there is none);
 * - boards another device put there stay; the boards this device manages (has published) are
 *   replaced by its current ones, or dropped when it no longer has them;
 * - settings keys only other clients write are kept;
 * - the wallet seed stays when this device has none.
 *
 * Without metadata (boards and settings not backed up from this device), only the seed changes.
 */
export function updateRemoteNostrBackup(
  remote: NostrBackupContent | null,
  local: { boards: NostrAppBackupBoard[]; settings: Record<string, unknown>; walletSeed?: WalletSeedBackupPayload | null; defaultRelays: string[]; printJobs?: NostrPrintJobManifest[] },
  options: { managedNostrIds: Iterable<string>; includeMetadata: boolean },
): NostrBackupContent & { managedNostrIds: string[] } {
  const remoteBoards = Array.isArray(remote?.boards) ? remote!.boards : [];
  const remoteSettings = remote?.settings && typeof remote.settings === "object" ? remote.settings : {};
  const walletSeed = local.walletSeed ?? remote?.walletSeed ?? undefined;
  const managed = new Set(Array.from(options.managedNostrIds, (id) => id.trim()).filter(Boolean));
  if (!options.includeMetadata) {
    return {
      boards: remoteBoards,
      settings: remoteSettings,
      ...(walletSeed ? { walletSeed } : {}),
      defaultRelays: remote?.defaultRelays ?? [],
      printJobs: mergeNostrPrintJobs(remote?.printJobs, local.printJobs),
      managedNostrIds: [...managed].sort(),
    };
  }
  const localIds = new Set(local.boards.map((board) => board.nostrId?.trim()).filter((id): id is string => !!id));
  const kept = remoteBoards.filter((board) => {
    const id = board?.nostrId?.trim();
    if (!id) return true;
    return !localIds.has(id) && !managed.has(id);
  });
  localIds.forEach((id) => managed.add(id));
  return {
    boards: [...kept, ...local.boards],
    settings: { ...remoteSettings, ...local.settings },
    ...(walletSeed ? { walletSeed } : {}),
    defaultRelays: local.defaultRelays,
    printJobs: mergeNostrPrintJobs(remote?.printJobs, local.printJobs),
    managedNostrIds: [...managed].sort(),
  };
}
