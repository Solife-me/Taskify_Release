import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, type EventTemplate } from "nostr-tools";
import { normalizeFileServerUrl } from "./fileStorage";

export type BlossomRetention = "protected" | "standard";

export type BlossomStorageBytes = {
  usedBytes: number;
  limitBytes: number;
};

export type BlossomPaidStorage = {
  bytes: number;
  paidThrough: number;
};

export type BlossomStandardRule = {
  type: string;
  expiration: number | null;
};

export type BlossomStorageOffer = {
  planId: string;
  planName: string;
  interval: "month" | "year" | string;
  priceUsdCents: number;
  bytes: number;
  durationSeconds: number;
};

export type BlossomStorageSummary = {
  protected: BlossomStorageBytes;
  total: BlossomStorageBytes;
  permanentExtraBytes: number;
  paidStorage: BlossomPaidStorage[];
  protectionSeconds: number;
  offers: BlossomStorageOffer[];
  standardRules: BlossomStandardRule[];
};

export type BlossomStorageBlob = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  lastAccessed: number;
  standardInactivitySeconds: number | null;
  tier: BlossomRetention;
  protectedUntil: number | null;
};

export type BlossomStorageInventoryPage = {
  blobs: BlossomStorageBlob[];
  nextCursor: string | null;
};

export type BlossomStorageOrder = {
  id: string;
  planId: string;
  planName: string;
  interval: "month" | "year" | string;
  priceUsdCents: number;
  bytes: number;
  amountSats: number;
  paymentHash: string;
  invoice: string;
  invoiceExpiresAt: number;
  paidThrough: number | null;
};

export type BlossomStorageErrorCode =
  | "protected_quota_exceeded"
  | "quota_exceeded"
  | "server_capacity"
  | "upload_retry"
  | "checkout_conflict"
  | "billing_unavailable"
  | string;

export class BlossomStorageApiError extends Error {
  readonly status: number;
  readonly code: BlossomStorageErrorCode;
  readonly reason: string;
  readonly response: unknown;

  constructor(status: number, code: BlossomStorageErrorCode, message: string, response: unknown = null) {
    super(message);
    this.name = "BlossomStorageApiError";
    this.status = status;
    this.code = code;
    this.reason = message;
    this.response = response;
  }
}

function signerBytes(signer: string | Uint8Array): Uint8Array {
  return typeof signer === "string"
    ? hexToBytes(signer.startsWith("0x") ? signer.slice(2) : signer)
    : signer;
}

function base64(value: Uint8Array, urlSafe: boolean): string {
  let binary = "";
  for (let i = 0; i < value.length; i += 1) binary += String.fromCharCode(value[i]);
  const encoded = btoa(binary);
  return urlSafe ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
}

function absoluteServerURL(serverUrl: string): string {
  return (normalizeFileServerUrl(serverUrl) || serverUrl).replace(/\/+$/, "");
}

export function blossomServerHost(serverUrl: string): string {
  try {
    return new URL(absoluteServerURL(serverUrl)).host.toLowerCase();
  } catch {
    return serverUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  }
}

