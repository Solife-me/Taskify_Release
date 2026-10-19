/** Helpers for chat, contacts and profiles: identity, profile caches, links, DM keys, inbox ids. */
import React from "react";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  LS_CONTACT_PROFILE_CACHE,
  LS_PROFILE_METADATA_CACHE,
} from "../localStorageKeys";
import { revealLocalSecretKey } from "../identity/identity";
import type { CalendarInvite } from "../domains/calendar/calendarInvitesHook";
import { idbKeyValue } from "../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR } from "../storage/taskifyDb";


import type { ContactProfile, Contact } from "../lib/contacts";
import type { WalletMessageItem } from "../types/walletMessages";
import { SessionPool } from "../nostr/SessionPool";
import type { WalletDmMessage, WalletDmThread } from "./hooks/useDmState";

export const CONTACT_PANEL_HEIGHT = "min(calc(100dvh - 6.5rem), calc(100vh - 6.5rem))";
export const PROFILE_SHARE_CACHE_KEY = "taskify.profileSharePayload.v1";
export const PAYMENT_HISTORY_EVENT_ID_REGEX = /^payment-request-(?:recv|pending)-([a-f0-9]{32,})$/i;
export const CHAT_TIMESTAMP_REVEAL_WIDTH = 92;
export const DM_THREAD_DELETE_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const CHAT_ATTACH_TRAY_MIN_HEIGHT = 248;
export const CHAT_ATTACH_TRAY_MAX_HEIGHT = 380;
export const CHAT_ATTACH_TRAY_FALLBACK_RATIO = 0.38;

export function measureDefaultChatAttachTrayHeight(): number {
  if (typeof window === "undefined") return 300;
  return Math.round(
    Math.min(
      CHAT_ATTACH_TRAY_MAX_HEIGHT,
      Math.max(CHAT_ATTACH_TRAY_MIN_HEIGHT, window.innerHeight * CHAT_ATTACH_TRAY_FALLBACK_RATIO),
    ),
  );
}

export function getWalletMessageStatusLabel(
  type?: WalletMessageItem["type"],
  status?: WalletMessageItem["status"],
): string | null {
  if (status === "accepted") {
    if (type === "board") return "Board added";
    if (type === "contact") return "Contact added";
    if (type === "task") return "Task added";
    return "Added";
  }
  if (status === "deleted") {
    if (type === "board") return "Board dismissed";
    if (type === "contact") return "Contact dismissed";
    if (type === "task") return "Task dismissed";
    return "Dismissed";
  }
  if (status === "tentative") {
    if (type === "task") return "Responded: maybe";
    return "Maybe";
  }
  if (status === "declined") {
    if (type === "task") return "Responded: declined";
    return "Declined";
  }
  return null;
}

export function getCalendarInviteStatusLabel(status?: string | null): string | null {
  if (status === "accepted") return "Event added";
  if (status === "tentative") return "Responded: maybe";
  if (status === "declined") return "Responded: declined";
  if (status === "dismissed") return "Dismissed";
  return null;
}

export type ContactSharePayload = {
  v: 1;
  kind: "nostr" | "custom";
  npub?: string;
  relays?: string[];
  name?: string;
  displayName?: string;
  lud16?: string;
  nip05?: string;
  picture?: string;
};

export function encodeContactPayload(payload: ContactSharePayload): string {
  const json = JSON.stringify(payload);
  try {
    if (typeof btoa === "function") {
      return `taskify:contact:${btoa(unescape(encodeURIComponent(json)))}`;
    }
  } catch {
    // fall through
  }
  return `taskify:contact:${encodeURIComponent(json)}`;
}

