export type RelayLimitation = {
  max_subscriptions?: number;
  max_filters?: number;
  max_limit?: number;
  default_limit?: number;
  max_message_length?: number;
  auth_required?: boolean;
  payment_required?: boolean;
  restricted_writes?: boolean;
};

export type RelayInfo = {
  name?: string;
  description?: string;
  pubkey?: string;
  contact?: string;
  supported_nips?: number[];
  software?: string;
  version?: string;
  limitation?: RelayLimitation;
};

export type CachedRelayInfo = {
  fetchedAt: number;
  info: RelayInfo;
  limitation: RelayLimitation;
};

export type RelayLimits = {
  maxLimit: number;
  maxMessageLength: number;
  maxSubscriptions: number;
  authRequired: boolean;
};

export type RelayInfoStorage = {
  getItem: (key: string) => string | null | undefined;
  setItem: (key: string, value: string) => void;
};

type RelayInfoCacheOptions = {
  ttlMs?: number;
  failureTtlMs?: number;
  storage?: RelayInfoStorage;
  storageKey?: string;
  maxEntries?: number;
};

const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_LIMIT = 5000;
const DEFAULT_MAX_MESSAGE_LENGTH = 16384;
const DEFAULT_MAX_SUBSCRIPTIONS = 30;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 64;
const DEFAULT_STORAGE_KEY = "relay-info-cache";

export function normalizeRelayCacheKey(relayUrl: string): string | null {
  try {
    const url = new URL(relayUrl.trim());
    const protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : url.protocol === "ws:" || url.protocol === "http:" ? "http:" : url.protocol;
    return `${protocol}//${url.host}${url.pathname || "/"}`;
  } catch {
    return null;
  }
}

export function buildNip11Url(relayUrl: string): string | null {
  try {
    const url = new URL(relayUrl.trim());
    const protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    return `${protocol}//${url.host}${url.pathname || "/"}`;
  } catch {
    return null;
  }
}

function sanitizeLimit(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.max(1, Math.min(num, DEFAULT_MAX_LIMIT));
}

function sanitizeMessageLength(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MAX_MESSAGE_LENGTH;
  return Math.max(1024, Math.min(num, 4 * DEFAULT_MAX_MESSAGE_LENGTH));
}

function sanitizeSubscriptionCount(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MAX_SUBSCRIPTIONS;
  return Math.max(1, Math.min(num, 100));
}

export class RelayInfoCache {
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly cache = new Map<string, CachedRelayInfo>();
  private readonly failures = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<CachedRelayInfo | null>>();
  private readonly storage?: RelayInfoStorage;
  private readonly storageKey: string;
  private readonly maxEntries: number;

  constructor(options: RelayInfoCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.storage = options.storage;
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.restore();
  }

  private isExpired(entry: CachedRelayInfo): boolean {
    return Date.now() - entry.fetchedAt > this.ttlMs;
  }

  private hasRecentFailure(key: string): boolean {
    const failedAt = this.failures.get(key);
    if (!failedAt) return false;
    if (Date.now() - failedAt <= this.failureTtlMs) return true;
    this.failures.delete(key);
    return false;
  }

  get(relayUrl: string): CachedRelayInfo | null {
    const key = normalizeRelayCacheKey(relayUrl);
    if (!key) return null;
    return this.cache.get(key) || null;
  }

  getAgeMs(relayUrl: string): number | null {
    const cached = this.get(relayUrl);
    if (!cached) return null;
    return Date.now() - cached.fetchedAt;
  }

  getLimits(relayUrls: string[]): RelayLimits {
    let maxLimit: number | undefined;
    let authRequired = false;
    let maxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH;
    let maxSubscriptions = DEFAULT_MAX_SUBSCRIPTIONS;

    for (const url of relayUrls) {
      const cached = this.get(url);
      if (!cached) continue;
      const lim = cached.limitation || {};
      const candidateLimit = sanitizeLimit(lim.max_limit ?? lim.default_limit);
      if (candidateLimit != null) maxLimit = maxLimit == null ? candidateLimit : Math.min(maxLimit, candidateLimit);
      if (lim.auth_required) authRequired = true;
      if (lim.max_message_length) maxMessageLength = Math.min(maxMessageLength, sanitizeMessageLength(lim.max_message_length));
      if (lim.max_subscriptions) maxSubscriptions = Math.min(maxSubscriptions, sanitizeSubscriptionCount(lim.max_subscriptions));
    }

    return { maxLimit: maxLimit ?? DEFAULT_MAX_LIMIT, maxMessageLength, maxSubscriptions, authRequired };
  }

  async prime(relayUrl: string, fetcher: (nip11Url: string) => Promise<RelayInfo | null>): Promise<CachedRelayInfo | null> {
    const key = normalizeRelayCacheKey(relayUrl);
    const nip11Url = buildNip11Url(relayUrl);
    if (!key || !nip11Url) return null;

    const cached = this.cache.get(key);
    if (cached && !this.isExpired(cached)) return cached;
    if (this.hasRecentFailure(key)) return cached ?? null;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const info = await fetcher(nip11Url);
        if (info && typeof info === "object") {
          const normalized = this.normalizeEntry(info);
          this.cache.set(key, normalized);
          this.failures.delete(key);
          this.persist();
          return normalized;
        }
        this.failures.set(key, Date.now());
      } catch {
        this.failures.set(key, Date.now());
      } finally {
        this.inFlight.delete(key);
      }
      return cached ?? null;
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  needsRefresh(relayUrl: string): boolean {
    const key = normalizeRelayCacheKey(relayUrl);
    if (!key) return false;
    if (this.hasRecentFailure(key)) return false;
    const cached = this.cache.get(key);
    if (!cached) return true;
    return this.isExpired(cached);
  }

  private normalizeEntry(info: RelayInfo): CachedRelayInfo {
    const limitation = info.limitation || {};
    const normalizedLimit: RelayLimitation = {
      ...limitation,
      default_limit: sanitizeLimit(limitation.default_limit) ?? DEFAULT_LIMIT,
      max_limit: sanitizeLimit(limitation.max_limit) ?? DEFAULT_MAX_LIMIT,
      max_message_length: sanitizeMessageLength(limitation.max_message_length),
      max_subscriptions: sanitizeSubscriptionCount(limitation.max_subscriptions),
      auth_required: !!limitation.auth_required,
      payment_required: !!limitation.payment_required,
      restricted_writes: !!limitation.restricted_writes,
    };

    return { fetchedAt: Date.now(), info: { ...info, limitation: normalizedLimit }, limitation: normalizedLimit };
  }

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, CachedRelayInfo>;
      if (!parsed || typeof parsed !== "object") return;
      Object.entries(parsed).forEach(([key, value]) => {
        if (!value || typeof value !== "object") return;
        const cached = value as CachedRelayInfo;
        if (cached.fetchedAt && cached.info) this.cache.set(key, cached);
      });
    } catch {
      // noop
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const entries = Array.from(this.cache.entries());
      if (entries.length > this.maxEntries) entries.sort((a, b) => (b[1].fetchedAt || 0) - (a[1].fetchedAt || 0));
      const payload: Record<string, CachedRelayInfo> = {};
      entries.slice(0, this.maxEntries).forEach(([key, value]) => (payload[key] = value));
      this.storage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      // noop
    }
  }
}
