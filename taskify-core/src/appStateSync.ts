// Cross-device merge rules for the per-account app state that Taskify syncs as encrypted,
// self-addressed kind-30078 events: the Bible reading tracker, the scripture memory list and
// chat state (read markers + shared-item responses). The native clients implement the same
// rules in `TaskifyCore/State/AppStateSync.swift`; keep the two in step.
//
// Bible tracker and scripture memory merge three ways against the last state this device
// synced (its "base"), so a change made on either device survives and a removal is honored
// instead of the last publisher silently overwriting the other. Conflicts resolve
// symmetrically so two devices merging each other's copies converge on the same result.
//
// Chat state only ever moves forward (read markers advance, a pending share gets answered),
// so it merges without a base.

export const APP_STATE_SYNC_KIND = 30078;
export const APP_STATE_SYNC_CLIENT_TAG = "taskify.app";
export const BIBLE_TRACKER_SYNC_D_TAG = "taskify-bible-tracker";
export const SCRIPTURE_MEMORY_SYNC_D_TAG = "taskify-scripture-memory";
export const CHAT_STATE_SYNC_D_TAG = "taskify-chat-state";

function isoMillis(value: string | null | undefined): number {
  if (typeof value !== "string" || !value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic JSON with sorted object keys, so equal values compare equal across clients. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareStrings(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Three-way merge of a set: an element added on either side is kept, one removed on either
 * side (present in `base`) is dropped. Without a base every element on either side is kept.
 */
export function mergeSetThreeWay<T extends string | number>(
  base: readonly T[] | undefined,
  local: readonly T[],
  remote: readonly T[],
): T[] {
  const baseSet = new Set(base ?? []);
  const localSet = new Set(local);
  const remoteSet = new Set(remote);
  const merged = new Set<T>();
  for (const value of localSet) {
    if (remoteSet.has(value) || !baseSet.has(value)) merged.add(value);
  }
  for (const value of remoteSet) {
    if (localSet.has(value) || !baseSet.has(value)) merged.add(value);
  }
  return Array.from(merged).sort((a, b) =>
    typeof a === "number" && typeof b === "number" ? a - b : compareStrings(String(a), String(b)),
  );
}

/**
 * Three-way merge of a keyed record. A key changed on only one side takes that side's value;
 * a key deleted on one side and untouched on the other is deleted; a key edited on one side
 * and deleted on the other keeps the edit. Keys changed differently on both sides go to
 * `resolve`, which must be symmetric.
 */
function mergeRecordThreeWay<V>(
  base: Record<string, V> | undefined,
  local: Record<string, V>,
  remote: Record<string, V>,
  resolve: (local: V, remote: V) => V,
): Record<string, V> {
  const same = (a: V, b: V) => stableStringify(a) === stableStringify(b);
  const merged: Record<string, V> = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const l = local[key];
    const r = remote[key];
    const b = base?.[key];
    if (l !== undefined && r !== undefined) {
      if (same(l, r)) merged[key] = l;
      else if (b !== undefined && same(l, b)) merged[key] = r;
      else if (b !== undefined && same(r, b)) merged[key] = l;
      else merged[key] = resolve(l, r);
      continue;
    }
    const only = l !== undefined ? l : r;
    if (only === undefined) continue;
    if (b !== undefined && same(only, b)) continue;
    merged[key] = only;
  }
  return merged;
}

// MARK: - Scripture memory

export type ScriptureMemorySyncEntry = {
  id: string;
  bookId: string;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
  addedAtISO: string;
  lastReviewISO?: string;
  scheduledAtISO?: string;
  stage: number;
  totalReviews: number;
};

export type ScriptureMemorySyncState = {
  entries: ScriptureMemorySyncEntry[];
  lastReviewISO?: string;
};

/** The entry that has seen more review wins; ties fall through to a stable ordering. */
function pickFurtherReviewedEntry(
  a: ScriptureMemorySyncEntry,
  b: ScriptureMemorySyncEntry,
): ScriptureMemorySyncEntry {
  if ((a.totalReviews ?? 0) !== (b.totalReviews ?? 0)) {
    return (a.totalReviews ?? 0) > (b.totalReviews ?? 0) ? a : b;
  }
  const reviewA = isoMillis(a.lastReviewISO);
  const reviewB = isoMillis(b.lastReviewISO);
  if (reviewA !== reviewB) return reviewA > reviewB ? a : b;
  if ((a.stage ?? 0) !== (b.stage ?? 0)) return (a.stage ?? 0) > (b.stage ?? 0) ? a : b;
  const scheduledA = isoMillis(a.scheduledAtISO);
  const scheduledB = isoMillis(b.scheduledAtISO);
  if (scheduledA !== scheduledB) return scheduledA > scheduledB ? a : b;
  return compareStrings(stableStringify(a), stableStringify(b)) >= 0 ? a : b;
}

function latestISO(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const time = isoMillis(value);
    if (time > bestTime) {
      bestTime = time;
      best = value;
    }
  }
  return best;
}

export function mergeScriptureMemoryStates<S extends ScriptureMemorySyncState>(
  base: ScriptureMemorySyncState | null | undefined,
  local: S,
  remote: ScriptureMemorySyncState,
): S {
  const byId = (entries: ScriptureMemorySyncEntry[] | undefined) => {
    const record: Record<string, ScriptureMemorySyncEntry> = {};
    for (const entry of entries ?? []) {
      if (entry && typeof entry.id === "string" && entry.id) record[entry.id] = entry;
    }
    return record;
  };
  const merged = mergeRecordThreeWay(
    base ? byId(base.entries) : undefined,
    byId(local.entries),
    byId(remote.entries),
    pickFurtherReviewedEntry,
  );
  const ordered: ScriptureMemorySyncEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...(local.entries ?? []), ...(remote.entries ?? [])]) {
    const next = merged[entry.id];
    if (!next || seen.has(entry.id)) continue;
    seen.add(entry.id);
    ordered.push(next);
  }
  const lastReviewISO = latestISO([
    local.lastReviewISO,
    remote.lastReviewISO,
    ...ordered.map((entry) => entry.lastReviewISO),
  ]);
  const result = { ...local, entries: ordered } as S;
  if (lastReviewISO) result.lastReviewISO = lastReviewISO;
  else delete (result as ScriptureMemorySyncState).lastReviewISO;
  return result;
}

