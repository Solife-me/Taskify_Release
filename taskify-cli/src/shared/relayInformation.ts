import { buildNip11Url } from "taskify-runtime-nostr";
import { sanitizeRemote } from "./displaySafe.js";
import { cliRelayInfoCache } from "./relaySettings.js";

/** What a relay's NIP-11 document says about access, plus what this client has learned. */
export type RelayInformation = {
  url: string;
  /** The NIP-11 document was served. */
  nip11: boolean;
  name?: string;
  software?: string;
  version?: string;
  supportedNips: number[];
  /** NIP-42: the relay requires clients to authenticate. */
  authRequired: boolean;
  paymentRequired: boolean;
  restrictedWrites: boolean;
  /** NIP-13 difficulty the relay advertises. */
  minPowDifficulty: number;
  /** NIP-13 difficulty learned from this relay's `pow:` rejections. */
  learnedPowDifficulty: number;
  error?: string;
};

function nonNegativeInteger(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.ceil(num) : 0;
}

export async function fetchRelayInformation(url: string, timeoutMs = 5000): Promise<RelayInformation> {
  const learnedPowDifficulty = cliRelayInfoCache().learnedProofOfWork(url);
  const base: RelayInformation = {
    url,
    nip11: false,
    supportedNips: [],
    authRequired: false,
    paymentRequired: false,
    restrictedWrites: false,
    minPowDifficulty: 0,
    learnedPowDifficulty,
  };
  const nip11Url = buildNip11Url(url);
  if (!nip11Url) return { ...base, error: "invalid relay URL" };
  try {
    const response = await fetch(nip11Url, {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ...base, error: `NIP-11 request failed (HTTP ${response.status})` };
    // Relay operators write this document; strip terminal control characters before printing.
    const info = sanitizeRemote(await response.json()) as Record<string, unknown>;
    const limitation = (info.limitation && typeof info.limitation === "object" ? info.limitation : {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined);
    return {
      ...base,
      nip11: true,
      name: text(info.name),
      software: text(info.software),
      version: text(info.version),
      supportedNips: Array.isArray(info.supported_nips)
        ? info.supported_nips.filter((nip): nip is number => Number.isInteger(nip)).slice(0, 200)
        : [],
      authRequired: limitation.auth_required === true,
      paymentRequired: limitation.payment_required === true,
      restrictedWrites: limitation.restricted_writes === true,
      minPowDifficulty: nonNegativeInteger(limitation.min_pow_difficulty),
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
