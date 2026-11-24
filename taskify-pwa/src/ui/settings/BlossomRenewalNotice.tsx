import { useEffect, useMemo, useState } from "react";
import type { Settings } from "../../domains/tasks/settingsTypes";
import { getBlossomStorageSummary, type BlossomStorageBlob } from "../../lib/blossomStorage";
import { blossomRenewalWindowSeconds, listBlossomRenewals } from "../../lib/blossomRenewals";
import {
  findServerEntry,
  MANAGED_BLOSSOM_SERVER,
  normalizeFileServerUrl,
  parseFileServers,
} from "../../lib/fileStorage";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

type RenewalSettings = Pick<Settings,
  "managedBlossomServer" | "fileStorageServer" | "encryptedFileStorageServer" | "fileServers" | "encryptedFileServers"
>;

function activeBlossomServers(settings: RenewalSettings): string[] {
  const managed = normalizeFileServerUrl(settings.managedBlossomServer || MANAGED_BLOSSOM_SERVER);
  const active = [
    findServerEntry(parseFileServers(settings.encryptedFileServers), settings.encryptedFileStorageServer),
    findServerEntry(parseFileServers(settings.fileServers), settings.fileStorageServer),
  ];
  return [...new Set([managed, ...active.flatMap((entry) => entry?.type === "blossom" ? [entry.url] : [])].filter(Boolean))];
}

export default function BlossomRenewalNotice({
  settings,
  signerKey,
  onReview,
}: {
  settings: RenewalSettings;
  signerKey: string;
  onReview: (serverUrl: string) => void;
}) {
  const { managedBlossomServer, fileStorageServer, encryptedFileStorageServer, fileServers, encryptedFileServers } = settings;
  const servers = useMemo(() => activeBlossomServers({
    managedBlossomServer, fileStorageServer, encryptedFileStorageServer, fileServers, encryptedFileServers,
  }), [managedBlossomServer, fileStorageServer, encryptedFileStorageServer, fileServers, encryptedFileServers]);
  const [dueByServer, setDueByServer] = useState<Record<string, BlossomStorageBlob[]>>({});

  useEffect(() => {
    if (!signerKey) return;
    const controller = new AbortController();
    let inFlight = false;
    let lastChecked = 0;

    async function refresh() {
      if (document.visibilityState === "hidden" || inFlight || controller.signal.aborted) return;
      if (lastChecked && Date.now() - lastChecked < REFRESH_INTERVAL_MS) return;
      inFlight = true;
      try {
        const results = await Promise.allSettled(servers.map(async (serverUrl) => {
          const signal = AbortSignal.any?.([controller.signal, AbortSignal.timeout(20_000)]) ?? controller.signal;
          const summary = await getBlossomStorageSummary(serverUrl, signerKey, signal);
          const windowSeconds = blossomRenewalWindowSeconds(summary.renewalWindowSeconds);
          const blobs = summary.protected.usedBytes > 0
            ? await listBlossomRenewals(serverUrl, signerKey, windowSeconds, signal) : [];
          return { serverUrl, blobs };
        }));
        if (controller.signal.aborted) return;
        setDueByServer((previous) => {
          const next: Record<string, BlossomStorageBlob[]> = {};
          results.forEach((result, index) => {
            if (result.status === "fulfilled") next[result.value.serverUrl] = result.value.blobs;
            else next[servers[index]] = previous[servers[index]] ?? [];
          });
          return next;
        });
        // Retry failed checks when the app returns to the foreground or reconnects.
        lastChecked = results.every((result) => result.status === "fulfilled") ? Date.now() : 0;
      } finally {
        inFlight = false;
      }
    }

    const initial = window.setTimeout(refresh, 500);
    const timer = window.setInterval(refresh, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [servers, signerKey]);

  let count = 0;
  let firstExpiry = Infinity;
  let firstServer = "";
  const now = Date.now() / 1000;
  for (const serverUrl of servers) {
    for (const blob of dueByServer[serverUrl] ?? []) {
      const expires = blob.protectedUntil ?? 0;
      if (expires <= now) continue;
      count += 1;
      if (expires >= firstExpiry) continue;
      firstExpiry = expires;
      firstServer = serverUrl;
    }
  }
  if (!count) return null;

  return (
    <aside className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 text-sm" aria-label="Attachment renewal">
      <span role="status">
        {count} {count === 1 ? "attachment can" : "attachments can"} be renewed. First expiry {new Date(firstExpiry * 1000).toLocaleDateString()}.
      </span>
      <button type="button" className="ghost-button button-sm pressable" onClick={() => onReview(firstServer)}>
        Review renewals
      </button>
    </aside>
  );
}
