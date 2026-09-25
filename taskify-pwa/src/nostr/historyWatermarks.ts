import { kvStorage } from "../storage/kvStorage";

// When each relay's history was last recovered completely, so the next recovery reads only what
// arrived since instead of paging back through everything. Recorded as the time the successful
// run started: anything published during the run is read again next time, never skipped.

const LS_HISTORY_WATERMARKS = "taskify_nostr_history_watermarks_v1";

type Watermarks = Record<string, number>;

let cache: Watermarks | null = null;

function load(): Watermarks {
  if (cache) return cache;
  try {
    const raw = kvStorage.getItem(LS_HISTORY_WATERMARKS);
    const parsed = raw ? JSON.parse(raw) : {};
    cache = parsed && typeof parsed === "object" ? parsed as Watermarks : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Unix seconds of the last complete recovery for `key`, or null when it never completed. */
export function getHistoryWatermark(key: string): number | null {
  const value = load()[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function setHistoryWatermark(key: string, seconds: number): void {
  const next = { ...load(), [key]: Math.floor(seconds) };
  cache = next;
  try { kvStorage.setItem(LS_HISTORY_WATERMARKS, JSON.stringify(next)); } catch {}
}

/**
 * The `since` for the next recovery: from the watermark less a lookback for clock skew and
 * backdated events, or from the beginning (undefined) when no recovery has completed.
 */
export function historyRecoverySince(key: string, lookbackSeconds: number, full = false): number | undefined {
  if (full) return undefined;
  const watermark = getHistoryWatermark(key);
  return watermark == null ? undefined : Math.max(0, watermark - lookbackSeconds);
}

/** Test hook: forget the in-memory copy so storage is read again. */
export function resetHistoryWatermarksCache(): void {
  cache = null;
}