export function decodeContactPayload(value: string): ContactSharePayload | null {
  const normalized = value.replace(/^taskify:contact:/i, "");
  let decoded = normalized;
  try {
    if (typeof atob === "function") {
      decoded = decodeURIComponent(escape(atob(normalized)));
    } else {
      decoded = decodeURIComponent(normalized);
    }
  } catch {
    // ignore decode errors
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === "object" && parsed.v === 1) {
      return parsed as ContactSharePayload;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

export function parseProfileContent(content: string): ContactProfile {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return {};
    const pictureRaw =
      typeof (parsed as any).picture === "string"
        ? (parsed as any).picture
        : typeof (parsed as any).image === "string"
          ? (parsed as any).image
          : typeof (parsed as any).avatar === "string"
            ? (parsed as any).avatar
            : undefined;
    return {
      username: typeof (parsed as any).name === "string" ? (parsed as any).name.trim() : undefined,
      displayName:
        typeof (parsed as any).display_name === "string"
          ? (parsed as any).display_name.trim()
          : undefined,
      lud16:
        typeof (parsed as any).lud16 === "string"
          ? (parsed as any).lud16.trim()
          : typeof (parsed as any).lightning_address === "string"
          ? (parsed as any).lightning_address.trim()
          : undefined,
      nip05: typeof (parsed as any).nip05 === "string" ? (parsed as any).nip05.trim() : undefined,
      about: typeof (parsed as any).about === "string" ? (parsed as any).about.trim() : undefined,
      picture: typeof pictureRaw === "string" ? pictureRaw.trim() : undefined,
    };
  } catch {
    return {};
  }
}

export type CachedProfileMetadata = {
  profile: {
    username: string;
    displayName: string;
    lud16: string;
    nip05: string;
    about: string;
    picture: string;
  };
  updatedAt: number | null;
  eventId: string | null;
};

export function normalizeCachedProfileForm(raw: any): CachedProfileMetadata["profile"] | null {
  if (!raw || typeof raw !== "object") return null;
  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  const lud16 = typeof raw.lud16 === "string" ? raw.lud16.trim() : "";
  const nip05 = typeof raw.nip05 === "string" ? raw.nip05.trim() : "";
  const about = typeof raw.about === "string" ? raw.about.trim() : "";
  const picture = typeof raw.picture === "string" ? raw.picture.trim() : "";
  return { username, displayName, lud16, nip05, about, picture };
}

export function readProfileMetadataCache(pubkey: string): CachedProfileMetadata | null {
  if (!pubkey) return null;
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_PROFILE_METADATA_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const cached = (parsed as Record<string, unknown>)[pubkey];
    if (!cached || typeof cached !== "object") return null;
    const profile = normalizeCachedProfileForm((cached as any).profile);
    if (!profile) return null;
    const updatedAt = Number.isFinite((cached as any).updatedAt)
      ? Math.floor((cached as any).updatedAt)
      : null;
    const eventId = typeof (cached as any).eventId === "string" ? (cached as any).eventId : null;
    return { profile, updatedAt, eventId };
  } catch {
    return null;
  }
}

export function persistProfileMetadataCache(pubkey: string, cache: CachedProfileMetadata | null): void {
  if (!pubkey) return;
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_PROFILE_METADATA_CACHE);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
    if (cache) {
      next[pubkey] = cache;
    } else {
      delete next[pubkey];
    }
    idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_PROFILE_METADATA_CACHE, JSON.stringify(next));
  } catch {
    // ignore persistence issues
  }
}

export type CachedContactProfile = { profile: ContactProfile; updatedAt: number; pictureDataUrl?: string };

export function normalizeCachedContactProfile(raw: any): CachedContactProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const updatedAt = Number.isFinite((raw as any).updatedAt) ? Math.floor((raw as any).updatedAt) : 0;
  const profileRaw = (raw as any).profile;
  if (!profileRaw || typeof profileRaw !== "object") return null;
  const normalizeString = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const normalizeOptionalString = (value: unknown) => {
    const normalized = normalizeString(value);
    return normalized || undefined;
  };
  const relays: string[] | undefined = Array.isArray((profileRaw as any).relays)
    ? Array.from(
        new Set<string>(
          (profileRaw as any).relays
            .map((relay: unknown) => (typeof relay === "string" ? relay.trim() : ""))
            .filter(Boolean),
        ),
      )
    : undefined;
  const profile: ContactProfile = {
    username: normalizeOptionalString((profileRaw as any).username),
    displayName: normalizeOptionalString((profileRaw as any).displayName),
    about: normalizeOptionalString((profileRaw as any).about),
    picture: normalizeOptionalString((profileRaw as any).picture),
    lud16: normalizeOptionalString((profileRaw as any).lud16),
    nip05: normalizeOptionalString((profileRaw as any).nip05),
    relays,
  };
  const hasData = Object.values(profile).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!hasData) return null;
  const pictureDataUrlCandidate =
    typeof (raw as any).pictureDataUrl === "string" && (raw as any).pictureDataUrl.trim()
      ? (raw as any).pictureDataUrl.trim()
      : undefined;
  const pictureDataUrl = pictureDataUrlCandidate && isDataUrl(pictureDataUrlCandidate)
    ? pictureDataUrlCandidate
    : undefined;
  return { profile, updatedAt, pictureDataUrl };
}

