import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, getPublicKey, nip19, type EventTemplate } from "nostr-tools";

const NPUB_CASH_DEFAULT_DOMAIN = "npub.cash";
const NPUB_CASH_API_PATH = "/api/v1";

export class NpubCashError extends Error {
  status?: number;
  raw?: unknown;

  constructor(message: string, options: { status?: number; raw?: unknown } = {}) {
    super(message);
    this.name = "NpubCashError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = options.status;
    this.raw = options.raw;
  }
}

export type NpubCashIdentity = {
  secretKey: string;
  pubkey: string;
  npub: string;
  address: string;
};

export type NpubCashClaimResult = {
  tokens: string[];
  status: number;
  raw: unknown;
  balance: number;
  sourceUrl: string;
};

export type NpubCashRequestOptions = {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  baseUrl?: string;
  domain?: string;
};

function encodeBase64(data: string): string {
  if (typeof btoa === "function") {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(data);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }
  const globalBuffer = (globalThis as {
    Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } };
  }).Buffer;
  if (globalBuffer) {
    return globalBuffer.from(data, "utf8").toString("base64");
  }
  throw new Error("Base64 encoding unavailable");
}

function normalizeSecretKey(secretKey: string): string {
  const trimmed = secretKey.trim();
  if (!trimmed) {
    throw new Error("Missing Nostr secret key");
  }
  if (trimmed.startsWith("nsec")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== "nsec" || !decoded.data) {
        throw new Error("Invalid nsec key");
      }
      if (typeof decoded.data === "string") {
        return decoded.data;
      }
      if (decoded.data instanceof Uint8Array) {
        return bytesToHex(decoded.data);
      }
      if (Array.isArray(decoded.data)) {
        return bytesToHex(Uint8Array.from(decoded.data));
      }
      throw new Error("Unsupported nsec payload");
    } catch (err: any) {
      throw new Error(err?.message || "Invalid nsec key");
    }
  }
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new Error("Invalid Nostr secret key");
  }
  return trimmed.toLowerCase();
}

function sanitizeDomain(domain: string): string {
  const trimmed = domain.trim();
  if (!trimmed) return NPUB_CASH_DEFAULT_DOMAIN;
  return trimmed.replace(/^https?:\/\//i, "").split("/")[0]?.toLowerCase() || NPUB_CASH_DEFAULT_DOMAIN;
}

function tryParseUrl(value: string): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    try {
      return new URL(`https://${value}`);
    } catch {
      return null;
    }
  }
}

function resolveNpubCashConfig(options: NpubCashRequestOptions = {}): { baseUrl: string; domain: string } {
  const explicitBase = options.baseUrl?.trim();
  if (explicitBase) {
    const parsed = tryParseUrl(explicitBase);
    if (parsed) {
      const normalizedPath = parsed.pathname.replace(/\/+$/, "");
      const baseUrl = `${parsed.origin}${normalizedPath}`;
      return { baseUrl, domain: parsed.hostname };
    }
    const sanitized = sanitizeDomain(explicitBase);
    return { baseUrl: `https://${sanitized}`, domain: sanitized };
  }

  const domainInput = options.domain?.trim();
  if (domainInput) {
    const parsed = tryParseUrl(domainInput);
    if (parsed) {
      const normalizedPath = parsed.pathname.replace(/\/+$/, "");
      const baseUrl = `${parsed.origin}${normalizedPath}`;
      return { baseUrl, domain: parsed.hostname };
    }
    const sanitized = sanitizeDomain(domainInput);
    return { baseUrl: `https://${sanitized}`, domain: sanitized };
  }

  return { baseUrl: `https://${NPUB_CASH_DEFAULT_DOMAIN}`, domain: NPUB_CASH_DEFAULT_DOMAIN };
}

