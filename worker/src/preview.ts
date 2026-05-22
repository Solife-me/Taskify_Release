// Link preview proxy — extracted from index.ts (Item #12 worker module split, pass 2).
// Fetches a URL, extracts OG/Twitter/JSON-LD metadata, and returns a normalized
// preview payload. Includes fallback heuristics for blocked / metadata-poor pages.

import { getPreviewFromContent } from "link-preview-js";
import { jsonResponse, JSON_HEADERS } from "./lib.ts";

const PREVIEW_TITLE_MAX_LENGTH = 160;
const PREVIEW_DESCRIPTION_MAX_LENGTH = 260;
const PREVIEW_TIMEOUT_MS = 8_000;
const PREVIEW_MAX_BYTES = 600_000;
const PREVIEW_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_REFERER = "https://www.google.com/";

type PreviewRankedValue = { value: string; priority: number };

type PreviewImageCandidate = {
  url: string;
  priority: number;
  kind: "image" | "icon";
};

type PreviewPayload = {
  url: string;
  finalUrl: string;
  displayUrl: string;
  title: string;
  description?: string;
  image?: string;
  icon?: string;
  siteName?: string;
};

type JsonLdPrimitive = string | number | boolean | null;
interface JsonLdObject {
  [key: string]: JsonLdValue | undefined;
}
type JsonLdValue = JsonLdPrimitive | JsonLdObject | JsonLdValue[];

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : match;
    })
    .replace(/&#(\d+);/g, (match, num) => {
      const code = parseInt(num, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : match;
    });
}

function normalizeText(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const decoded = decodeHtmlEntities(raw);
  const collapsed = decoded.replace(/\s+/g, " ").trim();
  return collapsed || null;
}

function resolveUrl(base: string, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

function unwrapGoogleRedirectUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === "consent.youtube.com" || host === "consent.google.com") {
      const continuation = parsed.searchParams.get("continue") || parsed.searchParams.get("continue_url");
      if (continuation) {
        return continuation;
      }
    }
    if (host.endsWith(".google.com")) {
      if (parsed.pathname === "/url" || parsed.pathname === "/imgres") {
        const candidate = parsed.searchParams.get("url") || parsed.searchParams.get("q") || parsed.searchParams.get("imgurl");
        if (candidate) {
          return candidate;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return rawUrl;
}

function buildDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    let path = parsed.pathname || "";
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    const display = path && path !== "/" ? `${host}${path}` : host;
    return display || parsed.hostname || url;
  } catch {
    return url;
  }
}

function fallbackTitleForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    const slugCandidate = (() => {
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const segment = segments[i];
        if (!segment) continue;
        if (/^\d+$/.test(segment)) continue;
        const decoded = decodeURIComponent(segment.replace(/\+/g, " "));
        const cleaned = decoded.replace(/\.(html?|php)$/i, "");
        if (!/[a-zA-Z]/.test(cleaned)) continue;
        const words = cleaned
          .split(/[^a-zA-Z0-9]+/g)
          .filter(Boolean)
          .map((word) => word.length ? word[0].toUpperCase() + word.slice(1).toLowerCase() : "")
          .filter(Boolean);
        if (words.length >= 2 || (words.length === 1 && words[0].length >= 4)) {
          return words.join(" ");
        }
      }
      return null;
    })();
    if (slugCandidate) {
      return slugCandidate;
    }
    const primarySegments = segments.slice(0, 2);
    const pathPart = primarySegments.length ? ` / ${primarySegments.join(" / ")}` : "";
    return (host || parsed.hostname || url) + pathPart;
  } catch {
    return url;
  }
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

function refinePreviewTitle(
  title: string | undefined,
  context: { siteName?: string; finalUrl?: string },
): string | undefined {
  if (!title) return undefined;
  let cleaned = title.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  cleaned = stripLeadingMetadataSegments(cleaned, context);
  cleaned = stripTrailingMetadataSegments(cleaned, context);
  if (context.finalUrl) {
    cleaned = stripHostFromTitle(cleaned, context.finalUrl, context.siteName);
  }
  return cleaned || undefined;
}

function stripLeadingMetadataSegments(
  title: string,
  context: { siteName?: string; finalUrl?: string },
): string {
  let current = title.trim();
  const host = getHostLabel(context.finalUrl);
  while (true) {
    const match = current.match(/^([^:\-|—·]+?)([:\-|—·]\s+)/u);
    if (!match) break;
    const segment = match[1]?.trim();
    const rawSeparator = match[2] || "";
    if (!segment) {
      current = current.slice(match[0].length).trimStart();
      continue;
    }
    if (!isMetadataSegment(segment, { siteName: context.siteName, host, separator: rawSeparator.trim() || rawSeparator })) {
      break;
    }
    current = current.slice(match[0].length).trimStart();
  }
  return current.trim();
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
  if (lower === "everything else") return true;
  if (lower === "amazon.com" || lower === "amazon") return true;
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

function buildBrowserHeaders(options: { referer?: string } = {}): Record<string, string> {
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-CH-UA": '"Not A(Brand";v="99", "Chromium";v="124", "Google Chrome";v="124"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": PREVIEW_USER_AGENT,
    Referer: options.referer || DEFAULT_REFERER,
    DNT: "1",
  };
}

async function readResponseBodyLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > PREVIEW_MAX_BYTES ? text.slice(0, PREVIEW_MAX_BYTES) : text;
  }
  const decoder = new TextDecoder();
  let received = 0;
  const chunks: string[] = [];
  while (received < PREVIEW_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    const allowed =
      received > PREVIEW_MAX_BYTES ? value.subarray(0, value.length - (received - PREVIEW_MAX_BYTES)) : value;
    if (allowed.length > 0) {
      chunks.push(decoder.decode(allowed, { stream: true }));
    }
    if (received >= PREVIEW_MAX_BYTES) break;
  }
  chunks.push(decoder.decode());
  const joined = chunks.join("");
  return joined.length > PREVIEW_MAX_BYTES ? joined.slice(0, PREVIEW_MAX_BYTES) : joined;
}

