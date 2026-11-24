import { kvStorage } from "../storage/kvStorage";
import { blossomServerKey } from "./blossomInventoryMatch";

const LS_BLOSSOM_FALLBACK_PREFERENCES = "taskify_blossom_fallback_preferences_v1";

export type BlossomFallbackPreference = {
  automaticFallback: boolean;
  termsFingerprint: string | null;
  decidedAt: number;
};

export const DEFAULT_BLOSSOM_FALLBACK_PREFERENCE: BlossomFallbackPreference = {
  automaticFallback: true,
  termsFingerprint: null,
  decidedAt: 0,
};

type PreferenceStore = Record<string, BlossomFallbackPreference>;

function preferenceKey(pubkey: string, serverUrl: string): string {
  return `${pubkey.trim().toLowerCase()}::${blossomServerKey(serverUrl)}`;
}

function loadStore(): PreferenceStore {
  try {
    const parsed = JSON.parse(kvStorage.getItem(LS_BLOSSOM_FALLBACK_PREFERENCES) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTermsFingerprint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const { protectionSeconds, standardRules } = JSON.parse(value);
    return JSON.stringify({ protectionSeconds, standardRules });
  } catch {
    return value;
  }
}

export function getBlossomFallbackPreference(pubkey: string, serverUrl: string): BlossomFallbackPreference | null {
  if (!pubkey.trim() || !serverUrl.trim()) return null;
  const value = loadStore()[preferenceKey(pubkey, serverUrl)];
  if (!value || typeof value !== "object" || typeof value.automaticFallback !== "boolean") {
    return { ...DEFAULT_BLOSSOM_FALLBACK_PREFERENCE };
  }
  return {
    automaticFallback: value.automaticFallback,
    termsFingerprint: normalizeTermsFingerprint(value.termsFingerprint),
    decidedAt: typeof value.decidedAt === "number" ? value.decidedAt : 0,
  };
}

export function setBlossomFallbackPreference(
  pubkey: string,
  serverUrl: string,
  preference: Omit<BlossomFallbackPreference, "decidedAt"> & { decidedAt?: number },
): void {
  if (!pubkey.trim() || !serverUrl.trim()) return;
  const store = loadStore();
  store[preferenceKey(pubkey, serverUrl)] = {
    automaticFallback: preference.automaticFallback,
    termsFingerprint: preference.termsFingerprint || null,
    decidedAt: preference.decidedAt ?? Date.now(),
  };
  kvStorage.setItem(LS_BLOSSOM_FALLBACK_PREFERENCES, JSON.stringify(store));
}

export type BlossomFallbackConsentRequest = {
  requestId: string;
  accountPubkey: string;
  serverUrl: string;
  termsChanged: boolean;
  reason?: string;
  termsFingerprint: string;
};

export type BlossomFallbackConsentResponse = {
  requestId: string;
  accepted: boolean;
};

const CONSENT_REQUEST_EVENT = "taskify:blossom-fallback-consent-request";
const CONSENT_RESPONSE_EVENT = "taskify:blossom-fallback-consent-response";
let consentQueue: Promise<unknown> = Promise.resolve();

/**
 * Asks the mounted consent host. The answer is remembered per account and server.
 * No browser host means uploads fail closed rather than silently using standard retention.
 */
export function requestBlossomFallbackConsent(
  request: Omit<BlossomFallbackConsentRequest, "requestId">,
): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  const ask = () => new Promise<boolean>((resolve) => {
    const requestId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const timeout = window.setTimeout(() => finish(false), 120_000);
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener(CONSENT_RESPONSE_EVENT, onResponse as EventListener);
      resolve(accepted);
    };
    const onResponse = (event: Event) => {
      const detail = (event as CustomEvent<BlossomFallbackConsentResponse>).detail;
      if (detail?.requestId === requestId) finish(detail.accepted === true);
    };
    window.addEventListener(CONSENT_RESPONSE_EVENT, onResponse as EventListener, { once: false });
    window.dispatchEvent(new CustomEvent<BlossomFallbackConsentRequest>(CONSENT_REQUEST_EVENT, {
      detail: { ...request, requestId },
    }));
  });
  const decide = async () => {
    const preference = getBlossomFallbackPreference(request.accountPubkey, request.serverUrl);
    if (preference?.automaticFallback === false) return false;
    if (preference?.termsFingerprint === request.termsFingerprint) return true;
    const automaticFallback = await ask();
    setBlossomFallbackPreference(request.accountPubkey, request.serverUrl, {
      automaticFallback,
      termsFingerprint: request.termsFingerprint,
    });
    return automaticFallback;
  };
  const next = consentQueue.then(decide, decide);
  consentQueue = next.then(() => undefined, () => undefined);
  return next;
}

export function listenForBlossomFallbackConsent(
  listener: (request: BlossomFallbackConsentRequest) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<BlossomFallbackConsentRequest>).detail;
    if (detail?.requestId) listener(detail);
  };
  window.addEventListener(CONSENT_REQUEST_EVENT, handler as EventListener);
  return () => window.removeEventListener(CONSENT_REQUEST_EVENT, handler as EventListener);
}

export function respondToBlossomFallbackConsent(response: BlossomFallbackConsentResponse): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<BlossomFallbackConsentResponse>(CONSENT_RESPONSE_EVENT, {
    detail: response,
  }));
}
