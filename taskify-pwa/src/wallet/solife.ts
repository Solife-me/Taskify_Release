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
};

type SolifeApiOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

type SolifeSession = {
  token: string;
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
  options: SolifeApiOptions & { method?: string; body?: unknown; token?: string } = {},
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
): Promise<{ config: SolifeConfig; address: SolifeAddress }> {
  const { config, session } = await createSolifeSession(secretKey, options);
  const address = await solifeApi<SolifeAddress>("/api/addresses", {
    ...options,
    method: "POST",
    token: session.token,
    body: {
      handle: request.handle,
      token: request.token || "",
      relays: request.relays ?? [],
      mintUrl: request.mintUrl || undefined,
    },
  });
  return { config, address };
}

export async function fetchSolifeAccount(
  secretKey: string,
  options: SolifeApiOptions = {},
): Promise<{ config: SolifeConfig; account: SolifeAccount }> {
  const { config, session } = await createSolifeSession(secretKey, options);
  const account = await solifeApi<SolifeAccount>("/api/me", {
    ...options,
    token: session.token,
  });
  return { config, account };
}

export async function updateSolifeLightningAddressMint(
  secretKey: string,
  mintUrl: string | null,
  options: SolifeApiOptions = {},
): Promise<{ config: SolifeConfig; mintUrl: string; mintOverride: boolean }> {
  const { config, session } = await createSolifeSession(secretKey, options);
  const result = await solifeApi<{ mintUrl: string; mintOverride: boolean }>("/api/me/mint", {
    ...options,
    method: "PATCH",
    token: session.token,
    body: { mintUrl },
  });
  return { config, mintUrl: result.mintUrl, mintOverride: result.mintOverride };
}
