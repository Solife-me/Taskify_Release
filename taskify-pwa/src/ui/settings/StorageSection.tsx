import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Task } from "taskify-core";
import type { Settings } from "../../domains/tasks/settingsTypes";
import {
  MANAGED_BLOSSOM_FILE_SERVER,
  MANAGED_BLOSSOM_SERVER,
  normalizeFileServerUrl,
  parseFileServers,
  serializeFileServers,
  type FileServerEntry,
  type FileServerType,
} from "../../lib/fileStorage";
import {
  BlossomStorageApiError,
  blossomTermsFingerprint,
  createBlossomStorageOrder,
  deleteBlossomStorageBlob,
  getBlossomStorageOrder,
  getBlossomStorageSummary,
  listBlossomStorageBlobs,
  listBlossomStorageOrders,
  protectBlossomStorageBlob,
  type BlossomStorageBlob,
  type BlossomStorageOrder,
  type BlossomStorageSummary,
} from "../../lib/blossomStorage";
import {
  getBlossomFallbackPreference,
  setBlossomFallbackPreference,
  type BlossomFallbackPreference,
} from "../../lib/blossomRetention";
import {
  localBlobReferences,
  matchBlobToLocalReferences,
  type LocalBlobReference,
} from "../../lib/blossomInventoryMatch";
import { decodeBolt11Amount, formatMsatAsSat } from "../../wallet/lightning";
import { resolveDocumentAsset } from "../task/documentAsset";
import { decryptAttachment, inferAttachmentMimeFromUrl } from "../../lib/attachmentCrypto";
import { useToast } from "../../context/ToastContext";
import { FileServersSection } from "./FileServersSection";
import { SettingsAccordion } from "./SettingsAccordion";

const INVENTORY_PAGE_SIZE = 50;
const RENEWAL_WINDOW_SECONDS = 30 * 24 * 60 * 60;

function formatDecimalBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function formatDate(unixSeconds: number | null | undefined): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return "—";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function usagePercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

function usageTone(percent: number): string {
  if (percent >= 95) return "bg-rose-500";
  if (percent >= 85) return "bg-amber-400";
  return "bg-emerald-500";
}

function serverChoices(settings: Settings): FileServerEntry[] {
  const choices = new Map<string, FileServerEntry>();
  for (const entry of [
    ...parseFileServers(settings.encryptedFileServers),
    ...parseFileServers(settings.fileServers),
    MANAGED_BLOSSOM_FILE_SERVER,
  ]) {
    if (entry.type !== "blossom") continue;
    const url = normalizeFileServerUrl(entry.url) || entry.url;
    if (!choices.has(url)) choices.set(url, { ...entry, url });
  }
  return [...choices.values()];
}

function invoiceSatAmountLabel(order: BlossomStorageOrder | null): string | null {
  if (!order?.invoice) return null;
  try {
    const { amountMsat } = decodeBolt11Amount(order.invoice);
    return amountMsat != null && amountMsat > 0n ? formatMsatAsSat(amountMsat) : null;
  } catch {
    return null;
  }
}

function InventoryPreview({ references }: { references: LocalBlobReference[] }) {
  const first = references[0];
  const [src, setSrc] = useState<string | null>(() => {
    if (!first) return null;
    if (first.document?.preview?.type === "image") return first.document.preview.data;
    if (first.document?.full?.type === "image") return first.document.full.data;
    return null;
  });
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUnavailable(false);
    if (!first) {
      setSrc(null);
      return;
    }
    if (first.kind === "document" && first.document) {
      if (first.document.preview?.type === "image") {
        setSrc(first.document.preview.data);
        return;
      }
      if (!first.document.remoteUrl) {
        setSrc(null);
        return;
      }
      if (!["png", "jpg", "jpeg", "webp", "gif"].includes(first.document.kind)) {
        setSrc(null);
        return;
      }
      void resolveDocumentAsset(first.document, first.boardId)
        .then((resolved) => {
          if (cancelled) return;
          setSrc(resolved.preview?.type === "image"
            ? resolved.preview.data
            : resolved.full?.type === "image"
              ? resolved.full.data
              : null);
        })
        .catch(() => { if (!cancelled) setUnavailable(true); });
      return () => { cancelled = true; };
    }
    if (first.kind === "image" && first.imageUrl) {
      if (first.imageUrl.startsWith("data:")) {
        setSrc(first.imageUrl);
        return;
      }
      void decryptAttachment({
        boardId: first.boardId,
        url: first.imageUrl,
        mimeType: inferAttachmentMimeFromUrl(first.imageUrl),
      })
        .then((dataUrl) => { if (!cancelled) setSrc(dataUrl); })
        .catch(() => { if (!cancelled) setUnavailable(true); });
    }
    return () => { cancelled = true; };
  }, [first]);

  if (src) return <img src={src} alt="" loading="lazy" className="h-12 w-12 rounded-xl object-cover" />;
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface text-[10px] text-secondary">
      {unavailable ? "No preview" : first?.kind === "document" ? first.document?.kind?.toUpperCase() || "FILE" : first ? "IMAGE" : "UNMATCHED"}
    </div>
  );
}

