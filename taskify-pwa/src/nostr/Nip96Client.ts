import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey, type EventTemplate, type NostrEvent } from "nostr-tools";
import { fixedFileUploadURL, resolveOriginlessUploadURL, secureUploadedFileURL } from "taskify-core";
import { DEFAULT_FILE_STORAGE_SERVER, normalizeFileServerUrl, type FileServerEntry } from "../lib/fileStorage";
import {
  blossomTermsFingerprint,
  buildBud11AuthHeader,
  getBlossomStorageSummary,
  type BlossomRetention,
} from "../lib/blossomStorage";
import {
  getBlossomFallbackPreference,
  requestBlossomFallbackConsent,
  setBlossomFallbackPreference,
} from "../lib/blossomRetention";

export type Nip96ServerInfo = {
  baseUrl: string;
  apiUrl: string;
  delegatedTo?: string;
};

export type Nip96UploadResult = {
  url: string;
  nip94?: NostrEvent | null;
  response?: any;
  info: Nip96ServerInfo;
};

const NIP96_DISCOVERY_PATH = "/.well-known/nostr/nip96.json";

function encodeBase64(value: string): string {
  try {
    if (typeof btoa === "function") {
      return btoa(unescape(encodeURIComponent(value)));
    }
  } catch {
    // fall back to Buffer if available
  }
  try {
    const globalBuffer = (globalThis as any)?.Buffer;
    if (globalBuffer?.from) {
      return globalBuffer.from(value, "utf8").toString("base64");
    }
  } catch {
    // ignore
  }
  return value;
}


function flattenDebugError(data: any): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const key of ["message", "error", "status", "code", "reason", "detail"]) {
    const value = (data as any)[key];
    if (value !== undefined) out[key] = value;
  }
  out.raw = data;
  return out;
}


function xhrRequest(opts: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: Document | XMLHttpRequestBodyInit | null;
  responseType?: XMLHttpRequestResponseType;
  signal?: AbortSignal;
  onUploadProgress?: (loaded: number, total: number) => void;
  debugLabel?: string;
}): Promise<{ status: number; responseText: string; responseURL: string; responseHeaders: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method, opts.url, true);
    xhr.responseType = opts.responseType || "text";
    if (opts.headers) {
      for (const [key, value] of Object.entries(opts.headers)) xhr.setRequestHeader(key, value);
    }
    xhr.onload = () => {
      console.info("[attachment-debug] upload:xhr:load", { label: opts.debugLabel, status: xhr.status, elapsedMs: Date.now() - startedAt });
      const responseHeaders: Record<string, string> = {};
      try {
        const rawHeaders = typeof xhr.getAllResponseHeaders === "function" ? xhr.getAllResponseHeaders() : "";
        for (const line of rawHeaders.split(/\r?\n/)) {
          const index = line.indexOf(":");
          if (index <= 0) continue;
          responseHeaders[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
        }
      } catch {
        // Some minimal XHR implementations do not expose response headers.
      }
      resolve({
        status: xhr.status,
        responseText: typeof xhr.response === "string" ? xhr.response : xhr.responseText,
        responseURL: xhr.responseURL || opts.url,
        responseHeaders,
      });
    };
    xhr.onerror = () => reject(new Error(`Network request failed for ${opts.url}`));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    const startedAt = Date.now();
    if (xhr.upload && opts.onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        console.info("[attachment-debug] upload:xhr:progress", { label: opts.debugLabel, loaded: event.loaded, total: event.total, lengthComputable: event.lengthComputable, elapsedMs: Date.now() - startedAt });
        if (!event.lengthComputable) return;
        opts.onUploadProgress?.(event.loaded, event.total);
      };
    }
    let abortHandler: (() => void) | undefined;
    if (opts.signal) {
      if (opts.signal.aborted) { xhr.abort(); return; }
      abortHandler = () => xhr.abort();
      opts.signal.addEventListener('abort', abortHandler, { once: true });
    }
    xhr.onloadend = () => {
      if (opts.signal && abortHandler) opts.signal.removeEventListener('abort', abortHandler);
    };
    xhr.send(opts.body ?? null);
  });
}

