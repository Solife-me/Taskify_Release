// NIP-05 address lookup — extracted from index.ts (Item #12 worker module
// split, pass 5).
//
// Resolves `name@domain` style NIP-05 identifiers to a pubkey by fetching
// `https://<domain>/.well-known/nostr.json?name=<name>`. Falls back to http
// only for localhost, and caches successful responses in Cloudflare's Cache API
// for 15 minutes (the cache also protects upstream identity servers from
// hammering during sync storms).

import { jsonResponse, MINUTE_MS } from "./lib.ts";

const NIP05_CACHE_MAX_AGE_MS = 15 * MINUTE_MS;

// Cloudflare Workers Cache API shape (not bundled in `@cloudflare/workers-types`
// when targeting the script bundle; defined inline for self-containment).
interface Cache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface CacheStorage {
  default: Cache;
}

export function parseNip05Address(input: string | null | undefined): { name: string; domain: string; normalized: string } | null {
  const value = (input || "").trim();
  if (!value) return null;
  const atIndex = value.indexOf("@");
  if (atIndex <= 0 || atIndex === value.length - 1) return null;
  const name = value.slice(0, atIndex).trim().toLowerCase();
  const domain = value.slice(atIndex + 1).trim().toLowerCase();
  if (!name || !domain) return null;
  return { name, domain, normalized: `${name}@${domain}` };
}

function getCacheTimestamp(response: Response): number | null {
  const header = response.headers.get("X-Cache-Timestamp") || response.headers.get("Date");
  if (!header) {
    return null;
  }

  const numeric = Number(header);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const parsed = Date.parse(header);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function handleNip05Lookup(url: URL): Promise<Response> {
  const addressParam = url.searchParams.get("address") ?? url.searchParams.get("addr") ?? url.searchParams.get("nip05");
  const parsed = parseNip05Address(addressParam);
  if (!parsed) {
    return jsonResponse({ error: "Invalid NIP-05 address" }, 400);
  }

  const { name, domain, normalized } = parsed;
  const cacheStorage = (globalThis as any).caches as CacheStorage | undefined;
  const cacheKey = cacheStorage ? new Request(`https://cache.taskify/nip05/${encodeURIComponent(normalized)}`) : null;
  if (cacheStorage && cacheKey) {
    try {
      const cached = await cacheStorage.default.match(cacheKey);
      if (cached) {
        const cachedAt = getCacheTimestamp(cached);
        if (cachedAt !== null && Date.now() - cachedAt < NIP05_CACHE_MAX_AGE_MS) {
          return cached;
        }
      }
    } catch {}
  }

  const searchParam = encodeURIComponent(name);
  const isLocalhost =
    /^localhost(?::\d+)?$/i.test(domain) || /^127\.0\.0\.1(?::\d+)?$/i.test(domain) || domain === "[::1]";

  const buildUrls = (scheme: "https" | "http") => [
    `${scheme}://${domain}/.well-known/nostr.json?name=${searchParam}`,
    `${scheme}://${domain}/.well-known/nostr.json`,
  ];

  const urls = [...buildUrls("https"), ...(isLocalhost ? [] : buildUrls("http"))];
  let lastError = "NIP-05 lookup failed";
  for (const target of urls) {
    try {
      const res = await fetch(target, {
        headers: { Accept: "application/json" },
        redirect: "follow",
      });
      if (!res.ok) {
        lastError = `NIP-05 lookup failed (${res.status})`;
        continue;
      }
      const record = await res.json();
      const response = jsonResponse({ nip05: normalized, resolvedFrom: target, record });
      if (cacheStorage && cacheKey) {
        response.headers.set("Cache-Control", `public, max-age=${Math.floor(NIP05_CACHE_MAX_AGE_MS / 1000)}`);
        const now = new Date();
        response.headers.set("Date", now.toUTCString());
        response.headers.set("X-Cache-Timestamp", String(now.getTime()));
        cacheStorage.default.put(cacheKey, response.clone()).catch(() => {});
      }
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return jsonResponse({ error: lastError }, 502);
}