function stripHostFromTitle(title: string, url: string, siteName?: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const rootHost = host.split(".").slice(-2).join(".");
    const normalizedSite = siteName ? siteName.replace(/^www\./i, "") : undefined;
    const loweredTitle = title.toLowerCase();
    const candidates = Array.from(
      new Set([host, rootHost, normalizedSite, siteName ?? ""].filter(Boolean) as string[]),
    );
    const separators = [": ", " - ", " — ", " | ", " · ", " :: "];
    for (const candidate of candidates) {
      const loweredCandidate = candidate.toLowerCase();
      for (const separator of separators) {
        if (loweredTitle.startsWith((loweredCandidate + separator).toLowerCase())) {
          const trimmed = title.slice(candidate.length + separator.length).trim();
          if (trimmed) return trimmed;
        }
        if (loweredTitle.endsWith((separator + loweredCandidate).toLowerCase())) {
          const trimmed = title.slice(0, title.length - separator.length - candidate.length).trim();
          if (trimmed) return trimmed;
        }
      }
    }
  } catch {}
  return title;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function guessFaviconUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/favicon.ico`;
  } catch {
    return undefined;
  }
}

function extractFromSrcset(srcset: string | null, baseUrl: string): string | null {
  if (!srcset) return null;
  const candidates: string[] = [];
  for (const part of srcset.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [urlPart] = trimmed.split(/\s+/);
    const absolute = resolveUrl(baseUrl, urlPart);
    if (absolute) {
      candidates.push(absolute);
    }
  }
  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
}

function parseDynamicImageAttribute(raw: string | null, baseUrl: string): string | null {
  if (!raw) return null;
  const decoded = decodeHtmlEntities(raw);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const ranked = Object.entries(parsed)
      .map(([url, value]) => {
        const absolute = resolveUrl(baseUrl, url);
        if (!absolute) return null;
        let score = 0;
        if (Array.isArray(value) && value.length >= 2) {
          const width = Number(value[0]);
          const height = Number(value[1]);
          if (Number.isFinite(width) && Number.isFinite(height)) {
            score = width * height;
          }
        } else if (typeof value === "number") {
          score = value;
        }
        return { url: absolute, score };
      })
      .filter((entry): entry is { url: string; score: number } => Boolean(entry?.url));
    if (!ranked.length) return null;
    ranked.sort((a, b) => b.score - a.score);
    return ranked[0]?.url ?? null;
  } catch {
    return null;
  }
}

function looksLikeBlockedPage(html: string): boolean {
  const snippet = html.slice(0, 8192).toLowerCase();
  return (
    snippet.includes("captcha") ||
    snippet.includes("robot check") ||
    snippet.includes("service unavailable") ||
    snippet.includes("automated access") ||
    snippet.includes("enable cookies")
  );
}

function buildPreviewResponse(preview: PreviewPayload, extras?: { blocked?: boolean; fallback?: boolean }): Response {
  const body = extras ? { preview, ...extras } : { preview };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "Cache-Control": "public, max-age=300",
    },
  });
}

function buildFallbackPreview(requestedUrl: string, finalUrl: string): PreviewPayload {
  const target = finalUrl || requestedUrl;
  return {
    url: requestedUrl,
    finalUrl: target,
    displayUrl: buildDisplayUrl(target),
    title: fallbackTitleForUrl(target),
    icon: guessFaviconUrl(target),
  };
}

class PreviewCollector {
  private readonly requestedUrl: string;
  private readonly finalUrl: string;
  private titles: PreviewRankedValue[] = [];
  private descriptions: PreviewRankedValue[] = [];
  private siteNames: PreviewRankedValue[] = [];
  private images: PreviewImageCandidate[] = [];
  private jsonLdBuffer = "";
  private titleBuffer = "";
  private headingBuffer = "";
  private productTitleBuffer = "";

  constructor(requestedUrl: string, finalUrl: string) {
    this.requestedUrl = requestedUrl;
    this.finalUrl = finalUrl;
  }

  async parse(html: string): Promise<void> {
    await new HTMLRewriter()
      .on("meta", {
        element: (element) => this.handleMeta(element as any),
      })
      .on("title", {
        text: (text) => this.collectTitleText(text as any),
      })
      .on("h1", {
        text: (text) => this.collectHeadingText(text as any),
      })
      .on("span#productTitle", {
        text: (text) => this.collectProductTitle(text as any),
      })
      .on("link", {
        element: (element) => this.handleLink(element as any),
      })
      .on("img", {
        element: (element) => this.handleImg(element as any),
      })
      .on('script[type="application/ld+json" i]', {
        text: (text) => this.collectJsonLd(text as any),
      })
      .transform(new Response(html))
      .text();
  }

  finalize(): PreviewPayload {
    const finalUrl = this.finalUrl || this.requestedUrl;
    const siteName = this.pickBest(this.siteNames);
    let title = this.pickBest(this.titles);
    if (title) {
      title = refinePreviewTitle(title, { siteName, finalUrl }) ?? title;
      title = truncate(title, PREVIEW_TITLE_MAX_LENGTH);
    }
    if (!title) {
      title = fallbackTitleForUrl(finalUrl);
    }
    let description = this.pickBest(this.descriptions);
    if (description) {
      description = truncate(description, PREVIEW_DESCRIPTION_MAX_LENGTH);
    }
    const image = this.pickImage("image");
    const icon = this.pickImage("icon") || guessFaviconUrl(finalUrl);

    return {
      url: this.requestedUrl,
      finalUrl,
      displayUrl: buildDisplayUrl(finalUrl),
      title,
      description: description || undefined,
      image,
      icon,
      siteName,
    };
  }

  private handleMeta(element: any): void {
    const content = element.getAttribute("content");
    if (!content) return;
    const property = (element.getAttribute("property") || "").toLowerCase();
    const name = (element.getAttribute("name") || "").toLowerCase();
    const itemprop = (element.getAttribute("itemprop") || "").toLowerCase();

    if (property === "og:title" || name === "og:title") {
      this.addTitle(content, 120);
    } else if (name === "twitter:title" || property === "twitter:title") {
      this.addTitle(content, 110);
    } else if (itemprop === "name" || name === "title") {
      this.addTitle(content, 90);
    }

    if (property === "og:site_name") {
      this.addSiteName(content, 70);
    } else if (name === "application-name") {
      this.addSiteName(content, 50);
    }

    if (property === "og:description" || name === "og:description") {
      this.addDescription(content, 110);
    } else if (name === "twitter:description" || property === "twitter:description") {
      this.addDescription(content, 100);
    } else if (name === "description") {
      this.addDescription(content, 80);
    }

    if (
      property === "og:image" ||
      property === "og:image:url" ||
      property === "og:image:secure_url" ||
      name === "twitter:image" ||
      name === "twitter:image:src" ||
      name === "og:image"
    ) {
      this.addImage(content, 120, "image");
    } else if (property === "og:logo" || name === "msapplication-square150x150logo") {
      this.addImage(content, 90, "icon");
    }
  }

  private handleLink(element: any): void {
    const rel = (element.getAttribute("rel") || "").toLowerCase();
    if (!rel) return;
    const href = element.getAttribute("href");
    if (!href) return;
    if (/\bapple-touch-icon\b/.test(rel)) {
      this.addImage(href, 90, "icon");
    } else if (/\bicon\b/.test(rel)) {
      this.addImage(href, 70, "icon");
    }
  }

  private handleImg(element: any): void {
    const base = this.finalUrl;
    const idAttr = (element.getAttribute("id") || "").toLowerCase();
    const oldHires = element.getAttribute("data-old-hires");
    if (oldHires) this.addImage(oldHires, 120, "image");

    const attrCandidates = [
      element.getAttribute("data-main-image-href"),
      element.getAttribute("data-hires"),
      element.getAttribute("data-large-image"),
      element.getAttribute("data-original-src"),
      element.getAttribute("data-src"),
      element.getAttribute("data-lazy-src"),
    ];
    for (const attr of attrCandidates) {
      if (attr) {
        const priority = idAttr.includes("landingimage") ? 120 : 95;
        this.addImage(attr, priority, "image");
      }
    }

    const dynamic = parseDynamicImageAttribute(element.getAttribute("data-a-dynamic-image"), base);
    if (dynamic) this.addImage(dynamic, 110, "image");

    const srcset = extractFromSrcset(element.getAttribute("data-srcset") || element.getAttribute("srcset"), base);
    if (srcset) this.addImage(srcset, 90, "image");

    const src = element.getAttribute("src");
    if (src) this.addImage(src, 70, "image");
  }

  private collectTitleText(text: any): void {
    if (!text?.text) return;
    this.titleBuffer += text.text;
    if (text.lastInTextNode) {
      this.addTitle(this.titleBuffer, 80);
      this.titleBuffer = "";
    }
  }

  private collectHeadingText(text: any): void {
    if (!text?.text) return;
    this.headingBuffer += text.text;
    if (text.lastInTextNode) {
      this.addTitle(this.headingBuffer, 60);
      this.headingBuffer = "";
    }
  }

  private collectProductTitle(text: any): void {
    if (!text?.text) return;
    this.productTitleBuffer += text.text;
    if (text.lastInTextNode) {
      this.addTitle(this.productTitleBuffer, 95);
      this.productTitleBuffer = "";
    }
  }

  private collectJsonLd(text: any): void {
    if (!text?.text) return;
    this.jsonLdBuffer += text.text;
    if (text.lastInTextNode) {
      this.processJsonLd(this.jsonLdBuffer);
      this.jsonLdBuffer = "";
    }
  }

  private processJsonLd(raw: string): void {
    if (!raw) return;
    try {
      const json = JSON.parse(raw) as JsonLdValue | JsonLdValue[];
      const nodes = Array.isArray(json) ? json : [json];
      for (const node of nodes) {
        this.walkJsonLd(node);
      }
    } catch {
      // ignore invalid JSON-LD
    }
  }

  private walkJsonLd(value: JsonLdValue): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        this.walkJsonLd(entry);
      }
      return;
    }
    if (typeof value === "object") {
      const obj = value as JsonLdObject;
      if (obj.image !== undefined) {
        this.extractImageFromJsonLd(obj.image, "image", 100);
      }
      if (obj.logo !== undefined) {
        this.extractImageFromJsonLd(obj.logo, "icon", 90);
      }
      if (obj.thumbnailUrl !== undefined) {
        this.extractImageFromJsonLd(obj.thumbnailUrl, "image", 95);
      }
      if (typeof obj.name === "string") {
        this.addTitle(obj.name, 80);
      }
      if (typeof obj.headline === "string") {
        this.addTitle(obj.headline, 75);
      }
      if (typeof obj.alternativeHeadline === "string") {
        this.addTitle(obj.alternativeHeadline, 70);
      }
      if (typeof obj.description === "string") {
        this.addDescription(obj.description, 90);
      }
      for (const nested of Object.values(obj)) {
        if (nested && (typeof nested === "object" || Array.isArray(nested))) {
          this.walkJsonLd(nested);
        }
      }
    } else if (typeof value === "string") {
      // strings can be plain descriptions
      this.addDescription(value, 50);
    }
  }

  private extractImageFromJsonLd(value: JsonLdValue | undefined, kind: "image" | "icon", priority: number): void {
    if (!value) return;
    if (typeof value === "string") {
      this.addImage(value, priority, kind);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        this.extractImageFromJsonLd(item, kind, priority);
      }
      return;
    }
    if (typeof value === "object") {
      const obj = value as JsonLdObject;
      const urlFields: (keyof JsonLdObject)[] = ["url", "contentUrl", "@id"];
      for (const field of urlFields) {
        const candidate = obj[field];
        if (typeof candidate === "string") {
          this.addImage(candidate, priority, kind);
          return;
        }
      }
      for (const nested of Object.values(obj)) {
        if (nested) {
          this.extractImageFromJsonLd(nested, kind, priority);
        }
      }
    }
  }

  private addTitle(value: string | null | undefined, priority: number): void {
    const normalized = normalizeText(value);
    if (!normalized) return;
    this.upsertRankedValue(this.titles, normalized, priority);
  }

  private addDescription(value: string | null | undefined, priority: number): void {
    const normalized = normalizeText(value);
    if (!normalized) return;
    this.upsertRankedValue(this.descriptions, normalized, priority);
  }

  private addSiteName(value: string | null | undefined, priority: number): void {
    const normalized = normalizeText(value);
    if (!normalized) return;
    this.upsertRankedValue(this.siteNames, normalized, priority);
  }

  private addImage(value: string | null | undefined, priority: number, kind: "image" | "icon"): void {
    const absolute = resolveUrl(this.finalUrl, value);
    if (!absolute) return;
    const existing = this.images.find((entry) => entry.url === absolute);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      if (kind === "image") {
        existing.kind = "image";
      }
      return;
    }
    this.images.push({ url: absolute, priority, kind });
  }

  private upsertRankedValue(list: PreviewRankedValue[], value: string, priority: number): void {
    const existing = list.find((entry) => entry.value === value);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
    } else {
      list.push({ value, priority });
    }
  }

  private pickBest(list: PreviewRankedValue[]): string | undefined {
    if (!list.length) return undefined;
    const sorted = [...list].sort((a, b) => b.priority - a.priority);
    return sorted[0]?.value;
  }

  private pickImage(kind: "image" | "icon"): string | undefined {
    const filtered = this.images.filter((entry) => (kind === "image" ? entry.kind === "image" : true));
    const sorted = filtered.sort((a, b) => b.priority - a.priority);
    if (sorted.length) return sorted[0]?.url;
    if (kind === "icon") {
      const fallback = [...this.images].sort((a, b) => b.priority - a.priority);
      if (fallback.length) return fallback[0]?.url;
    }
    return undefined;
  }
}

type LinkPreviewResult = Awaited<ReturnType<typeof getPreviewFromContent>>;

function pickPreviewAsset(candidates: unknown, baseUrl: string): string | undefined {
  if (!candidates) return undefined;
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const candidate of list) {
    if (typeof candidate !== "string") continue;
    const absolute = resolveUrl(baseUrl, candidate);
    if (!absolute) continue;
    try {
      const parsed = new URL(absolute);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

function normalizeLinkPreviewResult(
  result: LinkPreviewResult,
  requestedUrl: string,
): { preview: PreviewPayload; rich: boolean } | null {
  if (!result || typeof result !== "object") return null;

  const rawSiteName = (result as { siteName?: unknown }).siteName;
  const finalUrl = typeof (result as { url?: unknown }).url === "string" && (result as { url?: string }).url
    ? (result as { url?: string }).url!
    : requestedUrl;
  const siteName = normalizeText(typeof rawSiteName === "string" ? rawSiteName : null) ?? undefined;

  const fallbackTitle = fallbackTitleForUrl(finalUrl);
  const rawTitle = (result as { title?: unknown }).title;
  let title = normalizeText(typeof rawTitle === "string" ? rawTitle : null);
  let usedFallbackTitle = false;
  if (title) {
    title = refinePreviewTitle(title, { siteName, finalUrl }) ?? title;
    title = truncate(title, PREVIEW_TITLE_MAX_LENGTH);
  } else {
    title = fallbackTitle;
    usedFallbackTitle = true;
  }

  const rawDescription = (result as { description?: unknown }).description;
  let description = normalizeText(typeof rawDescription === "string" ? rawDescription : null);
  if (description) {
    description = truncate(description, PREVIEW_DESCRIPTION_MAX_LENGTH);
  }

  const image = pickPreviewAsset((result as { images?: unknown }).images, finalUrl);
  const icon =
    pickPreviewAsset((result as { favicons?: unknown }).favicons, finalUrl) ?? guessFaviconUrl(finalUrl);

  const preview: PreviewPayload = {
    url: requestedUrl,
    finalUrl,
    displayUrl: buildDisplayUrl(finalUrl),
    title,
    description: description ?? undefined,
    image,
    icon,
    siteName,
  };

  const rich = Boolean(image && !usedFallbackTitle);
  return { preview, rich };
}

function mergePreviewPayloads(primary: PreviewPayload | null, secondary: PreviewPayload | null): PreviewPayload | null {
  if (!primary && !secondary) return null;
  if (!primary) return secondary;
  if (!secondary) return primary;

  const merged: PreviewPayload = { ...primary };
  const mergedFinalUrl = merged.finalUrl || secondary.finalUrl || merged.url;
  if (mergedFinalUrl !== merged.finalUrl) {
    merged.finalUrl = mergedFinalUrl;
    merged.displayUrl = buildDisplayUrl(mergedFinalUrl);
  }

  const fallbackTitle = fallbackTitleForUrl(mergedFinalUrl);
  const secondaryFallbackTitle = fallbackTitleForUrl(secondary.finalUrl || secondary.url);

  const currentTitle = merged.title;
  const secondaryTitle = secondary.title;
  const currentIsGeneric = !currentTitle || currentTitle === fallbackTitle;
  const secondaryIsGeneric = !secondaryTitle || secondaryTitle === secondaryFallbackTitle;

  if (currentIsGeneric && !secondaryIsGeneric && secondaryTitle) {
    merged.title = secondaryTitle;
  }

  merged.title =
    refinePreviewTitle(merged.title, { siteName: merged.siteName, finalUrl: merged.finalUrl }) ?? merged.title;
  if (!merged.description && secondary.description) {
    merged.description = secondary.description;
  }
  if (!merged.image && secondary.image) {
    merged.image = secondary.image;
  }
  if (!merged.icon && secondary.icon) {
    merged.icon = secondary.icon;
  }
  if (!merged.siteName && secondary.siteName) {
    merged.siteName = secondary.siteName;
  }

  return merged;
}

function hasRichPreview(preview: PreviewPayload): boolean {
  if (!preview.image) return false;
  const finalUrl = preview.finalUrl || preview.url;
  const fallbackTitle = fallbackTitleForUrl(finalUrl);
  return Boolean(preview.title && preview.title !== fallbackTitle);
}

type DerivedPreviewResult = {
  preview: PreviewPayload | null;
  rich: boolean;
};

function collectHostCandidates(requestedUrl: string, finalUrl: string): Set<string> {
  const hosts = new Set<string>();
  for (const value of [requestedUrl, finalUrl]) {
    if (!value) continue;
    try {
      const parsed = new URL(value);
      hosts.add(parsed.hostname.toLowerCase());
    } catch {
      /* ignore */
    }
    try {
      const unwrapped = unwrapGoogleRedirectUrl(value);
      if (unwrapped && unwrapped !== value) {
        const parsed = new URL(unwrapped);
        hosts.add(parsed.hostname.toLowerCase());
      }
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

function extractAmazonAsin(url: string): string | null {
  try {
    const parsed = new URL(url);
    const asinParam = parsed.searchParams.get("asin");
    if (asinParam && /^[A-Z0-9]{10}$/i.test(asinParam)) {
      return asinParam.toUpperCase();
    }
    const pathMatch = parsed.pathname.match(
      /(?:dp|gp\/product|gp\/aw\/d|gp\/slredirect|gp\/aw\/olp|exec\/obidos\/asin)\/([A-Z0-9]{10})/i,
    );
    if (pathMatch) {
      return pathMatch[1].toUpperCase();
    }
    const genericMatch = parsed.pathname.match(/\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (genericMatch) {
      return genericMatch[1].toUpperCase();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractEtsyListingId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathMatch = parsed.pathname.match(/\/listing\/(\d+)/i);
    if (pathMatch) {
      return pathMatch[1];
    }
    const listingId = parsed.searchParams.get("listing_id");
    if (listingId && /^\d+$/.test(listingId)) {
      return listingId;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function canonicalizeAmazonUrl(url: string): string | null {
  const asin = extractAmazonAsin(url);
  if (!asin) return null;
  return `https://www.amazon.com/dp/${asin}`;
}

function canonicalizeEtsyUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const listingIndex = segments.indexOf("listing");
    if (listingIndex === -1 || listingIndex + 1 >= segments.length) return null;
    const listingId = segments[listingIndex + 1];
    const slugSegments = segments.slice(listingIndex + 2);
    const slug = slugSegments.length ? `/${slugSegments.join("/")}` : "";
    return `${parsed.protocol}//${parsed.hostname}/listing/${listingId}${slug}`;
  } catch {
    return null;
  }
}

function extractYouTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("youtu.be")) {
      const id = parsed.pathname.replace(/^\/+/, "");
      return id || null;
    }
    if (parsed.hostname.includes("youtube.")) {
      const id = parsed.searchParams.get("v");
      if (id) return id;
      const match = parsed.pathname.match(/\/embed\/([a-zA-Z0-9_-]{6,})/);
      if (match) return match[1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

function canonicalizeYouTubeUrl(url: string): string | null {
  const id = extractYouTubeId(url);
  if (!id) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}

function buildAmazonImageUrl(asin: string): string {
  return `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL600_&ID=AsinImage&MarketPlace=US&ServiceVersion=20070822`;
}

function extractAmazonImageFromHtml(html: string): string | undefined {
  const patterns = [
    /"hiRes":"(https:[^\"]+)"/i,
    /"large":"(https:[^\"]+)"/i,
    /"mainUrl":"(https:[^\"]+)"/i,
    /"displayImgSrc":"(https:[^\"]+)"/i,
    /data-old-hires="([^"]+)"/i,
    /data-old-hires='([^']+)'/i,
    /data-main-image-url="([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match && match[1]) {
      const cleaned = decodeHtmlEntities(match[1]).replace(/\\u0026/g, "&");
      const sanitized = sanitizeUrl(cleaned);
      if (sanitized) {
        return sanitized;
      }
    }
  }
  return undefined;
}