export function loadContactProfileCache(): Record<string, CachedContactProfile> {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_CONTACT_PROFILE_CACHE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next: Record<string, CachedContactProfile> = {};
    Object.entries(parsed).forEach(([hex, value]) => {
      const normalized = normalizeCachedContactProfile(value);
      if (normalized) {
        next[hex.toLowerCase()] = normalized;
      }
    });
    return next;
  } catch {
    return {};
  }
}

export function persistContactProfileCache(cache: Record<string, CachedContactProfile>): void {
  try {
    idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_CONTACT_PROFILE_CACHE, JSON.stringify(cache));
  } catch {
    // ignore persistence issues
  }
}

export const PROFILE_PHOTO_CACHE_LIMIT_BYTES = 350_000;
export const PROFILE_PHOTO_MAX_DIMENSION = 720;

export function estimateDataUrlSize(value: string): number {
  const parts = value.split(",", 2);
  if (parts.length < 2) return value.length;
  const base64 = parts[1];
  return Math.ceil((base64.length * 3) / 4);
}

export function isDataUrl(value: string): boolean {
  return /^data:image\//i.test(value.trim());
}

export function pickPreferredProfilePhoto(...candidates: Array<string | null | undefined>): string | undefined {
  const normalized = candidates
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  if (!normalized.length) return undefined;
  return normalized.find((value) => isDataUrl(value)) || normalized[0];
}

export function shouldCacheProfilePhoto(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export async function fetchProfilePhotoDataUrl(url: string, timeoutMs = 8000): Promise<string | null> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, { signal: controller?.signal, cache: "force-cache" });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().startsWith("image/")) return null;
    const blob = await response.blob();
    if (!blob || blob.size > PROFILE_PHOTO_CACHE_LIMIT_BYTES) return null;
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = typeof reader.result === "string" ? reader.result : null;
        resolve(result && result.trim() ? result : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    return dataUrl;
  } catch {
    return null;
  } finally {
    if (timer) {
      window.clearTimeout(timer);
    }
  }
}

export function extractDomain(target: string): string {
  try {
    const hostname = new URL(target).hostname;
    return hostname || target;
  } catch {
    return target;
  }
}