// MARK: - Bible tracker

export type BibleTrackerSyncArchiveEntry = {
  id: string;
  savedAtISO: string;
  lastResetISO: string;
  progress: Record<string, number[]>;
  verses: Record<string, Record<string, number[]>>;
  verseCounts: Record<string, Record<string, number>>;
  completedBooks: Record<string, { completedAtISO: string }>;
};

export type BibleTrackerSyncState = {
  lastResetISO: string;
  progress: Record<string, number[]>;
  verses: Record<string, Record<string, number[]>>;
  verseCounts: Record<string, Record<string, number>>;
  completedBooks: Record<string, { completedAtISO: string }>;
  archive: BibleTrackerSyncArchiveEntry[];
};

function mergeNestedSets(
  base: Record<string, Record<string, number[]>> | undefined,
  local: Record<string, Record<string, number[]>>,
  remote: Record<string, Record<string, number[]>>,
): Record<string, Record<string, number[]>> {
  const merged: Record<string, Record<string, number[]>> = {};
  for (const outer of new Set([...Object.keys(local ?? {}), ...Object.keys(remote ?? {})])) {
    const inner: Record<string, number[]> = {};
    const l = local?.[outer] ?? {};
    const r = remote?.[outer] ?? {};
    const b = base?.[outer];
    for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const values = mergeSetThreeWay(b?.[key], l[key] ?? [], r[key] ?? []);
      if (values.length) inner[key] = values;
    }
    if (Object.keys(inner).length) merged[outer] = inner;
  }
  return merged;
}

function mergeVerseCounts(
  base: Record<string, Record<string, number>> | undefined,
  local: Record<string, Record<string, number>>,
  remote: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const merged: Record<string, Record<string, number>> = {};
  for (const book of new Set([...Object.keys(local ?? {}), ...Object.keys(remote ?? {})])) {
    const inner = mergeRecordThreeWay(base?.[book], local?.[book] ?? {}, remote?.[book] ?? {}, (a, b) => Math.max(a, b));
    if (Object.keys(inner).length) merged[book] = inner;
  }
  return merged;
}