function safeParseJson(raw: string): any | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      // replace unescaped newlines which sometimes appear in JSON-LD
      const normalized = text.replace(/\n/g, "\\n");
      return JSON.parse(normalized);
    } catch {
      return null;
    }
  }
}

function extractImageFromJsonLd(node: any): string | undefined {
  if (!node) return undefined;
  if (typeof node === "string") {
    const sanitized = sanitizeUrl(node);
    return sanitized ?? undefined;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = extractImageFromJsonLd(entry);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof node === "object") {
    const keys = ["image", "imageUrl", "thumbnailUrl", "contentUrl", "url"];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        const found = extractImageFromJsonLd((node as Record<string, unknown>)[key]);
        if (found) {
          return found;
        }
      }
    }
  }
  return undefined;
}

function extractEtsyImageFromHtml(html: string): string | undefined {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html))) {
    const parsed = safeParseJson(match[1]);
    if (!parsed) continue;
    const found = extractImageFromJsonLd(parsed);
    if (found) {
      return found;
    }
  }
  const directMatch = html.match(/https:\/\/i\.etsystatic\.com\/[^"]+/i);
  if (directMatch && directMatch[0]) {
    const cleaned = decodeHtmlEntities(directMatch[0].replace(/\\u0026/g, "&"));
    const sanitized = sanitizeUrl(cleaned);
    if (sanitized) {
      return sanitized;
    }
  }
  return undefined;
}

function extractOgTitle(html: string): string | undefined {
  const regex = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i;
  const match = regex.exec(html);
  if (match && match[1]) {
    return truncate(decodeHtmlEntities(match[1]), PREVIEW_TITLE_MAX_LENGTH);
  }
  const descMatch = html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i);
  if (descMatch && descMatch[1]) {
    return truncate(decodeHtmlEntities(descMatch[1]), PREVIEW_TITLE_MAX_LENGTH);
  }
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match && h1Match[1]) {
    return truncate(decodeHtmlEntities(h1Match[1]), PREVIEW_TITLE_MAX_LENGTH);
  }
  return undefined;
}

