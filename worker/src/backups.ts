// Encrypted cloud backups — extracted from index.ts (Item #12 worker module
// split, pass 5).
//
// R2-backed object storage keyed by `backups/taskify-backup-<npub>.json`.
// The backup payload itself is opaque (AES-GCM ciphertext + iv from the
// client); the worker only stores/retrieves bytes and tracks lastReadAt for
// the cron cleanup. Backups expire if untouched for ~3 months.

import type { Env } from "./lib.ts";
import { jsonResponse, parseJson, MINUTE_MS } from "./lib.ts";

const THREE_MONTHS_MS = 90 * 24 * 60 * MINUTE_MS;
const ONE_WEEK_MS = 7 * 24 * 60 * MINUTE_MS;
const BACKUP_CLEANUP_STATE_KEY = "backups-cleanup-state.json";

// ---- Object-key helper + handlers ----

function getBackupObjectKey(npubRaw: string | null): string | null {
  if (!npubRaw) return null;
  const trimmed = npubRaw.trim().toLowerCase();
  if (!trimmed.startsWith("npub")) return null;
  if (!/^[0-9a-z]+$/.test(trimmed)) return null;
  return `backups/taskify-backup-${trimmed}.json`;
}

async function handleSaveBackup(request: Request, env: Env): Promise<Response> {
  if (!env.TASKIFY_BACKUPS) {
    return jsonResponse({ error: "Cloud backups are not configured" }, 501);
  }
  const body = await parseJson(request);
  const { npub, ciphertext, iv, version, createdAt } = body || {};
  const objectKey = getBackupObjectKey(typeof npub === "string" ? npub : null);
  if (!objectKey) {
    return jsonResponse({ error: "Invalid npub" }, 400);
  }
  if (typeof ciphertext !== "string" || !ciphertext) {
    return jsonResponse({ error: "ciphertext is required" }, 400);
  }
  if (typeof iv !== "string" || !iv) {
    return jsonResponse({ error: "iv is required" }, 400);
  }
  const nowIso = new Date().toISOString();
  const payload = {
    version: typeof version === "number" ? version : 1,
    createdAt: typeof createdAt === "string" && createdAt ? createdAt : nowIso,
    updatedAt: nowIso,
    lastReadAt: nowIso,
    ciphertext,
    iv,
  };
  await env.TASKIFY_BACKUPS.put(objectKey, JSON.stringify(payload), {
    httpMetadata: {
      contentType: "application/json",
      cacheControl: "private, max-age=0, must-revalidate",
    },
  });
  return jsonResponse({ ok: true });
}

async function handleLoadBackup(url: URL, env: Env): Promise<Response> {
  if (!env.TASKIFY_BACKUPS) {
    return jsonResponse({ error: "Cloud backups are not configured" }, 501);
  }
  const objectKey = getBackupObjectKey(url.searchParams.get("npub"));
  if (!objectKey) {
    return jsonResponse({ error: "Invalid npub" }, 400);
  }
  const stored = await env.TASKIFY_BACKUPS.get(objectKey);
  if (!stored) {
    return jsonResponse({ error: "Backup not found" }, 404);
  }
  let text: string;
  try {
    text = await stored.text();
  } catch {
    return jsonResponse({ error: "Failed to read backup" }, 500);
  }
  if (!text) {
    return jsonResponse({ error: "Backup not found" }, 404);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "Backup data is corrupted" }, 500);
  }
  if (!parsed || typeof parsed !== "object") {
    return jsonResponse({ error: "Backup data is corrupted" }, 500);
  }
  const payload = parsed as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  const storedPayload = { ...payload, lastReadAt: nowIso };
  try {
    await env.TASKIFY_BACKUPS.put(objectKey, JSON.stringify(storedPayload), {
      httpMetadata: {
        contentType: "application/json",
        cacheControl: "private, max-age=0, must-revalidate",
      },
    });
  } catch (err) {
    console.error("Failed to update backup metadata", {
      error: err instanceof Error ? err.message : String(err),
      key: objectKey,
    });
  }
  const { lastReadAt: _lastReadAt, ...responsePayload } = storedPayload;
  return jsonResponse({ backup: responsePayload });
}

// ---- Cron cleanup: delete backups untouched for ~3 months ----

async function cleanupExpiredBackups(env: Env): Promise<void> {
  if (!env.TASKIFY_BACKUPS) {
    return;
  }
  const now = Date.now();
  let lastRunAt = Number.NEGATIVE_INFINITY;

  try {
    const stateObject = await env.TASKIFY_BACKUPS.get(BACKUP_CLEANUP_STATE_KEY);
    if (stateObject) {
      const raw = await stateObject.text();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { lastRunAt?: string } | null;
          const candidate = parsed && typeof parsed.lastRunAt === "string" ? Date.parse(parsed.lastRunAt) : NaN;
          if (!Number.isNaN(candidate)) {
            lastRunAt = candidate;
          }
        } catch (err) {
          console.error("Failed to parse cleanup state", err);
        }
      }
    }
  } catch (err) {
    console.error("Failed to read cleanup state", err);
  }

  if (Number.isFinite(lastRunAt) && now - lastRunAt < ONE_WEEK_MS) {
    return;
  }

  let cursor: string | undefined;
  const cutoff = now - THREE_MONTHS_MS;
  let cleanupAttempted = false;

  do {
    let listResult: R2ListResult;
    try {
      listResult = await env.TASKIFY_BACKUPS.list({
        prefix: "backups/",
        limit: 1000,
        cursor,
      });
    } catch (err) {
      console.error("Failed to list backups", err);
      return;
    }
    cleanupAttempted = true;
    const objects = Array.isArray(listResult.objects) ? listResult.objects : [];
    for (const obj of objects) {
      if (!obj || typeof obj.key !== "string" || !obj.key) {
        continue;
      }
      try {
        const stored = await env.TASKIFY_BACKUPS.get(obj.key);
        if (!stored) {
          continue;
        }
        const raw = await stored.text();
        if (!raw) {
          await env.TASKIFY_BACKUPS.delete(obj.key);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          await env.TASKIFY_BACKUPS.delete(obj.key);
          continue;
        }
        if (!parsed || typeof parsed !== "object") {
          await env.TASKIFY_BACKUPS.delete(obj.key);
          continue;
        }
        const payload = parsed as Record<string, unknown>;
        const timestamps = ["lastReadAt", "updatedAt", "createdAt"].map((field) => {
          const value = payload[field];
          if (typeof value === "string" && value) {
            const parsedDate = Date.parse(value);
            if (!Number.isNaN(parsedDate)) {
              return parsedDate;
            }
          }
          return Number.NEGATIVE_INFINITY;
        });
        const lastTouched = Math.max(...timestamps);
        if (!Number.isFinite(lastTouched) || lastTouched < cutoff) {
          await env.TASKIFY_BACKUPS.delete(obj.key);
        }
      } catch (err) {
        console.error("Failed to process backup for cleanup", {
          key: obj.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    cursor = listResult.truncated ? (listResult.cursor ?? undefined) : undefined;
  } while (cursor);

  if (cleanupAttempted) {
    try {
      await env.TASKIFY_BACKUPS.put(
        BACKUP_CLEANUP_STATE_KEY,
        JSON.stringify({ lastRunAt: new Date(now).toISOString() }),
        {
          httpMetadata: {
            contentType: "application/json",
            cacheControl: "private, max-age=0, must-revalidate",
          },
        },
      );
    } catch (err) {
      console.error("Failed to update cleanup state", err);
    }
  }
}

export { handleSaveBackup, handleLoadBackup, cleanupExpiredBackups };
