import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent } from "nostr-tools";
import { deriveNpubCashIdentity } from "./npubCash";

export const SOLIFE_LIGHTNING_ADDRESS_DOMAIN = "solife.me";
export const SOLIFE_DEFAULT_BASE_URL = "https://solife.me";

export type SolifeConfig = {
  domain: string;
  publicUrl: string;
  mintUrl: string;
  customAddressPriceSats: number;
  customAddressInvoiceExpirySeconds?: number;
  lnbitsConfigured?: boolean;
  minSendableSats?: number;
  maxSendableSats?: number;
  defaultNostrRelays?: string[];
  authKind?: number;
};

export type SolifeAddress = {
  handle: string;
  address: string;
  nip05?: string;
  pubkey: string;
  npub?: string;
  relays: string[];
  mintUrl: string;
  mintOverride?: boolean;
};

export type SolifeAccount = {
  pubkey: string;
  npub: string;
  lightningAddress: string;
  lightningAddressMintUrl: string;
  lightningAddressMintOverride: boolean;
  relays: string[];
  addresses: SolifeAddress[];
  addressPurchases: SolifeAddressPurchase[];
  isAdmin?: boolean;
};

export type SolifeAddressPurchase = {
  purchaseId: string;
  handle?: string;
  address: string;
  priceSats: number;
  bolt11: string;
  status: "invoice_issued" | "address_claimed" | "expired" | "error" | string;
  expiresAt?: number;
  createdAt?: number;
  paidAt?: number;
  claimedAt?: number;
  mintUrl?: string;
  error?: string | null;
};

export type SolifeCustomAddressClaim =
  | { kind: "address"; address: SolifeAddress }
  | { kind: "purchase"; purchase: SolifeAddressPurchase };

export type SolifeAddressAvailability = {
  available: boolean;
  handle: string;
  address: string;
  priceSats: number;
  reason?: string;
};

type SolifeApiOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

type SolifeSession = {
  token?: string;
  pubkey: string;
  npub?: string;
  expiresIn?: number;
};

function configuredSolifeBaseUrl(): string {
  const envBase = (import.meta as any)?.env?.VITE_SOLIFE_API_BASE_URL;
  const windowBase =
    typeof window !== "undefined" && typeof (window as any).__TASKIFY_SOLIFE_API_BASE_URL__ === "string"
      ? (window as any).__TASKIFY_SOLIFE_API_BASE_URL__
      : "";
  return resolveSolifeBaseUrl(envBase || windowBase || SOLIFE_DEFAULT_BASE_URL);
}

function resolveSolifeBaseUrl(input: string): string {
  const raw = String(input || "").trim() || SOLIFE_DEFAULT_BASE_URL;
  try {
    return new URL(raw).toString().replace(/\/+$/, "");
  } catch {
    return new URL(`https://${raw}`).toString().replace(/\/+$/, "");
  }
}