function ensureApiBase(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/api\/v1$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}${NPUB_CASH_API_PATH}`;
}

export function deriveNpubCashIdentity(secretKey: string, options: { domain?: string } = {}): NpubCashIdentity {
  const normalizedSecret = normalizeSecretKey(secretKey);
  const pubkey = getPublicKey(normalizedSecret);
  const npub = nip19.npubEncode(pubkey);
  const domain = sanitizeDomain(options.domain || NPUB_CASH_DEFAULT_DOMAIN);
  return {
    secretKey: normalizedSecret,
    pubkey,
    npub,
    address: `${npub}@${domain}`,
  };
}

function buildNip98AuthHeader(url: string, method: string, secretKeyHex: string, body?: string): string {
  const normalizedMethod = method?.toUpperCase?.() || "GET";
  const template: EventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", normalizedMethod],
    ],
    content: body ?? "",
  };
  const event = finalizeEvent(template, secretKeyHex);
  const payload = JSON.stringify(event);
  return `Nostr ${encodeBase64(payload)}`;
}

function isProbablyJsonString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (
    (first === "{" && last === "}") ||
    (first === "[" && last === "]") ||
    (first === '"' && last === '"')
  );
}

function extractTokensFromString(value: string, seen: Set<string>): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const results: string[] = [];

  if (isProbablyJsonString(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      results.push(...normalizeTokens(parsed, seen));
    } catch {
      // fall through to regex extraction below
    }
  }

  const tokenPattern = /cashu[a-z0-9_-]+/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(trimmed))) {
    const token = match[0];
    if (!seen.has(token)) {
      seen.add(token);
      results.push(token);
    }
  }

  if (!results.length && trimmed.startsWith("cashu")) {
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      results.push(trimmed);
    }
  }

  return results;
}

function normalizeTokens(data: unknown, seen: Set<string> = new Set()): string[] {
  if (!data) return [];
  if (typeof data === "string") {
    return extractTokensFromString(data, seen);
  }
  if (Array.isArray(data)) {
    const nested = data.flatMap((item) => normalizeTokens(item, seen));
    return nested.filter((token) => typeof token === "string" && token.trim().length > 0);
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const collected: string[] = [];
    for (const value of Object.values(obj)) {
      collected.push(...normalizeTokens(value, seen));
    }
    return collected.filter((token) => typeof token === "string" && token.trim().length > 0);
  }
  return [];
}

function uniqueTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

async function readResponseBody(res: Response): Promise<unknown> {
  const contentType = res.headers?.get?.("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

function extractResponseError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const candidates = [obj.error, obj.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (Array.isArray(obj.errors)) {
    for (const entry of obj.errors) {
      if (typeof entry === "string" && entry.trim()) {
        return entry.trim();
      }
    }
  }
  return null;
}

function coerceBalance(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if ("balance" in obj) {
      const nested = coerceBalance(obj.balance);
      if (nested != null) return nested;
    }
    if ("data" in obj) {
      const nested = coerceBalance(obj.data);
      if (nested != null) return nested;
    }
    if ("amount" in obj) {
      const nested = coerceBalance(obj.amount);
      if (nested != null) return nested;
    }
  }
  return null;
}

type BalanceFetchResult = {
  balance: number;
  status: number;
  raw: unknown;
  url: string;
};

type ClaimFetchResult = {
  tokens: string[];
  status: number;
  raw: unknown;
  url: string;
};

async function fetchNpubCashBalance(
  identity: NpubCashIdentity,
  apiBase: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<BalanceFetchResult> {
  const url = `${apiBase}/balance`;
  const res = await fetcher(url, {
    method: "GET",
    headers: {
      Authorization: buildNip98AuthHeader(url, "GET", identity.secretKey),
      Accept: "application/json,text/plain",
    },
    signal,
  });
  const raw = await readResponseBody(res);
  if (!res.ok) {
    const message =
      (typeof raw === "object" && raw && extractResponseError(raw)) ||
      (typeof raw === "string" && raw.trim()) ||
      `npub.cash error ${res.status}`;
    throw new NpubCashError(message, { status: res.status, raw });
  }
  const errorMessage = extractResponseError(raw);
  if (errorMessage) {
    throw new NpubCashError(errorMessage, { status: res.status, raw });
  }
  const balanceValue = coerceBalance(raw);
  const balance = typeof balanceValue === "number" && Number.isFinite(balanceValue) ? balanceValue : 0;
  return { balance, status: res.status, raw, url };
}

async function fetchNpubCashClaim(
  identity: NpubCashIdentity,
  apiBase: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<ClaimFetchResult> {
  const url = `${apiBase}/claim`;
  const res = await fetcher(url, {
    method: "GET",
    headers: {
      Authorization: buildNip98AuthHeader(url, "GET", identity.secretKey),
      Accept: "application/json,text/plain",
    },
    signal,
  });
  const raw = await readResponseBody(res);
  if (!res.ok) {
    const message =
      (typeof raw === "object" && raw && extractResponseError(raw)) ||
      (typeof raw === "string" && raw.trim()) ||
      (res.status === 504
        ? "npub.cash request timed out. Please try again later."
        : res.status === 502
        ? "npub.cash is temporarily unavailable. Please try again soon."
        : `npub.cash error ${res.status}`);
    throw new NpubCashError(message, { status: res.status, raw });
  }
  const errorMessage = extractResponseError(raw);
  if (errorMessage) {
    throw new NpubCashError(errorMessage, { status: res.status, raw });
  }
  const payload = typeof raw === "object" && raw !== null && "data" in (raw as Record<string, unknown>)
    ? (raw as Record<string, unknown>).data
    : raw;
  const tokens = uniqueTokens(normalizeTokens(payload));
  return { tokens, status: res.status, raw, url };
}

export async function claimPendingEcashFromNpubCash(
  secretKey: string,
  options: NpubCashRequestOptions = {},
): Promise<NpubCashClaimResult> {
  const config = resolveNpubCashConfig(options);
  const identity = deriveNpubCashIdentity(secretKey, { domain: config.domain });
  const fetcher = options.fetcher ?? fetch;
  const apiBase = ensureApiBase(config.baseUrl);

  const balanceResult = await fetchNpubCashBalance(identity, apiBase, fetcher, options.signal);
  const safeBalance = Math.max(0, Math.floor(balanceResult.balance));
  if (safeBalance <= 0) {
    return {
      tokens: [],
      status: balanceResult.status,
      raw: balanceResult.raw,
      balance: 0,
      sourceUrl: balanceResult.url,
    };
  }

  const claimResult = await fetchNpubCashClaim(identity, apiBase, fetcher, options.signal);
  return {
    tokens: claimResult.tokens,
    status: claimResult.status,
    raw: { balance: balanceResult.raw, claim: claimResult.raw },
    balance: safeBalance,
    sourceUrl: claimResult.url,
  };
}

export async function acknowledgeNpubCashClaims(
  secretKey: string,
  options: NpubCashRequestOptions = {},
): Promise<boolean> {
  const config = resolveNpubCashConfig(options);
  const identity = deriveNpubCashIdentity(secretKey, { domain: config.domain });
  const fetcher = options.fetcher ?? fetch;
  const apiBase = ensureApiBase(config.baseUrl);
  const url = `${apiBase}/claim`;

  try {
    const res = await fetcher(url, {
      method: "DELETE",
      headers: {
        Authorization: buildNip98AuthHeader(url, "DELETE", identity.secretKey),
      },
      signal: options.signal,
    });

    if (res.ok || res.status === 404 || res.status === 204) {
      return true;
    }
    return false;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw err;
    }
    return false;
  }
}
