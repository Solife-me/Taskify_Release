import { useEffect, useMemo, useState } from "react";

import { LS_URL_PREVIEW_CACHE } from "../localStorageKeys";

export type UrlPreviewData = {
  url: string;
  finalUrl: string;
  displayUrl: string;
  title?: string;
  description?: string;
  image?: string;
  icon?: string;
  siteName?: string;
};

const DEV_WORKER_DEFAULT = "http://127.0.0.1:8787";
const RAW_WORKER_BASE = (import.meta as any)?.env?.VITE_WORKER_BASE_URL || "";
const STATIC_WORKER_BASE = (() => {
  const base = RAW_WORKER_BASE ? String(RAW_WORKER_BASE).replace(/\/$/, "") : "";
  if (base) return base;
  return (import.meta as any)?.env?.DEV ? DEV_WORKER_DEFAULT : "";
})();

const URL_REGEX = /https?:\/\/[^\s)]+/i;

type PreviewCacheStatus = "image" | "no-image" | "fallback" | "empty";

type PreviewCacheEntry = {
  data: UrlPreviewData | null;
  fetchedAt: number;
  status: PreviewCacheStatus;
  fallback?: boolean;
};

const PREVIEW_CACHE_TTLS: Record<PreviewCacheStatus, number> = {
  image: 24 * 60 * 60 * 1000,
  "no-image": 10 * 60 * 1000,
  fallback: 60 * 1000,
  empty: 60 * 1000,
};

const PREVIEW_RETRY_DELAY_MS = 4_000;

const previewCache = new Map<string, PreviewCacheEntry>();
const previewPromises = new Map<string, Promise<UrlPreviewData | null>>();
const persistentCache = new Map<string, PreviewCacheEntry>();

let persistentCacheLoaded = false;

type PersistedPreviewEntry = {
  data: UrlPreviewData | null;
  fetchedAt: number;
  status: PreviewCacheStatus;
  fallback?: boolean;
};

function clonePersistedPreviewData(raw: any): UrlPreviewData | null {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" && raw.url ? raw.url : null;
  const finalUrl = typeof raw.finalUrl === "string" && raw.finalUrl ? raw.finalUrl : url;
  const displayUrl = typeof raw.displayUrl === "string" && raw.displayUrl ? raw.displayUrl : finalUrl;
  if (!url || !finalUrl || !displayUrl) return null;

  const data: UrlPreviewData = {
    url,
    finalUrl,
    displayUrl,
  };

  if (typeof raw.title === "string" && raw.title) data.title = raw.title;
  if (typeof raw.description === "string" && raw.description) data.description = raw.description;
  const image = sanitizeUrl(raw.image);
  if (image) data.image = image;
  const icon = sanitizeUrl(raw.icon);
  if (icon) data.icon = icon;
  if (typeof raw.siteName === "string" && raw.siteName) data.siteName = raw.siteName;

  return data;
}

function deserializePersistedEntry(url: string, raw: any): PreviewCacheEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const fetchedAt = typeof raw.fetchedAt === "number" ? raw.fetchedAt : 0;
  const status = typeof raw.status === "string" ? (raw.status as PreviewCacheStatus) : null;
  if (!status || !(status in PREVIEW_CACHE_TTLS)) return null;
  const fallback = Boolean(raw.fallback);
  if (raw.data === null) {
    return { data: null, fetchedAt, status, fallback };
  }
  const data = clonePersistedPreviewData(raw.data);
  if (!data) return null;
  return { data, fetchedAt, status, fallback };
}

function ensurePersistentCacheLoaded(): void {
  if (persistentCacheLoaded) return;
  persistentCacheLoaded = true;
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(LS_URL_PREVIEW_CACHE);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [url, value] of Object.entries(parsed as Record<string, any>)) {
      const entry = deserializePersistedEntry(url, value);
      if (!entry) continue;
      if (!isCacheEntryFresh(entry)) continue;
      previewCache.set(url, entry);
      if (shouldPersistEntry(entry)) {
        persistentCache.set(url, entry);
      }
    }
  } catch {
    /* ignore */
  }
}

function shouldPersistEntry(entry: PreviewCacheEntry): boolean {
  if (!entry.data) return false;
  if (!entry.data.image) return false;
  if (!entry.data.title) return false;
  if (entry.status !== "image") return false;
  if (entry.fallback) return false;
  return true;
}

function serializePersistentCache(): Record<string, PersistedPreviewEntry> {
  const payload: Record<string, PersistedPreviewEntry> = {};
  for (const [url, entry] of persistentCache.entries()) {
    payload[url] = {
      data: entry.data ? { ...entry.data } : null,
      fetchedAt: entry.fetchedAt,
      status: entry.status,
      fallback: entry.fallback,
    };
  }
  return payload;
}