async function fetchAlternateHtml(url: string, referer?: string): Promise<{ html: string; finalUrl: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildBrowserHeaders({ referer }),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const html = await readResponseBodyLimited(response);
    if (!html) return null;
    return { html, finalUrl: response.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNoembedMetadata(url: string): Promise<{ title?: string; description?: string; thumbnail?: string; providerName?: string } | null> {
  const endpoint = `https://noembed.com/embed?nowrap=1&url=${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        "User-Agent": PREVIEW_USER_AGENT,
        Referer: DEFAULT_REFERER,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return null;
    }
    const payload = json as {
      title?: unknown;
      author_name?: unknown;
      provider_name?: unknown;
      thumbnail_url?: unknown;
      description?: unknown;
    };
    const title = typeof payload.title === "string" ? payload.title : undefined;
    const description =
      typeof payload.description === "string"
        ? payload.description
        : typeof payload.author_name === "string"
          ? payload.author_name
          : undefined;
    const thumbnail = typeof payload.thumbnail_url === "string" ? payload.thumbnail_url : undefined;
    const providerName = typeof payload.provider_name === "string" ? payload.provider_name : undefined;
    return { title, description, thumbnail, providerName };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPreviewFromExternalMetadata(
  requestedUrl: string,
  finalUrl: string,
  meta: { title?: string; description?: string; thumbnail?: string; providerName?: string },
  extras: { siteName?: string; fallbackImage?: string } = {},
): PreviewPayload {
  const fallbackTitle = fallbackTitleForUrl(finalUrl);
  const refinedTitle = refinePreviewTitle(meta.title, { siteName: extras.siteName, finalUrl }) ?? meta.title;
  const title = refinedTitle ? truncate(refinedTitle, PREVIEW_TITLE_MAX_LENGTH) : fallbackTitle;
  const description = meta.description ? truncate(meta.description, PREVIEW_DESCRIPTION_MAX_LENGTH) : undefined;
  const image = meta.thumbnail || extras.fallbackImage;
  const siteName = extras.siteName || meta.providerName || getHostLabel(finalUrl) || getHostLabel(requestedUrl);
  return {
    url: requestedUrl,
    finalUrl,
    displayUrl: buildDisplayUrl(finalUrl),
    title,
    description,
    image: image ?? undefined,
    icon: guessFaviconUrl(finalUrl),
    siteName,
  };
}

async function fetchAlternateAmazon(requestedUrl: string, finalUrl: string): Promise<DerivedPreviewResult | null> {
  const asin = extractAmazonAsin(finalUrl) || extractAmazonAsin(requestedUrl);
  if (!asin) return null;
  const mobileUrl = `https://www.amazon.com/gp/aw/d/${asin}`;
  const alternates = await fetchAlternateHtml(mobileUrl, DEFAULT_REFERER);
  if (!alternates) {
    return null;
  }
  const derived = await derivePreviewFromHtml(
    requestedUrl,
    alternates.finalUrl || mobileUrl,
    alternates.html,
    { "content-type": "text/html" },
    200,
  );
  if (derived.preview) {
    const fallbackTitle = fallbackTitleForUrl(derived.preview.finalUrl || derived.preview.url);
    if (!derived.preview.image) {
      const image = extractAmazonImageFromHtml(alternates.html);
      if (image) {
        derived.preview.image = image;
      } else {
        const asin = extractAmazonAsin(finalUrl) || extractAmazonAsin(requestedUrl);
        if (asin) {
          derived.preview.image = buildAmazonImageUrl(asin);
        }
      }
    }
    if (!derived.preview.title || derived.preview.title === fallbackTitle) {
      const ogTitle = extractOgTitle(alternates.html);
      if (ogTitle) {
        derived.preview.title = ogTitle;
      }
    }
    if (!derived.preview.title || derived.preview.title === fallbackTitle) {
      const asin = extractAmazonAsin(finalUrl) || extractAmazonAsin(requestedUrl);
      if (asin) {
        derived.preview.title = truncate(`Amazon product ${asin}`, PREVIEW_TITLE_MAX_LENGTH);
      }
    }
  }
  return derived;
}

async function fetchAlternateEtsy(requestedUrl: string, finalUrl: string): Promise<DerivedPreviewResult | null> {
  const listingId = extractEtsyListingId(finalUrl) || extractEtsyListingId(requestedUrl);
  if (!listingId) return null;
  const mobileUrl = `https://m.etsy.com/listing/${listingId}`;
  const alternates = await fetchAlternateHtml(mobileUrl, DEFAULT_REFERER);
  if (!alternates) {
    return null;
  }

  const derived = await derivePreviewFromHtml(
    requestedUrl,
    alternates.finalUrl || mobileUrl,
    alternates.html,
    { "content-type": "text/html" },
    200,
  );

  if (derived.preview) {
    const fallbackTitle = fallbackTitleForUrl(derived.preview.finalUrl || derived.preview.url);
    if (!derived.preview.image || /favicon/.test(derived.preview.image)) {
      const image = extractEtsyImageFromHtml(alternates.html);
      if (image) {
        derived.preview.image = image;
      }
    }
    if (!derived.preview.title || derived.preview.title === fallbackTitle) {
      const ogTitle = extractOgTitle(alternates.html);
      if (ogTitle) {
        derived.preview.title = ogTitle;
      }
    }
  }

  return derived;
}

async function derivePreviewFromHtml(
  requestedUrl: string,
  finalUrl: string,
  html: string,
  headers: Record<string, string>,
  status: number,
): Promise<DerivedPreviewResult> {
  let primaryPreview: PreviewPayload | null = null;
  let primaryRich = false;
  try {
    const linkPreviewResult = await getPreviewFromContent(
      {
        url: finalUrl,
        data: html,
        headers,
        status,
      },
      {
        headers: {
          "user-agent": PREVIEW_USER_AGENT,
        },
      },
    );
    const normalized = normalizeLinkPreviewResult(linkPreviewResult, requestedUrl);
    if (normalized) {
      primaryPreview = normalized.preview;
      primaryRich = normalized.rich;
    }
  } catch {
    /* ignore primary failure */
  }

  let collectorPreview: PreviewPayload | null = null;
  try {
    const collector = new PreviewCollector(requestedUrl, finalUrl);
    await collector.parse(html);
    collectorPreview = collector.finalize();
  } catch {
    collectorPreview = null;
  }

  const mergedPreview = mergePreviewPayloads(primaryPreview, collectorPreview);
  if (!mergedPreview) {
    return { preview: null, rich: false };
  }
  return { preview: mergedPreview, rich: hasRichPreview(mergedPreview) || primaryRich };
}

type AlternatePreviewReason = "blocked" | "incomplete";

async function fetchYouTubeOEmbed(url: string): Promise<PreviewPayload | null> {
  let target = url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("youtu.be")) {
      const videoId = parsed.pathname.replace(/^\/+/, "");
      if (videoId) {
        target = `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
  } catch {
    /* ignore */
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`;
    const res = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        "User-Agent": PREVIEW_USER_AGENT,
        Referer: DEFAULT_REFERER,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return null;
    }
    const title = typeof (json as { title?: unknown }).title === "string" ? (json as { title?: string }).title : undefined;
    const authorName =
      typeof (json as { author_name?: unknown }).author_name === "string"
        ? (json as { author_name?: string }).author_name
        : undefined;
    const thumbnail =
      typeof (json as { thumbnail_url?: unknown }).thumbnail_url === "string"
        ? (json as { thumbnail_url?: string }).thumbnail_url
        : undefined;
    const fallbackTitle = fallbackTitleForUrl(target);
    const finalTitle = title ? truncate(title, PREVIEW_TITLE_MAX_LENGTH) : fallbackTitle;
    const description = authorName ? `${authorName} • YouTube` : undefined;

    return {
      url,
      finalUrl: target,
      displayUrl: buildDisplayUrl(target),
      title: finalTitle,
      description,
      image: thumbnail ?? undefined,
      icon: "https://www.youtube.com/s/desktop/fe1f68f5/img/favicon_144.png",
      siteName: "YouTube",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEtsyOEmbed(url: string): Promise<PreviewPayload | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const canonical = canonicalizeEtsyUrl(url) ?? url;
    const endpoint = `https://www.etsy.com/oembed?url=${encodeURIComponent(canonical)}`;
    const res = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        "User-Agent": PREVIEW_USER_AGENT,
        Referer: DEFAULT_REFERER,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return null;
    }
    const data = json as {
      title?: unknown;
      url?: unknown;
      author_name?: unknown;
      provider_name?: unknown;
      thumbnail_url?: unknown;
    };
    const oembedUrl = typeof data.url === "string" && data.url ? data.url : canonical;
    const title =
      typeof data.title === "string" && data.title
        ? truncate(data.title, PREVIEW_TITLE_MAX_LENGTH)
        : fallbackTitleForUrl(oembedUrl);
    const seller = typeof data.author_name === "string" && data.author_name ? data.author_name : undefined;
    const image =
      typeof data.thumbnail_url === "string" && data.thumbnail_url ? data.thumbnail_url : undefined;
    const siteName =
      (typeof data.provider_name === "string" && data.provider_name) || "Etsy";

    return {
      url,
      finalUrl: oembedUrl,
      displayUrl: buildDisplayUrl(oembedUrl),
      title,
      description: seller ? `by ${seller}` : undefined,
      image: image ?? undefined,
      icon: "https://www.etsy.com/images/favicon.ico",
      siteName,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function attemptAlternatePreview(
  requestedUrl: string,
  finalUrl: string,
  reason: AlternatePreviewReason,
  existingPreview: PreviewPayload | null,
): Promise<{ preview: PreviewPayload; fallback?: boolean } | null> {
  const canonicalRequested = unwrapGoogleRedirectUrl(requestedUrl);
  const canonicalFinal = unwrapGoogleRedirectUrl(finalUrl || requestedUrl);
  const hosts = collectHostCandidates(canonicalRequested, canonicalFinal);
  let requestedHost: string | undefined;
  try {
    requestedHost = new URL(canonicalRequested).hostname.toLowerCase();
  } catch {
    requestedHost = undefined;
  }
  const hostMatches = (predicate: (host: string) => boolean) =>
    Array.from(hosts).some(predicate) || (requestedHost ? predicate(requestedHost) : false);
  const needsUpgrade = !existingPreview || !hasRichPreview(existingPreview);
  let fallbackCandidate: { preview: PreviewPayload; fallback?: boolean } | null = null;
  const setFallbackCandidate = (preview: PreviewPayload | null, options: { markFallback?: boolean } = {}): void => {
    if (!preview || !preview.image) return;
    if (!fallbackCandidate) {
      fallbackCandidate = options.markFallback ? { preview, fallback: true } : { preview };
    }
  };

  if (hostMatches((host) => host.includes("youtube.") || host.endsWith("youtu.be"))) {
    const canonicalYouTubeUrl =
      canonicalizeYouTubeUrl(canonicalFinal || canonicalRequested) ?? canonicalizeYouTubeUrl(canonicalRequested);
    const targetYoutubeUrl = canonicalYouTubeUrl || canonicalFinal || canonicalRequested;
    const youtubePreview = await fetchYouTubeOEmbed(targetYoutubeUrl);
    if (youtubePreview) {
      if (youtubePreview.image && youtubePreview.title) {
        return { preview: youtubePreview };
      }
      setFallbackCandidate(youtubePreview, { markFallback: needsUpgrade });
    }
    if (canonicalYouTubeUrl) {
      const youtubeNoembed = await fetchNoembedMetadata(canonicalYouTubeUrl);
      if (youtubeNoembed && (youtubeNoembed.title || youtubeNoembed.thumbnail)) {
        const fallbackImage = (() => {
          const id = extractYouTubeId(canonicalYouTubeUrl);
          return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
        })();
        const preview = buildPreviewFromExternalMetadata(requestedUrl, canonicalYouTubeUrl, youtubeNoembed, {
          siteName: "YouTube",
          fallbackImage,
        });
        if (preview.image && preview.title && preview.title !== fallbackTitleForUrl(preview.finalUrl)) {
          return { preview };
        }
        setFallbackCandidate(preview, { markFallback: true });
      }
    }
  }

  const isAmazonHost = hostMatches((host) => host.includes("amazon."));
  if (isAmazonHost) {
    const canonicalAmazon = canonicalizeAmazonUrl(canonicalFinal || canonicalRequested) ?? canonicalizeAmazonUrl(canonicalRequested);
    if (canonicalAmazon) {
      const noembed = await fetchNoembedMetadata(canonicalAmazon);
      if (noembed && (noembed.title || noembed.thumbnail)) {
        const asin = extractAmazonAsin(canonicalAmazon) ?? extractAmazonAsin(canonicalRequested);
        const fallbackImage = asin ? buildAmazonImageUrl(asin) : undefined;
        const preview = buildPreviewFromExternalMetadata(requestedUrl, canonicalAmazon, noembed, {
          siteName: "Amazon",
          fallbackImage,
        });
        if (preview.image && preview.title && preview.title !== fallbackTitleForUrl(preview.finalUrl)) {
          return { preview };
        }
        setFallbackCandidate(preview, { markFallback: true });
      }
    }
  }

  if (isAmazonHost && (reason === "blocked" || needsUpgrade)) {
    const amazonResult = await fetchAlternateAmazon(canonicalRequested, canonicalFinal || canonicalRequested);
    if (amazonResult?.preview) {
      if (amazonResult.rich) {
        return { preview: amazonResult.preview };
      }
      setFallbackCandidate(amazonResult.preview, { markFallback: true });
    }
  }

  const isEtsyHost = hostMatches((host) => host.includes("etsy."));
  if (isEtsyHost) {
    const canonicalEtsyUrl =
      canonicalizeEtsyUrl(canonicalFinal || canonicalRequested) ?? canonicalizeEtsyUrl(canonicalRequested);
    const targetEtsyUrl = canonicalEtsyUrl || canonicalFinal || canonicalRequested;
    const etsyPreview = await fetchEtsyOEmbed(targetEtsyUrl);
    if (etsyPreview) {
      if (etsyPreview.image && etsyPreview.title) {
        return { preview: etsyPreview };
      }
      setFallbackCandidate(etsyPreview, { markFallback: needsUpgrade });
    }
    const etsyNoembed = canonicalEtsyUrl ? await fetchNoembedMetadata(canonicalEtsyUrl) : null;
    if (etsyNoembed && (etsyNoembed.title || etsyNoembed.thumbnail)) {
      const preview = buildPreviewFromExternalMetadata(requestedUrl, canonicalEtsyUrl || targetEtsyUrl, etsyNoembed, {
        siteName: "Etsy",
      });
      if (preview.image && preview.title && preview.title !== fallbackTitleForUrl(preview.finalUrl)) {
        return { preview };
      }
      setFallbackCandidate(preview, { markFallback: true });
    }
  }

  if (isEtsyHost && (reason === "blocked" || needsUpgrade)) {
    const etsyResult = await fetchAlternateEtsy(canonicalRequested, canonicalFinal || canonicalRequested);
    if (etsyResult?.preview) {
      if (etsyResult.rich) {
        return { preview: etsyResult.preview };
      }
      setFallbackCandidate(etsyResult.preview, { markFallback: needsUpgrade });
    }
  }

  if (fallbackCandidate) {
    return fallbackCandidate;
  }

  return null;
}

async function handlePreviewProxy(url: URL): Promise<Response> {
  const targetRaw = url.searchParams.get("url");
  if (!targetRaw) {
    return jsonResponse({ error: "url is required" }, 400);
  }
  const normalizedTarget = unwrapGoogleRedirectUrl(targetRaw);
  let parsed: URL;
  try {
    parsed = new URL(normalizedTarget);
  } catch {
    return jsonResponse({ error: "Invalid URL" }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return jsonResponse({ error: "Only http(s) URLs are supported" }, 400);
  }
  const requestedUrl = parsed.toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(requestedUrl, {
      method: "GET",
      headers: buildBrowserHeaders(),
      redirect: "follow",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    const alternate = await attemptAlternatePreview(requestedUrl, requestedUrl, "blocked", null);
    if (alternate) {
      return buildPreviewResponse(alternate.preview, alternate.fallback ? { fallback: true } : undefined);
    }
    const fallback = buildFallbackPreview(requestedUrl, requestedUrl);
    return buildPreviewResponse(fallback, { fallback: true });
  }
  clearTimeout(timeout);

  if (!upstream.ok) {
    const alternate = await attemptAlternatePreview(requestedUrl, upstream.url || requestedUrl, "blocked", null);
    if (alternate) {
      return buildPreviewResponse(alternate.preview, alternate.fallback ? { fallback: true } : undefined);
    }
    const fallback = buildFallbackPreview(requestedUrl, upstream.url || requestedUrl);
    return buildPreviewResponse(fallback, { fallback: true });
  }

  let bodyText: string;
  try {
    bodyText = await readResponseBodyLimited(upstream);
  } catch {
    const alternate = await attemptAlternatePreview(requestedUrl, upstream.url || requestedUrl, "blocked", null);
    if (alternate) {
      return buildPreviewResponse(alternate.preview, alternate.fallback ? { fallback: true } : undefined);
    }
    const fallback = buildFallbackPreview(requestedUrl, upstream.url || requestedUrl);
    return buildPreviewResponse(fallback, { fallback: true });
  }

  const finalUrlRaw = upstream.url || requestedUrl;
  const finalUrl = unwrapGoogleRedirectUrl(finalUrlRaw);
  const headerMap: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    headerMap[key.toLowerCase()] = value;
  });

  const blockedHint = !bodyText ? false : looksLikeBlockedPage(bodyText);

  const derived = await derivePreviewFromHtml(requestedUrl, finalUrl, bodyText || "", headerMap, upstream.status);
  if (derived.preview && derived.rich) {
    return buildPreviewResponse(derived.preview);
  }

  const alternate = await attemptAlternatePreview(
    requestedUrl,
    finalUrl,
    blockedHint ? "blocked" : "incomplete",
    derived.preview,
  );
  if (alternate) {
    return buildPreviewResponse(alternate.preview, alternate.fallback ? { fallback: true } : undefined);
  }

  if (derived.preview) {
    return buildPreviewResponse(derived.preview, { fallback: !derived.rich });
  }

  const fallback = buildFallbackPreview(requestedUrl, finalUrl);
  return buildPreviewResponse(fallback, blockedHint ? { blocked: true } : { fallback: true });
}

export { handlePreviewProxy };