async function solifeApi<T>(
  path: string,
  options: SolifeApiOptions & { method?: string; body?: unknown; token?: string; credentials?: RequestCredentials } = {},
): Promise<T> {
  const baseUrl = resolveSolifeBaseUrl(options.baseUrl || configuredSolifeBaseUrl());
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      credentials: options.credentials,
    });
  } catch (error: any) {
    const message = error?.message || String(error);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      throw new Error("Unable to reach solife.me. Check the Solife server URL and CORS origin settings.");
    }
    throw error;
  }

  const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Solife request failed with ${response.status}`);
  }
  return payload as T;
}

export async function fetchSolifeConfig(options: SolifeApiOptions = {}): Promise<SolifeConfig> {
  return solifeApi<SolifeConfig>("/api/config", options);
}

function solifeAuthOptions(options: SolifeApiOptions, session: SolifeSession) {
  return {
    ...options,
    credentials: "include" as RequestCredentials,
    token: session.token,
  };
}

function normalizeSolifeAddressPurchase(value: SolifeAddressPurchase): SolifeAddressPurchase {
  return {
    ...value,
    purchaseId: String(value.purchaseId || ""),
    handle: typeof value.handle === "string" ? value.handle : undefined,
    address: String(value.address || "").trim().toLowerCase(),
    priceSats: Math.max(0, Math.floor(Number(value.priceSats) || 0)),
    bolt11: typeof value.bolt11 === "string" ? value.bolt11 : "",
    status: typeof value.status === "string" ? value.status : "",
    expiresAt: Number.isFinite(Number(value.expiresAt)) ? Number(value.expiresAt) : undefined,
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : undefined,
    paidAt: Number.isFinite(Number(value.paidAt)) ? Number(value.paidAt) : undefined,
    claimedAt: Number.isFinite(Number(value.claimedAt)) ? Number(value.claimedAt) : undefined,
    mintUrl: typeof value.mintUrl === "string" ? value.mintUrl : undefined,
    error: typeof value.error === "string" ? value.error : value.error ?? null,
  };
}

export function isSolifeAddressPurchase(value: unknown): value is SolifeAddressPurchase {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.purchaseId === "string" && typeof obj.address === "string";
}

function normalizeSolifeAccount(account: SolifeAccount, config: SolifeConfig): SolifeAccount {
  const addresses = Array.isArray(account.addresses) ? account.addresses : [];
  const addressPurchases = Array.isArray(account.addressPurchases)
    ? account.addressPurchases.map(normalizeSolifeAddressPurchase)
    : [];
  return {
    ...account,
    lightningAddress: typeof account.lightningAddress === "string" ? account.lightningAddress : "",
    lightningAddressMintUrl:
      typeof account.lightningAddressMintUrl === "string" && account.lightningAddressMintUrl.trim()
        ? account.lightningAddressMintUrl
        : config.mintUrl,
    lightningAddressMintOverride: Boolean(account.lightningAddressMintOverride),
    relays: Array.isArray(account.relays) ? account.relays : [],
    addresses,
    addressPurchases,
  };
}

export async function createSolifeSession(secretKey: string, options: SolifeApiOptions = {}) {
  const config = await fetchSolifeConfig(options);
  const identity = deriveNpubCashIdentity(secretKey, {
    domain: config.domain || SOLIFE_LIGHTNING_ADDRESS_DOMAIN,
  });
  const challenge = await solifeApi<{
    challenge: string;
    message: string;
    kind: number;
  }>("/api/auth/challenge", {
    ...options,
    method: "POST",
    credentials: "include",
    body: { pubkey: identity.pubkey },
  });
  const event = finalizeEvent(
    {
      kind: challenge.kind || config.authKind || 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: challenge.message || `Sign in to ${config.domain}: ${challenge.challenge}`,
      tags: [
        ["challenge", challenge.challenge],
        ["domain", config.domain || SOLIFE_LIGHTNING_ADDRESS_DOMAIN],
      ],
    },
    hexToBytes(identity.secretKey),
  );
  const session = await solifeApi<SolifeSession>("/api/auth/verify", {
    ...options,
    method: "POST",
    credentials: "include",
    body: { pubkey: identity.pubkey, challenge: challenge.challenge, event },
  });
  return { config, identity, session };
}

export async function claimSolifeCustomAddress(
  secretKey: string,
  request: {
    handle: string;
    token?: string;
    relays?: string[];
    mintUrl?: string | null;
  },
  options: SolifeApiOptions = {},
): Promise<{ config: SolifeConfig; claim: SolifeCustomAddressClaim }> {
  const { config, session } = await createSolifeSession(secretKey, options);
  const response = await solifeApi<SolifeAddress | SolifeAddressPurchase>("/api/addresses", {
    ...solifeAuthOptions(options, session),
    method: "POST",
    body: {
      handle: request.handle,
      ...(request.token ? { token: request.token } : {}),
      relays: request.relays ?? [],
      mintUrl: request.mintUrl || undefined,
    },
  });
  if (isSolifeAddressPurchase(response)) {
    return { config, claim: { kind: "purchase", purchase: normalizeSolifeAddressPurchase(response) } };
  }
  return { config, claim: { kind: "address", address: response } };
}

export async function verifySolifeAddressPurchase(
  secretKey: string,
  purchaseId: string,
  options: SolifeApiOptions = {},
): Promise<{ config: SolifeConfig; purchase: SolifeAddressPurchase }> {
  const normalizedPurchaseId = purchaseId.trim();
  if (!normalizedPurchaseId) throw new Error("Missing Solife address purchase id.");
  const { config, session } = await createSolifeSession(secretKey, options);
  const purchase = await solifeApi<SolifeAddressPurchase>(
    `/api/address-purchases/${encodeURIComponent(normalizedPurchaseId)}/verify`,
    {
      ...solifeAuthOptions(options, session),
      method: "POST",
    },
  );
  return { config, purchase: normalizeSolifeAddressPurchase(purchase) };
}

export async function fetchSolifeAddressAvailability(
  handle: string,
  options: SolifeApiOptions = {},
): Promise<SolifeAddressAvailability> {
  const normalizedHandle = handle.trim().toLowerCase();
  const params = new URLSearchParams({ handle: normalizedHandle });
  return solifeApi<SolifeAddressAvailability>(`/api/addresses/availability?${params.toString()}`, options);
}

export async function fetchSolifeAccount(
  secretKey: string,
  options: SolifeApiOptions = {},
): Promise<{ config: SolifeConfig; account: SolifeAccount }> {
  const { config, session } = await createSolifeSession(secretKey, options);
  const account = await solifeApi<SolifeAccount>("/api/me", {
    ...solifeAuthOptions(options, session),
  });
  return { config, account: normalizeSolifeAccount(account, config) };
}

export async function updateSolifeLightningAddressMint(
  secretKey: string,
  requestOrMintUrl: string | null | { handle: string; mintUrl?: string | null },
  options: SolifeApiOptions = {},
): Promise<{ config: SolifeConfig; mintUrl: string; mintOverride: boolean; address?: SolifeAddress }> {
  const { config, session } = await createSolifeSession(secretKey, options);
  if (requestOrMintUrl && typeof requestOrMintUrl === "object") {
    const handle = requestOrMintUrl.handle.trim().toLowerCase();
    if (!handle) throw new Error("Missing Solife address handle.");
    const address = await solifeApi<SolifeAddress>(`/api/addresses/${encodeURIComponent(handle)}`, {
      ...solifeAuthOptions(options, session),
      method: "PATCH",
      body: { mintUrl: requestOrMintUrl.mintUrl || "" },
    });
    return {
      config,
      mintUrl: address.mintUrl,
      mintOverride: Boolean(address.mintOverride),
      address,
    };
  }

  const result = await solifeApi<{ mintUrl: string; mintOverride: boolean }>("/api/me/mint", {
    ...solifeAuthOptions(options, session),
    method: "PATCH",
    body: { mintUrl: requestOrMintUrl },
  });
  return { config, mintUrl: result.mintUrl, mintOverride: result.mintOverride };
}