/** BUD-11 authorization for standard Blossom upload and delete endpoints. */
export function buildBud11AuthHeader(options: {
  signer: string | Uint8Array;
  action: "upload" | "delete";
  sha256: string;
  serverUrl: string;
  retention?: "protected" | "prefer-protected";
  now?: number;
}): string {
  const createdAt = options.now ?? Math.floor(Date.now() / 1000);
  const template: EventTemplate = {
    kind: 24242,
    content: options.action === "upload" ? "Upload Blob" : "Delete Blob",
    tags: [
      ["t", options.action],
      ["x", options.sha256],
      ["expiration", String(createdAt + 3600)],
      ["server", blossomServerHost(options.serverUrl)],
      ...(options.action === "upload" && options.retention ? [["retention", options.retention]] : []),
    ],
    created_at: createdAt,
  };
  const event = finalizeEvent(template, signerBytes(options.signer));
  return `Nostr ${base64(new TextEncoder().encode(JSON.stringify(event)), true)}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(sha256(bytes));
}

/** NIP-98 authorization for the private Storage API. The URL includes its query string exactly. */
export async function buildNip98AuthHeader(options: {
  signer: string | Uint8Array;
  method: string;
  url: string;
  payload?: Uint8Array;
  now?: number;
}): Promise<string> {
  const tags: string[][] = [
    ["u", options.url],
    ["method", options.method.toUpperCase()],
  ];
  if (options.payload) tags.push(["payload", await sha256Hex(options.payload)]);
  const template: EventTemplate = {
    kind: 27235,
    content: "",
    tags,
    created_at: options.now ?? Math.floor(Date.now() / 1000),
  };
  const event = finalizeEvent(template, signerBytes(options.signer));
  return `Nostr ${base64(new TextEncoder().encode(JSON.stringify(event)), false)}`;
}

function storageApiUrl(serverUrl: string, path = "", query?: URLSearchParams): string {
  const base = `${absoluteServerURL(serverUrl)}/api/storage/v1${path}`;
  const suffix = query && query.size ? `?${query.toString()}` : "";
  return `${base}${suffix}`;
}

async function readError(res: Response): Promise<BlossomStorageApiError> {
  let response: any = null;
  try {
    response = await res.json();
  } catch {
    try {
      response = await res.text();
    } catch {
      response = null;
    }
  }
  const code = typeof response?.error === "string"
    ? response.error
    : typeof response?.code === "string"
      ? response.code
      : `http_${res.status}`;
  const message = typeof response?.message === "string" && response.message.trim()
    ? response.message.trim()
    : typeof response?.reason === "string" && response.reason.trim()
      ? response.reason.trim()
      : `Storage request failed (${res.status})`;
  return new BlossomStorageApiError(res.status, code, message, response);
}

async function storageRequest<T>(
  options: {
    serverUrl: string;
    signer: string | Uint8Array;
    path?: string;
    method: string;
    query?: URLSearchParams;
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<T> {
  const url = storageApiUrl(options.serverUrl, options.path, options.query);
  const bodyBytes = typeof options.body === "undefined"
    ? undefined
    : new TextEncoder().encode(JSON.stringify(options.body));
  const authorization = await buildNip98AuthHeader({
    signer: options.signer,
    method: options.method,
    url,
    payload: bodyBytes,
  });
  const headers: Record<string, string> = { Authorization: authorization, Accept: "application/json" };
  if (bodyBytes) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: options.method,
    headers,
    body: bodyBytes,
    signal: options.signal,
  });
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  const data = await res.json();
  return data as T;
}

export function getBlossomStorageSummary(
  serverUrl: string,
  signer: string | Uint8Array,
  signal?: AbortSignal,
): Promise<BlossomStorageSummary> {
  return storageRequest({ serverUrl, signer, method: "GET", signal });
}

export function listBlossomStorageBlobs(options: {
  serverUrl: string;
  signer: string | Uint8Array;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<BlossomStorageInventoryPage> {
  const query = new URLSearchParams();
  query.set("limit", String(Math.max(1, Math.min(100, options.limit ?? 50))));
  if (options.cursor) query.set("cursor", options.cursor);
  return storageRequest({
    serverUrl: options.serverUrl,
    signer: options.signer,
    method: "GET",
    path: "/blobs",
    query,
    signal: options.signal,
  });
}

export function protectBlossomStorageBlob(options: {
  serverUrl: string;
  signer: string | Uint8Array;
  sha256: string;
  signal?: AbortSignal;
}): Promise<{ tier: BlossomRetention; protectedUntil: number | null }> {
  return storageRequest({
    serverUrl: options.serverUrl,
    signer: options.signer,
    method: "PUT",
    path: `/blobs/${encodeURIComponent(options.sha256)}/protection`,
    signal: options.signal,
  });
}

/** Standard BUD-11 delete. It removes this pubkey's ownership, not other owners' references. */
export async function deleteBlossomStorageBlob(options: {
  serverUrl: string;
  signer: string | Uint8Array;
  sha256: string;
  signal?: AbortSignal;
}): Promise<void> {
  const base = absoluteServerURL(options.serverUrl);
  const url = `${base}/${encodeURIComponent(options.sha256)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: buildBud11AuthHeader({
        signer: options.signer,
        action: "delete",
        sha256: options.sha256,
        serverUrl: options.serverUrl,
      }),
      "X-SHA-256": options.sha256,
    },
    signal: options.signal,
  });
  if (!res.ok) throw await readError(res);
}

export function createBlossomStorageOrder(options: {
  serverUrl: string;
  signer: string | Uint8Array;
  requestId: string;
  offer: Pick<BlossomStorageOffer, "planId" | "interval" | "priceUsdCents" | "bytes">;
  signal?: AbortSignal;
}): Promise<BlossomStorageOrder> {
  return storageRequest({
    serverUrl: options.serverUrl,
    signer: options.signer,
    method: "POST",
    path: "/orders",
    body: {
      requestId: options.requestId,
      planId: options.offer.planId,
      interval: options.offer.interval,
      priceUsdCents: options.offer.priceUsdCents,
      bytes: options.offer.bytes,
    },
    signal: options.signal,
  });
}

export function getBlossomStorageOrder(options: {
  serverUrl: string;
  signer: string | Uint8Array;
  id: string;
  signal?: AbortSignal;
}): Promise<BlossomStorageOrder> {
  return storageRequest({
    serverUrl: options.serverUrl,
    signer: options.signer,
    method: "GET",
    path: `/orders/${encodeURIComponent(options.id)}`,
    signal: options.signal,
  });
}

export async function listBlossomStorageOrders(options: {
  serverUrl: string;
  signer: string | Uint8Array;
  signal?: AbortSignal;
}): Promise<BlossomStorageOrder[]> {
  const result = await storageRequest<{ orders?: BlossomStorageOrder[] }>({
    serverUrl: options.serverUrl,
    signer: options.signer,
    method: "GET",
    path: "/orders",
    signal: options.signal,
  });
  return Array.isArray(result?.orders) ? result.orders : [];
}

/** A stable fingerprint of the retention terms a fallback acceptance was based on. */
export function blossomTermsFingerprint(summary: BlossomStorageSummary): string {
  return JSON.stringify({
    protectionSeconds: summary.protectionSeconds,
    standardRules: [...(summary.standardRules ?? [])]
      .map((rule) => [rule.type, rule.expiration])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    protectedLimitBytes: summary.protected.limitBytes,
    totalLimitBytes: summary.total.limitBytes,
  });
}