export const CHAT_URL_REGEX = /https?:\/\/[^\s<>"'\]()]+/gi;

export function extractUrlsFromText(text: string): string[] {
  return Array.from(text.matchAll(CHAT_URL_REGEX), (m) => m[0]);
}

export function renderFormattedText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /\*\*(.+?)\*\*|`([^`]+)`|https?:\/\/[^\s<>"'\]()]+/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1] !== undefined) {
      // **bold**
      parts.push(<strong key={match.index}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      // `inline code` — tap to copy
      const codeText = match[2];
      parts.push(
        <code
          key={match.index}
          className="chat-inline-code"
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(codeText);
          }}
        >
          {codeText}
        </code>
      );
    } else {
      // URL
      const url = match[0];
      parts.push(
        <a
          key={match.index}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-link"
          onClick={(e) => e.stopPropagation()}
        >
          {url}
        </a>
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const { signal, ...rest } = init;
  if (signal) {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function dmThreadKeyForMessage(message: Pick<WalletDmMessage, "peerPubkey" | "groupId"> | null | undefined): string {
  return ((message?.groupId || message?.peerPubkey || "") as string).trim().toLowerCase();
}

export function dmThreadKeyForThread(thread: Pick<WalletDmThread, "peerPubkey" | "groupId"> | null | undefined): string {
  return ((thread?.groupId || thread?.peerPubkey || "") as string).trim().toLowerCase();
}

/** A calendar invite that arrived by message; the same record the calendar keeps. */
export type PendingCalendarInvite = CalendarInvite;

export type SharedContactPreview = {
  contact: Contact;
  itemId?: string | null;
  status?: WalletMessageItem["status"] | "dismissed" | null;
};

export type NostrEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type NostrIdentity = {
  secret: string;
  pubkey: string;
};

export type NostrIdentityInfo = {
  identity: NostrIdentity | null;
  reason: string | null;
};

export const EMPTY_NOSTR_IDENTITY_INFO: NostrIdentityInfo = { identity: null, reason: null };

export function readStoredNostrIdentity(): NostrIdentityInfo {
  const raw = (revealLocalSecretKey() ?? "").trim();
  if (!raw) {
    return { identity: null, reason: "Add your Taskify Nostr key in Settings → Nostr." };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    return { identity: null, reason: "Nostr secret key must be 64 hexadecimal characters." };
  }
  const normalized = raw.toLowerCase();
  try {
    const pubkey = getPublicKey(hexToBytes(normalized));
    return { identity: { secret: normalized, pubkey }, reason: null };
  } catch {
    return { identity: null, reason: "Invalid Nostr secret key." };
  }
}

export type PublicFollow = {
  pubkey: string;
  relay?: string;
  petname?: string;
  username?: string;
  nip05?: string;
};

export function extractPublicFollowsFromTags(rawTags: any): PublicFollow[] {
  const tags = Array.isArray(rawTags) ? rawTags : [];
  const byPubkey = new Map<string, PublicFollow>();
  tags.forEach((tag) => {
    if (!Array.isArray(tag) || tag[0] !== "p") return;
    const pubkey = typeof tag[1] === "string" ? tag[1].trim() : "";
    if (!pubkey) return;
    const relay = typeof tag[2] === "string" ? tag[2].trim() : "";
    const petname = typeof tag[3] === "string" ? tag[3].trim() : "";
    const key = pubkey.toLowerCase();
    const existing = byPubkey.get(key);
    if (!existing) {
      byPubkey.set(key, { pubkey, relay: relay || undefined, petname: petname || undefined });
      return;
    }
    byPubkey.set(key, {
      pubkey,
      relay: existing.relay || relay || undefined,
      petname: existing.petname || petname || undefined,
      username: existing.username,
      nip05: existing.nip05,
    });
  });
  return Array.from(byPubkey.values());
}

export async function enrichPublicFollowsWithProfiles(
  follows: PublicFollow[],
  relays: string[],
  pool: SessionPool,
  options?: { maxLookups?: number },
): Promise<PublicFollow[]> {
  const maxLookups = typeof options?.maxLookups === "number" ? options.maxLookups : 64;
  const missingPubkeys = follows
    .filter((follow) => !follow.nip05 && !follow.username)
    .slice(0, maxLookups)
    .map((follow) => follow.pubkey);
  if (!missingPubkeys.length) return follows;

  try {
    const metadataEvents = await pool.list(relays, [{ kinds: [0], authors: missingPubkeys }]);
    if (!metadataEvents?.length) return follows;
    const profilesByPubkey = new Map<string, ContactProfile>();
    metadataEvents.forEach((event) => {
      if (!event?.pubkey || typeof event.content !== "string") return;
      try {
        const profile = parseProfileContent(event.content);
        profilesByPubkey.set(event.pubkey.toLowerCase(), profile);
      } catch {
        // ignore malformed profiles
      }
    });
    if (!profilesByPubkey.size) return follows;
    return follows.map((follow) => {
      const profile = profilesByPubkey.get(follow.pubkey.toLowerCase());
      if (!profile) return follow;
      return {
        ...follow,
        username: follow.username || profile.username,
        nip05: follow.nip05 || profile.nip05,
      };
    });
  } catch {
    return follows;
  }
}

export function cachedContactProfileToDmProfile(entry: CachedContactProfile): ContactProfile {
  return {
    ...entry.profile,
    picture: pickPreferredProfilePhoto(entry.pictureDataUrl, entry.profile.picture),
  };
}

export function buildWalletMessageSyntheticEventId(item: WalletMessageItem): string {
  const dmEventId = item.dmEventId?.trim();
  return dmEventId || `wallet-message-${item.id}`;
}

export function buildCalendarInviteSyntheticEventId(invite: PendingCalendarInvite): string {
  const eventId = invite.eventId?.trim();
  return eventId || `calendar-invite-${invite.id}`;
}