function writePersistentCache(): void {
  if (typeof window === "undefined") return;
  try {
    if (persistentCache.size === 0) {
      window.localStorage.removeItem(LS_URL_PREVIEW_CACHE);
      return;
    }
    const payload = serializePersistentCache();
    window.localStorage.setItem(LS_URL_PREVIEW_CACHE, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function updatePersistentCache(url: string, entry: PreviewCacheEntry): void {
  ensurePersistentCacheLoaded();
  if (!shouldPersistEntry(entry)) {
    if (persistentCache.delete(url)) {
      writePersistentCache();
    }
    return;
  }
  persistentCache.set(url, entry);
  writePersistentCache();
}

function purgePersistentEntry(url: string): void {
  ensurePersistentCacheLoaded();
  if (persistentCache.delete(url)) {
    writePersistentCache();
  }
}

export function extractFirstUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = text.match(URL_REGEX);
  return match ? match[0] : null;
}

export function isUrlLike(text: string | undefined | null): boolean {
  if (!text) return false;
  return /^https?:\/\/[^\s]+$/i.test(text.trim());
}

function resolveWorkerBaseUrl(): string | null {
  if (typeof window !== "undefined") {
    const fromWindow = (window as any).__TASKIFY_WORKER_BASE_URL__;
    if (typeof fromWindow === "string" && fromWindow.trim()) {
      return fromWindow.trim();
    }
    const host = (() => {
      try {
        return window.location.hostname;
      } catch {
        return undefined;
      }
    })();
    const isLocalhost = host ? /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host) : false;
    if (!isLocalhost) {
      try {
        return window.location.origin;
      } catch {}
    }
  }
  return STATIC_WORKER_BASE || null;
}

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 512);
}

function refinePreviewTitle(
  title: string | undefined,
  context: { siteName?: string; finalUrl?: string },
): string | undefined {
  if (!title) return undefined;
  let cleaned = title.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  cleaned = stripTrailingMetadataSegments(cleaned, context);
  return cleaned || undefined;
}

function stripTrailingMetadataSegments(
  title: string,
  context: { siteName?: string; finalUrl?: string },
): string {
  let current = title.trim();
  const host = getHostLabel(context.finalUrl);
  while (true) {
    const match = current.match(/([:\-|—·]\s*)([^:\-|—·]+)$/u);
    if (!match || match.index === undefined) {
      break;
    }
    const [, rawSeparator] = match;
    const separator = rawSeparator.trim() || rawSeparator;
    const segment = match[2]?.trim();
    if (!segment) {
      current = current.slice(0, match.index).trimEnd();
      continue;
    }
    if (!isMetadataSegment(segment, { siteName: context.siteName, host, separator })) {
      break;
    }
    current = current.slice(0, match.index).trimEnd();
  }
  return current.trim();
}

function isMetadataSegment(
  segment: string,
  context: { siteName?: string; host?: string; separator: string },
): boolean {
  const lower = segment.toLowerCase();
  if (!segment) return true;
  if (context.siteName && lower === context.siteName.toLowerCase()) return true;
  if (context.host && lower === context.host.toLowerCase()) return true;
  if (lower.startsWith("by ")) return true;
  if (/amazon/.test(lower) || /isbn/.test(lower) || /asin/.test(lower)) return true;
  if (/goodreads/.test(lower) || /barnes/.test(lower) || /target/.test(lower)) return true;
  if (lower === "books" || lower === "book") return true;
  if (/\b(?:hardcover|paperback|audiobook|ebook|kindle)\b/.test(lower)) return true;
  if (/https?:\/\//.test(lower) || /\.[a-z]{2,}$/.test(lower)) return true;
  const digitCount = (segment.match(/\d/g) || []).length;
  if (digitCount >= 6) return true;
  if (context.separator === ":" && /\b(?:author|editor)\b/.test(lower)) return true;
  if (segment.includes(",")) {
    const words = segment.split(/\s+/).filter(Boolean);
    if (words.length && words.length <= 6) {
      const properCase = words.filter((word) => /^[A-Z][a-z'’.-]*$/.test(word) || /^[A-Z]\.$/.test(word));
      if (properCase.length === words.length) {
        return true;
      }
    }
  }
  return false;
}

function getHostLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

function normalizePreview(raw: any, requestedUrl: string): UrlPreviewData | null {
  if (!raw || typeof raw !== "object") return null;
  const requested = typeof raw.url === "string" && raw.url ? raw.url : requestedUrl;
  const finalUrl = typeof raw.finalUrl === "string" && raw.finalUrl ? raw.finalUrl : requested;
  const displayUrl = sanitizeString(raw.displayUrl) || buildDisplayUrl(finalUrl);
  const siteName = sanitizeString(raw.siteName);
  const title = refinePreviewTitle(sanitizeString(raw.title), { siteName, finalUrl });
  const description = sanitizeString(raw.description);
  const image = sanitizeUrl(raw.image) || undefined;
  const icon = sanitizeUrl(raw.icon) || undefined;
  return {
    url: requested,
    finalUrl,
    displayUrl,
    title,
    description,
    image,
    icon,
    siteName,
  };
}

function sanitizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).href;
  } catch {
    return null;
  }
}

function buildDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    let path = parsed.pathname || "";
    if (path.endsWith("/")) path = path.slice(0, -1);
    const display = path && path !== "/" ? `${host}${path}` : host;
    return display || parsed.host || url;
  } catch {
    return url;
  }
}

function isCacheEntryFresh(entry: PreviewCacheEntry): boolean {
  const ttl = PREVIEW_CACHE_TTLS[entry.status] ?? PREVIEW_CACHE_TTLS.image;
  return Date.now() - entry.fetchedAt < ttl;
}

function readCacheData(url: string): UrlPreviewData | null | undefined {
  ensurePersistentCacheLoaded();
  const entry = previewCache.get(url);
  if (!entry) {
    return undefined;
  }
  if (!isCacheEntryFresh(entry)) {
    previewCache.delete(url);
    purgePersistentEntry(url);
    return undefined;
  }
  return entry.data;
}

type CacheEntryExtras = { fallback?: boolean };

function setCacheEntry(
  url: string,
  data: UrlPreviewData | null,
  status: PreviewCacheStatus,
  extras: CacheEntryExtras = {},
): PreviewCacheEntry {
  const entry: PreviewCacheEntry = {
    data,
    fetchedAt: Date.now(),
    status,
    fallback: extras.fallback,
  };
  previewCache.set(url, entry);
  updatePersistentCache(url, entry);
  return entry;
}

function determineCacheStatus(
  data: UrlPreviewData | null,
  extras: { fallback?: boolean } = {},
): PreviewCacheStatus {
  if (data && data.image) {
    return "image";
  }
  if (data) {
    return extras.fallback ? "fallback" : "no-image";
  }
  return extras.fallback ? "fallback" : "empty";
}

function scheduleRetry(url: string, entry: PreviewCacheEntry): void {
  if (typeof window === "undefined") return;
  if (entry.status === "image" && !entry.fallback) return;
  const scheduledAt = Date.now();
  setTimeout(() => {
    const current = previewCache.get(url);
    if (current && current.fetchedAt > scheduledAt && current.status === "image" && !current.fallback) {
      return;
    }
    fetchPreview(url, { force: true, skipRetry: true }).catch(() => {});
  }, PREVIEW_RETRY_DELAY_MS);
}

type FetchPreviewOptions = { force?: boolean; skipRetry?: boolean };

async function fetchPreview(url: string, options: FetchPreviewOptions = {}): Promise<UrlPreviewData | null> {
  if (!options.force) {
    const cached = readCacheData(url);
    if (cached !== undefined) {
      return cached ?? null;
    }
  }
  if (previewPromises.has(url)) {
    return previewPromises.get(url)!;
  }

  const promise = (async () => {
    const base = resolveWorkerBaseUrl();
    if (!base) {
      setCacheEntry(url, null, "empty");
      return null;
    }
    try {
      const endpoint = `${base}/api/preview?url=${encodeURIComponent(url)}`;
      const res = await fetch(endpoint, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) {
        setCacheEntry(url, null, "empty");
        return null;
      }
      const json = await res.json().catch(() => null);
      const preview = normalizePreview(json?.preview, url);
      const fallback = Boolean(json?.fallback);
      const status = determineCacheStatus(preview ?? null, { fallback });
      const entry = setCacheEntry(url, preview ?? null, status, { fallback });
      if (!options.skipRetry && (entry.status !== "image" || entry.fallback)) {
        scheduleRetry(url, entry);
      }
      return entry.data ?? null;
    } catch {
      setCacheEntry(url, null, "empty");
      return null;
    } finally {
      previewPromises.delete(url);
    }
  })();

  previewPromises.set(url, promise);
  return promise;
}

export function useUrlPreview(source: string | undefined | null): UrlPreviewData | null {
  const url = useMemo(() => extractFirstUrl(source), [source]);
  const [data, setData] = useState<UrlPreviewData | null>(() => {
    if (!url) return null;
    const cached = readCacheData(url);
    return cached ?? null;
  });

  useEffect(() => {
    if (!url) {
      setData(null);
      return;
    }
    const cached = readCacheData(url);
    if (cached !== undefined) {
      setData(cached ?? null);
      return;
    }
    let cancelled = false;
    fetchPreview(url).then((result) => {
      if (!cancelled) {
        setData(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return data;
}

export function getCachedPreview(url: string): UrlPreviewData | null | undefined {
  return readCacheData(url);
}