async function parseJsonSafe(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function discoverNip96Server(baseUrl: string, depth = 0): Promise<Nip96ServerInfo> {
  if (depth > 3) throw new Error("NIP-96 discovery redirected too many times.");
  const normalizedBase = normalizeFileServerUrl(baseUrl) || DEFAULT_FILE_STORAGE_SERVER;
  if (!normalizedBase) {
    throw new Error("Invalid file storage server URL.");
  }
  const discoveryUrl = `${normalizedBase}${NIP96_DISCOVERY_PATH}`;
  const res = await fetch(discoveryUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Failed to load NIP-96 info (${res.status})`);
  }
  const json = await parseJsonSafe(res);
  if (!json || typeof json !== "object") {
    throw new Error("Invalid NIP-96 discovery response");
  }
  const apiRaw = typeof (json as any).api_url === "string" ? (json as any).api_url.trim() : "";
  const delegatedTo =
    typeof (json as any).delegated_to_url === "string" ? (json as any).delegated_to_url.trim() : "";
  if (!apiRaw && delegatedTo) {
    return discoverNip96Server(delegatedTo, depth + 1);
  }
  if (!apiRaw) {
    throw new Error("NIP-96 api_url missing from discovery response");
  }
  const apiUrl = new URL(apiRaw, normalizedBase).toString();
  return { baseUrl: normalizedBase, apiUrl, delegatedTo: delegatedTo || undefined };
}

function buildNip98AuthHeader(url: string, method: string, payloadHashHex: string, signer: string | Uint8Array): string {
  const signerBytes =
    typeof signer === "string"
      ? hexToBytes(signer.startsWith("0x") ? signer.slice(2) : signer)
      : signer;
  const template: EventTemplate = {
    kind: 27235,
    content: "",
    tags: [
      ["u", url],
      ["method", method.toUpperCase()],
      ["payload", payloadHashHex],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
  const event = finalizeEvent(template, signerBytes);
  const encoded = encodeBase64(JSON.stringify(event));
  return `Nostr ${encoded}`;
}

async function pollProcessingUrl(url: string, headers: HeadersInit, timeoutMs: number): Promise<{ status: number; data: any }> {
  const started = Date.now();
  let delay = 750;
  let lastData: any = null;
  const absoluteUrl = (() => {
    try {
      return new URL(url).toString();
    } catch {
      return url;
    }
  })();

  while (Date.now() - started < timeoutMs) {
    const res = await fetch(absoluteUrl, { headers });
    const data = await parseJsonSafe(res);
    lastData = data;
    if (res.status !== 202) {
      return { status: res.status, data };
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 3200);
  }
  return { status: 202, data: lastData };
}

function extractUrlFromResponse(data: any): string | null {
  const nip94 = data?.nip94_event || data?.nip94;
  if (nip94 && Array.isArray(nip94.tags)) {
    const urlTag = (nip94.tags as unknown[]).find(
      (t): t is string[] => Array.isArray(t) && typeof t[0] === "string" && t[0] === "url" && typeof t[1] === "string",
    );
    if (urlTag && urlTag[1]?.trim()) {
      return urlTag[1].trim();
    }
  }
  if (typeof data?.url === "string" && data.url.trim()) {
    return data.url.trim();
  }
  return null;
}

export async function uploadFileToNip96(options: {
  serverUrl: string;
  file: Blob;
  filename?: string;
  contentType?: string;
  signer: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  onPhaseChange?: (phase: "uploading" | "processing") => void;
}): Promise<Nip96UploadResult> {
  const info = await discoverNip96Server(options.serverUrl);
  console.info("[attachment-debug] upload:nip96:start", {
    server: info.baseUrl,
    apiUrl: info.apiUrl,
    filename: options.filename,
    contentType: options.contentType || options.file.type || "application/octet-stream",
    blobBytes: options.file.size,
  });

  const uploadFile =
    options.file instanceof File
      ? options.file
      : new File([options.file], options.filename || "upload.bin", {
          type: options.contentType || options.file.type || "application/octet-stream",
        });
  const payloadHash = bytesToHex(sha256(new Uint8Array(await uploadFile.arrayBuffer())));
  const headers: HeadersInit = {
    Authorization: buildNip98AuthHeader(info.apiUrl, "POST", payloadHash, options.signer),
  };

  const form = new FormData();
  form.append("file", uploadFile);
  if (options.filename) {
    form.append("filename", options.filename);
  }
  form.append("content_type", options.contentType || uploadFile.type || "application/octet-stream");
  form.append("size", String(uploadFile.size));

  options.onPhaseChange?.("uploading");
  const requestStartedAt = Date.now();
  const res = await xhrRequest({
    url: info.apiUrl,
    method: "POST",
    headers: headers as Record<string, string>,
    body: form,
    signal: options.signal,
    onUploadProgress: options.onProgress,
    debugLabel: `nip96:${options.filename || "upload"}` ,
  });
  console.info("[attachment-debug] upload:nip96:request-complete", { filename: options.filename, elapsedMs: Date.now() - requestStartedAt, status: res.status });

  let data = (() => { try { return JSON.parse(res.responseText || "null"); } catch { return null; } })();
  console.info("[attachment-debug] upload:nip96:response", { status: res.status, ok: res.status >= 200 && res.status < 300, data: flattenDebugError(data) });
  if (res.status === 202 && data?.processing_url) {
    options.onPhaseChange?.("processing");
    const processingUrl = new URL(data.processing_url, info.apiUrl).toString();
    const poll = await pollProcessingUrl(processingUrl, headers, options.timeoutMs ?? 12000);
    data = poll.data ?? data;
    if (poll.status !== 200 && poll.status !== 201) {
      throw new Error(data?.message || "Upload is still processing, please try again.");
    }
  } else if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(data?.message || `Upload failed (${res.status})`);
  }

  const pictureUrl = extractUrlFromResponse(data);
  if (!pictureUrl) {
    throw new Error("Upload response did not include a file url.");
  }

  const nip94 = (data?.nip94_event || data?.nip94) as NostrEvent | null | undefined;
  console.info("[attachment-debug] upload:nip96:complete", { url: pictureUrl, response: flattenDebugError(data) });

  return {
    url: pictureUrl,
    nip94: nip94 ?? null,
    response: data,
    info,
  };
}

// ── Blossom (BUD-01/BUD-11) ──────────────────────────────────────────────────

export class BlossomUploadError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BlossomUploadError";
    this.status = status;
    this.code = code;
    this.reason = message;
  }
}

export type BlossomUploadResult = {
  url: string;
  nip94: null;
  sha256: string;
  serverUrl: string;
  retention?: BlossomRetention;
  protectedUntil?: number;
};

type BlossomRetentionRequest = "protected" | "prefer-protected" | "standard";

function headerValue(headers: Record<string, string>, name: string): string {
  return headers[name.toLowerCase()]?.trim() || "";
}

async function uploadBlossomAttempt(options: {
  serverUrl: string;
  file: Blob;
  fileHash: string;
  signer: string | Uint8Array;
  contentType: string;
  retention: BlossomRetentionRequest;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  onPhaseChange?: (phase: "uploading" | "processing") => void;
  filename?: string;
}, retry = true): Promise<BlossomUploadResult> {
  const uploadUrl = `${normalizeFileServerUrl(options.serverUrl) || options.serverUrl}/upload`;
  const res = await xhrRequest({
    url: uploadUrl,
    method: "PUT",
    headers: {
      "Content-Type": options.contentType,
      "X-SHA-256": options.fileHash,
      Authorization: buildBud11AuthHeader({
        signer: options.signer,
        action: "upload",
        sha256: options.fileHash,
        serverUrl: options.serverUrl,
        retention: options.retention === "standard" ? undefined : options.retention,
      }),
    },
    body: options.file,
    signal: options.signal,
    onUploadProgress: options.onProgress,
    debugLabel: `blossom:${options.filename || "upload"}`,
  });
  const data = (() => { try { return JSON.parse(res.responseText || "null"); } catch { return null; } })();
  if (!(res.status >= 200 && res.status < 300)) {
    const storageError = headerValue(res.responseHeaders, "x-blossom-storage-error");
    const reason = headerValue(res.responseHeaders, "x-reason")
      || (typeof data?.message === "string" ? data.message : "")
      || (typeof data?.error === "string" ? data.error : "")
      || `Blossom upload failed (${res.status})`;
    if (retry && storageError === "upload_retry") {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return uploadBlossomAttempt(options, false);
    }
    throw new BlossomUploadError(res.status, storageError || `http_${res.status}`, reason);
  }
  const url = typeof data?.url === "string" ? data.url.trim() : "";
  if (!url) throw new BlossomUploadError(res.status, "invalid_response", "Blossom upload response did not include a url.");
  const retentionHeader = headerValue(res.responseHeaders, "x-blossom-retention").toLowerCase();
  const retention: BlossomRetention | undefined =
    retentionHeader === "protected" || retentionHeader === "standard"
      ? retentionHeader
      : options.retention === "standard"
        ? "standard"
        : undefined;
  const protectedUntilRaw = Number(headerValue(res.responseHeaders, "x-blossom-protected-until"));
  return {
    url,
    nip94: null,
    sha256: options.fileHash,
    serverUrl: options.serverUrl,
    ...(retention ? { retention } : {}),
    ...(Number.isFinite(protectedUntilRaw) && protectedUntilRaw > 0 ? { protectedUntil: protectedUntilRaw } : {}),
  };
}

function protectedQuotaMessage(serverUrl: string): string {
  return `Protected storage is full for this account on ${serverUrl}. Enable automatic standard-storage fallback in Settings → Storage to upload additional files.`;
}

export async function uploadFileToBlossom(options: {
  serverUrl: string;
  file: Blob;
  filename?: string;
  contentType?: string;
  signer: string | Uint8Array;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  onPhaseChange?: (phase: "uploading" | "processing") => void;
}): Promise<BlossomUploadResult> {
  if (!options.signer) throw new Error("signer is required for Blossom uploads");
  const signerKey = typeof options.signer === "string"
    ? options.signer.startsWith("0x") ? options.signer.slice(2) : options.signer
    : bytesToHex(options.signer);
  const accountPubkey = getPublicKey(hexToBytes(signerKey));
  const bytes = new Uint8Array(await options.file.arrayBuffer());
  const fileHash = bytesToHex(sha256(bytes));
  const contentType = options.contentType || options.file.type || "application/octet-stream";
  console.info("[attachment-debug] upload:blossom:start", {
    server: options.serverUrl,
    filename: options.filename,
    contentType,
    blobBytes: options.file.size,
  });

  let preference = getBlossomFallbackPreference(accountPubkey, options.serverUrl);
  let summary = null as Awaited<ReturnType<typeof getBlossomStorageSummary>> | null;
  const loadSummary = async () => {
    if (summary) return summary;
    try {
      summary = await getBlossomStorageSummary(options.serverUrl, options.signer, options.signal);
    } catch {
      summary = null;
    }
    return summary;
  };

  let retention: BlossomRetentionRequest = "protected";
  if (preference?.automaticFallback) {
    retention = "prefer-protected";
    const currentSummary = await loadSummary();
    const currentTerms = currentSummary ? blossomTermsFingerprint(currentSummary) : null;
    if (preference.termsFingerprint && currentTerms && currentTerms !== preference.termsFingerprint) {
      const accepted = await requestBlossomFallbackConsent({
        accountPubkey,
        serverUrl: options.serverUrl,
        termsChanged: true,
        reason: "The server's standard-retention rules changed.",
      });
      setBlossomFallbackPreference(accountPubkey, options.serverUrl, {
        automaticFallback: accepted,
        termsFingerprint: accepted ? currentTerms : preference.termsFingerprint,
      });
      preference = getBlossomFallbackPreference(accountPubkey, options.serverUrl);
      if (!accepted) retention = "protected";
    } else if (currentTerms && !preference.termsFingerprint) {
      setBlossomFallbackPreference(accountPubkey, options.serverUrl, {
        automaticFallback: true,
        termsFingerprint: currentTerms,
      });
      preference = getBlossomFallbackPreference(accountPubkey, options.serverUrl);
    }
  }

  options.onPhaseChange?.("uploading");
  const attempt = (requested: BlossomRetentionRequest) => uploadBlossomAttempt({
    serverUrl: options.serverUrl,
    file: options.file,
    fileHash,
    signer: options.signer,
    contentType,
    retention: requested,
    signal: options.signal,
    onProgress: options.onProgress,
    onPhaseChange: options.onPhaseChange,
    filename: options.filename,
  });

  let result: BlossomUploadResult;
  try {
    result = await attempt(retention);
  } catch (error) {
    if (!(error instanceof BlossomUploadError) || error.code !== "protected_quota_exceeded") throw error;
    if (preference?.automaticFallback && retention === "prefer-protected") throw error;
    preference = getBlossomFallbackPreference(accountPubkey, options.serverUrl);
    if (preference?.automaticFallback) {
      result = await attempt("prefer-protected");
    } else {
      if (preference && !preference.automaticFallback) throw new Error(protectedQuotaMessage(options.serverUrl));
      const currentSummary = await loadSummary();
      const currentTerms = currentSummary ? blossomTermsFingerprint(currentSummary) : null;
      const accepted = await requestBlossomFallbackConsent({
        accountPubkey,
        serverUrl: options.serverUrl,
        termsChanged: false,
        reason: error.reason,
      });
      setBlossomFallbackPreference(accountPubkey, options.serverUrl, {
        automaticFallback: accepted,
        termsFingerprint: accepted ? currentTerms : preference?.termsFingerprint ?? null,
      });
      if (!accepted) throw new Error(protectedQuotaMessage(options.serverUrl));
      result = await attempt("prefer-protected");
    }
  }

  options.onPhaseChange?.("processing");
  console.info("[attachment-debug] upload:blossom:complete", {
    url: result.url,
    retention: result.retention,
    protectedUntil: result.protectedUntil,
  });
  return result;
}


// ── Originless ────────────────────────────────────────────────────────────────

export async function uploadFileToOriginless(options: {
  serverUrl: string;
  file: Blob;
  filename?: string;
  signal?: AbortSignal;
}): Promise<{ url: string; nip94: null }> {
  const base = normalizeFileServerUrl(options.serverUrl) || options.serverUrl;
  const uploadUrl = fixedFileUploadURL(base, "originless");
  const attempts: Array<{ label: string; init: RequestInit }> = [];

  const form = new FormData();
  form.append("file", options.file, options.filename || "file");
  attempts.push({
    label: "multipart",
    init: {
      method: "POST",
      body: form,
      signal: options.signal,
      mode: "cors",
      credentials: "omit",
    },
  });

  attempts.push({
    label: "raw-octet-stream",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: options.file,
      signal: options.signal,
      mode: "cors",
      credentials: "omit",
    },
  });

  let lastError: unknown = null;
  for (const attempt of attempts) {
    console.info("[attachment-debug] upload:originless:start", {
      server: options.serverUrl,
      uploadUrl,
      filename: options.filename,
      blobBytes: options.file.size,
      blobType: options.file.type || "application/octet-stream",
      attempt: attempt.label,
      headers: attempt.init.headers ? Object.keys(attempt.init.headers as Record<string, string>) : [],
      mode: attempt.init.mode,
      credentials: attempt.init.credentials,
    });
    try {
      const res = await fetch(uploadUrl, attempt.init);
      const data = await parseJsonSafe(res);
      console.info("[attachment-debug] upload:originless:response", {
        attempt: attempt.label,
        status: res.status,
        ok: res.ok,
        finalUrl: res.url,
        data: flattenDebugError(data),
      });
      if (!res.ok) throw new Error(data?.message || `Originless upload failed (${res.status})`);
      const url = resolveOriginlessUploadURL(base, data);
      if (!url) throw new Error(`Originless upload response did not include a url. Response: ${JSON.stringify(flattenDebugError(data))}`);
      return { url, nip94: null };
    } catch (err) {
      lastError = err;
      console.info("[attachment-debug] upload:originless:error", {
        attempt: attempt.label,
        server: options.serverUrl,
        uploadUrl,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      });
      if (!(err instanceof TypeError)) {
        throw err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Originless upload failed");
}

// ── Unified dispatcher ────────────────────────────────────────────────────────

export type UploadFileOptions = {
  serverEntry: FileServerEntry;
  file: Blob;
  filename?: string;
  contentType?: string;
  signer?: string | Uint8Array;
  signal?: AbortSignal;
  debugMeta?: Record<string, unknown>;
  onProgress?: (loaded: number, total: number) => void;
  onPhaseChange?: (phase: "uploading" | "processing") => void;
};

export async function uploadFile(options: UploadFileOptions): Promise<{ url: string; nip94: NostrEvent | null; sha256?: string; serverUrl?: string; retention?: BlossomRetention; protectedUntil?: number }> {
  const { serverEntry, file, filename, contentType, signer, signal, debugMeta, onProgress, onPhaseChange } = options;
  console.info("[attachment-debug] upload:dispatch", {
    serverType: serverEntry.type,
    serverUrl: serverEntry.url,
    filename,
    contentType: contentType || file.type || "application/octet-stream",
    blobBytes: file.size,
    debugMeta,
  });
  if (serverEntry.type === "blossom") {
    if (!signer) throw new Error("signer is required for Blossom uploads");
    const result = await uploadFileToBlossom({ serverUrl: serverEntry.url, file, filename, contentType, signer, signal, onProgress, onPhaseChange });
    return { ...result, url: secureUploadedFileURL(serverEntry.url, result.url) };
  }
  if (serverEntry.type === "originless") {
    const result = await uploadFileToOriginless({ serverUrl: serverEntry.url, file, filename, signal });
    return { ...result, url: secureUploadedFileURL(serverEntry.url, result.url) };
  }
  // Default: NIP-96
  if (!signer) throw new Error("signer is required for NIP-96 uploads");
  const result = await uploadFileToNip96({ serverUrl: serverEntry.url, file, filename, contentType, signer, signal, onProgress, onPhaseChange });
  return { url: secureUploadedFileURL(serverEntry.url, result.url), nip94: result.nip94 ?? null };
}

export const uploadAvatarToNip96 = uploadFileToNip96;
export const uploadAvatarToBlossom = uploadFileToBlossom;
export const uploadAvatarToOriginless = uploadFileToOriginless;
export const uploadAvatar = uploadFile;
export type UploadAvatarOptions = UploadFileOptions;