function UsageBar({
  label,
  used,
  limit,
  quietNearLimit = false,
}: {
  label: string;
  used: number;
  limit: number;
  quietNearLimit?: boolean;
}) {
  const percent = usagePercent(used, limit);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-primary">{label}</span>
        <span className="text-secondary">{formatDecimalBytes(used)} of {formatDecimalBytes(limit)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface">
        <div className={`h-full rounded-full transition-all ${usageTone(percent)}`} style={{ width: `${percent}%` }} />
      </div>
      {quietNearLimit && percent >= 85 ? (
        <div className="text-[11px] text-secondary">Nearing the included storage limit</div>
      ) : null}
    </div>
  );
}

export function StorageSection({
  settings,
  setSettings,
  pubkeyHex,
  signerKey,
  tasks,
}: {
  settings: Settings;
  setSettings: (settings: Partial<Settings>) => void;
  pubkeyHex: string;
  signerKey: string;
  tasks: Task[];
}) {
  const { show: showToast } = useToast();
  const choices = useMemo(() => serverChoices(settings), [settings]);
  const currentEncryptedBlossom = choices.find((entry) =>
    (normalizeFileServerUrl(entry.url) || entry.url) === (normalizeFileServerUrl(settings.encryptedFileStorageServer) || settings.encryptedFileStorageServer),
  );
  const [selectedServer, setSelectedServer] = useState(currentEncryptedBlossom?.url || MANAGED_BLOSSOM_SERVER);
  const [summary, setSummary] = useState<BlossomStorageSummary | null>(null);
  const [orders, setOrders] = useState<BlossomStorageOrder[]>([]);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [inventory, setInventory] = useState<BlossomStorageBlob[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expiryBlobs, setExpiryBlobs] = useState<BlossomStorageBlob[]>([]);
  const [loading, setLoading] = useState(false);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);
  const [actionSha, setActionSha] = useState<string | null>(null);
  const [managedDraft, setManagedDraft] = useState(settings.managedBlossomServer || MANAGED_BLOSSOM_SERVER);
  const [fallbackPreference, setFallbackPreferenceState] = useState<BlossomFallbackPreference | null>(() =>
    getBlossomFallbackPreference(pubkeyHex, selectedServer),
  );
  const loadGeneration = useRef(0);
  const orderRequests = useRef(new Map<string, {
    requestId: string;
    offer: BlossomStorageSummary["offers"][number];
  }>());

  useEffect(() => {
    setSelectedServer((current) =>
      choices.some((entry) => entry.url === current) ? current : currentEncryptedBlossom?.url || MANAGED_BLOSSOM_SERVER,
    );
  }, [choices, currentEncryptedBlossom?.url]);

  useEffect(() => {
    setManagedDraft(settings.managedBlossomServer || MANAGED_BLOSSOM_SERVER);
  }, [settings.managedBlossomServer]);

  useEffect(() => {
    setFallbackPreferenceState(getBlossomFallbackPreference(pubkeyHex, selectedServer));
  }, [pubkeyHex, selectedServer]);

  const references = useMemo(() => localBlobReferences(tasks), [tasks]);
  const activeOrder = useMemo(
    () => orders.find((order) => order.id === activeOrderId)
      ?? orders.find((order) => !order.paidThrough && order.invoiceExpiresAt * 1000 > Date.now())
      ?? null,
    [activeOrderId, orders],
  );
  const activeInvoiceSats = invoiceSatAmountLabel(activeOrder);
  const activeInvoiceExpired = Boolean(
    activeOrder && !activeOrder.paidThrough && activeOrder.invoiceExpiresAt * 1000 <= Date.now(),
  );
  const offersByPlan = useMemo(() => {
    const grouped = new Map<string, BlossomStorageSummary["offers"]>();
    for (const offer of summary?.offers ?? []) {
      const list = grouped.get(offer.planId) || [];
      list.push(offer);
      grouped.set(offer.planId, list);
    }
    return [...grouped.values()];
  }, [summary?.offers]);
  const expiringGroups = useMemo(() => {
    const groups = new Map<string, BlossomStorageBlob[]>();
    for (const blob of expiryBlobs) {
      if (!blob.protectedUntil || blob.protectedUntil * 1000 < Date.now()) continue;
      const key = new Date(blob.protectedUntil * 1000).toISOString().slice(0, 10);
      const list = groups.get(key) || [];
      list.push(blob);
      groups.set(key, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [expiryBlobs]);

  const loadInventoryPage = useCallback(async (cursor: string | null, replace: boolean) => {
    if (!signerKey || !selectedServer) return;
    setInventoryLoading(true);
    try {
      const page = await listBlossomStorageBlobs({
        serverUrl: selectedServer,
        signer: signerKey,
        cursor,
        limit: INVENTORY_PAGE_SIZE,
      });
      setInventory((previous) => replace ? page.blobs : [...previous, ...page.blobs]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not load stored files.", 5000);
    } finally {
      setInventoryLoading(false);
    }
  }, [selectedServer, showToast, signerKey]);

  const loadExpiryWindow = useCallback(async () => {
    if (!signerKey || !selectedServer) return;
    const collected: BlossomStorageBlob[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await listBlossomStorageBlobs({
        serverUrl: selectedServer,
        signer: signerKey,
        cursor,
        limit: 100,
      });
      collected.push(...result.blobs);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    setExpiryBlobs(collected);
  }, [selectedServer, signerKey]);

  const loadDashboard = useCallback(async () => {
    if (!signerKey || !selectedServer) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, nextOrders] = await Promise.all([
        getBlossomStorageSummary(selectedServer, signerKey),
        listBlossomStorageOrders({ serverUrl: selectedServer, signer: signerKey }).catch(() => []),
      ]);
      if (generation !== loadGeneration.current) return;
      setSummary(nextSummary);
      setOrders(nextOrders);
      setActiveOrderId((current) =>
        current && nextOrders.some((order) => order.id === current)
          ? current
          : nextOrders.find((order) => !order.paidThrough && order.invoiceExpiresAt * 1000 > Date.now())?.id ?? null,
      );
      setFallbackPreferenceState(getBlossomFallbackPreference(pubkeyHex, selectedServer));
      await Promise.all([
        loadInventoryPage(null, true),
        loadExpiryWindow().catch(() => {}),
      ]);
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      setSummary(null);
      setError(
        err instanceof BlossomStorageApiError
          ? `${err.message} (${err.code})`
          : err instanceof Error ? err.message : "Could not load Blossom storage.",
      );
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [loadExpiryWindow, loadInventoryPage, pubkeyHex, selectedServer, signerKey]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!activeOrder || activeOrder.paidThrough || !signerKey) return;
    let cancelled = false;
    let inFlight = false;
    const check = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const next = await getBlossomStorageOrder({
          serverUrl: selectedServer,
          signer: signerKey,
          id: activeOrder.id,
        });
        if (cancelled) return;
        setOrders((current) => current.map((order) => order.id === next.id ? next : order));
        if (next.paidThrough) {
          showToast("Storage payment confirmed. Usage updated.", 4500);
          setActiveOrderId(next.id);
          void loadDashboard();
        }
      } catch {
        // Payment may still be propagating. The next poll or app return will retry.
      } finally {
        inFlight = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5000);
    const onVisibility = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeOrder, loadDashboard, selectedServer, showToast, signerKey]);

  const saveManagedServer = useCallback((useForUploads: boolean) => {
    const normalized = normalizeFileServerUrl(managedDraft);
    if (!normalized) {
      showToast("Enter a valid managed Blossom URL.", 4000);
      return;
    }
    setSettings({ managedBlossomServer: normalized });
    setManagedDraft(normalized);
    if (!useForUploads) {
      showToast("Managed Blossom URL saved.", 3000);
      return;
    }
    const encrypted = parseFileServers(settings.encryptedFileServers);
    const withoutDuplicate = encrypted.filter((entry) => (normalizeFileServerUrl(entry.url) || entry.url) !== normalized);
    const hostname = (() => { try { return new URL(normalized).hostname; } catch { return "Managed Blossom"; } })();
    const nextServers = [...withoutDuplicate, { url: normalized, type: "blossom" as const, label: hostname }];
    setSettings({
      encryptedFileServers: serializeFileServers(nextServers),
      encryptedFileStorageServer: normalized,
    });
    setSelectedServer(normalized);
    showToast("Using the managed Blossom server for encrypted uploads.", 4000);
  }, [managedDraft, setSettings, settings.encryptedFileServers, showToast]);

  const updateFallbackPreference = useCallback((automaticFallback: boolean) => {
    const termsFingerprint = summary ? blossomTermsFingerprint(summary) : null;
    setBlossomFallbackPreference(pubkeyHex, selectedServer, { automaticFallback, termsFingerprint });
    setFallbackPreferenceState(getBlossomFallbackPreference(pubkeyHex, selectedServer));
  }, [pubkeyHex, selectedServer, summary]);

  const protectBlob = useCallback(async (blob: BlossomStorageBlob) => {
    setActionSha(blob.sha256);
    try {
      await protectBlossomStorageBlob({ serverUrl: selectedServer, signer: signerKey, sha256: blob.sha256 });
      showToast(blob.tier === "protected" ? "Protection renewed." : "Blob moved to protected storage.", 3500);
      await loadDashboard();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not update protection.", 5000);
    } finally {
      setActionSha(null);
    }
  }, [loadDashboard, selectedServer, showToast, signerKey]);

  const deleteBlob = useCallback(async (blob: BlossomStorageBlob) => {
    const known = matchBlobToLocalReferences(blob, selectedServer, references);
    const warning = known.length
      ? `This blob is referenced by ${known.length} local task${known.length === 1 ? "" : "s"}: ${known.map((ref) => ref.taskTitle).join(", ")}. Deleting it removes your ownership and may break those attachments elsewhere. Continue?`
      : "This blob has no local filename or task match. It may belong to another Taskify client or app. Do not delete it unless you are sure. Continue?";
    if (!window.confirm(warning)) return;
    setActionSha(blob.sha256);
    try {
      await deleteBlossomStorageBlob({ serverUrl: selectedServer, signer: signerKey, sha256: blob.sha256 });
      setInventory((current) => current.filter((entry) => entry.sha256 !== blob.sha256));
      showToast("Blob ownership deleted. Other owners' references remain valid.", 4000);
      await loadDashboard();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not delete this blob.", 5000);
    } finally {
      setActionSha(null);
    }
  }, [loadDashboard, references, selectedServer, showToast, signerKey]);

  const createOrder = useCallback(async (offer: BlossomStorageSummary["offers"][number]) => {
    const busyKey = `${offer.planId}:${offer.interval}`;
    const existingRequest = orderRequests.current.get(busyKey);
    const request = existingRequest
      && existingRequest.offer.planId === offer.planId
      && existingRequest.offer.interval === offer.interval
      && existingRequest.offer.priceUsdCents === offer.priceUsdCents
      && existingRequest.offer.bytes === offer.bytes
      ? existingRequest
      : { requestId: crypto.randomUUID(), offer };
    orderRequests.current.set(busyKey, request);
    setCheckoutBusy(busyKey);
    try {
      const order = await createBlossomStorageOrder({
        serverUrl: selectedServer,
        signer: signerKey,
        requestId: request.requestId,
        offer: request.offer,
      });
      orderRequests.current.delete(busyKey);
      setOrders((current) => [order, ...current.filter((entry) => entry.id !== order.id)]);
      setActiveOrderId(order.id);
      showToast("Invoice created. Pay it with any Lightning wallet.", 4000);
    } catch (err) {
      if (err instanceof BlossomStorageApiError && err.code === "checkout_conflict") {
        orderRequests.current.delete(busyKey);
        showToast("That offer changed or an invoice is already open. Refreshing checkout.", 5000);
        await loadDashboard();
      } else {
        showToast(err instanceof Error ? err.message : "Could not create a checkout invoice. Retry to reuse this request.", 5000);
      }
    } finally {
      setCheckoutBusy(null);
    }
  }, [loadDashboard, selectedServer, showToast, signerKey]);

  const copyInvoice = useCallback(async () => {
    if (!activeOrder?.invoice) return;
    try {
      await navigator.clipboard.writeText(activeOrder.invoice);
      showToast("Lightning invoice copied.", 2500);
    } catch {
      showToast("Could not copy the invoice.", 3000);
    }
  }, [activeOrder?.invoice, showToast]);

  const totalPercent = summary ? usagePercent(summary.total.usedBytes, summary.total.limitBytes) : 0;
  const protectedPercent = summary ? usagePercent(summary.protected.usedBytes, summary.protected.limitBytes) : 0;

  return (
    <div className="space-y-3">
      <SettingsAccordion title="Blossom account storage" summary="Usage, inventory, protection, and purchases" nested>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium text-secondary" htmlFor="blossom-storage-server">Server</label>
            <select
              id="blossom-storage-server"
              className="pill-input min-w-0 flex-1"
              value={selectedServer}
              onChange={(event) => setSelectedServer(event.target.value)}
            >
              {choices.map((entry) => (
                <option key={entry.url} value={entry.url}>{entry.label || entry.url}</option>
              ))}
            </select>
            <button type="button" className="ghost-button button-sm pressable" onClick={() => void loadDashboard()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {error ? (
            <div className="rounded-xl bg-surface p-3 text-xs text-secondary">
              {error}
              <div className="mt-2 text-[11px] text-tertiary">
                This account may not have Blossom storage plans enabled on the selected server.
              </div>
            </div>
          ) : null}

          {summary ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="glass-panel rounded-xl p-3">
                  <UsageBar label="Protected" used={summary.protected.usedBytes} limit={summary.protected.limitBytes} />
                </div>
                <div className="glass-panel rounded-xl p-3">
                  <UsageBar label="Total" used={summary.total.usedBytes} limit={summary.total.limitBytes} quietNearLimit />
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-secondary">
                <span>Protected: {protectedPercent.toFixed(0)}%</span>
                <span>Total: {totalPercent.toFixed(0)}%</span>
                {summary.permanentExtraBytes > 0 ? <span>Extra: {formatDecimalBytes(summary.permanentExtraBytes)}</span> : null}
                <span>Protection grants last up to {Math.round(summary.protectionSeconds / 86400)} days</span>
              </div>
              {summary.paidStorage.length ? (
                <div className="rounded-xl bg-surface p-3">
                  <div className="text-xs font-medium text-primary">Paid storage</div>
                  <div className="mt-1 space-y-1 text-[11px] text-secondary">
                    {summary.paidStorage.map((entry, index) => (
                      <div key={`${entry.paidThrough}-${index}`}>
                        +{formatDecimalBytes(entry.bytes)} through {formatDate(entry.paidThrough)}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="rounded-xl bg-surface p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-primary">Automatic standard-storage fallback</div>
                <div className="mt-1 text-[11px] text-secondary">
                  When protected storage is full, allow new files to use the server&apos;s standard inactivity rules.
                  This is remembered for {pubkeyHex ? "this account" : "this device"} and this server.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={fallbackPreference?.automaticFallback === true}
                className={`pressable rounded-full px-3 py-1 text-xs ${fallbackPreference?.automaticFallback ? "bg-emerald-500 text-white" : "bg-surface-muted text-secondary"}`}
                onClick={() => updateFallbackPreference(!fallbackPreference?.automaticFallback)}
              >
                {fallbackPreference?.automaticFallback ? "On" : "Off"}
              </button>
            </div>
            {fallbackPreference?.automaticFallback ? (
              <div className="mt-2 text-[11px] text-secondary">
                Standard uploads are labelled in attachment details. Taskify will ask again if the retention terms change.
              </div>
            ) : null}
          </div>

          <div className="rounded-xl bg-surface p-3">
            <div className="text-xs font-medium text-primary">Managed Blossom URL</div>
            <div className="mt-1 text-[11px] text-secondary">
              The built-in managed Blossom default is {MANAGED_BLOSSOM_SERVER}. Set VITE_MANAGED_BLOSSOM_URL or this field to override it for a deployment.
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                className="pill-input min-w-0 flex-1"
                value={managedDraft}
                onChange={(event) => setManagedDraft(event.target.value)}
                placeholder="https://blossom.example.com"
                inputMode="url"
              />
              <button type="button" className="ghost-button button-sm pressable" onClick={() => saveManagedServer(false)}>
                Save
              </button>
              <button type="button" className="accent-button button-sm pressable" onClick={() => saveManagedServer(true)}>
                Use for uploads
              </button>
            </div>
          </div>

          {orders.length ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-primary">Checkout</div>
                <button type="button" className="link-accent text-xs" onClick={() => void loadDashboard()}>Refresh status</button>
              </div>
              {activeOrder ? (
                <div className="rounded-xl border border-surface bg-surface p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-primary">{activeOrder.planName}</div>
                      <div className="text-[11px] text-secondary">
                        +{formatDecimalBytes(activeOrder.bytes)} · {activeOrder.interval === "year" ? "Yearly" : "Monthly"} · ${(activeOrder.priceUsdCents / 100).toFixed(2)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-primary">{activeInvoiceSats == null ? "Amount in invoice" : activeInvoiceSats}</div>
                      <div className="text-[10px] text-secondary">decoded from BOLT11</div>
                    </div>
                  </div>
                  {activeOrder.paidThrough ? (
                    <div className="mt-3 rounded-lg bg-emerald-500/10 p-3 text-xs text-emerald-500">
                      Payment settled. Storage is active through {formatDate(activeOrder.paidThrough)}.
                    </div>
                  ) : activeInvoiceExpired ? (
                    <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-500">
                      This invoice expired. Choose a plan below to create a new one.
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                      <div className="flex h-44 w-44 self-center rounded-xl bg-white p-3">
                        <QRCodeSVG value={activeOrder.invoice} size={160} marginSize={1} />
                      </div>
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="text-[11px] text-secondary">
                          Expires {formatDateTime(activeOrder.invoiceExpiresAt)}. Pay with any Lightning wallet; Taskify checks settlement and refreshes usage.
                        </div>
                        <div className="max-h-20 overflow-auto break-all rounded-lg bg-surface-muted p-2 font-mono text-[10px] text-secondary">
                          {activeOrder.invoice}
                        </div>
                        <button type="button" className="accent-button button-sm pressable" onClick={() => void copyInvoice()}>
                          Copy BOLT11 invoice
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="text-xs font-medium text-primary">Add storage</div>
            {offersByPlan.length ? offersByPlan.map((offers) => (
              <div key={offers[0].planId} className="rounded-xl bg-surface p-3">
                <div className="text-sm font-medium text-primary">{offers[0].planName}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {offers.map((offer) => {
                    const key = `${offer.planId}:${offer.interval}`;
                    return (
                      <button
                        key={key}
                        type="button"
                        className="ghost-button button-sm pressable text-left"
                        disabled={checkoutBusy != null}
                        onClick={() => void createOrder(offer)}
                      >
                        <span className="block text-xs font-medium">
                          ${(offer.priceUsdCents / 100).toFixed(2)} · {offer.interval === "year" ? "Yearly" : "Monthly"}
                        </span>
                        <span className="block text-[10px] text-secondary">+{formatDecimalBytes(offer.bytes)} storage</span>
                        {checkoutBusy === key ? <span className="block text-[10px] text-secondary">Creating invoice…</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )) : (
              <div className="text-[11px] text-secondary">No storage offers are available on this server.</div>
            )}
          </div>

          {expiringGroups.length ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-primary">Upcoming protection expiries</div>
              {expiringGroups.map(([day, blobs]) => (
                <div key={day} className="rounded-xl bg-surface p-3">
                  <div className="text-[11px] font-medium text-secondary">{new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</div>
                  <div className="mt-1 space-y-1">
                    {blobs.map((blob) => {
                      const matches = matchBlobToLocalReferences(blob, selectedServer, references);
                      return (
                        <div key={blob.sha256} className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate text-primary">{matches[0]?.filename || "Unmatched blob"}</span>
                          <span className="text-secondary">{formatDecimalBytes(blob.size)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-primary">Stored files</div>
              <div className="text-[11px] text-secondary">{inventory.length} loaded</div>
            </div>
            {inventory.length ? inventory.map((blob) => {
              const matches = matchBlobToLocalReferences(blob, selectedServer, references);
              const knownTitles = [...new Set(matches.map((ref) => ref.taskTitle))];
              const canRenew = blob.tier === "standard" || !blob.protectedUntil || blob.protectedUntil - Math.floor(Date.now() / 1000) <= RENEWAL_WINDOW_SECONDS;
              return (
                <div key={`${blob.sha256}:${blob.url}`} className="rounded-xl border border-surface bg-surface p-3">
                  <div className="flex gap-3">
                    <InventoryPreview references={matches} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-primary">
                            {matches.length ? matches[0].filename : "Unmatched blob"}
                          </div>
                          <div className="mt-0.5 text-[10px] text-secondary">
                            {formatDecimalBytes(blob.size)} · {blob.type || "unknown type"} · uploaded {formatDate(blob.uploaded)}
                          </div>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] ${blob.tier === "protected" ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"}`}>
                          {blob.tier === "protected" ? "Protected" : "Standard retention"}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-secondary">
                        {blob.tier === "protected" ? blob.protectedUntil ? `Protected until ${formatDate(blob.protectedUntil)}` : "Protected" : "No protection date; standard inactivity rules apply"}
                      </div>
                      {matches.length ? (
                        <div className="mt-1 text-[11px] text-secondary">
                          Task reference{knownTitles.length === 1 ? "" : "s"}: {knownTitles.join(", ")}
                        </div>
                      ) : (
                        <div className="mt-1 text-[11px] text-amber-500">
                          Unmatched: this client cannot identify a local filename or task. It may belong to another app.
                        </div>
                      )}
                      <div className="mt-1 break-all text-[9px] text-tertiary">{blob.sha256}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="ghost-button button-sm pressable"
                          disabled={!canRenew || actionSha === blob.sha256}
                          title={canRenew ? undefined : "Protection can be renewed within 30 days of expiry."}
                          onClick={() => void protectBlob(blob)}
                        >
                          {actionSha === blob.sha256 ? "Updating…" : blob.tier === "standard" ? "Protect" : "Renew"}
                        </button>
                        <a className="ghost-button button-sm pressable" href={blob.url} target="_blank" rel="noopener noreferrer">Open</a>
                        <button
                          type="button"
                          className="ghost-button button-sm pressable text-rose-500"
                          disabled={actionSha === blob.sha256}
                          onClick={() => void deleteBlob(blob)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            }) : (
              <div className="text-[11px] text-secondary">{inventoryLoading ? "Loading stored files…" : "No stored files were returned."}</div>
            )}
            {nextCursor ? (
              <button
                type="button"
                className="ghost-button button-sm pressable"
                disabled={inventoryLoading}
                onClick={() => void loadInventoryPage(nextCursor, false)}
              >
                {inventoryLoading ? "Loading…" : "Load more"}
              </button>
            ) : null}
          </div>
        </div>
      </SettingsAccordion>

      <SettingsAccordion title="Public file servers" summary="Attachment hosts visible to file-server operators" nested>
        <FileServersSection
          fileStorageServer={settings.fileStorageServer}
          fileServers={settings.fileServers || ""}
          onSelectServer={(url) => setSettings({ fileStorageServer: url })}
          onUpdateServers={(serialized) => setSettings({ fileServers: serialized })}
        />
      </SettingsAccordion>
      <SettingsAccordion title="Encrypted file servers" summary="Hosts for encrypted task and chat attachments" nested>
        <FileServersSection
          fileStorageServer={settings.encryptedFileStorageServer}
          fileServers={settings.encryptedFileServers || ""}
          onSelectServer={(url) => setSettings({ encryptedFileStorageServer: url })}
          onUpdateServers={(serialized) => setSettings({ encryptedFileServers: serialized })}
          addWarning={(type: FileServerType | null) => type && type !== "originless" ? "Blossom is supported for encrypted uploads. NIP-96 servers may reject opaque ciphertext." : null}
        />
      </SettingsAccordion>
    </div>
  );
}