function mergeArchives(
  base: BibleTrackerSyncArchiveEntry[] | undefined,
  local: BibleTrackerSyncArchiveEntry[],
  remote: BibleTrackerSyncArchiveEntry[],
): BibleTrackerSyncArchiveEntry[] {
  const byId = (entries: BibleTrackerSyncArchiveEntry[] | undefined) =>
    Object.fromEntries((entries ?? []).filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  const merged = mergeRecordThreeWay(
    base ? byId(base) : undefined,
    byId(local),
    byId(remote),
    (a, b) => (compareStrings(stableStringify(a), stableStringify(b)) >= 0 ? a : b),
  );
  return Object.values(merged).sort((a, b) => {
    const diff = isoMillis(b.savedAtISO) - isoMillis(a.savedAtISO);
    if (Number.isFinite(diff) && diff !== 0) return diff;
    return compareStrings(a.id, b.id);
  });
}

export function mergeBibleTrackerStates<S extends BibleTrackerSyncState>(
  base: BibleTrackerSyncState | null | undefined,
  local: S,
  remote: BibleTrackerSyncState,
): S {
  const archive = mergeArchives(base?.archive, local.archive ?? [], remote.archive ?? []);
  if (local.lastResetISO !== remote.lastResetISO) {
    // One device reset the tracker since they last agreed. The newer reading cycle wins
    // outright; the older cycle's progress lives on in the archive that the reset wrote.
    const localTime = isoMillis(local.lastResetISO);
    const remoteTime = isoMillis(remote.lastResetISO);
    const remoteWins = remoteTime !== localTime
      ? remoteTime > localTime
      : compareStrings(remote.lastResetISO, local.lastResetISO) > 0;
    const winner = remoteWins ? remote : local;
    return {
      ...local,
      lastResetISO: winner.lastResetISO,
      progress: winner.progress ?? {},
      verses: winner.verses ?? {},
      verseCounts: winner.verseCounts ?? {},
      completedBooks: winner.completedBooks ?? {},
      archive,
    };
  }
  // A base from a different reading cycle says nothing about this one's removals.
  const cycleBase = base && base.lastResetISO === local.lastResetISO ? base : undefined;
  const progress: Record<string, number[]> = {};
  for (const book of new Set([...Object.keys(local.progress ?? {}), ...Object.keys(remote.progress ?? {})])) {
    const chapters = mergeSetThreeWay(cycleBase?.progress?.[book], local.progress?.[book] ?? [], remote.progress?.[book] ?? []);
    if (chapters.length) progress[book] = chapters;
  }
  return {
    ...local,
    progress,
    verses: mergeNestedSets(cycleBase?.verses, local.verses ?? {}, remote.verses ?? {}),
    verseCounts: mergeVerseCounts(cycleBase?.verseCounts, local.verseCounts ?? {}, remote.verseCounts ?? {}),
    completedBooks: mergeRecordThreeWay(
      cycleBase?.completedBooks,
      local.completedBooks ?? {},
      remote.completedBooks ?? {},
      (a, b) => (isoMillis(a.completedAtISO) <= isoMillis(b.completedAtISO) ? a : b),
    ),
    archive,
  };
}

/**
 * Order-independent fingerprints of the synced content. Clients compare these, not raw JSON,
 * to decide whether there is anything to publish: raw JSON also changes with key order and
 * with device-only UI fields (the PWA's `expandedBooks`), and treating either as a change
 * would republish on every expand/collapse and let two devices bounce merges back and forth.
 */
export function bibleTrackerSyncKey(state: BibleTrackerSyncState): string {
  const content = bibleTrackerSyncContent(state);
  return stableStringify({ ...content, archive: [...content.archive].sort((a, b) => compareStrings(a.id, b.id)) });
}

/**
 * The part of a Bible tracker that syncs. Device-only UI state such as which books are expanded
 * stays on the device: it is left out of the published payload as well as the comparison.
 */
export function bibleTrackerSyncContent(state: BibleTrackerSyncState): BibleTrackerSyncState {
  return {
    lastResetISO: state.lastResetISO,
    progress: state.progress ?? {},
    verses: state.verses ?? {},
    verseCounts: state.verseCounts ?? {},
    completedBooks: state.completedBooks ?? {},
    archive: state.archive ?? [],
  };
}

export function scriptureMemorySyncKey(state: ScriptureMemorySyncState): string {
  return stableStringify({
    entries: [...(state.entries ?? [])]
      .map((entry) => ({ ...entry, startVerse: entry.startVerse ?? null, endVerse: entry.endVerse ?? null }))
      .sort((a, b) => compareStrings(a.id, b.id)),
    lastReviewISO: state.lastReviewISO ?? null,
  });
}

// MARK: - Chat state

export type ChatInboxResponseStatus = "accepted" | "declined" | "tentative" | "deleted";

export type ChatInboxResponse = {
  status: ChatInboxResponseStatus;
  /** Unix seconds when the response was made. */
  at: number;
};

export type ChatSyncState = {
  /** Conversation key (lowercased peer pubkey or group id) -> read-through Unix seconds. */
  readThrough: Record<string, number>;
  /** Shared-item gift-wrap event id -> the response given on some device. */
  inboxResponses: Record<string, ChatInboxResponse>;
};

export type ChatSyncPayload = ChatSyncState & { version: 1; timestamp: number };

const CHAT_INBOX_RESPONSE_STATUSES = new Set<string>(["accepted", "declined", "tentative", "deleted"]);

export function isChatInboxResponseStatus(value: unknown): value is ChatInboxResponseStatus {
  return typeof value === "string" && CHAT_INBOX_RESPONSE_STATUSES.has(value);
}

export function emptyChatSyncState(): ChatSyncState {
  return { readThrough: {}, inboxResponses: {} };
}

export function sanitizeChatSyncState(raw: unknown): ChatSyncState {
  const state = emptyChatSyncState();
  if (!raw || typeof raw !== "object") return state;
  const readThrough = (raw as { readThrough?: unknown }).readThrough;
  if (readThrough && typeof readThrough === "object") {
    for (const [key, value] of Object.entries(readThrough as Record<string, unknown>)) {
      const normalizedKey = key.trim().toLowerCase();
      const seconds = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
      if (!normalizedKey || seconds <= 0) continue;
      state.readThrough[normalizedKey] = Math.max(state.readThrough[normalizedKey] ?? 0, seconds);
    }
  }
  const responses = (raw as { inboxResponses?: unknown }).inboxResponses;
  if (responses && typeof responses === "object") {
    for (const [key, value] of Object.entries(responses as Record<string, unknown>)) {
      const normalizedKey = key.trim().toLowerCase();
      if (!normalizedKey || !value || typeof value !== "object") continue;
      const status = (value as { status?: unknown }).status;
      const at = (value as { at?: unknown }).at;
      if (!isChatInboxResponseStatus(status)) continue;
      const response = { status, at: typeof at === "number" && Number.isFinite(at) ? Math.max(0, Math.floor(at)) : 0 };
      const existing = state.inboxResponses[normalizedKey];
      state.inboxResponses[normalizedKey] = existing ? pickChatInboxResponse(existing, response) : response;
    }
  }
  return state;
}

function pickChatInboxResponse(a: ChatInboxResponse, b: ChatInboxResponse): ChatInboxResponse {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return compareStrings(a.status, b.status) >= 0 ? a : b;
}

export function mergeChatSyncStates(a: ChatSyncState, b: ChatSyncState): ChatSyncState {
  const merged = emptyChatSyncState();
  for (const source of [a, b]) {
    for (const [key, seconds] of Object.entries(source.readThrough ?? {})) {
      merged.readThrough[key] = Math.max(merged.readThrough[key] ?? 0, seconds);
    }
    for (const [key, response] of Object.entries(source.inboxResponses ?? {})) {
      const existing = merged.inboxResponses[key];
      merged.inboxResponses[key] = existing ? pickChatInboxResponse(existing, response) : response;
    }
  }
  return merged;
}

/**
 * True when merging `local` into `remote` would change nothing — i.e. there is nothing for
 * this device to publish. Checks only `local`'s entries, so it stays cheap on every keystroke.
 */
export function chatSyncStateCovers(remote: ChatSyncState, local: ChatSyncState): boolean {
  for (const [key, seconds] of Object.entries(local.readThrough ?? {})) {
    if ((remote.readThrough?.[key] ?? 0) < seconds) return false;
  }
  for (const [key, response] of Object.entries(local.inboxResponses ?? {})) {
    const existing = remote.inboxResponses?.[key];
    if (!existing) return false;
    const picked = pickChatInboxResponse(existing, response);
    if (picked.status !== existing.status || picked.at !== existing.at) return false;
  }
  return true;
}

export function chatSyncStatesEqual(a: ChatSyncState, b: ChatSyncState): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Keeps the synced chat state small: drops shared-item responses older than `maxAgeSeconds`
 * and keeps only the newest `maxEntries` of each map. A dropped read marker costs at most a
 * stale unread badge on a device that never opened that conversation.
 */
export function pruneChatSyncState(
  state: ChatSyncState,
  options: { nowSeconds: number; maxAgeSeconds?: number; maxEntries?: number },
): ChatSyncState {
  const maxAge = options.maxAgeSeconds ?? 180 * 24 * 60 * 60;
  const maxEntries = options.maxEntries ?? 1000;
  const cutoff = options.nowSeconds - maxAge;
  const newest = <V>(record: Record<string, V>, time: (value: V) => number) =>
    Object.fromEntries(
      Object.entries(record)
        .filter(([, value]) => time(value) >= cutoff)
        .sort(([ka, a], [kb, b]) => time(b) - time(a) || compareStrings(ka, kb))
        .slice(0, maxEntries),
    );
  return {
    readThrough: newest(state.readThrough, (seconds) => seconds),
    inboxResponses: newest(state.inboxResponses, (response) => response.at),
  };
}
