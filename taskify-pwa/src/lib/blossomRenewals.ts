import { listBlossomStorageBlobs, type BlossomStorageBlob } from "./blossomStorage";

const DAY_SECONDS = 86_400;

/** Older Blossom deployments used a 30-day window and did not return a field. */
export function blossomRenewalWindowSeconds(advertised: number | undefined): number {
  return typeof advertised === "number" && Number.isFinite(advertised) && advertised > 0
    ? advertised : 30 * DAY_SECONDS;
}

export function isBlossomRenewalDue(
  blob: Pick<BlossomStorageBlob, "tier" | "protectedUntil">,
  windowSeconds: number,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const remaining = (blob.protectedUntil ?? 0) - now;
  return blob.tier === "protected" && remaining > 0 && remaining <= windowSeconds;
}

export async function listBlossomRenewals(
  serverUrl: string,
  signer: string,
  windowSeconds: number,
  signal: AbortSignal,
) {
  const now = Math.floor(Date.now() / 1000);
  const due = new Map<string, BlossomStorageBlob>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const page = await listBlossomStorageBlobs({ serverUrl, signer, cursor, limit: 100, signal });
    for (const blob of page.blobs) {
      if (isBlossomRenewalDue(blob, windowSeconds, now)) due.set(blob.sha256, blob);
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
  } while (cursor);
  return [...due.values()];
}
