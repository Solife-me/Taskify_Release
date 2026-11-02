export type FixedFileUploadServerType = "originless" | "blossom";

export type FixedFileUploadRoute = {
  method: "POST" | "PUT";
  path: `/${string}`;
};

const FIXED_UPLOAD_ROUTES: Record<FixedFileUploadServerType, FixedFileUploadRoute> = {
  originless: { method: "POST", path: "/up" },
  blossom: { method: "PUT", path: "/upload" },
};

/**
 * Originless returns a CID and does not serve blobs itself, so retrieval goes through a public
 * gateway. In order of preference: a CID names the same bytes on every gateway, so an attachment
 * whose gateway has gone away can still be fetched from another. Attachments are encrypted before
 * upload, so a gateway only ever handles ciphertext. Both were verified serving an Originless
 * upload, with CORS open for the PWA, in November 2026.
 */
export const TASKIFY_IPFS_GATEWAY_BASES = ["https://ipfs.filebase.io", "https://gateway.pinata.cloud"] as const;
export const TASKIFY_IPFS_GATEWAY_BASE = TASKIFY_IPFS_GATEWAY_BASES[0];

/**
 * Protocol Labs' gateways stopped serving content to apps on September 21, 2026: every request now
 * gets a permanent 429 pointing at a browser-only service worker gateway. Messages already sent
 * still carry these URLs, so they are redirected to the live gateways rather than tried first.
 */
const RETIRED_IPFS_GATEWAY_HOSTS = ["dweb.link", "ipfs.io", "w3s.link", "nftstorage.link"];

/** A gateway that hangs shouldn't hold up the next one for the browser's whole network timeout. */
const IPFS_GATEWAY_ATTEMPT_TIMEOUT_MS = 45_000;

/** Fixed upload routes shared by the PWA, CLI and native clients. NIP-96 discovers its route. */
export function fixedFileUploadRoute(type: FixedFileUploadServerType): FixedFileUploadRoute {
  return FIXED_UPLOAD_ROUTES[type];
}

export function fixedFileUploadURL(serverURL: string, type: FixedFileUploadServerType): string {
  return `${serverURL.replace(/\/+$/, "")}${fixedFileUploadRoute(type).path}`;
}

export const OPAQUE_UPLOAD_FILENAME_SUFFIX = ".bin";

/**
 * A content-addressed name for encrypted upload bytes. It deliberately contains no original
 * filename, extension, MIME type, or account metadata; only ciphertext is reachable at this name.
 */
export function opaqueUploadFilename(ciphertextSha256: string): string {
  const hash = ciphertextSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("Ciphertext SHA-256 must be 64 hexadecimal characters.");
  }
  return `${hash}${OPAQUE_UPLOAD_FILENAME_SUFFIX}`;
}

/** Deliberately shallow: enough to distinguish a CID from a path or sentence. */
function isPlausibleCID(value: string): boolean {
  return (value.length >= 46 || value.startsWith("b")) && /^[A-Za-z0-9]+$/.test(value);
}

/** Resolves the URL shapes returned by Originless, including its CID-only response. */
export function resolveOriginlessUploadURL(serverURL: string, payload: unknown): string {
  const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  for (const key of ["url", "cidUrl", "gatewayUrl", "fileUrl", "ipfs"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const cid = typeof data.cid === "string" ? data.cid.trim() : "";
  if (cid && isPlausibleCID(cid)) return `${TASKIFY_IPFS_GATEWAY_BASE}/ipfs/${cid}`;
  const path = typeof data.path === "string" ? data.path.trim() : "";
  if (!path) return "";
  if (path.startsWith("http")) return path;
  const base = serverURL.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** The CID of a path-style (`/ipfs/{cid}`) or subdomain-style (`{cid}.ipfs.host`) gateway URL. */
function ipfsCIDInURL(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 2 && parts[0] === "ipfs" && isPlausibleCID(parts[1])) return parts[1];
  const labels = url.hostname.split(".");
  if (labels.length > 2 && labels[1] === "ipfs" && isPlausibleCID(labels[0])) return labels[0];
  return null;
}

/** Where to fetch `url` from, in order. A URL that isn't an IPFS gateway URL only has itself. */
export function ipfsRetrievalCandidates(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const cid = ipfsCIDInURL(parsed);
  if (!cid) return [url];
  const host = parsed.hostname.toLowerCase();
  const retired = RETIRED_IPFS_GATEWAY_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
  const live = TASKIFY_IPFS_GATEWAY_BASES.map((base) => `${base}/ipfs/${cid}`);
  return [...new Set(retired ? live : [url, ...live])];
}

/**
 * Fetches `url`, falling back across IPFS gateways when it names content-addressed bytes. Resolves
 * with the first successful response, or the last failed one so the caller can report its status.
 */
export async function fetchWithIPFSGatewayFallback(
  url: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const candidates = ipfsRetrievalCandidates(url);
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (const [index, candidate] of candidates.entries()) {
    const outer = init.signal ?? undefined;
    if (outer?.aborted) throw new DOMException("Aborted", "AbortError");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    outer?.addEventListener("abort", forwardAbort, { once: true });
    // Only the wait for headers is timed: the body of a large file may legitimately take longer.
    const timer = index < candidates.length - 1
      ? setTimeout(forwardAbort, IPFS_GATEWAY_ATTEMPT_TIMEOUT_MS)
      : undefined;
    try {
      const response = await fetchImpl(candidate, { ...init, signal: controller.signal });
      if (response.ok) return response;
      lastResponse = response;
    } catch (error) {
      if (outer?.aborted) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError;
}
