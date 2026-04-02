/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bech32 } from "bech32";
import {
  decodePaymentRequest,
  getDecodedToken,
  getEncodedToken,
  PaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestPayload,
  type PaymentRequestTransport,
  type Proof,
  type ProofState,
} from "@cashu/cashu-ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import QrScannerLib from "qr-scanner";
import { QRCodeCanvas } from "qrcode.react";
import { finalizeEvent, getEventHash, getPublicKey, nip04, nip19, nip44, type EventTemplate } from "nostr-tools";
import { useCashu } from "../context/CashuContext";
import { useNwc } from "../context/NwcContext";
import { useToast } from "../context/ToastContext";
import { useP2PK, type P2PKKey } from "../context/P2PKContext";
import { EcashGlyph } from "./EcashGlyph";
import {
  addMintToList,
  getMintList,
  loadStore,
  listPendingTokens,
  removeMintFromList,
  type PendingTokenEntry,
} from "../wallet/storage";
import {
  assembleNut16FromText,
  containsNut16Frame,
  createNut16Animation,
  Nut16Collector,
  parseNut16FrameString,
} from "../wallet/nut16";
import { encodePeanut, extractPeanutToken } from "../wallet/peanut";
import { decodeBolt11Amount, estimateInvoiceAmountSat, formatMsatAsSat } from "../wallet/lightning";
import {
  LS_LIGHTNING_CONTACTS,
  LS_ECASH_OPEN_REQUESTS,
  LS_SPENT_NOSTR_PAYMENTS,
  LS_BTC_USD_PRICE_CACHE,
  LS_MINT_BACKUP_ENABLED,
  LS_CONTACTS_SYNC_META,
  LS_NIP51_CONTACTS_MIGRATED,
  LS_CONTACT_NIP05_CACHE,
  LS_CONTACT_PROFILE_CACHE,
  LS_DM_BLOCKED_PEERS,
  LS_DM_DELETED_EVENTS,
  LS_PROFILE_EVENT_IDS,
  LS_PROFILE_METADATA_CACHE,
} from "../localStorageKeys";
import { LS_NOSTR_SK } from "../nostrKeys";
import { kvStorage } from "../storage/kvStorage";
import { idbKeyValue } from "../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR, TASKIFY_STORE_WALLET } from "../storage/taskifyDb";
import { DEFAULT_NOSTR_RELAYS } from "../lib/relays";
import { DEFAULT_FILE_STORAGE_SERVER, normalizeFileServerUrl } from "../lib/fileStorage";
import { buildContactShareEnvelope, sendShareMessage, type SharedTaskPayload } from "../lib/shareInbox";
import { normalizeNostrPubkey } from "../lib/nostr";
import {
  fetchLatestPrivateContactsList,
  publishNip51PrivateContactsList,
  type Nip51PrivateContact,
} from "../lib/nip51Contacts";
import { SessionPool } from "../nostr/SessionPool";
import { NostrSession } from "../nostr/NostrSession";
import { loadMyLatestProfileEvent, publishMyProfile } from "../nostr/ProfilePublisher";
import { uploadAvatarToNip96, uploadAvatar } from "../nostr/Nip96Client";
import { parseFileServers, findServerEntry, type FileServerType } from "../lib/fileStorage";
import {
  markHistoryEntrySpentRaw,
  MARK_HISTORY_ENTRIES_OLDER_SPENT_EVENT,
  type MarkHistoryEntriesOldSpentEventDetail,
} from "../lib/walletHistory";
import type { CreateSendTokenOptions } from "../mint/MintSession";
import {
  NpubCashError,
  claimPendingEcashFromNpubCash,
  deriveNpubCashIdentity,
} from "../wallet/npubCash";
import { ActionSheet } from "./ActionSheet";
import type { Contact, ContactProfile, ContactSyncEnvelope } from "../lib/contacts";
import {
  contactDisplayLabel,
  contactHasNpub,
  contactHasLightning,
  contactPrimaryName,
  formatContactNpub,
  formatContactUsername,
  loadContactsFromStorage,
  makeContactId,
  mergeContactsFromSync,
  normalizeContact,
  sanitizeUsername,
  parseContactSyncEnvelope,
  saveContactsToStorage,
} from "../lib/contacts";
import { parseShareEnvelope } from "../lib/shareInbox";
import { COINBASE_SPOT_PRICE_URL } from "../lib/pricing";
import { getWalletSeedMnemonic } from "../wallet/seed";
import {
  createMintBackupTemplate,
  deriveMintBackupKeys,
  loadMintBackupCache,
  MINT_BACKUP_CLIENT_TAG,
  persistMintBackupCache as persistMintBackupCacheToStorage,
  type MintBackupPayload,
} from "../wallet/mintBackup";
import type { WalletMessageItem } from "../types/walletMessages";

type ScanResult = QrScannerLib.ScanResult;

const WALLET_SCAN_TARGET_SIZE = 800;
const WALLET_SCAN_MAX_SCANS_PER_SECOND = 25;

const AnimatedEllipsis = () => {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStep((current) => (current + 1) % 4);
    }, 350);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const dots = step === 0 ? "" : ".".repeat(step);

  return <span className="inline-block w-4 text-left">{dots}</span>;
};

const ShareArrowIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M14.5 6.5 9 10.5l5.5 4" />
    <circle cx="17.5" cy="4.5" r="2.25" />
    <circle cx="17.5" cy="19.5" r="2.25" />
    <circle cx="6.5" cy="12" r="2.25" />
  </svg>
);

const LNURL_DECODE_LIMIT = 2048;
const CONTACT_PANEL_HEIGHT = "min(calc(100dvh - 6.5rem), calc(100vh - 6.5rem))";
const PROFILE_SHARE_CACHE_KEY = "taskify.profileSharePayload.v1";
const HISTORY_ID_TIMESTAMP_REGEX = /(\d{10,})/;
const MINT_QUOTE_SUBSCRIPTION_WINDOW_MS = 60 * 60 * 1000;
const UNPAID_MINT_QUOTE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const PAYMENT_HISTORY_EVENT_ID_REGEX = /^payment-request-(?:recv|pending)-([a-f0-9]{32,})$/i;

function deriveTimestampFromId(value: string): number {
  if (typeof value !== "string" || !value) return Date.now();
  const match = value.match(HISTORY_ID_TIMESTAMP_REGEX);
  if (!match) return Date.now();
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  if (parsed >= 1_000_000_000_000) return parsed;
  return parsed * 1000;
}

function normalizeProofAmount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function sumProofAmounts(proofs: any[]): number {
  if (!Array.isArray(proofs)) return 0;
  return proofs.reduce((sum: number, proof: any) => sum + normalizeProofAmount(proof?.amount), 0);
}

function extractMinibitsPaymentSender(value: string): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  const match = /(?:^|\s)(?:nostr:)?(npub1[0-9a-z]{20,})\s+sent\s+you\b/i.exec(trimmed);
  return match?.[1] ?? null;
}

function normalizeCashuTokenCandidate(value: string): string | null {
  let candidate = (value || "").trim();
  if (!candidate) return null;
  candidate = candidate
    .replace(/^[("'`<\u2018\u2019\u201C\u201D]+/, "")
    .replace(/[)"'`>\u2018\u2019\u201C\u201D]+$/, "");
  candidate = candidate.replace(/\u200b|\u200c|\u200d|\uFEFF/g, "").replace(/\s+/g, "");
  if (!candidate) return null;
  if (/^cashu:/i.test(candidate)) {
    candidate = extractCashuUriPayload(candidate);
    if (!candidate) return null;
    candidate = candidate.replace(/\u200b|\u200c|\u200d|\uFEFF/g, "").replace(/\s+/g, "");
  }
  candidate = candidate.replace(/[)\]}>.,!?;:"'\u2018\u2019\u201C\u201D`]+$/g, "");
  if (!candidate) return null;
  try {
    return getDecodedToken(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function extractFirstCashuTokenFromText(value: string): string | null {
  const text = value || "";
  if (!/cashu/i.test(text)) return null;

  try {
    if (containsNut16Frame(text)) {
      const assembled = assembleNut16FromText(text);
      const normalized = normalizeCashuTokenCandidate(assembled.token);
      if (normalized) return normalized;
    }
  } catch {
    // fall through to regex extraction
  }

  const matches = text.match(/cashu:[^\s]+|cashu[A-Za-z0-9_+/=-]{10,}/gi) ?? [];
  for (const match of matches) {
    const normalized = normalizeCashuTokenCandidate(match);
    if (normalized) return normalized;
  }

  // Some clients wrap long tokens across whitespace/newlines.
  const parts = text.split(/\s+/).filter(Boolean);
  const tokenChunkPattern = /^[A-Za-z0-9_+/=-]{10,}[)\]}>.,!?;:"'\u2018\u2019\u201C\u201D`]*$/;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!/^cashu/i.test(part)) continue;
    let combined = part;
    let normalized = normalizeCashuTokenCandidate(combined);
    if (normalized) return normalized;
    for (let j = i + 1; j < parts.length && j < i + 32; j += 1) {
      const chunk = parts[j]!;
      if (!tokenChunkPattern.test(chunk)) break;
      combined += chunk;
      if (combined.length > 16_384) break;
      normalized = normalizeCashuTokenCandidate(combined);
      if (normalized) return normalized;
    }
  }
  return null;
}

function getWalletMessageStatusLabel(
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

function mintListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type SubsetPathEntry = { prevSum: number; noteIndex: number };

function computeSubsetSelectionInfo(
  notes: { amount: number; secret: string }[],
  target: number,
): {
  exactMatch: string[] | null;
  closestBelow: number | null;
  closestBelowSelection: string[] | null;
  closestAbove: number | null;
  closestAboveSelection: string[] | null;
} {
  const pathMap = new Map<number, SubsetPathEntry | null>();
  pathMap.set(0, null);
  notes.forEach((note, noteIndex) => {
    if (!Number.isFinite(note.amount) || note.amount <= 0) return;
    const normalizedAmount = Math.floor(note.amount);
    if (normalizedAmount <= 0) return;
    const existingSums = Array.from(pathMap.keys()).sort((a, b) => b - a);
    for (const sum of existingSums) {
      const nextSum = sum + normalizedAmount;
      if (pathMap.has(nextSum)) continue;
      pathMap.set(nextSum, { prevSum: sum, noteIndex });
    }
  });

  const positiveSums = Array.from(pathMap.keys())
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  let closestBelow: number | null = null;
  let closestAbove: number | null = null;
  for (const value of positiveSums) {
    if (value <= target) {
      closestBelow = value;
    }
    if (value >= target && closestAbove === null) {
      closestAbove = value;
    }
    if (closestBelow !== null && closestAbove !== null) {
      break;
    }
  }

  const reconstruct = (sum: number | null): string[] | null => {
    if (sum === null) return null;
    if (sum === 0) return [];
    const secrets: string[] = [];
    let current = sum;
    const seen = new Set<number>();
    while (current > 0) {
      if (seen.has(current)) {
        return null;
      }
      seen.add(current);
      const entry = pathMap.get(current);
      if (!entry) {
        return null;
      }
      const note = notes[entry.noteIndex];
      if (!note) {
        return null;
      }
      secrets.push(note.secret);
      current = entry.prevSum;
    }
    return secrets.reverse();
  };

  const exactMatch = pathMap.has(target) ? reconstruct(target) : null;

  return {
    exactMatch,
    closestBelow,
    closestBelowSelection: reconstruct(closestBelow),
    closestAbove,
    closestAboveSelection: reconstruct(closestAbove),
  };
}

function totalForSelection(
  notes: { amount: number; secret: string }[],
  selection: string[] | null | undefined,
): number {
  if (!selection?.length) return 0;
  const amountBySecret = new Map<string, number>();
  notes.forEach((note) => {
    amountBySecret.set(note.secret, note.amount);
  });
  return selection.reduce((sum, secret) => sum + (amountBySecret.get(secret) ?? 0), 0);
}

function decodeLnurlString(lnurl: string): string {
  try {
    const trimmed = lnurl.trim();
    const decoded = bech32.decode(trimmed.toLowerCase(), LNURL_DECODE_LIMIT);
    const bytes = bech32.fromWords(decoded.words);
    return new TextDecoder().decode(Uint8Array.from(bytes));
  } catch {
    throw new Error("Invalid LNURL");
  }
}

function encodeContactPayload(payload: ContactSharePayload): string {
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

function decodeContactPayload(value: string): ContactSharePayload | null {
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

function parseProfileContent(content: string): ContactProfile {
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

type CachedProfileMetadata = {
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

function normalizeCachedProfileForm(raw: any): CachedProfileMetadata["profile"] | null {
  if (!raw || typeof raw !== "object") return null;
  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  const lud16 = typeof raw.lud16 === "string" ? raw.lud16.trim() : "";
  const nip05 = typeof raw.nip05 === "string" ? raw.nip05.trim() : "";
  const about = typeof raw.about === "string" ? raw.about.trim() : "";
  const picture = typeof raw.picture === "string" ? raw.picture.trim() : "";
  return { username, displayName, lud16, nip05, about, picture };
}

function readProfileMetadataCache(pubkey: string): CachedProfileMetadata | null {
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

function persistProfileMetadataCache(pubkey: string, cache: CachedProfileMetadata | null): void {
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

type CachedContactProfile = { profile: ContactProfile; updatedAt: number; pictureDataUrl?: string };

function normalizeCachedContactProfile(raw: any): CachedContactProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const updatedAt = Number.isFinite((raw as any).updatedAt) ? Math.floor((raw as any).updatedAt) : 0;
  const profileRaw = (raw as any).profile;
  if (!profileRaw || typeof profileRaw !== "object") return null;
  const normalizeString = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const normalizeOptionalString = (value: unknown) => {
    const normalized = normalizeString(value);
    return normalized || undefined;
  };
  const relays = Array.isArray((profileRaw as any).relays)
    ? Array.from(
        new Set(
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

function loadContactProfileCache(): Record<string, CachedContactProfile> {
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

function persistContactProfileCache(cache: Record<string, CachedContactProfile>): void {
  try {
    idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_CONTACT_PROFILE_CACHE, JSON.stringify(cache));
  } catch {
    // ignore persistence issues
  }
}

const PROFILE_PHOTO_CACHE_LIMIT_BYTES = 350_000;
const PROFILE_PHOTO_MAX_DIMENSION = 720;

function estimateDataUrlSize(value: string): number {
  const parts = value.split(",", 2);
  if (parts.length < 2) return value.length;
  const base64 = parts[1];
  return Math.ceil((base64.length * 3) / 4);
}

function isDataUrl(value: string): boolean {
  return /^data:image\//i.test(value.trim());
}

function shouldCacheProfilePhoto(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

async function fetchProfilePhotoDataUrl(url: string, timeoutMs = 8000): Promise<string | null> {
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

function normalizeMintUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function extractCashuUriPayload(raw: string): string {
  const rest = raw.replace(/^cashu:/i, "").trim();
  if (!rest) return rest;

  if (rest.startsWith("?")) {
    const params = new URLSearchParams(rest.slice(1));
    const paramCandidate =
      params.get("token") ||
      params.get("cashu") ||
      params.get("proofs") ||
      params.get("t") ||
      params.get("payment_request") ||
      params.get("request") ||
      params.get("pr");
    if (paramCandidate) {
      return paramCandidate.trim();
    }
    return rest;
  }

  const keyValueMatch = rest.match(/(?:^|[?&])(token|cashu|proofs|t|payment_request|request|pr)=([^&]+)/i);
  if (keyValueMatch?.[2]) {
    return keyValueMatch[2].trim();
  }

  if (rest.startsWith("//")) {
    const withoutScheme = rest.replace(/^\/+/, "");
    const tryParse = () => {
      const url = new URL(`https://${withoutScheme}`);
      const paramCandidate =
        url.searchParams.get("token") ||
        url.searchParams.get("cashu") ||
        url.searchParams.get("proofs") ||
        url.searchParams.get("t") ||
        url.searchParams.get("payment_request") ||
        url.searchParams.get("request") ||
        url.searchParams.get("pr");
      if (paramCandidate) {
        return paramCandidate.trim();
      }
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length) {
        return segments[segments.length - 1]!.trim();
      }
      return withoutScheme;
    };

    try {
      return tryParse();
    } catch {
      const parts = withoutScheme.split("/").filter(Boolean);
      if (parts.length) {
        return parts[parts.length - 1]!.trim();
      }
      return withoutScheme;
    }
  }

  return rest;
}

function extractDomain(target: string): string {
  try {
    const hostname = new URL(target).hostname;
    return hostname || target;
  } catch {
    return target;
  }
}

function formatLightningAddressDisplay(address: string, baseMaxLength = 32): string {
  const ellipsis = "…";
  if (address.length <= baseMaxLength) return address;
  const atIndex = address.indexOf("@");
  if (atIndex <= 0) {
    return `${address.slice(0, baseMaxLength - 1)}${ellipsis}`;
  }

  const localPart = address.slice(0, atIndex);
  const domainPartWithAt = address.slice(atIndex);
  const dynamicMaxLength = Math.max(baseMaxLength, domainPartWithAt.length + 6);
  if (address.length <= dynamicMaxLength) return address;

  const maxLocalLength = Math.max(3, dynamicMaxLength - domainPartWithAt.length - ellipsis.length);
  return `${localPart.slice(0, maxLocalLength)}${ellipsis}${domainPartWithAt}`;
}

function capitalizeWords(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatMintDisplayName(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, "");
    const hostParts = hostname.split(".").filter(Boolean);
    const hostLabel = hostParts
      .slice(Math.max(0, hostParts.length - 2))
      .map((part) => capitalizeWords(part.replace(/[-_]+/g, " ")))
      .join(" ");
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = pathSegments.length ? decodeURIComponent(pathSegments[pathSegments.length - 1]!) : "";
    if (lastSegment) {
      const formattedSegment = capitalizeWords(lastSegment.replace(/[-_]+/g, " "));
      return `${hostLabel || hostname} • ${formattedSegment}`.trim();
    }
    return hostLabel || hostname || url;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}

function trimMintUrlScheme(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
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

function generatePrivateKey(): { hex: string; bytes: Uint8Array } {
  let bytes: Uint8Array;
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
  } else {
    bytes = secp256k1.utils.randomPrivateKey();
  }
  const hex = bytesToHex(bytes);
  return { hex, bytes };
}

function randomPastTimestampSeconds(maxOffsetSeconds = 2 * 24 * 60 * 60): number {
  const now = Math.floor(Date.now() / 1000);
  const offset = Math.floor(Math.random() * maxOffsetSeconds);
  return Math.max(0, now - offset);
}

function LockIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="5" y="9" width="10" height="7" rx="2" />
      <path d="M7.5 9V7a2.5 2.5 0 0 1 5 0v2" />
      <circle cx="10" cy="12.5" r="1" />
    </svg>
  );
}

function ChevronDownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M5.5 8.5 10 13l4.5-4.5" />
    </svg>
  );
}

function BackIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="m14.75 6.75-6 5.25 6 5.25" />
    </svg>
  );
}

function PencilIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L8.032 18.62a3.75 3.75 0 0 1-1.579 0.942l-2.469 0.74 0.74-2.47a3.75 3.75 0 0 1 0.943-1.578L16.862 4.487Z" />
      <path d="M16.862 4.487 19.5 7.125" />
    </svg>
  );
}

function CloseIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}

function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m6 12 4.5 4.5L18 8" />
    </svg>
  );
}

function VerifiedBadgeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l.967 2.329a1.125 1.125 0 0 0 1.304.674l2.457-.624c1.119-.285 2.114.71 1.829 1.829l-.624 2.457a1.125 1.125 0 0 0 .674 1.304l2.329.967c1.077.448 1.077 1.976 0 2.424l-2.329.967a1.125 1.125 0 0 0-.674 1.304l.624 2.457c.285 1.119-.71 2.114-1.829 1.829l-2.457-.624a1.125 1.125 0 0 0-1.304.674l-.967 2.329c-.448 1.077-1.976 1.077-2.424 0l-.967-2.329a1.125 1.125 0 0 0-1.304-.674l-2.457.624c-1.119.285-2.114-.71-1.829-1.829l.624-2.457a1.125 1.125 0 0 0-.674-1.304l-2.329-.967c-1.077-.448-1.077-1.976 0-2.424l2.329-.967a1.125 1.125 0 0 0 .674-1.304l-.624-2.457c-.285-1.119.71-2.114 1.829-1.829l2.457.624a1.125 1.125 0 0 0 1.304-.674l.967-2.329Z"
      />
      <path
        d="m9.4 12.75 1.9 1.9 3.85-3.85"
        fill="none"
        stroke="var(--surface-base)"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PersonIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <circle cx="12" cy="8.25" r="3.25" />
      <path d="M5.5 19c.25-3.2 3.1-5 6.5-5s6.25 1.8 6.5 5" />
    </svg>
  );
}

type LnurlPayData = {
  lnurl: string;
  callback: string;
  domain: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed: number;
  metadata?: string;
};

type LnurlWithdrawData = {
  lnurl: string;
  callback: string;
  domain: string;
  k1: string;
  minWithdrawable: number;
  maxWithdrawable: number;
  defaultDescription?: string;
};

type WalletDmAttachment =
  | {
      type: "board";
      boardName?: string | null;
      boardId?: string | null;
      taskId?: string | null;
      status?: string | null;
    }
  | {
      type: "contact";
      contactName?: string | null;
      displayName?: string | null;
      username?: string | null;
      npub?: string | null;
      nip05?: string | null;
      address?: string | null;
      picture?: string | null;
      taskId?: string | null;
      status?: string | null;
    }
  | {
      type: "task";
      task?: SharedTaskPayload | null;
      taskId?: string | null;
      status?: string | null;
    }
  | { type: "payment"; amountSat?: number | null; detail?: string | null; raw?: string | null }
  | { type: "text" };

type DecryptedNostrDm = {
  content: string;
  senderPubkey?: string | null;
  recipientPubkey?: string | null;
  recipientPubkeys?: string[] | null;
};

type WalletDmMessage = {
  id: string;
  eventId: string;
  peerPubkey: string;
  isIncoming: boolean;
  createdAt: number;
  content: string;
  preview: string;
  attachment?: WalletDmAttachment;
};

type WalletDmThread = {
  peerPubkey: string;
  messages: WalletDmMessage[];
  lastCreatedAt: number;
  lastPreview: string;
  isStranger: boolean;
};

type ContactViewMode = "list" | "detail" | "edit";

type ContactEditDraft = {
  id: string | null;
  name: string;
  displayName: string;
  username: string;
  address: string;
  npub: string;
  nip05: string;
  about: string;
  picture: string;
  isProfile?: boolean;
};

type Nip05CheckState = {
  status: "pending" | "valid" | "invalid";
  nip05: string;
  npub: string;
  checkedAt: number;
  contactUpdatedAt: number | null;
};

type NostrEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

type IncomingPaymentRequest = {
  eventId: string;
  id?: string | null;
  token: string;
  amount: number;
  mint: string;
  unit: string;
  sender: string;
  receivedAt: number;
  fingerprint?: string | null;
};

type ActivePaymentRequest = {
  id: string;
  encoded: string;
  request: PaymentRequest;
  amountSat?: number;
  lockPubkey?: string | null;
};

function isSamePaymentRequest(
  a: ActivePaymentRequest | null | undefined,
  b: ActivePaymentRequest | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    a.encoded === b.encoded &&
    (a.lockPubkey ?? null) === (b.lockPubkey ?? null) &&
    (a.amountSat ?? null) === (b.amountSat ?? null) &&
    a.request.singleUse === b.request.singleUse
  );
}

type NormalizedIncomingPayment = {
  token: string;
  amount: number;
  mint: string;
  unit: string;
};

type NostrIdentity = {
  secret: string;
  pubkey: string;
};

type PublicFollow = {
  pubkey: string;
  relay?: string;
  petname?: string;
  username?: string;
  nip05?: string;
};

type ContactSyncMeta = {
  lastEventId: string | null;
  lastUpdatedAt: number | null;
  fingerprint: string | null;
  publicFollows: PublicFollow[];
};

type ContactSharePayload = {
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

function loadNip05Cache(): Record<string, Nip05CheckState> {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_CONTACT_NIP05_CACHE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const entries: Record<string, Nip05CheckState> = {};
    Object.entries(parsed as Record<string, any>).forEach(([key, value]) => {
      if (!value || typeof value !== "object") return;
      const status = (value as any).status;
      const nip05 = typeof (value as any).nip05 === "string" ? (value as any).nip05 : "";
      const npub = typeof (value as any).npub === "string" ? (value as any).npub : "";
      const checkedAt = Number((value as any).checkedAt) || 0;
      const contactUpdatedAtRaw = Number((value as any).contactUpdatedAt);
      if (!nip05 || !npub) return;
      if (status !== "pending" && status !== "valid" && status !== "invalid") return;
      entries[key] = {
        status,
        nip05,
        npub,
        checkedAt: checkedAt || Date.now(),
        contactUpdatedAt: Number.isFinite(contactUpdatedAtRaw) ? contactUpdatedAtRaw : null,
      };
    });
    return entries;
  } catch {
    return {};
  }
}

function isMintTokenAlreadySpentError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const anyErr = err as Record<string, unknown>;
  const code = anyErr?.code;
  if (typeof code === "number" && code === 11001) {
    return true;
  }
  if (typeof code === "string") {
    const parsed = Number.parseInt(code, 10);
    if (Number.isFinite(parsed) && parsed === 11001) {
      return true;
    }
  }
  const detail = typeof anyErr?.detail === "string" ? anyErr.detail.toLowerCase() : "";
  if (detail.includes("already spent")) {
    return true;
  }
  const message = typeof anyErr?.message === "string" ? anyErr.message.toLowerCase() : "";
  if (message.includes("already spent")) {
    return true;
  }
  const responseData =
    typeof anyErr?.response === "object" && anyErr?.response !== null
      ? (anyErr.response as Record<string, unknown>).data
      : null;
  if (responseData && typeof responseData === "object") {
    const dataCode = (responseData as Record<string, unknown>).code;
    if (typeof dataCode === "number" && dataCode === 11001) {
      return true;
    }
    if (typeof dataCode === "string") {
      const parsed = Number.parseInt(dataCode, 10);
      if (Number.isFinite(parsed) && parsed === 11001) {
        return true;
      }
    }
    const dataDetail = (responseData as Record<string, unknown>).detail;
    if (typeof dataDetail === "string" && dataDetail.toLowerCase().includes("already spent")) {
      return true;
    }
  }
  return false;
}

function normalizePublicFollow(raw: any): PublicFollow | null {
  if (!raw || typeof raw !== "object") return null;
  const pubkey = typeof raw.pubkey === "string" ? raw.pubkey.trim() : "";
  const relay = typeof raw.relay === "string" ? raw.relay.trim() : "";
  const petname = typeof raw.petname === "string" ? raw.petname.trim() : "";
  const username = typeof raw.username === "string" ? sanitizeUsername(raw.username) : "";
  const nip05 = typeof raw.nip05 === "string" ? raw.nip05.trim() : "";
  if (!pubkey) return null;
  return {
    pubkey,
    relay: relay || undefined,
    petname: petname || undefined,
    username: username || undefined,
    nip05: nip05 || undefined,
  };
}

function normalizePublicFollowsList(raw: any): PublicFollow[] {
  const list = Array.isArray(raw) ? raw : [];
  const byPubkey = new Map<string, PublicFollow>();
  list.forEach((entry) => {
    const normalized = normalizePublicFollow(entry);
    if (!normalized) return;
    const key = normalized.pubkey.toLowerCase();
    const existing = byPubkey.get(key);
    if (!existing) {
      byPubkey.set(key, normalized);
      return;
    }
    byPubkey.set(key, {
      pubkey: normalized.pubkey,
      relay: normalized.relay || existing.relay,
      petname: normalized.petname || existing.petname,
      username: normalized.username || existing.username,
      nip05: normalized.nip05 || existing.nip05,
    });
  });
  return Array.from(byPubkey.values());
}

function extractPublicFollowsFromTags(rawTags: any): PublicFollow[] {
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

async function enrichPublicFollowsWithProfiles(
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

const SATS_PER_BTC = 100_000_000;
const BACKGROUND_REFRESH_INTERVAL_MS = 300_000;
const PRICE_REFRESH_MS = BACKGROUND_REFRESH_INTERVAL_MS;
const PRICE_REFRESH_STAGGER_MS = 0;
const NPUB_CASH_REFRESH_STAGGER_MS = 20_000;
const TOKEN_STATE_BACKGROUND_STAGGER_MS = 60_000;
const TOKEN_STATE_BACKGROUND_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_RETRY_DELAY_MS = 300_000;
const PROOF_STATE_VALUES = ["UNSPENT", "PENDING", "SPENT"] as const;
type ProofStateValue = (typeof PROOF_STATE_VALUES)[number];
const KNOWN_PROOF_STATES = new Set<ProofStateValue>(PROOF_STATE_VALUES);

function computeProofY(secret: string): string | null {
  try {
    if (!secret) return null;
    return secp256k1.ProjectivePoint.hashToCurve(new TextEncoder().encode(secret)).toHex(true);
  } catch {
    return null;
  }
}

function sanitizeProofStateValue(state: string | null | undefined): ProofStateValue | undefined {
  if (!state) return undefined;
  const normalized = state.trim().toUpperCase();
  return KNOWN_PROOF_STATES.has(normalized as ProofStateValue)
    ? (normalized as ProofStateValue)
    : undefined;
}

function aggregateStoredProofStates(proofs: Array<{ lastState?: ProofStateValue }>): ProofStateValue | undefined {
  const values = proofs
    .map((proof) => proof.lastState)
    .filter((state): state is ProofStateValue => !!state && KNOWN_PROOF_STATES.has(state));
  if (!values.length) return undefined;
  const unique = new Set(values);
  if (unique.size === 1) {
    const [only] = Array.from(unique);
    return only;
  }
  if (unique.has("PENDING")) return "PENDING";
  if (unique.has("SPENT") && unique.has("UNSPENT")) return "PENDING";
  return undefined;
}

function summarizeStoredProofStates(proofs: Array<{ lastState?: ProofStateValue }>): string {
  const counts = new Map<ProofStateValue, number>();
  for (const proof of proofs) {
    const state = proof.lastState;
    if (!state || !KNOWN_PROOF_STATES.has(state)) continue;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  if (!counts.size) return "";
  return Array.from(counts.entries())
    .map(([state, count]) => (count > 1 ? `${state} ×${count}` : state))
    .join(", ");
}

function buildTokenSpentToastMessage(proofs: Array<{ amount?: number | null }>): string {
  const totalSat = proofs.reduce(
    (sum, proof) => sum + (typeof proof.amount === "number" ? proof.amount : 0),
    0,
  );
  if (totalSat > 0) {
    return `sent ${totalSat} sat${totalSat === 1 ? "" : "s"}`;
  }
  const count = proofs.length;
  const tokenLabel = `ecash token${count === 1 ? "" : "s"}`;
  return `${tokenLabel} spent`;
}

function extractWitnesses(states: ProofState[]): Record<string, string> | undefined {
  const collected: Record<string, string> = {};
  for (const entry of states) {
    if (entry.witness) {
      collected[entry.Y] = entry.witness;
    }
  }
  return Object.keys(collected).length ? collected : undefined;
}

function shouldSuppressProofStateChecks(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const anyError = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown; response?: { status?: unknown } };
  const rawStatus = typeof anyError.status === "number" ? anyError.status : typeof anyError.response?.status === "number" ? anyError.response.status : null;
  const status = typeof rawStatus === "number" ? rawStatus : null;
  const code = typeof anyError.code === "number" ? anyError.code : null;
  const name = typeof anyError.name === "string" ? anyError.name : "";
  const message = typeof anyError.message === "string" ? anyError.message : "";
  if (status === 400 || status === 404) return true;
  if (code === 11001 || code === 11002) return true;
  if (name.toLowerCase().includes("mintoperationerror")) return true;
  if (message && /unknown proof/i.test(message)) return true;
  return false;
}

function QrCodeCard({
  value,
  label,
  copyLabel = "Copy",
  extraActions,
  size = 320,
  className,
  hideLabel = false,
  flat = false,
  enableNut16Animation = false,
  hideCopyButton = false,
}: {
  value: string;
  label?: string;
  copyLabel?: string;
  extraActions?: React.ReactNode;
  size?: number;
  className?: string;
  hideLabel?: boolean;
  flat?: boolean;
  enableNut16Animation?: boolean;
  hideCopyButton?: boolean;
}) {
  const trimmed = value?.trim();
  const [animSpeed, setAnimSpeed] = useState<"S" | "M" | "F">("F");
  const [animDensity, setAnimDensity] = useState<"S" | "M" | "L">("L");
  const [copied, setCopied] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const animation = useMemo(() => {
    if (!enableNut16Animation) return null;
    const chunkSizeMap: Record<typeof animDensity, number> = { S: 140, M: 200, L: 260 };
    const intervalMap: Record<typeof animSpeed, number> = { F: 30, M: 60, S: 90 };
    return createNut16Animation(trimmed, {
      chunkSize: chunkSizeMap[animDensity],
      intervalMs: intervalMap[animSpeed],
    });
  }, [enableNut16Animation, trimmed, animSpeed, animDensity]);
  const animationKey = animation
    ? `${animation.version}:${animation.digest}:${animation.frames.length}`
    : trimmed;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    setFrameIndex(0);
  }, [animationKey]);

  useEffect(() => {
    if (!animation || animation.frames.length <= 1) return;
    const { frames, intervalMs } = animation;
    const delay = Math.max(250, Number.isFinite(intervalMs) ? intervalMs : 450);
    const timer = setInterval(() => {
      setFrameIndex((idx) => (idx + 1) % frames.length);
    }, delay);
    return () => clearInterval(timer);
  }, [animation]);

  if (!trimmed) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(trimmed);
      setCopied(true);
    } catch (e) {
      console.warn("Copy failed", e);
      setCopied(false);
    }
  }

  const classes = ["wallet-qr-card"];
  if (flat) classes.push("wallet-qr-card--flat");
  if (className) classes.push(className);

  const currentFrame = animation
    ? animation.frames[Math.min(frameIndex, Math.max(animation.frames.length - 1, 0))]
    : null;
  const qrValue = currentFrame?.value ?? trimmed;

  const qrByteLength = (() => {
    if (!qrValue) return 0;
    try {
      return typeof TextEncoder !== "undefined"
        ? new TextEncoder().encode(qrValue).length
        : qrValue.length;
    } catch (error) {
      console.warn("Failed to measure QR payload", error);
      return qrValue.length;
    }
  })();

  const isQrTooLong = qrByteLength > 2953;

  const showControls = !!animation && animation.frames.length > 1;

  return (
    <div className={classes.join(" ")}>
      {(showControls || (!hideLabel && label)) && (
        <div className="wallet-qr-card__header">
          {!hideLabel && label && <div className="wallet-qr-card__label">{label}</div>}
          {showControls && (
            <div className="wallet-qr-card__controls wallet-qr-card__controls--compact">
              <button
                type="button"
                className="wallet-qr-card__control-pill"
                onClick={() => setAnimSpeed((prev) => (prev === "S" ? "M" : prev === "M" ? "F" : "S"))}
                aria-label={`QR speed ${animSpeed}`}
              >
                Speed: {animSpeed}
              </button>
              <button
                type="button"
                className="wallet-qr-card__control-pill"
                onClick={() => setAnimDensity((prev) => (prev === "S" ? "M" : prev === "M" ? "L" : "S"))}
                aria-label={`QR size ${animDensity}`}
              >
                Size: {animDensity}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="wallet-qr-card__code" aria-live="polite">
        <div className="wallet-qr-card__canvas" aria-hidden={isQrTooLong ? undefined : true}>
          {isQrTooLong ? (
            <div className="wallet-qr-card__fallback" role="status">
              QR code unavailable
            </div>
          ) : (
            <QRCodeCanvas value={qrValue} size={size} includeMargin={false} className="wallet-qr-card__qr" />
          )}
        </div>
      </div>
      {isQrTooLong && (
        <div className="wallet-qr-card__helper" role="status">
          This code is too long to display as a QR code. Use the copy button to share it instead.
        </div>
      )}
      <div className="wallet-qr-card__actions">
        {extraActions}
        {!hideCopyButton && (
          <button
            className="ghost-button button-sm pressable"
            onClick={handleCopy}
            aria-label={`Copy ${(label || "code").toLowerCase()}`}
          >
            {copied ? "Copied" : copyLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function QrScanner({ active, onDetected, onError }: { active: boolean; onDetected: (value: string) => boolean | Promise<boolean>; onError?: (message: string) => void; }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScannerLib | null>(null);
  const stopRequestedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const reportError = useCallback((message: string) => {
    setError(message);
    if (onError) onError(message);
  }, [onError]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const calculateScanRegion = useCallback((video: HTMLVideoElement) => {
    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    if (!width || !height) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const shortSide = Math.min(width, height);
    const targetSize = Math.min(WALLET_SCAN_TARGET_SIZE, shortSide);
    const scale = Math.min(targetSize / shortSide, 1);
    return {
      x: 0,
      y: 0,
      width,
      height,
      downScaledWidth: Math.round(width * scale),
      downScaledHeight: Math.round(height * scale),
    };
  }, []);

  const stopScanner = useCallback(() => {
    const scanner = scannerRef.current;
    if (scanner) {
      try {
        scanner.stop();
      } catch (err) {
        console.warn("Failed to stop scanner", err);
      }
      scanner.destroy();
      scannerRef.current = null;
    }
    const video = videoRef.current;
    if (video && video.srcObject instanceof MediaStream) {
      video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!active) {
      stopRequestedRef.current = true;
      stopScanner();
      clearError();
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    stopRequestedRef.current = false;
    let cancelled = false;

    async function start() {
      try {
        clearError();
        const scanner = new QrScannerLib(
          video,
          async (result: ScanResult) => {
            const value = result?.data?.trim();
            if (!value || stopRequestedRef.current) return;
            try {
              const shouldClose = await onDetected(value);
              if (shouldClose) {
                stopRequestedRef.current = true;
                stopScanner();
              }
            } catch (err) {
              console.warn("QR handler failed", err);
            }
          },
          {
            returnDetailedScanResult: true,
            highlightScanRegion: false,
            highlightCodeOutline: false,
            calculateScanRegion,
            preferredCamera: "environment",
            maxScansPerSecond: WALLET_SCAN_MAX_SCANS_PER_SECOND,
            onDecodeError: (err) => {
              if (typeof err === "string" && err === QrScannerLib.NO_QR_CODE_FOUND) return;
            },
          }
        );

        video.setAttribute("playsinline", "true");
        video.setAttribute("muted", "true");
        video.setAttribute("autoplay", "true");
        video.playsInline = true;
        video.muted = true;

        scannerRef.current = scanner;
        await scanner.start();
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        reportError(message || "Unable to access camera");
        stopScanner();
      }
    }

    start();

    return () => {
      cancelled = true;
      stopRequestedRef.current = true;
      stopScanner();
    };
  }, [active, onDetected, reportError, stopScanner, clearError, calculateScanRegion]);

  return (
    <div className="wallet-scanner space-y-3">
      <div className={`wallet-scanner__viewport${error ? " wallet-scanner__viewport--error" : ""}`}>
        {error ? (
          <div className="wallet-scanner__fallback">{error}</div>
        ) : (
          <>
            <video ref={videoRef} className="wallet-scanner__video" playsInline muted />
          </>
        )}
        {!error && <div className="wallet-scanner__guide" aria-hidden="true" />}
      </div>
      <div className="wallet-scanner__hint text-xs text-secondary text-center">
        {error ? "Camera unavailable. Try entering the code manually." : "Point your camera at a QR code to scan."}
      </div>
    </div>
  );
}

function LightningGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="11 2 4 11 9 11 7 18 14 9 9 9 11 2" />
    </svg>
  );
}

function WalletGlyphIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="8" y1="16" x2="16" y2="16" />
      <line x1="12" y1="2.75" x2="12" y2="5.25" />
      <line x1="12" y1="18.75" x2="12" y2="21.25" />
    </svg>
  );
}

function ChatBubbleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="3.5" y="6" width="17" height="12" rx="2" ry="2" />
      <path d="M4 8l8 5 8-5" />
    </svg>
  );
}

function formatShortDate(tsSeconds: number): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return "";
  const date = new Date(tsSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  if (sameYear) return `${month}-${day}`;
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatDmDay(tsSeconds: number): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return "";
  const date = new Date(tsSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDmTime(tsSeconds: number): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return "";
  const date = new Date(tsSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function truncatePreview(value: string, limit = 72): string {
  const trimmed = (value || "").trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

function shortenNpubDisplay(npub: string | null | undefined, lead = 8, tail = 6): string {
  if (!npub) return "";
  const value = npub.trim();
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function tryParseJson<T = any>(value: string | null | undefined): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export default function CashuWalletModal({
  open,
  onClose,
  onOpenBounties,
  page = "wallet",
  showTabSwitcher = true,
  showBottomNav = false,
  walletConversionEnabled,
  walletPrimaryCurrency,
  setWalletPrimaryCurrency,
  npubCashLightningAddressEnabled,
  npubCashAutoClaim,
  sentTokenStateChecksEnabled,
  paymentRequestsEnabled,
  paymentRequestsBackgroundChecksEnabled,
  tokenStateResetNonce,
  mintBackupEnabled: mintBackupEnabledProp,
  contactsSyncEnabled,
  fileStorageServer,
  fileServers,
  messageItems,
  onAcceptMessage,
  onMaybeMessage,
  onDeclineMessage,
  onDismissMessage,
  onMarkMessagesRead,
}: {
  open: boolean;
  onClose: () => void;
  onOpenBounties?: () => void;
  page?: "wallet" | "contacts";
  showTabSwitcher?: boolean;
  showBottomNav?: boolean;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  setWalletPrimaryCurrency: (currency: "sat" | "usd") => void;
  npubCashLightningAddressEnabled: boolean;
  npubCashAutoClaim: boolean;
  sentTokenStateChecksEnabled: boolean;
  paymentRequestsEnabled: boolean;
  paymentRequestsBackgroundChecksEnabled: boolean;
  tokenStateResetNonce: number;
  mintBackupEnabled: boolean;
  contactsSyncEnabled: boolean;
  fileStorageServer: string;
  fileServers?: string;
  messageItems: WalletMessageItem[];
  messagesUnreadCount: number;
  onAcceptMessage: (id: string) => void;
  onMaybeMessage: (id: string) => void;
  onDeclineMessage: (id: string) => void;
  onDismissMessage: (id: string) => void;
  onMarkMessagesRead: (dmEventIds: string[]) => void;
}) {
  const walletDebugEnabled = import.meta.env.DEV && (() => {
    try {
      return kvStorage.getItem("taskify.wallet.debug") === "1";
    } catch {
      return false;
    }
  })();
  const nip17TimestampMode: "random" | "now" = (() => {
    try {
      const value = (kvStorage.getItem("taskify.nip17.timestamp") || "").trim().toLowerCase();
      return value === "now" ? "now" : "random";
    } catch {
      return "random";
    }
  })();

  useEffect(() => {
    if (!open) return;
    if (!walletDebugEnabled) return;
    console.debug("[wallet] CashuWalletModal render start");
  }, [open, walletDebugEnabled]);
  const {
    mintUrl,
    setMintUrl,
    totalBalance,
    pendingBalance,
    info,
    proofs,
    createMintInvoice,
    checkMintQuote,
    claimMint,
    savePendingTokenForRedemption,
    receiveToken,
    createSendToken,
    payInvoice: payMintInvoice,
    checkProofStates,
    subscribeProofStateUpdates,
    subscribeMintQuoteUpdates,
    createTokenFromProofSelection,
    redeemPendingToken,
  } = useCashu();
  const { status: nwcStatus, connection: nwcConnection, info: nwcInfo, lastError: nwcError, connect: connectNwc, disconnect: disconnectNwc, refreshInfo: refreshNwcInfo, getBalanceMsat: getNwcBalanceMsat, payInvoice: payWithNwc, makeInvoice: makeNwcInvoice } = useNwc();
  const { show: showToast } = useToast();
  const {
    keys: p2pkKeys,
    primaryKey: primaryP2pkKey,
    setPrimaryKey: setPrimaryP2pkKey,
    generateKeypair: generateP2pkKeypair,
  } = useP2PK();

  const sortedP2pkKeys = useMemo(() => {
    return [...p2pkKeys].sort((a, b) => {
      const labelA = (a.label || "").toLowerCase();
      const labelB = (b.label || "").toLowerCase();
      if (labelA && labelB && labelA !== labelB) return labelA.localeCompare(labelB);
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return a.publicKey.localeCompare(b.publicKey);
    });
  }, [p2pkKeys]);

  const activeP2pkKey: P2PKKey | null = useMemo(() => {
    return primaryP2pkKey ?? sortedP2pkKeys[0] ?? null;
  }, [primaryP2pkKey, sortedP2pkKeys]);

  type StoredProofForState = Pick<Proof, "secret" | "amount" | "id" | "C" | "witness"> & {
    Y?: string | null;
    lastState?: ProofStateValue;
  };

  interface HistoryMintQuoteInfo {
    quote: string;
    amount: number;
    request?: string;
    mintUrl?: string;
    createdAt?: number;
    expiresAt?: number;
    state?: string;
    suppressChecks?: boolean;
    lastError?: string;
    lastErrorAt?: number;
    errorCount?: number;
  }

  interface HistoryTokenState {
    mintUrl: string;
    proofs: StoredProofForState[];
    lastState?: ProofStateValue;
    lastSummary?: string;
    lastCheckedAt?: number;
    lastWitnesses?: Record<string, string>;
    notifiedSpent?: boolean;
    suppressChecks?: boolean;
    lastError?: string;
    lastErrorAt?: number;
    errorCount?: number;
  }

  type HistoryEntryType = "lightning" | "ecash";
  type HistoryEntryDirection = "in" | "out";
  type HistoryDetailKind = "token" | "invoice" | "note";
  type HistoryEntryKind = "bounty-attachment";

  function markHistoryTokenStateSpent(tokenState: HistoryTokenState, timestamp: number): HistoryTokenState {
    const nextProofs = tokenState.proofs.map((proof) =>
      proof.lastState === "SPENT" ? proof : { ...proof, lastState: "SPENT" as const },
    );
    const nextTokenState: HistoryTokenState = {
      ...tokenState,
      proofs: nextProofs,
      lastState: "SPENT",
      lastSummary: tokenState.lastSummary || "SPENT",
      lastCheckedAt: timestamp,
      notifiedSpent: true,
      suppressChecks: true,
    };
    delete (nextTokenState as Partial<HistoryTokenState>).lastError;
    delete (nextTokenState as Partial<HistoryTokenState>).lastErrorAt;
    delete (nextTokenState as Partial<HistoryTokenState>).errorCount;
    return nextTokenState;
  }

  function deriveSpentHistoryTokenStateFromToken(token: string, timestamp: number): HistoryTokenState | undefined {
    const derived = deriveHistoryTokenStateFromToken(token);
    if (!derived) return undefined;
    return markHistoryTokenStateSpent(derived, timestamp);
  }
  const markHistoryTokenStateSpentRef = useRef(markHistoryTokenStateSpent);
  markHistoryTokenStateSpentRef.current = markHistoryTokenStateSpent;
  const deriveSpentHistoryTokenStateFromTokenRef = useRef(deriveSpentHistoryTokenStateFromToken);
  deriveSpentHistoryTokenStateFromTokenRef.current = deriveSpentHistoryTokenStateFromToken;

  function deriveHistoryTokenStateFromToken(token: string): HistoryTokenState | undefined {
    const trimmed = typeof token === "string" ? token.trim() : "";
    if (!trimmed) return undefined;
    try {
      const decoded: any = getDecodedToken(trimmed);
      const tokenEntries: any[] = Array.isArray(decoded?.token)
        ? decoded.token
        : decoded?.proofs
          ? [decoded]
          : [];
      for (const entry of tokenEntries) {
        const mint = typeof entry?.mint === "string" ? normalizeMintUrl(entry.mint) : null;
        const proofsRaw = Array.isArray(entry?.proofs) ? entry.proofs : [];
        const storedProofs = proofsRaw
          .map((proof: any) => {
            if (!proof || typeof proof !== "object") return null;
            const secret = typeof proof.secret === "string" ? proof.secret : null;
            const id = typeof proof.id === "string" ? proof.id : null;
            const C = typeof proof.C === "string" ? proof.C : null;
            if (!secret || !id || !C) return null;
            const stored: StoredProofForState = {
              secret,
              id,
              C,
              amount: normalizeProofAmount(proof.amount),
            };
            if (typeof proof.witness === "string" && proof.witness) {
              stored.witness = proof.witness;
            }
            const computed = typeof proof.Y === "string" && proof.Y ? proof.Y : computeProofY(secret);
            if (computed) stored.Y = computed;
            const proofState =
              typeof proof.lastState === "string" && proof.lastState
                ? sanitizeProofStateValue(proof.lastState.toUpperCase())
                : undefined;
            if (proofState) stored.lastState = proofState;
            return stored;
          })
          .filter((proof): proof is StoredProofForState => !!proof);
        if (!mint || !storedProofs.length) continue;
        return {
          mintUrl: mint,
          proofs: storedProofs,
          lastState: aggregateStoredProofStates(storedProofs) ?? "UNSPENT",
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  function isCashuTokenDetail(detail: string | undefined, detailKind?: HistoryDetailKind): boolean {
    if (!detail) return false;
    if (detailKind === "token") return true;
    const trimmed = detail.trim();
    if (!trimmed) return false;
    if (containsNut16Frame(trimmed)) return false;
    const candidate = extractCashuUriPayload(trimmed) || trimmed;
    if (/^cashuA:/i.test(candidate)) return false;
    if (!/^cashu[a-z0-9]/i.test(candidate)) return false;
    try {
      getDecodedToken(candidate);
      return true;
    } catch {
      return false;
    }
  }

  interface HistoryItem {
    id: string;
    summary: string;
    detail?: string;
    detailKind?: HistoryDetailKind;
    revertToken?: string;
    tokenState?: HistoryTokenState;
    mintQuote?: HistoryMintQuoteInfo;
    pendingTokenId?: string;
    pendingTokenAmount?: number;
    pendingTokenMint?: string;
    pendingStatus?: "pending" | "redeemed";
    type?: HistoryEntryType;
    direction?: HistoryEntryDirection;
    amountSat?: number;
    feeSat?: number;
    mintUrl?: string;
    createdAt?: number;
    fiatValueUsd?: number;
    stateLabel?: string;
    entryKind?: HistoryEntryKind;
    relatedTaskTitle?: string;
  }

  type HistoryEntryInput = Partial<HistoryItem> & {
    id?: string;
    summary: string;
  };

  type ManualSendNoteGroup = {
    amount: number;
    secrets: string[];
  };

  type ManualSendPlan = {
    target: number;
    notes: { secret: string; amount: number }[];
    groups: ManualSendNoteGroup[];
    closestBelow: number | null;
    closestBelowSelection: string[] | null;
    closestAbove: number | null;
    closestAboveSelection: string[] | null;
    exactMatchSelection: string[] | null;
    lockActive: boolean;
  };

  const [showSendOptions, setShowSendOptions] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [isCompactLightningSheetLayout, setIsCompactLightningSheetLayout] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(max-height: 820px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia("(max-height: 820px)");
    const handleChange = (event: MediaQueryListEvent) => {
      setIsCompactLightningSheetLayout(event.matches);
    };
    setIsCompactLightningSheetLayout(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);
  const [scannerMessage, setScannerMessage] = useState("");
  type PendingScan =
    | { type: "ecash"; token: string }
    | { type: "bolt11"; invoice: string }
    | { type: "lightningAddress"; address: string }
    | { type: "lnurl"; data: string }
    | { type: "paymentRequest"; request: string };
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [scannedContact, setScannedContact] = useState<Contact | null>(null);
  const [walletTab, setWalletTab] = useState<"wallet" | "messages" | "contacts">("wallet");
  const isContactsPage = page === "contacts";
  const [dmMessages, setDmMessages] = useState<WalletDmMessage[]>([]);
  const [dmExpandedMessages, setDmExpandedMessages] = useState<Set<string>>(new Set());
  const [dmMessageActions, setDmMessageActions] = useState<{ eventId: string; copyValue: string } | null>(null);
  const dmLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dmDeletedEventsRef = useRef<Set<string>>(new Set());
  const [dmDeletedEventsVersion, setDmDeletedEventsVersion] = useState(0);
  const dmBlockedPeersRef = useRef<Set<string>>(new Set());
  const [, setDmBlockedPeersVersion] = useState(0);
  const dmPeerProfilesRef = useRef<Map<string, ContactProfile>>(new Map());
  const dmPeerProfileLoadingRef = useRef<Set<string>>(new Set());
  const [, setDmPeerProfilesVersion] = useState(0);
  const dmProcessedEventsRef = useRef<Set<string>>(new Set());
  const dmSubscriptionCloseRef = useRef<(() => void) | null>(null);
  const dmLastSyncRef = useRef<number>(0);
  const [dmView, setDmView] = useState<"list" | "thread" | "strangers">("list");
  const [activeThreadPeer, setActiveThreadPeer] = useState<string | null>(null);
  const [dmSearch, setDmSearch] = useState("");
  const [showStrangersOnly, setShowStrangersOnly] = useState(false);
  useEffect(() => {
    if (showTabSwitcher || isContactsPage) return;
    if (walletTab !== "wallet") {
      setWalletTab("wallet");
    }
  }, [isContactsPage, showTabSwitcher, walletTab]);
  const toggleDmMessageExpanded = useCallback((eventId: string) => {
    setDmExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  }, []);
  const isDmMessageExpanded = useCallback(
    (eventId: string) => dmExpandedMessages.has(eventId),
    [dmExpandedMessages],
  );
  const copyMessageValue = useCallback(
    async (value: string, label: string) => {
      if (!value) return;
      try {
        await navigator.clipboard?.writeText(value);
        showToast(`${label} copied`, 2000);
      } catch {
        showToast("Unable to copy", 2000);
      }
    },
    [showToast],
  );
  const persistDeletedDmEvents = useCallback((events: Set<string>) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_DM_DELETED_EVENTS, JSON.stringify(Array.from(events)));
    } catch {
      // ignore storage failures
    }
  }, []);
  const persistBlockedPeers = useCallback((peers: Set<string>) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_DM_BLOCKED_PEERS, JSON.stringify(Array.from(peers)));
    } catch {
      // ignore storage failures
    }
  }, []);
  useEffect(() => {
    try {
      const rawDeleted = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_DM_DELETED_EVENTS);
      if (rawDeleted) {
        const parsed = JSON.parse(rawDeleted);
        if (Array.isArray(parsed)) {
          const filtered = parsed
            .map((id) => (typeof id === "string" ? id.trim() : ""))
            .filter(Boolean);
          dmDeletedEventsRef.current = new Set(filtered);
          setDmDeletedEventsVersion((v) => v + 1);
        }
      }
    } catch {
      dmDeletedEventsRef.current = new Set();
    }
    try {
      const rawBlocked = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_DM_BLOCKED_PEERS);
      if (rawBlocked) {
        const parsed = JSON.parse(rawBlocked);
        if (Array.isArray(parsed)) {
          const filtered = parsed
            .map((id) => (typeof id === "string" ? id.trim().toLowerCase() : ""))
            .filter(Boolean);
          dmBlockedPeersRef.current = new Set(filtered);
          setDmBlockedPeersVersion((v) => v + 1);
        }
      }
    } catch {
      dmBlockedPeersRef.current = new Set();
    }
  }, []);
  useEffect(() => {
    if (!dmMessages.length) return;
    const removed = new Set<string>();
    const filtered = dmMessages.filter((msg) => {
      if (dmDeletedEventsRef.current.has(msg.eventId)) {
        removed.add(msg.eventId);
        return false;
      }
      return true;
    });
    if (!removed.size && filtered.length === dmMessages.length) return;
    setDmMessages(filtered);
    if (removed.size) {
      setDmExpandedMessages((prev) => {
        const next = new Set(prev);
        removed.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [dmDeletedEventsVersion, dmMessages]);
  const buildDmCopyValue = useCallback(
    (
      msg: WalletDmMessage,
      extras?: {
        paymentToken?: string | null;
        boardId?: string | null;
        contactNpub?: string | null;
        taskPayload?: SharedTaskPayload | null;
      },
    ) => {
      if (msg.attachment?.type === "board") {
        return extras?.boardId?.trim() || msg.attachment.boardId || msg.content || msg.eventId;
      }
      if (msg.attachment?.type === "contact") {
        return extras?.contactNpub?.trim() || msg.attachment.npub || msg.content || msg.eventId;
      }
      if (msg.attachment?.type === "task") {
        const payload = msg.attachment.task || extras?.taskPayload;
        if (payload) {
          try {
            return JSON.stringify(payload);
          } catch {}
        }
        return msg.content || msg.eventId;
      }
      if (msg.attachment?.type === "payment") {
        return extras?.paymentToken?.trim() || msg.attachment.raw || msg.content || msg.eventId;
      }
      return msg.content || msg.preview || msg.eventId;
    },
    [],
  );
  const handleDeleteDmMessage = useCallback(
    (eventId: string) => {
      if (!eventId) return;
      dmDeletedEventsRef.current.add(eventId);
      persistDeletedDmEvents(dmDeletedEventsRef.current);
      setDmDeletedEventsVersion((v) => v + 1);
      dmProcessedEventsRef.current.add(eventId);
      setDmMessages((prev) => prev.filter((msg) => msg.eventId !== eventId));
      setDmExpandedMessages((prev) => {
        if (!prev.has(eventId)) return prev;
        const next = new Set(prev);
        next.delete(eventId);
        return next;
      });
      setDmMessageActions((prev) => (prev?.eventId === eventId ? null : prev));
    },
    [persistDeletedDmEvents],
  );
  const cancelDmLongPress = useCallback(() => {
    if (dmLongPressTimerRef.current) {
      clearTimeout(dmLongPressTimerRef.current);
      dmLongPressTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    return () => {
      cancelDmLongPress();
    };
  }, [cancelDmLongPress]);
  useEffect(() => {
    cancelDmLongPress();
    setDmMessageActions(null);
  }, [activeThreadPeer, cancelDmLongPress, dmView]);
  const [receiveMode, setReceiveMode] = useState<null | "ecash" | "lightning" | "lnurlWithdraw">(null);
  const [receiveLockVisible, setReceiveLockVisible] = useState(false);
  const [ecashReceiveView, setEcashReceiveView] = useState<"overview" | "amount" | "request">(
    "overview",
  );
  const [lastCreatedEcashRequest, setLastCreatedEcashRequest] = useState<ActivePaymentRequest | null>(
    null,
  );
  const [ecashRequestAmt, setEcashRequestAmt] = useState("");
  const [ecashRequestMode, setEcashRequestMode] = useState<"multi" | "single">("multi");
  const [pendingPrimaryP2pkKeyId, setPendingPrimaryP2pkKeyId] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<null | "ecash" | "lightning" | "paymentRequest">(null);
  const [btcUsdPrice, setBtcUsdPrice] = useState<number | null>(null);
  const [priceStatus, setPriceStatus] = useState<"idle" | "loading" | "error">("idle");
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<number | null>(null);
  const captureFiatValueUsd = useCallback(
    (amountSat?: number | null) => {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return undefined;
      if (typeof amountSat !== "number" || !Number.isFinite(amountSat)) return undefined;
      if (amountSat < 0) return undefined;
      const usdValue = (amountSat / SATS_PER_BTC) * btcUsdPrice;
      if (!Number.isFinite(usdValue)) return undefined;
      return Number(usdValue.toFixed(2));
    },
    [walletConversionEnabled, btcUsdPrice],
  );

  useEffect(() => {
    if (!walletConversionEnabled) return;
    try {
      const raw = kvStorage.getItem(LS_BTC_USD_PRICE_CACHE);
      if (!raw) return;
      const parsed: { price?: unknown; updatedAt?: unknown } = JSON.parse(raw);
      const cachedPrice = Number(parsed?.price);
      if (!Number.isFinite(cachedPrice) || cachedPrice <= 0) return;
      const cachedUpdatedAt = Number(parsed?.updatedAt);
      setBtcUsdPrice((current) => (current == null ? cachedPrice : current));
      setPriceUpdatedAt((current) => {
        if (current != null) return current;
        return Number.isFinite(cachedUpdatedAt) && cachedUpdatedAt > 0 ? cachedUpdatedAt : Date.now();
      });
    } catch (error) {
      console.warn("[wallet] Failed to read cached BTC/USD price", error);
    }
  }, [walletConversionEnabled]);

  const backgroundSuspended = useMemo(() => sendMode !== null || receiveMode !== null, [sendMode, receiveMode]);

  const [mintAmt, setMintAmt] = useState("");
  const [mintQuote, setMintQuote] = useState<{ request: string; quote: string; expiry: number } | null>(null);
  const [lightningReceiveView, setLightningReceiveView] = useState<"address" | "amount" | "invoice">("address");
  const [activeMintInvoice, setActiveMintInvoice] = useState<
    { request: string; quote: string; expiry: number; amountSat: number; mintUrl?: string } | null
  >(null);
  const [mintStatus, setMintStatus] = useState<"idle" | "waiting" | "minted" | "error">("idle");
  const [mintError, setMintError] = useState("");
  const [creatingMintInvoice, setCreatingMintInvoice] = useState(false);
  const [mintInfoByUrl, setMintInfoByUrl] = useState<Record<string, { name?: string; unit?: string }>>({});
  const [lightningAddressCopied, setLightningAddressCopied] = useState(false);

  useEffect(() => {
    if (!lightningAddressCopied) return;
    const timer = window.setTimeout(() => setLightningAddressCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [lightningAddressCopied]);

  const [sendAmt, setSendAmt] = useState("");
  const [sendTokenStr, setSendTokenStr] = useState("");
  const [nutTokenCopied, setNutTokenCopied] = useState(false);
  const [ecashSendView, setEcashSendView] = useState<"amount" | "token" | "contact">("amount");
  const [ecashSendRecipient, setEcashSendRecipient] = useState<Contact | null>(null);
  const [lastSendTokenAmount, setLastSendTokenAmount] = useState<number | null>(null);
  const [lastSendTokenMint, setLastSendTokenMint] = useState<string | null>(null);
  const [creatingSendToken, setCreatingSendToken] = useState(false);
  const [lastSendTokenFingerprint, setLastSendTokenFingerprint] = useState<string | null>(null);
  const [lastSendTokenLockLabel, setLastSendTokenLockLabel] = useState<string | null>(null);
  const [lockSendToPubkey, setLockSendToPubkey] = useState(false);
  const [sendLockPubkeyInput, setSendLockPubkeyInput] = useState("");
  const [sendLockError, setSendLockError] = useState("");
  const [paymentRequestManualAmount, setPaymentRequestManualAmount] = useState("");
  const [currentPaymentRequest, setCurrentPaymentRequest] = useState<ActivePaymentRequest | null>(null);
  const [openPaymentRequest, setOpenPaymentRequest] = useState<ActivePaymentRequest | null>(null);
  const [paymentRequestError, setPaymentRequestError] = useState("");
  const [paymentRequestStatusMessage, setPaymentRequestStatusMessage] = useState("");
  const [paymentRequestLockEnabled, setPaymentRequestLockEnabled] = useState(false);
  const [paymentRequestLockPubkey, setPaymentRequestLockPubkey] = useState("");
  const incomingPaymentRequestsRef = useRef<IncomingPaymentRequest[]>([]);
  const spentIncomingPaymentsRef = useRef<Map<string, string>>(new Map());
  const spentIncomingTokenFingerprintsRef = useRef<Set<string>>(new Set());
  const textEncoderRef = useRef<TextEncoder | null>(null);
  const [claimingEventIds, setClaimingEventIds] = useState<string[]>([]);
  const defaultNostrRelays = useMemo(() => Array.from(new Set(DEFAULT_NOSTR_RELAYS)), []);
  const preferredFileServer = useMemo(
    () => normalizeFileServerUrl(fileStorageServer) || DEFAULT_FILE_STORAGE_SERVER,
    [fileStorageServer],
  );
  const nostrPoolRef = useRef<SessionPool | null>(null);
  const nostrPoolClosingRef = useRef(false);
  const nostrSubscriptionActiveRef = useRef(false);
  const nostrIdentityRef = useRef<{ secret: string; pubkey: string } | null>(null);

  const peanutSendToken = useMemo(() => {
    if (!sendTokenStr.trim()) return null;
    try {
      return encodePeanut(sendTokenStr.trim());
    } catch (error) {
      console.warn("Failed to encode nut token", error);
      return null;
    }
  }, [sendTokenStr]);

  useEffect(() => {
    setNutTokenCopied(false);
  }, [peanutSendToken]);

  useEffect(() => {
    if (!nutTokenCopied) return;
    const timer = window.setTimeout(() => setNutTokenCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [nutTokenCopied]);

  const ensureNostrPool = useCallback(() => {
    if (!nostrPoolRef.current) {
      if (walletDebugEnabled) {
        console.debug("[wallet] Initialising nostr pool", defaultNostrRelays);
      }
      nostrPoolRef.current = new SessionPool();
      nostrPoolClosingRef.current = false;
    }
    return nostrPoolRef.current;
  }, [defaultNostrRelays, walletDebugEnabled]);

  const closeNostrPool = useCallback(
    async (destroy?: boolean) => {
      if (nostrPoolClosingRef.current) return;
      const pool = nostrPoolRef.current;
      if (!pool) return;
      nostrPoolClosingRef.current = true;
      try {
        if (destroy && typeof (pool as any).destroy === "function") {
          await (pool as any).destroy();
        } else if (defaultNostrRelays.length && typeof pool.close === "function") {
          pool.close(defaultNostrRelays);
        }
      } catch (err: any) {
        const msg = err?.message || "";
        if (!/closing or closed/i.test(msg)) {
          console.warn("[wallet] Failed to close Nostr pool", err);
        }
      } finally {
        nostrPoolRef.current = null;
        nostrPoolClosingRef.current = false;
      }
    },
    [defaultNostrRelays],
  );

  const isReplaceableRejection = useCallback((err: unknown): boolean => {
    const msg = typeof (err as any)?.message === "string" ? (err as any).message : "";
    return /have newer event/i.test(msg) || /already exists/i.test(msg) || /duplicate/i.test(msg);
  }, []);
  const safePublish = useCallback(
    async (pool: SessionPool, relays: string[], event: any) => {
      const result = pool.publish(relays, event);
      try {
        await Promise.resolve(result);
      } catch (err) {
        if (!isReplaceableRejection(err)) {
          throw err;
        }
      }
    },
    [isReplaceableRejection],
  );

  const resetSendLockSettings = useCallback(() => {
    setLockSendToPubkey(false);
    setSendLockPubkeyInput("");
    setSendLockError("");
  }, []);

  const readNostrIdentity = useCallback((): { identity: NostrIdentity | null; reason: string | null } => {
    const raw = (kvStorage.getItem(LS_NOSTR_SK) || "").trim();
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
  }, []);

  const readProfileEventId = useCallback((pubkey: string): string | null => {
    if (!pubkey) return null;
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_PROFILE_EVENT_IDS);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") return null;
      const cached = parsed[pubkey];
      return typeof cached === "string" && cached.trim() ? cached.trim() : null;
    } catch {
      return null;
    }
  }, []);

  const persistProfileEventId = useCallback((pubkey: string, eventId: string | null) => {
    if (!pubkey) return;
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_PROFILE_EVENT_IDS);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const next = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
      if (eventId && eventId.trim()) {
        next[pubkey] = eventId.trim();
      } else {
        delete next[pubkey];
      }
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_PROFILE_EVENT_IDS, JSON.stringify(next));
    } catch {
      // ignore persistence issues
    }
  }, []);

  const ensureNostrIdentity = useCallback((): NostrIdentity | null => {
    if (nostrIdentityRef.current) return nostrIdentityRef.current;
    const { identity } = readNostrIdentity();
    if (identity) {
      nostrIdentityRef.current = identity;
      if (walletDebugEnabled) {
        console.debug("[wallet] Loaded nostr identity", identity.pubkey.slice(0, 8));
      }
      return identity;
    }
    return null;
  }, [readNostrIdentity, walletDebugEnabled]);

  const fingerprintIncomingToken = useCallback((token: string | null | undefined) => {
    if (typeof token !== "string") return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    let encoder = textEncoderRef.current;
    if (!encoder) {
      encoder = new TextEncoder();
      textEncoderRef.current = encoder;
    }
    return bytesToHex(sha256(encoder.encode(trimmed)));
  }, []);

  const rebuildSpentFingerprints = useCallback(() => {
    spentIncomingTokenFingerprintsRef.current = new Set(
      Array.from(spentIncomingPaymentsRef.current.values()).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    );
  }, []);

  const addSpentIncomingPayment = useCallback(
    (eventId: string, fingerprint: string | null) => {
      if (!eventId) return;
      const map = spentIncomingPaymentsRef.current;
      if (map.has(eventId)) {
        map.delete(eventId);
      }
      map.set(eventId, fingerprint ?? "");
      while (map.size > 400) {
        const firstKey = map.keys().next().value as string | undefined;
        if (!firstKey) break;
        map.delete(firstKey);
      }
      rebuildSpentFingerprints();
    },
    [rebuildSpentFingerprints],
  );

  const isIncomingPaymentSpent = useCallback((eventId?: string | null, fingerprint?: string | null) => {
    if (eventId) {
      if (spentIncomingPaymentsRef.current.has(eventId)) {
        const storedFingerprint = spentIncomingPaymentsRef.current.get(eventId) ?? "";
        if (!storedFingerprint) {
          return true;
        }
        if (!fingerprint) {
          return true;
        }
        return storedFingerprint === fingerprint;
      }
      if (fingerprint && spentIncomingTokenFingerprintsRef.current.has(fingerprint)) {
        return true;
      }
      return false;
    }
    if (fingerprint && spentIncomingTokenFingerprintsRef.current.has(fingerprint)) {
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_SPENT_NOSTR_PAYMENTS);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const values = parsed
          .filter((value): value is string => typeof value === "string" && !!value.trim())
          .slice(-400);
        const map = new Map<string, string>();
        for (const entry of values) {
          const trimmed = entry.trim();
          if (!trimmed) continue;
          const [eventIdPart, fingerprintPart] = trimmed.split("::", 2);
          const eventId = eventIdPart?.trim();
          if (!eventId) continue;
          const fingerprint = fingerprintPart?.trim() ?? "";
          map.set(eventId, fingerprint);
        }
        spentIncomingPaymentsRef.current = map;
        rebuildSpentFingerprints();
      }
    } catch (err) {
      console.warn("Failed to load spent nostr payments", err);
      spentIncomingPaymentsRef.current = new Map();
      spentIncomingTokenFingerprintsRef.current = new Set();
    }
  }, [rebuildSpentFingerprints]);

  useEffect(() => {
    if (!paymentRequestLockEnabled) return;
    if (paymentRequestLockPubkey) return;
    if (activeP2pkKey?.publicKey) {
      setPaymentRequestLockPubkey(activeP2pkKey.publicKey);
    }
  }, [paymentRequestLockEnabled, paymentRequestLockPubkey, activeP2pkKey]);

  const PAYMENT_REQUEST_DEBUG = walletDebugEnabled;
  const PAYMENT_REQUEST_LOOKBACK_SECONDS = 3 * 24 * 60 * 60; // 72 hours
  const PAYMENT_REQUEST_SAFETY_WINDOW_SECONDS = 45;
  const PAYMENT_REQUEST_DEEP_SYNC_LOOKBACK_SECONDS = 14 * 24 * 60 * 60; // 14 days
  const DM_SYNC_LOOKBACK_SECONDS = 30 * 24 * 60 * 60; // 30 days of NIP-17/DM history
  const decryptNostrPaymentMessage = useCallback(
    async (event: NostrEvent, identityPubkey: string, secretHex: string): Promise<DecryptedNostrDm | null> => {
      const normalizedIdentity = (identityPubkey || "").toLowerCase();
      const extractTagPubkeys = (tags: unknown, name: string): string[] => {
        if (!Array.isArray(tags)) return [];
        return tags
          .filter(
            (tag): tag is string[] =>
              Array.isArray(tag) &&
              tag[0] === name &&
              typeof tag[1] === "string" &&
              tag[1].trim().length > 0,
          )
          .map((tag) => tag[1]!.trim());
      };
      try {
        if (event.kind === 4) {
          if (PAYMENT_REQUEST_DEBUG) {
            console.debug("[wallet] payment request DM kind=4", event.id);
          }
          const recipientPubkeys = extractTagPubkeys(event.tags, "p");
          const recipientPubkey = recipientPubkeys[0] ?? null;
          const normalizedSender = (event.pubkey || "").toLowerCase();
          const normalizedRecipient = (recipientPubkey || "").toLowerCase();
          const peerPubkeyForDecrypt =
            normalizedSender === normalizedIdentity ? recipientPubkey : event.pubkey;

          if (!peerPubkeyForDecrypt) return null;
          if (normalizedSender !== normalizedIdentity && normalizedRecipient !== normalizedIdentity) {
            return null;
          }

          let content: string;
          try {
            content = await nip04.decrypt(secretHex, peerPubkeyForDecrypt, event.content);
          } catch (err) {
            if (nip44?.v2) {
              try {
                const dmKey = nip44.v2.utils.getConversationKey(hexToBytes(secretHex), peerPubkeyForDecrypt);
                content = await nip44.v2.decrypt(event.content, dmKey);
              } catch (inner) {
                if (PAYMENT_REQUEST_DEBUG) {
                  console.debug("[wallet] Failed to decrypt DM", event.id, inner);
                }
                return null;
              }
            } else {
              if (PAYMENT_REQUEST_DEBUG) {
                console.debug("[wallet] Failed to decrypt DM", event.id, err);
              }
              return null;
            }
          }

          return { content, senderPubkey: event.pubkey, recipientPubkey, recipientPubkeys };
        }
        if (event.kind === 1059 && nip44?.v2) {
          if (PAYMENT_REQUEST_DEBUG) {
            console.debug("[wallet] payment request DM kind=1059", event.id);
          }
          const wrapRecipients = extractTagPubkeys(event.tags, "p");
          if (!wrapRecipients.length) {
            if (PAYMENT_REQUEST_DEBUG) {
              console.debug("[wallet] kind=1059 missing recipient p tags", event.id);
            }
            return null;
          }
          const wrapKey = nip44.v2.utils.getConversationKey(hexToBytes(secretHex), event.pubkey);
          const sealJson = await nip44.v2.decrypt(event.content, wrapKey);
          let sealEvent: NostrEvent | null = null;
          try {
            sealEvent = JSON.parse(sealJson) as NostrEvent;
          } catch {
            sealEvent = null;
          }
          if (!sealEvent || sealEvent.kind !== 13 || typeof sealEvent.content !== "string") {
            return null;
          }
          const senderPubkey = typeof sealEvent.pubkey === "string" ? sealEvent.pubkey : null;
          if (!senderPubkey) return null;
          const dmKey = nip44.v2.utils.getConversationKey(hexToBytes(secretHex), senderPubkey);
          const dmJson = await nip44.v2.decrypt(sealEvent.content, dmKey);
          let rumor: NostrEvent | null = null;
          try {
            rumor = JSON.parse(dmJson) as NostrEvent;
          } catch {
            rumor = null;
          }
          if (!rumor || rumor.kind !== 14 || typeof rumor.content !== "string") {
            return null;
          }
          const rumorPubkey = typeof rumor.pubkey === "string" ? rumor.pubkey.trim().toLowerCase() : "";
          const normalizedSenderPubkey = senderPubkey.trim().toLowerCase();
          if (!rumorPubkey || rumorPubkey !== normalizedSenderPubkey) {
            if (PAYMENT_REQUEST_DEBUG) {
              console.debug("[wallet] kind=1059 sender mismatch between seal and rumor", {
                eventId: event.id,
                sealPubkey: normalizedSenderPubkey,
                rumorPubkey,
              });
            }
            return null;
          }
          const rumorRecipients = extractTagPubkeys(rumor.tags, "p");
          if (!rumorRecipients.length) {
            if (PAYMENT_REQUEST_DEBUG) {
              console.debug("[wallet] kind=14 rumor missing recipient p tags", event.id);
            }
            return null;
          }
          return {
            content: rumor.content,
            senderPubkey,
            recipientPubkey: rumorRecipients[0] ?? null,
            recipientPubkeys: rumorRecipients,
          };
        }
      } catch (err) {
        if (PAYMENT_REQUEST_DEBUG) {
          console.debug("[wallet] Failed to decrypt payment request message", event.id, err);
        }
      }
      return null;
    },
    [PAYMENT_REQUEST_DEBUG],
  );

  const parseIncomingPaymentMessage = useCallback((plain: string): PaymentRequestPayload | string | null => {
    const trimmed = (plain || "").trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return parsed as PaymentRequestPayload;
      }
    } catch {
      // fall through to string heuristics
    }
    const token = extractFirstCashuTokenFromText(trimmed);
    if (token) return token;
    return null;
  }, []);

  const resolvePeerPubkey = useCallback(
    (event: NostrEvent, identityPubkey: string, senderPubkey?: string | null, recipientPubkey?: string | null): string => {
      const normalizedIdentity = normalizeNostrPubkey(identityPubkey) ?? identityPubkey;
      const normalizedSender = senderPubkey ? normalizeNostrPubkey(senderPubkey) ?? senderPubkey : null;
      const normalizedRecipient = recipientPubkey ? normalizeNostrPubkey(recipientPubkey) ?? recipientPubkey : null;

      if (normalizedSender && normalizedSender !== normalizedIdentity) {
        return normalizedSender;
      }
      if (normalizedRecipient && normalizedRecipient !== normalizedIdentity) {
        return normalizedRecipient;
      }

      const normalizedAuthor = normalizeNostrPubkey(event.pubkey) ?? event.pubkey;
      if (normalizedAuthor !== normalizedIdentity) {
        return normalizedAuthor;
      }
      const pTag = Array.isArray(event.tags)
        ? event.tags.find((tag) => Array.isArray(tag) && tag[0] === "p" && typeof tag[1] === "string")
        : null;
      const peer = pTag?.[1];
      const normalizedPeer = peer ? normalizeNostrPubkey(peer) ?? peer : null;
      if (normalizedPeer && normalizedPeer !== normalizedIdentity) {
        return normalizedPeer;
      }
      return normalizedSender || normalizedAuthor;
    },
    [normalizeNostrPubkey],
  );

  const stopDmSubscription = useCallback(() => {
    if (dmSubscriptionCloseRef.current) {
      try {
        dmSubscriptionCloseRef.current();
      } catch {
        // ignore
      }
      dmSubscriptionCloseRef.current = null;
    }
  }, []);


  const nostrIdentityInfo = useMemo(() => {
    if (!paymentRequestsEnabled) return { identity: null as NostrIdentity | null, reason: null as string | null };
    return readNostrIdentity();
  }, [paymentRequestsEnabled, readNostrIdentity]);

  useEffect(() => {
    nostrIdentityRef.current = nostrIdentityInfo.identity;
  }, [nostrIdentityInfo]);

  useEffect(() => {
    if (!paymentRequestsEnabled) return;
    if (!paymentRequestLockPubkey && activeP2pkKey) {
      setPaymentRequestLockPubkey(activeP2pkKey.publicKey);
    }
    if (paymentRequestLockEnabled && !paymentRequestLockPubkey) {
      if (activeP2pkKey) {
        setPaymentRequestLockPubkey(activeP2pkKey.publicKey);
      } else {
        setPaymentRequestLockEnabled(false);
      }
    }
  }, [paymentRequestsEnabled, paymentRequestLockEnabled, paymentRequestLockPubkey, activeP2pkKey]);

  const [recvMsg, setRecvMsg] = useState("");

  const [lnInput, setLnInput] = useState("");
  const [lnAddrAmt, setLnAddrAmt] = useState("");
  const [lnState, setLnState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [lnError, setLnError] = useState("");
  const [lnurlPayData, setLnurlPayData] = useState<LnurlPayData | null>(null);
  const [lightningSendView, setLightningSendView] = useState<"input" | "invoice" | "address">("input");
  const [contacts, setContacts] = useState<Contact[]>(() => loadContactsFromStorage());
  const [contactsOpen, setContactsOpen] = useState(false);
  const [nip05Checks, setNip05Checks] = useState<Record<string, Nip05CheckState>>(() =>
    typeof window !== "undefined" ? loadNip05Cache() : {},
  );
  const ensureNip05VerificationRef = useRef<
    ((contactId: string, nip05?: string | null, npub?: string | null, contactUpdatedAt?: number | null) => void) | null
  >(null);
  const isNip05VerifiedForRef = useRef<
    ((contactId: string, nip05?: string | null, npub?: string | null) => boolean) | null
  >(null);
  const contactsRef = useRef<Contact[]>(contacts);
  const skipContactsEventRef = useRef(false);
  const skipContactsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);
  useEffect(() => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_CONTACT_NIP05_CACHE, JSON.stringify(nip05Checks));
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("taskify:nip05-cache-updated"));
      }
    } catch {
      // ignore persistence issues
    }
  }, [nip05Checks]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleContactsUpdated = () => {
      if (skipContactsEventRef.current) {
        skipContactsEventRef.current = false;
        return;
      }
      setContacts(loadContactsFromStorage());
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LS_LIGHTNING_CONTACTS) {
        handleContactsUpdated();
      }
    };
    window.addEventListener("taskify:contacts-updated", handleContactsUpdated);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("taskify:contacts-updated", handleContactsUpdated);
      window.removeEventListener("storage", handleStorage);
      if (skipContactsTimerRef.current) {
        clearTimeout(skipContactsTimerRef.current);
        skipContactsTimerRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    if (contactsOpen) {
      setContacts(loadContactsFromStorage());
    }
  }, [contactsOpen]);
  const resetContactForm = useCallback(() => {}, []);
  const [contactsTabOpen, setContactsTabOpen] = useState(false);
  const contactsPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (showTabSwitcher) return;
    if (isContactsPage && !contactsTabOpen) {
      setContactsTabOpen(true);
    } else if (!isContactsPage && contactsTabOpen) {
      setContactsTabOpen(false);
    }
  }, [contactsTabOpen, isContactsPage, showTabSwitcher]);
  const [contactSyncState, setContactSyncState] = useState<{
    status: "idle" | "loading" | "error" | "success";
    message?: string;
    updatedAt?: number | null;
  }>({ status: "idle", updatedAt: null });
  const [contactsPublishState, setContactsPublishState] = useState<"idle" | "publishing" | "error" | "success">("idle");
  const [, setContactsPublishMessage] = useState("");
  const initialContactSyncMeta = useMemo<ContactSyncMeta>(() => {
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_CONTACTS_SYNC_META);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          lastEventId: typeof parsed?.lastEventId === "string" ? parsed.lastEventId : null,
          lastUpdatedAt: Number(parsed?.lastUpdatedAt) || null,
          fingerprint: typeof parsed?.fingerprint === "string" ? parsed.fingerprint : null,
          publicFollows: normalizePublicFollowsList(parsed?.publicFollows),
        };
      }
    } catch {
      // ignore parse issues
    }
    return { lastEventId: null, lastUpdatedAt: null, fingerprint: null, publicFollows: [] };
  }, []);
  const contactSyncMetaRef = useRef<ContactSyncMeta>(initialContactSyncMeta);
  const [contactSyncMeta, setContactSyncMeta] = useState<ContactSyncMeta>(initialContactSyncMeta);
  const persistContactSyncMeta = useCallback(
    (meta: Partial<ContactSyncMeta>) => {
      let nextState: ContactSyncMeta | null = null;
      setContactSyncMeta((prev) => {
        const nextPublicFollows =
          meta.publicFollows !== undefined
            ? normalizePublicFollowsList(meta.publicFollows)
            : prev.publicFollows ?? [];
        const next: ContactSyncMeta = {
          lastEventId: meta.lastEventId ?? prev.lastEventId ?? null,
          lastUpdatedAt: meta.lastUpdatedAt ?? prev.lastUpdatedAt ?? null,
          fingerprint: meta.fingerprint ?? prev.fingerprint ?? null,
          publicFollows: nextPublicFollows,
        };
        nextState = next;
        try {
          idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_CONTACTS_SYNC_META, JSON.stringify(next));
        } catch {
          // ignore persistence issues
        }
        return next;
      });
      if (nextState) {
        contactSyncMetaRef.current = nextState;
      }
      return nextState;
    },
    [contactSyncMetaRef],
  );
  const [profileForm, setProfileForm] = useState<{
    username: string;
    displayName: string;
    lud16: string;
    nip05: string;
    about: string;
    picture: string;
  }>(() => {
    const { identity } = readNostrIdentity();
    const cached = identity ? readProfileMetadataCache(identity.pubkey) : null;
    return (
      cached?.profile ?? {
        username: "",
        displayName: "",
        lud16: "",
        nip05: "",
        about: "",
        picture: "",
      }
    );
  });
  const [profileSharePayload, setProfileSharePayload] = useState<string | null>(() => {
    try {
      const cached = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, PROFILE_SHARE_CACHE_KEY);
      if (!cached) return null;
      const parsed = JSON.parse(cached);
      if (typeof parsed === "string") return parsed;
    } catch {
      // ignore cache issues
    }
    return null;
  });
  const profileEventIdRef = useRef<string | null>(null);
  const profileFormRef = useRef(profileForm);
  useEffect(() => {
    profileFormRef.current = profileForm;
  }, [profileForm]);
  useEffect(() => {
    if (!profileSharePayload) return;
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, PROFILE_SHARE_CACHE_KEY, JSON.stringify(profileSharePayload));
    } catch {
      // ignore persistence issues
    }
  }, [profileSharePayload]);
  const [profileStatus, setProfileStatus] = useState<"idle" | "loading" | "ready" | "publishing" | "error">(() => {
    const { identity } = readNostrIdentity();
    const cached = identity ? readProfileMetadataCache(identity.pubkey) : null;
    return cached?.profile ? "ready" : "idle";
  });
  const [profileMessage, setProfileMessage] = useState("");
  const [profileUpdatedAt, setProfileUpdatedAt] = useState<number | null>(() => {
    const { identity } = readNostrIdentity();
    const cached = identity ? readProfileMetadataCache(identity.pubkey) : null;
    return cached?.updatedAt ?? null;
  });
  useEffect(() => {
    const { identity } = readNostrIdentity();
    if (!identity) return;
    const cached = readProfileMetadataCache(identity.pubkey);
    if (cached?.eventId && !profileEventIdRef.current) {
      profileEventIdRef.current = cached.eventId;
      persistProfileEventId(identity.pubkey, cached.eventId);
    }
  }, [persistProfileEventId, readNostrIdentity]);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [contactLookupInput, setContactLookupInput] = useState("");
  const [contactLookupBusy, setContactLookupBusy] = useState(false);
  const [contactLookupError, setContactLookupError] = useState("");
  const [showCustomContactFields, setShowCustomContactFields] = useState(false);
  const [contactView, setContactView] = useState<ContactViewMode>("list");
  const [activeContactId, setActiveContactId] = useState<string | "profile" | null>(null);
  const [shareContactPickerOpen, setShareContactPickerOpen] = useState(false);
  const [shareContactSource, setShareContactSource] = useState<Contact | null>(null);
  const [shareContactStatus, setShareContactStatus] = useState<string | null>(null);
  const [shareContactBusy, setShareContactBusy] = useState(false);
  const [contactEditDraft, setContactEditDraft] = useState<ContactEditDraft>({
    id: null,
    name: "",
    displayName: "",
    username: "",
    address: "",
    npub: "",
    nip05: "",
    about: "",
    picture: "",
    isProfile: false,
  });
  const [contactEditError, setContactEditError] = useState("");
  const [profilePhotoError, setProfilePhotoError] = useState("");
  const [profilePhotoBusy, setProfilePhotoBusy] = useState(false);
  const profilePhotoInputRef = useRef<HTMLInputElement | null>(null);
  const profilePhotoUploadRef = useRef<{ blob: Blob; name?: string; contentType?: string } | null>(null);
  const [publicFollowPickerOpen, setPublicFollowPickerOpen] = useState(false);
  const resetContactEditDraft = useCallback(() => {
    setContactEditDraft({
      id: null,
      name: "",
      displayName: "",
      username: "",
      address: "",
      npub: "",
      nip05: "",
      about: "",
      picture: "",
      isProfile: false,
    });
    setContactEditError("");
    setProfilePhotoError("");
    setProfilePhotoBusy(false);
    profilePhotoUploadRef.current = null;
  }, []);
  const closeContactsTab = useCallback(() => {
    setContactsTabOpen(false);
    setProfileEditorOpen(false);
    resetContactEditDraft();
    setContactView("list");
    setActiveContactId(null);
    setShowCustomContactFields(false);
    setWalletTab("wallet");
  }, [resetContactEditDraft]);
  const handleStartAddContact = useCallback(() => {
    resetContactEditDraft();
    setContactEditError("");
    setContactLookupError("");
    setContactLookupInput("");
    setShowCustomContactFields(false);
    setContactView("edit");
  }, [resetContactEditDraft]);
  const handleBackToContactsList = useCallback(() => {
    setContactView("list");
    setActiveContactId(null);
  }, []);
  const contactsPublishQueuedRef = useRef(false);
  const [contactsContext, setContactsContext] = useState<"lightning" | "ecash" | null>(null);
  const contactsContextRef = useRef<"lightning" | "ecash" | null>(null);
  const contactsFingerprintRef = useRef<string | null>(null);
  const nip51MigrationInFlightRef = useRef(false);
  const contactProfilesRefreshedRef = useRef(false);
  const computeContactsFingerprint = useCallback(
    (list: Contact[]): string => {
      const normalized = list
        .map((contact) => {
          const relays = Array.isArray(contact.relays)
            ? Array.from(
                new Set(
                  contact.relays
                    .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
                    .filter(Boolean),
                ),
              ).sort()
            : [];
          return {
            id: contact.id,
            kind: contact.kind,
            name: (contact.name || "").trim(),
            address: (contact.address || "").trim(),
            paymentRequest: (contact.paymentRequest || "").trim(),
            npub: (contact.npub || "").trim(),
            username: sanitizeUsername(contact.username || ""),
            displayName: (contact.displayName || "").trim(),
            nip05: (contact.nip05 || "").trim(),
            about: (contact.about || "").trim(),
            picture: (contact.picture || "").trim(),
            relays,
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      let encoder = textEncoderRef.current;
      if (!encoder) {
        encoder = new TextEncoder();
        textEncoderRef.current = encoder;
      }
      return bytesToHex(sha256(encoder.encode(JSON.stringify(normalized))));
    },
    [],
  );

  const upsertContact = useCallback(
    (input: Partial<Contact> & { id?: string }) => {
      const shouldUpdatePaymentRequest =
        Object.prototype.hasOwnProperty.call(input, "paymentRequest") ||
        Object.prototype.hasOwnProperty.call(input as any, "creq") ||
        Object.prototype.hasOwnProperty.call(input as any, "cashuPaymentRequest");
      const normalized = normalizeContact({
        ...input,
        id: input.id || makeContactId(),
        kind: input.kind || (input.npub ? "nostr" : "custom"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      if (!normalized) return null;
      const normalizedNpub = formatContactNpub(normalized.npub);
      const normalizedWithNpub: Contact = { ...normalized, npub: normalizedNpub };
      let result: Contact = normalizedWithNpub;
      setContacts((prev) => {
        const normalizedHex = normalizeNostrPubkey(normalizedWithNpub.npub || "");
        const existingIndex = prev.findIndex((entry) => {
          if (entry.id === normalized.id) return true;
          if (normalizedHex) {
            const entryHex = normalizeNostrPubkey(entry.npub || "");
            if (entryHex && entryHex === normalizedHex) return true;
          }
          return false;
        });
        if (existingIndex >= 0) {
          const prevContact = prev[existingIndex];
          const merged: Contact = {
            ...prevContact,
            ...normalizedWithNpub,
            id: prevContact.id,
            updatedAt: Date.now(),
            paymentRequest: shouldUpdatePaymentRequest
              ? normalizedWithNpub.paymentRequest
              : prevContact.paymentRequest,
          };
          result = merged;
          const next = prev.slice();
          next[existingIndex] = merged;
          return next;
        }
        result = normalizedWithNpub;
        return [...prev, normalizedWithNpub];
      });
      return result;
    },
    [normalizeContact, normalizeNostrPubkey, setContacts, makeContactId, formatContactNpub],
  );

  const compressedToRawHex = useCallback((value: string) => {
    if (typeof value !== "string") return value;
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(value)) return value.slice(-64);
    if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.slice(-64);
    if (/^[0-9a-fA-F]{64}$/.test(value)) return value;
    return value;
  }, []);

  const formatNpub = useCallback(
    (value: string) => {
      const raw = compressedToRawHex(value);
      try {
        return nip19.npubEncode(raw);
      } catch {
        return value;
      }
    },
    [compressedToRawHex],
  );

  const formatNpubDisplay = useCallback(
    (value: string | null | undefined): string | null => {
      if (!value) return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith("npub")) return trimmed;
      const normalized = normalizeNostrPubkey(trimmed);
      const candidate = normalized || trimmed;
      let rawHex: string | null = null;
      if (/^[0-9a-f]{64}$/i.test(candidate)) {
        rawHex = candidate;
      } else if (/^(02|03)[0-9a-f]{64}$/i.test(candidate)) {
        rawHex = candidate.slice(-64);
      }
      if (rawHex) {
        try {
          return nip19.npubEncode(hexToBytes(rawHex));
        } catch {
          return rawHex;
        }
      }
      return candidate;
    },
    [normalizeNostrPubkey],
  );

  const [lnurlWithdrawInfo, setLnurlWithdrawInfo] = useState<LnurlWithdrawData | null>(null);
  const [lnurlWithdrawAmt, setLnurlWithdrawAmt] = useState("");
  const [lnurlWithdrawState, setLnurlWithdrawState] = useState<"idle" | "creating" | "waiting" | "done" | "error">("idle");
  const [lnurlWithdrawMessage, setLnurlWithdrawMessage] = useState("");
  const [lnurlWithdrawInvoice, setLnurlWithdrawInvoice] = useState("");

  const [paymentRequestState, setPaymentRequestState] = useState<{ encoded: string; request: PaymentRequest } | null>(null);
  const [paymentRequestStatus, setPaymentRequestStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [paymentRequestMessage, setPaymentRequestMessage] = useState("");

  const [showNwcManager, setShowNwcManager] = useState(false);
  const [nwcUrlInput, setNwcUrlInput] = useState("");
  const [nwcBusy, setNwcBusy] = useState(false);
  const [nwcFeedback, setNwcFeedback] = useState("");

  const [swapAmount, setSwapAmount] = useState("");
  const [swapFromValue, setSwapFromValue] = useState<string>("");
  const [swapToValue, setSwapToValue] = useState<string>("");
  const [nwcFundState, setNwcFundState] = useState<"idle" | "creating" | "paying" | "waiting" | "claiming" | "done" | "error">("idle");
  const [nwcFundMessage, setNwcFundMessage] = useState("");
  const [nwcFundInvoice, setNwcFundInvoice] = useState("");

  const [nwcWithdrawState, setNwcWithdrawState] = useState<"idle" | "requesting" | "paying" | "done" | "error">("idle");
  const [nwcWithdrawMessage, setNwcWithdrawMessage] = useState("");
  const [nwcWithdrawInvoice, setNwcWithdrawInvoice] = useState("");
  const [mintSwapState, setMintSwapState] = useState<"idle" | "creating" | "paying" | "waiting" | "claiming" | "done" | "error">("idle");
  const [mintSwapMessage, setMintSwapMessage] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const saved = idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashuHistory");
      if (!saved) return [];
      const parsed: unknown = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const raw = item as Record<string, any>;
          const { id, summary } = raw;
          if (typeof id !== "string" || typeof summary !== "string") return null;
          const normalized: HistoryItem = { id, summary };
          if (typeof raw.detail === "string" && raw.detail) {
            normalized.detail = raw.detail;
          }
          if (typeof raw.detailKind === "string") {
            const detailKind = raw.detailKind;
            if (detailKind === "token" || detailKind === "invoice" || detailKind === "note") {
              normalized.detailKind = detailKind;
            }
          }
          if (typeof raw.revertToken === "string" && raw.revertToken) {
            normalized.revertToken = raw.revertToken;
          }
          const isBountyAttachmentId = typeof id === "string" && id.startsWith("attach-bounty-");
          if (raw.entryKind === "bounty-attachment") {
            normalized.entryKind = "bounty-attachment";
          } else if (isBountyAttachmentId) {
            normalized.entryKind = "bounty-attachment";
          }
          if (typeof raw.relatedTaskTitle === "string" && raw.relatedTaskTitle.trim()) {
            normalized.relatedTaskTitle = raw.relatedTaskTitle.trim();
          }
          const typeLabel = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
          if (typeLabel === "lightning" || typeLabel === "ecash") {
            normalized.type = typeLabel;
          }
          const directionLabel = typeof raw.direction === "string" ? raw.direction.toLowerCase() : "";
          if (directionLabel === "in" || directionLabel === "out") {
            normalized.direction = directionLabel;
          }
          const amountValue = Number(raw.amountSat);
          if (Number.isFinite(amountValue) && amountValue >= 0) {
            normalized.amountSat = amountValue;
          }
          const feeValue = Number(raw.feeSat);
          if (Number.isFinite(feeValue) && feeValue >= 0) {
            normalized.feeSat = feeValue;
          }
          if (typeof raw.mintUrl === "string" && raw.mintUrl) {
            normalized.mintUrl = raw.mintUrl;
          }
          if (typeof raw.stateLabel === "string" && raw.stateLabel.trim()) {
            normalized.stateLabel = raw.stateLabel;
          }
          const createdAtValue = Number(raw.createdAt);
          normalized.createdAt =
            Number.isFinite(createdAtValue) && createdAtValue > 0
              ? createdAtValue
              : deriveTimestampFromId(id);
          const fiatValue = Number(raw.fiatValueUsd);
          if (Number.isFinite(fiatValue) && fiatValue >= 0) {
            normalized.fiatValueUsd = fiatValue;
          }
          if (typeof raw.pendingTokenId === "string" && raw.pendingTokenId) {
            normalized.pendingTokenId = raw.pendingTokenId;
          }
          const pendingAmountValue = Number(raw.pendingTokenAmount);
          if (Number.isFinite(pendingAmountValue) && pendingAmountValue > 0) {
            normalized.pendingTokenAmount = pendingAmountValue;
          }
          if (typeof raw.pendingTokenMint === "string" && raw.pendingTokenMint) {
            normalized.pendingTokenMint = raw.pendingTokenMint;
          }
          if (raw.pendingStatus === "pending" || raw.pendingStatus === "redeemed") {
            normalized.pendingStatus = raw.pendingStatus;
          }
          const rawMintQuote = raw.mintQuote;
          if (rawMintQuote && typeof rawMintQuote === "object") {
            const quoteId = typeof (rawMintQuote as any).quote === "string" ? (rawMintQuote as any).quote : null;
            const amount = Number((rawMintQuote as any).amount);
            if (quoteId && Number.isFinite(amount)) {
              const mintQuote: HistoryMintQuoteInfo = { quote: quoteId, amount };
              if (typeof (rawMintQuote as any).request === "string") {
                mintQuote.request = (rawMintQuote as any).request;
              }
              if (typeof (rawMintQuote as any).mintUrl === "string") {
                mintQuote.mintUrl = normalizeMintUrl((rawMintQuote as any).mintUrl);
              }
              const createdAt = Number((rawMintQuote as any).createdAt);
              if (Number.isFinite(createdAt) && createdAt > 0) {
                mintQuote.createdAt = createdAt;
              }
              const expiresAt = Number((rawMintQuote as any).expiresAt);
              if (Number.isFinite(expiresAt) && expiresAt > 0) {
                mintQuote.expiresAt = expiresAt;
              }
              if (typeof (rawMintQuote as any).state === "string") {
                mintQuote.state = (rawMintQuote as any).state;
              }
              if ((rawMintQuote as any).suppressChecks === true) {
                mintQuote.suppressChecks = true;
              }
              if (typeof (rawMintQuote as any).lastError === "string" && (rawMintQuote as any).lastError) {
                mintQuote.lastError = (rawMintQuote as any).lastError;
              }
              const mintQuoteErrorAt = Number((rawMintQuote as any).lastErrorAt);
              if (Number.isFinite(mintQuoteErrorAt) && mintQuoteErrorAt > 0) {
                mintQuote.lastErrorAt = mintQuoteErrorAt;
              }
              const mintQuoteErrorCount = Number((rawMintQuote as any).errorCount);
              if (Number.isFinite(mintQuoteErrorCount) && mintQuoteErrorCount > 0) {
                mintQuote.errorCount = mintQuoteErrorCount;
              }
              normalized.mintQuote = mintQuote;
            }
          }
          const rawTokenState = raw.tokenState;
          if (rawTokenState && typeof rawTokenState === "object") {
            const mintUrl = typeof rawTokenState.mintUrl === "string" ? rawTokenState.mintUrl : null;
            const proofsRaw = Array.isArray(rawTokenState.proofs) ? rawTokenState.proofs : [];
            if (mintUrl && proofsRaw.length) {
              const normalizedProofs = proofsRaw
                .map((proof: any) => {
                  if (!proof || typeof proof !== "object") return null;
                  const secret = typeof proof.secret === "string" ? proof.secret : null;
                  const proofId = typeof proof.id === "string" ? proof.id : null;
                  const C = typeof proof.C === "string" ? proof.C : null;
                  if (!secret || !proofId || !C) return null;
                  const amount = typeof proof.amount === "number" ? proof.amount : 0;
                  const stored: StoredProofForState = { secret, id: proofId, C, amount };
                  if (typeof proof.witness === "string") stored.witness = proof.witness;
                  const Y = typeof proof.Y === "string" ? proof.Y : computeProofY(secret);
                  if (Y) stored.Y = Y;
                  const rawState =
                    typeof proof.lastState === "string" ? proof.lastState.toUpperCase() : undefined;
                  const normalizedState = sanitizeProofStateValue(rawState);
                  if (normalizedState) {
                    stored.lastState = normalizedState;
                  }
                  return stored;
                })
                .filter((proof): proof is StoredProofForState => !!proof);
              if (normalizedProofs.length) {
                const tokenState: HistoryTokenState = { mintUrl, proofs: normalizedProofs };
                if (typeof rawTokenState.lastState === "string") {
                  const normalizedState = sanitizeProofStateValue(rawTokenState.lastState.toUpperCase());
                  if (normalizedState) {
                    tokenState.lastState = normalizedState;
                  }
                }
                if (typeof rawTokenState.lastSummary === "string") {
                  tokenState.lastSummary = rawTokenState.lastSummary;
                }
                if (typeof rawTokenState.lastCheckedAt === "number" && Number.isFinite(rawTokenState.lastCheckedAt)) {
                  tokenState.lastCheckedAt = rawTokenState.lastCheckedAt;
                }
                if (rawTokenState.lastWitnesses && typeof rawTokenState.lastWitnesses === "object") {
                  const witnessEntries = Object.entries(rawTokenState.lastWitnesses as Record<string, unknown>)
                    .filter((entry): entry is [string, string] => {
                      const [key, value] = entry;
                      return typeof key === "string" && typeof value === "string";
                    });
                  if (witnessEntries.length) {
                    tokenState.lastWitnesses = Object.fromEntries(witnessEntries);
                  }
                }
                if (rawTokenState.notifiedSpent === true) {
                  tokenState.notifiedSpent = true;
                }
                if (rawTokenState.suppressChecks === true) {
                  tokenState.suppressChecks = true;
                }
                if (typeof rawTokenState.lastError === "string" && rawTokenState.lastError) {
                  tokenState.lastError = rawTokenState.lastError;
                }
                const tokenStateErrorAt = Number(rawTokenState.lastErrorAt);
                if (Number.isFinite(tokenStateErrorAt) && tokenStateErrorAt > 0) {
                  tokenState.lastErrorAt = tokenStateErrorAt;
                }
                const tokenStateErrorCount = Number(rawTokenState.errorCount);
                if (Number.isFinite(tokenStateErrorCount) && tokenStateErrorCount > 0) {
                  tokenState.errorCount = tokenStateErrorCount;
                }
                const summaryMarkedSpent =
                  typeof normalized.summary === "string" && normalized.summary.includes("(spent)");
                if (summaryMarkedSpent && tokenState.lastState !== "SPENT") {
                  tokenState.lastState = "SPENT";
                  tokenState.lastSummary = tokenState.lastSummary ?? "SPENT";
                  tokenState.suppressChecks = true;
                  tokenState.notifiedSpent = true;
                  tokenState.proofs = tokenState.proofs.map((proof) =>
                    proof.lastState ? proof : { ...proof, lastState: "SPENT" },
                  );
                }
                normalized.tokenState = tokenState;
              }
            }
          }
          if (!normalized.tokenState && typeof normalized.detail === "string" && normalized.detail.trim()) {
            const shouldInferTokenState =
              normalized.entryKind === "bounty-attachment" ||
              normalized.detailKind === "token" ||
              isCashuTokenDetail(normalized.detail, normalized.detailKind);
            if (shouldInferTokenState) {
              const inferred = deriveHistoryTokenStateFromToken(normalized.detail);
              if (inferred) {
                normalized.tokenState = inferred;
              }
            }
          }
          return normalized;
        })
        .filter((item): item is HistoryItem => !!item);
    } catch {
      return [];
    }
  });
  const buildHistoryEntry = useCallback(
    (entry: HistoryEntryInput): HistoryItem => {
      const amountSat =
        typeof entry.amountSat === "number" && Number.isFinite(entry.amountSat)
          ? entry.amountSat
          : undefined;
      const feeSat =
        typeof entry.feeSat === "number" && Number.isFinite(entry.feeSat) ? entry.feeSat : undefined;
      const createdAt =
        typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) && entry.createdAt > 0
          ? entry.createdAt
          : Date.now();
      const fiatSnapshot =
        entry.fiatValueUsd != null ? entry.fiatValueUsd : captureFiatValueUsd(amountSat);
      const normalized: HistoryItem = {
        ...entry,
        id: entry.id && entry.id.trim() ? entry.id : `${entry.type || "entry"}-${createdAt}`,
        amountSat,
        feeSat,
        createdAt,
        fiatValueUsd: typeof fiatSnapshot === "number" ? fiatSnapshot : undefined,
      };
      if (entry.mintQuote) {
        normalized.mintQuote = { ...entry.mintQuote };
      }
      if (entry.tokenState) {
        normalized.tokenState = {
          ...entry.tokenState,
          proofs: [...entry.tokenState.proofs],
        };
      }
      return normalized;
    },
    [captureFiatValueUsd],
  );
  const [showHistory, setShowHistory] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<"all" | "pending" | "bounty">("all");
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [historyRevertState, setHistoryRevertState] = useState<
    Record<string, { status: "idle" | "pending" | "success" | "error"; message?: string }>
  >({});
  const [historyCheckStates, setHistoryCheckStates] = useState<
    Record<string, { status: "idle" | "pending" | "success" | "error"; message?: string }>
  >({});
  const [historyMintQuoteStates, setHistoryMintQuoteStates] = useState<
    Record<string, { status: "idle" | "pending" | "success" | "error"; message?: string }>
  >({});
  const [historyRedeemStates, setHistoryRedeemStates] = useState<
    Record<string, { status: "idle" | "pending" | "success" | "error"; message?: string }>
  >({});
  const [manualSendPlan, setManualSendPlan] = useState<ManualSendPlan | null>(null);
  const [manualSendSelection, setManualSendSelection] = useState<Set<string>>(() => new Set());
  const [manualSendError, setManualSendError] = useState("");
  const [manualSendInProgress, setManualSendInProgress] = useState(false);

  const manualSelectedTotal = useMemo(() => {
    if (!manualSendPlan) return 0;
    let sum = 0;
    manualSendPlan.notes.forEach((note) => {
      if (manualSendSelection.has(note.secret)) {
        sum += note.amount;
      }
    });
    return sum;
  }, [manualSendPlan, manualSendSelection]);

  const finalizeManualSelection = useCallback(
    async (params: { selection: string[]; selectedTotal: number; target: number }) => {
      const { selection, selectedTotal, target } = params;
      const res = await createTokenFromProofSelection(selection);
      setSendTokenStr(res.token);
      setLastSendTokenAmount(selectedTotal);
      setLastSendTokenMint(mintUrl ?? null);
      setLastSendTokenFingerprint(`${selectedTotal}|manual`);
      setLastSendTokenLockLabel(null);
      setEcashSendView("token");
      setHistory((h) => [
        buildHistoryEntry({
          id: `token-manual-${Date.now()}`,
          summary:
            selectedTotal === target
              ? `Token for ${selectedTotal} sats`
              : `Manual token for ${selectedTotal} sats (target ${target} sats)`,
          detail: res.token,
          detailKind: "token",
          revertToken: res.token,
          type: "ecash",
          direction: "out",
          amountSat: selectedTotal,
          mintUrl: res.mintUrl,
          tokenState:
            res.proofs?.length
              ? {
                  mintUrl: res.mintUrl,
                  proofs: res.proofs.map((proof) => {
                    const stored: StoredProofForState = {
                      secret: proof.secret,
                      amount: proof.amount,
                      id: proof.id,
                      C: proof.C,
                    };
                    if (proof.witness) stored.witness = proof.witness;
                    const y = computeProofY(proof.secret);
                    if (y) stored.Y = y;
                    return stored;
                  }),
                  lastState: "UNSPENT",
                }
              : undefined,
        }),
        ...h,
      ]);
      showToast(`Token created for ${selectedTotal} sats`, 3000);
      return res;
    },
    [
      buildHistoryEntry,
      createTokenFromProofSelection,
      mintUrl,
      setHistory,
      setLastSendTokenAmount,
      setLastSendTokenMint,
      setLastSendTokenFingerprint,
      setLastSendTokenLockLabel,
      setSendTokenStr,
      setEcashSendView,
      showToast,
    ],
  );

  const closeManualSendPlan = useCallback(() => {
    setManualSendPlan(null);
    setManualSendSelection(() => new Set());
    setManualSendError("");
    setManualSendInProgress(false);
  }, []);

  const applyManualSendSelection = useCallback(
    async (secrets: string[] | null, options?: { autoCreate?: boolean }) => {
      if (!secrets) return;
      if (options?.autoCreate && manualSendPlan) {
        setManualSendInProgress(true);
        setManualSendError("");
        try {
          const selectedTotal = totalForSelection(manualSendPlan.notes, secrets);
          if (!selectedTotal) {
            setManualSendError("Select at least one note.");
            return;
          }
          await finalizeManualSelection({
            selection: secrets,
            selectedTotal,
            target: manualSendPlan.target,
          });
          closeManualSendPlan();
        } catch (err: any) {
          setManualSendError(err?.message || String(err));
        } finally {
          setManualSendInProgress(false);
        }
        return;
      }
      setManualSendSelection(() => new Set(secrets));
      setManualSendError("");
    },
    [
      closeManualSendPlan,
      finalizeManualSelection,
      manualSendPlan,
      setManualSendError,
      setManualSendInProgress,
      setManualSendSelection,
    ],
  );

  const adjustManualSendGroupSelection = useCallback(
    (amount: number, delta: number) => {
      setManualSendSelection((prev) => {
        if (!manualSendPlan) return prev;
        const group = manualSendPlan.groups.find((entry) => entry.amount === amount);
        if (!group) return prev;
        const next = new Set(prev);
        if (delta > 0) {
          const secretToAdd = group.secrets.find((secret) => !next.has(secret));
          if (!secretToAdd) return prev;
          next.add(secretToAdd);
        } else if (delta < 0) {
          const selectedSecrets = group.secrets.filter((secret) => next.has(secret));
          const secretToRemove = selectedSecrets[selectedSecrets.length - 1];
          if (!secretToRemove) return prev;
          next.delete(secretToRemove);
        } else {
          return prev;
        }
        return next;
      });
    },
    [manualSendPlan],
  );

  const manualSelectionMatches = useCallback(
    (candidate: string[] | null) => {
      if (!candidate) return false;
      if (candidate.length !== manualSendSelection.size) return false;
      return candidate.every((secret) => manualSendSelection.has(secret));
    },
    [manualSendSelection],
  );

  const handleGenerateP2pkKey = useCallback((): P2PKKey | null => {
    try {
      const key = generateP2pkKeypair();
      setPrimaryP2pkKey(key.id);
      showToast("Generated new P2PK key", 2500);
      setPendingPrimaryP2pkKeyId(key.id);
      return key;
    } catch (err: any) {
      showToast(err?.message || "Unable to generate key");
      return null;
    }
  }, [generateP2pkKeypair, setPrimaryP2pkKey, showToast]);

  const handleOpenReceiveLock = useCallback(() => {
    if (!activeP2pkKey) {
      const generated = handleGenerateP2pkKey();
      if (!generated) {
        return;
      }
    }
    setReceiveLockVisible(true);
  }, [activeP2pkKey, handleGenerateP2pkKey]);
  const handleRevertHistoryToken = useCallback(
    async (item: HistoryItem) => {
      if (!item.revertToken) return;
      setHistoryRevertState((prev) => ({
        ...prev,
        [item.id]: { status: "pending" },
      }));
      try {
        const res = await receiveToken(item.revertToken);
        if (res.savedForLater) {
          showToast("Token saved for later redemption. We'll redeem it when you're back online.");
          setHistoryRevertState((prev) => ({
            ...prev,
            [item.id]: { status: "idle" },
          }));
          return;
        }
        const amt = sumProofAmounts(res.proofs);
        const crossNote = res.crossMint && res.usedMintUrl ? ` • Stored at ${res.usedMintUrl}` : "";
        const successMessage = amt
          ? `Redeemed ${amt} sat${amt === 1 ? "" : "s"}${crossNote}`
          : `Redeemed token${crossNote}`;
        const tokenState = deriveSpentHistoryTokenStateFromTokenRef.current(item.revertToken, Date.now());
        setHistory((prev) => {
          const updated = prev.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  summary: entry.summary.includes("(reverted)")
                    ? entry.summary
                    : `${entry.summary} (reverted)`,
                  revertToken: undefined,
                  tokenState: undefined,
                }
              : entry,
          );
          return [
            buildHistoryEntry({
              id: `reverted-${Date.now()}`,
              summary: amt
                ? `Reverted token for ${amt} sat${amt === 1 ? "" : "s"}`
                : "Reverted token",
              detail: item.revertToken,
              detailKind: "token",
              type: "ecash",
              direction: "in",
              amountSat: amt || undefined,
              mintUrl: res.usedMintUrl ?? mintUrl ?? undefined,
              ...(tokenState ? { tokenState } : {}),
            }),
            ...updated,
          ];
        });
        setHistoryCheckStates((prev) => {
          if (!(item.id in prev)) return prev;
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setHistoryRevertState((prev) => ({
          ...prev,
          [item.id]: { status: "success", message: successMessage },
        }));
        showToast(successMessage, 3000);
      } catch (err: any) {
        const message = err?.message || String(err);
        setHistoryRevertState((prev) => ({
          ...prev,
          [item.id]: { status: "error", message },
        }));
      }
    },
    [buildHistoryEntry, mintUrl, receiveToken, showToast]
  );
  const mintQuoteClaimingRef = useRef<Set<string>>(new Set());
  const handleMintQuoteClaimSuccess = useCallback(
    (historyId: string, amountSat: number, mintHint?: string | null) => {
      setHistory((prev) => [
        buildHistoryEntry({
          id: `mint-${Date.now()}`,
          summary: `Minted ${amountSat} sats`,
          type: "lightning",
          direction: "in",
          amountSat,
          mintUrl: mintHint ?? undefined,
          stateLabel: "Paid",
        }),
        ...prev.filter((entry) => entry.id !== historyId),
      ]);
      setHistoryMintQuoteStates((prev) => {
        if (!(historyId in prev)) return prev;
        const next = { ...prev };
        delete next[historyId];
        return next;
      });
      showToast(`received ${amountSat} sats`, 3500);
    },
    [buildHistoryEntry, setHistory, setHistoryMintQuoteStates, showToast],
  );
  const claimMintQuoteById = useCallback(
    async (
      quoteId: string,
      amountSat: number,
      options?: { historyItemId?: string; mintUrl?: string },
    ) => {
      if (!quoteId) return;
      if (mintQuoteClaimingRef.current.has(quoteId)) return;
      mintQuoteClaimingRef.current.add(quoteId);
      const historyKey = options?.historyItemId ?? quoteId;
      if (historyKey) {
        setHistoryMintQuoteStates((prev) => ({
          ...prev,
          [historyKey]: { status: "pending" },
        }));
      }
      try {
        await claimMint(quoteId, amountSat, { mintUrl: options?.mintUrl });
        handleMintQuoteClaimSuccess(historyKey, amountSat, options?.mintUrl ?? null);
      } catch (err: any) {
        const message = err?.message || String(err ?? "");
        if (historyKey) {
          setHistoryMintQuoteStates((prev) => ({
            ...prev,
            [historyKey]: { status: "error", message },
          }));
        }
        throw err;
      } finally {
        mintQuoteClaimingRef.current.delete(quoteId);
      }
    },
    [claimMint, handleMintQuoteClaimSuccess, setHistoryMintQuoteStates],
  );
  const performTokenStateCheck = useCallback(
    async (item: HistoryItem, options?: { silent?: boolean }) => {
      const tokenState = item.tokenState;
      if (!tokenState || !tokenState.proofs.length) return;
      if (!options?.silent) {
        setHistoryCheckStates((prev) => ({
          ...prev,
          [item.id]: { status: "pending" },
        }));
      }
      try {
        const proofsForCheck: Proof[] = tokenState.proofs.map((proof) => ({
          amount: proof.amount,
          secret: proof.secret,
          id: proof.id,
          C: proof.C,
          witness: proof.witness,
        }));
        const states = await checkProofStates(tokenState.mintUrl, proofsForCheck);
        const responseStateWrappers = states.map((state) => ({
          lastState: sanitizeProofStateValue(state.state),
        }));
        const aggregatedFromResponse = aggregateStoredProofStates(responseStateWrappers);
        const summaryFromResponse = summarizeStoredProofStates(responseStateWrappers);
        const witnessMap = extractWitnesses(states);
        let toastMessage: string | null = null;
        const timestamp = Date.now();
        setHistory((prev) =>
          prev.map((entry) => {
            if (entry.id !== item.id || !entry.tokenState) return entry;
            const updatedProofs = entry.tokenState.proofs.map((proof, index) => {
              const stateEntry = states[index];
              const normalizedState = sanitizeProofStateValue(stateEntry?.state);
              const yFromResponse = stateEntry?.Y;
              const witnessFromState = stateEntry?.witness;
              let nextProof = proof;
              if (yFromResponse && proof.Y !== yFromResponse) {
                nextProof = { ...nextProof, Y: yFromResponse };
              } else if (!proof.Y) {
                const computed = computeProofY(proof.secret);
                if (computed) {
                  nextProof = { ...nextProof, Y: computed };
                }
              }
              if (typeof witnessFromState === "string" && witnessFromState !== proof.witness) {
                nextProof = { ...nextProof, witness: witnessFromState };
              }
              if (normalizedState && normalizedState !== proof.lastState) {
                nextProof = { ...nextProof, lastState: normalizedState };
              }
              return nextProof;
            });
            const aggregated =
              aggregateStoredProofStates(updatedProofs) ?? entry.tokenState.lastState;
            const summaryValue = summarizeStoredProofStates(updatedProofs);
            const mergedWitnesses = { ...(entry.tokenState.lastWitnesses ?? {}) };
            if (witnessMap) {
              for (const [y, witness] of Object.entries(witnessMap)) {
                mergedWitnesses[y] = witness;
              }
            }
            const shouldNotify = aggregated === "SPENT" && entry.tokenState.notifiedSpent !== true;
            if (shouldNotify) {
              toastMessage = buildTokenSpentToastMessage(updatedProofs);
            }
            const mergedWitnessesValue = Object.keys(mergedWitnesses).length
              ? mergedWitnesses
              : entry.tokenState.lastWitnesses;
            const nextTokenState: HistoryTokenState = {
              ...entry.tokenState,
              proofs: updatedProofs,
              lastState: aggregated ?? entry.tokenState.lastState,
              lastSummary: summaryValue || entry.tokenState.lastSummary,
              lastCheckedAt: timestamp,
              lastWitnesses: mergedWitnessesValue,
              notifiedSpent: aggregated === "SPENT" ? true : entry.tokenState.notifiedSpent,
            };
            if (aggregated === "SPENT") {
              nextTokenState.suppressChecks = true;
            } else if (entry.tokenState.suppressChecks) {
              nextTokenState.suppressChecks = entry.tokenState.suppressChecks;
            } else {
              delete (nextTokenState as any).suppressChecks;
            }
            delete (nextTokenState as any).lastError;
            delete (nextTokenState as any).lastErrorAt;
            if (entry.tokenState.errorCount != null) {
              delete (nextTokenState as any).errorCount;
            }
            return {
              ...entry,
              summary:
                aggregated === "SPENT" && !entry.summary.includes("(spent)")
                  ? `${entry.summary} (spent)`
                  : entry.summary,
              tokenState: nextTokenState,
            };
          })
        );
        if (!options?.silent) {
          const baseLabel = aggregatedFromResponse ?? item.tokenState.lastState;
          const summaryLabel = summaryFromResponse || item.tokenState.lastSummary || "";
          const label = baseLabel ?? (summaryLabel ? "Updated" : "State updated");
          const message = summaryLabel ? `${label}${label ? " • " : ""}${summaryLabel}` : label ?? "State updated";
          setHistoryCheckStates((prev) => ({
            ...prev,
            [item.id]: { status: "success", message },
          }));
        }
        if (toastMessage) {
          showToast(toastMessage, 3500);
        }
      } catch (err: any) {
        const message = err?.message || String(err);
        const timestamp = Date.now();
        const suppressChecks = shouldSuppressProofStateChecks(err);
        const alreadySpent = /already spent/i.test(message);
        setHistory((prev) =>
          prev.map((entry) => {
            if (entry.id !== item.id || !entry.tokenState) return entry;
            if (alreadySpent) {
              const updatedProofs = entry.tokenState.proofs.map((proof) =>
                proof.lastState === "SPENT" ? proof : { ...proof, lastState: "SPENT" },
              );
              const summaryValue = summarizeStoredProofStates(updatedProofs);
              const nextTokenState: HistoryTokenState = {
                ...entry.tokenState,
                proofs: updatedProofs,
                lastState: "SPENT",
                lastSummary: summaryValue || entry.tokenState.lastSummary || "SPENT",
                lastCheckedAt: timestamp,
                notifiedSpent: true,
                suppressChecks: true,
              };
              delete (nextTokenState as any).lastError;
              delete (nextTokenState as any).lastErrorAt;
              if (nextTokenState.errorCount != null) {
                delete (nextTokenState as any).errorCount;
              }
              return {
                ...entry,
                summary:
                  entry.summary.includes("(spent)")
                    ? entry.summary
                    : `${entry.summary} (spent)`,
                tokenState: nextTokenState,
              };
            }
            const errorCount = (entry.tokenState.errorCount ?? 0) + 1;
            const nextTokenState: HistoryTokenState = {
              ...entry.tokenState,
              lastCheckedAt: timestamp,
              lastError: message,
              lastErrorAt: timestamp,
              errorCount,
            };
            if (suppressChecks) {
              nextTokenState.suppressChecks = true;
            }
            return {
              ...entry,
              tokenState: nextTokenState,
            };
          })
        );
        if (!options?.silent) {
          setHistoryCheckStates((prev) => ({
            ...prev,
            [item.id]: alreadySpent
              ? { status: "success", message: "Token marked spent" }
              : { status: "error", message },
          }));
        }
        if (alreadySpent && !options?.silent) {
          showToast("Token marked spent", 3000);
        }
      }
    },
    [checkProofStates, setHistory, setHistoryCheckStates, showToast]
  );

  const handleCheckHistoryMintQuote = useCallback(
    async (item: HistoryItem) => {
      const mintQuote = item.mintQuote;
      if (!mintQuote) return;
      const targetMintRaw = mintQuote.mintUrl || mintUrl || "";
      const targetMint = targetMintRaw ? normalizeMintUrl(targetMintRaw) : null;
      if (!targetMint) {
        setHistoryMintQuoteStates((prev) => ({
          ...prev,
          [item.id]: {
            status: "error",
            message: "Mint unavailable. Select a mint to claim this invoice.",
          },
        }));
        return;
      }
      setHistoryMintQuoteStates((prev) => ({
        ...prev,
        [item.id]: { status: "pending" },
      }));
      try {
        const state = await checkMintQuote(mintQuote.quote, { mintUrl: targetMintRaw });
        if (state === "PAID" || state === "ISSUED") {
          await claimMint(mintQuote.quote, mintQuote.amount, { mintUrl: targetMintRaw });
          setHistory((prev) => [
            buildHistoryEntry({
              id: `mint-${Date.now()}`,
              summary: `Minted ${mintQuote.amount} sats`,
              type: "lightning",
              direction: "in",
              amountSat: mintQuote.amount,
              mintUrl: targetMintRaw ?? undefined,
              stateLabel: "Paid",
            }),
            ...prev.filter((entry) => entry.id !== item.id),
          ]);
          setHistoryMintQuoteStates((prev) => {
            const next = { ...prev };
            delete next[item.id];
            return next;
          });
          showToast(`received ${mintQuote.amount} sats`, 3500);
          return;
        }
        const normalizedState =
          typeof state === "string" && state ? state.toUpperCase() : String(state ?? "").toUpperCase();
        setHistory((prev) =>
          prev.map((entry) =>
            entry.id === item.id && entry.mintQuote
              ? { ...entry, mintQuote: { ...entry.mintQuote, state: normalizedState } }
              : entry,
          ),
        );
        if (normalizedState === "EXPIRED") {
          setHistory((prev) => prev.filter((entry) => entry.id !== item.id));
          setHistoryMintQuoteStates((prev) => {
            const next = { ...prev };
            delete next[item.id];
            return next;
          });
          showToast("Invoice expired", 3000);
          return;
        }
        const message =
          normalizedState === "UNPAID" ? "Invoice not paid yet" : `Status: ${normalizedState || state || "Unknown"}`;
        setHistoryMintQuoteStates((prev) => ({
          ...prev,
          [item.id]: { status: "success", message },
        }));
    } catch (err: any) {
      const message = err?.message || String(err);
      setHistoryMintQuoteStates((prev) => ({
        ...prev,
        [item.id]: { status: "error", message },
      }));
    }
  },
  [buildHistoryEntry, checkMintQuote, claimMint, mintUrl, setHistory, setHistoryMintQuoteStates, showToast],
);
  const removeHistoryEntryStates = useCallback(
    (entryId: string) => {
      setHistoryCheckStates((prev) => {
        if (!(entryId in prev)) return prev;
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
      setHistoryMintQuoteStates((prev) => {
        if (!(entryId in prev)) return prev;
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
      setHistoryRedeemStates((prev) => {
        if (!(entryId in prev)) return prev;
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
      setHistoryRevertState((prev) => {
        if (!(entryId in prev)) return prev;
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
    },
    [
      setHistoryCheckStates,
      setHistoryMintQuoteStates,
      setHistoryRedeemStates,
      setHistoryRevertState,
    ],
  );
  const markHistoryEntryAsSpent = useCallback(
    (entry: HistoryItem, timestamp: number): HistoryItem => {
      const updated = markHistoryEntrySpentRaw(entry, timestamp);
      return (updated as HistoryItem) ?? entry;
    },
    [markHistoryEntrySpentRaw],
  );
  const markHistoryEntriesOlderThan = useCallback(
    (cutoffMs: number, options?: { suppressToast?: boolean }) => {
      const normalizedCutoff = Math.max(0, cutoffMs);
      const now = Date.now();
      const threshold = now - normalizedCutoff;
      const updatedIds: string[] = [];
      setHistory((prev) => {
        let changed = false;
        const next = prev.map((entry) => {
          if (!entry.tokenState) return entry;
          const createdAt =
            typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
              ? entry.createdAt
              : deriveTimestampFromId(entry.id);
          if (createdAt > threshold) return entry;
          const alreadySpent =
            entry.tokenState.lastState === "SPENT" || entry.summary.includes("(spent)");
          if (alreadySpent) return entry;
          const updatedEntry = markHistoryEntryAsSpent(entry, now);
          if (updatedEntry === entry) return entry;
          changed = true;
          updatedIds.push(entry.id);
          return updatedEntry;
        });
        return changed ? next : prev;
      });
      if (!updatedIds.length) {
        return 0;
      }
      setHistoryCheckStates((prev) => {
        const next = { ...prev };
        for (const id of updatedIds) {
          next[id] = { status: "success", message: "Token marked spent" };
        }
        return next;
      });
      if (!options?.suppressToast) {
        showToast(
          `Marked ${updatedIds.length} history entr${updatedIds.length === 1 ? "y" : "ies"} as spent`,
          3500,
        );
      }
      return updatedIds.length;
    },
    [markHistoryEntryAsSpent, setHistory, setHistoryCheckStates, showToast],
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<MarkHistoryEntriesOldSpentEventDetail>;
      const cutoffMs =
        customEvent?.detail && typeof customEvent.detail.cutoffMs === "number"
          ? customEvent.detail.cutoffMs
          : 0;
      markHistoryEntriesOlderThan(cutoffMs, { suppressToast: true });
    };
    window.addEventListener(MARK_HISTORY_ENTRIES_OLDER_SPENT_EVENT, handler);
    return () => {
      window.removeEventListener(MARK_HISTORY_ENTRIES_OLDER_SPENT_EVENT, handler);
    };
  }, [markHistoryEntriesOlderThan]);
  const handleMarkHistoryTokenSpent = useCallback(
    (item: HistoryItem) => {
      if (!item.tokenState) return;
      const timestamp = Date.now();
      setHistory((prev) =>
        prev.map((entry) => (entry.id === item.id ? markHistoryEntryAsSpent(entry, timestamp) : entry)),
      );
      setHistoryCheckStates((prev) => ({
        ...prev,
        [item.id]: { status: "success", message: "Token marked spent" },
      }));
      showToast("Token marked spent", 3000);
    },
    [markHistoryEntryAsSpent, setHistory, setHistoryCheckStates, showToast],
  );
  const handleDeleteHistoryEntry = useCallback(
    (item: HistoryItem) => {
      setHistory((prev) => prev.filter((entry) => entry.id !== item.id));
      removeHistoryEntryStates(item.id);
      setExpandedHistoryId((prev) => (prev === item.id ? null : prev));
      showToast("History entry deleted", 2000);
    },
    [removeHistoryEntryStates, setHistory, setExpandedHistoryId, showToast],
  );
  const [npubCashIdentity, setNpubCashIdentity] = useState<{ npub: string; address: string } | null>(null);
  const [npubCashIdentityError, setNpubCashIdentityError] = useState<string | null>(null);
  const [npubCashClaimStatus, setNpubCashClaimStatus] = useState<"idle" | "checking" | "success" | "error">("idle");
  const [npubCashClaimMessage, setNpubCashClaimMessage] = useState("");
  const deriveDefaultLightningAddress = useCallback(() => {
    if (npubCashIdentity?.address) return npubCashIdentity.address;
    const storedSk = kvStorage.getItem(LS_NOSTR_SK) || "";
    if (!storedSk) return "";
    try {
      const identity = deriveNpubCashIdentity(storedSk);
      return identity.address;
    } catch {
      return "";
    }
  }, [npubCashIdentity?.address]);
  const lightningAddressDisplay = useMemo(() => {
    const address = npubCashIdentity?.address?.trim();
    if (!address) return "";
    const [localPart, domain] = address.split("@");
    if (!localPart || !domain) return address;
    const normalizedLocalPart = localPart.trim();
    if (normalizedLocalPart.length <= 11) {
      return `${normalizedLocalPart}@${domain}`;
    }
    const prefix = normalizedLocalPart.slice(0, 7);
    const suffix = normalizedLocalPart.slice(-4);
    return `${prefix}…${suffix}@${domain}`;
  }, [npubCashIdentity?.address]);
  const nut16CollectorRef = useRef<Nut16Collector | null>(null);
  const lnRef = useRef<HTMLTextAreaElement | null>(null);
  const npubCashClaimAbortRef = useRef<AbortController | null>(null);
  const npubCashClaimingRef = useRef(false);
  const backgroundNpubCashClaimRef = useRef(false);
  const tokenStateCheckRunningRef = useRef(false);
  const nostrProcessedEventsRef = useRef<Set<string>>(new Set());
  const nostrLastCheckRef = useRef<number>(0);
  const autoClaimQueueRef = useRef<IncomingPaymentRequest[]>([]);
  const autoClaimRunningRef = useRef(false);
  const nostrSubscriptionCloserRef = useRef<null | (() => void)>(null);
  const handlePaymentRequestEventRef = useRef<
    ((event: NostrEvent, options?: { updateClock?: boolean }) => Promise<void>) | null
  >(null);
  const deepSyncDMsRef = useRef<(() => Promise<void>) | null>(null);
  const initialTokenCheckIdsRef = useRef<Set<string>>(new Set());
  const proofStateSubscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const proofStateSubscriptionMetadataRef = useRef<
    Map<string, { secretToItem: Map<string, { itemId: string; proofIndex: number }> }>
  >(new Map());
  const unsupportedProofSubscriptionMintsRef = useRef<Set<string>>(new Set());
  const proofSubscriptionCooldownRef = useRef<Map<string, number>>(new Map());
  const mintQuoteSubscriptionCooldownRef = useRef<Map<string, number>>(new Map());
  const unsupportedMintQuoteSubscriptionMintsRef = useRef<Set<string>>(new Set());
  const pendingMintInfoRef = useRef<Set<string>>(new Set());
  const previousReceiveModeRef = useRef<typeof receiveMode>(receiveMode);

  useEffect(() => {
    if (!paymentRequestsEnabled) {
      setCurrentPaymentRequest(null);
      incomingPaymentRequestsRef.current = [];
      setPaymentRequestStatusMessage("");
      setPaymentRequestError("");
      setClaimingEventIds([]);
      autoClaimQueueRef.current.length = 0;
      autoClaimRunningRef.current = false;
    }
  }, [paymentRequestsEnabled]);

  const clearProofStateSubscriptions = useCallback(() => {
    proofStateSubscriptionsRef.current.forEach((cancel) => {
      try {
        cancel();
      } catch (err) {
        console.warn("Error closing proof state subscription", err);
      }
    });
    proofStateSubscriptionsRef.current.clear();
    proofStateSubscriptionMetadataRef.current.clear();
  }, []);
  const resetTokenTracking = useCallback(() => {
    clearProofStateSubscriptions();
    proofSubscriptionCooldownRef.current.clear();
    unsupportedProofSubscriptionMintsRef.current.clear();
    mintQuoteSubscriptionCooldownRef.current.clear();
    unsupportedMintQuoteSubscriptionMintsRef.current.clear();
    initialTokenCheckIdsRef.current.clear();
    tokenStateCheckRunningRef.current = false;
    setHistoryCheckStates({});
    setHistoryMintQuoteStates({});
    setHistory((prev) => {
      let changed = false;
      const next = prev.map((entry) => {
        let nextTokenState = entry.tokenState;
        let tokenChanged = false;
        if (nextTokenState) {
          const suppress = nextTokenState.suppressChecks === true;
          const hasErrorMeta =
            !!nextTokenState.lastError ||
            !!nextTokenState.lastErrorAt ||
            (nextTokenState.errorCount ?? 0) > 0;
          if (!suppress || hasErrorMeta) {
            nextTokenState = {
              ...nextTokenState,
              suppressChecks: true,
            };
            delete (nextTokenState as any).lastError;
            delete (nextTokenState as any).lastErrorAt;
            delete (nextTokenState as any).errorCount;
            tokenChanged = true;
          }
        }
        let nextMintQuote = entry.mintQuote;
        let quoteChanged = false;
        if (nextMintQuote) {
          const suppress = nextMintQuote.suppressChecks === true;
          const hasErrorMeta =
            !!nextMintQuote.lastError ||
            !!nextMintQuote.lastErrorAt ||
            (nextMintQuote.errorCount ?? 0) > 0;
          if (!suppress || hasErrorMeta) {
            nextMintQuote = {
              ...nextMintQuote,
              suppressChecks: true,
            };
            delete (nextMintQuote as any).lastError;
            delete (nextMintQuote as any).lastErrorAt;
            delete (nextMintQuote as any).errorCount;
            quoteChanged = true;
          }
        }
        if (!tokenChanged && !quoteChanged) {
          return entry;
        }
        changed = true;
        return {
          ...entry,
          ...(tokenChanged ? { tokenState: nextTokenState! } : {}),
          ...(quoteChanged ? { mintQuote: nextMintQuote! } : {}),
        };
      });
      return changed ? next : prev;
    });
  }, [
    clearProofStateSubscriptions,
    setHistory,
    setHistoryCheckStates,
    setHistoryMintQuoteStates,
  ]);
  const normalizedLnInput = useMemo(() => lnInput.trim().replace(/^lightning:/i, "").trim(), [lnInput]);
  const isLnAddress = useMemo(() => /^[^@\s]+@[^@\s]+$/.test(normalizedLnInput), [normalizedLnInput]);
  const isLnurlInput = useMemo(() => /^lnurl[0-9a-z]+$/i.test(normalizedLnInput), [normalizedLnInput]);
  const isBolt11Input = useMemo(() => /^ln(bc|tb|sb|bcrt)[0-9]/i.test(normalizedLnInput), [normalizedLnInput]);
  const lightningSendAddressDisplay = useMemo(() => {
    if (!isLnAddress) return "";
    return formatLightningAddressDisplay(normalizedLnInput);
  }, [isLnAddress, normalizedLnInput]);
  const lightningDestinationDisplay = useMemo(() => {
    if (!normalizedLnInput) return "";
    if (isLnAddress) return lightningSendAddressDisplay;
    if (isLnurlInput) return `LNURL (${lnurlPayData?.domain || extractDomain(normalizedLnInput)})`;
    return normalizedLnInput;
  }, [
    isLnAddress,
    isLnurlInput,
    lnurlPayData,
    lightningSendAddressDisplay,
    normalizedLnInput,
  ]);
  const lightningInvoiceAmountSat = useMemo(
    () => (isBolt11Input ? estimateInvoiceAmountSat(normalizedLnInput) : null),
    [isBolt11Input, normalizedLnInput],
  );
  const tokenizedHistoryItems = useMemo(
    () => history.filter((entry) => entry.tokenState && entry.tokenState.proofs.length),
    [history],
  );
  const pendingTokenStateItems = useMemo(() => {
    const now = Date.now();
    const earliestAllowed = now - TOKEN_STATE_BACKGROUND_WINDOW_MS;
    return tokenizedHistoryItems.filter((entry) => {
      const tokenState = entry.tokenState;
      if (!tokenState) return false;
      if (tokenState.lastState === "SPENT") return false;
      if (tokenState.suppressChecks === true) return false;
      if (typeof entry.summary === "string" && entry.summary.includes("(spent)")) return false;
      const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : null;
      const lastCheckedAt = typeof tokenState.lastCheckedAt === "number" ? tokenState.lastCheckedAt : null;
      const lastActivity = Math.max(createdAt ?? 0, lastCheckedAt ?? 0);
      if (lastActivity <= 0) return false;
      return lastActivity >= earliestAllowed;
    });
  }, [tokenizedHistoryItems]);
  const pendingMintQuoteHistoryItems = useMemo(() => {
    const normalizedActive = mintUrl ? normalizeMintUrl(mintUrl) : null;
    const now = Date.now();
    const earliestAllowed = now - MINT_QUOTE_SUBSCRIPTION_WINDOW_MS;
    return history.filter((entry) => {
      const mintQuote = entry.mintQuote;
      if (!mintQuote) return false;
      const quoteId = mintQuote.quote?.trim();
      if (!quoteId) return false;
      if (mintQuote.suppressChecks) return false;
      const createdAt =
        typeof mintQuote.createdAt === "number"
          ? mintQuote.createdAt
          : typeof entry.createdAt === "number"
            ? entry.createdAt
            : deriveTimestampFromId(entry.id);
      if (createdAt && Number.isFinite(createdAt) && createdAt < earliestAllowed) return false;
      if (mintQuote.expiresAt && mintQuote.expiresAt <= now) return false;
      const targetMint = mintQuote.mintUrl ? normalizeMintUrl(mintQuote.mintUrl) : normalizedActive;
      if (!targetMint) return false;
      return true;
    });
  }, [history, mintUrl]);
  const isHistoryEntryPending = useCallback((entry: HistoryItem) => {
    if (entry.pendingTokenId && entry.pendingStatus !== "redeemed") return true;
    if (entry.tokenState && entry.tokenState.lastState !== "SPENT") return true;
    if (entry.mintQuote) return true;
    return false;
  }, []);
  const pendingHistoryItems = useMemo(
    () => history.filter((entry) => isHistoryEntryPending(entry)),
    [history, isHistoryEntryPending],
  );
  const bountyHistoryItems = useMemo(
    () => history.filter((entry) => entry.entryKind === "bounty-attachment"),
    [history],
  );
  const filteredHistory = useMemo(() => {
    if (historyFilter === "pending") {
      return pendingHistoryItems;
    }
    if (historyFilter === "bounty") {
      return bountyHistoryItems;
    }
    return history;
  }, [history, historyFilter, pendingHistoryItems, bountyHistoryItems]);
  const hasExpiringMintQuotes = useMemo(
    () => history.some((entry) => entry.mintQuote?.expiresAt),
    [history],
  );
  const expireStaleMintQuotes = useCallback(() => {
    setHistory((prev) => {
      const now = Date.now();
      let changed = false;
      const removedIds: string[] = [];
      const next = prev.filter((entry) => {
        const expiresAt = entry.mintQuote?.expiresAt;
        if (!expiresAt) return true;
        if (expiresAt > now) return true;
        changed = true;
        removedIds.push(entry.id);
        return false;
      });
      if (changed) {
        setHistoryMintQuoteStates((prevStates) => {
          if (!removedIds.length) return prevStates;
          const updated = { ...prevStates };
          removedIds.forEach((id) => {
            if (id in updated) {
              delete updated[id];
            }
          });
          return updated;
        });
      }
      return changed ? next : prev;
    });
  }, [setHistory, setHistoryMintQuoteStates]);
  const pruneStaleUnpaidMintQuotes = useCallback(() => {
    setHistory((prev) => {
      const now = Date.now();
      let changed = false;
      const removedIds: string[] = [];
      const next = prev.filter((entry) => {
        const mintQuote = entry.mintQuote;
        if (!mintQuote) return true;
        const normalizedState =
          typeof mintQuote.state === "string" && mintQuote.state
            ? mintQuote.state.toUpperCase()
            : "";
        if (normalizedState === "PAID" || normalizedState === "ISSUED") return true;
        const createdAt =
          typeof mintQuote.createdAt === "number"
            ? mintQuote.createdAt
            : typeof entry.createdAt === "number"
              ? entry.createdAt
              : deriveTimestampFromId(entry.id);
        if (!Number.isFinite(createdAt) || createdAt <= 0) return true;
        if (now - createdAt < UNPAID_MINT_QUOTE_RETENTION_MS) return true;
        changed = true;
        removedIds.push(entry.id);
        return false;
      });
      if (!changed) return prev;
      setHistoryMintQuoteStates((prevStates) => {
        if (!removedIds.some((id) => id in prevStates)) return prevStates;
        const updated = { ...prevStates };
        removedIds.forEach((id) => {
          if (id in updated) {
            delete updated[id];
          }
        });
        return updated;
      });
      return next;
    });
  }, [setHistory, setHistoryMintQuoteStates]);
  useEffect(() => {
    if (!hasExpiringMintQuotes) return;
    expireStaleMintQuotes();
    const timer = window.setInterval(expireStaleMintQuotes, 30000);
    return () => window.clearInterval(timer);
  }, [expireStaleMintQuotes, hasExpiringMintQuotes]);
  useEffect(() => {
    pruneStaleUnpaidMintQuotes();
    const timer = window.setInterval(pruneStaleUnpaidMintQuotes, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [pruneStaleUnpaidMintQuotes]);
  const historyFilterControls = useMemo(() => {
    if (!history.length) return null;
    return (
      <div className="history-filter" role="group" aria-label="Filter history">
        <button
          type="button"
          className="history-filter__option"
          onClick={() => {
            setHistoryFilter("all");
            setExpandedHistoryId(null);
          }}
          aria-pressed={historyFilter === "all"}
        >
          All
        </button>
        <span className="history-filter__divider" aria-hidden="true">
          •
        </span>
        <button
          type="button"
          className="history-filter__option"
          onClick={() => {
            setHistoryFilter("bounty");
            setExpandedHistoryId(null);
          }}
          disabled={!bountyHistoryItems.length}
          aria-pressed={historyFilter === "bounty"}
        >
          Bounties
          {bountyHistoryItems.length ? (
            <span className="history-filter__badge">{bountyHistoryItems.length}</span>
          ) : null}
        </button>
        <span className="history-filter__divider" aria-hidden="true">
          •
        </span>
        <button
          type="button"
          className="history-filter__option"
          onClick={() => {
            setHistoryFilter("pending");
            setExpandedHistoryId(null);
          }}
          disabled={!pendingHistoryItems.length}
          aria-pressed={historyFilter === "pending"}
        >
          Pending
          <span className="history-filter__badge">{pendingHistoryItems.length}</span>
        </button>
      </div>
    );
  }, [history.length, historyFilter, pendingHistoryItems.length, bountyHistoryItems.length]);
  useEffect(() => {
    if (historyFilter === "pending" && pendingHistoryItems.length === 0) {
      setHistoryFilter("all");
      return;
    }
    if (historyFilter === "bounty" && bountyHistoryItems.length === 0) {
      setHistoryFilter("all");
    }
  }, [historyFilter, pendingHistoryItems.length, bountyHistoryItems.length]);
  useEffect(() => {
    if (!expandedHistoryId) return;
    const matchesFilter = filteredHistory.some((entry) => entry.id === expandedHistoryId);
    if (!matchesFilter) {
      setExpandedHistoryId(null);
    }
  }, [expandedHistoryId, filteredHistory]);
  const bolt11Details = useMemo(() => {
    if (!isBolt11Input) return null;
    try {
      const { amountMsat } = decodeBolt11Amount(normalizedLnInput);
      if (amountMsat === null) {
        return { message: "Invoice amount: not specified" };
      }
      return { message: `Invoice amount: ${formatMsatAsSat(amountMsat)}` };
    } catch (err: any) {
      return { error: err?.message || "Unable to decode invoice" };
    }
  }, [isBolt11Input, normalizedLnInput]);
  const lnurlRequiresAmount = useMemo(() => {
    if (!isLnurlInput) return false;
    if (!lnurlPayData) return true;
    if (lnurlPayData.lnurl.trim().toLowerCase() !== normalizedLnInput.toLowerCase()) return true;
    return lnurlPayData.minSendable !== lnurlPayData.maxSendable;
  }, [isLnurlInput, lnurlPayData, normalizedLnInput]);
  const hasNwcConnection = !!nwcConnection;
  const messageItemsByEventId = useMemo(() => {
    const map = new Map<string, WalletMessageItem>();
    messageItems.forEach((item) => {
      const key = item.dmEventId?.trim();
      if (key) map.set(key, item);
    });
    return map;
  }, [messageItems]);
  const paymentHistoryByEventId = useMemo(() => {
    const map = new Map<string, HistoryItem>();
    history.forEach((entry) => {
      const match = PAYMENT_HISTORY_EVENT_ID_REGEX.exec(entry.id);
      if (match?.[1]) {
        map.set(match[1].toLowerCase(), entry);
      }
    });
    return map;
  }, [history]);
  const dmPreviewForMessage = useCallback(
    (msg: WalletDmMessage) => {
      if (msg.attachment?.type === "payment") {
        const historyEntry = paymentHistoryByEventId.get(msg.eventId.toLowerCase());
        if (historyEntry?.summary) {
          return historyEntry.summary;
        }
      }
      return msg.preview;
    },
    [paymentHistoryByEventId],
  );

  const messageItemStatusRef = useRef<Map<string, WalletMessageItem["status"]>>(new Map());
  useEffect(() => {
    const seenIds = new Set<string>();
    messageItems.forEach((item) => {
      seenIds.add(item.id);
      const prevStatus = messageItemStatusRef.current.get(item.id);
      if (prevStatus === undefined) {
        messageItemStatusRef.current.set(item.id, item.status);
        return;
      }
      if (prevStatus !== item.status) {
        messageItemStatusRef.current.set(item.id, item.status);
        if (item.status === "accepted") {
          const label = getWalletMessageStatusLabel(item.type, item.status);
          if (label) {
            showToast(label);
          }
        }
      }
    });
    messageItemStatusRef.current.forEach((_, key) => {
      if (!seenIds.has(key)) {
        messageItemStatusRef.current.delete(key);
      }
    });
  }, [messageItems, showToast]);
  const ensurePeerProfile = useCallback(
    async (pubkey: string) => {
      const normalized = normalizeNostrPubkey(pubkey);
      if (!normalized) return null;
      const peerHex = compressedToRawHex(normalized).toLowerCase();
      if (dmPeerProfilesRef.current.has(peerHex)) return dmPeerProfilesRef.current.get(peerHex)!;
      const contactEntry = contacts.find((c) => {
        const cn = normalizeNostrPubkey(c.npub || "");
        if (!cn) return false;
        return compressedToRawHex(cn).toLowerCase() === peerHex;
      });
      if (contactEntry) {
        dmPeerProfilesRef.current.set(peerHex, {
          username: contactEntry.username || contactEntry.name,
          displayName: contactDisplayLabel(contactEntry),
          lud16: contactEntry.address || undefined,
          paymentRequest: contactEntry.paymentRequest || undefined,
          nip05: contactEntry.nip05 || undefined,
          picture: contactEntry.picture || undefined,
          about: contactEntry.about || undefined,
        });
        setDmPeerProfilesVersion((v) => v + 1);
        if (contactEntry.nip05) {
          ensureNip05VerificationRef.current?.(
            `dm-${peerHex}`,
            contactEntry.nip05,
            pubkey,
            contactEntry.updatedAt ?? null,
          );
        }
        return dmPeerProfilesRef.current.get(peerHex)!;
      }
      const cachedProfiles = loadContactProfileCache();
      const cached = cachedProfiles[peerHex];
      if (cached?.profile) {
        dmPeerProfilesRef.current.set(peerHex, cached.profile);
        setDmPeerProfilesVersion((v) => v + 1);
        if (cached.profile.nip05) {
          ensureNip05VerificationRef.current?.(
            `dm-${peerHex}`,
            cached.profile.nip05,
            pubkey,
            cached.updatedAt ?? null,
          );
        }
        return cached.profile;
      }
      if (dmPeerProfileLoadingRef.current.has(peerHex)) return null;
      dmPeerProfileLoadingRef.current.add(peerHex);
      try {
        const relays = defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")).filter(Boolean);
        if (!relays.length) return null;
        const session = await NostrSession.init(relays);
        const events = await session.fetchEvents([{ kinds: [0], authors: [peerHex] }], relays);
        const profileEvent = Array.isArray(events)
          ? events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]
          : null;
        if (profileEvent?.content) {
          const profile = parseProfileContent(profileEvent.content);
          dmPeerProfilesRef.current.set(peerHex, profile);
          setDmPeerProfilesVersion((v) => v + 1);
          if (profile.nip05) {
            ensureNip05VerificationRef.current?.(
              `dm-${peerHex}`,
              profile.nip05,
              pubkey,
              (profileEvent.created_at || 0) * 1000,
            );
          }
          return profile;
        }
      } catch (err) {
        console.warn("Failed to load DM peer profile", err);
      } finally {
        dmPeerProfileLoadingRef.current.delete(peerHex);
      }
      return null;
    },
    [
      compressedToRawHex,
      contacts,
      defaultNostrRelays,
      normalizeNostrPubkey,
      parseProfileContent,
    ],
  );
  const getPeerProfile = useCallback(
    (pubkey: string): ContactProfile | undefined => {
      const normalized = normalizeNostrPubkey(pubkey);
      if (!normalized) return undefined;
      const peerHex = compressedToRawHex(normalized).toLowerCase();
      return dmPeerProfilesRef.current.get(peerHex);
    },
    [compressedToRawHex, normalizeNostrPubkey],
  );
  const handleDmEvent = useCallback(
    async (event: NostrEvent) => {
      if (!event?.id) return;
      if (dmProcessedEventsRef.current.has(event.id)) return;
      if (dmDeletedEventsRef.current.has(event.id)) {
        dmProcessedEventsRef.current.add(event.id);
        return;
      }
      const identity = ensureNostrIdentity();
      if (!identity) return;
      const decrypted = await decryptNostrPaymentMessage(event, identity.pubkey, identity.secret);
      if (!decrypted?.content) {
        dmProcessedEventsRef.current.add(event.id);
        return;
      }
      const peerPubkey = resolvePeerPubkey(
        event,
        identity.pubkey,
        decrypted.senderPubkey,
        decrypted.recipientPubkey,
      );
      const normalizedPeer = (peerPubkey || event.pubkey || "").toLowerCase();
      if (normalizedPeer && dmBlockedPeersRef.current.has(normalizedPeer)) {
        dmProcessedEventsRef.current.add(event.id);
        return;
      }
      if (peerPubkey) {
        void ensurePeerProfile(peerPubkey);
      }

      let attachment: WalletDmAttachment | undefined;
      let preview = truncatePreview(decrypted.content, 140);
      const share = parseShareEnvelope(decrypted.content);
      const matchedItem = messageItems.find((item) => item.dmEventId && item.dmEventId === event.id);

      if (share && share.item.type === "board") {
        attachment = {
          type: "board",
          boardName: share.item.boardName || "Shared board",
          boardId: share.item.boardId,
          taskId: matchedItem?.id ?? null,
          status: matchedItem?.status ?? null,
        };
        preview = `Shared board: ${share.item.boardName || "Board"}`;
      } else if (share && share.item.type === "contact") {
        const contactNpub = normalizeNostrPubkey(share.item.npub);
        if (contactNpub) {
          void ensurePeerProfile(contactNpub);
        }
          attachment = {
            type: "contact",
            contactName: share.item.name || share.item.displayName || share.item.username || "Shared contact",
            displayName: share.item.displayName,
            username: share.item.username,
            npub: share.item.npub,
            nip05: share.item.nip05,
            address: share.item.lud16 || (share.item as any).address || null,
            picture: share.item.picture,
            taskId: matchedItem?.id ?? null,
            status: matchedItem?.status ?? null,
          };
        preview = `Shared contact${share.item.name ? `: ${share.item.name}` : ""}`;
      } else if (share && share.item.type === "task") {
        attachment = {
          type: "task",
          task: share.item,
          taskId: matchedItem?.id ?? null,
          status: matchedItem?.status ?? null,
        };
        preview = `Shared task${share.item.title ? `: ${share.item.title}` : ""}`;
      } else {
        const paymentPayload = parseIncomingPaymentMessage(decrypted.content);
        if (paymentPayload) {
          let amountSat: number | null = null;
          let detail: string | null = null;
          if (typeof paymentPayload === "object") {
            const amountRaw =
              (paymentPayload as any).amount ??
              (paymentPayload as any).amountSat ??
              (paymentPayload as any).amountMsat ??
              (paymentPayload as any).amount_msat;
            amountSat =
              typeof amountRaw === "number"
                ? Math.max(0, Math.floor((amountRaw >= 1_000_000 ? amountRaw / 1000 : amountRaw)))
                : null;
            detail = typeof (paymentPayload as any).memo === "string" ? (paymentPayload as any).memo : null;
          } else if (typeof paymentPayload === "string") {
            try {
              const decoded = getDecodedToken(paymentPayload);
              const entries: any[] = decoded
                ? Array.isArray((decoded as any)?.token)
                  ? (decoded as any).token
                  : (decoded as any)?.proofs
                    ? [decoded]
                    : []
                : [];
              const decodedAmount = entries.reduce(
                (outer, entry) => outer + sumProofAmounts(Array.isArray(entry?.proofs) ? entry.proofs : []),
                0,
              );
              amountSat = decodedAmount > 0 ? decodedAmount : null;
            } catch {
              amountSat = null;
            }
          }
          attachment = {
            type: "payment",
            amountSat,
            detail,
            raw: decrypted.content,
          };
          preview =
            amountSat && amountSat > 0
              ? `Received ${amountSat} sats via Nostr`
              : "Payment token received";
        }
      }

      const createdAt = Number(event.created_at) || Math.floor(Date.now() / 1000);
      const normalizedSender = decrypted.senderPubkey
        ? normalizeNostrPubkey(decrypted.senderPubkey) ?? decrypted.senderPubkey
        : null;
      const normalizedIdentity = normalizeNostrPubkey(identity.pubkey) ?? identity.pubkey;
      const isIncoming =
        normalizedSender != null ? normalizedSender !== normalizedIdentity : event.pubkey !== identity.pubkey;
      if (isIncoming && attachment?.type === "payment") {
        const handler = handlePaymentRequestEventRef.current;
        if (handler) {
          void handler(event, { updateClock: true });
        }
      }
      const message: WalletDmMessage = {
        id: crypto.randomUUID(),
        eventId: event.id,
        peerPubkey: (peerPubkey || event.pubkey).toLowerCase(),
        isIncoming,
        createdAt,
        content: decrypted.content,
        preview,
        attachment: attachment ?? { type: "text" },
      };

      dmProcessedEventsRef.current.add(event.id);
      setDmMessages((prev) => {
        if (prev.some((m) => m.eventId === event.id)) return prev;
        const next = [...prev, message].sort((a, b) => a.createdAt - b.createdAt);
        if (next.length > 400) next.shift();
        return next;
      });
    },
    [
      decryptNostrPaymentMessage,
      ensureNostrIdentity,
      ensurePeerProfile,
      messageItems,
      normalizeNostrPubkey,
      parseIncomingPaymentMessage,
      resolvePeerPubkey,
    ],
  );
  const startDmSubscription = useCallback(async () => {
    stopDmSubscription();
    const identity = ensureNostrIdentity();
    if (!identity) return;
    const relays = defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")).filter(Boolean);
    if (!relays.length) return;
    const now = Math.floor(Date.now() / 1000);
    const since = Math.max(0, now - DM_SYNC_LOOKBACK_SECONDS);
    try {
      const session = await NostrSession.init(relays);
      const filters = [
        { kinds: [4, 1059], "#p": [identity.pubkey], since },
        { kinds: [4, 1059], authors: [identity.pubkey], since },
      ];
      const managed = await session.subscribe(filters, {
        relayUrls: relays,
        onEvent: (ev) => {
          void handleDmEvent(ev as NostrEvent);
        },
      });
      dmSubscriptionCloseRef.current = () => {
        try {
          managed.release();
        } catch {
          // ignore
        }
      };

      const history = await session.fetchEvents(filters, relays);
      const ordered = history
        .filter((ev) => ev && (ev.kind === 4 || ev.kind === 1059))
        .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      for (const ev of ordered) {
        await handleDmEvent(ev as NostrEvent);
      }
      dmLastSyncRef.current = Date.now();
    } catch (err) {
      console.warn("Failed to sync DMs", err);
    }
  }, [DM_SYNC_LOOKBACK_SECONDS, defaultNostrRelays, ensureNostrIdentity, handleDmEvent, stopDmSubscription]);
  const contactIndex = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        picture?: string;
      }
    >();
    contacts.forEach((contact) => {
      const normalized = normalizeNostrPubkey(contact.npub || "");
      if (!normalized) return;
      const compressed = normalized.toLowerCase();
      const raw = compressedToRawHex(normalized).toLowerCase();
      const entry = {
        name: contactDisplayLabel(contact),
        picture: contact.picture?.trim() || undefined,
      };
      map.set(compressed, entry);
      map.set(raw, entry);
    });
    return map;
  }, [compressedToRawHex, contacts, normalizeNostrPubkey]);
  const peerLabelFor = useCallback(
    (peerHex: string) => {
      const contact = contactIndex.get(peerHex);
      const profile = dmPeerProfilesRef.current.get(peerHex);
      const npub = formatNpubDisplay(peerHex);
      const verifiedNip05 =
        profile?.nip05 && isNip05VerifiedForRef.current?.(`dm-${peerHex}`, profile.nip05, npub)
          ? profile.nip05
          : null;
      const label =
        (profile?.displayName && profile.displayName.trim()) ||
        (contact?.name && contact.name.trim()) ||
        (verifiedNip05 ? verifiedNip05 : "") ||
        (profile?.username && profile.username.trim()) ||
        shortenNpubDisplay(npub) ||
        peerHex.slice(0, 10);
      const subtitle = verifiedNip05 || profile?.username || undefined;
      const picture = contact?.picture || (profile?.picture || "").trim() || undefined;
      return { label, subtitle, picture, verifiedNip05 };
    },
    [contactIndex, formatNpubDisplay],
  );
  const sharedContactMetaFor = useCallback(
    (npub?: string | null, fallbackName?: string | null, fallbackPicture?: string | null) => {
      const normalized = npub ? normalizeNostrPubkey(npub) : null;
      const hex = normalized ? compressedToRawHex(normalized).toLowerCase() : null;
      const profile = hex ? dmPeerProfilesRef.current.get(hex) : undefined;
      const npubDisplay = hex ? formatNpubDisplay(hex) : formatNpubDisplay(npub);
      const verifiedNip05 =
        profile?.nip05 &&
        hex &&
        isNip05VerifiedForRef.current?.(`dm-${hex}`, profile.nip05, npubDisplay || npub || hex)
          ? profile.nip05
          : null;
      const label =
        (profile?.displayName && profile.displayName.trim()) ||
        (fallbackName && fallbackName.trim()) ||
        (verifiedNip05 ? verifiedNip05 : "") ||
        (profile?.username && profile.username.trim()) ||
        (npubDisplay ? shortenNpubDisplay(npubDisplay, 10, 6) : hex?.slice(0, 12) || "Contact");
      const subtitle = verifiedNip05 || profile?.username || (npubDisplay || undefined);
      const picture = (profile?.picture || fallbackPicture || "").trim() || undefined;
      return {
        label,
        subtitle,
        picture,
        verifiedNip05,
        npub: npubDisplay || formatNpubDisplay(npub) || "",
      };
    },
    [compressedToRawHex, formatNpubDisplay, normalizeNostrPubkey],
  );
  useEffect(() => {
    if (!dmMessages.length) return;
    const targets = new Set<string>();
    dmMessages.forEach((msg) => {
      if (msg.peerPubkey) {
        const normalized = normalizeNostrPubkey(msg.peerPubkey);
        if (normalized) targets.add(normalized);
      }
      if (msg.attachment?.type === "contact" && msg.attachment.npub) {
        const normalized = normalizeNostrPubkey(msg.attachment.npub);
        if (normalized) targets.add(normalized);
      }
    });
    targets.forEach((pubkey) => {
      void ensurePeerProfile(pubkey);
    });
  }, [dmMessages, ensurePeerProfile]);
  const dmThreads = useMemo(() => {
    if (!dmMessages.length) return [] as WalletDmThread[];
    const threads = new Map<string, WalletDmThread>();
    const contactKeys = new Set(Array.from(contactIndex.keys()));
    dmMessages.forEach((msg) => {
      const preview = dmPreviewForMessage(msg);
      const peer = msg.peerPubkey.toLowerCase();
      const existing = threads.get(peer);
      const base: WalletDmThread =
        existing ??
        {
          peerPubkey: peer,
          messages: [],
          lastCreatedAt: 0,
          lastPreview: "",
          isStranger: !contactKeys.has(peer),
        };
      base.messages.push(msg);
      if (msg.createdAt > base.lastCreatedAt) {
        base.lastCreatedAt = msg.createdAt;
        base.lastPreview = preview;
      }
      threads.set(peer, base);
    });
    const ordered = Array.from(threads.values()).map((thread) => ({
      ...thread,
      messages: [...thread.messages].sort((a, b) => a.createdAt - b.createdAt),
    }));
    ordered.sort((a, b) => b.lastCreatedAt - a.lastCreatedAt);
    return ordered;
  }, [contactIndex, dmMessages, dmPreviewForMessage]);
  const activeThread = useMemo(
    () => (activeThreadPeer ? dmThreads.find((t) => t.peerPubkey === activeThreadPeer) ?? null : null),
    [activeThreadPeer, dmThreads],
  );
  useEffect(() => {
    if (dmView === "thread" && !activeThread) {
      setDmView("list");
      setActiveThreadPeer(null);
    }
  }, [activeThread, dmView]);
  const threadUnreadMap = useMemo(() => {
    const map = new Map<string, number>();
    dmThreads.forEach((thread) => {
      const count = thread.messages.reduce((acc, msg) => {
        const item = messageItemsByEventId.get(msg.eventId);
        if (!item) return acc;
        const status = item.status;
        if (status === "accepted" || status === "deleted" || status === "read") return acc;
        return acc + 1;
      }, 0);
      map.set(thread.peerPubkey, count);
    });
    return map;
  }, [dmThreads, messageItemsByEventId]);
  const strangerUnreadCount = useMemo(
    () =>
      dmThreads.reduce((acc, thread) => {
        if (!thread.isStranger) return acc;
        return acc + (threadUnreadMap.get(thread.peerPubkey) || 0);
      }, 0),
    [dmThreads, threadUnreadMap],
  );
  const mainUnreadCount = useMemo(
    () =>
      dmThreads.reduce((acc, thread) => {
        if (thread.isStranger) return acc;
        return acc + (threadUnreadMap.get(thread.peerPubkey) || 0);
      }, 0),
    [dmThreads, threadUnreadMap],
  );
  const activeThreadBlocked = activeThread
    ? dmBlockedPeersRef.current.has(activeThread.peerPubkey.toLowerCase())
    : false;
  useEffect(() => {
    if (!activeThread) return;
    const unreadIds = activeThread.messages
      .map((m) => m.eventId)
      .filter((id) => {
        const item = messageItemsByEventId.get(id);
        if (!item) return false;
        const status = item.status;
        return status !== "accepted" && status !== "deleted" && status !== "read";
      });
    if (unreadIds.length) {
      onMarkMessagesRead(unreadIds);
    }
  }, [activeThread, messageItemsByEventId, onMarkMessagesRead]);
  const toggleBlockPeer = useCallback(
    (peerPubkey: string) => {
      const key = (peerPubkey || "").toLowerCase().trim();
      if (!key) return;
      const next = new Set(dmBlockedPeersRef.current);
      const isBlocking = !next.has(key);
      if (isBlocking) {
        next.add(key);
      } else {
        next.delete(key);
      }
      dmBlockedPeersRef.current = next;
      persistBlockedPeers(next);
      setDmBlockedPeersVersion((v) => v + 1);
      setDmMessageActions(null);
      cancelDmLongPress();
      showToast(isBlocking ? "User blocked" : "User unblocked", isBlocking ? 2000 : 1600);
    },
    [cancelDmLongPress, persistBlockedPeers, showToast],
  );
  const handleAddPeerToContacts = useCallback(
    (peerPubkey: string) => {
      if (!peerPubkey) return;
      const npub = formatNpub(peerPubkey);
      const profile = getPeerProfile(peerPubkey);
      const label = peerLabelFor(peerPubkey);
      const contact = upsertContact({
        npub,
        name: profile?.displayName || profile?.username || label.label,
        displayName: profile?.displayName || label.label,
        username: profile?.username,
        address: profile?.lud16 || "",
        picture: profile?.picture,
      });
      if (contact) {
        showToast("Added to contacts", 2000);
      } else {
        showToast("Unable to add contact", 2400);
      }
    },
    [formatNpub, getPeerProfile, peerLabelFor, showToast, upsertContact],
  );
  const sortedContacts = useMemo(() => {
    return [...contacts].sort((a, b) => {
      const baseA = (a.name || a.address || a.nip05 || a.npub || "").toLowerCase();
      const baseB = (b.name || b.address || b.nip05 || b.npub || "").toLowerCase();
      if (baseA < baseB) return -1;
      if (baseA > baseB) return 1;
      const fallbackA = a.address || a.npub || "";
      const fallbackB = b.address || b.npub || "";
      return fallbackA.localeCompare(fallbackB);
    });
  }, [contacts]);
  const visibleContacts = useMemo(() => {
    if (!contactsContext) return sortedContacts;
    return sortedContacts.filter((contact) =>
      contactsContext === "lightning"
        ? contact.address.trim().length > 0
        : contactHasNpub(contact) || contact.paymentRequest.trim().length > 0,
    );
  }, [contactsContext, sortedContacts]);
  const shareRecipientOptions = useMemo(() => {
    const sourceHex = shareContactSource?.npub
      ? compressedToRawHex(
          normalizeNostrPubkey(shareContactSource.npub) ?? shareContactSource.npub,
        ).toLowerCase()
      : null;
    return contacts.filter((contact) => {
      if (!contactHasNpub(contact)) return false;
      const normalized = normalizeNostrPubkey(contact.npub);
      const contactHex = normalized
        ? compressedToRawHex(normalized).toLowerCase()
        : contact.npub.trim().toLowerCase();
      if (sourceHex && contactHex && contactHex === sourceHex) return false;
      return true;
    });
  }, [compressedToRawHex, contacts, normalizeNostrPubkey, shareContactSource]);
  const handleShareContactToContact = useCallback(
    async (recipient: Contact) => {
      if (!shareContactSource) {
        setShareContactStatus("Select a contact to share first.");
        return;
      }
      const sourceNpub = formatContactNpub(shareContactSource.npub);
      if (!sourceNpub) {
        setShareContactStatus("This contact is missing a valid npub.");
        return;
      }
      const normalizedRecipient = normalizeNostrPubkey(recipient.npub);
      if (!normalizedRecipient) {
        setShareContactStatus("Recipient contact is missing a valid npub.");
        return;
      }
      const { identity, reason } = readNostrIdentity();
      if (!identity) {
        setShareContactStatus(reason || "Add your Taskify Nostr key in Settings → Nostr.");
        return;
      }
      const storedRelays = (() => {
        try {
          const raw = kvStorage.getItem(LS_NOSTR_RELAYS);
          const parsed = raw ? JSON.parse(raw) : null;
          if (Array.isArray(parsed)) {
            return parsed.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean);
          }
        } catch {
          // ignore
        }
        return [];
      })();
      const relaySource = Array.isArray(shareContactSource.relays)
        ? shareContactSource.relays
        : storedRelays.length
          ? storedRelays
          : defaultNostrRelays;
      const relayList = Array.from(
        new Set(
          [
            ...relaySource,
            ...defaultNostrRelays,
          ]
            .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
            .filter(Boolean),
        ),
      );
      if (!relayList.length) {
        setShareContactStatus("Add at least one relay first.");
        return;
      }
      setShareContactBusy(true);
      setShareContactStatus(null);
      try {
        const envelope = buildContactShareEnvelope({
          type: "contact",
          npub: sourceNpub,
          // Keep payload lean to avoid oversized NIP-44 plaintexts; other fields can be fetched later.
          relays: shareContactSource.relays,
          sender: {
            npub: formatNpub(identity.pubkey),
            name: profileForm.displayName || profileForm.username || undefined,
          },
        });
        await sendShareMessage(envelope, normalizedRecipient, identity.secret, relayList);
        setShareContactPickerOpen(false);
        setShareContactSource(null);
        showToast(`Contact sent to ${contactPrimaryName(recipient)}`, 3000);
      } catch (err: any) {
        setShareContactStatus(err?.message || "Unable to send contact.");
      } finally {
        setShareContactBusy(false);
      }
    },
    [
      defaultNostrRelays,
      formatContactNpub,
      formatNpub,
      normalizeNostrPubkey,
      profileForm.displayName,
      profileForm.username,
      readNostrIdentity,
      shareContactSource,
      showToast,
    ],
  );
  const publicFollowOptions = useMemo(
    () => {
      const seen = new Set<string>();
      return (contactSyncMeta.publicFollows || [])
        .map((follow) => {
          const pubkey = (follow.pubkey || "").trim();
          if (!pubkey) return null;
          const key = pubkey.toLowerCase();
          if (seen.has(key)) return null;
          seen.add(key);
          const username = sanitizeUsername(follow.username || "");
          const nip05 = (follow.nip05 || "").trim();
          return {
            pubkey,
            npub: formatNpub(pubkey),
            relay: (follow.relay || "").trim(),
            petname: (follow.petname || "").trim(),
            username: username || undefined,
            nip05: nip05 || undefined,
          };
        })
        .filter(Boolean) as Array<{
          pubkey: string;
          npub: string;
          relay?: string;
          petname?: string;
          username?: string;
          nip05?: string;
        }>;
    },
    [contactSyncMeta.publicFollows, formatNpub],
  );
  const lightningContactCount = useMemo(
    () => contacts.reduce((count, contact) => (contact.address.trim().length > 0 ? count + 1 : count), 0),
    [contacts],
  );
  const truncateContactName = (value: string, maxLength = 32) => {
    const normalized = (value || "").trim();
    if (normalized.length <= maxLength) return normalized || "Contact";
    const ellipsis = "…";
    const lead = Math.max(6, Math.min(18, Math.floor((maxLength - 1) / 2)));
    const tail = Math.max(4, maxLength - lead - 1);
    return `${normalized.slice(0, lead)}${ellipsis}${normalized.slice(-tail)}`;
  };
  const truncateContactValue = (value: string, maxLength = 48) => {
    const normalized = (value || "").trim();
    if (normalized.length <= maxLength) return normalized;
    const ellipsis = "…";
    const lead = Math.max(8, Math.min(18, Math.floor((maxLength - 1) / 2)));
    const tail = Math.max(6, maxLength - lead - 1);
    return `${normalized.slice(0, lead)}${ellipsis}${normalized.slice(-tail)}`;
  };
  const contactsPanelContent = (context: "lightning" | "ecash") => {
    if (contactsContext !== context) return null;
    const hasContacts = visibleContacts.length > 0;
    const contactPanelHeight = CONTACT_PANEL_HEIGHT;
    return (
      <div
        className="flex flex-col gap-3 text-xs"
        style={{ minHeight: contactPanelHeight, maxHeight: contactPanelHeight }}
      >
        <div className="contacts-list-view flex-1 min-h-0">
          {hasContacts ? (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div className="contact-list">
                {visibleContacts.map((contact) => {
                  const displayName = contactDisplayLabel(contact);
                  const displayNameTrimmed = truncateContactName(displayName);
                  const subtitle = contactSubtitle(contact) || "No details added";
                  const subtitleIsNip05 =
                    !!contact.nip05 &&
                    !!subtitle &&
                    normalizeNip05(contact.nip05) === normalizeNip05(subtitle);
                  const nip05Verified =
                    subtitleIsNip05 &&
                    isNip05VerifiedForRef.current?.(contact.id, contact.nip05, contact.npub);
                  const photo = contact.picture?.trim();
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      className="contact-row pressable"
                      onClick={() => handleSelectContact(contact)}
                    >
                      <div className={photo ? "contact-avatar contact-avatar--image" : "contact-avatar"}>
                        {photo ? (
                          <img src={photo} alt={displayName} className="contact-avatar__img" />
                        ) : (
                          contactInitials(displayName)
                        )}
                      </div>
                      <div className="contact-row__text">
                        <div className="contact-row__name">{displayNameTrimmed}</div>
                        <div
                          className={`contact-row__meta${subtitleIsNip05 ? " contact-row__meta--nip05" : ""}`}
                        >
                          <span className="contact-row__meta-text">{subtitle}</span>
                          {subtitleIsNip05 && nip05Verified && (
                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                          )}
                        </div>
                      </div>
                      <span className="contact-chevron">›</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="contact-empty text-secondary">
              {context === "ecash"
                ? "Add a contact with an npub from the Contacts tab."
                : "Save a lightning address from the Contacts tab."}
            </div>
          )}
        </div>
      </div>
    );
  };
  const nwcAlias = nwcInfo?.alias || nwcConnection?.walletName || "";
  const nwcBalanceSats = typeof nwcInfo?.balanceMsat === "number" ? Math.floor(nwcInfo.balanceMsat / 1000) : null;
  const nwcStatusLabel = useMemo(() => {
    if (!hasNwcConnection) return "Not connected";
    switch (nwcStatus) {
      case "connecting":
        return "Connecting…";
      case "error":
        return "Error";
      default:
        return "Connected";
    }
  }, [hasNwcConnection, nwcStatus]);
  const nwcFundStatusText = useMemo(() => {
    switch (nwcFundState) {
      case "creating":
        return "Creating invoice…";
      case "paying":
        return "Paying via NWC…";
      case "waiting":
        return "Waiting on mint…";
      case "claiming":
        return "Claiming ecash…";
      case "done":
        return "Completed";
      default:
        return "";
    }
  }, [nwcFundState]);
  const nwcWithdrawStatusText = useMemo(() => {
    switch (nwcWithdrawState) {
      case "requesting":
        return "Requesting invoice…";
      case "paying":
        return "Paying from wallet…";
      case "done":
        return "Completed";
      default:
        return "";
    }
  }, [nwcWithdrawState]);
  const lnurlWithdrawStatusText = useMemo(() => {
    switch (lnurlWithdrawState) {
      case "creating":
        return "Creating invoice…";
      case "waiting":
        return "Waiting for payment…";
      case "done":
        return "Completed";
      case "error":
        return "Error";
      default:
        return "";
    }
  }, [lnurlWithdrawState]);

  useEffect(() => {
    skipContactsEventRef.current = true;
    saveContactsToStorage(contacts);
    if (skipContactsTimerRef.current) {
      clearTimeout(skipContactsTimerRef.current);
    }
    skipContactsTimerRef.current = setTimeout(() => {
      skipContactsEventRef.current = false;
      skipContactsTimerRef.current = null;
    }, 0);
  }, [contacts]);

  useEffect(() => {
    if (!contactsOpen) {
      resetContactForm();
      setContactsContext(null);
      contactsContextRef.current = null;
    }
  }, [contactsOpen, resetContactForm]);

  const handlePaymentRequestScan = useCallback(async (encodedRequest: string): Promise<boolean> => {
    const trimmed = encodedRequest?.trim() || "";
    if (!trimmed) return false;
    if (!/^creq/i.test(trimmed)) {
      return false;
    }
    try {
      const request = decodePaymentRequest(trimmed);
      if (request.mints && request.mints.length) {
        if (!mintUrl) {
          throw new Error("Set an active mint before fulfilling payment requests");
        }
        const normalizedActive = normalizeMintUrl(mintUrl);
        const compatible = request.mints.some((m) => normalizeMintUrl(m) === normalizedActive);
        if (!compatible) {
          throw new Error("Payment request targets a different mint");
        }
      }
      if (request.unit && info?.unit && request.unit.toLowerCase() !== info.unit.toLowerCase()) {
        throw new Error(`Payment request unit ${request.unit} does not match active mint unit ${info.unit}`);
      }

      setPaymentRequestState({ encoded: trimmed, request });
      const numericAmount = Number(request.amount);
      setPaymentRequestManualAmount(
        Number.isFinite(numericAmount) && numericAmount > 0 ? String(Math.floor(numericAmount)) : "",
      );
      setPaymentRequestStatus("idle");
      setPaymentRequestMessage("");
      setReceiveMode(null);
      setSendMode("paymentRequest");
      setShowSendOptions(true);
      setScannerMessage("");
      return true;
    } catch (err: any) {
      console.warn("Payment request scan failed", err);
      setPaymentRequestState(null);
      setPaymentRequestStatus("error");
      setPaymentRequestMessage("");
      setPaymentRequestManualAmount("");
      setScannerMessage(err?.message || "Invalid payment request");
      return false;
    }
  }, [info?.unit, mintUrl]);

  const openContactsFor = useCallback(
    (context: "lightning" | "ecash") => {
      contactsContextRef.current = context;
      setContactsContext(context);
      setContactsOpen(true);
    },
    [setContactsContext, setContactsOpen],
  );

  const closeContactsSheet = useCallback(() => {
    setContactsOpen(false);
  }, []);

  const applyLightningContact = useCallback(
    (contact: Contact) => {
      if (!contact.address.trim()) {
        alert("This contact does not have a lightning address stored.");
        return false;
      }
      setSendMode("lightning");
      setShowSendOptions(true);
      setLnInput(contact.address);
      setLightningSendView("address");
      setLnAddrAmt("");
      setLnState("idle");
      setLnError("");
      setTimeout(() => {
        lnRef.current?.focus();
      }, 0);
      return true;
    },
    [
      lnRef,
      setLnAddrAmt,
      setLnError,
      setLnInput,
      setLnState,
      setLightningSendView,
      setSendMode,
      setShowSendOptions,
    ],
  );

  const resolveNip17Timestamp = useCallback(() => {
    if (nip17TimestampMode === "now") {
      return Math.floor(Date.now() / 1000);
    }
    return randomPastTimestampSeconds();
  }, [nip17TimestampMode]);

  const resolveNip17Relays = useCallback(
    async (recipientHex: string, fallbackRelays: string[]): Promise<string[]> => {
      const normalizedFallback = Array.from(
        new Set(
          (fallbackRelays || [])
            .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
            .filter(Boolean),
        ),
      );
      if (!normalizedFallback.length) return normalizedFallback;
      const normalizedRecipient = (recipientHex || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalizedRecipient)) return normalizedFallback;
      try {
        const session = await NostrSession.init(normalizedFallback);
        const events = await session.fetchEvents(
          [{ kinds: [10050], authors: [normalizedRecipient] }],
          normalizedFallback,
        );
        const latest = Array.isArray(events)
          ? events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]
          : null;
        const inboxRelays = Array.isArray(latest?.tags)
          ? latest.tags
              .filter(
                (tag) =>
                  Array.isArray(tag) &&
                  tag[0] === "relay" &&
                  typeof tag[1] === "string" &&
                  tag[1].trim(),
              )
              .map((tag) => tag[1]!.trim())
          : [];
        return Array.from(new Set([...inboxRelays, ...normalizedFallback]));
      } catch (err) {
        if (walletDebugEnabled) {
          console.warn("[wallet] Failed to load NIP-17 inbox relays", err);
        }
        return normalizedFallback;
      }
    },
    [walletDebugEnabled],
  );

  const publishNip17Giftwraps = useCallback(
    async (options: {
      content: string;
      senderHex: string;
      recipientHex: string;
      senderSecret: string;
      publish: (event: NostrEvent) => Promise<void>;
    }) => {
      const { content, senderHex, recipientHex, senderSecret, publish } = options;
      if (!nip44?.v2) {
        throw new Error("NIP-44 support is required to send this message");
      }
      const normalizedSender = senderHex.toLowerCase();
      const normalizedRecipient = recipientHex.toLowerCase();
      const rumorBase = {
        kind: 14,
        content,
        tags: [["p", normalizedRecipient]] as string[][],
        created_at: resolveNip17Timestamp(),
        pubkey: normalizedSender,
      };
      const rumor = {
        ...rumorBase,
        id: getEventHash(rumorBase),
      } satisfies Partial<NostrEvent>;
      const wrapRecipients = Array.from(new Set([normalizedRecipient, normalizedSender]));
      for (const wrapRecipient of wrapRecipients) {
        const dmKey = nip44.v2.utils.getConversationKey(hexToBytes(senderSecret), wrapRecipient);
        const sealedContent = await nip44.v2.encrypt(JSON.stringify(rumor), dmKey);
        const sealTemplate: EventTemplate = {
          kind: 13,
          content: sealedContent,
          tags: [],
          created_at: resolveNip17Timestamp(),
        };
        const sealEvent = finalizeEvent(sealTemplate, hexToBytes(senderSecret));
        const wrapKey = generatePrivateKey();
        const wrapConversationKey = nip44.v2.utils.getConversationKey(hexToBytes(wrapKey.hex), wrapRecipient);
        const wrapContent = await nip44.v2.encrypt(JSON.stringify(sealEvent), wrapConversationKey);
        const wrapTemplate: EventTemplate = {
          kind: 1059,
          content: wrapContent,
          tags: [["p", wrapRecipient]],
          created_at: resolveNip17Timestamp(),
        };
        const wrapEvent = finalizeEvent(wrapTemplate, wrapKey.bytes);
        await publish(wrapEvent);
      }
    },
    [resolveNip17Timestamp],
  );

  const applyEcashContact = useCallback(
    async (contact: Contact) => {
      const { identity, reason } = readNostrIdentity();
      if (!identity) {
        showToast(reason || "Add your Taskify Nostr key in Settings → Nostr.", 4000);
        return false;
      }
      const primaryCurrencyForAmount = walletConversionEnabled ? walletPrimaryCurrency : "sat";
      const unitLabelLocal = primaryCurrencyForAmount === "usd" ? "USD" : "sats";
      const trimmedSendAmt = sendAmt.trim();
      let sats = 0;
      if (trimmedSendAmt) {
        const numeric = Number(trimmedSendAmt);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          showToast(`Enter amount in ${unitLabelLocal}`, 4500);
          return false;
        }
        if (primaryCurrencyForAmount === "usd") {
          if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
            showToast("USD price unavailable. Try again in a moment.", 4500);
            return false;
          }
          sats = Math.floor((numeric / btcUsdPrice) * SATS_PER_BTC);
          if (sats <= 0) {
            showToast("Amount too small. Increase the USD value.", 4500);
            return false;
          }
        } else {
          sats = Math.floor(numeric);
        }
      }
      if (!sats) {
        showToast(`Enter amount in ${unitLabelLocal}`, 3500);
        return false;
      }

      let recipientPubkey: string | null = null;
      let relayHints: string[] | undefined;

      const contactNpub = normalizeNostrPubkey(contact.npub);
      if (contactNpub) {
        recipientPubkey = compressedToRawHex(contactNpub).toLowerCase();
        relayHints = contact.relays;
      } else {
        const storedRequest = contact.paymentRequest?.trim?.() ?? "";
        if (storedRequest) {
          try {
            const request = decodePaymentRequest(storedRequest);
            const transport = request.getTransport(PaymentRequestTransportType.NOSTR) as PaymentRequestTransport | undefined;
            if (transport?.target) {
              const decoded = nip19.decode(transport.target);
              if (decoded.type === "nprofile") {
                const data = decoded.data as { pubkey?: string; relays?: string[] };
                if (typeof data.pubkey === "string") {
                  recipientPubkey = data.pubkey;
                }
                if (Array.isArray(data.relays)) {
                  relayHints = data.relays.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim());
                }
              } else if (decoded.type === "npub") {
                recipientPubkey = typeof decoded.data === "string" ? decoded.data : null;
              }
            }
          } catch (err) {
            console.warn("Failed to decode contact payment request for recipient", err);
          }
        }
      }

      if (!recipientPubkey) {
        showToast("Contact is missing a valid npub.", 3500);
        return false;
      }

      const relays = Array.from(
        new Set(
          [
            ...(relayHints || []),
            ...defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")),
          ].filter(Boolean),
        ),
      );
      if (!relays.length) {
        showToast("Add at least one relay to send.", 3500);
        return false;
      }

      if (!nip44?.v2) {
        showToast("NIP-44 support is required to send eCash via NIP-17.", 4500);
        return false;
      }

      setCreatingSendToken(true);
      try {
        let lockOptions: CreateSendTokenOptions | undefined;
        if (lockSendToPubkey) {
          const lockPubkey = normalizeNostrPubkey(sendLockPubkeyInput) || normalizeNostrPubkey(recipientPubkey);
          if (!lockPubkey) {
            showToast("Enter a valid npub or 64-character hex key to lock the token.", 4000);
            return false;
          }
          lockOptions = { p2pk: { pubkey: lockPubkey } };
        }

        const { token, proofs: sentProofs, mintUrl: sentMintUrl, lockInfo } = await createSendToken(sats, lockOptions);
        setSendTokenStr(token);
        setLastSendTokenAmount(sats);
        setLastSendTokenMint(sentMintUrl);
        setLastSendTokenFingerprint(`${sats}|contact:${recipientPubkey}:${Date.now()}`);
        if (lockInfo?.type === "p2pk") {
          const labelSource = Array.isArray(lockInfo.options.pubkey)
            ? lockInfo.options.pubkey.join(", ")
            : lockInfo.options.pubkey;
          setLastSendTokenLockLabel(`Locked to ${labelSource}`);
        } else {
          setLastSendTokenLockLabel(null);
        }
        setEcashSendView("token");
        setHistory((h) => [
          buildHistoryEntry({
            id: `token-dm-${Date.now()}`,
            summary: `Sent ${sats} sats to ${contactDisplayLabel(contact)}`,
            detail: token,
            detailKind: "token",
            revertToken: token,
            type: "ecash",
            direction: "out",
            amountSat: sats,
            mintUrl: sentMintUrl,
            tokenState:
              sentProofs?.length
                ? {
                    mintUrl: sentMintUrl,
                    proofs: sentProofs.map((proof) => {
                      const stored: StoredProofForState = {
                        secret: proof.secret,
                        amount: proof.amount,
                        id: proof.id,
                        C: proof.C,
                      };
                      if (proof.witness) stored.witness = proof.witness;
                      const y = computeProofY(proof.secret);
                      if (y) stored.Y = y;
                      return stored;
                    }),
                    lastState: "UNSPENT",
                  }
                : undefined,
          }),
          ...h,
        ]);

        const senderNpub = formatNpub(identity.pubkey);
        const dmPlain = `nostr:${senderNpub} sent you ${sats} SAT from Taskify wallet!\n${token}`;
        const recipientHex = recipientPubkey.toLowerCase();
        const senderHex = identity.pubkey.toLowerCase();
        const publishRelays = await resolveNip17Relays(recipientHex, relays);
        if (!publishRelays.length) {
          throw new Error("No relays available for NIP-17 inbox");
        }
        const pool = ensureNostrPool();
        const publish = (event: NostrEvent) => safePublish(pool, publishRelays, event);
        await publishNip17Giftwraps({
          content: dmPlain,
          senderHex,
          recipientHex,
          senderSecret: identity.secret,
          publish,
        });
        showToast(`Sent ${sats} sat${sats === 1 ? "" : "s"} to ${contactDisplayLabel(contact)}`, 3500);
        return true;
      } catch (err: any) {
        const message = err?.message || String(err);
        console.warn("Failed to send eCash DM", err);
        showToast(message, 5000);
        return false;
      } finally {
        setCreatingSendToken(false);
      }
    },
    [
      btcUsdPrice,
      buildHistoryEntry,
      compressedToRawHex,
      contactDisplayLabel,
      createSendToken,
      defaultNostrRelays,
      ensureNostrPool,
      formatNpub,
      lockSendToPubkey,
      normalizeNostrPubkey,
      readNostrIdentity,
      publishNip17Giftwraps,
      resolveNip17Relays,
      safePublish,
      sendAmt,
      sendLockPubkeyInput,
      setHistory,
      showToast,
      walletConversionEnabled,
      walletPrimaryCurrency,
    ],
  );

  const handleSelectContact = useCallback(
    (contact: Contact) => {
      const context = contactsContextRef.current;
      if (context === "lightning") {
        applyLightningContact(contact);
      } else if (context === "ecash") {
        setEcashSendRecipient(contact);
        setEcashSendView("contact");
      }
      setContactsOpen(false);
      resetContactForm();
    },
    [applyLightningContact, resetContactForm],
  );

  const parseNip05Address = useCallback((input: string | null | undefined) => {
    const value = input?.trim();
    if (!value) return null;
    const atIndex = value.indexOf("@");
    if (atIndex <= 0 || atIndex === value.length - 1) return null;
    const name = value.slice(0, atIndex).trim().toLowerCase();
    const domain = value.slice(atIndex + 1).trim().toLowerCase();
    if (!name || !domain) return null;
    return { name, domain, normalized: `${name}@${domain}` };
  }, []);

  const normalizeNip05 = useCallback(
    (value: string | null | undefined) => parseNip05Address(value)?.normalized ?? null,
    [parseNip05Address],
  );

  const resolveNip05Record = useCallback(
    async (value: string) => {
      const parsed = parseNip05Address(value);
      if (!parsed) {
        throw new Error("Invalid NIP-05 address.");
      }
      const { name, domain, normalized } = parsed;
      const searchParam = encodeURIComponent(name);
      const isLocalhost =
        /^localhost(?::\d+)?$/.test(domain) || /^127\.0\.0\.1(?::\d+)?$/.test(domain) || domain === "[::1]";

      const buildUrls = (scheme: "https" | "http") => [
        `${scheme}://${domain}/.well-known/nostr.json?name=${searchParam}`,
        `${scheme}://${domain}/.well-known/nostr.json`,
      ];

      const urls = [...buildUrls("https"), ...(isLocalhost ? [] : buildUrls("http"))];

      const resolveFromRecord = (
        record: any,
      ): { pubkey: string; relays?: string[]; nip05: string } | null => {
        const names = (record?.names as Record<string, unknown>) || {};
        const matched = normalizePubkeyCandidate(findPubkey(names));
        if (!matched) {
          return null;
        }
        let relayHints: string[] | undefined;
        const relaysRecord =
          record?.relays && typeof record.relays === "object" ? (record.relays as Record<string, unknown>) : null;
        if (relaysRecord && matched in relaysRecord) {
          const relays = relaysRecord[matched];
          if (Array.isArray(relays)) {
            relayHints = relays
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter(Boolean);
          }
        }
        return { pubkey: matched, relays: relayHints, nip05: normalized };
      };

      const workerBaseUrl =
        typeof window !== "undefined" && typeof (window as any).__TASKIFY_WORKER_BASE_URL__ === "string"
          ? (window as any).__TASKIFY_WORKER_BASE_URL__
          : "";

      const normalizePubkeyCandidate = (candidate: string | null | undefined): string | null => {
        if (!candidate) return null;
        const trimmed = candidate.trim();
        if (!trimmed) return null;

        // Try to decode any bech32 values first (npub/nprofile) to hex
        if (/^n(profile|pub)1[ac-hj-np-z02-9]+$/i.test(trimmed)) {
          try {
            const decoded = nip19.decode(trimmed.toLowerCase());
            if (decoded.type === "npub" && decoded.data) {
              if (typeof decoded.data === "string" && /^[0-9a-f]{64}$/i.test(decoded.data)) return decoded.data.toLowerCase();
              if (decoded.data instanceof Uint8Array) return bytesToHex(decoded.data).toLowerCase();
            }
            if (decoded.type === "nprofile" && decoded.data) {
              const pubkey = (decoded.data as any)?.pubkey;
              if (typeof pubkey === "string" && /^[0-9a-f]{64}$/i.test(pubkey)) {
                return pubkey.toLowerCase();
              }
            }
          } catch {
            // fall through to hex handling
          }
        }

        const hexMatch = trimmed.replace(/^0x/i, "");
        if (/^[0-9a-f]{64}$/i.test(hexMatch)) return hexMatch.toLowerCase();
        if (/^(02|03)[0-9a-f]{64}$/i.test(hexMatch)) return hexMatch.slice(-64).toLowerCase();
        return null;
      };

      const findPubkey = (names: Record<string, unknown>): string | null => {
        if (!names) return null;
        const directMatch = names[name];
        const lowerMatch = names[name.toLowerCase()];
        const wildcard = names._;
        const candidate =
          (typeof directMatch === "string" && directMatch) ||
          (typeof lowerMatch === "string" && lowerMatch) ||
          (typeof wildcard === "string" && wildcard);
        return candidate ? String(candidate) : null;
      };

      let lastError = "NIP-05 lookup failed";

      const fetchViaWorker = async (): Promise<{ pubkey: string; relays?: string[]; nip05: string } | null> => {
        const base = workerBaseUrl?.trim().replace(/\/$/, "");
        if (!base) return null;
        const workerUrl = `${base}/api/nip05?address=${encodeURIComponent(normalized)}`;
        try {
          const res = await fetch(workerUrl, {
            headers: { Accept: "application/json" },
            redirect: "follow",
            mode: "cors",
          });
          if (!res.ok) {
            lastError = `NIP-05 lookup failed (${res.status})`;
            return null;
          }
          const payload = await res.json();
          const candidate = resolveFromRecord(payload?.record ?? payload);
          if (candidate) return candidate;
          lastError = "Name not found in NIP-05 record.";
          return null;
        } catch (error: any) {
          lastError = error?.message || String(error);
          return null;
        }
      };

      const workerResolution = await fetchViaWorker();
      if (workerResolution) {
        return workerResolution;
      }

      for (const url of urls) {
        try {
          const res = await fetch(url, {
            headers: { Accept: "application/json" },
            redirect: "follow",
            mode: "cors",
          });
          if (!res.ok) {
            lastError = `NIP-05 lookup failed (${res.status})`;
            continue;
          }
          const data = await res.json();
          const resolved = resolveFromRecord(data);
          if (resolved) {
            return resolved;
          }
          lastError = "Name not found in NIP-05 record.";
        } catch (error: any) {
          lastError = error?.message || String(error);
        }
      }
      throw new Error(lastError);
    },
    [parseNip05Address],
  );

  const handleLookupContact = useCallback(async (overrideInput?: string) => {
    if (contactLookupBusy) return;
    const input = (overrideInput ?? contactLookupInput).trim();
    if (!input) {
      setContactLookupError("Enter a npub, hex key, or NIP-05 address.");
      return;
    }
    setContactLookupBusy(true);
    setContactLookupError("");
    try {
      let targetPubkeyHex: string | null = null;
      let relayHints: string[] | undefined;
      let resolvedNip05: string | null = null;
      const normalizedInputNip05 = normalizeNip05(input);
      if (input.includes("@") && !input.toLowerCase().startsWith("npub")) {
        const resolution = await resolveNip05Record(input);
        const normalizedPubkey = normalizeNostrPubkey(resolution.pubkey) ?? resolution.pubkey;
        targetPubkeyHex = normalizedPubkey;
        relayHints = resolution.relays;
        resolvedNip05 = resolution.nip05;
      } else {
        const normalized = normalizeNostrPubkey(input);
        if (!normalized) {
          throw new Error("Invalid npub or hex key.");
        }
        targetPubkeyHex = compressedToRawHex(normalized);
      }
      if (!targetPubkeyHex) {
        throw new Error("Unable to resolve contact key.");
      }
      const authorHex = compressedToRawHex(targetPubkeyHex);
      const pool = ensureNostrPool();
      const relayList = Array.from(
        new Set([
          ...(Array.isArray(relayHints) ? relayHints : []),
          ...defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")),
        ].filter(Boolean)),
      );
      let profile: ContactProfile = {};
      if (relayList.length) {
        try {
          const profileEvent = await pool.get(relayList, { kinds: [0], authors: [authorHex] });
          if (profileEvent?.content) {
            profile = parseProfileContent(profileEvent.content);
          }
        } catch {
          // ignore profile fetch failure
        }
      }
      const newContact = upsertContact({
        kind: "nostr",
        npub: formatNpub(authorHex),
        name: profile.displayName || profile.username || input,
        displayName: profile.displayName,
        username: profile.username,
        address: profile.lud16 || "",
        nip05: profile.nip05 || resolvedNip05 || normalizedInputNip05 || "",
        picture: profile.picture,
        relays: relayHints,
        source: "profile",
        updatedAt: Date.now(),
      });
      if (!newContact) {
        throw new Error("Unable to save contact.");
      }
      setContactLookupInput("");
      contactsPublishQueuedRef.current = true;
      setActiveContactId(newContact.id);
      setContactView("detail");
    } catch (err: any) {
      setContactLookupError(err?.message || "Unable to add contact from profile.");
    } finally {
      setContactLookupBusy(false);
    }
  }, [
    compressedToRawHex,
    contactLookupBusy,
    contactLookupInput,
    defaultNostrRelays,
    ensureNostrPool,
    formatNpub,
    setActiveContactId,
    setContactView,
    normalizeNip05,
    normalizeNostrPubkey,
    resolveNip05Record,
    parseProfileContent,
    upsertContact,
  ]);

  const handleContactImportAction = useCallback(async () => {
    if (contactLookupBusy) return;
    const trimmedInput = contactLookupInput.trim();
    if (trimmedInput) {
      await handleLookupContact();
      return;
    }
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        throw new Error("Clipboard access is not available.");
      }
      const pasted = await navigator.clipboard.readText();
      const nextValue = pasted.trim();
      if (!nextValue) {
        setContactLookupError("Clipboard is empty.");
        return;
      }
      setContactLookupError("");
      setContactLookupInput(nextValue);
    } catch (err: any) {
      const message = err?.message || "Unable to read from clipboard.";
      setContactLookupError(message);
    }
  }, [contactLookupBusy, contactLookupInput, handleLookupContact]);

  const handleImportPublicFollow = useCallback(
    async (npub: string) => {
      const trimmed = (npub || "").trim();
      if (!trimmed) return;
      setPublicFollowPickerOpen(false);
      setContactLookupInput(trimmed);
      await handleLookupContact(trimmed);
    },
    [handleLookupContact],
  );

    const handleScannedContactPayload = useCallback(
      async (payload: ContactSharePayload | { npub?: string; relays?: string[]; name?: string; displayName?: string; lud16?: string; nip05?: string; kind?: string }) => {
        const relayHints = Array.isArray((payload as any).relays)
          ? ((payload as any).relays as string[]).filter((r) => typeof r === "string" && r.trim())
          : undefined;
      const rawNpub = typeof (payload as any).npub === "string" ? (payload as any).npub.trim() : "";
      const normalizedHex = rawNpub ? normalizeNostrPubkey(rawNpub) : null;
      const scannedNpub = normalizedHex
        ? formatNpub(normalizedHex)
        : rawNpub.startsWith("npub")
          ? rawNpub
          : "";
      const authorHex = normalizedHex ? compressedToRawHex(normalizedHex) : null;
      let mergedProfile: ContactProfile = {
        username: (payload as any).name,
        displayName: (payload as any).displayName,
        lud16: (payload as any).lud16,
        nip05: (payload as any).nip05,
        picture: (payload as any).picture,
      };
      if (authorHex) {
        const relays = Array.from(
          new Set(
            [
              ...(relayHints || []),
              ...defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")),
            ].filter(Boolean),
          ),
        );
        if (relays.length) {
          try {
            const pool = ensureNostrPool();
            const profileEvent = await pool.get(relays, { kinds: [0], authors: [authorHex] });
            if (profileEvent?.content) {
              mergedProfile = { ...mergedProfile, ...parseProfileContent(profileEvent.content) };
            }
          } catch {
            // ignore profile fetch failures
          }
        }
      }
      const candidateContact = normalizeContact({
        id: makeContactId(),
        kind: (payload as any).kind === "custom" && !authorHex ? "custom" : "nostr",
        npub: scannedNpub || (authorHex ? formatNpub(authorHex) : ""),
        name:
          mergedProfile.displayName ||
          mergedProfile.username ||
          (payload as any).name ||
          (payload as any).displayName ||
          rawNpub,
        displayName: mergedProfile.displayName || (payload as any).displayName,
        username: mergedProfile.username || (payload as any).name,
        address: mergedProfile.lud16 || (payload as any).lud16 || "",
        nip05: mergedProfile.nip05 || (payload as any).nip05,
        picture: mergedProfile.picture,
        relays: relayHints,
        source: "scan",
        updatedAt: Date.now(),
      });
      if (!candidateContact) {
        setScannerMessage("Contact code is missing usable details.");
        return;
      }
      setScannedContact(candidateContact);
      setShowScanner(false);
      setScannerMessage("");
    },
    [
      compressedToRawHex,
      defaultNostrRelays,
      ensureNostrPool,
      formatNpub,
      parseProfileContent,
      setScannerMessage,
      setShowScanner,
    ],
  );

  const handleDeleteContact = useCallback((id: string) => {
    setContacts((prev) => prev.filter((c) => c.id !== id));
    contactsPublishQueuedRef.current = true;
  }, []);

  const buildContactShareValue = useCallback(
    (contact: Contact): string | null => {
      const rawNpub = contact.npub?.trim() || "";
      const relays = contact.relays;
      const normalized = normalizeNostrPubkey(rawNpub);
      const npub = normalized ? formatNpub(normalized) : rawNpub.startsWith("npub") ? rawNpub : "";

      if (contact.kind === "custom") {
        const payload: ContactSharePayload = {
          v: 1,
          kind: "custom",
          npub: npub || undefined,
          relays,
          name: contact.name?.trim() || undefined,
          displayName: contact.displayName?.trim() || undefined,
          lud16: contact.address?.trim() || undefined,
          nip05: contact.nip05?.trim() || undefined,
        };
        return encodeContactPayload(payload);
      }

      if (npub) {
        return npub;
      }

      // Fallback: share whatever fields we have if npub is missing.
      return encodeContactPayload({
        v: 1,
        kind: contact.kind,
        npub: npub || undefined,
        relays,
        name: contact.name?.trim() || undefined,
        displayName: contact.displayName?.trim() || undefined,
        lud16: contact.address?.trim() || undefined,
        nip05: contact.nip05?.trim() || undefined,
      });
    },
    [encodeContactPayload, formatNpub],
  );

  const profileShareValue = useMemo(() => {
    if (profileSharePayload) return profileSharePayload;
    // Read identity directly — not gated by paymentRequestsEnabled so new accounts
    // without payment requests still get a QR on their contact card.
    const identity = readNostrIdentity().identity ?? nostrIdentityRef.current;
    return identity ? formatNpub(identity.pubkey) : null;
  }, [formatNpub, profileSharePayload, readNostrIdentity]);
  const nwcFundInProgress = nwcFundState === "creating" || nwcFundState === "paying" || nwcFundState === "waiting" || nwcFundState === "claiming";
  const nwcWithdrawInProgress = nwcWithdrawState === "requesting" || nwcWithdrawState === "paying";

  // Mint balances sheet
  const [showMintBalances, setShowMintBalances] = useState(false);
  // NWC sheet
  const [showNwcSheet, setShowNwcSheet] = useState(false);
  const [mintInputSheet, setMintInputSheet] = useState("");
  const [mintEntries, setMintEntries] = useState<{ url: string; balance: number; count: number }[]>([]);
  const [mintBackupEnabled, setMintBackupEnabled] = useState<boolean>(() => mintBackupEnabledProp);
  const [, setMintBackupState] = useState<"idle" | "syncing" | "success" | "error" | "restoring">(
    "idle",
  );
  const [, setMintBackupMessage] = useState("");
  const [mintBackupCache, setMintBackupCache] = useState<MintBackupPayload | null>(() => loadMintBackupCache());
  const [mintBackupCandidate, setMintBackupCandidate] = useState<string[]>(() => getMintList());

  useEffect(() => {
    setMintBackupEnabled(mintBackupEnabledProp);
  }, [mintBackupEnabledProp]);

  useEffect(() => {
    try {
      kvStorage.setItem(LS_MINT_BACKUP_ENABLED, mintBackupEnabled ? "1" : "0");
    } catch {
      // ignore persistence errors
    }
  }, [mintBackupEnabled]);

  useEffect(() => {
    if (!mintBackupEnabled) {
      setMintBackupState("idle");
      setMintBackupMessage("");
    }
  }, [mintBackupEnabled]);

  const persistMintBackupCache = useCallback((payload: MintBackupPayload) => {
    setMintBackupCache(payload);
    persistMintBackupCacheToStorage(payload);
  }, []);

  const refreshMintEntries = useCallback(() => {
    try {
      const store = loadStore();
      const storeEntries = new Map<string, { url: string; proofs: Proof[] }>();
      Object.entries(store).forEach(([url, proofs]) => {
        const normalized = normalizeMintUrl(url);
        if (!normalized) return;
        storeEntries.set(normalized, {
          url,
          proofs: Array.isArray(proofs) ? (proofs as Proof[]) : [],
        });
      });

      let trackedMints = getMintList();
      const trackedSet = new Set<string>();
      for (const url of trackedMints) {
        const normalized = normalizeMintUrl(url);
        if (!normalized) continue;
        trackedSet.add(normalized);
      }

      if (mintUrl) {
        const normalizedActive = normalizeMintUrl(mintUrl);
        if (normalizedActive && !trackedSet.has(normalizedActive)) {
          trackedMints = addMintToList(mintUrl);
          trackedSet.add(normalizedActive);
        }
      }

      storeEntries.forEach((payload, normalized) => {
        const hasBalance = payload.proofs.some((proof) => normalizeProofAmount(proof?.amount) > 0);
        if (hasBalance && !trackedSet.has(normalized)) {
          trackedMints = addMintToList(payload.url);
          trackedSet.add(normalized);
        }
      });

      const entries: { url: string; balance: number; count: number }[] = [];
      const seen = new Set<string>();
      for (const url of trackedMints) {
        const normalized = normalizeMintUrl(url);
        if (!normalized || seen.has(normalized)) continue;
        const payload = storeEntries.get(normalized);
        const proofs = payload?.proofs ?? [];
        const balance = sumProofAmounts(proofs);
        entries.push({
          url,
          balance,
          count: proofs.length,
        });
        seen.add(normalized);
      }

      entries.sort((a, b) => b.balance - a.balance || a.url.localeCompare(b.url));
      setMintBackupCandidate(trackedMints);
      setMintEntries(entries);
    } catch (error) {
      console.warn("Failed to refresh mint entries", error);
      setMintEntries([]);
    }
  }, [mintUrl]);

  const syncMintBackup = useCallback(
    async (overrideMints?: string[]) => {
      if (!mintBackupEnabled) return;
      setMintBackupState("syncing");
      setMintBackupMessage("");
      try {
        const relays = defaultNostrRelays
          .map((url) => (typeof url === "string" ? url.trim() : ""))
          .filter((url): url is string => !!url);
        if (!relays.length) {
          throw new Error("No Nostr relays configured.");
        }
        const mnemonic = getWalletSeedMnemonic();
        const keys = deriveMintBackupKeys(mnemonic);
        const mintList = (overrideMints ?? getMintList()).map((mint) => mint);
        if (mintBackupCache && mintListsEqual(mintBackupCache.mints, mintList)) {
          setMintBackupState("success");
          setMintBackupMessage("Mint backup already up to date.");
          return;
        }
        const template = await createMintBackupTemplate(mintList, keys, {
          clientTag: MINT_BACKUP_CLIENT_TAG,
        });
        const created_at = Math.max(template.created_at || 0, Math.floor(Date.now() / 1000));
        const signedEvent = finalizeEvent(
          { ...template, created_at },
          hexToBytes(keys.privateKeyHex),
        );
        const pool = ensureNostrPool();
        await safePublish(pool, relays, signedEvent as any);
        const payload: MintBackupPayload = {
          mints: mintList,
          timestamp: signedEvent.created_at || created_at,
        };
        persistMintBackupCache(payload);
        setMintBackupState("success");
        setMintBackupMessage(
          `Backed up ${mintList.length} mint${mintList.length === 1 ? "" : "s"}.`,
        );
      } catch (error: any) {
        setMintBackupState("error");
        setMintBackupMessage(error?.message || "Unable to back up mints.");
      }
    },
    [
      defaultNostrRelays,
      ensureNostrPool,
      mintBackupCache,
      mintBackupEnabled,
      persistMintBackupCache,
      safePublish,
    ],
  );

  useEffect(() => {
    if (!mintBackupEnabled) return;
    void syncMintBackup(mintBackupCandidate);
  }, [mintBackupCandidate, mintBackupEnabled, syncMintBackup]);

  const resetNwcFundState = useCallback(() => {
    setNwcFundState("idle");
    setNwcFundMessage("");
    setNwcFundInvoice("");
  }, []);

  const resetNwcWithdrawState = useCallback(() => {
    setNwcWithdrawState("idle");
    setNwcWithdrawMessage("");
    setNwcWithdrawInvoice("");
  }, []);

  const closeNwcSheets = useCallback(() => {
    setShowNwcManager(false);
    setShowNwcSheet(false);
    resetNwcFundState();
    resetNwcWithdrawState();
    setMintSwapState("idle");
    setMintSwapMessage("");
    setSwapAmount("");
    setSwapFromValue("");
    setSwapToValue("");
    setNwcFeedback("");
    setNwcBusy(false);
  }, [resetNwcFundState, resetNwcWithdrawState]);

  const resetLnurlWithdrawView = useCallback(() => {
    setLnurlWithdrawState("idle");
    setLnurlWithdrawMessage("");
    setLnurlWithdrawInvoice("");
    setLnurlWithdrawAmt("");
    setLnurlWithdrawInfo(null);
  }, []);

  const openReceiveEcashSheet = useCallback(() => {
    setReceiveMode("ecash");
    setReceiveLockVisible(false);
    setEcashReceiveView("overview");
    setEcashRequestAmt("");
    setEcashRequestMode("multi");
    setRecvMsg("");
    setLastCreatedEcashRequest(null);
  }, []);

  const closeReceiveEcashSheet = useCallback(() => {
    setReceiveMode(null);
    setReceiveLockVisible(false);
    setEcashReceiveView("overview");
    setEcashRequestAmt("");
    setEcashRequestMode("multi");
    setRecvMsg("");
    setLastCreatedEcashRequest(null);
  }, []);

  const openReceiveLightningSheet = useCallback(() => {
    setReceiveMode("lightning");
    setMintAmt("");
    setMintQuote(null);
    setMintStatus(activeMintInvoice ? "waiting" : "idle");
    setMintError("");
    if (!npubCashClaimingRef.current) {
      setNpubCashClaimStatus("idle");
      setNpubCashClaimMessage("");
    }
    const defaultView = activeMintInvoice
      ? "invoice"
      : npubCashLightningAddressEnabled
        ? "address"
        : "amount";
    setLightningReceiveView(defaultView);
    refreshMintEntries();
  }, [activeMintInvoice, npubCashLightningAddressEnabled, refreshMintEntries]);

  const resetLightningInvoiceState = useCallback(() => {
    setMintQuote(null);
    setActiveMintInvoice(null);
    setMintStatus("idle");
    setMintError("");
  }, []);

  const closeReceiveLightningSheet = useCallback(() => {
    setReceiveMode(null);
    setMintAmt("");
    resetLightningInvoiceState();
    setLightningReceiveView("address");
    setNpubCashClaimStatus("idle");
    setNpubCashClaimMessage("");
  }, [resetLightningInvoiceState]);

  const closeReceiveLnurlWithdrawSheet = useCallback(() => {
    resetLnurlWithdrawView();
    setReceiveMode(null);
  }, [resetLnurlWithdrawView]);

  const resetLightningSendForm = useCallback(() => {
    setLnInput("");
    setLnAddrAmt("");
    setLnState("idle");
    setLnError("");
    setLnurlPayData(null);
    setContactsOpen(false);
    resetContactForm();
    setLightningSendView("input");
  }, [resetContactForm]);

  useEffect(() => {
    const previous = previousReceiveModeRef.current;
    if (receiveMode === "lightning" && previous !== "lightning") {
      if (!activeMintInvoice) {
        setLightningReceiveView(npubCashLightningAddressEnabled ? "address" : "amount");
      }
      refreshMintEntries();
    }
    if (receiveMode !== "lightning" && previous === "lightning") {
      setLightningReceiveView("address");
    }
    previousReceiveModeRef.current = receiveMode;
  }, [
    receiveMode,
    npubCashLightningAddressEnabled,
    activeMintInvoice,
    refreshMintEntries,
  ]);

  useEffect(() => {
    if (!open) return;
    if (
      sendMode === "ecash" ||
      sendMode === "lightning" ||
      sendMode === "paymentRequest" ||
      receiveMode === "ecash" ||
      receiveMode === "lightning"
    ) {
      refreshMintEntries();
    }
  }, [open, receiveMode, refreshMintEntries, sendMode]);

  useEffect(() => {
    if (!open) return;
    if (sendMode === "paymentRequest") {
      refreshMintEntries();
    }
  }, [open, refreshMintEntries, sendMode]);

  useEffect(() => {
    if (receiveMode !== "lightning") return;
    if (lightningReceiveView === "invoice" && !activeMintInvoice) {
      setLightningReceiveView(npubCashLightningAddressEnabled ? "address" : "amount");
    }
  }, [
    receiveMode,
    lightningReceiveView,
    activeMintInvoice,
    npubCashLightningAddressEnabled,
  ]);

  const ensureMintInfo = useCallback(
    async (url: string) => {
      const normalized = normalizeMintUrl(url);
      if (!normalized) return;
      if (mintInfoByUrl[normalized] || pendingMintInfoRef.current.has(normalized)) return;
      pendingMintInfoRef.current.add(normalized);
      const fallbackName = formatMintDisplayName(normalized);
      const targets = ["info", "v1/info", "api/v1/info"].map((segment) => `${normalized}/${segment}`);
      let resolvedName: string | undefined;
      let resolvedUnit: string | undefined;
      try {
        for (const target of targets) {
          try {
            const response = await fetchWithTimeout(target, { headers: { accept: "application/json" } }, 10000);
            if (!response.ok) {
              continue;
            }
            const data = await response
              .json()
              .catch(() => null);
            if (!data || typeof data !== "object") {
              continue;
            }
            const candidateName = typeof (data as any)?.name === "string" ? (data as any).name.trim() : "";
            const candidateUnit = typeof (data as any)?.unit === "string" ? (data as any).unit.trim() : undefined;
            if (candidateName && !resolvedName) {
              resolvedName = candidateName;
            }
            if (candidateUnit && !resolvedUnit) {
              resolvedUnit = candidateUnit;
            }
            if (resolvedName && resolvedUnit) {
              break;
            }
          } catch {
            continue;
          }
        }
      } finally {
        setMintInfoByUrl((prev) => ({
          ...prev,
          [normalized]: {
            name: resolvedName || prev[normalized]?.name || fallbackName,
            unit: resolvedUnit ?? prev[normalized]?.unit,
          },
        }));
        pendingMintInfoRef.current.delete(normalized);
      }
    },
    [mintInfoByUrl],
  );

  useEffect(() => {
    if (!mintUrl) return;
    const normalized = normalizeMintUrl(mintUrl);
    if (!normalized) return;
    const derivedName = info?.name?.trim();
    const derivedUnit = info?.unit;
    setMintInfoByUrl((prev) => {
      const existing = prev[normalized];
      const nextName = derivedName || existing?.name || formatMintDisplayName(normalized);
      const nextUnit = derivedUnit ?? existing?.unit;
      if (existing && existing.name === nextName && existing.unit === nextUnit) {
        return prev;
      }
      return {
        ...prev,
        [normalized]: {
          name: nextName,
          unit: nextUnit,
        },
      };
    });
  }, [mintUrl, info?.name, info?.unit]);

  const mintEntriesByNormalized = useMemo(() => {
    const map = new Map<string, { url: string; balance: number; count: number }>();
    mintEntries.forEach((entry) => {
      const normalized = normalizeMintUrl(entry.url);
      if (!normalized) return;
      map.set(normalized, entry);
    });
    return map;
  }, [mintEntries]);

  const mintSelectionOptions = useMemo(() => {
    const options: { url: string; normalized: string; balance: number; isActive: boolean }[] = [];
    const seen = new Set<string>();
    const normalizedActive = mintUrl ? normalizeMintUrl(mintUrl) : null;

    if (normalizedActive) {
      const activeEntry = mintEntriesByNormalized.get(normalizedActive);
      options.push({
        url: activeEntry?.url ?? mintUrl!,
        normalized: normalizedActive,
        balance: activeEntry?.balance ?? 0,
        isActive: true,
      });
      seen.add(normalizedActive);
    }

    for (const entry of mintEntries) {
      const normalized = normalizeMintUrl(entry.url);
      if (!normalized || seen.has(normalized)) continue;
      options.push({ url: entry.url, normalized, balance: entry.balance, isActive: false });
      seen.add(normalized);
    }

    return options;
  }, [mintEntries, mintEntriesByNormalized, mintUrl]);

  const satFormatter = useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }), []);

  const swapOptionList = useMemo(() => {
    const options = mintSelectionOptions.map((option) => ({ value: option.normalized, type: "mint" as const }));
    if (hasNwcConnection) {
      options.push({ value: "nwc", type: "nwc" as const });
    }
    return options;
  }, [hasNwcConnection, mintSelectionOptions]);

  const getSwapOptionMeta = useCallback(
    (value: string) => {
      if (!value) {
        return { label: "No selection", balanceLabel: "Choose a mint or wallet" };
      }
      if (value === "nwc") {
        if (!hasNwcConnection) {
          return { label: "NWC wallet", balanceLabel: "Not connected" };
        }
        const alias = nwcAlias?.trim();
        const label = alias || "NWC wallet";
        const balanceLabel =
          nwcBalanceSats != null
            ? `${satFormatter.format(nwcBalanceSats)} sat available`
            : "Balance unknown";
        return { label, balanceLabel };
      }
      const entry = mintEntriesByNormalized.get(value);
      const info = mintInfoByUrl[value];
      const fallbackName = entry ? formatMintDisplayName(entry.url) : formatMintDisplayName(value);
      const label = info?.name || fallbackName;
      const balance = entry?.balance ?? 0;
      return { label, balanceLabel: `${satFormatter.format(balance)} sat available` };
    },
    [hasNwcConnection, mintEntriesByNormalized, mintInfoByUrl, nwcAlias, nwcBalanceSats, satFormatter],
  );

  useEffect(() => {
    if (!showNwcSheet) return;
    refreshMintEntries();
  }, [refreshMintEntries, showNwcSheet]);

  useEffect(() => {
    if (!showNwcSheet) return;
    setSwapFromValue((current) => (current ? "" : current));
    setSwapToValue((current) => (current ? "" : current));
  }, [showNwcSheet]);

  useEffect(() => {
    if (!showNwcSheet) return;
    const mintedValues = mintSelectionOptions.map((option) => option.normalized);
    const availableOptions = hasNwcConnection ? ["nwc", ...mintedValues] : [...mintedValues];
    let fromCandidate = swapFromValue;
    if (fromCandidate === "nwc" && !hasNwcConnection) {
      fromCandidate = "";
    } else if (fromCandidate && !availableOptions.includes(fromCandidate)) {
      fromCandidate = "";
    }
    let toCandidate = swapToValue;
    if (toCandidate === "nwc" && !hasNwcConnection) {
      toCandidate = "";
    } else if (toCandidate && !availableOptions.includes(toCandidate)) {
      toCandidate = "";
    }
    if (fromCandidate && fromCandidate === toCandidate) {
      toCandidate = "";
    }
    if (fromCandidate !== swapFromValue) {
      setSwapFromValue(fromCandidate);
    }
    if (toCandidate !== swapToValue) {
      setSwapToValue(toCandidate);
    }
  }, [
    hasNwcConnection,
    mintSelectionOptions,
    showNwcSheet,
    swapFromValue,
    swapToValue,
  ]);

  const handleRemoveMintEntry = useCallback(
    (url: string) => {
      removeMintFromList(url);
      refreshMintEntries();
    },
    [refreshMintEntries],
  );

  const resetEcashSendForm = useCallback(() => {
    setSendAmt("");
    setSendTokenStr("");
    setEcashSendRecipient(null);
    setEcashSendView("amount");
    setLastSendTokenAmount(null);
    setLastSendTokenMint(null);
    setLastSendTokenFingerprint(null);
    setLastSendTokenLockLabel(null);
    resetSendLockSettings();
    setCreatingSendToken(false);
  }, [resetSendLockSettings]);

  const openLightningSendSheet = useCallback(() => {
    resetEcashSendForm();
    resetLightningSendForm();
    setSendMode("lightning");
    setShowSendOptions(false);
  }, [resetEcashSendForm, resetLightningSendForm]);

  const closeLightningSendSheet = useCallback(() => {
    setSendMode(null);
    setShowSendOptions(false);
    resetLightningSendForm();
  }, [resetLightningSendForm]);

  const openEcashSendSheet = useCallback(() => {
    resetEcashSendForm();
    resetLightningSendForm();
    setSendMode("ecash");
    setShowSendOptions(false);
  }, [resetEcashSendForm, resetLightningSendForm]);

  const openEcashSendToContact = useCallback(
    (contact: Contact) => {
      resetEcashSendForm();
      resetLightningSendForm();
      setEcashSendRecipient(contact);
      setEcashSendView("contact");
      setSendMode("ecash");
      setShowSendOptions(false);
    },
    [resetEcashSendForm, resetLightningSendForm],
  );

  const closeEcashSendSheet = useCallback(() => {
    setSendMode(null);
    setShowSendOptions(false);
    resetEcashSendForm();
  }, [resetEcashSendForm]);

  const closePaymentRequestSheet = useCallback(() => {
    setSendMode(null);
    setShowSendOptions(false);
    setPaymentRequestState(null);
    setPaymentRequestStatus("idle");
    setPaymentRequestMessage("");
    setPaymentRequestManualAmount("");
  }, []);

  const handleClaimNpubCash = useCallback(
    async (options?: { auto?: boolean }) => {
      if (!npubCashLightningAddressEnabled) return;
      if (npubCashClaimingRef.current) return;
      const auto = options?.auto === true;
      const storedSk = kvStorage.getItem(LS_NOSTR_SK) || "";
      if (!storedSk) {
        setNpubCashIdentity(null);
        const message = "Add your Taskify Nostr key in Settings → Nostr to use npub.cash.";
        setNpubCashIdentityError(message);
        if (!auto) {
          setNpubCashClaimStatus("error");
          setNpubCashClaimMessage(message);
        }
        return;
      }

      let identity: ReturnType<typeof deriveNpubCashIdentity> | null = null;
      try {
        identity = deriveNpubCashIdentity(storedSk);
        setNpubCashIdentity({ npub: identity.npub, address: identity.address });
        setNpubCashIdentityError(null);
      } catch (err: any) {
        const message = err?.message || "Unable to derive npub.cash address.";
        setNpubCashIdentity(null);
        setNpubCashIdentityError(message);
        if (!auto) {
          setNpubCashClaimStatus("error");
          setNpubCashClaimMessage(message);
        }
        return;
      }

      if (!mintUrl) {
        if (!auto) {
          setNpubCashClaimStatus("error");
          setNpubCashClaimMessage("Select an active mint before claiming from npub.cash.");
        }
        return;
      }

      if (auto) {
        backgroundNpubCashClaimRef.current = true;
      }
      const controller = new AbortController();
      npubCashClaimAbortRef.current = controller;
      npubCashClaimingRef.current = true;
      setNpubCashClaimStatus("checking");
      setNpubCashClaimMessage("Checking npub.cash for pending tokens…");

      try {
        const result = await claimPendingEcashFromNpubCash(storedSk, { signal: controller.signal });
        const tokens = Array.isArray(result.tokens) ? result.tokens : [];
        const reportedBalance = Number.isFinite(result.balance)
          ? Math.max(0, Math.floor(result.balance))
          : 0;
        if (reportedBalance > 0) {
          setNpubCashClaimMessage(
            `npub.cash reports ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"} ready to claim…`,
          );
        }
        if (!tokens.length) {
          if (reportedBalance > 0) {
            setNpubCashClaimStatus("error");
            setNpubCashClaimMessage(
              `npub.cash reported ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"}, but no token was returned. Please try again later.`,
            );
          } else {
            setNpubCashClaimStatus("idle");
            setNpubCashClaimMessage("No pending eCash found.");
          }
          return;
        }

        let successCount = 0;
        let totalRedeemedSat = 0;
        let savedForLaterCount = 0;
        let totalSavedSat = 0;
        let lastError: string | null = null;
        const successTokens: string[] = [];
        const crossMintMints = new Set<string>();
        const tokenHistoryEntries: HistoryEntryInput[] = [];
        let tokenEntryCounter = 0;
        for (const token of tokens) {
          try {
            const normalizedToken = typeof token === "string" ? token.trim() : "";
            if (!normalizedToken) {
              continue;
            }
            let decodedAmount = 0;
            try {
              const decoded = getDecodedToken(normalizedToken);
              const tokenEntries: any[] = Array.isArray(decoded?.token)
                ? decoded.token
                : decoded?.proofs
                  ? [decoded]
                  : [];
              decodedAmount = tokenEntries.reduce((outerSum, entry) => {
                const proofs = Array.isArray(entry?.proofs) ? entry.proofs : [];
                return outerSum + sumProofAmounts(proofs);
              }, 0);
            } catch {
              decodedAmount = 0;
            }

            decodedAmount = Math.max(0, Math.floor(decodedAmount));

            const res = await receiveToken(normalizedToken);
            if (res.savedForLater) {
              savedForLaterCount += 1;
              totalSavedSat += decodedAmount;
            } else {
              successCount += 1;
              totalRedeemedSat += decodedAmount;
            }
            successTokens.push(normalizedToken);
            if (res.crossMint && res.usedMintUrl) {
              crossMintMints.add(res.usedMintUrl);
            }
            const resolvedMintUrl = res.usedMintUrl ?? mintUrl ?? undefined;
            const amountSummary =
              decodedAmount > 0 ? `${decodedAmount} sat${decodedAmount === 1 ? "" : "s"}` : "token";
            const capitalizedAmountSummary = decodedAmount > 0 ? amountSummary : "Token";
            const crossMintNote = res.crossMint && res.usedMintUrl ? ` at ${res.usedMintUrl}` : "";
            const tokenSummary = res.savedForLater
              ? `Saved ${capitalizedAmountSummary} via npub.cash${crossMintNote}`
              : `Received ${capitalizedAmountSummary} via npub.cash${crossMintNote}`;
            const tokenState = !res.savedForLater
              ? deriveSpentHistoryTokenStateFromTokenRef.current(normalizedToken, Date.now())
              : undefined;
            const historyEntry: HistoryEntryInput = {
              id: `npubcash-token-${Date.now()}-${tokenEntryCounter++}`,
              summary: tokenSummary,
              detail: normalizedToken,
              detailKind: "token",
              type: "ecash",
              direction: "in",
              amountSat: decodedAmount || undefined,
              mintUrl: resolvedMintUrl,
            };
            if (tokenState) {
              historyEntry.tokenState = tokenState;
            }
            if (res.savedForLater) {
              if (res.pendingTokenId) {
                historyEntry.pendingTokenId = res.pendingTokenId;
                historyEntry.pendingStatus = "pending";
              }
              historyEntry.pendingTokenAmount = decodedAmount || undefined;
              historyEntry.pendingTokenMint = resolvedMintUrl;
            }
            tokenHistoryEntries.push(historyEntry);
          } catch (err: any) {
            lastError = err?.message || String(err);
          }
        }

        if (lastError) {
          setNpubCashClaimStatus("error");
          const prefix = successCount ? `Claimed ${successCount} token${successCount === 1 ? "" : "s"}, but ` : "";
          setNpubCashClaimMessage(`${prefix}${lastError}`);
        } else {
          setNpubCashClaimStatus("success");
          const mintedNote = crossMintMints.size
            ? `Stored at ${Array.from(crossMintMints).join(", ")}`
            : "";
          const reportNote =
            reportedBalance > 0 ? `npub.cash reported ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"}` : "";
          const messageParts: string[] = [];
          if (successCount > 0) {
            const satText = totalRedeemedSat
              ? ` for ${totalRedeemedSat} sat${totalRedeemedSat === 1 ? "" : "s"}`
              : "";
            messageParts.push(`Redeemed ${successCount} token${successCount === 1 ? "" : "s"}${satText}`);
          }
          if (savedForLaterCount > 0) {
            const satText = totalSavedSat
              ? ` totaling ${totalSavedSat} sat${totalSavedSat === 1 ? "" : "s"}`
              : "";
            messageParts.push(
              `${savedForLaterCount} token${savedForLaterCount === 1 ? "" : "s"} saved for later redemption${satText}`,
            );
          }
          const suffixParts = [mintedNote, reportNote].filter(Boolean);
          const details = suffixParts.length ? `Details: ${suffixParts.join("; ")}` : "";
          const summaryMessage = messageParts.length ? messageParts.join(". ") : "No tokens claimed.";
          setNpubCashClaimMessage([summaryMessage, details].filter(Boolean).join(" \u2022 "));
          let toastMessage: string;
          if (successCount > 0) {
            toastMessage = totalRedeemedSat
              ? `received ${totalRedeemedSat} sat${totalRedeemedSat === 1 ? "" : "s"}`
              : `received ${successCount} token${successCount === 1 ? "" : "s"}`;
          } else if (savedForLaterCount > 0) {
            toastMessage = `saved ${savedForLaterCount} token${savedForLaterCount === 1 ? "" : "s"} for later`;
          } else {
            toastMessage = "received token";
          }
          showToast(toastMessage, 3000);
          const detailParts = [`Address ${identity.address}`];
          if (identity.npub) detailParts.push(`npub ${identity.npub}`);
          if (totalRedeemedSat) {
            detailParts.push(`${totalRedeemedSat} sat${totalRedeemedSat === 1 ? "" : "s"}`);
          }
          if (savedForLaterCount) {
            detailParts.push(`Saved ${savedForLaterCount} token${savedForLaterCount === 1 ? "" : "s"} for later`);
          }
          if (crossMintMints.size) {
            detailParts.push(`Stored at ${Array.from(crossMintMints).join(", ")}`);
          }
          if (reportedBalance > 0) {
            detailParts.push(`npub.cash reported ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"}`);
          }
          const summary = totalRedeemedSat
            ? `Claimed ${totalRedeemedSat} sat${totalRedeemedSat === 1 ? "" : "s"} via npub.cash`
            : savedForLaterCount
              ? `Saved ${savedForLaterCount} token${savedForLaterCount === 1 ? "" : "s"} via npub.cash`
              : `Claimed token via npub.cash`;
          setHistory((prev) => {
            const crossMintSummaryUrl =
              crossMintMints.size === 1
                ? Array.from(crossMintMints)[0]
                : crossMintMints.size === 0
                  ? mintUrl || undefined
                  : undefined;
            const summaryEntry: HistoryEntryInput = {
              id: `npubcash-${Date.now()}`,
              summary,
              detail: detailParts.join(" · "),
              detailKind: "note",
            };
            if (crossMintSummaryUrl) {
              summaryEntry.mintUrl = crossMintSummaryUrl;
            }
            const additions: HistoryItem[] = [];
            if (tokenHistoryEntries.length) {
              additions.push(...tokenHistoryEntries.map((entry) => buildHistoryEntry(entry)));
            } else {
              additions.push(buildHistoryEntry(summaryEntry));
            }
            return [...additions, ...prev];
          });
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        if (err instanceof NpubCashError && err.status === 504) {
          const message = err.message || "npub.cash request timed out. Please try again later.";
          setNpubCashClaimStatus(auto ? "idle" : "error");
          setNpubCashClaimMessage(message);
          return;
        }
        const message = err?.message || "Unable to claim eCash from npub.cash.";
        setNpubCashClaimStatus("error");
        setNpubCashClaimMessage(message);
      } finally {
        npubCashClaimingRef.current = false;
        if (npubCashClaimAbortRef.current === controller) {
          npubCashClaimAbortRef.current = null;
        }
        if (auto) {
          backgroundNpubCashClaimRef.current = false;
        }
      }
    },
    [
      buildHistoryEntry,
      mintUrl,
      npubCashLightningAddressEnabled,
      receiveToken,
      setHistory,
      showToast,
    ],
  );

  useEffect(() => {
    idbKeyValue.setItem(TASKIFY_STORE_WALLET, "cashuHistory", JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const syncPending = () => {
      if (cancelled) return;
      const now = Date.now();
      let entries: PendingTokenEntry[] = [];
      try {
        entries = listPendingTokens();
      } catch {
        entries = [];
      }
      const pendingIds = new Set(entries.map((entry) => entry.id));
      setHistory((prev) => {
        let changed = false;
        const next = prev.map((item) => {
          if (item.pendingTokenId && !pendingIds.has(item.pendingTokenId) && item.pendingStatus !== "redeemed") {
            changed = true;
            const amount = item.pendingTokenAmount;
            const amountNote = amount ? `${amount} sat${amount === 1 ? "" : "s"}` : "Token";
            const tokenState = item.tokenState
              ? markHistoryTokenStateSpentRef.current(item.tokenState, now)
              : typeof item.detail === "string"
                ? deriveSpentHistoryTokenStateFromTokenRef.current(item.detail, now)
                : undefined;
            return {
              ...item,
              pendingTokenId: undefined,
              pendingStatus: "redeemed",
              ...(tokenState ? { tokenState } : {}),
              summary: item.summary.includes("saved for later redemption")
                ? `${amountNote} redeemed automatically`
                : item.summary,
            };
          }
          return item;
        });
        return changed ? next : prev;
      });
    };
    syncPending();
    const interval = window.setInterval(syncPending, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open, setHistory]);

  useEffect(() => {
    if (!open || !sentTokenStateChecksEnabled) {
      initialTokenCheckIdsRef.current.clear();
      return;
    }
    if (typeof window === "undefined") return;
    if (!pendingTokenStateItems.length) {
      initialTokenCheckIdsRef.current.clear();
      return;
    }
    const pendingIds = new Set(pendingTokenStateItems.map((item) => item.id));
    for (const checkedId of Array.from(initialTokenCheckIdsRef.current)) {
      if (!pendingIds.has(checkedId)) {
        initialTokenCheckIdsRef.current.delete(checkedId);
      }
    }
    const dueItems = pendingTokenStateItems.filter(
      (entry) => !initialTokenCheckIdsRef.current.has(entry.id),
    );
    if (!dueItems.length) return;
    let cancelled = false;
    const runChecks = async () => {
      if (cancelled || tokenStateCheckRunningRef.current) return;
      tokenStateCheckRunningRef.current = true;
      try {
        for (const entry of dueItems) {
          if (cancelled) break;
          await performTokenStateCheck(entry, { silent: true });
          initialTokenCheckIdsRef.current.add(entry.id);
        }
      } finally {
        tokenStateCheckRunningRef.current = false;
      }
    };
    void runChecks();
    return () => {
      cancelled = true;
    };
  }, [open, sentTokenStateChecksEnabled, pendingTokenStateItems, performTokenStateCheck]);

  useEffect(() => {
    if (!open || !sentTokenStateChecksEnabled || backgroundSuspended) return;
    if (!pendingTokenStateItems.length) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let initialTimer: ReturnType<typeof setTimeout> | null = null;

    const runChecks = async () => {
      if (cancelled) return;
      if (!pendingTokenStateItems.length) {
        refreshTimer = setTimeout(runChecks, BACKGROUND_REFRESH_INTERVAL_MS);
        return;
      }
      if (tokenStateCheckRunningRef.current) {
        refreshTimer = setTimeout(runChecks, BACKGROUND_REFRESH_INTERVAL_MS);
        return;
      }
      tokenStateCheckRunningRef.current = true;
      try {
        for (const entry of pendingTokenStateItems) {
          if (cancelled) break;
          await performTokenStateCheck(entry, { silent: true });
        }
      } finally {
        tokenStateCheckRunningRef.current = false;
      }
      if (!cancelled) {
        refreshTimer = setTimeout(runChecks, BACKGROUND_REFRESH_INTERVAL_MS);
      }
    };

    initialTimer = setTimeout(() => {
      if (!cancelled) {
        void runChecks();
      }
    }, TOKEN_STATE_BACKGROUND_STAGGER_MS);

    return () => {
      cancelled = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [
    open,
    sentTokenStateChecksEnabled,
    pendingTokenStateItems,
    backgroundSuspended,
    performTokenStateCheck,
  ]);

  useEffect(() => {
    return () => {
      clearProofStateSubscriptions();
    };
  }, [clearProofStateSubscriptions]);
  const lastTokenStateResetNonceRef = useRef<number>(0);
  useEffect(() => {
    if (!tokenStateResetNonce) return;
    if (lastTokenStateResetNonceRef.current === tokenStateResetNonce) return;
    lastTokenStateResetNonceRef.current = tokenStateResetNonce;
    resetTokenTracking();
  }, [tokenStateResetNonce, resetTokenTracking]);

  const handleProofStateNotification = useCallback(
    (mintKey: string, payload: ProofState & { proof: Proof }) => {
      const meta = proofStateSubscriptionMetadataRef.current.get(mintKey);
      if (!meta) return;
      const secret = payload.proof?.secret;
      if (!secret) return;
      const target = meta.secretToItem.get(secret);
      if (!target) return;
      let toastMessageLocal: string | null = null;
      setHistory((prev) =>
        prev.map((entry) => {
          if (entry.id !== target.itemId || !entry.tokenState) return entry;
          const proofs = entry.tokenState.proofs;
          if (!proofs[target.proofIndex]) return entry;
          const nextProofs = proofs.map((stored, idx) => {
            if (idx !== target.proofIndex) return stored;
            let updated = stored;
            if (payload.Y && stored.Y !== payload.Y) {
              updated = { ...updated, Y: payload.Y };
            } else if (!stored.Y) {
              const computed = computeProofY(stored.secret);
              if (computed) {
                updated = { ...updated, Y: computed };
              }
            }
            if (payload.witness && payload.witness !== stored.witness) {
              updated = { ...updated, witness: payload.witness };
            }
            const normalizedState = sanitizeProofStateValue(payload.state);
            if (normalizedState && normalizedState !== stored.lastState) {
              updated = { ...updated, lastState: normalizedState };
            }
            return updated;
          });
          const aggregated =
            aggregateStoredProofStates(nextProofs) ?? entry.tokenState.lastState;
          const summaryValue = summarizeStoredProofStates(nextProofs);
          const mergedWitnesses = { ...(entry.tokenState.lastWitnesses ?? {}) };
          const yKey = payload.Y ?? nextProofs[target.proofIndex]?.Y;
          if (payload.witness && yKey) {
            mergedWitnesses[yKey] = payload.witness;
          }
          const mergedWitnessesValue = Object.keys(mergedWitnesses).length
            ? mergedWitnesses
            : entry.tokenState.lastWitnesses;
          const shouldNotify = aggregated === "SPENT" && entry.tokenState.notifiedSpent !== true;
          if (shouldNotify) {
            toastMessageLocal = buildTokenSpentToastMessage(nextProofs);
          }
          const nextTokenState: HistoryTokenState = {
            ...entry.tokenState,
            proofs: nextProofs,
            lastState: aggregated ?? entry.tokenState.lastState,
            lastSummary: summaryValue || entry.tokenState.lastSummary,
            lastCheckedAt: Date.now(),
            lastWitnesses: mergedWitnessesValue,
            notifiedSpent: aggregated === "SPENT" ? true : entry.tokenState.notifiedSpent,
          };
          return {
            ...entry,
            summary:
              aggregated === "SPENT" && !entry.summary.includes("(spent)")
                ? `${entry.summary} (spent)`
                : entry.summary,
            tokenState: nextTokenState,
          };
        }),
      );
      if (toastMessageLocal) {
        showToast(toastMessageLocal, 3500);
      }
    },
    [setHistory, showToast],
  );

  useEffect(() => {
    if (!open || !sentTokenStateChecksEnabled) {
      clearProofStateSubscriptions();
      return;
    }
    if (!pendingTokenStateItems.length) {
      clearProofStateSubscriptions();
      return;
    }
    const subscriptionPlans = new Map<
      string,
      { proofs: Proof[]; secretToItem: Map<string, { itemId: string; proofIndex: number }> }
    >();
    for (const item of pendingTokenStateItems) {
      const tokenState = item.tokenState;
      if (!tokenState || !tokenState.proofs.length) continue;
      const normalizedMint = normalizeMintUrl(tokenState.mintUrl);
      if (!normalizedMint || unsupportedProofSubscriptionMintsRef.current.has(normalizedMint)) continue;
      const existing = subscriptionPlans.get(normalizedMint);
      const plan = existing ?? { proofs: [], secretToItem: new Map() };
      tokenState.proofs.forEach((proof, index) => {
        if (!proof.secret || !proof.id || !proof.C) return;
        if (!plan.secretToItem.has(proof.secret)) {
          plan.proofs.push({
            amount: proof.amount,
            secret: proof.secret,
            id: proof.id,
            C: proof.C,
            witness: proof.witness,
          });
        }
        plan.secretToItem.set(proof.secret, { itemId: item.id, proofIndex: index });
      });
      if (plan.proofs.length) {
        subscriptionPlans.set(normalizedMint, plan);
      }
    }
    if (!subscriptionPlans.size) {
      clearProofStateSubscriptions();
      return;
    }
    let cancelled = false;
    const setup = async () => {
      const now = Date.now();
      for (const [mint, plan] of subscriptionPlans.entries()) {
        const cooldownUntil = proofSubscriptionCooldownRef.current.get(mint);
        if (typeof cooldownUntil === "number" && cooldownUntil > now) {
          continue;
        }
        if (typeof cooldownUntil === "number" && cooldownUntil <= now) {
          proofSubscriptionCooldownRef.current.delete(mint);
        }
        proofStateSubscriptionMetadataRef.current.set(mint, {
          secretToItem: plan.secretToItem,
        });
        try {
          const cancel = await subscribeProofStateUpdates(
            mint,
            plan.proofs,
            (payload) => handleProofStateNotification(mint, payload),
            (error) => {
              console.warn(`Proof state subscription error for ${mint}`, error);
              proofSubscriptionCooldownRef.current.set(
                mint,
                Date.now() + SUBSCRIPTION_RETRY_DELAY_MS,
              );
            },
          );
          if (cancelled) {
            cancel();
            continue;
          }
          proofStateSubscriptionsRef.current.set(mint, cancel);
          proofSubscriptionCooldownRef.current.delete(mint);
        } catch (err: any) {
          proofStateSubscriptionMetadataRef.current.delete(mint);
          if (err?.message?.includes("does not support proof_state")) {
            unsupportedProofSubscriptionMintsRef.current.add(mint);
          } else {
            console.warn(`Failed to subscribe to proof states for ${mint}`, err);
            proofSubscriptionCooldownRef.current.set(
              mint,
              Date.now() + SUBSCRIPTION_RETRY_DELAY_MS,
            );
          }
        }
      }
    };
    void setup();
    return () => {
      cancelled = true;
      clearProofStateSubscriptions();
    };
  }, [
    open,
    sentTokenStateChecksEnabled,
    pendingTokenStateItems,
    subscribeProofStateUpdates,
    handleProofStateNotification,
    clearProofStateSubscriptions,
  ]);

  useEffect(() => {
    if (!npubCashLightningAddressEnabled) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError(null);
      return;
    }
    const storedSk = kvStorage.getItem(LS_NOSTR_SK) || "";
    if (!storedSk) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError("Add your Taskify Nostr key in Settings → Nostr to use npub.cash.");
      return;
    }
    try {
      const identity = deriveNpubCashIdentity(storedSk);
      setNpubCashIdentity({ npub: identity.npub, address: identity.address });
      setNpubCashIdentityError(null);
    } catch (err: any) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError(err?.message || "Unable to derive npub.cash address.");
    }
  }, [npubCashLightningAddressEnabled, open]);

  useEffect(() => {
    if (
      !open ||
      !npubCashLightningAddressEnabled ||
      !npubCashAutoClaim ||
      backgroundSuspended
    ) {
      return;
    }
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let initialTimer: ReturnType<typeof setTimeout> | null = null;

    const runClaim = async () => {
      if (cancelled) return;
      await handleClaimNpubCash({ auto: true });
      if (!cancelled) {
        refreshTimer = setTimeout(runClaim, BACKGROUND_REFRESH_INTERVAL_MS);
      }
    };

    initialTimer = setTimeout(() => {
      if (!cancelled) {
        void runClaim();
      }
    }, NPUB_CASH_REFRESH_STAGGER_MS);

    return () => {
      cancelled = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (backgroundNpubCashClaimRef.current && npubCashClaimAbortRef.current) {
        try {
          npubCashClaimAbortRef.current.abort();
        } catch {}
      }
    };
  }, [
    open,
    npubCashLightningAddressEnabled,
    npubCashAutoClaim,
    backgroundSuspended,
    handleClaimNpubCash,
  ]);

  useEffect(() => {
    return () => {
      if (npubCashClaimAbortRef.current) {
        npubCashClaimAbortRef.current.abort();
        npubCashClaimAbortRef.current = null;
      }
      npubCashClaimingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setSendTokenStr("");
      setLastSendTokenFingerprint(null);
      setLastSendTokenLockLabel(null);
      resetSendLockSettings();
      setRecvMsg("");
      setLnInput("");
      setLnAddrAmt("");
      setLnState("idle");
      setLnError("");
      setShowSendOptions(false);
      setReceiveMode(null);
      setSendMode(null);
      setShowNwcManager(false);
      setNwcUrlInput(nwcConnection?.uri || "");
      setNwcBusy(false);
      setNwcFeedback("");
      setNwcTransferAmt("");
      setNwcFundState("idle");
      setNwcFundMessage("");
      setNwcFundInvoice("");
      setNwcWithdrawState("idle");
      setNwcWithdrawMessage("");
      setNwcWithdrawInvoice("");
      setLnurlPayData(null);
      setLnurlWithdrawInfo(null);
      setLnurlWithdrawAmt("");
      setLnurlWithdrawState("idle");
      setLnurlWithdrawMessage("");
      setLnurlWithdrawInvoice("");
      setPaymentRequestState(null);
      setPaymentRequestStatus("idle");
      setPaymentRequestMessage("");
      setPendingScan(null);
      setShowScanner(false);
      setScannerMessage("");
      setShowMintBalances(false);
      setShowNwcSheet(false);
      setLightningSendView("input");
    }
  }, [open, nwcConnection, resetSendLockSettings]);

  useEffect(() => {
    if (!pendingPrimaryP2pkKeyId) return;
    if (!p2pkKeys.some((key) => key.id === pendingPrimaryP2pkKeyId)) return;
    setPrimaryP2pkKey(pendingPrimaryP2pkKeyId);
    setPendingPrimaryP2pkKeyId(null);
  }, [pendingPrimaryP2pkKeyId, p2pkKeys, setPrimaryP2pkKey]);

  // Removed auto clipboard detection to avoid unwanted paste popup.
  // Users can explicitly paste via dedicated buttons in each view.

  useEffect(() => {
    if (!open || sendMode !== "lightning") return;
    const timer = setTimeout(() => {
      lnRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [open, sendMode]);

  useEffect(() => {
    if (!lnurlPayData) return;
    if (normalizedLnInput.toLowerCase() !== lnurlPayData.lnurl.trim().toLowerCase()) {
      setLnurlPayData(null);
    }
  }, [lnurlPayData, normalizedLnInput]);

  useEffect(() => {
    if (!showMintBalances) return;
    setMintInputSheet(mintUrl || "");
    refreshMintEntries();
  }, [showMintBalances, mintUrl, refreshMintEntries]);

  useEffect(() => {
    if (!showNwcManager) return;
    setNwcUrlInput(nwcConnection?.uri || "");
    setNwcFeedback("");
  }, [showNwcManager, nwcConnection]);

  useEffect(() => {
    if (!open || !walletConversionEnabled || backgroundSuspended) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let initialTimer: ReturnType<typeof setTimeout> | null = null;

    const loadPrice = async () => {
      try {
        setPriceStatus((prev) => (prev === "loading" ? prev : "loading"));
        const response = await fetch(COINBASE_SPOT_PRICE_URL, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: any = await response.json();
        const amount = Number(payload?.data?.amount);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid price data");
        if (cancelled) return;
        const fetchedAt = Date.now();
        setBtcUsdPrice(amount);
        setPriceUpdatedAt(fetchedAt);
        try {
          kvStorage.setItem(
            LS_BTC_USD_PRICE_CACHE,
            JSON.stringify({ price: amount, updatedAt: fetchedAt })
          );
        } catch (error) {
          console.warn("[wallet] Failed to cache BTC/USD price", error);
        }
        setPriceStatus("idle");
      } catch {
        if (!cancelled) {
          setPriceStatus("error");
        }
      } finally {
        if (!cancelled) {
          refreshTimer = setTimeout(() => {
            void loadPrice();
          }, PRICE_REFRESH_MS);
        }
      }
    };

    const trigger = () => {
      if (!cancelled) {
        void loadPrice();
      }
    };

    if (PRICE_REFRESH_STAGGER_MS > 0) {
      initialTimer = setTimeout(trigger, PRICE_REFRESH_STAGGER_MS);
    } else {
      trigger();
    }

    return () => {
      cancelled = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [open, walletConversionEnabled, backgroundSuspended]);

  useEffect(() => {
    if (!walletConversionEnabled) {
      setPriceStatus("idle");
    }
  }, [walletConversionEnabled]);

  const usdFormatterLarge = useMemo(() => new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }), []);

  const usdFormatterSmall = useMemo(() => new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }), []);

  const relativeTimeFormatter = useMemo(
    () => new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }),
    [],
  );
  const formatRelativeTime = useCallback(
    (timestamp?: number | null) => {
      if (!timestamp) return "";
      const diff = timestamp - Date.now();
      const absDiff = Math.abs(diff);
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      const week = 7 * day;
      const month = 30 * day;
      const year = 365 * day;
      if (absDiff < minute) {
        return relativeTimeFormatter.format(Math.round(diff / 1000), "second");
      }
      if (absDiff < hour) {
        return relativeTimeFormatter.format(Math.round(diff / minute), "minute");
      }
      if (absDiff < day) {
        return relativeTimeFormatter.format(Math.round(diff / hour), "hour");
      }
      if (absDiff < week) {
        return relativeTimeFormatter.format(Math.round(diff / day), "day");
      }
      if (absDiff < month) {
        return relativeTimeFormatter.format(Math.round(diff / week), "week");
      }
      if (absDiff < year) {
        return relativeTimeFormatter.format(Math.round(diff / month), "month");
      }
      return relativeTimeFormatter.format(Math.round(diff / year), "year");
    },
    [relativeTimeFormatter],
  );
  const formatHistoryAmount = useCallback(
    (entry: HistoryItem) => {
      if (entry.amountSat == null) return "";
      const prefix = entry.direction === "out" ? "−" : "+";
      return `${prefix}${satFormatter.format(entry.amountSat)} sat`;
    },
    [satFormatter],
  );
  const resolveMintDisplay = useCallback(
    (entry: HistoryItem) => {
      const target =
        entry.mintUrl || entry.pendingTokenMint || entry.tokenState?.mintUrl || entry.mintQuote?.mintUrl;
      if (!target) return "";
      const normalized = normalizeMintUrl(target);
      const info = normalized ? mintInfoByUrl[normalized] : undefined;
      return info?.name || formatMintDisplayName(target);
    },
    [mintInfoByUrl],
  );
  const deriveHistoryStatus = useCallback((entry: HistoryItem) => {
    const isLightningEntry = entry.type === "lightning" || entry.detailKind === "invoice";
    const prefersReceivedLabel = isLightningEntry && entry.direction === "in";
    if (entry.pendingTokenId && entry.pendingStatus !== "redeemed") {
      return { label: "Pending redemption", tone: "pending" as const };
    }
    if (entry.tokenState) {
      if (entry.tokenState.lastState === "SPENT") {
        if (entry.direction === "in") {
          return { label: "Received", tone: "success" as const };
        }
        return { label: "Sent", tone: "success" as const };
      }
      if (entry.tokenState.lastSummary) {
        return { label: entry.tokenState.lastSummary, tone: "pending" as const };
      }
      return { label: entry.tokenState.lastState || "Pending", tone: "pending" as const };
    }
    if (entry.mintQuote) {
      const state = entry.mintQuote.state?.toLowerCase();
      if (state === "expired") {
        return { label: "Expired", tone: "danger" as const };
      }
      if (state === "paid" || state === "issued") {
        return { label: prefersReceivedLabel ? "Received" : "Paid", tone: "success" as const };
      }
      return { label: state ? state.charAt(0).toUpperCase() + state.slice(1) : "Pending", tone: "pending" as const };
    }
    if (entry.stateLabel) {
      const normalized = entry.stateLabel.toLowerCase();
      if (normalized === "expired") {
        return { label: entry.stateLabel, tone: "danger" as const };
      }
      if (normalized === "paid" || normalized === "completed") {
        return { label: prefersReceivedLabel ? "Received" : entry.stateLabel, tone: "success" as const };
      }
      return { label: entry.stateLabel, tone: undefined };
    }
    if (entry.direction === "in") {
      return { label: "Received", tone: "success" as const };
    }
    if (entry.direction === "out") {
      return { label: "Sent", tone: undefined };
    }
    return { label: "Activity", tone: undefined };
  }, []);

  const paymentRequestUnitLabel = useMemo(
    () => (paymentRequestState?.request.unit || info?.unit || "sat").toLowerCase(),
    [paymentRequestState?.request.unit, info?.unit],
  );

  const paymentRequestFixedAmount = useMemo(() => {
    if (!paymentRequestState) return null;
    const value = Number(paymentRequestState.request.amount);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.floor(value);
  }, [paymentRequestState]);

  const paymentRequestHasFixedAmount = paymentRequestFixedAmount !== null;

  const canToggleCurrency = walletConversionEnabled;

  const paymentRequestInputCurrency =
    walletConversionEnabled && walletPrimaryCurrency === "usd" ? "usd" : "sat";

  const paymentRequestInputUnitLabel = paymentRequestInputCurrency === "usd" ? "USD" : "sats";

  const canTogglePaymentRequestCurrency = canToggleCurrency && !paymentRequestHasFixedAmount;

  const paymentRequestAmountTextValue = useMemo(() => {
    if (paymentRequestHasFixedAmount) {
      if (paymentRequestFixedAmount != null) {
        return satFormatter.format(paymentRequestFixedAmount);
      }
      return "0";
    }
    return paymentRequestManualAmount.trim() || "0";
  }, [
    paymentRequestHasFixedAmount,
    paymentRequestFixedAmount,
    paymentRequestManualAmount,
    satFormatter,
  ]);

  const paymentRequestPrimaryAmountText = useMemo(() => {
    if (paymentRequestHasFixedAmount) {
      return `${paymentRequestAmountTextValue} ${paymentRequestUnitLabel}`;
    }
    const trimmed = paymentRequestManualAmount.trim();
    if (paymentRequestInputCurrency === "usd") {
      return `$${trimmed || "0.00"}`;
    }
    return `${trimmed || "0"} sat`;
  }, [
    paymentRequestAmountTextValue,
    paymentRequestHasFixedAmount,
    paymentRequestInputCurrency,
    paymentRequestManualAmount,
    paymentRequestUnitLabel,
  ]);

  const paymentRequestSecondaryAmountText = useMemo(() => {
    const unitDisplay = paymentRequestUnitLabel === "sat" ? "sats" : paymentRequestUnitLabel;
    if (paymentRequestHasFixedAmount) {
      if (paymentRequestFixedAmount != null) {
        return `Request requires ${satFormatter.format(paymentRequestFixedAmount)} ${unitDisplay}`;
      }
      return `Request requires amount in ${unitDisplay}`;
    }
    const inputUnitDisplay = paymentRequestInputUnitLabel;
    const trimmed = paymentRequestManualAmount.trim();
    if (!trimmed) {
      return `Enter amount in ${inputUnitDisplay}`;
    }
    const numericAmount = Number(trimmed);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return `Enter amount in ${inputUnitDisplay}`;
    }
    if (paymentRequestInputCurrency === "usd") {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
        return `Enter amount in ${inputUnitDisplay}`;
      }
      const sats = Math.floor((numericAmount / btcUsdPrice) * SATS_PER_BTC);
      if (sats <= 0) {
        return `Enter amount in ${inputUnitDisplay}`;
      }
      return `≈ ${satFormatter.format(sats)} sat`;
    }
    return `Ready to send ${trimmed} ${inputUnitDisplay}`;
  }, [
    paymentRequestHasFixedAmount,
    paymentRequestManualAmount,
    paymentRequestInputCurrency,
    paymentRequestInputUnitLabel,
    paymentRequestUnitLabel,
    paymentRequestFixedAmount,
    walletConversionEnabled,
    btcUsdPrice,
    satFormatter,
  ]);

  const paymentRequestPrimaryTransportType = useMemo(() => {
    if (!paymentRequestState) return null;
    const request = paymentRequestState.request;
    let transports = Array.isArray((request as any)?.transport)
      ? ((request as any).transport as PaymentRequestTransport[])
      : [];
    transports = transports.filter(
      (entry): entry is PaymentRequestTransport =>
        !!entry && typeof entry.type === "string" && typeof entry.target === "string",
    );
    if (!transports.length) {
      const fallback = new Map<PaymentRequestTransportType, PaymentRequestTransport>();
      const nostr = request.getTransport(
        PaymentRequestTransportType.NOSTR,
      ) as PaymentRequestTransport | undefined;
      if (nostr) fallback.set(PaymentRequestTransportType.NOSTR, nostr);
      const post = request.getTransport(
        PaymentRequestTransportType.POST,
      ) as PaymentRequestTransport | undefined;
      if (post) fallback.set(PaymentRequestTransportType.POST, post);
      transports = [...fallback.values()];
    }
    if (!transports.length) {
      return null;
    }
    return transports[0].type;
  }, [paymentRequestState]);

  const paymentRequestActionLabel = useMemo(() => {
    switch (paymentRequestPrimaryTransportType) {
      case PaymentRequestTransportType.NOSTR:
        return "Pay via nostr";
      case PaymentRequestTransportType.POST:
        return "Pay via http";
      default:
        return "Send";
    }
  }, [paymentRequestPrimaryTransportType]);

  const canEditPaymentRequestAmount = !paymentRequestHasFixedAmount;

  const paymentRequestAmountButtonEnabled = canEditPaymentRequestAmount || canTogglePaymentRequestCurrency;

  const formatUsdAmount = useCallback((amount: number | null) => {
    if (amount == null || !Number.isFinite(amount)) return "—";
    if (amount <= 0) return "$0.00";
    if (amount >= 1) return usdFormatterLarge.format(amount);
    return usdFormatterSmall.format(amount);
  }, [usdFormatterLarge, usdFormatterSmall]);

  const effectivePrimaryCurrency = walletConversionEnabled ? walletPrimaryCurrency : "sat";

  const usdBalance = useMemo(() => {
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    return (totalBalance / SATS_PER_BTC) * btcUsdPrice;
  }, [walletConversionEnabled, btcUsdPrice, totalBalance]);

  const primaryCurrency = effectivePrimaryCurrency === "usd" ? "usd" : "sat";
  const unitLabel = primaryCurrency === "usd" ? "USD" : "SAT";
  const amountInputUnitLabel = primaryCurrency === "usd" ? "USD" : "sats";
  const amountInputPlaceholder = `Amount (${amountInputUnitLabel})`;

  const unitButtonClass = useMemo(
    () => `wallet-modal__unit chip chip-accent${canToggleCurrency ? " pressable" : ""}`,
    [canToggleCurrency]
  );

  const balanceCardClass = useMemo(
    () =>
      `wallet-balance-card${canToggleCurrency ? " wallet-balance-card--toggleable pressable" : ""}`,
    [canToggleCurrency],
  );

  const contentClass = useMemo(
    () => `wallet-modal__content${walletTab === "wallet" ? " wallet-modal__content--home" : ""}`,
    [walletTab],
  );

  const handleTogglePrimary = useCallback(() => {
    if (!walletConversionEnabled) return;
    const next = walletPrimaryCurrency === "usd" ? "sat" : "usd";
    setWalletPrimaryCurrency(next);
  }, [walletConversionEnabled, walletPrimaryCurrency, setWalletPrimaryCurrency]);

  const parseAmountInput = useCallback((raw: string) => {
    const trimmed = raw.trim();
    const unitLabelLocal = primaryCurrency === "usd" ? "USD" : "sats";
    if (!trimmed) {
      return { sats: 0, raw: 0 };
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return { sats: 0, raw: numeric, error: `Enter amount in ${unitLabelLocal}` };
    }
    if (primaryCurrency === "usd") {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
        return { sats: 0, raw: numeric, error: "USD price unavailable. Try again in a moment." };
      }
      const sats = Math.floor((numeric / btcUsdPrice) * SATS_PER_BTC);
      if (sats <= 0) {
        return { sats: 0, raw: numeric, error: "Amount too small. Increase the USD value." };
      }
      return { sats, raw: numeric, usd: numeric };
    }
    const sats = Math.floor(numeric);
    if (sats <= 0) {
      return { sats: 0, raw: numeric, error: `Enter amount in ${unitLabelLocal}` };
    }
    return { sats, raw: numeric };
  }, [primaryCurrency, walletConversionEnabled, btcUsdPrice]);

  const parsedMintAmount = useMemo(() => parseAmountInput(mintAmt), [parseAmountInput, mintAmt]);

  const mintAmountSecondaryDisplay = useMemo(() => {
    if (parsedMintAmount.error || parsedMintAmount.sats <= 0) return null;
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(parsedMintAmount.sats)} sat`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (parsedMintAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [
    parsedMintAmount,
    primaryCurrency,
    walletConversionEnabled,
    btcUsdPrice,
    satFormatter,
    formatUsdAmount,
  ]);

  const canCreateMintInvoice = useMemo(
    () => parsedMintAmount.sats > 0 && !parsedMintAmount.error && !!mintUrl,
    [parsedMintAmount, mintUrl],
  );

  const selectedMintBalance = useMemo(() => {
    const selected = mintSelectionOptions.find((option) => option.isActive);
    return selected?.balance ?? 0;
  }, [mintSelectionOptions]);

  const selectedMintOption = useMemo(
    () => mintSelectionOptions.find((option) => option.isActive) || null,
    [mintSelectionOptions],
  );

  const selectedMintValue = selectedMintOption?.normalized ?? "";

  const selectedMintLabel = useMemo(() => {
    if (!selectedMintOption) return "Select mint";
    const info = mintInfoByUrl[selectedMintOption.normalized];
    return info?.name || formatMintDisplayName(selectedMintOption.url);
  }, [selectedMintOption, mintInfoByUrl]);

  const selectedMintBalanceLabel = useMemo(
    () =>
      selectedMintBalance > 0
        ? `${satFormatter.format(selectedMintBalance)} sat available`
        : "No eCash stored yet",
    [selectedMintBalance, satFormatter],
  );

  const parsedLightningSendAmount = useMemo(
    () => parseAmountInput(lnAddrAmt),
    [parseAmountInput, lnAddrAmt],
  );

  const lightningSendAmountSecondaryDisplay = useMemo(() => {
    if (parsedLightningSendAmount.error || parsedLightningSendAmount.sats <= 0) return null;
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(parsedLightningSendAmount.sats)} sat`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (parsedLightningSendAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [
    parsedLightningSendAmount,
    primaryCurrency,
    walletConversionEnabled,
    btcUsdPrice,
    satFormatter,
    formatUsdAmount,
  ]);

  const lightningSendPrimaryAmountText = useMemo(() => {
    const trimmedAmount = lnAddrAmt.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmedAmount || "0.00"}`;
    }
    return `${trimmedAmount || "0"} sat`;
  }, [lnAddrAmt, primaryCurrency]);

  const lightningSendSecondaryAmountText = useMemo(() => {
    if (lightningSendAmountSecondaryDisplay) return lightningSendAmountSecondaryDisplay;
    const trimmedAmount = lnAddrAmt.trim();
    if (!trimmedAmount) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (!canToggleCurrency) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const nextCurrency = primaryCurrency === "usd" ? "sat" : "USD";
    return `Tap to switch to ${nextCurrency}`;
  }, [
    lightningSendAmountSecondaryDisplay,
    lnAddrAmt,
    amountInputUnitLabel,
    canToggleCurrency,
    primaryCurrency,
  ]);

  const canReviewLightningInput = useMemo(() => {
    if (!lnInput.trim()) return false;
    return isBolt11Input || isLnAddress || isLnurlInput;
  }, [lnInput, isBolt11Input, isLnAddress, isLnurlInput]);

  const lightningInvoiceAmountSecondaryDisplay = useMemo(() => {
    if (lightningInvoiceAmountSat == null) return null;
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (lightningInvoiceAmountSat / SATS_PER_BTC) * btcUsdPrice;
    return formatUsdAmount(usdValue);
  }, [lightningInvoiceAmountSat, walletConversionEnabled, btcUsdPrice, formatUsdAmount]);

  const lightningPrimaryAmountText = useMemo(() => {
    const trimmedAmount = mintAmt.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmedAmount || "0.00"}`;
    }
    return `${trimmedAmount || "0"} sat`;
  }, [mintAmt, primaryCurrency]);

  const lightningSecondaryAmountText = useMemo(() => {
    if (mintAmountSecondaryDisplay) return mintAmountSecondaryDisplay;
    const trimmedAmount = mintAmt.trim();
    if (!trimmedAmount) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (!canToggleCurrency) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const nextCurrency = primaryCurrency === "usd" ? "sat" : "USD";
    return `Tap to switch to ${nextCurrency}`;
  }, [
    amountInputUnitLabel,
    canToggleCurrency,
    mintAmt,
    mintAmountSecondaryDisplay,
    primaryCurrency,
  ]);

  const invoiceAmountSecondary = useMemo(() => {
    if (!activeMintInvoice) return null;
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (activeMintInvoice.amountSat / SATS_PER_BTC) * btcUsdPrice;
    return formatUsdAmount(usdValue);
  }, [activeMintInvoice, walletConversionEnabled, btcUsdPrice, formatUsdAmount]);

  const lightningInvoiceStatusLabel = useMemo(() => {
    switch (mintStatus) {
      case "waiting":
        return "Pending";
      case "minted":
        return "Received";
      case "error":
        return "Error";
      default:
        return "Unpaid";
    }
  }, [mintStatus]);

  const handleCopyLightningAddress = useCallback(async () => {
    const address = npubCashIdentity?.address;
    if (!address) return;
    try {
      await navigator.clipboard?.writeText(address);
      setLightningAddressCopied(true);
      showToast("Lightning address copied", 2000);
    } catch (error) {
      console.warn("Failed to copy lightning address", error);
    }
  }, [npubCashIdentity?.address, showToast]);

  const handleOpenLightningAmountView = useCallback(() => {
    resetLightningInvoiceState();
    setLightningReceiveView("amount");
    refreshMintEntries();
  }, [resetLightningInvoiceState, refreshMintEntries]);

  const handleLightningInvoiceBack = useCallback(() => {
    resetLightningInvoiceState();
    setLightningReceiveView("amount");
  }, [resetLightningInvoiceState]);

  const handleLightningAmountUnitToggle = useCallback(() => {
    if (!canToggleCurrency) return;
    const nextCurrency = walletPrimaryCurrency === "usd" ? "sat" : "usd";
    const satsAmount = parsedMintAmount.error ? 0 : parsedMintAmount.sats;
    handleTogglePrimary();
    if (!satsAmount || satsAmount <= 0) {
      setMintAmt("");
      return;
    }
    if (nextCurrency === "usd") {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
        setMintAmt("");
        return;
      }
      const usdValue = (satsAmount / SATS_PER_BTC) * btcUsdPrice;
      const rounded = Math.round(usdValue * 100) / 100;
      setMintAmt(rounded.toFixed(2));
      return;
    }
    setMintAmt(String(satsAmount));
  }, [
    canToggleCurrency,
    walletPrimaryCurrency,
    parsedMintAmount,
    handleTogglePrimary,
    walletConversionEnabled,
    btcUsdPrice,
  ]);

  const handleLightningAmountKeypadInput = useCallback(
    (key: string) => {
      setMintAmt((prev) => {
        const current = prev || "";
        if (key === "backspace") {
          const trimmed = current.slice(0, -1);
          return trimmed;
        }
        if (key === "clear") {
          return "";
        }
        if (key === "decimal") {
          if (primaryCurrency !== "usd") return current;
          if (current.includes(".")) return current;
          return current ? `${current}.` : "0.";
        }
        if (/^\d$/.test(key)) {
          if (primaryCurrency === "usd") {
            let next = current === "0" && !current.includes(".") ? key : `${current}${key}`;
            if (current === "" && key === "0") {
              return "0";
            }
            if (!current.includes(".") && /^0\d/.test(next)) {
              next = String(Number(next));
            }
            const decimalPart = next.split(".")[1];
            if (decimalPart && decimalPart.length > 2) {
              return current;
            }
            return next;
          }
          const combined = `${current}${key}`;
          const normalized = combined.replace(/^0+(?=\d)/, "");
          return normalized || "0";
        }
        return current;
      });
      setMintError("");
      if (mintQuote || activeMintInvoice) {
        resetLightningInvoiceState();
      }
    },
    [primaryCurrency, mintQuote, activeMintInvoice, resetLightningInvoiceState],
  );

  const handleOpenEcashRequestAmountView = useCallback(() => {
    refreshMintEntries();
    setEcashReceiveView("amount");
    setRecvMsg("");
    setPaymentRequestError("");
    setLastCreatedEcashRequest(null);
  }, [refreshMintEntries, setPaymentRequestError]);

  const handleEcashRequestKeypadInput = useCallback(
    (key: string) => {
      setEcashRequestAmt((prev) => {
        const current = prev || "";
        if (key === "backspace") {
          return current.slice(0, -1);
        }
        if (key === "clear") {
          return "";
        }
        if (key === "decimal") {
          if (primaryCurrency !== "usd") return current;
          if (current.includes(".")) return current;
          return current ? `${current}.` : "0.";
        }
        if (/^\d$/.test(key)) {
          if (primaryCurrency === "usd") {
            let next = current === "0" && !current.includes(".") ? key : `${current}${key}`;
            if (current === "" && key === "0") {
              return "0";
            }
            if (!current.includes(".") && /^0\d/.test(next)) {
              next = String(Number(next));
            }
            const decimalPart = next.split(".")[1];
            if (decimalPart && decimalPart.length > 2) {
              return current;
            }
            return next;
          }
          const combined = `${current}${key}`;
          const normalized = combined.replace(/^0+(?=\d)/, "");
          return normalized || "0";
        }
        return current;
      });
    },
    [primaryCurrency],
  );

  const handleLightningSendAmountKeypadInput = useCallback(
    (key: string) => {
      setLnAddrAmt((prev) => {
        const current = prev || "";
        if (key === "backspace") {
          const trimmed = current.slice(0, -1);
          return trimmed;
        }
        if (key === "clear") {
          return "";
        }
        if (key === "decimal") {
          if (primaryCurrency !== "usd") return current;
          if (current.includes(".")) return current;
          return current ? `${current}.` : "0.";
        }
        if (/^\d$/.test(key)) {
          if (primaryCurrency === "usd") {
            let next = current === "0" && !current.includes(".") ? key : `${current}${key}`;
            if (current === "" && key === "0") {
              return "0";
            }
            if (!current.includes(".") && /^0\d/.test(next)) {
              next = String(Number(next));
            }
            const decimalPart = next.split(".")[1];
            if (decimalPart && decimalPart.length > 2) {
              return current;
            }
            return next;
          }
          const combined = `${current}${key}`;
          const normalized = combined.replace(/^0+(?=\d)/, "");
          return normalized || "0";
        }
        return current;
      });
    },
    [primaryCurrency],
  );

  type LightningSendInputKind = "empty" | "invoice" | "address" | "lnurl" | "unknown";

  const evaluateLightningSendInput = useCallback(
    (rawValue: string): LightningSendInputKind => {
      const trimmed = rawValue.trim();
      if (!trimmed) {
        setLightningSendView("input");
        return "empty";
      }
      const normalized = trimmed.replace(/^lightning:/i, "").trim();
      if (/^ln(bc|tb|sb|bcrt)[0-9]/i.test(normalized)) {
        setLightningSendView("invoice");
        return "invoice";
      }
      if (/^[^@\s]+@[^@\s]+$/.test(normalized)) {
        setLightningSendView("address");
        return "address";
      }
      if (/^lnurl[0-9a-z]+$/i.test(normalized)) {
        setLightningSendView("address");
        return "lnurl";
      }
      setLightningSendView("input");
      return "unknown";
    },
    [],
  );

  const handleLightningInputReview = useCallback(() => {
    const kind = evaluateLightningSendInput(lnInput);
    if (kind === "invoice") {
      setLnAddrAmt("");
      setLnState("idle");
      setLnError("");
    } else if (kind === "address" || kind === "lnurl") {
      setLnState("idle");
      setLnError("");
    } else if (kind === "empty") {
      setLnError("Paste an invoice or enter a lightning address");
    } else if (kind === "unknown") {
      setLnError("Unsupported input. Paste a Lightning invoice, address, or LNURL.");
    }
    return kind;
  }, [evaluateLightningSendInput, lnInput]);

  const handlePasteLightningInput = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      setLnInput(text);
      const kind = evaluateLightningSendInput(text);
      setLnState("idle");
      setLnError("");
      if (kind === "invoice") {
        setLnAddrAmt("");
      } else if (kind === "address" || kind === "lnurl") {
        setLnAddrAmt("");
      } else if (kind === "unknown") {
        alert("Clipboard does not contain a valid Lightning invoice, address, or LNURL.");
        setLnError("Clipboard does not contain a valid Lightning invoice, address, or LNURL.");
      }
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, [evaluateLightningSendInput]);

  const handlePaymentRequestKeypadInput = useCallback((key: string) => {
    setPaymentRequestManualAmount((prev) => {
      const current = prev || "";
      if (key === "backspace") {
        return current.slice(0, -1);
      }
      if (key === "clear") {
        return "";
      }
      if (key === "decimal") {
        if (primaryCurrency !== "usd") return current;
        if (current.includes(".")) return current;
        return current ? `${current}.` : "0.";
      }
      if (/^\d$/.test(key)) {
        if (primaryCurrency === "usd") {
          let next = current === "0" && !current.includes(".") ? key : `${current}${key}`;
          if (current === "" && key === "0") {
            return "0";
          }
          if (!current.includes(".") && /^0\d/.test(next)) {
            next = String(Number(next));
          }
          const decimalPart = next.split(".")[1];
          if (decimalPart && decimalPart.length > 2) {
            return current;
          }
          return next;
        }
        const combined = `${current}${key}`;
        const normalized = combined.replace(/^0+(?=\d)/, "");
        return normalized || "0";
      }
      return current;
    });
  }, [primaryCurrency]);

  const handlePaymentRequestAmountUnitToggle = useCallback(() => {
    if (!canTogglePaymentRequestCurrency) return;
    const nextCurrency = walletPrimaryCurrency === "usd" ? "sat" : "usd";
    const trimmed = paymentRequestManualAmount.trim();
    let satsAmount = 0;
    if (trimmed) {
      const numeric = Number(trimmed);
      if (paymentRequestInputCurrency === "usd") {
        if (
          walletConversionEnabled &&
          btcUsdPrice != null &&
          btcUsdPrice > 0 &&
          Number.isFinite(numeric) &&
          numeric > 0
        ) {
          satsAmount = Math.floor((numeric / btcUsdPrice) * SATS_PER_BTC);
        }
      } else if (Number.isFinite(numeric) && numeric > 0) {
        satsAmount = Math.floor(numeric);
      }
    }
    handleTogglePrimary();
    if (!satsAmount || satsAmount <= 0) {
      setPaymentRequestManualAmount("");
      return;
    }
    if (nextCurrency === "usd") {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
        setPaymentRequestManualAmount("");
        return;
      }
      const usdValue = (satsAmount / SATS_PER_BTC) * btcUsdPrice;
      const rounded = Math.round(usdValue * 100) / 100;
      setPaymentRequestManualAmount(rounded.toFixed(2));
      return;
    }
    setPaymentRequestManualAmount(String(satsAmount));
  }, [
    btcUsdPrice,
    canTogglePaymentRequestCurrency,
    handleTogglePrimary,
    paymentRequestInputCurrency,
    paymentRequestManualAmount,
    walletConversionEnabled,
    walletPrimaryCurrency,
  ]);

  const handleSetEcashRequestMode = useCallback((mode: "multi" | "single") => {
    setEcashRequestMode(mode);
    setRecvMsg("");
  }, []);

  const parsedEcashRequestAmount = useMemo(
    () => parseAmountInput(ecashRequestAmt),
    [parseAmountInput, ecashRequestAmt],
  );

  const ecashRequestAmountSecondaryDisplay = useMemo(() => {
    if (parsedEcashRequestAmount.error || parsedEcashRequestAmount.sats <= 0) return null;
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(parsedEcashRequestAmount.sats)} sat`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    const usdValue = (parsedEcashRequestAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [
    parsedEcashRequestAmount,
    primaryCurrency,
    walletConversionEnabled,
    btcUsdPrice,
    satFormatter,
    formatUsdAmount,
  ]);

  const ecashRequestPrimaryAmountText = useMemo(() => {
    const trimmedAmount = ecashRequestAmt.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmedAmount || "0.00"}`;
    }
    return `${trimmedAmount || "0"} sat`;
  }, [ecashRequestAmt, primaryCurrency]);

  const ecashRequestSecondaryAmountText = useMemo(() => {
    if (ecashRequestMode === "multi") {
      return "Reusable request";
    }
    if (ecashRequestAmountSecondaryDisplay) return ecashRequestAmountSecondaryDisplay;
    const trimmedAmount = ecashRequestAmt.trim();
    if (!trimmedAmount) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (!canToggleCurrency) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const nextCurrency = primaryCurrency === "usd" ? "sat" : "USD";
    return `Tap to switch to ${nextCurrency}`;
  }, [
    ecashRequestMode,
    ecashRequestAmountSecondaryDisplay,
    ecashRequestAmt,
    amountInputUnitLabel,
    canToggleCurrency,
    primaryCurrency,
  ]);

  const nostrMissingReason = paymentRequestsEnabled ? nostrIdentityInfo.reason : null;

  const canCreateEcashRequest = useMemo(() => {
    if (!paymentRequestsEnabled) return false;
    if (!mintUrl) return false;
    if (!info?.unit) return false;
    if (nostrMissingReason) return false;
    if (ecashRequestMode === "single") {
      return parsedEcashRequestAmount.sats > 0 && !parsedEcashRequestAmount.error;
    }
    return true;
  }, [
    paymentRequestsEnabled,
    mintUrl,
    info?.unit,
    nostrMissingReason,
    ecashRequestMode,
    parsedEcashRequestAmount,
  ]);

  const overviewPaymentRequest = useMemo(() => {
    if (openPaymentRequest && !openPaymentRequest.request.singleUse) {
      return openPaymentRequest;
    }
    if (currentPaymentRequest && !currentPaymentRequest.request.singleUse) {
      return currentPaymentRequest;
    }
    return null;
  }, [openPaymentRequest, currentPaymentRequest]);

  const handleOpenEcashAmountView = useCallback(() => {
    refreshMintEntries();
    setEcashSendView("amount");
  }, [refreshMintEntries]);

  const handleEcashAmountKeypadInput = useCallback(
    (key: string) => {
      setSendAmt((prev) => {
        const current = prev || "";
        if (key === "backspace") {
          return current.slice(0, -1);
        }
        if (key === "clear") {
          return "";
        }
        if (key === "decimal") {
          if (primaryCurrency !== "usd") return current;
          if (current.includes(".")) return current;
          return current ? `${current}.` : "0.";
        }
        if (/^\d$/.test(key)) {
          if (primaryCurrency === "usd") {
            let next = current === "0" && !current.includes(".") ? key : `${current}${key}`;
            if (current === "" && key === "0") {
              return "0";
            }
            if (!current.includes(".") && /^0\d/.test(next)) {
              next = String(Number(next));
            }
            const decimalPart = next.split(".")[1];
            if (decimalPart && decimalPart.length > 2) {
              return current;
            }
            return next;
          }
          const combined = `${current}${key}`;
          const normalized = combined.replace(/^0+(?=\d)/, "");
          return normalized || "0";
        }
        return current;
      });
      setSendLockError("");
    },
    [primaryCurrency],
  );

  const handleSwapAmountKeypadInput = useCallback(
    (key: string) => {
      setSwapAmount((prev) => {
        const current = prev || "";
        if (key === "backspace") {
          return current.slice(0, -1);
        }
        if (key === "clear") {
          return "";
        }
        if (key === "decimal") {
          if (primaryCurrency !== "usd") return current;
          if (current.includes(".")) return current;
          return current ? `${current}.` : "0.";
        }
        if (/^\d$/.test(key)) {
          if (primaryCurrency === "usd") {
            let next = current === "0" && !current.includes(".") ? key : `${current}${key}`;
            if (current === "" && key === "0") {
              return "0";
            }
            if (!current.includes(".") && /^0\d/.test(next)) {
              next = String(Number(next));
            }
            const decimalPart = next.split(".")[1];
            if (decimalPart && decimalPart.length > 2) {
              return current;
            }
            return next;
          }
          const combined = `${current}${key}`;
          const normalized = combined.replace(/^0+(?=\d)/, "");
          return normalized || "0";
        }
        return current;
      });
      if (mintSwapState === "error") {
        setMintSwapState("idle");
        setMintSwapMessage("");
      }
      if (nwcFundState === "error") {
        setNwcFundMessage("");
      }
      if (nwcWithdrawState === "error") {
        setNwcWithdrawMessage("");
      }
    },
    [mintSwapState, nwcFundState, nwcWithdrawState, primaryCurrency],
  );

  useEffect(() => {
    if (lightningReceiveView !== "amount") return;
    mintSelectionOptions.forEach((option) => {
      void ensureMintInfo(option.url);
    });
  }, [lightningReceiveView, mintSelectionOptions, ensureMintInfo]);

  const swapFromIsNwc = swapFromValue === "nwc";
  const swapToIsNwc = swapToValue === "nwc";

  const swapScenario = useMemo<"mint-to-mint" | "mint-to-nwc" | "nwc-to-mint" | null>(() => {
    if (!swapFromValue || !swapToValue) return null;
    if (swapFromValue === swapToValue) return null;
    if (swapFromIsNwc && swapToIsNwc) return null;
    if (swapFromIsNwc) return "nwc-to-mint";
    if (swapToIsNwc) return "mint-to-nwc";
    return "mint-to-mint";
  }, [swapFromIsNwc, swapFromValue, swapToIsNwc, swapToValue]);

  const parsedSwapAmount = useMemo(() => parseAmountInput(swapAmount), [parseAmountInput, swapAmount]);

  const swapPrimaryAmountText = useMemo(() => {
    const trimmed = swapAmount.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmed || "0.00"}`;
    }
    return `${trimmed || "0"} sat`;
  }, [swapAmount, primaryCurrency]);

  const swapSecondaryAmountText = useMemo(() => {
    if (parsedSwapAmount.error || parsedSwapAmount.sats <= 0) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(parsedSwapAmount.sats)} sat`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const usdValue = (parsedSwapAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [
    amountInputUnitLabel,
    btcUsdPrice,
    formatUsdAmount,
    parsedSwapAmount,
    primaryCurrency,
    satFormatter,
    walletConversionEnabled,
  ]);

  const mintSwapInProgress =
    mintSwapState === "creating" || mintSwapState === "paying" || mintSwapState === "waiting" || mintSwapState === "claiming";

  const swapInProgress = useMemo(() => {
    if (swapScenario === "mint-to-mint") return mintSwapInProgress;
    if (swapScenario === "nwc-to-mint") return nwcFundInProgress;
    if (swapScenario === "mint-to-nwc") return nwcWithdrawInProgress;
    return false;
  }, [mintSwapInProgress, nwcFundInProgress, nwcWithdrawInProgress, swapScenario]);

  const canSubmitSwap = useMemo(() => {
    if (!swapScenario) return false;
    if (parsedSwapAmount.error || parsedSwapAmount.sats <= 0) return false;
    if (swapScenario === "mint-to-mint") {
      return mintEntriesByNormalized.has(swapFromValue) && mintEntriesByNormalized.has(swapToValue);
    }
    if (!hasNwcConnection) return false;
    const mintValue = swapScenario === "mint-to-nwc" ? swapFromValue : swapToValue;
    return !!mintValue && mintEntriesByNormalized.has(mintValue);
  }, [
    hasNwcConnection,
    mintEntriesByNormalized,
    parsedSwapAmount,
    swapFromValue,
    swapScenario,
    swapToValue,
  ]);

  const mintSwapStatusText = useMemo(() => {
    switch (mintSwapState) {
      case "creating":
        return "Creating invoice…";
      case "paying":
        return "Paying invoice…";
      case "waiting":
        return "Waiting for mint…";
      case "claiming":
        return "Claiming eCash…";
      case "done":
        return "Swap complete";
      default:
        return "";
    }
  }, [mintSwapState]);

  const claimingEventSet = useMemo(() => new Set(claimingEventIds), [claimingEventIds]);

  const persistSpentIncomingEvents = useCallback(() => {
    try {
      const entries: string[] = [];
      for (const [eventId, fingerprint] of spentIncomingPaymentsRef.current.entries()) {
        if (!eventId) continue;
        if (fingerprint) {
          entries.push(`${eventId}::${fingerprint}`);
        } else {
          entries.push(eventId);
        }
      }
      const trimmed = entries.slice(-400);
      idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_SPENT_NOSTR_PAYMENTS, JSON.stringify(trimmed));
    } catch (err) {
      console.warn("Failed to persist spent nostr payments", err);
    }
  }, []);

  const requestNostrPaymentDeletion = useCallback(
    async (eventId: string, senderPubkey?: string | null, reason?: string) => {
      if (!paymentRequestsEnabled) return;
      const identity = ensureNostrIdentity();
      if (!identity) return;
      const relayList = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter((url): url is string => !!url);
      if (!relayList.length) return;
      if (!eventId) return;
      try {
        const tags: string[][] = [["e", eventId]];
        if (senderPubkey && typeof senderPubkey === "string" && senderPubkey.trim()) {
          tags.push(["p", senderPubkey.trim()]);
        }
        const deletionTemplate: EventTemplate = {
          kind: 5,
          content: typeof reason === "string" ? reason : "",
          tags,
          created_at: Math.floor(Date.now() / 1000),
        };
        const deletionEvent = finalizeEvent(deletionTemplate, hexToBytes(identity.secret));
        const pool = ensureNostrPool();
        await safePublish(pool, relayList, deletionEvent);
      } catch (err) {
        console.warn("Failed to publish nostr deletion", err);
      }
    },
    [defaultNostrRelays, ensureNostrIdentity, ensureNostrPool, paymentRequestsEnabled, safePublish],
  );

  const loadStoredOpenPaymentRequest = useCallback((): ActivePaymentRequest | null => {
    if (!mintUrl) return null;
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_ECASH_OPEN_REQUESTS);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, any>;
      if (!parsed || typeof parsed !== "object") return null;
      const normalizedMint = normalizeMintUrl(mintUrl);
      const entry = parsed[normalizedMint];
      if (!entry || typeof entry.encoded !== "string") return null;
      let request: PaymentRequest;
      try {
        request = PaymentRequest.fromEncodedRequest(entry.encoded);
      } catch (err) {
        console.warn("Stored payment request invalid", err);
        return null;
      }
      if (request.singleUse) return null;
      if (Array.isArray(request.mints) && request.mints.length) {
        // Stored multi-use requests used to be tied to a specific mint. Regenerate
        // them so new links accept payments from any mint.
        return null;
      }
      const active: ActivePaymentRequest = {
        id: typeof entry.id === "string" && entry.id ? entry.id : request.id || normalizedMint,
        encoded: entry.encoded,
        request,
        amountSat:
          typeof entry.amountSat === "number" && Number.isFinite(entry.amountSat)
            ? entry.amountSat
            : typeof request.amount === "number"
              ? request.amount
              : undefined,
        lockPubkey:
          typeof entry.lockPubkey === "string" && entry.lockPubkey
            ? entry.lockPubkey
            : (request.nut10?.d as string | undefined) || null,
      };
      return active;
    } catch (err) {
      console.warn("Failed to load stored eCash payment request", err);
      return null;
    }
  }, [mintUrl]);

  useEffect(() => {
    if (!mintUrl) {
      setOpenPaymentRequest(null);
      if (currentPaymentRequest && !currentPaymentRequest.request.singleUse) {
        setCurrentPaymentRequest(null);
        setPaymentRequestStatusMessage("");
      }
      return;
    }
    const normalizedMint = normalizeMintUrl(mintUrl);
    const restrictsMint =
      !!openPaymentRequest?.request?.mints && openPaymentRequest.request.mints.length > 0;
    const openMatches =
      !!openPaymentRequest &&
      (!restrictsMint ||
        openPaymentRequest.request.mints?.some((m) => normalizeMintUrl(String(m)) === normalizedMint) === true);
    if (!openMatches || restrictsMint) {
      setOpenPaymentRequest(null);
    }
    const stored = loadStoredOpenPaymentRequest();
    if (stored) {
      if (!isSamePaymentRequest(openPaymentRequest, stored)) {
        setOpenPaymentRequest(stored);
      }
      if (!currentPaymentRequest || !currentPaymentRequest.request.singleUse) {
        if (!isSamePaymentRequest(currentPaymentRequest, stored)) {
          setCurrentPaymentRequest(stored);
        }
        setPaymentRequestStatusMessage("");
      }
    } else if (!openMatches && (!currentPaymentRequest || !currentPaymentRequest.request.singleUse)) {
      if (currentPaymentRequest) {
        setCurrentPaymentRequest(null);
      }
      setPaymentRequestStatusMessage("");
    }
  }, [mintUrl, loadStoredOpenPaymentRequest, currentPaymentRequest, openPaymentRequest]);

  const persistOpenPaymentRequest = useCallback(
    (request: ActivePaymentRequest | null) => {
      if (!mintUrl) return;
      const normalizedMint = normalizeMintUrl(mintUrl);
      try {
        const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, LS_ECASH_OPEN_REQUESTS);
        let parsed: Record<string, any> = {};
        if (raw) {
          try {
            parsed = JSON.parse(raw) as Record<string, any>;
            if (!parsed || typeof parsed !== "object") {
              parsed = {};
            }
          } catch {
            parsed = {};
          }
        }
        if (request && !request.request.singleUse) {
          parsed[normalizedMint] = {
            id: request.id,
            encoded: request.encoded,
            amountSat: request.amountSat ?? null,
            lockPubkey: request.lockPubkey ?? null,
            singleUse: false,
            updatedAt: Date.now(),
          };
        } else {
          delete parsed[normalizedMint];
        }
        idbKeyValue.setItem(TASKIFY_STORE_WALLET, LS_ECASH_OPEN_REQUESTS, JSON.stringify(parsed));
      } catch (err) {
        console.warn("Failed to persist eCash payment request", err);
      }
    },
    [mintUrl],
  );

  const createPaymentRequest = useCallback(
    async (
      amountInputRaw: string,
      options?: {
        forceNew?: boolean;
        lockEnabled?: boolean;
        lockPubkey?: string | null;
        mode?: "single" | "multi";
        persistOpen?: boolean;
      },
    ) => {
      if (!paymentRequestsEnabled) return null;
      setPaymentRequestError("");
      setPaymentRequestStatusMessage("");
      try {
        if (!mintUrl) {
          throw new Error("Set an active mint first");
        }
        if (!info?.unit) {
          throw new Error("Mint info unavailable. Try switching mints.");
        }
        const identity = ensureNostrIdentity();
        if (!identity) {
          throw new Error(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr.");
        }
        const amountInput = amountInputRaw.trim();
        let amountSat: number | undefined;
        if (amountInput) {
          const { sats, error } = parseAmountInput(amountInputRaw);
          if (error) throw new Error(error);
          if (!sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
          amountSat = sats;
        }
        const lockEnabled = options?.lockEnabled ?? paymentRequestLockEnabled;
        let resolvedLockPubkey = options?.lockPubkey ?? paymentRequestLockPubkey ?? "";
        if (lockEnabled && !resolvedLockPubkey && activeP2pkKey?.publicKey) {
          resolvedLockPubkey = activeP2pkKey.publicKey;
        }
        const wantsLock = lockEnabled && !!resolvedLockPubkey;
        if (lockEnabled && !resolvedLockPubkey) {
          throw new Error("Add a P2PK locking key first.");
        }
        const requestMode = options?.mode;
        const persistOpen = options?.persistOpen ?? true;
        const wantsSingleUse =
          requestMode === "single"
            ? true
            : requestMode === "multi"
            ? wantsLock
            : !!amountSat || wantsLock;
        if (!wantsSingleUse && !options?.forceNew) {
          const existing =
            openPaymentRequest && !openPaymentRequest.request.singleUse
              ? openPaymentRequest
              : loadStoredOpenPaymentRequest();
          if (existing) {
            setOpenPaymentRequest(existing);
            setCurrentPaymentRequest(existing);
            setPaymentRequestStatusMessage("");
            return existing;
          }
        }
        const transport: PaymentRequestTransport = {
          type: PaymentRequestTransportType.NOSTR,
          target: nip19.nprofileEncode({ pubkey: identity.pubkey, relays: defaultNostrRelays }),
          tags: [["n", "17"]],
        };
        const rawId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const requestId = rawId.slice(0, 16);
        const unit = (info?.unit || "sat").toLowerCase();
        const nut10Option = wantsLock
          ? ({
              kind: "P2PK",
              data: resolvedLockPubkey,
              tags: [["sigflag", "SIG_INPUTS"]],
            } as NonNullable<PaymentRequest["nut10"]>)
          : undefined;
        const request = new PaymentRequest(
          [transport],
          requestId,
          amountSat,
          unit,
          undefined,
          undefined,
          wantsSingleUse,
          nut10Option,
        );
        const encoded = request.toEncodedRequest();
        const nextRequest: ActivePaymentRequest = {
          id: requestId,
          encoded,
          request,
          amountSat,
          lockPubkey: wantsLock ? resolvedLockPubkey : null,
        };
        if (!wantsSingleUse && persistOpen) {
          setOpenPaymentRequest(nextRequest);
          persistOpenPaymentRequest(nextRequest);
        }
        setCurrentPaymentRequest(nextRequest);
        setPaymentRequestStatusMessage("");
        return nextRequest;
      } catch (err: any) {
        setPaymentRequestError(err?.message || String(err));
        return null;
      }
    }, [
      paymentRequestsEnabled,
      mintUrl,
      info?.unit,
      ensureNostrIdentity,
      nostrMissingReason,
      parseAmountInput,
      amountInputUnitLabel,
      paymentRequestLockEnabled,
      paymentRequestLockPubkey,
      activeP2pkKey,
      defaultNostrRelays,
      openPaymentRequest,
      loadStoredOpenPaymentRequest,
      persistOpenPaymentRequest,
    ]);

  const handleCreateEcashRequest = useCallback(async () => {
    const trimmedAmount = ecashRequestAmt.trim();
    let amountInput = trimmedAmount;
    let persistOpen = ecashRequestMode === "multi";
    if (ecashRequestMode === "multi") {
      const isOpenAmount =
        !trimmedAmount || parsedEcashRequestAmount.error || parsedEcashRequestAmount.sats === 0;
      if (isOpenAmount) {
        amountInput = "";
      } else {
        persistOpen = false;
      }
    } else {
      persistOpen = false;
    }
    const created = await createPaymentRequest(amountInput, {
      forceNew: true,
      mode: ecashRequestMode,
      persistOpen,
    });
    if (created) {
      setLastCreatedEcashRequest(created);
      setEcashReceiveView("request");
      if (ecashRequestMode === "single") {
        setEcashRequestAmt("");
      }
      setRecvMsg("");
    }
  }, [
    createPaymentRequest,
    ecashRequestAmt,
    ecashRequestMode,
    parsedEcashRequestAmount,
  ]);

  const ensureOpenPaymentRequest = useCallback(async () => {
    if (!paymentRequestsEnabled || !mintUrl || nostrMissingReason) return null;
    if (openPaymentRequest && !openPaymentRequest.request.singleUse) {
      if (!currentPaymentRequest || !currentPaymentRequest.request.singleUse) {
        if (!isSamePaymentRequest(currentPaymentRequest, openPaymentRequest)) {
          setCurrentPaymentRequest(openPaymentRequest);
        }
        setPaymentRequestStatusMessage("");
      }
      return openPaymentRequest;
    }
    const stored = loadStoredOpenPaymentRequest();
    if (stored) {
      if (!isSamePaymentRequest(openPaymentRequest, stored)) {
        setOpenPaymentRequest(stored);
      }
      if (!currentPaymentRequest || !currentPaymentRequest.request.singleUse) {
        if (!isSamePaymentRequest(currentPaymentRequest, stored)) {
          setCurrentPaymentRequest(stored);
        }
        setPaymentRequestStatusMessage("");
      }
      return stored;
    }
    const created = await createPaymentRequest("", { forceNew: true });
    if (created && !created.request.singleUse) {
      return created;
    }
    return null;
  }, [
    paymentRequestsEnabled,
    mintUrl,
    nostrMissingReason,
    openPaymentRequest,
    currentPaymentRequest,
    loadStoredOpenPaymentRequest,
    createPaymentRequest,
  ]);

  const readNip51ContactsMigrated = useCallback((): boolean => {
    try {
      return idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_NIP51_CONTACTS_MIGRATED) === "true";
    } catch {
      return false;
    }
  }, []);

  const persistNip51ContactsMigrated = useCallback((value: boolean) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_NIP51_CONTACTS_MIGRATED, value ? "true" : "false");
    } catch {
      // ignore persistence issues
    }
  }, []);

  const contactPubkeyKey = useCallback(
    (npub: string | null | undefined): string | null => {
      const normalized = normalizeNostrPubkey(npub || "");
      if (!normalized) return null;
      return compressedToRawHex(normalized).toLowerCase();
    },
    [compressedToRawHex, normalizeNostrPubkey],
  );

  const mergeContactsByPubkey = useCallback(
    (base: Contact[], incoming: Contact[]): Contact[] => {
      const next = [...base];
      const seen = new Set<string>();
      base.forEach((contact) => {
        const key = contactPubkeyKey(contact.npub);
        if (key) seen.add(key);
      });
      incoming.forEach((contact) => {
        const key = contactPubkeyKey(contact.npub);
        if (!key || seen.has(key)) return;
        seen.add(key);
        next.push(contact);
      });
      return next;
    },
    [contactPubkeyKey],
  );

  const buildContactSyncEnvelopeFromNip51 = useCallback(
    (privateContacts: Nip51PrivateContact[], updatedAt: number): ContactSyncEnvelope => {
      return {
        version: 1,
        updatedAt,
        contacts: (privateContacts || []).map((contact) => ({
          id: makeContactId(),
          kind: "nostr",
          npub: formatContactNpub(contact.pubkey),
          relays: contact.relayHint ? [contact.relayHint] : undefined,
          name: contact.petname || undefined,
        })),
      };
    },
    [formatContactNpub, makeContactId],
  );

  const loadLegacyContacts = useCallback(
    async (identity: NostrIdentity, relays: string[]): Promise<Contact[]> => {
      const localContacts = loadContactsFromStorage().filter((contact) => contactHasNpub(contact));
      let legacyFromEvent: Contact[] = [];
      if (nip44?.v2) {
        try {
          const pool = ensureNostrPool();
          const legacyEvent = await pool.get(relays, { kinds: [3], authors: [identity.pubkey] });
          if (legacyEvent?.content?.trim()) {
            const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(identity.secret), identity.pubkey);
            const plaintext = await nip44.v2.decrypt(legacyEvent.content, conversationKey);
            const parsed = parseContactSyncEnvelope(JSON.parse(plaintext));
            if (parsed) {
              legacyFromEvent = mergeContactsFromSync([], parsed).filter((contact) => contactHasNpub(contact));
            }
          }
        } catch (err) {
          if (walletDebugEnabled) {
            console.warn("[wallet] Failed to read legacy contacts payload", err);
          }
        }
      }
      return mergeContactsByPubkey(localContacts, legacyFromEvent);
    },
    [
      contactHasNpub,
      ensureNostrPool,
      loadContactsFromStorage,
      mergeContactsByPubkey,
      mergeContactsFromSync,
      parseContactSyncEnvelope,
      walletDebugEnabled,
    ],
  );

  const migrateNip51ContactsIfNeeded = useCallback(
    async (options?: { silent?: boolean }) => {
      if (nip51MigrationInFlightRef.current) return;
      if (readNip51ContactsMigrated()) return;
      if (!contactsSyncEnabled) return;
      const identity = ensureNostrIdentity();
      if (!identity) return;
      if (!nip44?.v2) return;
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) return;

      nip51MigrationInFlightRef.current = true;
      try {
        const legacyContacts = await loadLegacyContacts(identity, relays);
        if (!legacyContacts.length) {
          persistNip51ContactsMigrated(true);
          if (walletDebugEnabled) {
            console.debug("[wallet] NIP-51 migration: no legacy contacts to migrate");
          }
          return;
        }
        const merged = mergeContactsByPubkey(contactsRef.current, legacyContacts);
        if (merged.length !== contactsRef.current.length) {
          setContacts(merged);
          saveContactsToStorage(merged);
          contactsRef.current = merged;
        }

        const pool = ensureNostrPool();
        const nip51Event = await publishNip51PrivateContactsList(pool, relays, merged, {
          privateKeyHex: identity.secret,
          publicKeyHex: identity.pubkey,
        });
        const updatedAt = nip51Event.created_at ? nip51Event.created_at * 1000 : Date.now();
        const fingerprint = computeContactsFingerprint(merged);
        contactsFingerprintRef.current = fingerprint;
        persistContactSyncMeta({
          lastEventId: nip51Event.id,
          lastUpdatedAt: updatedAt,
          fingerprint,
          publicFollows: contactSyncMetaRef.current.publicFollows,
        });
        persistNip51ContactsMigrated(true);
        if (!options?.silent) {
          setContactSyncState({
            status: "success",
            message: "Contacts migrated to NIP-51",
            updatedAt,
          });
        }
        if (walletDebugEnabled) {
          console.debug("[wallet] NIP-51 migration published", nip51Event.id.slice(0, 8));
        }
      } catch (err: any) {
        if (!options?.silent) {
          setContactSyncState((prev) => ({
            status: "error",
            message: err?.message || "Unable to migrate legacy contacts.",
            updatedAt: prev.updatedAt ?? null,
          }));
        }
        if (walletDebugEnabled) {
          console.warn("[wallet] NIP-51 migration failed", err);
        }
      } finally {
        nip51MigrationInFlightRef.current = false;
      }
    },
    [
      computeContactsFingerprint,
      contactSyncMetaRef,
      contactsRef,
      contactsSyncEnabled,
      defaultNostrRelays,
      ensureNostrIdentity,
      ensureNostrPool,
      loadLegacyContacts,
      mergeContactsByPubkey,
      publishNip51PrivateContactsList,
      persistContactSyncMeta,
      persistNip51ContactsMigrated,
      readNip51ContactsMigrated,
      saveContactsToStorage,
      setContacts,
      walletDebugEnabled,
    ],
  );

  const syncContactsFromNostr = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!contactsSyncEnabled) {
        contactsPublishQueuedRef.current = false;
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: "Contact sync is disabled in Settings.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      const identity = ensureNostrIdentity();
      if (!identity) {
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr to sync contacts.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      if (!nip44?.v2) {
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: "NIP-44 v2 support is required to read contacts.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) {
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: "Add at least one relay to sync contacts.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      if (!silent) {
        setContactSyncState({
          status: "loading",
          message: "Syncing contacts…",
          updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
        });
      }
      try {
        await migrateNip51ContactsIfNeeded({ silent: true });
        const pool = ensureNostrPool();
        const [publicEvent, privateResult] = await Promise.all([
          pool.get(relays, { kinds: [3], authors: [identity.pubkey] }),
          fetchLatestPrivateContactsList(pool, relays, identity.pubkey, {
            privateKeyHex: identity.secret,
            publicKeyHex: identity.pubkey,
          }),
        ]);

        let publicFollows = contactSyncMeta.publicFollows ?? [];
        if (publicEvent) {
          const existingFollowsByKey = new Map(
            (contactSyncMeta.publicFollows || []).map((follow) => [follow.pubkey.toLowerCase(), follow]),
          );
          const publicFollowsFromTags = extractPublicFollowsFromTags(publicEvent.tags).map((follow) => {
            const existing = existingFollowsByKey.get(follow.pubkey.toLowerCase());
            if (!existing) return follow;
            return { ...existing, ...follow };
          });
          publicFollows = await enrichPublicFollowsWithProfiles(publicFollowsFromTags, relays, pool);
          persistContactSyncMeta({ publicFollows });
        }

        if (!privateResult.event) {
          if (!silent) {
            setContactSyncState({
              status: "idle",
              message: "No private contacts found on relays yet.",
              updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
            });
          }
          return;
        }

        const updatedAt = privateResult.event.created_at ? privateResult.event.created_at * 1000 : Date.now();
        const envelope = buildContactSyncEnvelopeFromNip51(privateResult.contacts, updatedAt);
        const merged = mergeContactsFromSync(contactsRef.current, envelope);
        setContacts(merged);
        saveContactsToStorage(merged);
        const fingerprint = computeContactsFingerprint(merged);
        contactsFingerprintRef.current = fingerprint;
        persistContactSyncMeta({
          lastEventId: privateResult.event.id,
          lastUpdatedAt: updatedAt,
          fingerprint,
          publicFollows,
        });
        contactsPublishQueuedRef.current = false;
        setContactSyncState({
          status: "success",
          message: `Synced ${envelope.contacts.length} contact${envelope.contacts.length === 1 ? "" : "s"}`,
          updatedAt,
        });
      } catch (err: any) {
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: err?.message || "Failed to sync contacts.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
      }
    },
    [
      contactsSyncEnabled,
      contactSyncMeta.lastUpdatedAt,
      contactSyncMeta.publicFollows,
      contactsRef,
      buildContactSyncEnvelopeFromNip51,
      fetchLatestPrivateContactsList,
      migrateNip51ContactsIfNeeded,
      defaultNostrRelays,
      ensureNostrIdentity,
      ensureNostrPool,
      nostrMissingReason,
      persistContactSyncMeta,
      setContacts,
      saveContactsToStorage,
      mergeContactsFromSync,
      computeContactsFingerprint,
    ],
  );

  const publishContactsToNostr = useCallback(
    async (options?: { silent?: boolean; publicFollowsOverride?: PublicFollow[] }) => {
      const silent = options?.silent === true;
      const meta = contactSyncMetaRef.current;
      if (!contactsSyncEnabled) {
        contactsPublishQueuedRef.current = false;
        setContactsPublishState("idle");
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: "Contact sync is disabled in Settings.",
            updatedAt: meta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      const identity = ensureNostrIdentity();
      if (!identity) {
        if (!silent) {
          setContactsPublishState("error");
          setContactsPublishMessage(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr to sync contacts.");
        }
        return;
      }
      if (!nip44?.v2) {
        setContactsPublishState("error");
        setContactsPublishMessage("NIP-44 v2 support is required to encrypt contacts.");
        return;
      }
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) {
        setContactsPublishState("error");
        setContactsPublishMessage("Add at least one relay to sync contacts.");
        return;
      }
      const fingerprint = computeContactsFingerprint(contactsRef.current);
      contactsFingerprintRef.current = fingerprint;
      const publicFollows = options?.publicFollowsOverride ?? meta.publicFollows ?? [];
      const shouldPublishPrivateList = !(meta.fingerprint && meta.lastUpdatedAt && meta.fingerprint === fingerprint);
      const shouldPublishPublicFollows = options?.publicFollowsOverride !== undefined || shouldPublishPrivateList;
      if (!shouldPublishPrivateList && !shouldPublishPublicFollows) {
        setContactsPublishState("success");
        setContactsPublishMessage("Contacts already synced");
        if (!silent) {
          setContactSyncState({
            status: "success",
            message: "Contacts already synced",
            updatedAt: meta.lastUpdatedAt,
          });
        }
        contactsPublishQueuedRef.current = false;
        return;
      }
      const updatedAt = Date.now();
      const publicFollowTags = publicFollows
        .map((follow) => {
          const pubkey = (follow.pubkey || "").trim();
          if (!pubkey) return null;
          const relay = (follow.relay || "").trim();
          const petname = (follow.petname || "").trim();
          const tag: string[] = ["p", pubkey];
          if (relay || petname) {
            tag.push(relay);
          }
          if (petname) {
            if (!relay) {
              tag.push("");
            }
            tag.push(petname);
          }
          return tag;
        })
        .filter(Boolean) as string[][];
      try {
        setContactsPublishState("publishing");
        setContactsPublishMessage("");
        const pool = ensureNostrPool();
        const createdAt = Math.floor(updatedAt / 1000);
        let nip51Event: { id: string; created_at?: number } | null = null;
        if (shouldPublishPrivateList) {
          nip51Event = await publishNip51PrivateContactsList(pool, relays, contactsRef.current, {
            privateKeyHex: identity.secret,
            publicKeyHex: identity.pubkey,
          }, {
            createdAt,
          });
          if (walletDebugEnabled) {
            console.debug("[wallet] Published NIP-51 contacts list", nip51Event.id.slice(0, 8));
          }
        }
        if (shouldPublishPublicFollows) {
          const template: EventTemplate = {
            kind: 3,
            content: "",
            tags: publicFollowTags,
            created_at: createdAt,
          };
          if (template.content !== "") {
            throw new Error("Kind:3 content must be empty.");
          }
          const signed = finalizeEvent(template, hexToBytes(identity.secret));
          await safePublish(pool, relays, signed);
          if (walletDebugEnabled) {
            console.debug("[wallet] Published kind:3 follows", signed.id.slice(0, 8));
          }
        }
        if (shouldPublishPrivateList && nip51Event) {
          const publishedAt = nip51Event.created_at ? nip51Event.created_at * 1000 : updatedAt;
          persistContactSyncMeta({
            lastEventId: nip51Event.id,
            lastUpdatedAt: publishedAt,
            fingerprint,
            publicFollows,
          });
          setContactSyncState({
            status: "success",
            message: "Contacts synced",
            updatedAt: publishedAt,
          });
        } else {
          persistContactSyncMeta({ publicFollows });
          if (!silent) {
            setContactSyncState({
              status: "success",
              message: "Public follows synced",
              updatedAt: meta.lastUpdatedAt ?? null,
            });
          }
        }
        setContactsPublishState("success");
        setContactsPublishMessage("Contacts synced to relays");
        contactsPublishQueuedRef.current = false;
      } catch (err: any) {
        const message = err?.message || "Unable to sync contacts.";
        setContactsPublishState("error");
        setContactsPublishMessage(message);
        if (!silent) {
          setContactSyncState((prev) => ({
            status: "error",
            message,
            updatedAt: prev.updatedAt ?? null,
          }));
        }
        contactsPublishQueuedRef.current = false;
      }
    },
    [
      contactsSyncEnabled,
      contactsRef,
      defaultNostrRelays,
      ensureNostrIdentity,
      ensureNostrPool,
      contactSyncMetaRef,
      computeContactsFingerprint,
      nostrMissingReason,
      persistContactSyncMeta,
      safePublish,
      walletDebugEnabled,
      publishNip51PrivateContactsList,
    ],
  );

  const applyContactProfileUpdates = useCallback(
    (
      profilesByHex: Map<string, CachedContactProfile>,
      options?: { persistCache?: boolean; existingCache?: Record<string, CachedContactProfile> },
    ) => {
      if (!profilesByHex.size) return;
      setContacts((prev) => {
        let changed = false;
        const next = prev.map((contact) => {
          const normalizedNpub = normalizeNostrPubkey(contact.npub || "");
          const hex = normalizedNpub ? compressedToRawHex(normalizedNpub).toLowerCase() : null;
          if (!hex) return contact;
          const incoming = profilesByHex.get(hex);
          if (!incoming) return contact;
          const baseline = contact.updatedAt ?? contact.createdAt ?? 0;
          const isNewer = incoming.updatedAt > baseline;
          const fillMissing =
            !contact.picture ||
            !contact.displayName ||
            !contact.username ||
            !contact.address ||
            !contact.nip05 ||
            !contact.about ||
            !contact.name;
          if (!isNewer && !fillMissing) return contact;
          const { profile, updatedAt, pictureDataUrl } = incoming;
          let updatedContact = contact;
          let localChanged = false;
          const preferProfileName = contact.source !== "manual" || !contact.name?.trim();
          const nextName = profile.displayName || profile.username || contact.name;
          if (preferProfileName && nextName && nextName !== contact.name) {
            updatedContact = { ...updatedContact, name: nextName };
            localChanged = true;
          }
          const maybeUpdate = <K extends keyof Contact>(key: K, value: Contact[K] | undefined) => {
            if (!value) return;
            const current = updatedContact[key];
            const shouldUpdate = isNewer || !current || (typeof current === "string" && current.trim() === "");
            if (shouldUpdate && value !== current) {
              updatedContact = { ...updatedContact, [key]: value };
              localChanged = true;
            }
          };
          maybeUpdate("displayName", profile.displayName);
          maybeUpdate(
            "username",
            profile.username ? (sanitizeUsername(profile.username) as Contact["username"]) : updatedContact.username,
          );
          maybeUpdate("address", profile.lud16 as Contact["address"] | undefined);
          maybeUpdate("nip05", profile.nip05 as Contact["nip05"] | undefined);
          maybeUpdate("about", profile.about as Contact["about"] | undefined);
          const nextPictureRaw = typeof profile.picture === "string" ? profile.picture.trim() : "";
          const nextPicture = (pictureDataUrl || nextPictureRaw).trim();
          if (nextPicture && nextPicture !== (updatedContact.picture || "").trim()) {
            updatedContact = { ...updatedContact, picture: nextPicture };
            localChanged = true;
          }
          if (!localChanged) return contact;
          changed = true;
          return { ...updatedContact, updatedAt: isNewer ? updatedAt : baseline };
        });
        return changed ? next : prev;
      });
      if (options?.persistCache) {
        const nextCache = { ...(options.existingCache || {}) };
        profilesByHex.forEach(({ profile, updatedAt, pictureDataUrl }, hex) => {
          const existing = nextCache[hex];
          if (!existing || updatedAt > (existing.updatedAt ?? 0)) {
            nextCache[hex] = { profile, updatedAt, pictureDataUrl };
          } else if (pictureDataUrl && !existing.pictureDataUrl) {
            nextCache[hex] = { ...existing, pictureDataUrl };
          }
        });
        persistContactProfileCache(nextCache);
      }
    },
    [compressedToRawHex, normalizeNostrPubkey, sanitizeUsername],
  );

  const refreshContactProfiles = useCallback(async () => {
    const contactsList = contactsRef.current;
    if (!contactsList.length) return;

    const cachedProfiles = loadContactProfileCache();
    const cachedProfilesByHex = new Map<string, CachedContactProfile>();
    Object.entries(cachedProfiles).forEach(([hex, entry]) => {
      if (!hex || !entry?.profile) return;
      cachedProfilesByHex.set(hex.toLowerCase(), {
        profile: entry.profile,
        updatedAt: entry.updatedAt || 0,
        pictureDataUrl: entry.pictureDataUrl,
      });
    });
    if (cachedProfilesByHex.size) {
      applyContactProfileUpdates(cachedProfilesByHex);
    }

    const authorHexes: string[] = [];
    const seenAuthors = new Set<string>();
    const relays = new Set(
      defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter((url): url is string => !!url),
    );
    contactsList.forEach((contact) => {
      const normalizedNpub = normalizeNostrPubkey(contact.npub);
      if (!normalizedNpub) return;
      const authorHex = compressedToRawHex(normalizedNpub).toLowerCase();
      if (!authorHex) return;
      if (!seenAuthors.has(authorHex)) {
        seenAuthors.add(authorHex);
        authorHexes.push(authorHex);
      }
      if (Array.isArray(contact.relays)) {
        contact.relays.forEach((relay) => {
          const trimmed = typeof relay === "string" ? relay.trim() : "";
          if (trimmed) {
            relays.add(trimmed);
          }
        });
      }
    });
    if (!authorHexes.length) return;
    const relayList = Array.from(relays);
    if (!relayList.length) return;
    try {
      const pool = ensureNostrPool();
      const events = await pool
        .querySync(relayList, { kinds: [0], authors: authorHexes })
        .then((res) => (Array.isArray(res) ? res : []))
        .catch(() => []);
      if (!events.length) return;
      const profilesByHex = new Map<string, CachedContactProfile>();
      const photoCacheTasks: Promise<void>[] = [];
      events.forEach((event) => {
        if (!event?.pubkey || typeof event.content !== "string") return;
        const hex = compressedToRawHex(event.pubkey).toLowerCase();
        if (!hex) return;
        const updatedAt = event.created_at ? event.created_at * 1000 : Date.now();
        const existing = profilesByHex.get(hex);
        if (existing && existing.updatedAt >= updatedAt) return;
        const profile = parseProfileContent(event.content);
        const cachedProfile = cachedProfiles[hex];
        const entry: CachedContactProfile = { profile, updatedAt };
        const pictureUrl = typeof profile.picture === "string" ? profile.picture.trim() : "";
        const cachedPictureUrl = typeof cachedProfile?.profile?.picture === "string"
          ? cachedProfile.profile.picture.trim()
          : "";
        if (pictureUrl) {
          if (isDataUrl(pictureUrl)) {
            entry.pictureDataUrl = pictureUrl;
          } else if (cachedProfile?.pictureDataUrl && pictureUrl === cachedPictureUrl) {
            entry.pictureDataUrl = cachedProfile.pictureDataUrl;
          } else if (shouldCacheProfilePhoto(pictureUrl)) {
            photoCacheTasks.push(
              fetchProfilePhotoDataUrl(pictureUrl).then((dataUrl) => {
                if (!dataUrl) return;
                const current = profilesByHex.get(hex);
                if (current && current.updatedAt === updatedAt) {
                  profilesByHex.set(hex, { ...current, pictureDataUrl: dataUrl });
                }
              }),
            );
          }
        }
        profilesByHex.set(hex, entry);
      });
      if (photoCacheTasks.length) {
        await Promise.allSettled(photoCacheTasks);
      }
      if (!profilesByHex.size) return;
      applyContactProfileUpdates(profilesByHex, { persistCache: true, existingCache: cachedProfiles });
    } catch (err) {
      console.warn("Failed to refresh contact profiles", err);
    }
  }, [
    applyContactProfileUpdates,
    compressedToRawHex,
    contactsRef,
    defaultNostrRelays,
    ensureNostrPool,
    normalizeNostrPubkey,
    parseProfileContent,
  ]);

  const publishProfileMetadata = useCallback(
    async (draft?: Partial<ContactProfile>) => {
      if (!contactsSyncEnabled) {
        setProfileStatus("error");
        setProfileMessage("Contact sync is disabled in Settings.");
        return null;
      }
      const identity = ensureNostrIdentity();
      if (!identity) {
        setProfileStatus("error");
        setProfileMessage(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr.");
        return null;
      }
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) {
        setProfileStatus("error");
        setProfileMessage("Add at least one relay to publish your profile.");
        return null;
      }
      if (!profileEventIdRef.current) {
        profileEventIdRef.current = readProfileEventId(identity.pubkey);
      }
      const currentProfile = profileFormRef.current;
      const username = (draft?.username ?? currentProfile.username ?? "").trim();
      const displayName = (draft?.displayName ?? currentProfile.displayName ?? "").trim();
      const lud16 = (draft?.lud16 ?? currentProfile.lud16 ?? "").trim();
      const nip05 = (draft?.nip05 ?? currentProfile.nip05 ?? "").trim();
      const about = (draft?.about ?? currentProfile.about ?? "").trim();
      const hasDraftPicture = draft && "picture" in draft;
      const picture = (hasDraftPicture ? draft?.picture ?? "" : currentProfile.picture ?? "").trim();
      if (picture && isDataUrl(picture)) {
        setProfilePhotoError("Upload your profile photo before publishing.");
        setProfileStatus("error");
        setProfileMessage("Upload your profile photo before publishing.");
        return null;
      }
      try {
        setProfileStatus("publishing");
        setProfileMessage("");
        const result = await publishMyProfile(
          { username, displayName, lud16, nip05, about, picture },
          {
            signer: identity.secret,
            pubkey: identity.pubkey,
            relays,
            previousIdHint: profileEventIdRef.current,
            reason: "superseded profile metadata",
          },
        );
        const event = result.event;
        const updatedAt = event?.created_at ? event.created_at * 1000 : Date.now();
        profileEventIdRef.current = event.id || null;
        persistProfileEventId(identity.pubkey, event.id || null);
        const nextProfile = { username, displayName, lud16, nip05, about, picture };
        persistProfileMetadataCache(identity.pubkey, {
          profile: nextProfile,
          updatedAt,
          eventId: event.id || null,
        });
        setProfileForm(nextProfile);
        setProfileUpdatedAt(updatedAt);
        setProfileStatus("ready");
        setProfileMessage("Profile saved");
        setProfileSharePayload(formatNpub(identity.pubkey));
        return event;
      } catch (err: any) {
        setProfileStatus("error");
        setProfileMessage(err?.message || "Unable to publish profile.");
        console.warn("[profile] Unable to publish profile metadata", err);
        return null;
      }
    },
    [
      contactsSyncEnabled,
      defaultNostrRelays,
      ensureNostrIdentity,
      formatNpub,
      nostrMissingReason,
      persistProfileEventId,
      persistProfileMetadataCache,
      readProfileEventId,
      setProfilePhotoError,
    ],
  );

  const loadProfileMetadata = useCallback(
    async () => {
      if (!contactsSyncEnabled) {
        setProfileStatus("error");
        setProfileMessage("Contact sync is disabled in Settings.");
        return null;
      }
      const identity = ensureNostrIdentity();
      if (!identity) {
        setProfileStatus("error");
        setProfileMessage(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr.");
        return null;
      }
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) {
        setProfileStatus("error");
        setProfileMessage("Add at least one relay to load your profile.");
        return null;
      }
      if (!profileEventIdRef.current) {
        profileEventIdRef.current = readProfileEventId(identity.pubkey);
      }
      const cached = readProfileMetadataCache(identity.pubkey);
      if (cached?.eventId && !profileEventIdRef.current) {
        profileEventIdRef.current = cached.eventId;
        persistProfileEventId(identity.pubkey, cached.eventId);
      }
      if (cached?.profile) {
        setProfileForm(cached.profile);
        setProfileSharePayload(identity ? formatNpub(identity.pubkey) : null);
        setProfileUpdatedAt(cached.updatedAt ?? null);
        setProfileStatus((prev) => (prev === "publishing" ? prev : "ready"));
        setProfileMessage("Refreshing profile…");
      } else {
        setProfileStatus("loading");
        setProfileMessage("Loading profile…");
      }
      try {
        const event = await loadMyLatestProfileEvent(identity.pubkey, relays, { timeoutMs: 8000 });
        if (event && typeof event.content === "string") {
          const meta = parseProfileContent(event.content);
          const updatedAt = event.created_at ? event.created_at * 1000 : Date.now();
          profileEventIdRef.current = event.id || null;
          persistProfileEventId(identity.pubkey, event.id || null);
          const nextProfile = {
            username: meta.username || profileFormRef.current.username || "",
            displayName: meta.displayName || meta.username || profileFormRef.current.displayName || "",
            lud16: meta.lud16 || profileFormRef.current.lud16 || deriveDefaultLightningAddress(),
            nip05: meta.nip05 || profileFormRef.current.nip05 || "",
            about: meta.about || profileFormRef.current.about || "",
            picture: meta.picture || profileFormRef.current.picture || "",
          };
          setProfileForm(nextProfile);
          setProfileSharePayload(identity ? formatNpub(identity.pubkey) : null);
          setProfileUpdatedAt(updatedAt);
          persistProfileMetadataCache(identity.pubkey, {
            profile: nextProfile,
            updatedAt,
            eventId: event.id || null,
          });
          setProfileStatus("ready");
          setProfileMessage("Profile loaded");
          return meta;
        }
        setProfileStatus("ready");
        setProfileMessage("No profile metadata found yet.");
        return null;
      } catch (err: any) {
        setProfileStatus("error");
        setProfileMessage(err?.message || "Unable to load profile.");
        return null;
      }
    },
    [
      contactsSyncEnabled,
      defaultNostrRelays,
      deriveDefaultLightningAddress,
      ensureNostrIdentity,
      formatNpub,
      nostrMissingReason,
      parseProfileContent,
      persistProfileMetadataCache,
      persistProfileEventId,
      readProfileMetadataCache,
      readProfileEventId,
    ],
  );

  useEffect(() => {
    if (!paymentRequestsEnabled) return;
    if (receiveMode !== "ecash") return;
    if (nostrMissingReason) return;
    void ensureOpenPaymentRequest();
  }, [paymentRequestsEnabled, receiveMode, nostrMissingReason, ensureOpenPaymentRequest]);

  useEffect(() => {
    if (!paymentRequestsEnabled) return;
    if (sendMode !== "ecash") return;
    if (nostrMissingReason) return;
    void ensureOpenPaymentRequest();
  }, [paymentRequestsEnabled, sendMode, nostrMissingReason, ensureOpenPaymentRequest]);

  useEffect(() => {
    if (!paymentRequestsEnabled) return;
    if (!mintUrl) return;
    setPaymentRequestStatusMessage((prev) => {
      if (!info?.unit) {
        return prev || "Loading mint info…";
      }
      return prev === "Loading mint info…" ? "" : prev;
    });
  }, [paymentRequestsEnabled, mintUrl, info?.unit]);

  useEffect(() => {
    if (!contactsSyncEnabled) {
      contactsPublishQueuedRef.current = false;
      return;
    }
    const fingerprint = computeContactsFingerprint(contacts);
    contactsFingerprintRef.current = fingerprint;
    if (!contacts.length && !contactSyncMeta.fingerprint) {
      contactsPublishQueuedRef.current = false;
      return;
    }
    if (contactSyncMeta.fingerprint && contactSyncMeta.fingerprint === fingerprint) {
      if (contactsPublishState !== "publishing") {
        contactsPublishQueuedRef.current = false;
      }
      return;
    }
    contactsPublishQueuedRef.current = true;
  }, [computeContactsFingerprint, contactSyncMeta.fingerprint, contacts, contactsPublishState, contactsSyncEnabled]);

  useEffect(() => {
    if (!contactsSyncEnabled) return;
    if (nostrMissingReason) return;
    void migrateNip51ContactsIfNeeded({ silent: true });
  }, [contactsSyncEnabled, nostrMissingReason, migrateNip51ContactsIfNeeded]);

  useEffect(() => {
    if (!contactsTabOpen) return;
    if (!contactsSyncEnabled) return;
    if (!contactsPublishQueuedRef.current) return;
    const timer = window.setTimeout(() => {
      if (contactsPublishQueuedRef.current) {
        void publishContactsToNostr({ silent: true });
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [contactsSyncEnabled, contactsTabOpen, publishContactsToNostr]);

  useEffect(() => {
    if (!contactsTabOpen && !contactsOpen) {
      contactProfilesRefreshedRef.current = false;
      return;
    }
    if (!contactProfilesRefreshedRef.current) {
      contactProfilesRefreshedRef.current = true;
      void refreshContactProfiles();
      if (contactsSyncEnabled) {
        void loadProfileMetadata();
        void syncContactsFromNostr({ silent: true });
      }
    }
  }, [contactsOpen, contactsSyncEnabled, contactsTabOpen, loadProfileMetadata, refreshContactProfiles, syncContactsFromNostr]);

  useEffect(() => {
    if (contactsTabOpen) return;
    setContactView("list");
    setActiveContactId(null);
    resetContactEditDraft();
    setContactEditError("");
    setContactLookupError("");
    setContactLookupInput("");
    setPublicFollowPickerOpen(false);
  }, [contactsTabOpen, resetContactEditDraft]);

  useEffect(() => {
    if (!contactsTabOpen) return;
    if (contactView !== "detail") return;
    if (activeContactId && activeContactId !== "profile") {
      const exists = contacts.some((entry) => entry.id === activeContactId);
      if (!exists) {
        setContactView("list");
        setActiveContactId(null);
      }
    }
  }, [activeContactId, contactView, contacts, contactsTabOpen]);

  useEffect(() => {
    if (!contactsTabOpen) return;
    if (contactView !== "detail") return;
    const panelEl = contactsPanelRef.current?.closest(".sheet-panel") as HTMLElement | null;
    panelEl?.scrollTo({ top: 0 });
  }, [activeContactId, contactView, contactsTabOpen]);

  const handleClaimIncomingPayment = useCallback(
    async (entry: IncomingPaymentRequest) => {
      if (claimingEventSet.has(entry.eventId)) return;
      let fingerprint = entry.fingerprint ?? fingerprintIncomingToken(entry.token);
      if (isIncomingPaymentSpent(entry.eventId, fingerprint)) {
        return;
      }
      setClaimingEventIds((prev) => [...prev, entry.eventId]);
      try {
        const res = await receiveToken(entry.token);
        if (res.savedForLater) {
          setHistory((prev) => [
            buildHistoryEntry({
              id: `payment-request-pending-${entry.eventId}`,
              summary: `Saved ${entry.amount} sat${entry.amount === 1 ? "" : "s"} payment token for later redemption`,
              detail: entry.token,
              detailKind: "token",
              type: "ecash",
              direction: "in",
              amountSat: entry.amount,
              mintUrl: res.usedMintUrl ?? entry.mint ?? undefined,
              pendingTokenId: res.pendingTokenId,
              pendingTokenAmount: entry.amount,
              pendingTokenMint: res.usedMintUrl ?? entry.mint ?? undefined,
              pendingStatus: "pending",
            }),
            ...prev,
          ]);
          if (entry.id && currentPaymentRequest?.id === entry.id) {
            setPaymentRequestStatusMessage(
              "Payment received but will be redeemed when your connection returns.",
            );
          }
          showToast(
            `Saved ${entry.amount} sat${entry.amount === 1 ? "" : "s"} token for later redemption.`,
            5000,
          );
          if (!fingerprint) {
            fingerprint = fingerprintIncomingToken(entry.token);
          }
          if (fingerprint && !entry.fingerprint) {
            entry.fingerprint = fingerprint;
          }
          addSpentIncomingPayment(entry.eventId, fingerprint ?? null);
          persistSpentIncomingEvents();
          return;
        }
        incomingPaymentRequestsRef.current = incomingPaymentRequestsRef.current.filter(
          (item) => item.eventId !== entry.eventId,
        );
        const now = Date.now();
        const tokenState = deriveSpentHistoryTokenStateFromTokenRef.current(entry.token, now);
        setHistory((prev) => [
          buildHistoryEntry({
            id: `payment-request-recv-${entry.eventId}`,
            summary: `Received ${entry.amount} sats via payment request`,
            detail: entry.token,
            detailKind: "token",
            type: "ecash",
            direction: "in",
            amountSat: entry.amount,
            mintUrl: res.usedMintUrl ?? entry.mint ?? undefined,
            ...(tokenState ? { tokenState } : {}),
          }),
          ...prev,
        ]);
        if (entry.id && currentPaymentRequest?.id === entry.id) {
          setPaymentRequestStatusMessage("Payment received and claimed automatically.");
        }
        const amountLabel = `${entry.amount} sat${entry.amount === 1 ? "" : "s"}`;
        let senderNip05: string | null = null;
        const normalizedSender = normalizeNostrPubkey(entry.sender);
        const senderHex = normalizedSender ? compressedToRawHex(normalizedSender).toLowerCase() : entry.sender.toLowerCase();
        if (senderHex && /^[0-9a-f]{64}$/.test(senderHex)) {
          const contact = contacts.find((c) => {
            const npub = normalizeNostrPubkey(c.npub || "");
            return npub ? compressedToRawHex(npub).toLowerCase() === senderHex : false;
          });
          if (contact?.nip05) {
            const nip05 = contact.nip05.trim();
            const normalizedNip05 = normalizeNip05(nip05);
            const check = nip05Checks[contact.id];
            const contactPubkeyHex = contact.npub
              ? compressedToRawHex(normalizeNostrPubkey(contact.npub) ?? contact.npub).toLowerCase()
              : "";
            if (
              normalizedNip05 &&
              check &&
              check.status === "valid" &&
              check.nip05 === normalizedNip05 &&
              check.npub === contactPubkeyHex
            ) {
              senderNip05 = nip05;
            }
          }
          if (!senderNip05) {
            const profile = dmPeerProfilesRef.current.get(senderHex);
            if (profile?.nip05) {
              const nip05 = profile.nip05.trim();
              const normalizedNip05 = normalizeNip05(nip05);
              const check = nip05Checks[`dm-${senderHex}`];
              if (
                normalizedNip05 &&
                check &&
                check.status === "valid" &&
                check.nip05 === normalizedNip05 &&
                check.npub === senderHex
              ) {
                senderNip05 = nip05;
              }
            }
          }
        }
        showToast(senderNip05 ? `Received ${amountLabel} from ${senderNip05}` : `Received ${amountLabel}`, 3500);
        if (res.crossMint) {
          showToast(`Redeemed to ${res.usedMintUrl}. Switch to view the balance.`, 5000);
        }
        if (!fingerprint) {
          fingerprint = fingerprintIncomingToken(entry.token);
        }
        if (fingerprint && !entry.fingerprint) {
          entry.fingerprint = fingerprint;
        }
        addSpentIncomingPayment(entry.eventId, fingerprint ?? null);
        persistSpentIncomingEvents();
      } catch (err: any) {
        const message = err?.message || String(err);
        console.warn("Failed to claim incoming payment", err);
        if (isMintTokenAlreadySpentError(err)) {
          if (!fingerprint) {
            fingerprint = fingerprintIncomingToken(entry.token);
          }
          if (fingerprint && !entry.fingerprint) {
            entry.fingerprint = fingerprint;
          }
          addSpentIncomingPayment(entry.eventId, fingerprint ?? null);
          incomingPaymentRequestsRef.current = incomingPaymentRequestsRef.current.filter(
            (item) => item.eventId !== entry.eventId,
          );
          persistSpentIncomingEvents();
          await requestNostrPaymentDeletion(entry.eventId, entry.sender, message);
        }
        showToast(message, 5000);
      } finally {
        setClaimingEventIds((prev) => prev.filter((id) => id !== entry.eventId));
      }
    },
    [
      addSpentIncomingPayment,
      buildHistoryEntry,
      claimingEventSet,
      compressedToRawHex,
      contacts,
      currentPaymentRequest,
      fingerprintIncomingToken,
      isIncomingPaymentSpent,
      nip05Checks,
      normalizeNip05,
      requestNostrPaymentDeletion,
      persistSpentIncomingEvents,
      receiveToken,
      setHistory,
      setPaymentRequestStatusMessage,
      showToast,
    ],
  );

  const scheduleAutoClaimRun = useCallback(() => {
    if (autoClaimRunningRef.current) return;
    autoClaimRunningRef.current = true;
    const processQueue = async () => {
      while (autoClaimQueueRef.current.length) {
        const entry = autoClaimQueueRef.current.shift();
        if (!entry) continue;
        let fingerprint = entry.fingerprint;
        if (!fingerprint) {
          fingerprint = fingerprintIncomingToken(entry.token);
          if (fingerprint) {
            entry.fingerprint = fingerprint;
          }
        }
        if (isIncomingPaymentSpent(entry.eventId, fingerprint)) {
          continue;
        }
        try {
          await handleClaimIncomingPayment(entry);
        } catch (err) {
          console.warn("Auto-claim payment request failed", err);
        }
      }
      autoClaimRunningRef.current = false;
    };
    void Promise.resolve().then(processQueue);
  }, [handleClaimIncomingPayment, fingerprintIncomingToken, isIncomingPaymentSpent]);

  const selectIncomingPaymentFromPayload = useCallback(
    (
      rawPayload:
        | PaymentRequestPayload
        | Record<string, unknown>
        | string
        | null
        | undefined,
    ): NormalizedIncomingPayment | null => {
      const payload = (() => {
        if (typeof rawPayload !== "string") return rawPayload;
        const trimmed = rawPayload.trim();
        if (!trimmed) return null;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
          // fall through to token extraction
        }
        const extracted = extractFirstCashuTokenFromText(trimmed);
        if (!extracted) return null;
        return { token: extracted } as Record<string, unknown>;
      })();
      if (!payload || typeof payload !== "object") return null;
      const defaultUnit = (info?.unit || "sat").toLowerCase();
      const normalizedActiveMint = mintUrl ? normalizeMintUrl(mintUrl) : null;
      const entries: NormalizedIncomingPayment[] = [];
      const seenEntries = new Set<string>();

      const normalizeProofList = (input: unknown): Proof[] => {
        if (!Array.isArray(input) || !input.length) return [];
        const normalized: Proof[] = [];
        for (const rawProof of input) {
          if (!rawProof || typeof rawProof !== "object") continue;
          const rawAmount = (rawProof as any).amount;
          const amountValue =
            typeof rawAmount === "number"
              ? rawAmount
              : typeof rawAmount === "string"
                ? Number(rawAmount.trim())
                : NaN;
          if (!Number.isFinite(amountValue) || amountValue <= 0) continue;
          const secret = typeof (rawProof as any).secret === "string" ? (rawProof as any).secret.trim() : "";
          const C = typeof (rawProof as any).C === "string" ? (rawProof as any).C.trim() : "";
          const id = typeof (rawProof as any).id === "string" ? (rawProof as any).id.trim() : "";
          if (!secret || !C || !id) continue;
          const proof: Proof = {
            amount: Math.floor(amountValue),
            secret,
            C,
            id,
          };
          if ((rawProof as any).dleq) {
            proof.dleq = (rawProof as any).dleq as Proof["dleq"];
          }
          if ((rawProof as any).witness) {
            proof.witness = (rawProof as any).witness as Proof["witness"];
          }
          normalized.push(proof);
        }
        return normalized;
      };

      const pushEntry = (mint: unknown, proofs: unknown, unitHint?: unknown, encodedCandidate?: unknown) => {
        if (typeof mint !== "string") return;
        const trimmedMint = mint.trim();
        if (!trimmedMint) return;
        const normalizedProofs = normalizeProofList(proofs);
        if (!normalizedProofs.length) return;
        const amount = normalizedProofs.reduce((sum, proof) => sum + (Number.isFinite(proof.amount) ? proof.amount : 0), 0);
        if (!amount) return;
        const resolvedUnit =
          typeof unitHint === "string" && unitHint.trim() ? unitHint.toLowerCase() : defaultUnit;
        let encoded = typeof encodedCandidate === "string" ? encodedCandidate.trim() : "";
        if (encoded) {
          if (/^cashu:/i.test(encoded)) {
            encoded = extractCashuUriPayload(encoded);
          }
        } else {
          try {
            encoded = getEncodedToken({ mint: trimmedMint, proofs: normalizedProofs, unit: resolvedUnit });
          } catch (err) {
            console.warn("Failed to encode incoming payment proofs", err);
            return;
          }
        }
        if (!encoded) return;
        const key = `${normalizeMintUrl(trimmedMint)}::${encoded}`;
        if (seenEntries.has(key)) return;
        seenEntries.add(key);
        entries.push({ token: encoded, amount, mint: trimmedMint, unit: resolvedUnit });
      };

      const tokenStrings: string[] = [];
      const seenTokenStrings = new Set<string>();
      const pushTokenString = (value: unknown) => {
        if (typeof value !== "string") return;
        const trimmed = value.trim();
        if (!trimmed) return;
        if (!/cashu/i.test(trimmed)) return;
        if (seenTokenStrings.has(trimmed)) return;
        seenTokenStrings.add(trimmed);
        tokenStrings.push(trimmed);
      };

      const considerProofLike = (value: unknown, unitHint?: unknown) => {
        if (!value || typeof value !== "object") return;
        const maybeMint = (value as any)?.mint;
        const maybeProofs = (value as any)?.proofs;
        pushEntry(maybeMint, maybeProofs, (value as any)?.unit ?? unitHint);
      };

      considerProofLike(payload, (payload as any)?.unit);

      pushTokenString((payload as any)?.token);
      pushTokenString((payload as any)?.cashu);
      pushTokenString((payload as any)?.encodedToken);
      pushTokenString((payload as any)?.encoded_token);
      pushTokenString((payload as any)?.payment_request);
      pushTokenString((payload as any)?.request);

      const tokensField = (payload as any)?.tokens;
      if (Array.isArray(tokensField)) {
        for (const entry of tokensField) {
          pushTokenString(entry);
          considerProofLike(entry, (payload as any)?.unit);
        }
      }

      const tokenField = (payload as any)?.token;
      if (tokenField && typeof tokenField === "object") {
        considerProofLike(tokenField, (tokenField as any)?.unit ?? (payload as any)?.unit);
        const nestedTokens = (tokenField as any)?.token;
        if (typeof nestedTokens === "string") {
          pushTokenString(nestedTokens);
        } else if (Array.isArray(nestedTokens)) {
          for (const nested of nestedTokens) {
            pushTokenString(nested);
            considerProofLike(nested, (tokenField as any)?.unit ?? (payload as any)?.unit);
          }
        }
      }

      for (const rawToken of tokenStrings) {
        let normalizedToken = rawToken;
        if (/^cashu:/i.test(normalizedToken)) {
          normalizedToken = extractCashuUriPayload(normalizedToken);
        }
        if (!normalizedToken) continue;
        try {
          const decoded = getDecodedToken(normalizedToken);
          if (!decoded) continue;
          const decodedEntries = Array.isArray((decoded as any)?.token)
            ? (decoded as any).token
            : (decoded as any)?.mint && Array.isArray((decoded as any)?.proofs)
              ? [decoded]
              : [];
          const decodedUnit = (decoded as any)?.unit;
          for (const entry of decodedEntries) {
            considerProofLike(entry, decodedUnit ?? (entry as any)?.unit ?? (payload as any)?.unit);
            pushEntry(
              (entry as any)?.mint,
              (entry as any)?.proofs,
              decodedUnit ?? (entry as any)?.unit ?? (payload as any)?.unit,
              normalizedToken,
            );
          }
        } catch (err) {
          if (walletDebugEnabled) {
            console.warn("Failed to decode token from payment payload", err);
          }
        }
      }

      if (!entries.length) return null;

      entries.sort((a, b) => {
        const aMatches = normalizedActiveMint
          ? normalizeMintUrl(a.mint) === normalizedActiveMint
          : false;
        const bMatches = normalizedActiveMint
          ? normalizeMintUrl(b.mint) === normalizedActiveMint
          : false;
        if (aMatches !== bMatches) {
          return aMatches ? -1 : 1;
        }
        if (b.amount !== a.amount) {
          return b.amount - a.amount;
        }
        return a.token.localeCompare(b.token);
      });

      return entries[0] ?? null;
    },
    [info?.unit, mintUrl, walletDebugEnabled],
  );

  const processIncomingPaymentPayload = useCallback(
    (
      payload: PaymentRequestPayload | string,
      event: NostrEvent,
      normalizedOverride?: NormalizedIncomingPayment | null,
      senderOverride?: string | null,
    ) => {
      const normalized = normalizedOverride ?? selectIncomingPaymentFromPayload(payload);
      if (!normalized) return;
      const { token: encoded, amount, mint, unit } = normalized;
      const fingerprint = fingerprintIncomingToken(encoded);
      if (isIncomingPaymentSpent(event.id, fingerprint)) {
        return;
      }
      const receivedAt = (event.created_at || Math.floor(Date.now() / 1000)) * 1000;
      let createdEntry: IncomingPaymentRequest | null = null;
      const existing = incomingPaymentRequestsRef.current;
      if (existing.some((entry) => entry.eventId === event.id)) {
        return;
      }
      const payloadId =
        payload && typeof payload === "object" && "id" in payload
          ? ((payload as PaymentRequestPayload).id ?? null)
          : null;
      let sender = (event.pubkey || "").toLowerCase();
      if (senderOverride && typeof senderOverride === "string") {
        const normalizedSender = normalizeNostrPubkey(senderOverride);
        if (normalizedSender) {
          const rawSender = compressedToRawHex(normalizedSender).toLowerCase();
          if (/^[0-9a-f]{64}$/.test(rawSender)) {
            sender = rawSender;
          }
        }
      }
      if (sender) {
        void ensurePeerProfile(sender);
      }
      const nextEntry: IncomingPaymentRequest = {
        eventId: event.id,
        id: payloadId,
        token: encoded,
        amount,
        mint,
        unit,
        sender,
        receivedAt,
        fingerprint,
      };
      createdEntry = nextEntry;
      const combined = [nextEntry, ...existing].sort((a, b) => b.receivedAt - a.receivedAt);
      incomingPaymentRequestsRef.current = combined.slice(0, 100);
      if (paymentRequestsEnabled && createdEntry) {
        autoClaimQueueRef.current.push(createdEntry);
        scheduleAutoClaimRun();
      }
      if (payloadId && currentPaymentRequest?.id === payloadId) {
        setPaymentRequestStatusMessage("Payment received. Claiming automatically…");
      }
    },
    [
      compressedToRawHex,
      currentPaymentRequest,
      ensurePeerProfile,
      paymentRequestsEnabled,
      scheduleAutoClaimRun,
      selectIncomingPaymentFromPayload,
      fingerprintIncomingToken,
      isIncomingPaymentSpent,
    ],
  );

  const PAYMENT_REQUEST_SEND_TIMEOUT_MS = 8000;

  const decryptNostrPaymentMessageRef = useRef(decryptNostrPaymentMessage);
  const parseIncomingPaymentMessageRef = useRef(parseIncomingPaymentMessage);
  const selectIncomingPaymentFromPayloadRef = useRef(selectIncomingPaymentFromPayload);
  const processIncomingPaymentPayloadRef = useRef(processIncomingPaymentPayload);
  useEffect(() => {
    decryptNostrPaymentMessageRef.current = decryptNostrPaymentMessage;
  }, [decryptNostrPaymentMessage]);
  useEffect(() => {
    parseIncomingPaymentMessageRef.current = parseIncomingPaymentMessage;
  }, [parseIncomingPaymentMessage]);
  useEffect(() => {
    selectIncomingPaymentFromPayloadRef.current = selectIncomingPaymentFromPayload;
  }, [selectIncomingPaymentFromPayload]);
  useEffect(() => {
    processIncomingPaymentPayloadRef.current = processIncomingPaymentPayload;
  }, [processIncomingPaymentPayload]);
  const handlePaymentRequestEvent = useCallback(
    async (event: NostrEvent, options?: { updateClock?: boolean }) => {
      if (!event || typeof event.id !== "string") return;
      if (event.kind !== 4 && event.kind !== 1059) return;
      if (nostrProcessedEventsRef.current.has(event.id)) return;
      const decrypt = decryptNostrPaymentMessageRef.current;
      const parseMessage = parseIncomingPaymentMessageRef.current;
      const selectPayload = selectIncomingPaymentFromPayloadRef.current;
      const processPayload = processIncomingPaymentPayloadRef.current;
      if (!decrypt || !parseMessage || !selectPayload || !processPayload) return;
      const identity = ensureNostrIdentity();
      if (!identity) return;
      const decrypted = await decrypt(event, identity.pubkey, identity.secret);
      const plain = decrypted?.content;
      if (!plain) return;
      const identityRaw = compressedToRawHex(identity.pubkey).toLowerCase();
      const normalizeToRawHex = (value: string | null | undefined): string | null => {
        if (!value || typeof value !== "string") return null;
        const normalized = normalizeNostrPubkey(value);
        if (!normalized) {
          const trimmed = value.trim().toLowerCase();
          return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
        }
        const raw = compressedToRawHex(normalized).toLowerCase();
        return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
      };
      const hintedSender = normalizeToRawHex(extractMinibitsPaymentSender(plain));
      const decryptedSender = normalizeToRawHex(decrypted?.senderPubkey);
      const decryptedRecipient = normalizeToRawHex(decrypted?.recipientPubkey);
      const decryptedRecipients = Array.isArray(decrypted?.recipientPubkeys)
        ? decrypted.recipientPubkeys
            .map((value) => normalizeToRawHex(value))
            .filter((value): value is string => !!value)
        : [];
      const recipientCandidates = Array.from(
        new Set<string>([
          ...decryptedRecipients,
          ...(decryptedRecipient ? [decryptedRecipient] : []),
        ]),
      );
      const recipientMatchesIdentity = recipientCandidates.includes(identityRaw);
      if (recipientCandidates.length > 0 && !recipientMatchesIdentity) {
        return;
      }
      if (recipientCandidates.length === 0 && decryptedSender === identityRaw) {
        // If we cannot determine a recipient, ignore self-authored messages
        // to avoid claiming sender mirror wraps unintentionally.
        return;
      }
      const senderOverride =
        hintedSender && hintedSender !== identityRaw
          ? hintedSender
          : decryptedSender && decryptedSender !== identityRaw
            ? decryptedSender
            : null;
      try {
        const message = parseMessage(plain);
        if (!message) return;
        const normalizedPayload = selectPayload(message);
        if (!normalizedPayload) return;
        nostrProcessedEventsRef.current.add(event.id);
        if (nostrProcessedEventsRef.current.size > 512) {
          const iter = nostrProcessedEventsRef.current.values();
          const first = iter.next().value;
          if (first) nostrProcessedEventsRef.current.delete(first);
        }
        if (options?.updateClock !== false) {
          const createdAt = event.created_at || Math.floor(Date.now() / 1000);
          if (createdAt > nostrLastCheckRef.current) {
            nostrLastCheckRef.current = createdAt;
          }
        }
        processPayload(message, event, normalizedPayload, senderOverride);
      } catch (err) {
        console.warn("Failed to parse Nostr payment request message", err);
      }
    },
    [compressedToRawHex, ensureNostrIdentity],
  );

  useEffect(() => {
    handlePaymentRequestEventRef.current = handlePaymentRequestEvent;
  }, [handlePaymentRequestEvent]);

  const stopPaymentRequestSubscription = useCallback(() => {
    if (nostrSubscriptionCloserRef.current) {
      try { nostrSubscriptionCloserRef.current(); } catch {}
      nostrSubscriptionCloserRef.current = null;
    }
    nostrSubscriptionActiveRef.current = false;
  }, []);

  const startPaymentRequestSubscription = useCallback(async () => {
    if (!paymentRequestsEnabled || nostrSubscriptionActiveRef.current) return;
    if (!paymentRequestsBackgroundChecksEnabled && !open) return;
    const identity = ensureNostrIdentity();
    if (!identity) return;
    const relays = defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")).filter(Boolean);
    if (!relays.length) return;
    const now = Math.floor(Date.now() / 1000);
    const initialLastCheck = nostrLastCheckRef.current || now - PAYMENT_REQUEST_LOOKBACK_SECONDS;
    const normalizedLastCheck = Math.max(0, Math.min(initialLastCheck, now));
    const since = Math.max(0, normalizedLastCheck - PAYMENT_REQUEST_SAFETY_WINDOW_SECONDS);
    nostrLastCheckRef.current = normalizedLastCheck;
    try {
      const session = await NostrSession.init(relays);
      if (nostrSubscriptionCloserRef.current) {
        stopPaymentRequestSubscription();
      }
      const managed = await session.subscribe(
        [{ kinds: [4, 1059], "#p": [identity.pubkey], since }],
        {
          relayUrls: relays,
          onEvent: (ev) => {
            const handler = handlePaymentRequestEventRef.current;
            if (handler) {
              void handler(ev as NostrEvent, { updateClock: true });
            }
          },
        },
      );
      nostrSubscriptionCloserRef.current = () => {
        try { managed.release(); } catch {}
        nostrSubscriptionActiveRef.current = false;
      };
      nostrSubscriptionActiveRef.current = true;
    } catch (err) {
      console.warn("Failed to start payment request subscription", err);
    }
  }, [
    PAYMENT_REQUEST_SAFETY_WINDOW_SECONDS,
    PAYMENT_REQUEST_LOOKBACK_SECONDS,
    defaultNostrRelays,
    ensureNostrIdentity,
    open,
    paymentRequestsEnabled,
    paymentRequestsBackgroundChecksEnabled,
    stopPaymentRequestSubscription,
  ]);

  const deepSyncDMs = useCallback(async () => {
    if (!paymentRequestsEnabled) return;
    const identity = ensureNostrIdentity();
    if (!identity) return;
    const relays = defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")).filter(Boolean);
    if (!relays.length) return;
    try {
      const session = await NostrSession.init(relays);
      const since = Math.max(
        0,
        Math.floor(Date.now() / 1000) - PAYMENT_REQUEST_DEEP_SYNC_LOOKBACK_SECONDS,
      );
      const events = await session.fetchEvents(
        [{ kinds: [4, 1059], "#p": [identity.pubkey], since }],
        relays,
      );
      const ordered = events
        .filter((event) => event && (event.kind === 4 || event.kind === 1059))
        .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      for (const event of ordered) {
        const handler = handlePaymentRequestEventRef.current;
        if (handler) {
          await handler(event, { updateClock: false });
        }
      }
    } catch (err) {
      console.warn("Deep DM sync failed", err);
    }
  }, [
    PAYMENT_REQUEST_DEEP_SYNC_LOOKBACK_SECONDS,
    defaultNostrRelays,
    ensureNostrIdentity,
    paymentRequestsEnabled,
  ]);

  useEffect(() => {
    deepSyncDMsRef.current = deepSyncDMs;
  }, [deepSyncDMs]);

  useEffect(() => {
    if (!paymentRequestsEnabled) {
      autoClaimQueueRef.current.length = 0;
      return;
    }
    if (autoClaimQueueRef.current.length) {
      scheduleAutoClaimRun();
    }
  }, [paymentRequestsEnabled, scheduleAutoClaimRun]);

  useEffect(() => {
    if (!paymentRequestsEnabled || (!open && !paymentRequestsBackgroundChecksEnabled)) {
      stopPaymentRequestSubscription();
      return;
    }
    void startPaymentRequestSubscription();
    return () => {
      stopPaymentRequestSubscription();
    };
  }, [
    defaultNostrRelays,
    open,
    paymentRequestsEnabled,
    paymentRequestsBackgroundChecksEnabled,
    receiveMode,
    sendMode,
    startPaymentRequestSubscription,
    stopPaymentRequestSubscription,
  ]);

  useEffect(() => {
    return () => {
      stopPaymentRequestSubscription();
      void closeNostrPool(true);
    };
  }, [closeNostrPool, stopPaymentRequestSubscription]);

  useEffect(() => {
    if (!open) {
      stopDmSubscription();
      return;
    }
    void startDmSubscription();
    return () => {
      stopDmSubscription();
    };
  }, [open, startDmSubscription, stopDmSubscription]);

  useEffect(() => {
    if (walletTab === "messages" && !dmSubscriptionCloseRef.current) {
      void startDmSubscription();
    }
  }, [startDmSubscription, walletTab]);

  const normalizedSendLockPubkey = useMemo(() => {
    if (!lockSendToPubkey) return null;
    return normalizeNostrPubkey(sendLockPubkeyInput);
  }, [lockSendToPubkey, sendLockPubkeyInput]);

  const parsedSendAmount = useMemo(() => parseAmountInput(sendAmt), [parseAmountInput, sendAmt]);

  const currentSendTokenFingerprint = useMemo(() => {
    const parsed = parsedSendAmount;
    if (parsed.error || parsed.sats <= 0) return null;
    if (lockSendToPubkey) {
      if (!normalizedSendLockPubkey) return null;
      return `${parsed.sats}|p2pk:${normalizedSendLockPubkey}`;
    }
    return `${parsed.sats}|standard`;
  }, [lockSendToPubkey, normalizedSendLockPubkey, parsedSendAmount]);

  const tokenAlreadyCreatedForAmount = useMemo(() => {
    if (!sendTokenStr || !lastSendTokenFingerprint || !currentSendTokenFingerprint) return false;
    return lastSendTokenFingerprint === currentSendTokenFingerprint;
  }, [currentSendTokenFingerprint, lastSendTokenFingerprint, sendTokenStr]);

  const ecashPrimaryAmountText = useMemo(() => {
    const trimmed = sendAmt.trim();
    if (primaryCurrency === "usd") {
      return `$${trimmed || "0.00"}`;
    }
    return `${trimmed || "0"} sat`;
  }, [primaryCurrency, sendAmt]);

  const ecashSecondaryAmountText = useMemo(() => {
    if (parsedSendAmount.error || parsedSendAmount.sats <= 0) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(parsedSendAmount.sats)} sat`;
    }
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
      return `Enter amount in ${amountInputUnitLabel}`;
    }
    const usdValue = (parsedSendAmount.sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${formatUsdAmount(usdValue)}`;
  }, [
    amountInputUnitLabel,
    btcUsdPrice,
    formatUsdAmount,
    parsedSendAmount,
    primaryCurrency,
    satFormatter,
    walletConversionEnabled,
  ]);

  const canCreateSendTokenAmount = useMemo(
    () => parsedSendAmount.sats > 0 && !parsedSendAmount.error && !!mintUrl,
    [parsedSendAmount, mintUrl],
  );

  const primaryAmountDisplay = useMemo(() => {
    if (primaryCurrency === "usd") {
      if (usdBalance == null) {
        if (!walletConversionEnabled) return "$0.00";
        return priceStatus === "error" ? "USD unavailable" : "Fetching price…";
      }
      return formatUsdAmount(usdBalance);
    }
    return `${satFormatter.format(Math.max(0, Math.floor(totalBalance)))} sat`;
  }, [primaryCurrency, usdBalance, walletConversionEnabled, priceStatus, formatUsdAmount, satFormatter, totalBalance]);

  const secondaryAmountDisplay = useMemo(() => {
    if (!walletConversionEnabled) return null;
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(Math.max(0, Math.floor(totalBalance)))} sat`;
    }
    if (usdBalance == null) {
      return priceStatus === "error" ? "USD unavailable" : "Fetching price…";
    }
    return `≈ ${formatUsdAmount(usdBalance)}`;
  }, [walletConversionEnabled, primaryCurrency, satFormatter, totalBalance, usdBalance, priceStatus, formatUsdAmount]);

  const priceMeta = useMemo(() => {
    if (!walletConversionEnabled) return null;
    if (btcUsdPrice == null || btcUsdPrice <= 0) {
      return priceStatus === "error" ? "BTC/USD price unavailable" : "Fetching BTC/USD price…";
    }
    const base = `${usdFormatterLarge.format(btcUsdPrice)} / BTC`;
    if (priceStatus === "error") {
      return `${base} • Using last update`;
    }
    if (priceUpdatedAt) {
      const timeStr = new Date(priceUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `${base} • Updated ${timeStr}`;
    }
    return base;
  }, [walletConversionEnabled, btcUsdPrice, priceStatus, priceUpdatedAt, usdFormatterLarge]);

  const pendingBalanceDisplay = useMemo(() => {
    if (pendingBalance <= 0) return null;
    const pendingSat = Math.max(0, Math.floor(pendingBalance));
    return `${satFormatter.format(pendingSat)} sat pending redemption`;
  }, [pendingBalance, satFormatter]);

  const scannerMessageTone = useMemo(() => {
    if (!scannerMessage) return "info";
    return /denied|unsupported|not supported|unrecognized|error|unable/i.test(scannerMessage) ? "error" : "info";
  }, [scannerMessage]);

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const handleScannerError = useCallback((message: string) => {
    setScannerMessage(message);
  }, []);

  const handleScannerDetected = useCallback(async (rawValue: string) => {
    const text = rawValue.trim();
    if (!text) return false;

    const compact = text.replace(/\s+/g, "");

    if (/^https?:\/\//i.test(compact) || /^www\./i.test(compact)) {
      setScannerMessage("Unsupported QR code. Only Cashu tokens and Lightning requests are allowed.");
      return false;
    }

    let candidate = compact;

    const collector = nut16CollectorRef.current ?? (nut16CollectorRef.current = new Nut16Collector());

    if (/^bitcoin:/i.test(candidate)) {
      const [, query = ""] = candidate.split("?");
      if (query) {
        const params = new URLSearchParams(query);
        const lightningParam = params.get("lightning") || params.get("lightning_pay");
        const tokenParam = params.get("token");
        if (lightningParam) {
          try {
            candidate = decodeURIComponent(lightningParam);
          } catch {
            candidate = lightningParam;
          }
        } else if (tokenParam?.toLowerCase().startsWith("cashu")) {
          try {
            candidate = decodeURIComponent(tokenParam);
          } catch {
            candidate = tokenParam;
          }
        }
      }
    }

    candidate = candidate.replace(/^lightning:/i, "").trim();

    if (/^cashu:/i.test(candidate)) {
      candidate = extractCashuUriPayload(candidate);
    }

    const peanutDecoded = extractPeanutToken(candidate);
    if (peanutDecoded) {
      candidate = peanutDecoded;
    }

    candidate = candidate.replace(/^nostr:/i, "").trim();

    const contactPayload = decodeContactPayload(candidate);
    if (contactPayload) {
      await handleScannedContactPayload(contactPayload);
      return true;
    }

    try {
      const decoded = nip19.decode(candidate);
      if (decoded.type === "nprofile") {
        const data = decoded.data as { pubkey?: string; relays?: string[] };
        if (data?.pubkey) {
          await handleScannedContactPayload({
            npub: formatNpub(data.pubkey),
            relays: Array.isArray(data.relays)
              ? data.relays.filter((entry) => typeof entry === "string" && entry.trim())
              : undefined,
          });
          return true;
        }
      } else if (decoded.type === "npub") {
        const npub =
          typeof decoded.data === "string"
            ? decoded.data
            : Array.isArray(decoded.data)
              ? nip19.npubEncode(Uint8Array.from(decoded.data))
              : null;
        if (npub) {
          await handleScannedContactPayload({ npub });
          return true;
        }
      }
    } catch {
      // not a nostr profile
    }

    const lowerCandidate = candidate.toLowerCase();

    const nut16Frame = parseNut16FrameString(candidate);
    if (nut16Frame) {
      const result = collector.addFrame(nut16Frame);
      if (result.status === "complete") {
        setPendingScan({ type: "ecash", token: result.token });
        setShowScanner(false);
        setScannerMessage("Animated Cashu token assembled.");
        collector.reset();
        return true;
      }
      if (result.status === "error") {
        setScannerMessage(result.error.message || "Failed to assemble animated token.");
        collector.reset();
        return false;
      }
      const received = typeof result.received === "number" ? result.received : nut16Frame.index;
      const total = typeof result.total === "number" && result.total > 0 ? result.total : nut16Frame.total || 0;
      const remaining =
        typeof result.missing === "number"
          ? result.missing
          : total > 0
            ? Math.max(total - received, 0)
            : null;
      const progressLabel = total ? `${Math.min(received, total)}/${total}` : `${Math.max(received, 1)}`;
      const remainingLabel =
        remaining != null
          ? `${remaining} frame${remaining === 1 ? "" : "s"} remaining…`
          : "Processing…";
      const statusLabel = result.status === "duplicate" ? "Frame already captured" : "Captured frame";
      setScannerMessage(`${statusLabel} ${progressLabel}. ${remainingLabel}`);
      return false;
    }

    if (lowerCandidate.startsWith("cashu")) {
      setPendingScan({ type: "ecash", token: candidate });
      setShowScanner(false);
      return true;
    }

    if (/^creqa[0-9a-z]+$/i.test(candidate)) {
      setPendingScan({ type: "paymentRequest", request: candidate });
      setShowScanner(false);
      return true;
    }

    if (/^ln(bc|tb|sb|bcrt)[0-9]/.test(lowerCandidate)) {
      setPendingScan({ type: "bolt11", invoice: lowerCandidate });
      setShowScanner(false);
      return true;
    }

    if (/^[^@\s]+@[^@\s]+$/.test(candidate)) {
      setPendingScan({ type: "lightningAddress", address: candidate.toLowerCase() });
      setShowScanner(false);
      return true;
    }

    if (/^lnurl[0-9a-z]+$/i.test(candidate)) {
      setPendingScan({ type: "lnurl", data: candidate });
      setShowScanner(false);
      return true;
    }

    try {
      PaymentRequest.fromEncodedRequest(candidate);
      setPendingScan({ type: "paymentRequest", request: candidate });
      setShowScanner(false);
      return true;
    } catch {
      // fall through to error message
    }

    const maybeLockKeyInput = candidate.replace(/^p2pk:/i, "");
    const normalizedLockKey = normalizeNostrPubkey(maybeLockKeyInput);
    if (normalizedLockKey) {
      resetSendLockSettings();
      setLockSendToPubkey(true);
      setSendLockPubkeyInput(maybeLockKeyInput);
      setSendLockError("");
      setReceiveMode(null);
      setSendMode("ecash");
      setShowSendOptions(true);
      setPendingScan(null);
      setScannerMessage("");
      setShowScanner(false);
      return true;
    }

    setScannerMessage("Unrecognized code. Scan a Cashu token, Lightning invoice/address, LNURL or payment request.");
    return false;
  }, [decodeContactPayload, formatNpub, handleScannedContactPayload, resetSendLockSettings]);

  const handlePasteFromClipboard = useCallback(async () => {
    setScannerMessage("");
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        setScannerMessage("Clipboard access unavailable. Paste the code manually.");
        return;
      }

      const pasted = await navigator.clipboard.readText();
      const trimmed = pasted.trim();
      if (!trimmed) {
        setScannerMessage("Clipboard is empty.");
        return;
      }

      await handleScannerDetected(trimmed);
    } catch (err: any) {
      console.error("Clipboard read failed", err);
      setScannerMessage(err?.message || "Failed to read from clipboard.");
    }
  }, [handleScannerDetected]);

  const handleLnurlScan = useCallback(async (lnurlValue: string) => {
    try {
      const url = decodeLnurlString(lnurlValue);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`LNURL request failed (${res.status})`);
      const data = await res.json();
      const tag = String(data?.tag || "").toLowerCase();
      const domain = extractDomain(url);

      if (tag === "payrequest") {
        const minSendable = Number(data?.minSendable ?? 0);
        const maxSendable = Number(data?.maxSendable ?? 0);
        const commentAllowed = Number(data?.commentAllowed ?? 0);
        if (!data?.callback) throw new Error("LNURL pay is missing callback URL");
        if (!minSendable || !maxSendable) throw new Error("LNURL pay missing sendable range");

        const payload: LnurlPayData = {
          lnurl: lnurlValue.trim(),
          callback: data.callback,
          domain,
          minSendable,
          maxSendable,
          commentAllowed,
          metadata: typeof data?.metadata === "string" ? data.metadata : undefined,
        };

        setLnurlPayData(payload);
        setLnurlWithdrawInfo(null);
        setReceiveMode(null);
        setSendMode("lightning");
        setShowSendOptions(true);
        setLnInput(lnurlValue.trim());
        setLightningSendView("address");
        if (minSendable === maxSendable) {
          setLnAddrAmt(String(Math.floor(minSendable / 1000)));
        } else {
          setLnAddrAmt("");
        }
        setLnState("idle");
        setLnError("");
        setScannerMessage("");
        return;
      }

      if (tag === "withdrawrequest") {
        if (!data?.callback || !data?.k1) throw new Error("LNURL withdraw missing callback parameters");
        const minWithdrawable = Number(data?.minWithdrawable ?? 0);
        const maxWithdrawable = Number(data?.maxWithdrawable ?? 0);
        if (!minWithdrawable || !maxWithdrawable) throw new Error("LNURL withdraw missing withdrawable range");

        const info: LnurlWithdrawData = {
          lnurl: lnurlValue.trim(),
          callback: data.callback,
          domain,
          k1: data.k1,
          minWithdrawable,
          maxWithdrawable,
          defaultDescription: typeof data?.defaultDescription === "string" ? data.defaultDescription : undefined,
        };

        setLnurlWithdrawInfo(info);
        const maxSat = Math.floor(maxWithdrawable / 1000);
        setLnurlWithdrawAmt(maxSat > 0 ? String(maxSat) : "");
        setLnurlWithdrawState("idle");
        setLnurlWithdrawMessage("");
        setLnurlWithdrawInvoice("");
        setLnurlPayData(null);
        setSendMode(null);
        setShowSendOptions(false);
        setReceiveMode("lnurlWithdraw");
        setScannerMessage("");
        return;
      }

      throw new Error("Unsupported LNURL tag");
    } catch (err: any) {
      console.error("handleLnurlScan failed", err);
      setScannerMessage(err?.message || String(err));
    }
  }, []);

  const openScanner = useCallback(async () => {
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    };
    if (navigator?.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stream.getTracks().forEach((track) => track.stop());
      } catch (err: any) {
        setScannerMessage(err?.message || "Camera permission denied");
        setPendingScan(null);
        setShowScanner(true);
        return;
      }
    }
    nut16CollectorRef.current?.reset();
    setScannerMessage("");
    setPendingScan(null);
    setReceiveMode(null);
    setShowSendOptions(false);
    setSendMode(null);
    setShowScanner(true);
  }, []);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    setScannerMessage("");
    setPendingScan(null);
    nut16CollectorRef.current?.reset();
  }, []);

  async function handleCreateInvoice() {
    if (creatingMintInvoice) return;
    setMintError("");
    setCreatingMintInvoice(true);
    try {
      const { sats, error } = parseAmountInput(mintAmt);
      if (error) throw new Error(error);
      if (!sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
      const q = await createMintInvoice(sats);
      const expiresAt = q.expiry > 1_000_000_000_000 ? q.expiry : q.expiry * 1000;
      setMintQuote(q);
      setActiveMintInvoice({ ...q, amountSat: sats });
      setMintStatus("waiting");
      setLightningReceiveView("invoice");
      setHistory((h) => [
        buildHistoryEntry({
          id: q.quote,
          summary: `Invoice for ${sats} sats`,
          detail: q.request,
           detailKind: "invoice",
           type: "lightning",
           direction: "in",
           amountSat: sats,
           mintUrl: q.mintUrl,
           stateLabel: "Pending",
          mintQuote: {
            quote: q.quote,
            amount: sats,
            request: q.request,
            mintUrl: q.mintUrl,
            createdAt: Date.now(),
            expiresAt,
            state: "UNPAID",
          },
        }),
        ...h,
      ]);
    } catch (e: any) {
      setMintError(e?.message || String(e));
    } finally {
      setCreatingMintInvoice(false);
    }
  }
  useEffect(() => {
    if (!activeMintInvoice) return;

    const { quote, amountSat, expiry, mintUrl: invoiceMintUrl } = activeMintInvoice;
    const expiryMs = expiry > 1_000_000_000_000 ? expiry : expiry * 1000;
    const targetMintUrl = invoiceMintUrl || mintUrl || "";
    const normalizedMint = targetMintUrl ? normalizeMintUrl(targetMintUrl) : "";

    let cancelled = false;
    let claimed = false;
    let pollInFlight = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let subscriptionCancel: (() => void) | null = null;

    const finalizeClaim = async () => {
      if (claimed) return;
      claimed = true;
      try {
        await claimMintQuoteById(quote, amountSat, { historyItemId: quote, mintUrl: targetMintUrl });
        setMintStatus("minted");
        setMintQuote(null);
        setMintAmt("");
        setMintError("");
        setActiveMintInvoice(null);
        if (receiveMode === "lightning") {
          closeReceiveLightningSheet();
        }
      } catch (err: any) {
        const message = err?.message || String(err ?? "");
        setMintStatus("error");
        setMintError(message);
      }
    };

    const handleState = async (state: string) => {
      if (cancelled || claimed) return;
      const normalized = typeof state === "string" ? state.toUpperCase() : "";
      if (normalized === "PAID" || normalized === "ISSUED") {
        await finalizeClaim();
        return;
      }
      if (expiryMs <= Date.now()) {
        setMintStatus("error");
        setMintError("Invoice expired. Create a new one.");
        setActiveMintInvoice(null);
        setMintQuote(null);
        setMintAmt("");
        setHistory((h) => h.filter((i) => i.id !== quote));
        setHistoryMintQuoteStates((prev) => {
          if (!(quote in prev)) return prev;
          const next = { ...prev };
          delete next[quote];
          return next;
        });
      }
    };

    const poll = async () => {
      if (cancelled || claimed || pollInFlight) return;
      pollInFlight = true;
      try {
        const state = await checkMintQuote(quote, { mintUrl: targetMintUrl });
        await handleState(state);
      } catch (err: any) {
        setMintError(err?.message || String(err ?? ""));
        setMintStatus("error");
      } finally {
        pollInFlight = false;
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = window.setInterval(() => {
        void poll();
      }, 4000);
      void poll();
    };

    const setupSubscription = async () => {
      if (!normalizedMint) {
        startPolling();
        return;
      }
      try {
        subscriptionCancel = await subscribeMintQuoteUpdates(
          normalizedMint,
          [quote],
          (payload) => {
            void handleState((payload?.state as string) ?? "");
          },
          (error) => {
            console.warn(`Mint quote subscription error`, error);
            startPolling();
          },
        );
      } catch (error) {
        console.warn(`Mint quote subscription unavailable`, error);
        startPolling();
      }
    };

    void poll();
    void setupSubscription();

    return () => {
      cancelled = true;
      if (subscriptionCancel) {
        try {
          subscriptionCancel();
        } catch {
          // ignore
        }
      }
      if (pollTimer) {
        window.clearInterval(pollTimer);
      }
    };
  }, [
    activeMintInvoice,
    mintUrl,
    subscribeMintQuoteUpdates,
    claimMintQuoteById,
    checkMintQuote,
    closeReceiveLightningSheet,
    receiveMode,
    setHistory,
    setHistoryMintQuoteStates,
    setMintQuote,
    setMintStatus,
    setMintAmt,
    setActiveMintInvoice,
  ]);

  useEffect(() => {
    if (sendMode !== "ecash") {
      setSendAmt("");
      setCreatingSendToken(false);
      setLastSendTokenFingerprint(null);
      setLastSendTokenLockLabel(null);
      setSendTokenStr("");
      resetSendLockSettings();
    }
  }, [sendMode, resetSendLockSettings]);

  useEffect(() => {
    if (!open) return;
    if (!pendingMintQuoteHistoryItems.length) return;

    const fallbackMintRaw = mintUrl || "";
    const groups = new Map<
      string,
      Array<{ item: HistoryItem; quoteId: string; amount: number; mintUrlRaw: string }>
    >();

    for (const entry of pendingMintQuoteHistoryItems) {
      const quoteId = entry.mintQuote?.quote?.trim() ?? "";
      if (!quoteId) continue;
      const rawMint = entry.mintQuote?.mintUrl || fallbackMintRaw;
      const normalizedMint = rawMint ? normalizeMintUrl(rawMint) : "";
      if (!normalizedMint) continue;
      const amount = entry.mintQuote?.amount ?? 0;
      const plan = { item: entry, quoteId, amount, mintUrlRaw: rawMint };
      const list = groups.get(normalizedMint);
      if (list) {
        list.push(plan);
      } else {
        groups.set(normalizedMint, [plan]);
      }
    }

    if (!groups.size) return;

    let cancelled = false;
    const cleanupFns: Array<() => void> = [];

    groups.forEach((plans, normalizedMint) => {
      const planMap = new Map(plans.map((plan) => [plan.quoteId, plan]));
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let pollInFlight = false;
      let subscriptionCancel: (() => void) | null = null;

      const handleState = (quoteId: string, state: string, amountFromEvent?: number) => {
        if (cancelled) return;
        const normalizedState = state?.toUpperCase?.() ?? "";
        if (normalizedState !== "PAID" && normalizedState !== "ISSUED") return;
        const plan = planMap.get(quoteId);
        if (!plan) return;
        const amount = amountFromEvent && amountFromEvent > 0 ? amountFromEvent : plan.amount;
        void claimMintQuoteById(quoteId, amount, {
          historyItemId: plan.item.id,
          mintUrl: plan.mintUrlRaw,
        });
      };

      const poll = async () => {
        if (cancelled || pollInFlight) return;
        pollInFlight = true;
        try {
          for (const plan of plans) {
            if (cancelled) break;
            const state = await checkMintQuote(plan.quoteId, { mintUrl: plan.mintUrlRaw });
            handleState(plan.quoteId, state);
          }
        } catch (error) {
          console.warn("Mint quote polling failed", error);
        } finally {
          pollInFlight = false;
        }
      };

      const startPolling = () => {
        if (pollTimer) return;
        pollTimer = window.setInterval(() => {
          void poll();
        }, 6000);
        void poll();
      };

      const setupSubscription = async () => {
        if (unsupportedMintQuoteSubscriptionMintsRef.current.has(normalizedMint)) {
          startPolling();
          return;
        }
        const cooldownUntil = mintQuoteSubscriptionCooldownRef.current.get(normalizedMint);
        const now = Date.now();
        if (typeof cooldownUntil === "number" && cooldownUntil > now) {
          startPolling();
          return;
        }
        if (typeof cooldownUntil === "number" && cooldownUntil <= now) {
          mintQuoteSubscriptionCooldownRef.current.delete(normalizedMint);
        }
        try {
          subscriptionCancel = await subscribeMintQuoteUpdates(
            normalizedMint,
            plans.map((plan) => plan.quoteId),
            (payload) => {
              if (!payload?.quote) return;
              handleState(
                payload.quote,
                (payload.state as string) ?? "",
                payload.amount ?? undefined,
              );
            },
            (error) => {
              console.warn("Mint quote history subscription error", error);
              mintQuoteSubscriptionCooldownRef.current.set(
                normalizedMint,
                Date.now() + SUBSCRIPTION_RETRY_DELAY_MS,
              );
              startPolling();
            },
          );
          mintQuoteSubscriptionCooldownRef.current.delete(normalizedMint);
        } catch (error: any) {
          const message = error?.message ? String(error.message) : "";
          if (message.toLowerCase().includes("does not support")) {
            unsupportedMintQuoteSubscriptionMintsRef.current.add(normalizedMint);
          } else {
            mintQuoteSubscriptionCooldownRef.current.set(
              normalizedMint,
              Date.now() + SUBSCRIPTION_RETRY_DELAY_MS,
            );
          }
          console.warn("Mint quote history subscription unavailable", error);
          startPolling();
        }
      };

      void poll();
      void setupSubscription();

      cleanupFns.push(() => {
        if (subscriptionCancel) {
          try {
            subscriptionCancel();
          } catch {}
        }
        if (pollTimer) {
          window.clearInterval(pollTimer);
        }
      });
    });

    return () => {
      cancelled = true;
      cleanupFns.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
    };
  }, [
    open,
    pendingMintQuoteHistoryItems,
    mintUrl,
    subscribeMintQuoteUpdates,
    claimMintQuoteById,
    checkMintQuote,
  ]);

  useEffect(() => {
    if (sendMode !== "ecash" || !sendTokenStr) return;
    const spentEntry = history.find(
      (entry) => entry.revertToken === sendTokenStr && entry.tokenState?.lastState === "SPENT",
    );
    if (spentEntry) {
      setSendMode(null);
      setShowSendOptions(false);
      showToast("Token spent by recipient", 3000);
    }
  }, [history, sendMode, sendTokenStr, setSendMode, setShowSendOptions, showToast]);

  async function handleCreateSendToken() {
    const { sats, error } = parseAmountInput(sendAmt);
    if (error) {
      alert(error);
      return;
    }
    if (!sats) {
      alert(`Enter amount in ${amountInputUnitLabel}`);
      return;
    }

    let lockOptions: CreateSendTokenOptions | undefined;
    let fingerprintSuffix = "standard";
    if (lockSendToPubkey) {
      if (!normalizedSendLockPubkey) {
        setSendLockError("Enter a valid npub or 64-character hex key");
        return;
      }
      lockOptions = { p2pk: { pubkey: normalizedSendLockPubkey } };
      fingerprintSuffix = `p2pk:${normalizedSendLockPubkey}`;
      setSendLockError("");
    } else {
      setSendLockError("");
    }

    if (tokenAlreadyCreatedForAmount) {
      alert("Token already created for this amount. Close this sheet or change the amount to create another token.");
      return;
    }

    setCreatingSendToken(true);
    try {
      const {
        token,
        proofs: sentProofs,
        mintUrl: sentMintUrl,
        lockInfo,
      } = await createSendToken(sats, lockOptions);
      setSendTokenStr(token);
      setLastSendTokenAmount(sats);
      setLastSendTokenMint(sentMintUrl);
      setLastSendTokenFingerprint(`${sats}|${fingerprintSuffix}`);
      if (lockInfo?.type === "p2pk") {
        const labelSource = Array.isArray(lockInfo.options.pubkey)
          ? lockInfo.options.pubkey.join(", ")
          : lockInfo.options.pubkey;
        setLastSendTokenLockLabel(`Locked to ${labelSource}`);
      } else {
        setLastSendTokenLockLabel(null);
      }
      setEcashSendView("token");
      setHistory((h) => [
        buildHistoryEntry({
          id: `token-${Date.now()}`,
          summary: `${lockInfo?.type === "p2pk" ? "Locked token" : "Token"} for ${sats} sats`,
          detail: token,
          detailKind: "token",
          revertToken: token,
          type: "ecash",
          direction: "out",
          amountSat: sats,
          mintUrl: sentMintUrl,
          tokenState:
            sentProofs?.length
              ? {
                  mintUrl: sentMintUrl,
                  proofs: sentProofs.map((proof) => {
                    const stored: StoredProofForState = {
                      secret: proof.secret,
                      amount: proof.amount,
                      id: proof.id,
                      C: proof.C,
                    };
                    if (proof.witness) stored.witness = proof.witness;
                    const y = computeProofY(proof.secret);
                    if (y) stored.Y = y;
                    return stored;
                  }),
                  lastState: "UNSPENT",
                }
              : undefined,
        }),
        ...h,
      ]);
    } catch (e: any) {
      const message = e?.message || String(e);
      const totalProofValue = sumProofAmounts(proofs);
      if (totalProofValue >= sats) {
        const availableNotes = proofs
          .filter((proof) => normalizeProofAmount(proof?.amount) > 0 && typeof proof?.secret === "string" && proof.secret)
          .map((proof) => ({ secret: proof.secret!, amount: proof.amount ?? 0 }));
        if (availableNotes.length) {
          const sortedNotes = [...availableNotes].sort((a, b) => b.amount - a.amount);
          const subsetInfo = computeSubsetSelectionInfo(sortedNotes, sats);
          let autoExactError: string | null = null;
          if (subsetInfo.exactMatch?.length) {
            const autoSelectedTotal = totalForSelection(sortedNotes, subsetInfo.exactMatch);
            if (autoSelectedTotal > 0) {
              try {
                await finalizeManualSelection({
                  selection: subsetInfo.exactMatch,
                  selectedTotal: autoSelectedTotal,
                  target: sats,
                });
                return;
              } catch (autoErr: any) {
                autoExactError = autoErr?.message || String(autoErr);
              }
            }
          }
          const groupedNotes = (() => {
            const map = new Map<number, string[]>();
            sortedNotes.forEach((note) => {
              const list = map.get(note.amount);
              if (list) {
                list.push(note.secret);
              } else {
                map.set(note.amount, [note.secret]);
              }
            });
            return Array.from(map.entries())
              .map(([amount, secrets]) => ({ amount, secrets }))
              .sort((a, b) => b.amount - a.amount);
          })();
          setManualSendPlan({
            target: sats,
            notes: sortedNotes,
            groups: groupedNotes,
            closestBelow: subsetInfo.closestBelow,
            closestBelowSelection: subsetInfo.closestBelowSelection,
            closestAbove: subsetInfo.closestAbove,
            closestAboveSelection: subsetInfo.closestAboveSelection,
            exactMatchSelection: subsetInfo.exactMatch,
            lockActive: !!lockOptions,
          });
          setManualSendSelection(() => new Set(subsetInfo.exactMatch ?? []));
          setManualSendError(autoExactError ?? "");
          return;
        }
      }
      alert(message);
    } finally {
      setCreatingSendToken(false);
    }
  }

  const handleCopyNutToken = useCallback(async () => {
    if (!peanutSendToken) return;
    try {
      await navigator.clipboard?.writeText(peanutSendToken);
      setNutTokenCopied(true);
    } catch (err) {
      console.warn("Copy nut token failed", err);
      setNutTokenCopied(false);
    }
  }, [peanutSendToken]);

  const handlePasteEcashRequest = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      const success = await handlePaymentRequestScan(text);
      if (!success) {
        alert("Unable to process eCash payment request. Check the value and try again.");
      }
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, [handlePaymentRequestScan]);

  const handlePasteSendLock = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      setSendLockPubkeyInput(text);
      const normalized = normalizeNostrPubkey(text);
      if (!normalized) {
        setLockSendToPubkey(false);
        setSendLockError("Enter a valid npub or 64-character hex key");
        return;
      }
      setLockSendToPubkey(true);
      setSendLockError("");
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, []);

  const handlePasteEcashInput = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      const requestHandled = await handlePaymentRequestScan(text);
      if (requestHandled) {
        return;
      }
      setSendLockPubkeyInput(text);
      const normalized = normalizeNostrPubkey(text);
      if (normalized) {
        setLockSendToPubkey(true);
        setSendLockError("");
        return;
      }
      setLockSendToPubkey(false);
      setSendLockError("Clipboard does not contain a valid eCash request or locking key");
      alert("Clipboard does not contain a valid eCash request or locking key.");
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, [handlePaymentRequestScan]);

  const handleClearSendLock = useCallback(() => {
    resetSendLockSettings();
  }, [resetSendLockSettings]);

  type EcashInputInterpretation =
    | { kind: "empty" }
    | { kind: "amount"; value: string }
    | { kind: "token"; value: string }
    | { kind: "invalid" };

  const interpretEcashInput = useCallback(
    (raw: string): EcashInputInterpretation => {
      const trimmed = raw.trim();
      if (!trimmed) {
        return { kind: "empty" };
      }
      const parsedAmount = parseAmountInput(trimmed);
      if (!parsedAmount.error && parsedAmount.sats > 0) {
        return { kind: "amount", value: trimmed };
      }
      let normalizedToken = trimmed;
      const peanutDecoded = extractPeanutToken(normalizedToken);
      if (peanutDecoded) {
        normalizedToken = peanutDecoded;
      }
      if (/^cashu:/i.test(normalizedToken)) {
        normalizedToken = extractCashuUriPayload(normalizedToken);
      }
      if (!normalizedToken) {
        return { kind: "invalid" };
      }
      try {
        if (containsNut16Frame(normalizedToken)) {
          const assembled = assembleNut16FromText(normalizedToken);
          normalizedToken = assembled.token;
        }
      } catch {
        // fall back to attempting decode with the provided input
      }
      try {
        const decoded = getDecodedToken(normalizedToken);
        if (decoded) {
          return { kind: "token", value: normalizedToken };
        }
      } catch {
        // invalid token
      }
      return { kind: "invalid" };
    },
    [parseAmountInput],
  );

  const redeemEcashToken = useCallback(
    async (tokenInput: string) => {
      let tokenCandidate = tokenInput.trim();
      if (!tokenCandidate) throw new Error("Paste a Cashu token");
      const peanutDecoded = extractPeanutToken(tokenCandidate);
      if (peanutDecoded) {
        tokenCandidate = peanutDecoded;
      }
      if (/^cashu:/i.test(tokenCandidate)) {
        tokenCandidate = extractCashuUriPayload(tokenCandidate);
      }
      if (!tokenCandidate) throw new Error("Paste a Cashu token");
      if (containsNut16Frame(tokenCandidate)) {
        const assembled = assembleNut16FromText(tokenCandidate);
        tokenCandidate = assembled.token;
      }
      const normalizedToken = tokenCandidate;
      const saved = await savePendingTokenForRedemption(normalizedToken);

      let savedAmount = typeof saved.amountSat === "number" ? saved.amountSat : 0;
      if (!savedAmount) {
        try {
          const decoded = getDecodedToken(normalizedToken);
          const entries: any[] = Array.isArray(decoded?.token)
            ? decoded.token
            : decoded?.proofs
              ? [decoded]
              : [];
          savedAmount = entries.reduce((outer, entry) => {
            const proofs = Array.isArray(entry?.proofs) ? entry.proofs : [];
            return outer + sumProofAmounts(proofs);
          }, 0);
        } catch {
          savedAmount = 0;
        }
      }

      const amountNote = savedAmount ? `${savedAmount} sat${savedAmount === 1 ? "" : "s"}` : "Token";
      const crossMintNote = saved.crossMint && saved.mintUrl ? ` at ${saved.mintUrl}` : "";
      const historyId = `recv-${Date.now()}`;

      setHistory((h) => [
        buildHistoryEntry({
          id: historyId,
          summary: `Received ${amountNote}${crossMintNote} (redeeming…)`,
          detail: normalizedToken,
          detailKind: "token",
          type: "ecash",
          direction: "in",
          amountSat: savedAmount || undefined,
          mintUrl: saved.mintUrl ?? mintUrl ?? undefined,
          pendingTokenId: saved.id,
          pendingTokenAmount: savedAmount || undefined,
          pendingTokenMint: saved.mintUrl ?? mintUrl ?? undefined,
          pendingStatus: "pending",
        }),
        ...h,
      ]);

      const toastAmount = savedAmount
        ? `${savedAmount} sat${savedAmount === 1 ? "" : "s"}`
        : "token";
      showToast(`Received ${toastAmount}${crossMintNote}`, 3500);

      if (receiveMode === "ecash") {
        closeReceiveEcashSheet();
      }

      void (async () => {
        try {
          const res = await redeemPendingToken(saved.id);
          const redeemedAmount = sumProofAmounts(res.proofs);
          const amountValue = redeemedAmount || savedAmount;
          const redeemedNote = amountValue
            ? `${amountValue} sat${amountValue === 1 ? "" : "s"}`
            : "Token";
          const mintLabel = saved.crossMint
            ? res.mintUrl
              ? ` at ${res.mintUrl}`
              : crossMintNote
            : "";
          const tokenState = deriveSpentHistoryTokenStateFromTokenRef.current(normalizedToken, Date.now());
          setHistory((prev) =>
            prev.map((entry) =>
              entry.id === historyId
                ? {
                    ...entry,
                    summary: `Received ${redeemedNote}${mintLabel}`,
                    amountSat: amountValue || undefined,
                    pendingTokenId: undefined,
                    pendingTokenAmount: undefined,
                    pendingTokenMint: undefined,
                    pendingStatus: "redeemed",
                    ...(tokenState ? { tokenState } : {}),
                  }
                : entry,
            ),
          );
        } catch (err) {
          console.warn("Cashu wallet: automatic redemption failed", err);
          setHistory((prev) =>
            prev.map((entry) =>
              entry.id === historyId
                ? {
                    ...entry,
                    summary: `${amountNote} saved for later redemption${crossMintNote}`,
                  }
                : entry,
            ),
          );
          showToast("Payment received but will be redeemed when your connection returns.", 4000);
        }
      })();
    },
    [
      buildHistoryEntry,
      closeReceiveEcashSheet,
      mintUrl,
      receiveMode,
      redeemPendingToken,
      savePendingTokenForRedemption,
      setHistory,
      showToast,
    ]
  );

  const processEcashInput = useCallback(
    async (raw: string) => {
      const promptMessage = "please enter amount for request or valid ecash token";
      setRecvMsg("");
      const interpretation = interpretEcashInput(raw);
      if (interpretation.kind === "empty") {
        setRecvMsg(promptMessage);
        return false;
      }
      if (interpretation.kind === "amount") {
        const created = await createPaymentRequest(interpretation.value);
        if (!created) {
          setRecvMsg(promptMessage);
          return false;
        }
        return true;
      }
      if (interpretation.kind === "token") {
        try {
          await redeemEcashToken(interpretation.value);
          return true;
        } catch (err: any) {
          setRecvMsg(err?.message || String(err));
          return false;
        }
      }
      setRecvMsg(promptMessage);
      return false;
    },
    [createPaymentRequest, interpretEcashInput, redeemEcashToken],
  );

  useEffect(() => {
    if (!pendingScan) return;
    let cancelled = false;

    async function process() {
      switch (pendingScan.type) {
        case "ecash": {
          openReceiveEcashSheet();
          setRecvMsg("");
          setSendMode(null);
          setShowSendOptions(false);
          setScannerMessage("");
          await processEcashInput(pendingScan.token);
          break;
        }
        case "bolt11": {
          setReceiveMode(null);
          setSendMode("lightning");
          setShowSendOptions(true);
          setLnInput(pendingScan.invoice);
          setLightningSendView("invoice");
          setLnAddrAmt("");
          setLnState("idle");
          setLnError("");
          setScannerMessage("");
          break;
        }
        case "lightningAddress": {
          setReceiveMode(null);
          setSendMode("lightning");
          setShowSendOptions(true);
          setLnInput(pendingScan.address);
          setLightningSendView("address");
          setLnAddrAmt("");
          setLnState("idle");
          setLnError("");
          setScannerMessage("");
          break;
        }
        case "lnurl": {
          setScannerMessage("Processing LNURL…");
          await handleLnurlScan(pendingScan.data);
          break;
        }
        case "paymentRequest": {
          setScannerMessage("Processing payment request…");
          await handlePaymentRequestScan(pendingScan.request);
          break;
        }
        default:
          closeCamera();
          break;
      }
    }

    process().finally(() => {
      if (!cancelled) setPendingScan(null);
    });

    return () => {
      cancelled = true;
    };
  }, [
    pendingScan,
    handleLnurlScan,
    handlePaymentRequestScan,
    openReceiveEcashSheet,
    processEcashInput,
  ]);

  const handlePasteEcashClipboard = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText())?.trim() ?? "";
      if (!text) {
        alert("Clipboard is empty.");
        return;
      }
      await processEcashInput(text);
    } catch {
      alert("Unable to read clipboard. Please paste manually.");
    }
  }, [processEcashInput]);

  const handleRedeemPendingHistoryItem = useCallback(
    async (item: HistoryItem) => {
      if (!item.pendingTokenId) return;
      setHistoryRedeemStates((prev) => ({
        ...prev,
        [item.id]: { status: "pending" },
      }));
      try {
        const res = await redeemPendingToken(item.pendingTokenId);
        const amount = sumProofAmounts(res.proofs);
        const amountNote = amount ? `${amount} sat${amount === 1 ? "" : "s"}` : "Token";
        showToast(`${amountNote} redeemed`, 3000);
        const tokenState =
          typeof item.detail === "string"
            ? deriveSpentHistoryTokenStateFromTokenRef.current(item.detail, Date.now())
            : undefined;
        setHistory((prev) =>
          prev.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  summary: `${amountNote} redeemed${res.mintUrl ? ` at ${res.mintUrl}` : ""}`,
                  pendingTokenId: undefined,
                  pendingTokenAmount: undefined,
                  pendingTokenMint: undefined,
                  pendingStatus: "redeemed",
                  ...(tokenState ? { tokenState } : {}),
                }
              : entry,
          ),
        );
        setHistoryRedeemStates((prev) => ({
          ...prev,
          [item.id]: { status: "success", message: `${amountNote} redeemed` },
        }));
      } catch (err: any) {
        const message = err?.message || String(err);
        setHistoryRedeemStates((prev) => ({
          ...prev,
          [item.id]: { status: "error", message },
        }));
      }
    },
    [redeemPendingToken, setHistory, showToast],
  );

  const handleManualSendConfirm = useCallback(async () => {
    if (!manualSendPlan) return;
    const secrets = Array.from(manualSendSelection);
    if (!secrets.length) {
      setManualSendError("Select at least one note.");
      return;
    }
    setManualSendInProgress(true);
    setManualSendError("");
    try {
      const selectedTotal = manualSelectedTotal;
      await finalizeManualSelection({
        selection: secrets,
        selectedTotal,
        target: manualSendPlan.target,
      });
      closeManualSendPlan();
    } catch (err: any) {
      setManualSendError(err?.message || String(err));
    } finally {
      setManualSendInProgress(false);
    }
  }, [
    closeManualSendPlan,
    finalizeManualSelection,
    manualSelectedTotal,
    manualSendPlan,
    manualSendSelection,
  ]);

  async function handlePayInvoice() {
    setLnState("sending");
    setLnError("");
    try {
      const raw = lnInput.trim();
      if (!raw) throw new Error("Paste an invoice or enter lightning address");
      const normalized = raw.replace(/^lightning:/i, "").trim();
      let toastLabel: string | null = null;

      if (isLnAddress) {
        const trimmedAddress = normalized.trim();
        const [rawName, ...domainParts] = trimmedAddress.split("@");
        const domainPart = domainParts.join("@").trim();
        if (!rawName || !domainPart) {
          throw new Error("Invalid lightning address");
        }
        const namePart = rawName.trim();
        const namePartLower = namePart.toLowerCase();
        const domainLower = domainPart.toLowerCase();
        const protocol = domainLower.endsWith(".onion") ? "http" : "https";
        const lnurlInfoUrl = `${protocol}://${domainLower}/.well-known/lnurlp/${encodeURIComponent(namePartLower)}`;
        let infoRes: Response;
        try {
          infoRes = await fetchWithTimeout(
            lnurlInfoUrl,
            { headers: { Accept: "application/json" }, mode: "cors", cache: "no-store" },
            15000,
          );
        } catch (error: any) {
          if (error?.name === "AbortError") {
            throw new Error("Lightning address request timed out");
          }
          throw error;
        }
        if (!infoRes.ok) {
          throw new Error(`Failed to fetch LNURL pay info (${infoRes.status})`);
        }
        let info: any;
        try {
          info = await infoRes.json();
        } catch {
          throw new Error("Invalid LNURL pay response");
        }
        const minSendable = Number(info?.minSendable ?? 0);
        const maxSendable = Number(info?.maxSendable ?? 0);
        const callbackRaw = typeof info?.callback === "string" ? info.callback : "";
        if (!callbackRaw || !minSendable || !maxSendable) {
          throw new Error("LNURL pay metadata incomplete");
        }
        const parsed = parseAmountInput(lnAddrAmt);
        if (parsed.error) throw new Error(parsed.error);
        if (!parsed.sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
        const requestedMsat = parsed.sats * 1000;
        const amountMsat = minSendable === maxSendable ? minSendable : requestedMsat;
        if (amountMsat < minSendable || amountMsat > maxSendable) {
          const minSat = Math.ceil(minSendable / 1000);
          const maxSat = Math.floor(maxSendable / 1000);
          throw new Error(`Amount must be between ${minSat} and ${maxSat} sats`);
        }
        const amountParam = String(amountMsat);
        const callbackUrl = (() => {
          try {
            const base = /^https?:/i.test(callbackRaw)
              ? new URL(callbackRaw)
              : new URL(callbackRaw, `${protocol}://${domainLower}`);
            base.searchParams.set("amount", amountParam);
            return base.toString();
          } catch {
            const separator = callbackRaw.includes("?") ? "&" : "?";
            return `${callbackRaw}${separator}amount=${encodeURIComponent(amountParam)}`;
          }
        })();
        let invRes: Response;
        try {
          invRes = await fetchWithTimeout(
            callbackUrl,
            { headers: { Accept: "application/json" }, mode: "cors", cache: "no-store" },
            15000,
          );
        } catch (error: any) {
          if (error?.name === "AbortError") {
            throw new Error("Lightning address invoice request timed out");
          }
          throw error;
        }
        if (!invRes.ok) {
          throw new Error(`Failed to fetch invoice (${invRes.status})`);
        }
        let inv: any;
        try {
          inv = await invRes.json();
        } catch {
          throw new Error("Invoice request returned invalid JSON");
        }
        if (inv?.status === "ERROR") {
          throw new Error(inv?.reason || "Invoice request failed");
        }
        const paymentRequest = typeof inv?.pr === "string" ? inv.pr : inv?.payRequest;
        if (typeof paymentRequest !== "string" || !paymentRequest) {
          throw new Error("LNURL callback did not return an invoice");
        }
        const paymentResult = await payMintInvoice(paymentRequest);
        const amountSat = Math.floor(amountMsat / 1000);
        toastLabel = String(amountSat);
        const historyAddress = `${namePartLower}@${domainLower}`;
        setHistory((h) => [
          buildHistoryEntry({
            id: `sent-${Date.now()}`,
            summary: `Sent ${amountSat} sats to ${historyAddress}`,
            detail: paymentRequest,
            detailKind: "invoice",
            type: "lightning",
            direction: "out",
            amountSat,
            feeSat: paymentResult?.feeReserveSat ?? undefined,
            mintUrl: paymentResult?.mintUrl ?? mintUrl ?? undefined,
            stateLabel: paymentResult?.state || "Paid",
          }),
          ...h,
        ]);
      } else if (isLnurlInput) {
        const payData = await (async () => {
          if (lnurlPayData && lnurlPayData.lnurl.trim().toLowerCase() === normalized.toLowerCase()) return lnurlPayData;
          const url = decodeLnurlString(normalized);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`LNURL request failed (${res.status})`);
          const data = await res.json();
          if (String(data?.tag || "").toLowerCase() !== "payrequest") {
            throw new Error("LNURL is not a pay request");
          }
          const minSendable = Number(data?.minSendable ?? 0);
          const maxSendable = Number(data?.maxSendable ?? 0);
          if (!data?.callback || !minSendable || !maxSendable) {
            throw new Error("LNURL pay metadata incomplete");
          }
          const payload: LnurlPayData = {
            lnurl: normalized,
            callback: data.callback,
            domain: extractDomain(url),
            minSendable,
            maxSendable,
            commentAllowed: Number(data?.commentAllowed ?? 0),
            metadata: typeof data?.metadata === "string" ? data.metadata : undefined,
          };
          setLnurlPayData(payload);
          return payload;
        })();

        const minSat = Math.ceil(payData.minSendable / 1000);
        const maxSat = Math.floor(payData.maxSendable / 1000);
        const amountSat = payData.minSendable === payData.maxSendable
          ? Math.floor(payData.minSendable / 1000)
          : (() => {
              const parsed = parseAmountInput(lnAddrAmt);
              if (parsed.error) throw new Error(parsed.error);
              return parsed.sats;
            })();
        if (!amountSat) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
        if (amountSat < minSat || amountSat > maxSat) {
          throw new Error(`Amount must be between ${minSat} and ${maxSat} sats`);
        }
        const params = new URLSearchParams({ amount: String(amountSat * 1000) });
        const invoiceRes = await fetch(`${payData.callback}?${params.toString()}`);
        if (!invoiceRes.ok) throw new Error("Failed to fetch LNURL invoice");
        const invoice = await invoiceRes.json();
        if (invoice?.status === "ERROR") throw new Error(invoice?.reason || "LNURL pay error");
        const paymentResult = await payMintInvoice(invoice.pr);
        toastLabel = String(amountSat);
        setHistory((h) => [
          buildHistoryEntry({
            id: `paid-lnurl-${Date.now()}`,
            summary: `Paid ${amountSat} sats via LNURL (${payData.domain})`,
            detail: invoice.pr,
            detailKind: "invoice",
            type: "lightning",
            direction: "out",
            amountSat,
            feeSat: paymentResult?.feeReserveSat ?? undefined,
            mintUrl: paymentResult?.mintUrl ?? mintUrl ?? undefined,
            stateLabel: paymentResult?.state || "Paid",
          }),
          ...h,
        ]);
        setLnurlPayData(null);
      } else if (isBolt11Input) {
        const paymentResult = await payMintInvoice(normalized);
        let boltAmountSat: number | null = null;
        try {
          const { amountMsat } = decodeBolt11Amount(normalized);
          if (amountMsat !== null) {
            boltAmountSat = Number(amountMsat / 1000n);
            const amountLabel = formatMsatAsSat(amountMsat).replace(/\s*sat$/, "");
            toastLabel = amountLabel;
          }
        } catch {
          // ignore amount parse errors
        }
        setHistory((h) => [
          buildHistoryEntry({
            id: `paid-${Date.now()}`,
            summary: `Paid lightning invoice`,
            detail: normalized,
            detailKind: "invoice",
            type: "lightning",
            direction: "out",
            amountSat: boltAmountSat ?? undefined,
            feeSat: paymentResult?.feeReserveSat ?? undefined,
            mintUrl: paymentResult?.mintUrl ?? mintUrl ?? undefined,
            stateLabel: paymentResult?.state || "Paid",
          }),
          ...h,
        ]);
      } else {
        throw new Error("Unsupported lightning input");
      }
      setLnState("done");
      setLnInput("");
      setLnAddrAmt("");
      if (toastLabel) {
        showToast(`sent ${toastLabel} sats`, 3500);
      } else {
        showToast("sent payment", 3500);
      }
      if (sendMode === "lightning") {
        closeLightningSendSheet();
      }
    } catch (e: any) {
      setLnState("error");
      setLnError(e?.message || String(e));
    }
  }

  async function handleNwcConnect() {
    const url = nwcUrlInput.trim();
    if (!url) {
      setNwcFeedback("Enter NWC connection URL");
      return;
    }
    setNwcBusy(true);
    setNwcFeedback("");
    try {
      await connectNwc(url);
      await refreshNwcInfo().catch(() => null);
      await getNwcBalanceMsat().catch(() => null);
      setNwcFeedback("NWC wallet connected");
    } catch (e: any) {
      setNwcFeedback(e?.message || String(e));
    } finally {
      setNwcBusy(false);
    }
  }

  async function handleNwcTest() {
    setNwcBusy(true);
    setNwcFeedback("");
    try {
      const latest = await refreshNwcInfo().catch(() => null);
      const balanceMsat = await getNwcBalanceMsat().catch(() => latest?.balanceMsat ?? null);
      if (typeof balanceMsat === "number") {
        setNwcFeedback(`Balance: ${Math.floor(balanceMsat / 1000)} sats`);
      } else {
        setNwcFeedback("Connection OK");
      }
    } catch (e: any) {
      setNwcFeedback(e?.message || String(e));
    } finally {
      setNwcBusy(false);
    }
  }

  function handleNwcDisconnect() {
    disconnectNwc();
    setNwcUrlInput("");
    setNwcFeedback("Disconnected");
  }

  async function handleNwcFund(amount: number, targetMintNormalized: string) {
    setNwcFundMessage("");
    try {
      if (!hasNwcConnection) throw new Error("Connect an NWC wallet first");
      if (!targetMintNormalized) throw new Error("Select a receiving mint");
      const targetMintEntry = mintEntriesByNormalized.get(targetMintNormalized);
      const targetMintUrl = targetMintEntry?.url ?? targetMintNormalized;
      setNwcFundState("creating");
      const quote = await createMintInvoice(amount, `Taskify via NWC (${amount} sat)`, { mintUrl: targetMintUrl });
      setNwcFundInvoice(quote.request);
      setNwcFundState("paying");
      await payWithNwc(quote.request);
      setNwcFundState("waiting");
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const state = await checkMintQuote(quote.quote, { mintUrl: quote.mintUrl });
        if (state === "PAID" || state === "ISSUED") {
          setNwcFundState("claiming");
          await claimMint(quote.quote, amount, { mintUrl: quote.mintUrl });
          setNwcFundState("done");
          setNwcFundMessage("");
          setHistory((h) => [
            buildHistoryEntry({
              id: `nwc-fund-${Date.now()}`,
              summary: `Funded ${amount} sats via NWC`,
              detail: quote.request,
              detailKind: "invoice",
              type: "lightning",
              direction: "in",
              amountSat: amount,
              mintUrl: quote.mintUrl ?? targetMintUrl ?? undefined,
              stateLabel: "Paid",
            }),
            ...h,
          ]);
          setNwcFundInvoice("");
          await getNwcBalanceMsat().catch(() => null);
          showToast(`received ${amount} sats`, 3500);
          closeNwcSheets();
          return;
        }
        await sleep(2500);
      }
      throw new Error("Mint invoice not paid yet. Try again in a moment.");
    } catch (e: any) {
      setNwcFundState("error");
      setNwcFundMessage(e?.message || String(e));
    }
  }

  async function handleLnurlWithdrawConfirm() {
    if (!lnurlWithdrawInfo) {
      setLnurlWithdrawMessage("Scan an LNURL withdraw code first");
      return;
    }
    setLnurlWithdrawMessage("");
    try {
      const { sats: amountSat, error } = parseAmountInput(lnurlWithdrawAmt);
      if (error) throw new Error(error);
      if (!amountSat) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
      const minSat = Math.ceil(lnurlWithdrawInfo.minWithdrawable / 1000);
      const maxSat = Math.floor(lnurlWithdrawInfo.maxWithdrawable / 1000);
      if (amountSat < minSat || amountSat > maxSat) {
        throw new Error(`Amount must be between ${minSat} and ${maxSat} sats`);
      }
      if (!mintUrl) throw new Error("Set an active mint first");

      setLnurlWithdrawState("creating");
      const description = lnurlWithdrawInfo.defaultDescription || `LNURL withdraw (${lnurlWithdrawInfo.domain})`;
      const quote = await createMintInvoice(amountSat, description);
      setLnurlWithdrawInvoice(quote.request);
      setLnurlWithdrawState("waiting");

      const params = new URLSearchParams({ k1: lnurlWithdrawInfo.k1, pr: quote.request });
      const callbackUrl = lnurlWithdrawInfo.callback.includes("?")
        ? `${lnurlWithdrawInfo.callback}&${params.toString()}`
        : `${lnurlWithdrawInfo.callback}?${params.toString()}`;

      const resp = await fetch(callbackUrl);
      let body: any = null;
      try {
        body = await resp.clone().json();
      } catch {
        // ignore parse issues for non-json responses
      }
      if (!resp.ok || body?.status === "ERROR") {
        throw new Error(body?.reason || "LNURL withdraw callback failed");
      }

      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const state = await checkMintQuote(quote.quote, { mintUrl: quote.mintUrl });
        if (state === "PAID" || state === "ISSUED") {
          await claimMint(quote.quote, amountSat, { mintUrl: quote.mintUrl });
          setLnurlWithdrawState("done");
          setLnurlWithdrawMessage("");
          setLnurlWithdrawAmt("");
          setHistory((h) => [
            buildHistoryEntry({
              id: `lnurl-withdraw-${Date.now()}`,
              summary: `Received ${amountSat} sats via LNURLw (${lnurlWithdrawInfo.domain})`,
              detail: quote.request,
              detailKind: "invoice",
              type: "lightning",
              direction: "in",
              amountSat,
              mintUrl: quote.mintUrl ?? mintUrl ?? undefined,
              stateLabel: "Paid",
            }),
            ...h,
          ]);
          showToast(`received ${amountSat} sats`, 3500);
          if (receiveMode === "lnurlWithdraw") {
            closeReceiveLnurlWithdrawSheet();
          }
          return;
        }
        await sleep(2500);
      }

      throw new Error("Withdraw still pending. Try again shortly.");
    } catch (err: any) {
      setLnurlWithdrawState("error");
      setLnurlWithdrawMessage(err?.message || String(err));
    }
  }

  async function handleNwcWithdraw(amount: number, sourceMintNormalized: string) {
    setNwcWithdrawMessage("");
    try {
      if (!hasNwcConnection) throw new Error("Connect an NWC wallet first");
      if (!sourceMintNormalized) throw new Error("Select a sending mint");
      const sourceMintEntry = mintEntriesByNormalized.get(sourceMintNormalized);
      const sourceMintUrl = sourceMintEntry?.url ?? sourceMintNormalized;
      setNwcWithdrawState("requesting");
      const msat = amount * 1000;
      const invoiceRes = await makeNwcInvoice(msat, `Taskify withdrawal ${amount} sat`);
      setNwcWithdrawInvoice(invoiceRes.invoice);
      setNwcWithdrawState("paying");
      const paymentResult = await payMintInvoice(invoiceRes.invoice, { mintUrl: sourceMintUrl });
      setHistory((h) => [
        buildHistoryEntry({
          id: `nwc-withdraw-${Date.now()}`,
          summary: `Withdrew ${amount} sats via NWC`,
          detail: invoiceRes.invoice,
          detailKind: "invoice",
          type: "lightning",
          direction: "out",
          amountSat: amount,
          feeSat: paymentResult?.feeReserveSat ?? undefined,
          mintUrl: paymentResult?.mintUrl ?? sourceMintUrl ?? undefined,
          stateLabel: paymentResult?.state || "Paid",
        }),
        ...h,
      ]);
      setNwcWithdrawState("done");
      setNwcWithdrawMessage("");
      await getNwcBalanceMsat().catch(() => null);
      showToast(`sent ${amount} sats`, 3500);
      closeNwcSheets();
    } catch (e: any) {
      setNwcWithdrawState("error");
      setNwcWithdrawMessage(e?.message || String(e));
    }
  }

  async function handleMintSwap(amount: number, fromNormalized: string, toNormalized: string) {
    setMintSwapMessage("");
    try {
      if (!fromNormalized || !toNormalized) throw new Error("Select mints for the swap");
      const fromEntry = mintEntriesByNormalized.get(fromNormalized);
      const toEntry = mintEntriesByNormalized.get(toNormalized);
      const fromUrl = fromEntry?.url ?? fromNormalized;
      const toUrl = toEntry?.url ?? toNormalized;
      setMintSwapState("creating");
      const quote = await createMintInvoice(amount, `Taskify swap ${amount} sat`, { mintUrl: toUrl });
      setMintSwapState("paying");
      const paymentResult = await payMintInvoice(quote.request, { mintUrl: fromUrl });
      setMintSwapState("waiting");
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const state = await checkMintQuote(quote.quote, { mintUrl: quote.mintUrl });
        if (state === "PAID" || state === "ISSUED") {
          setMintSwapState("claiming");
          await claimMint(quote.quote, amount, { mintUrl: quote.mintUrl });
          setMintSwapState("done");
          const fromMeta = getSwapOptionMeta(fromNormalized);
          const toMeta = getSwapOptionMeta(toNormalized);
          const timestamp = Date.now();
          setHistory((h) => [
            buildHistoryEntry({
              id: `swap-out-${timestamp}`,
              summary: `Swapped ${amount} sats from ${fromMeta.label} to ${toMeta.label}`,
              detail: quote.request,
              detailKind: "invoice",
              type: "lightning",
              direction: "out",
              amountSat: amount,
              feeSat: paymentResult?.feeReserveSat ?? undefined,
              mintUrl: paymentResult?.mintUrl ?? fromUrl ?? undefined,
              stateLabel: paymentResult?.state || "Paid",
            }),
            buildHistoryEntry({
              id: `swap-in-${timestamp + 1}`,
              summary: `Received ${amount} sats on ${toMeta.label}`,
              detail: quote.request,
              detailKind: "invoice",
              type: "lightning",
              direction: "in",
              amountSat: amount,
              mintUrl: quote.mintUrl ?? toUrl ?? undefined,
              stateLabel: "Paid",
            }),
            ...h,
          ]);
          showToast(`swapped ${amount} sats`, 3500);
          closeNwcSheets();
          return;
        }
        await sleep(2500);
      }
      throw new Error("Swap still pending. Try again shortly.");
    } catch (error: any) {
      setMintSwapState("error");
      setMintSwapMessage(error?.message || String(error));
    }
  }

  async function handleSwapSubmit() {
    const scenario = swapScenario;
    if (!scenario) {
      const message = "Select swap options";
      setMintSwapState("error");
      setMintSwapMessage(message);
      if (swapFromValue === "nwc") {
        setNwcFundState("error");
        setNwcFundMessage(message);
      }
      if (swapToValue === "nwc") {
        setNwcWithdrawState("error");
        setNwcWithdrawMessage(message);
      }
      return;
    }
    const { sats: amount, error } = parseAmountInput(swapAmount);
    if (error) {
      if (scenario === "mint-to-mint") {
        setMintSwapState("error");
        setMintSwapMessage(error);
      } else if (scenario === "nwc-to-mint") {
        setNwcFundState("error");
        setNwcFundMessage(error);
      } else if (scenario === "mint-to-nwc") {
        setNwcWithdrawState("error");
        setNwcWithdrawMessage(error);
      }
      return;
    }
    if (!amount) {
      const message = `Enter amount in ${amountInputUnitLabel}`;
      if (scenario === "mint-to-mint") {
        setMintSwapState("error");
        setMintSwapMessage(message);
      } else if (scenario === "nwc-to-mint") {
        setNwcFundState("error");
        setNwcFundMessage(message);
      } else if (scenario === "mint-to-nwc") {
        setNwcWithdrawState("error");
        setNwcWithdrawMessage(message);
      }
      return;
    }

    if (scenario === "nwc-to-mint") {
      await handleNwcFund(amount, swapToValue);
      return;
    }
    if (scenario === "mint-to-nwc") {
      await handleNwcWithdraw(amount, swapFromValue);
      return;
    }
    await handleMintSwap(amount, swapFromValue, swapToValue);
  }

  async function handleFulfillPaymentRequest() {
    if (!paymentRequestState) {
      setPaymentRequestMessage("Scan a payment request first");
      return;
    }
    const identityInfo = readNostrIdentity();
    const identity = identityInfo.identity ?? ensureNostrIdentity();
    if (!identity) {
      setPaymentRequestStatus("error");
      setPaymentRequestMessage(identityInfo.reason || "Add your Taskify Nostr key in Settings → Nostr.");
      return;
    }
    setPaymentRequestMessage("");
    setPaymentRequestStatus("sending");
    let paymentRequestToken: string | null = null;
    let createdMintUrl: string | null = null;
    let createdAmount: number | null = null;
    try {
      const request = paymentRequestState.request;
      let amount = Math.max(0, Math.floor(Number(request.amount) || 0));
      if (!amount) {
        const { sats, error } = parseAmountInput(paymentRequestManualAmount);
        if (error) throw new Error(error);
        if (!sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
        amount = sats;
      }
      if (!mintUrl) throw new Error("Set an active mint first");

      if (request.mints && request.mints.length) {
        const normalizedActive = normalizeMintUrl(mintUrl);
        const compatible = request.mints.some((m) => normalizeMintUrl(m) === normalizedActive);
        if (!compatible) {
          throw new Error("Payment request targets a different mint");
        }
      }

      if (request.unit && info?.unit && request.unit.toLowerCase() !== info.unit.toLowerCase()) {
        throw new Error(`Payment request unit ${request.unit} does not match active mint unit ${info.unit}`);
      }

      let transports = Array.isArray((request as any)?.transport)
        ? ((request as any).transport as PaymentRequestTransport[])
        : [];
      transports = transports.filter(
        (entry): entry is PaymentRequestTransport =>
          !!entry && typeof entry.type === "string" && typeof entry.target === "string",
      );
      if (!transports.length) {
        const fallback = new Map<PaymentRequestTransportType, PaymentRequestTransport>();
        const nostr = request.getTransport(PaymentRequestTransportType.NOSTR) as PaymentRequestTransport | undefined;
        if (nostr) fallback.set(PaymentRequestTransportType.NOSTR, nostr);
        const post = request.getTransport(PaymentRequestTransportType.POST) as PaymentRequestTransport | undefined;
        if (post) fallback.set(PaymentRequestTransportType.POST, post);
        transports = [...fallback.values()];
      }
      if (!transports.length) {
        throw new Error("Unsupported payment request transport");
      }

      let delivered = false;
      let deliveredDetail = "";
      createdAmount = amount;

      const {
        proofs,
        mintUrl: proofMintUrl,
        token: createdToken,
      } = await createSendToken(amount);
      paymentRequestToken = createdToken;
      createdMintUrl = proofMintUrl;
      const payload = {
        id: request.id,
        memo: request.description,
        unit: (request.unit || info?.unit || "sat").toLowerCase(),
        mint: proofMintUrl,
        proofs,
        sender: identity.pubkey,
      };

      for (const transport of transports) {
        try {
          if (transport.type === PaymentRequestTransportType.POST) {
            const resp = await fetch(transport.target, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            });
            let body: any = null;
            try {
              body = await resp.clone().json();
            } catch {
              // ignore non-json responses
            }
            if (!resp.ok || body?.status === "ERROR") {
              throw new Error(body?.reason || "Payment request endpoint failed");
            }
            delivered = true;
            deliveredDetail = transport.target;
            break;
          }

          if (transport.type === PaymentRequestTransportType.NOSTR) {
            const { identity, reason } = readNostrIdentity();
            if (!identity) {
              throw new Error(reason || "Add your Taskify Nostr key in Settings → Nostr.");
            }
            let recipientPubkey: string | null = null;
            let relayHints: string[] | undefined;
            try {
              const decoded = nip19.decode(transport.target);
              if (decoded.type === "nprofile") {
                const data = decoded.data as { pubkey?: string; relays?: string[] };
                if (typeof data.pubkey === "string") recipientPubkey = data.pubkey;
                if (Array.isArray(data.relays)) relayHints = data.relays;
              } else if (decoded.type === "npub") {
                recipientPubkey = typeof decoded.data === "string" ? decoded.data : null;
              }
            } catch {
              recipientPubkey = null;
            }
            if (!recipientPubkey) {
              throw new Error("Invalid Nostr target in payment request");
            }
            const relayList = [
              ...(relayHints || []),
              ...defaultNostrRelays,
            ]
              .filter((url): url is string => typeof url === "string" && !!url.trim())
              .map((url) => url.trim());
            const uniqueRelays = Array.from(new Set(relayList));
            if (!uniqueRelays.length) {
              throw new Error("Payment request transport missing relays");
            }
            const publishWithTimeout = async (
              signedEvent: Record<string, unknown>,
              relayTargets: string[] = uniqueRelays,
            ) => {
              const pool = ensureNostrPool();
              let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
              try {
                const publishPromise = safePublish(pool, relayTargets, signedEvent);
                const timeoutPromise = new Promise<never>((_, reject) => {
                  timeoutHandle = setTimeout(
                    () => reject(new Error("Timed out sending payment via nostr")),
                    PAYMENT_REQUEST_SEND_TIMEOUT_MS,
                  );
                });
                await Promise.race([publishPromise, timeoutPromise]);
              } finally {
                if (timeoutHandle != null) {
                  clearTimeout(timeoutHandle);
                }
              }
            };
            const supportedNips = new Set<string>();
            if (Array.isArray(transport.tags)) {
              for (const tag of transport.tags) {
                if (!Array.isArray(tag) || tag[0] !== "n") continue;
                for (let idx = 1; idx < tag.length; idx++) {
                  const value = tag[idx];
                  if (typeof value === "string" && value.trim()) {
                    supportedNips.add(value.trim());
                  }
                }
              }
            }
            const allowNip17 = supportedNips.size === 0 || supportedNips.has("17");
            if (!allowNip17) {
              throw new Error("Payment request transport does not support NIP-17 giftwrap");
            }
            if (!nip44?.v2) {
              throw new Error("NIP-44 support is required to send this payment");
            }
            const recipientHex = recipientPubkey.toLowerCase();
            const senderHex = identity.pubkey.toLowerCase();
            const publishRelays = await resolveNip17Relays(recipientHex, uniqueRelays);
            if (!publishRelays.length) {
              throw new Error("No relays available for NIP-17 inbox");
            }
            const publish = (event: NostrEvent) => publishWithTimeout(event, publishRelays);
            await publishNip17Giftwraps({
              content: JSON.stringify(payload),
              senderHex,
              recipientHex,
              senderSecret: identity.secret,
              publish,
            });
            delivered = true;
            deliveredDetail = paymentRequestToken || transport.target;
            break;
          }
        } catch (err) {
          console.warn("Payment request transport failed", err);
          continue;
        }
      }

      if (!delivered) {
        throw new Error("Unable to send payment via provided transports");
      }

      const deliveredSummary = deliveredDetail && deliveredDetail !== paymentRequestToken
        ? `Sent ${amount} sats via payment request (${deliveredDetail})`
        : `Sent ${amount} sats via payment request`;
      const historyDetail = paymentRequestToken || deliveredDetail || undefined;
      const historyDetailKind: HistoryDetailKind | undefined = paymentRequestToken
        ? "token"
        : deliveredDetail
          ? "note"
          : undefined;

      setPaymentRequestStatus("done");
      setPaymentRequestMessage("");
      setHistory((h) => [
        buildHistoryEntry({
          id: `payment-request-${Date.now()}`,
          summary: deliveredSummary,
          detail: historyDetail,
          detailKind: historyDetailKind,
          type: "ecash",
          direction: "out",
          amountSat: amount,
          mintUrl,
        }),
        ...h,
      ]);
      showToast(`sent ${amount} sats`, 3500);
      if (sendMode === "paymentRequest") {
        closePaymentRequestSheet();
      }
    } catch (err: any) {
      if (paymentRequestToken && createdMintUrl && createdAmount != null) {
        setHistory((h) => [
          buildHistoryEntry({
            id: `payment-request-failed-${Date.now()}`,
            summary: `Payment request token for ${createdAmount} sats (not sent)`,
            detail: paymentRequestToken,
            detailKind: "token",
            revertToken: paymentRequestToken,
            type: "ecash",
            direction: "out",
            amountSat: createdAmount,
            mintUrl: createdMintUrl,
          }),
          ...h,
        ]);
      }
      setPaymentRequestStatus("error");
      setPaymentRequestMessage(err?.message || String(err));
    }
  }

  const contactInitials = (value: string) => {
    const parts = (value || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    const cp = parts[0].codePointAt(0) ?? 0;
    const isEmoji = (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x1f900 && cp <= 0x1f9ff);
    if (isEmoji) return [...parts[0]][0] ?? "?";
    if (parts.length === 1) return [...parts[0]].slice(0, 2).join("").toUpperCase();
    return ([...parts[0]][0] ?? "" + ([...parts[parts.length - 1]][0] ?? "")).toUpperCase();
  };

  const contactSubtitle = useCallback(
    (contact: Contact) => {
      const nip05 = contact.nip05?.trim() || "";
      const npub = contact.npub?.trim() || "";
      const normalizedNip05 = normalizeNip05(nip05);
      const normalizedNpub = normalizeNostrPubkey(npub);
      const contactHex = normalizedNpub ? compressedToRawHex(normalizedNpub).toLowerCase() : null;
      const nip05Check = contact.id && normalizedNip05 ? nip05Checks[contact.id] : undefined;
      const nip05Verified =
        !!nip05Check &&
        nip05Check.status === "valid" &&
        nip05Check.nip05 === normalizedNip05 &&
        nip05Check.npub === contactHex;
      const nip05Display = nip05Verified || (!contactHex && nip05) ? nip05 : "";
      const hasPaymentRequest = !!contact.paymentRequest.trim();

      return (
        nip05Display ||
        contact.address.trim() ||
        npub ||
        (hasPaymentRequest ? "Payment request saved" : "") ||
        contact.displayName?.trim() ||
        ""
      );
    },
    [compressedToRawHex, nip05Checks, normalizeNip05, normalizeNostrPubkey],
  );

  const myCardUsername = formatContactUsername(profileForm.username);
  const myCardName = profileForm.displayName.trim() || myCardUsername || "My Card";
  const myCardLightning = profileForm.lud16.trim() || deriveDefaultLightningAddress();
  const myCardNpub = useMemo(() => {
    const identity = readNostrIdentity().identity ?? nostrIdentityRef.current;
    return identity ? formatNpub(identity.pubkey) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatNpub, readNostrIdentity, profileSharePayload]);
  const myCardSubtitle =
    myCardLightning || profileForm.nip05.trim() || myCardNpub || "My Card";
  const profileCard = {
    id: "profile",
    name: myCardName,
    displayName: profileForm.displayName.trim(),
    username: sanitizeUsername(profileForm.username),
    address: myCardLightning,
    npub: myCardNpub,
    nip05: profileForm.nip05.trim(),
    about: profileForm.about.trim(),
    picture: profileForm.picture.trim(),
    updatedAt: profileUpdatedAt,
  };

  const activeContact =
    activeContactId && activeContactId !== "profile"
      ? contacts.find((entry) => entry.id === activeContactId) || null
      : null;
  const detailTarget = activeContactId === "profile" ? profileCard : activeContact;
  const detailShareValue =
    activeContactId === "profile"
      ? profileShareValue
      : activeContact
        ? buildContactShareValue(activeContact)
        : null;
  const detailUsername = detailTarget ? formatContactUsername(detailTarget.username) : "";
  const buildContactFields = useCallback(
    (contact: Contact | typeof profileCard | null | undefined) => {
      if (!contact) return [] as { key: string; label: string; value: string; multiline?: boolean }[];
      const formattedUsername = formatContactUsername(contact.username);
      const formattedNpub = formatContactNpub(contact.npub);
      return (
        [
          contact.address && { key: "lightning", label: "Lightning", value: contact.address },
          formattedNpub && { key: "npub", label: "Nostr pubkey", value: formattedNpub },
          contact.nip05 && { key: "nip05", label: "NIP-05", value: contact.nip05 },
          formattedUsername && { key: "username", label: "Username", value: formattedUsername },
          contact.about && { key: "about", label: "About", value: contact.about, multiline: true },
        ].filter(Boolean) as { key: string; label: string; value: string; multiline?: boolean }[]
      );
    },
    [formatContactNpub, formatContactUsername],
  );
  const detailFields = buildContactFields(detailTarget);
  const detailHasLightning = activeContact ? contactHasLightning(activeContact) : false;
  const detailCanShare = activeContact ? contactHasNpub(activeContact) : false;

  const verifyContactNip05 = useCallback(
    async (contactId: string, nip05: string, npub: string, contactUpdatedAt?: number | null) => {
      const contactPubkeyHex = compressedToRawHex(npub).toLowerCase();
      setNip05Checks((prev) => ({
        ...prev,
        [contactId]: {
          status: "pending",
          nip05,
          npub: contactPubkeyHex,
          checkedAt: Date.now(),
          contactUpdatedAt: contactUpdatedAt ?? null,
        },
      }));
      try {
        const resolution = await resolveNip05Record(nip05);
        const resolvedPubkey = compressedToRawHex(
          normalizeNostrPubkey(resolution.pubkey) ?? resolution.pubkey,
        ).toLowerCase();
        setNip05Checks((prev) => ({
          ...prev,
          [contactId]: {
            status: resolvedPubkey === contactPubkeyHex ? "valid" : "invalid",
            nip05,
            npub: contactPubkeyHex,
            checkedAt: Date.now(),
            contactUpdatedAt: contactUpdatedAt ?? null,
          },
        }));
      } catch {
        setNip05Checks((prev) => ({
          ...prev,
          [contactId]: {
            status: "invalid",
            nip05,
            npub: contactPubkeyHex,
            checkedAt: Date.now(),
            contactUpdatedAt: contactUpdatedAt ?? null,
          },
        }));
      }
    },
    [compressedToRawHex, normalizeNostrPubkey, resolveNip05Record],
  );

  const ensureNip05Verification = useCallback(
    (contactId: string, nip05?: string | null, npub?: string | null, contactUpdatedAt?: number | null) => {
      if (!contactId || !nip05 || !npub) return;
      const normalizedNip05 = normalizeNip05(nip05);
      const normalizedNpub = normalizeNostrPubkey(npub);
      if (!normalizedNip05 || !normalizedNpub) return;
      const contactPubkeyHex = compressedToRawHex(normalizedNpub).toLowerCase();
      const existingCheck = nip05Checks[contactId];
      if (
        existingCheck &&
        existingCheck.nip05 === normalizedNip05 &&
        existingCheck.npub === contactPubkeyHex
      ) {
        if (existingCheck.status === "pending") {
          return;
        }
        const cachedUpdatedAt = existingCheck.contactUpdatedAt ?? null;
        const targetUpdatedAt = contactUpdatedAt ?? null;
        if (cachedUpdatedAt != null) {
          if (targetUpdatedAt == null || targetUpdatedAt <= cachedUpdatedAt) {
            return;
          }
        } else if (targetUpdatedAt == null) {
          return;
        }
      }
      void verifyContactNip05(contactId, normalizedNip05, normalizedNpub, contactUpdatedAt);
    },
    [compressedToRawHex, nip05Checks, normalizeNip05, normalizeNostrPubkey, verifyContactNip05],
  );

  useEffect(() => {
    if (!detailTarget?.id) return;
    ensureNip05Verification(detailTarget.id, detailTarget.nip05, detailTarget.npub, detailTarget.updatedAt ?? null);
  }, [detailTarget, ensureNip05Verification]);

  const isNip05VerifiedFor = useCallback(
    (contactId: string, nip05?: string | null, npub?: string | null) => {
      if (!contactId) return false;
      const normalizedNip05 = normalizeNip05(nip05 ?? null);
      const normalizedNpub = normalizeNostrPubkey(npub ?? null);
      if (!normalizedNip05 || !normalizedNpub) return false;
      const nip05Check = nip05Checks[contactId];
      if (!nip05Check) return false;
      const contactPubkeyHex = compressedToRawHex(normalizedNpub).toLowerCase();
      return (
        nip05Check.status === "valid" &&
        nip05Check.nip05 === normalizedNip05 &&
        nip05Check.npub === contactPubkeyHex
      );
    },
    [compressedToRawHex, nip05Checks, normalizeNip05, normalizeNostrPubkey],
  );

  useEffect(() => {
    ensureNip05VerificationRef.current = ensureNip05Verification;
  }, [ensureNip05Verification]);

  useEffect(() => {
    isNip05VerifiedForRef.current = isNip05VerifiedFor;
  }, [isNip05VerifiedFor]);

    const detailNip05Normalized = normalizeNip05(detailTarget?.nip05 ?? null);
    const detailNpubHex = detailTarget?.npub
      ? compressedToRawHex(normalizeNostrPubkey(detailTarget.npub) ?? detailTarget.npub).toLowerCase()
      : null;
    const detailNip05Verified =
      !!detailNip05Normalized &&
      !!detailNpubHex &&
      isNip05VerifiedFor(detailTarget?.id ?? "", detailTarget?.nip05, detailTarget?.npub);

    const scannedContactTitle = scannedContact ? contactPrimaryName(scannedContact) : "Contact";
    const scannedContactUsername = scannedContact ? formatContactUsername(scannedContact.username) : "";
    const scannedContactShareValue = scannedContact ? buildContactShareValue(scannedContact) : null;
    const scannedContactFields = buildContactFields(scannedContact);
    const scannedContactNip05Verified = scannedContact
      ? isNip05VerifiedFor(scannedContact.id, scannedContact.nip05, scannedContact.npub)
      : false;
    const scannedContactSaved = useMemo(() => {
      if (!scannedContact) return false;
      const normalizedTarget = normalizeNostrPubkey(scannedContact.npub || "");
      const targetHex = normalizedTarget ? compressedToRawHex(normalizedTarget).toLowerCase() : null;
      return contacts.some((contact) => {
        if (contact.id === scannedContact.id) return true;
        if (targetHex) {
          const normalizedContact = normalizeNostrPubkey(contact.npub || "");
          const contactHex = normalizedContact ? compressedToRawHex(normalizedContact).toLowerCase() : null;
          if (contactHex && contactHex === targetHex) return true;
        }
        return false;
      });
    }, [compressedToRawHex, contacts, normalizeNostrPubkey, scannedContact]);
    const scannedContactFollowed = useMemo(() => {
      if (!scannedContact?.npub) return false;
      const normalized = normalizeNostrPubkey(scannedContact.npub);
      if (!normalized) return false;
      const targetHex = compressedToRawHex(normalized).toLowerCase();
      return (contactSyncMeta.publicFollows || []).some(
        (follow) => (follow.pubkey || "").toLowerCase() === targetHex,
      );
    }, [compressedToRawHex, contactSyncMeta.publicFollows, normalizeNostrPubkey, scannedContact]);
    const scannedContactCanShare = !!scannedContact && contactHasNpub(scannedContact);
    const scannedContactCanFollow = !!scannedContact && scannedContactSaved && !!scannedContact.npub.trim();
    useEffect(() => {
      if (!scannedContact?.id) return;
      ensureNip05Verification(
        scannedContact.id,
        scannedContact.nip05,
        scannedContact.npub,
        scannedContact.updatedAt ?? null,
      );
    }, [ensureNip05Verification, scannedContact]);

    const handleSaveScannedContact = useCallback(() => {
      if (!scannedContact || scannedContactSaved) return;
      const saved = upsertContact({ ...scannedContact, source: scannedContact.source ?? "scan" });
      if (!saved) {
        showToast("Unable to add contact", 2500);
        return;
      }
      setScannedContact(saved);
      contactsPublishQueuedRef.current = true;
      if (contactsSyncEnabled) {
        void publishContactsToNostr({ silent: true });
      }
      showToast("Contact added", 2000);
    }, [
      contactsPublishQueuedRef,
      contactsSyncEnabled,
      publishContactsToNostr,
      scannedContact,
      scannedContactSaved,
      showToast,
      upsertContact,
    ]);

    const handleToggleFollowScannedContact = useCallback(() => {
      if (!scannedContact) return;
      const normalized = normalizeNostrPubkey(scannedContact.npub);
      if (!normalized) {
        showToast("Contact is missing a valid npub to follow.", 2500);
        return;
      }
      const pubkeyHex = compressedToRawHex(normalized).toLowerCase();
      const withoutExisting = (contactSyncMeta.publicFollows || []).filter(
        (follow) => (follow.pubkey || "").toLowerCase() !== pubkeyHex,
      );
      const updatedFollows = scannedContactFollowed
        ? withoutExisting
        : [
            ...withoutExisting,
            {
              pubkey: pubkeyHex,
              username: sanitizeUsername(scannedContact.username || ""),
              nip05: scannedContact.nip05?.trim() || undefined,
            },
          ];
      const nextMeta = persistContactSyncMeta({ publicFollows: updatedFollows });
      contactsPublishQueuedRef.current = true;
      if (contactsSyncEnabled) {
        const nextFollows = nextMeta?.publicFollows ?? updatedFollows;
        void publishContactsToNostr({ silent: true, publicFollowsOverride: nextFollows });
      }
      showToast(scannedContactFollowed ? "Unfollowed contact" : "Following contact", 2000);
    }, [
      compressedToRawHex,
      contactSyncMeta.publicFollows,
      contactsPublishQueuedRef,
      contactsSyncEnabled,
      normalizeNostrPubkey,
      persistContactSyncMeta,
      publishContactsToNostr,
      sanitizeUsername,
      scannedContact,
      scannedContactFollowed,
      showToast,
    ]);

    const scannedContactHeader = scannedContact ? (
      <div className="contacts-sheet-header contacts-sheet-header--detail">
        <button
          className="glass-icon-button pressable"
          onClick={() => setScannedContact(null)}
          aria-label="Close contact"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
        <div className="contacts-header-spacer" aria-hidden="true" />
        {!scannedContactSaved ? (
          <button
            type="button"
            className="contact-pill contact-pill--accent contact-pill--compact contact-pill--wrap pressable"
            onClick={handleSaveScannedContact}
          >
            Add contact
          </button>
        ) : scannedContactCanFollow ? (
          <button
            type="button"
            className="contact-pill contact-pill--accent contact-pill--compact pressable"
            onClick={handleToggleFollowScannedContact}
          >
            {scannedContactFollowed ? "Unfollow" : "Follow"}
          </button>
        ) : (
          <div className="contacts-header-spacer" aria-hidden="true" />
        )}
      </div>
    ) : null;

  useEffect(() => {
    const candidates: { id: string; nip05: string; npub: string; updatedAt?: number | null }[] = [];
    const seen = new Set<string>();
    const addCandidate = (contact: Contact | typeof profileCard) => {
      if (!contact.id || !contact.nip05 || !contact.npub) return;
      const normalizedNip05 = normalizeNip05(contact.nip05);
      const normalizedNpub = normalizeNostrPubkey(contact.npub);
      if (!normalizedNip05 || !normalizedNpub) return;
      const key = `${contact.id}:${normalizedNip05}`;
      if (seen.has(key)) return;
      seen.add(key);
      const updatedAt = (contact as Contact).updatedAt ?? (contact === profileCard ? profileUpdatedAt : null);
      candidates.push({ id: contact.id, nip05: normalizedNip05, npub: normalizedNpub, updatedAt });
    };

    if (contactsTabOpen) {
      addCandidate(profileCard);
      sortedContacts.forEach(addCandidate);
    }

    if (contactsOpen && contactsContext) {
      visibleContacts.forEach(addCandidate);
    }

    candidates.forEach(({ id, nip05, npub, updatedAt }) => ensureNip05Verification(id, nip05, npub, updatedAt));
  }, [
    contactsContext,
    contactsOpen,
    contactsTabOpen,
    ensureNip05Verification,
    normalizeNip05,
    normalizeNostrPubkey,
    profileCard,
    profileUpdatedAt,
    sortedContacts,
    visibleContacts,
  ]);

  const handleStartEditCurrentContact = useCallback(() => {
    const source = activeContactId === "profile" ? profileCard : activeContact;
    if (!source) {
      resetContactEditDraft();
    } else {
      setContactEditDraft({
        id: source.id === "profile" ? null : source.id,
        name: source.name || "",
        displayName: source.displayName || "",
        username: sanitizeUsername(source.username || ""),
        address: source.address || "",
        npub: source.npub || "",
        nip05: source.nip05 || "",
        about: source.about || "",
        picture: source.picture || "",
        isProfile: activeContactId === "profile",
      });
    }
    setContactEditError("");
    setProfilePhotoError("");
    setProfilePhotoBusy(false);
    profilePhotoUploadRef.current = null;
    setContactLookupError("");
    setContactLookupInput("");
    setShowCustomContactFields(true);
    setContactView("edit");
  }, [activeContact, activeContactId, profileCard, resetContactEditDraft]);

    const handleCancelContactEdit = useCallback(() => {
      setContactEditError("");
      setContactLookupError("");
      setShowCustomContactFields(false);
      setContactView(detailTarget ? "detail" : "list");
    }, [detailTarget]);

    const detailTitle = detailTarget ? contactPrimaryName(detailTarget) : "Contact";
    const detailIsNostrContact = useMemo(() => {
      if (!detailTarget) return false;
      if (detailTarget.id === "profile" || (detailTarget as any).isProfile || detailTarget.kind === "custom") {
        return false;
      }
      const hasNpub = !!normalizeNostrPubkey(detailTarget.npub || "");
      const hasVerifiedNip05 = !!(
        detailTarget.nip05 &&
        isNip05VerifiedFor(detailTarget.id, detailTarget.nip05, detailTarget.npub)
      );
      return hasNpub || hasVerifiedNip05;
    }, [detailTarget, isNip05VerifiedFor, normalizeNostrPubkey]);
    const detailContactFollowed = useMemo(() => {
      if (!detailTarget?.npub) return false;
      const normalized = normalizeNostrPubkey(detailTarget.npub);
      if (!normalized) return false;
      const targetHex = compressedToRawHex(normalized).toLowerCase();
      return (contactSyncMeta.publicFollows || []).some(
        (follow) => (follow.pubkey || "").toLowerCase() === targetHex,
      );
    }, [compressedToRawHex, contactSyncMeta.publicFollows, detailTarget, normalizeNostrPubkey]);
    const detailContactCanFollow = !!detailTarget && detailIsNostrContact && !!detailTarget.npub.trim();
    const handleToggleFollowDetailContact = useCallback(() => {
      if (!detailTarget) return;
      const normalized = normalizeNostrPubkey(detailTarget.npub);
      if (!normalized) return;
      const pubkeyHex = compressedToRawHex(normalized).toLowerCase();
      const withoutExisting = (contactSyncMeta.publicFollows || []).filter(
        (follow) => (follow.pubkey || "").toLowerCase() !== pubkeyHex,
      );
      const updatedFollows = detailContactFollowed
        ? withoutExisting
        : [
            ...withoutExisting,
            {
              pubkey: pubkeyHex,
              username: sanitizeUsername(detailTarget.username || ""),
              nip05: detailTarget.nip05?.trim() || undefined,
            },
          ];
      const nextMeta = persistContactSyncMeta({ publicFollows: updatedFollows });
      contactsPublishQueuedRef.current = true;
      if (contactsSyncEnabled) {
        const nextFollows = nextMeta?.publicFollows ?? updatedFollows;
        void publishContactsToNostr({ silent: true, publicFollowsOverride: nextFollows });
      }
      showToast(detailContactFollowed ? "Unfollowed contact" : "Following contact", 2000);
    }, [
      compressedToRawHex,
      contactSyncMeta.publicFollows,
      contactsPublishQueuedRef,
      contactsSyncEnabled,
      detailContactFollowed,
      detailTarget,
      normalizeNostrPubkey,
      persistContactSyncMeta,
      publishContactsToNostr,
      sanitizeUsername,
      showToast,
    ]);

    const profileHeaderPhoto = profileCard.picture?.trim();
    const contactsHeaderTitle =
      contactView === "edit"
        ? contactEditDraft.isProfile
          ? "Edit My Card"
          : contactEditDraft.id
            ? "Edit Contact"
            : "New Contact"
        : contactView === "detail"
          ? ""
          : isContactsPage
            ? ""
            : "Contacts";

    const contactsHeaderLeft =
      contactView === "list" && isContactsPage ? (
        <button
          type="button"
          className={`contact-avatar pressable${profileHeaderPhoto ? " contact-avatar--image contact-avatar--profile" : " contact-avatar--profile"}`}
          onClick={() => {
            setActiveContactId("profile");
            setContactView("detail");
          }}
          aria-label="Open profile"
          title="Open profile"
        >
          {profileHeaderPhoto ? (
            <img src={profileHeaderPhoto} alt={myCardName} className="contact-avatar__img" />
          ) : (
            contactInitials(myCardName)
          )}
        </button>
      ) : contactView === "list" ? (
        <button
          className="glass-icon-button pressable"
          onClick={closeContactsTab}
          aria-label="Close contacts"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      ) : contactView === "detail" ? (
        <button
          className="glass-icon-button pressable"
          onClick={handleBackToContactsList}
          aria-label="Back to contacts"
        >
          <BackIcon className="h-5 w-5" />
        </button>
      ) : (
        <button
          className="glass-icon-button pressable"
          onClick={handleCancelContactEdit}
          aria-label="Cancel contact changes"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      );

    const contactsHeaderRight =
      contactView === "list" ? (
        <button
          type="button"
          className="glass-icon-button glass-icon-button--accent pressable"
          onClick={handleStartAddContact}
          title="Add contact"
          aria-label="Add contact"
        >
          <span className="text-xl leading-none">+</span>
        </button>
      ) : contactView === "detail" && detailTarget ? (
        detailIsNostrContact ? (
          detailContactCanFollow ? (
            <button
              type="button"
              className="contact-pill contact-pill--accent contact-pill--compact pressable"
              onClick={handleToggleFollowDetailContact}
            >
              {detailContactFollowed ? "Unfollow" : "Follow"}
            </button>
          ) : (
            <div className="contacts-header-spacer" aria-hidden="true" />
          )
        ) : (
          <button
            type="button"
            className="glass-icon-button glass-icon-button--accent pressable"
            onClick={handleStartEditCurrentContact}
            aria-label="Edit contact"
          >
            <PencilIcon className="h-4 w-4" />
          </button>
        )
      ) : contactView === "edit" ? (
        <button
          type="button"
          className="glass-icon-button glass-icon-button--accent pressable"
          aria-label="Save contact"
          onClick={() => {
            void handleContactEditSubmit();
          }}
          disabled={contactsPublishState === "publishing" || profileStatus === "publishing" || profilePhotoBusy}
        >
          <CheckIcon className="h-4 w-4" />
        </button>
      ) : (
        <div className="contacts-header-spacer" aria-hidden="true" />
      );

    const contactsHeader = (
      <div className="contacts-sheet-header contacts-sheet-header--detail">
        {contactsHeaderLeft}
        {contactsHeaderTitle ? (
          <div className="contacts-sheet-title">{contactsHeaderTitle}</div>
        ) : (
          <div className="contacts-header-spacer" aria-hidden="true" />
        )}
        {contactsHeaderRight}
      </div>
    );

  const handleCopyContactField = useCallback(
    async (value: string, label: string) => {
      if (!value) return;
      try {
        await navigator.clipboard?.writeText(value);
        showToast(`${label} copied`, 2000);
      } catch {
        showToast("Unable to copy", 2000);
      }
    },
    [showToast],
  );

  const processProfilePhotoFile = useCallback(
    async (file: File): Promise<{ dataUrl: string; blob: Blob; contentType: string; name?: string } | null> => {
      if (!file) return null;
      if (!file.type?.startsWith("image/")) {
        setProfilePhotoError("Choose an image file.");
        return null;
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
          reader.onerror = () => reject(new Error("Unable to read file."));
          reader.readAsDataURL(file);
        });
        const trimmed = dataUrl.trim();
        if (!trimmed) {
          setProfilePhotoError("Unable to read image.");
          return null;
        }
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("Unable to load image."));
          img.src = trimmed;
        });
        const initialSize = estimateDataUrlSize(trimmed);
        const needsResize =
          image.width > PROFILE_PHOTO_MAX_DIMENSION || image.height > PROFILE_PHOTO_MAX_DIMENSION;
        if (!needsResize && initialSize <= PROFILE_PHOTO_CACHE_LIMIT_BYTES) {
          const blobDirect = await fetch(trimmed).then((res) => res.blob());
          return {
            dataUrl: trimmed,
            blob: blobDirect,
            contentType: blobDirect.type || file.type || "image/jpeg",
            name: file.name,
          };
        }
        const maxSide = Math.max(image.width || 1, image.height || 1);
        const scale = maxSide ? Math.min(1, PROFILE_PHOTO_MAX_DIMENSION / maxSide) : 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((image.width || PROFILE_PHOTO_MAX_DIMENSION) * scale));
        canvas.height = Math.max(
          1,
          Math.round((image.height || PROFILE_PHOTO_MAX_DIMENSION) * scale),
        );
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return trimmed;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        let quality = 0.9;
        let output = canvas.toDataURL("image/jpeg", quality);
        let outputSize = estimateDataUrlSize(output);
        while (outputSize > PROFILE_PHOTO_CACHE_LIMIT_BYTES && quality > 0.55) {
          quality -= 0.1;
          output = canvas.toDataURL("image/jpeg", quality);
          outputSize = estimateDataUrlSize(output);
        }
        if (outputSize > PROFILE_PHOTO_CACHE_LIMIT_BYTES) {
          setProfilePhotoError("Profile photo is too large after compression.");
          return null;
        }
        const blob = await fetch(output).then((res) => res.blob());
        return {
          dataUrl: output,
          blob,
          contentType: blob.type || file.type || "image/jpeg",
          name: file.name,
        };
      } catch (error: any) {
        setProfilePhotoError(error?.message || "Unable to process photo.");
        return null;
      }
    },
    [],
  );

  const handleProfilePhotoChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] || null;
      event.target.value = "";
      if (!file) return;
      setProfilePhotoError("");
      setProfilePhotoBusy(true);
      try {
        const processed = await processProfilePhotoFile(file);
        if (!processed) return;
        profilePhotoUploadRef.current = {
          blob: processed.blob,
          name: processed.name,
          contentType: processed.contentType,
        };
        setContactEditDraft((prev) => ({ ...prev, picture: processed.dataUrl }));
      } finally {
        setProfilePhotoBusy(false);
      }
    },
    [processProfilePhotoFile],
  );

  const handleClearProfilePhoto = useCallback(() => {
    setProfilePhotoError("");
    setContactEditDraft((prev) => ({ ...prev, picture: "" }));
    profilePhotoUploadRef.current = null;
  }, []);

  const handleContactEditSubmit = useCallback(
    async (event?: React.FormEvent) => {
      if (event) event.preventDefault();
      const nickname = contactEditDraft.name.trim();
      const displayName = contactEditDraft.displayName.trim();
      const username = sanitizeUsername(contactEditDraft.username);
      const address = contactEditDraft.address.trim();
      const npub = contactEditDraft.npub.trim();
      const nip05 = contactEditDraft.nip05.trim();
      const about = contactEditDraft.about.trim();
      const picture = contactEditDraft.picture.trim();
      const primaryName = contactEditDraft.isProfile
        ? displayName || username
        : nickname || displayName || username;
      if (!primaryName && !address && !npub && !nip05 && !about && !picture) {
        setContactEditError(
          contactEditDraft.isProfile
            ? "Add a display name or another detail to save."
            : "Add a nickname or another detail to save.",
        );
        return;
      }
      if (contactEditDraft.isProfile) {
        const currentDisplayName = displayName || profileForm.displayName;
        let nextPicture = picture;
        if (profilePhotoUploadRef.current) {
          const identity = ensureNostrIdentity();
          if (!identity) {
            setProfileStatus("error");
            setProfileMessage(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr.");
            setContactEditError(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr.");
            return;
          }
          setProfilePhotoBusy(true);
          setProfilePhotoError("");
          setProfileMessage("Uploading profile photo…");
          try {
            const servers = parseFileServers(fileServers);
            const serverEntry = findServerEntry(servers, preferredFileServer)
              ?? { url: preferredFileServer, type: "nip96" as FileServerType };
            const upload = await uploadAvatar({
              serverEntry,
              file: profilePhotoUploadRef.current.blob,
              filename: profilePhotoUploadRef.current.name || "avatar.jpg",
              contentType: profilePhotoUploadRef.current.contentType,
              signer: identity.secret,
            });
            nextPicture = upload.url;
            profilePhotoUploadRef.current = null;
          } catch (err: any) {
            const message = err?.message || "Unable to upload profile photo.";
            setProfilePhotoError(message);
            setProfileStatus("error");
            setProfileMessage(message);
            console.warn("[profile] Profile photo upload failed", err);
            return;
          } finally {
            setProfilePhotoBusy(false);
          }
        } else if (isDataUrl(nextPicture)) {
          const message = "Upload your profile photo before publishing.";
          setProfilePhotoError(message);
          setProfileStatus("error");
          setProfileMessage(message);
          return;
        }
        const profileDraft = {
          displayName: currentDisplayName,
          username,
          lud16: address || deriveDefaultLightningAddress(),
          nip05,
          about,
          picture: nextPicture,
        };
        setProfileForm((prev) => ({
          ...prev,
          displayName: profileDraft.displayName || prev.displayName,
          username: profileDraft.username || prev.username,
          lud16: profileDraft.lud16 || prev.lud16,
          nip05: profileDraft.nip05 || prev.nip05,
          about: profileDraft.about || prev.about,
          picture: profileDraft.picture ?? prev.picture,
        }));
        const published = await publishProfileMetadata(profileDraft);
        if (published) {
          setProfilePhotoError("");
          setContactEditDraft((prev) => ({ ...prev, picture: profileDraft.picture || "" }));
          setContactEditError("");
          setContactView("detail");
          setActiveContactId("profile");
        }
        return;
      }
      const preservedPaymentRequest = contactEditDraft.id
        ? (contactsRef.current.find((entry) => entry.id === contactEditDraft.id)?.paymentRequest ?? "")
        : "";
      const saved = upsertContact({
        id: contactEditDraft.id || undefined,
        name: nickname || displayName || username || address || npub,
        displayName,
        username,
        address,
        paymentRequest: preservedPaymentRequest,
        npub,
        nip05,
        about,
        picture,
        source: "manual",
        updatedAt: Date.now(),
      });
      if (!saved) {
        setContactEditError("Unable to save contact.");
        return;
      }
      if (contactsSyncEnabled) {
        contactsPublishQueuedRef.current = true;
        void publishContactsToNostr({ silent: true });
      } else {
        contactsPublishQueuedRef.current = false;
      }
      setContactEditError("");
      setContactView("detail");
      setActiveContactId(saved.id);
    },
    [
      contactEditDraft,
      deriveDefaultLightningAddress,
      contactsSyncEnabled,
      ensureNostrIdentity,
      nostrMissingReason,
      preferredFileServer,
      fileServers,
      profileForm,
      publishContactsToNostr,
      publishProfileMetadata,
      setProfileMessage,
      setProfilePhotoBusy,
      setProfilePhotoError,
      setProfileStatus,
      setProfileForm,
      upsertContact,
      uploadAvatar,
    ],
  );

  const walletRootClass = `wallet-modal${showBottomNav ? " wallet-modal--with-nav" : ""}${isContactsPage ? " wallet-modal--contacts" : ""}`;
  const contactsPanelInline = !showTabSwitcher && isContactsPage;
  const contactsPanelOpen = contactsTabOpen || contactsPanelInline;
  const showWalletTabSwitcher = showTabSwitcher && !isContactsPage;

  if (!open) return null;

  return (
    <div className={walletRootClass}>
      {!isContactsPage && (
        <>
          <div className="wallet-modal__header">
            <button className="ghost-button button-sm pressable" onClick={onClose}>Close</button>
            {walletTab !== "messages" && (
              <>
                <button
                  type="button"
                  className={unitButtonClass}
                  onClick={handleTogglePrimary}
                  aria-disabled={!canToggleCurrency}
                  title={canToggleCurrency ? "Toggle primary currency" : "Currency toggle available when conversion is enabled"}
                >
                  {unitLabel}
                </button>
                <button className="ghost-button button-sm pressable" onClick={()=>setShowHistory(true)}>History</button>
              </>
            )}
          </div>
          {walletTab !== "messages" && (
            <div className="wallet-modal__toolbar">
              <button className="ghost-button button-sm pressable" onClick={()=>setShowMintBalances(true)}>Mints</button>
              <button className="ghost-button button-sm pressable" onClick={()=>setShowNwcSheet(true)}>Swap</button>
              {onOpenBounties && (
                <button className="ghost-button button-sm pressable" onClick={onOpenBounties}>
                  Bounties
                </button>
              )}
            </div>
          )}
          <div className={contentClass}>
            {walletTab === "wallet" && (
              <>
            <button
              type="button"
              className={balanceCardClass}
              onClick={handleTogglePrimary}
              disabled={!canToggleCurrency}
              title={
                canToggleCurrency
                  ? "Toggle primary currency"
                  : "Currency toggle available when conversion is enabled"
              }
              aria-label={
                canToggleCurrency
                  ? "Toggle wallet primary currency"
                  : "Wallet currency toggle disabled"
              }
            >
              <div className="wallet-balance-card__amount">{primaryAmountDisplay}</div>
              {secondaryAmountDisplay && (
                <div className="wallet-balance-card__secondary">{secondaryAmountDisplay}</div>
              )}
              {(pendingBalanceDisplay || priceMeta) && (
                <div className="wallet-balance-card__meta space-y-1">
                  {pendingBalanceDisplay && <div>{pendingBalanceDisplay}</div>}
                  {priceMeta && <div>{priceMeta}</div>}
                </div>
              )}
            </button>
            <div className="wallet-modal__cta">
              <button className="accent-button pressable" onClick={openReceiveLightningSheet}>{"Receive"}</button>
              <button
                type="button"
                className="wallet-modal__scan-button pressable"
                onClick={()=>{ void openScanner(); }}
                aria-label="Scan code"
                title="Scan code"
              >
                <svg className="wallet-modal__scan-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 6h2.4l1.1-2h3l1.1 2H17a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
                  <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" fill="none" />
                  <circle cx="18.25" cy="9.25" r="0.75" fill="currentColor" />
                </svg>
              </button>
              <button className="ghost-button pressable" onClick={openLightningSendSheet}>Send</button>
            </div>
              </>
            )}
            {walletTab === "messages" && (
              <div className="wallet-messages">
            <div className="wallet-messages__search">
              <input
                className="wallet-messages__search-input"
                placeholder="Search"
                value={dmSearch}
                onChange={(event) => setDmSearch(event.target.value)}
              />
            </div>
            <div className="wallet-messages__body">
              {dmView === "list" && (
                <div className="wallet-messages__list space-y-2">
                {showStrangersOnly && (
                  <button
                    className="wallet-messages__thread pressable"
                    onClick={() => {
                      setShowStrangersOnly(false);
                    }}
                  >
                    <div className="wallet-messages__avatar wallet-messages__avatar--stranger">⇠</div>
                    <div className="wallet-messages__thread-body">
                      <div className="wallet-messages__thread-title">Back to everyone</div>
                      <div className="wallet-messages__thread-preview">View all conversations</div>
                    </div>
                  </button>
                )}
                {!showStrangersOnly && dmThreads.some((t) => t.isStranger) && (
                  <button
                    className="wallet-messages__thread wallet-messages__thread--stranger pressable"
                    onClick={() => {
                      setShowStrangersOnly(true);
                      setActiveThreadPeer(null);
                    }}
                  >
                    <div className="wallet-messages__avatar wallet-messages__avatar--stranger">◎</div>
                    <div className="wallet-messages__thread-body">
                      <div className="wallet-messages__thread-title">
                        Strangers{strangerUnreadCount > 0 ? ` (${strangerUnreadCount})` : ""}
                      </div>
                      <div className="wallet-messages__thread-preview">
                        {dmThreads.find((t) => t.isStranger)?.lastPreview || "New requests"}
                      </div>
                    </div>
                    <div className="wallet-messages__thread-meta">
                      <span className="wallet-messages__thread-date">
                        {dmThreads.find((t) => t.isStranger)
                          ? formatShortDate(dmThreads.find((t) => t.isStranger)!.lastCreatedAt)
                          : ""}
                      </span>
                    </div>
                  </button>
                )}
                {(showStrangersOnly
                  ? dmThreads.filter((t) => t.isStranger)
                  : dmThreads.filter((t) => {
                      if (!dmSearch.trim()) return !t.isStranger;
                      const meta = peerLabelFor(t.peerPubkey);
                      const haystack = `${meta.label} ${meta.subtitle ?? ""} ${t.lastPreview} ${t.peerPubkey}`.toLowerCase();
                      return haystack.includes(dmSearch.trim().toLowerCase());
                    })
                ).map((thread) => (
                  <button
                    key={thread.peerPubkey}
                    className="wallet-messages__thread pressable"
                    onClick={() => {
                      setActiveThreadPeer(thread.peerPubkey);
                      setDmView("thread");
                      const unreadIds = thread.messages
                        .map((m) => m.eventId)
                        .filter((id) => {
                          const item = messageItemsByEventId.get(id);
                          if (!item) return false;
                          const status = item.status;
                          return status !== "accepted" && status !== "deleted" && status !== "read";
                        });
                      if (unreadIds.length) {
                        onMarkMessagesRead(unreadIds);
                      }
                    }}
                  >
                    {(() => {
                      const meta = peerLabelFor(thread.peerPubkey);
                      const unreadCount = threadUnreadMap.get(thread.peerPubkey) || 0;
                      return (
                        <>
                          <div className="wallet-messages__avatar">
                            {meta.picture ? (
                              <img
                                src={meta.picture}
                                alt={meta.label}
                                className="wallet-messages__avatar-img"
                              />
                            ) : (
                              <span>{meta.label.slice(0, 2)}</span>
                            )}
                          </div>
                          <div className="wallet-messages__thread-body">
                            <div className="wallet-messages__thread-title">
                              {meta.label}
                              {unreadCount > 0 ? ` (${unreadCount})` : ""}
                            </div>
                            {meta.subtitle && (
                              <div className="wallet-messages__thread-subtitle">{meta.subtitle}</div>
                            )}
                            <div className="wallet-messages__thread-preview">{thread.lastPreview}</div>
                          </div>
                          <div className="wallet-messages__thread-meta">
                            <span className="wallet-messages__thread-date">
                              {formatShortDate(thread.lastCreatedAt)}
                            </span>
                          </div>
                        </>
                      );
                    })()}
                  </button>
                ))}
                {dmThreads.length === 0 && (
                  <div className="wallet-messages__empty text-secondary text-sm text-center">
                    No messages yet. Incoming DMs will appear here.
                  </div>
                )}
                </div>
              )}
              {dmView === "thread" && activeThread && (
                <div className="wallet-messages__thread-view">
                <div className="wallet-messages__thread-header">
                  <button
                    className="glass-icon-button pressable"
                    onClick={() => {
                      setDmView(showStrangersOnly ? "list" : "list");
                      setActiveThreadPeer(null);
                    }}
                  >
                    <BackIcon className="h-4 w-4" />
                  </button>
                  {(() => {
                    const meta = peerLabelFor(activeThread.peerPubkey);
                    return (
                      <div className="wallet-messages__thread-title">
                        <div className="wallet-messages__thread-title-text">{meta.label}</div>
                        {meta.subtitle && (
                          <div className="wallet-messages__thread-subtitle">{meta.subtitle}</div>
                        )}
                      </div>
                    );
                  })()}
                  <span className="wallet-messages__thread-date">
                    {formatDmDay(activeThread.lastCreatedAt)}
                  </span>
                </div>
                {activeThread.isStranger && (
                  <div className="wallet-messages__stranger-actions">
                    <button
                      type="button"
                      className="wallet-messages__stranger-button wallet-messages__stranger-button--muted pressable"
                      onClick={() => toggleBlockPeer(activeThread.peerPubkey)}
                    >
                      {activeThreadBlocked ? "Unblock User" : "Block User"}
                    </button>
                    <button
                      type="button"
                      className="wallet-messages__stranger-button wallet-messages__stranger-button--accent pressable"
                      onClick={() => handleAddPeerToContacts(activeThread.peerPubkey)}
                    >
                      Add to contacts
                    </button>
                  </div>
                )}
                <div className="wallet-messages__thread-messages">
                  {activeThread.messages.map((msg) => {
                    const matchedItem = messageItemsByEventId.get(msg.eventId);
                    const isPayment = msg.attachment?.type === "payment";
                    const isContact = msg.attachment?.type === "contact";
                    const isBoard = msg.attachment?.type === "board";
                    const isTask = msg.attachment?.type === "task";
                    const isStructured = !!msg.attachment && msg.attachment.type !== "text";
                    const bubbleClass = `wallet-message__bubble${isStructured ? " wallet-message__bubble--card" : ""}`;
                    const expanded = isDmMessageExpanded(msg.eventId);
                    const paymentHistoryEntry = isPayment
                      ? paymentHistoryByEventId.get(msg.eventId.toLowerCase())
                      : null;
                    const paymentCreatedSeconds = paymentHistoryEntry?.createdAt
                      ? Math.floor(paymentHistoryEntry.createdAt / 1000)
                      : msg.createdAt;
                    const cardDayLabel = (() => {
                      const date = new Date(paymentCreatedSeconds * 1000);
                      const day = date.getDate();
                      if (!Number.isFinite(day)) return "–";
                      return `${day}`.padStart(2, "0");
                    })();
                    const cardDate = formatShortDate(paymentCreatedSeconds);
                    const paymentDetails = isPayment
                      ? selectIncomingPaymentFromPayload(
                          tryParseJson<PaymentRequestPayload>(msg.attachment?.raw ?? null) ??
                            tryParseJson<PaymentRequestPayload>(msg.content) ??
                            msg.attachment?.raw ??
                            msg.content,
                        )
                      : null;
                    const paymentAmount =
                      paymentDetails?.amount ??
                      (isPayment ? msg.attachment?.amountSat ?? null : null);
                    const paymentUnit =
                      paymentDetails?.unit && typeof paymentDetails.unit === "string"
                        ? paymentDetails.unit.toLowerCase()
                        : "sat";
                    const paymentMintRaw =
                      paymentDetails?.mint && typeof paymentDetails.mint === "string"
                        ? normalizeMintUrl(paymentDetails.mint)
                        : null;
                    const paymentMint = paymentHistoryEntry
                      ? resolveMintDisplay(paymentHistoryEntry)
                      : paymentMintRaw;
                    const paymentToken =
                      paymentHistoryEntry?.detail ||
                      (paymentDetails?.token as string | undefined) ||
                      (isPayment && typeof msg.attachment?.raw === "string" ? msg.attachment.raw : "");
                    const paymentTitle =
                      paymentHistoryEntry?.amountSat != null
                        ? formatHistoryAmount(paymentHistoryEntry)
                        : paymentAmount != null
                        ? `${satFormatter.format(Math.max(0, Math.floor(paymentAmount)))} ${paymentUnit}`
                        : "Payment request received";
                    const paymentStatusInfo = paymentHistoryEntry ? deriveHistoryStatus(paymentHistoryEntry) : null;
                    const paymentSubtitle =
                      paymentHistoryEntry?.summary ||
                      (paymentStatusInfo?.label
                        ? [paymentStatusInfo.label, paymentMint].filter(Boolean).join(" • ")
                        : null) ||
                      (isPayment && msg.attachment?.detail) ||
                      paymentMint ||
                      "Tap to view payment details";
                    const contactAttachment = isContact ? msg.attachment : null;
                    const contactMeta = contactAttachment
                      ? sharedContactMetaFor(
                          contactAttachment.npub,
                          contactAttachment.contactName ||
                            contactAttachment.displayName ||
                            contactAttachment.username ||
                            matchedItem?.contact?.displayName ||
                            matchedItem?.contact?.name ||
                            matchedItem?.title,
                          contactAttachment.picture,
                        )
                      : null;
                    const taskAttachment = isTask ? msg.attachment?.task : null;
                    const taskDueSeconds = taskAttachment?.dueISO
                      ? Math.floor(new Date(taskAttachment.dueISO).getTime() / 1000)
                      : null;
                    const taskHasDue = !!(taskDueSeconds && Number.isFinite(taskDueSeconds) && taskDueSeconds > 0);
                    const taskDayLabel = taskHasDue
                      ? (() => {
                          const date = new Date((taskDueSeconds as number) * 1000);
                          const day = date.getDate();
                          if (!Number.isFinite(day)) return cardDayLabel;
                          return `${day}`.padStart(2, "0");
                        })()
                      : cardDayLabel;
                    const taskCardDate = taskHasDue ? formatShortDate(taskDueSeconds as number) : cardDate;
                    const taskDueLabel = taskHasDue
                      ? `Due ${formatDmDay(taskDueSeconds as number)}${
                          taskAttachment?.dueTimeEnabled ? ` · ${formatDmTime(taskDueSeconds as number)}` : ""
                        }`
                      : "Shared task";
                    const taskSubtasks = Array.isArray(taskAttachment?.subtasks)
                      ? taskAttachment.subtasks
                          .map((subtask) => subtask.title?.trim())
                          .filter((title): title is string => !!title)
                      : [];
                    const isTaskAssignment = !!(taskAttachment?.assignment || matchedItem?.task?.assignment);
                    const cardTime = `${formatDmDay(paymentCreatedSeconds)} · ${formatDmTime(paymentCreatedSeconds)}`;
                    const paymentAmountLabel =
                      paymentHistoryEntry?.amountSat != null
                        ? formatHistoryAmount(paymentHistoryEntry)
                        : paymentAmount != null
                          ? `${satFormatter.format(Math.max(0, Math.floor(paymentAmount)))} ${paymentUnit}`
                          : null;
                    const paymentStatusLabel = paymentStatusInfo?.label;
                    const paymentSummary = paymentHistoryEntry?.summary;
                    const actionStatus = matchedItem?.status;
                    const showActionButtons =
                      actionStatus !== "accepted" &&
                      actionStatus !== "declined" &&
                      actionStatus !== "tentative" &&
                      actionStatus !== "deleted";
                    const boardStatusLabel = getWalletMessageStatusLabel("board", actionStatus);
                    const contactStatusLabel = getWalletMessageStatusLabel("contact", actionStatus);
                    const taskStatusLabel = getWalletMessageStatusLabel("task", actionStatus);
                    const copyValue = buildDmCopyValue(msg, {
                      paymentToken,
                      boardId: isBoard
                        ? msg.attachment?.boardId || msg.attachment?.boardName || msg.content
                        : undefined,
                      contactNpub:
                        contactAttachment?.npub ||
                        formatNpubDisplay(contactAttachment?.npub || msg.peerPubkey) ||
                        formatNpub(msg.peerPubkey) ||
                        msg.peerPubkey,
                      taskPayload: taskAttachment || matchedItem?.task || null,
                    });
                    const copyLabel =
                      msg.attachment?.type === "board"
                        ? "Board ID"
                        : msg.attachment?.type === "contact"
                          ? "Pubkey"
                          : msg.attachment?.type === "task"
                            ? "Task"
                          : msg.attachment?.type === "payment"
                            ? "Token"
                            : "Message";
                    const isActionOpen = dmMessageActions?.eventId === msg.eventId;
                    const stackClass = `wallet-message__stack${msg.isIncoming ? "" : " wallet-message__stack--out"}`;
                    return (
                      <div
                        key={msg.eventId}
                        className={`wallet-message ${msg.isIncoming ? "wallet-message--in" : "wallet-message--out"}`}
                      >
                        <div className={stackClass}>
                          <div
                            className={bubbleClass}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              cancelDmLongPress();
                              setDmMessageActions({ eventId: msg.eventId, copyValue });
                            }}
                            onPointerDown={(event) => {
                              if ((event.target as HTMLElement | null)?.closest("button")) return;
                              cancelDmLongPress();
                              dmLongPressTimerRef.current = window.setTimeout(() => {
                                setDmMessageActions({ eventId: msg.eventId, copyValue });
                              }, 420);
                            }}
                            onPointerUp={cancelDmLongPress}
                            onPointerLeave={cancelDmLongPress}
                            onPointerCancel={cancelDmLongPress}
                          >
                            {isBoard && (
                              <div className="wallet-message__card wallet-message__card--inline">
                                <div className="wallet-message__card-icon">{cardDayLabel}</div>
                                <div className="wallet-message__card-body">
                                  <div className="wallet-message__card-title">
                                    {msg.attachment?.boardName || "Shared board"}
                                  </div>
                                  <div className="wallet-message__card-subtitle">
                                    Add this board to your workspace
                                  </div>
                                  {showActionButtons ? (
                                    <div className="wallet-message__card-actions">
                                    <button
                                      className="accent-button button-sm pressable"
                                      onClick={() => {
                                        if (matchedItem) onAcceptMessage(matchedItem.id);
                                      }}
                                      disabled={!matchedItem}
                                    >
                                      Add board
                                    </button>
                                    <button
                                      className="ghost-button button-sm pressable"
                                      onClick={() => {
                                        if (matchedItem) onDismissMessage(matchedItem.id);
                                      }}
                                      disabled={!matchedItem}
                                    >
                                      Dismiss
                                    </button>
                                    </div>
                                  ) : (
                                    boardStatusLabel && (
                                      <div className="wallet-message__card-status">{boardStatusLabel}</div>
                                    )
                                  )}
                                </div>
                                <div className="wallet-message__card-meta">{cardDate}</div>
                              </div>
                            )}
                            {isContact && (
                              <div
                                role="button"
                                tabIndex={0}
                                className="wallet-message__card pressable"
                                onClick={() => toggleDmMessageExpanded(msg.eventId)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggleDmMessageExpanded(msg.eventId);
                                  }
                                }}
                                aria-expanded={expanded}
                              >
                                <div className="wallet-message__card-icon wallet-message__card-icon--contact">
                                  {contactMeta?.picture ? (
                                    <img src={contactMeta.picture} alt={contactMeta.label} className="wallet-message__avatar-img" />
                                  ) : (
                                    <span>{cardDayLabel}</span>
                                  )}
                                </div>
                                <div className="wallet-message__card-body">
                                  <div className="wallet-message__card-title">
                                    {contactMeta?.label || contactAttachment?.contactName || "Shared contact"}
                                  </div>
                                  <div className="wallet-message__card-subtitle">
                                    {contactMeta?.subtitle || "Shared contact"}
                                  </div>
                                  {contactMeta?.verifiedNip05 && (
                                    <div className="wallet-message__badge">NIP-05 verified</div>
                                  )}
                                </div>
                                <div className="wallet-message__card-meta">{cardDate}</div>
                                {expanded && (
                                  <>
                                    <div className="wallet-message__card-details">
                                      {(contactMeta?.npub || contactAttachment?.npub) && (
                                        <div className="wallet-message__detail-row">
                                          <span>Npub</span>
                                          <div className="wallet-message__detail-value">
                                            <span className="wallet-message__mono">
                                              {contactMeta?.npub ||
                                                formatNpubDisplay(contactAttachment?.npub) ||
                                                ""}
                                            </span>
                                            <button
                                              type="button"
                                              className="ghost-button button-xs pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                void copyMessageValue(
                                                  contactMeta?.npub ||
                                                    formatNpubDisplay(contactAttachment?.npub) ||
                                                    "",
                                                  "npub",
                                                );
                                              }}
                                            >
                                              Copy
                                            </button>
                                          </div>
                                        </div>
                                      )}
                                      {(contactAttachment?.nip05 || contactMeta?.verifiedNip05) && (
                                        <div className="wallet-message__detail-row">
                                          <span>NIP-05</span>
                                          <div className="wallet-message__detail-value">
                                            {contactMeta?.verifiedNip05 || contactAttachment?.nip05}
                                            {contactMeta?.verifiedNip05 && (
                                              <span className="wallet-message__badge">Verified</span>
                                            )}
                                          </div>
                                        </div>
                                      )}
                                      {contactAttachment?.address && (
                                        <div className="wallet-message__detail-row">
                                          <span>Lightning</span>
                                          <span className="wallet-message__detail-value">
                                            {contactAttachment.address}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                    {showActionButtons ? (
                                      <div className="wallet-message__card-actions">
                                        <button
                                          className="accent-button button-sm pressable"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            if (matchedItem) onAcceptMessage(matchedItem.id);
                                          }}
                                          disabled={!matchedItem}
                                        >
                                          Add contact
                                        </button>
                                        <button
                                          className="ghost-button button-sm pressable"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            if (matchedItem) onDismissMessage(matchedItem.id);
                                          }}
                                          disabled={!matchedItem}
                                        >
                                          Dismiss
                                        </button>
                                      </div>
                                    ) : (
                                      contactStatusLabel && (
                                        <div className="wallet-message__card-status">{contactStatusLabel}</div>
                                      )
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                            {isTask && (
                              <div
                                role="button"
                                tabIndex={0}
                                className="wallet-message__card pressable"
                                onClick={() => toggleDmMessageExpanded(msg.eventId)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggleDmMessageExpanded(msg.eventId);
                                  }
                                }}
                                aria-expanded={expanded}
                              >
                                <div className="wallet-message__card-icon">{taskDayLabel}</div>
                                <div className="wallet-message__card-body">
                                  <div className="wallet-message__card-title">
                                    {taskAttachment?.title || "Shared task"}
                                  </div>
                                  <div className="wallet-message__card-subtitle">{taskDueLabel}</div>
                                </div>
                                <div className="wallet-message__card-meta">{taskCardDate}</div>
                                {expanded && (
                                  <>
                                    <div className="wallet-message__card-details">
                                      {taskAttachment?.note && (
                                        <div className="wallet-message__detail-row">
                                          <span>Note</span>
                                          <span className="wallet-message__detail-value">
                                            {taskAttachment.note}
                                          </span>
                                        </div>
                                      )}
                                      {taskHasDue && (
                                        <div className="wallet-message__detail-row">
                                          <span>Due</span>
                                          <span className="wallet-message__detail-value">
                                            {taskDueLabel.replace("Due ", "")}
                                          </span>
                                        </div>
                                      )}
                                      {taskSubtasks.length > 0 && (
                                        <div className="wallet-message__detail-row">
                                          <span>Subtasks</span>
                                          <span className="wallet-message__detail-value">
                                            {taskSubtasks.join(", ")}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                    {showActionButtons ? (
                                      <div className="wallet-message__card-actions">
                                        {isTaskAssignment ? (
                                          <>
                                            <button
                                              className="accent-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onAcceptMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Accept
                                            </button>
                                            <button
                                              className="ghost-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onMaybeMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Maybe
                                            </button>
                                            <button
                                              className="ghost-button button-sm pressable text-rose-400"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onDeclineMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Decline
                                            </button>
                                          </>
                                        ) : (
                                          <>
                                            <button
                                              className="accent-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onAcceptMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Add task
                                            </button>
                                            <button
                                              className="ghost-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (matchedItem) onDismissMessage(matchedItem.id);
                                              }}
                                              disabled={!matchedItem}
                                            >
                                              Dismiss
                                            </button>
                                          </>
                                        )}
                                      </div>
                                    ) : (
                                      taskStatusLabel && (
                                        <div className="wallet-message__card-status">{taskStatusLabel}</div>
                                      )
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                            {isPayment && (
                              <div
                                role="button"
                                tabIndex={0}
                                className="wallet-message__card pressable"
                                onClick={() => toggleDmMessageExpanded(msg.eventId)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggleDmMessageExpanded(msg.eventId);
                                  }
                                }}
                                aria-expanded={expanded}
                              >
                                <div className="wallet-message__card-icon wallet-message__card-icon--payment">
                                  {cardDayLabel}
                                </div>
                                <div className="wallet-message__card-body">
                                  <div className="wallet-message__card-title">{paymentTitle}</div>
                                  <div className="wallet-message__card-subtitle">{paymentSubtitle}</div>
                                </div>
                                <div className="wallet-message__card-meta">{cardDate}</div>
                                {expanded && (
                                  <>
                                    <div className="wallet-message__card-details">
                                      {paymentAmountLabel && (
                                        <div className="wallet-message__detail-row">
                                          <span>Amount</span>
                                          <span className="wallet-message__detail-value">{paymentAmountLabel}</span>
                                        </div>
                                      )}
                                      {paymentStatusLabel && (
                                        <div className="wallet-message__detail-row">
                                          <span>Status</span>
                                          <span className="wallet-message__detail-value">{paymentStatusLabel}</span>
                                        </div>
                                      )}
                                      {paymentMint && (
                                        <div className="wallet-message__detail-row">
                                          <span>Mint</span>
                                          <span className="wallet-message__detail-value">{paymentMint}</span>
                                        </div>
                                      )}
                                      <div className="wallet-message__detail-row">
                                        <span>Received</span>
                                        <span className="wallet-message__detail-value">{cardTime}</span>
                                      </div>
                                      {paymentSummary && (
                                        <div className="wallet-message__detail-row wallet-message__detail-row--stacked">
                                          <span>History</span>
                                          <div className="wallet-message__token">{paymentSummary}</div>
                                        </div>
                                      )}
                                      {paymentToken && (
                                        <div className="wallet-message__detail-row wallet-message__detail-row--stacked">
                                          <span>Token</span>
                                          <div className="wallet-message__token">
                                            {paymentToken}
                                          </div>
                                          <div className="wallet-message__card-actions">
                                            <button
                                              type="button"
                                              className="ghost-button button-sm pressable"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                void copyMessageValue(paymentToken, "Token");
                                              }}
                                            >
                                              Copy token
                                            </button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                            {msg.attachment?.type === "text" && (
                              <>
                                <div className="wallet-message__text">{msg.content}</div>
                                <div className="wallet-message__time">
                                  {formatDmDay(msg.createdAt)} · {formatDmTime(msg.createdAt)}
                                </div>
                              </>
                            )}
                          </div>
                          {isActionOpen && (
                            <div className="wallet-message__actions">
                              <button
                                type="button"
                                className="ghost-button button-xs pressable"
                                onClick={() => {
                                  void copyMessageValue(copyValue, copyLabel);
                                  setDmMessageActions(null);
                                }}
                              >
                                Copy {copyLabel.toLowerCase()}
                              </button>
                              <button
                                type="button"
                                className="ghost-button button-xs pressable wallet-message__action-delete"
                                onClick={() => handleDeleteDmMessage(msg.eventId)}
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              )}
            </div>
          </div>
        )}
            {walletTab === "contacts" && (
              <div className="wallet-messages__empty text-secondary text-sm text-center space-y-3">
            <div>Contacts live here now. Open the Contacts panel to add or manage entries.</div>
            <button
              className="accent-button button-sm pressable"
              onClick={() => {
                setWalletTab("contacts");
                setContactsTabOpen(true);
              }}
            >
              Open contacts
            </button>
          </div>
            )}
          </div>

          {showWalletTabSwitcher && (
            <div className="wallet-tab-switcher">
              <div className="wallet-tab-switcher__pill">
                <button
                  className={`wallet-tab-switcher__btn pressable${walletTab === "wallet" ? " wallet-tab-switcher__btn--active" : ""}`}
                  onClick={() => setWalletTab("wallet")}
                >
                  <div className="wallet-tab-switcher__icon">
                    <WalletGlyphIcon className="wallet-tab-switcher__icon-svg" />
                  </div>
                  <div className="wallet-tab-switcher__label">Wallet</div>
                </button>
                <button
                  className={`wallet-tab-switcher__btn pressable${walletTab === "messages" ? " wallet-tab-switcher__btn--active" : ""}`}
                  onClick={() => {
                    setWalletTab("messages");
                    setDmView("list");
                  }}
                >
                  <div className="wallet-tab-switcher__icon">
                    <ChatBubbleIcon className="wallet-tab-switcher__icon-svg" />
                  </div>
                  <div className="wallet-tab-switcher__label">
                    Messages{mainUnreadCount > 0 ? ` (${mainUnreadCount})` : ""}
                  </div>
                </button>
                <button
                  className={`wallet-tab-switcher__btn pressable${walletTab === "contacts" ? " wallet-tab-switcher__btn--active" : ""}`}
                  onClick={() => {
                    setWalletTab("contacts");
                    setContactsTabOpen(true);
                  }}
                >
                  <div className="wallet-tab-switcher__icon">
                    <PersonIcon className="wallet-tab-switcher__icon-svg" />
                  </div>
                  <div className="wallet-tab-switcher__label">Contacts</div>
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <ActionSheet
        open={receiveMode === "ecash"}
        onClose={closeReceiveEcashSheet}
        title="Receive eCash"
        actions={(
          <button
            className="ghost-button button-sm pressable"
            onClick={() => {
              closeReceiveEcashSheet();
              openReceiveLightningSheet();
            }}
          >
            Lightning
          </button>
        )}
      >
        {ecashReceiveView === "overview" ? (
          <div className="space-y-4">
            <div className="wallet-section space-y-4">
              {paymentRequestsEnabled ? (
                <>
                  <div className="flex items-center justify-between text-left">
                    <div className="text-sm font-medium">Payment request</div>
                    <span className="text-[11px] text-secondary">
                      {overviewPaymentRequest?.request.singleUse ? "Single-use" : "Multi-use"}
                    </span>
                  </div>
                  {overviewPaymentRequest?.encoded ? (
                    <>
                      <div className="flex justify-center">
                        <QrCodeCard
                          value={overviewPaymentRequest.encoded}
                          label="Payment request"
                          copyLabel="Copy"
                          size={220}
                          hideLabel
                          flat
                          className="wallet-qr-card--centered"
                          extraActions={
                            <div className="flex flex-wrap justify-center gap-2">
                              <button
                                className="ghost-button button-sm pressable"
                                onClick={handleOpenEcashRequestAmountView}
                              >
                                Get request
                              </button>
                              <button
                                className="ghost-button button-sm pressable"
                                onClick={handleOpenReceiveLock}
                                type="button"
                              >
                                Lock
                              </button>
                            </div>
                          }
                        />
                      </div>
                      {paymentRequestStatusMessage && !paymentRequestError && (
                        <div className="text-[11px] text-secondary text-center">
                          {paymentRequestStatusMessage}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-xs text-secondary text-center">
                      {nostrMissingReason
                        ? nostrMissingReason
                        : "Generate a NUT-18 payment request to collect eCash via Nostr."}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-secondary text-center">
                  Enable payment requests in Settings to generate a reusable eCash request.
                </div>
              )}
            </div>
            <button
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={() => {
                void handlePasteEcashClipboard();
              }}
            >
              Paste
            </button>
            {paymentRequestError && (
              <div className="text-[11px] text-rose-500 text-center">{paymentRequestError}</div>
            )}
            {recvMsg && <div className="text-xs text-secondary text-center">{recvMsg}</div>}
          </div>
        ) : ecashReceiveView === "amount" ? (
          <div className="space-y-4">
            <div className="wallet-section wallet-section--compact space-y-4">
              <div className="space-y-2 text-left">
                <div className="text-[11px] uppercase tracking-wide text-secondary">Receive to</div>
                {mintSelectionOptions.length ? (
                  <div className="relative">
                    <select
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                      value={selectedMintValue}
                      aria-label="Select mint"
                      onChange={(event) => {
                        const next = event.target.value;
                        if (next && next !== selectedMintValue) {
                          void setMintUrl(next);
                        }
                      }}
                    >
                      {mintSelectionOptions.map((option) => {
                        const info = mintInfoByUrl[option.normalized];
                        const label = info?.name || formatMintDisplayName(option.url);
                        return (
                          <option key={option.normalized} value={option.normalized}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                    <div className="pill-input lightning-mint-select__display">
                      <div className="lightning-mint-select__label">{selectedMintLabel}</div>
                      <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
                    </div>
                    <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                  </div>
                ) : (
                  <div className="text-sm text-secondary">
                    Add a mint in Wallet → Mint balances to start receiving.
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
                onClick={canToggleCurrency ? handleLightningAmountUnitToggle : undefined}
                disabled={!canToggleCurrency}
              >
                <div className="wallet-balance-card__amount lightning-amount-display__primary">
                  {ecashRequestPrimaryAmountText}
                </div>
                <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
                  {ecashRequestSecondaryAmountText}
                </div>
              </button>
              <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
                <button
                  type="button"
                  className={`glass-panel pressable py-0.5 transition-colors ${
                    ecashRequestMode === "single"
                      ? "border border-accent text-accent"
                      : "border border-transparent text-secondary"
                  }`}
                  onClick={() => handleSetEcashRequestMode("single")}
                >
                  Single-use
                </button>
                <button
                  type="button"
                  className={`glass-panel pressable py-0.5 transition-colors ${
                    ecashRequestMode === "multi"
                      ? "border border-accent text-accent"
                      : "border border-transparent text-secondary"
                  }`}
                  onClick={() => handleSetEcashRequestMode("multi")}
                >
                  Multi-use
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(primaryCurrency === "usd"
                  ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
                  : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
                ).map((key) => {
                  const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
                  return (
                    <button
                      key={key}
                      type="button"
                      className="glass-panel pressable py-3 text-lg font-semibold"
                      onClick={() => handleEcashRequestKeypadInput(handlerKey)}
                    >
                      {key === "clear" ? "Clear" : key}
                    </button>
                  );
                })}
              </div>
              <button
                className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                onClick={() => {
                  void handleCreateEcashRequest();
                }}
                disabled={!canCreateEcashRequest}
              >
                Get request
              </button>
              {paymentRequestError && (
                <div className="text-sm text-rose-400 text-center">{paymentRequestError}</div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {lastCreatedEcashRequest ? (
              <div className="wallet-section wallet-section--compact space-y-4">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    className="flex items-center gap-2 text-secondary hover:text-primary transition-colors pressable"
                    onClick={() => {
                      handleOpenEcashRequestAmountView();
                    }}
                  >
                    <BackIcon className="h-4 w-4" />
                    New request
                  </button>
                  <div className="text-sm font-medium text-secondary">
                    {lastCreatedEcashRequest.request.singleUse ? "Single-use" : "Multi-use"}
                  </div>
                </div>
                <div className="flex justify-center">
                  <QrCodeCard
                    value={lastCreatedEcashRequest.encoded}
                    label="Payment request"
                    copyLabel="Copy request"
                    size={240}
                  />
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Amount</span>
                    <span className="font-semibold">
                      {typeof lastCreatedEcashRequest.amountSat === "number"
                        ? `${satFormatter.format(lastCreatedEcashRequest.amountSat)} SAT`
                        : "Open amount"}
                    </span>
                  </div>
                  {walletConversionEnabled &&
                    btcUsdPrice != null &&
                    btcUsdPrice > 0 &&
                    typeof lastCreatedEcashRequest.amountSat === "number" && (
                      <div className="flex items-center justify-between text-secondary">
                        <span>USD</span>
                        <span>
                          {formatUsdAmount(
                            (lastCreatedEcashRequest.amountSat / SATS_PER_BTC) * btcUsdPrice,
                          )}
                        </span>
                      </div>
                    )}
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Mint</span>
                    <span className="font-medium break-all">{trimMintUrlScheme(mintUrl || "—")}</span>
                  </div>
                  {lastCreatedEcashRequest.lockPubkey && (
                    <div className="flex items-center justify-between">
                      <span className="text-secondary">Lock</span>
                      <span className="font-medium break-all">{lastCreatedEcashRequest.lockPubkey}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="wallet-section text-sm text-secondary">Create a request to view its details.</div>
            )}
            <div className="flex flex-wrap justify-center gap-2 text-sm">
              <button
                type="button"
                className="ghost-button button-sm pressable"
                onClick={() => {
                  handleOpenEcashRequestAmountView();
                }}
              >
                New request
              </button>
              <button
                type="button"
                className="ghost-button button-sm pressable"
                onClick={() => {
                  void ensureOpenPaymentRequest();
                  setLastCreatedEcashRequest(null);
                  setEcashReceiveView("overview");
                }}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </ActionSheet>

      <ActionSheet
        open={receiveLockVisible}
        onClose={() => {
          setReceiveLockVisible(false);
        }}
        title="Lock eCash"
      >
        <div className="wallet-section space-y-4">
          {activeP2pkKey ? (
            <>
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={activeP2pkKey.publicKey}
                label="P2PK key"
                copyLabel="Copy key"
                size={240}
                extraActions={
                  <button className="accent-button button-sm pressable" onClick={() => { handleGenerateP2pkKey(); }}>
                    Generate new key
                  </button>
                }
              />
              <div className="space-y-1 text-xs text-secondary">
                {activeP2pkKey.label?.trim() && (
                  <div className="font-medium text-primary">{activeP2pkKey.label.trim()}</div>
                )}
                <div className="break-all text-[11px] text-tertiary">{activeP2pkKey.publicKey}</div>
                <div className="text-[11px]">
                  Used {activeP2pkKey.usedCount}×
                  {activeP2pkKey.lastUsedAt ? ` • Last ${new Date(activeP2pkKey.lastUsedAt).toLocaleDateString()}` : ""}
                </div>
                {activeP2pkKey.usedCount > 0 && (
                  <div className="text-[11px] text-amber-400 font-medium">
                    Warning: This key was used before. Use a new key for better privacy.
                  </div>
                )}
                {primaryP2pkKey?.id === activeP2pkKey.id && (
                  <div className="text-[11px] text-accent">Default lock for new tokens</div>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-3 text-sm text-secondary">
              <div>Generate a P2PK key to lock incoming tokens. Only share this key with trusted senders.</div>
              <div className="flex flex-wrap gap-2 text-xs">
                <button className="accent-button button-sm pressable" onClick={() => { handleGenerateP2pkKey(); }}>
                  Generate key
                </button>
                <button className="ghost-button button-sm pressable" onClick={() => setReceiveLockVisible(false)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet
        open={receiveMode === "lightning"}
        onClose={closeReceiveLightningSheet}
        title="Receive Lightning"
        actions={(
          <button
            className="ghost-button button-sm pressable"
            onClick={() => {
              closeReceiveLightningSheet();
              openReceiveEcashSheet();
            }}
          >
            ecash
          </button>
        )}
      >
        <div className="space-y-4">
          {lightningReceiveView === "address" && (
            <div className="space-y-4">
              <div className="wallet-section space-y-4 text-center">
                {npubCashLightningAddressEnabled ? (
                  npubCashIdentity ? (
                    <>
                      <div className="flex justify-center">
                        <QrCodeCard
                          value={npubCashIdentity.address}
                          label="Lightning address"
                          size={240}
                          flat
                          hideCopyButton
                          className="wallet-qr-card--centered"
                        />
                      </div>
                      <div className="flex justify-center gap-3">
                        <button
                          type="button"
                          className="ghost-button button-sm pressable"
                          onClick={() => {
                            void handleClaimNpubCash();
                          }}
                          disabled={!npubCashLightningAddressEnabled || npubCashClaimStatus === "checking"}
                        >
                          {npubCashClaimStatus === "checking" ? "Checking…" : "Redeem"}
                        </button>
                        <button
                          type="button"
                          className="ghost-button button-sm pressable"
                          onClick={handleCopyLightningAddress}
                          disabled={!npubCashIdentity?.address}
                        >
                          {lightningAddressCopied ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <div className="text-sm font-medium text-primary break-words">
                        {lightningAddressDisplay}
                      </div>
                      {npubCashClaimMessage && (
                        <div
                          className={`text-sm ${
                            npubCashClaimStatus === "error"
                              ? "text-rose-400"
                              : npubCashClaimStatus === "success"
                                ? "text-emerald-400"
                                : "text-secondary"
                          }`}
                        >
                          {npubCashClaimMessage}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-sm text-secondary">
                      {npubCashIdentityError || "Add your Taskify Nostr key to enable npub.cash."}
                    </div>
                  )
                ) : (
                  <div className="text-sm text-secondary">
                    Lightning address disabled. Use Amount to create an invoice.
                  </div>
                )}
              </div>
              <button
                type="button"
                className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                onClick={handleOpenLightningAmountView}
              >
                Create Invoice
              </button>
            </div>
          )}
          {lightningReceiveView === "amount" && (
            <div className="wallet-section space-y-5">
              <div className="space-y-2 text-left">
                <div className="text-[11px] uppercase tracking-wide text-secondary">Receive to</div>
                {mintSelectionOptions.length ? (
                  <div className="relative">
                    <select
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                      value={selectedMintValue}
                      aria-label="Select mint"
                      onChange={(event) => {
                        const next = event.target.value;
                        if (next && next !== selectedMintValue) {
                          void setMintUrl(next);
                        }
                      }}
                    >
                      {mintSelectionOptions.map((option) => {
                        const info = mintInfoByUrl[option.normalized];
                        const label = info?.name || formatMintDisplayName(option.url);
                        return (
                          <option key={option.normalized} value={option.normalized}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                    <div className="pill-input lightning-mint-select__display">
                      <div className="lightning-mint-select__label">{selectedMintLabel}</div>
                      <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
                    </div>
                    <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                  </div>
                ) : (
                  <div className="text-sm text-secondary">
                    Add a mint in Wallet → Mint balances to start receiving.
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
                onClick={canToggleCurrency ? handleLightningAmountUnitToggle : undefined}
                disabled={!canToggleCurrency}
              >
                <div className="wallet-balance-card__amount lightning-amount-display__primary">
                  {lightningPrimaryAmountText}
                </div>
                <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
                  {lightningSecondaryAmountText}
                </div>
              </button>
              <div className="grid grid-cols-3 gap-3">
                {(primaryCurrency === "usd"
                  ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
                  : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
                ).map((key) => {
                  const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
                  return (
                    <button
                      key={key}
                      type="button"
                      className="glass-panel pressable py-3 text-lg font-semibold"
                      onClick={() => handleLightningAmountKeypadInput(handlerKey)}
                    >
                      {key === "clear" ? "Clear" : key}
                    </button>
                  );
                })}
              </div>
              <button
                className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                onClick={handleCreateInvoice}
                disabled={!canCreateMintInvoice || creatingMintInvoice}
              >
                {creatingMintInvoice ? (
                  <span className="inline-flex items-center gap-1">
                    Creating
                    <AnimatedEllipsis />
                  </span>
                ) : (
                  "Create invoice"
                )}
              </button>
              {mintError && <div className="text-sm text-rose-400 text-center">{mintError}</div>}
            </div>
          )}
          {lightningReceiveView === "invoice" && mintQuote && activeMintInvoice && (
            <div className="space-y-4">
              <div className="wallet-section space-y-4">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    className="flex items-center gap-2 text-secondary hover:text-primary transition-colors pressable"
                    onClick={handleLightningInvoiceBack}
                  >
                    <BackIcon className="h-4 w-4" />
                    New invoice
                  </button>
                  <div className="text-sm font-medium text-secondary">{lightningInvoiceStatusLabel}</div>
                </div>
                <div className="flex justify-center">
                  <QrCodeCard
                    value={mintQuote.request}
                    label="Lightning invoice"
                    copyLabel="Copy invoice"
                    size={240}
                  />
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Amount</span>
                    <span className="font-semibold">{satFormatter.format(activeMintInvoice.amountSat)} SAT</span>
                  </div>
                  {invoiceAmountSecondary && (
                    <div className="flex items-center justify-between text-secondary">
                      <span>USD</span>
                      <span>{invoiceAmountSecondary}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Mint</span>
                    <span className="font-medium break-all">{trimMintUrlScheme(mintUrl || "—")}</span>
                  </div>
                </div>
                {mintError && <div className="text-sm text-rose-400">{mintError}</div>}
              </div>
            </div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet open={receiveMode === "lnurlWithdraw"} onClose={closeReceiveLnurlWithdrawSheet} title="LNURL Withdraw">
        {lnurlWithdrawInfo ? (
          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary">Source: {lnurlWithdrawInfo.domain}</div>
            <div className="text-xs text-secondary">
              Limits: {Math.ceil(lnurlWithdrawInfo.minWithdrawable / 1000)} – {Math.floor(lnurlWithdrawInfo.maxWithdrawable / 1000)} sats
            </div>
            {lnurlWithdrawInvoice && (
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={lnurlWithdrawInvoice}
                label="Mint invoice"
                copyLabel="Copy invoice"
                size={220}
              />
            )}
            <input
              className="pill-input"
              placeholder={amountInputPlaceholder}
              value={lnurlWithdrawAmt}
              onChange={(e)=>setLnurlWithdrawAmt(e.target.value)}
              inputMode="decimal"
            />
            <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
              <button
                className="accent-button button-sm pressable"
                onClick={handleLnurlWithdrawConfirm}
                disabled={!mintUrl || lnurlWithdrawState === "creating" || lnurlWithdrawState === "waiting"}
              >Withdraw</button>
              {lnurlWithdrawStatusText && <span>{lnurlWithdrawStatusText}</span>}
              {lnurlWithdrawMessage && (
                <span className={lnurlWithdrawState === "error" ? "text-rose-400" : "text-accent"}>{lnurlWithdrawMessage}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="wallet-section text-sm text-secondary">Scan an LNURL withdraw QR code to pull sats into your wallet.</div>
        )}
      </ActionSheet>

      {/* Send options */}
      <ActionSheet open={showSendOptions && sendMode === null} onClose={()=>setShowSendOptions(false)} title="Send">
        <div className="wallet-section space-y-2 text-sm">
          <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setSendMode("ecash")}>
            <span>ecash</span>
            <span className="text-tertiary">→</span>
          </button>
          <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setSendMode("lightning")}>
            <span>Lightning</span>
            <span className="text-tertiary">→</span>
          </button>
        </div>
      </ActionSheet>

	      <ActionSheet
	        open={sendMode === "ecash"}
	        onClose={closeEcashSendSheet}
	        title={
	          ecashSendView === "contact" && ecashSendRecipient
	            ? (() => {
	                const nip05 = ecashSendRecipient.nip05?.trim() || "";
	                const nip05Verified = nip05 && isNip05VerifiedFor(ecashSendRecipient.id, nip05, ecashSendRecipient.npub);
	                const label = nip05Verified ? nip05 : contactPrimaryName(ecashSendRecipient);
	                return `Send to ${truncateContactName(label, 34)}`;
	              })()
	            : "Send eCash"
	        }
	        actions={
	          ecashSendView === "contact" ? (
	            <button
	              className="ghost-button button-sm pressable"
	              onClick={() => openContactsFor("ecash")}
	            >
	              Contacts
	            </button>
	          ) : (
	            <div className="flex items-center gap-2">
	              <button
	                className="glass-panel pressable rounded-full p-2"
	                type="button"
	                onClick={() => {
	                  if (lockSendToPubkey) {
	                    handleClearSendLock();
	                  } else {
	                    void handlePasteSendLock();
	                  }
	                }}
	                title={lockSendToPubkey ? "Clear P2PK lock" : "Paste P2PK locking key"}
	                aria-label={lockSendToPubkey ? "Clear P2PK lock" : "Paste P2PK locking key"}
	              >
	                <LockIcon className={`h-4 w-4 ${lockSendToPubkey ? "text-accent" : "text-white"}`} />
	              </button>
	              <button
	                className="ghost-button button-sm pressable"
	                onClick={() => {
	                  closeEcashSendSheet();
	                  openLightningSendSheet();
	                }}
	              >
	                Lightning
	              </button>
	            </div>
	          )
	        }
	      >
        {ecashSendView === "amount" && (
          <div className="space-y-4">
            <div className="wallet-section wallet-section--compact space-y-3">
              {sendTokenStr && (
                <button
                  type="button"
                  className="ghost-button button-sm pressable w-full justify-between"
                  onClick={() => setEcashSendView("token")}
                >
                  <span>View last token</span>
                  <span className="text-tertiary">→</span>
                </button>
              )}
              <div className="space-y-2 text-left">
                <div className="text-[11px] uppercase tracking-wide text-secondary">Send from</div>
                {mintSelectionOptions.length ? (
                  <div className="relative">
                    <select
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                      value={selectedMintValue}
                      aria-label="Select mint"
                      onChange={(event) => {
                        const next = event.target.value;
                        if (next && next !== selectedMintValue) {
                          void setMintUrl(next);
                        }
                      }}
                    >
                      {mintSelectionOptions.map((option) => {
                        const info = mintInfoByUrl[option.normalized];
                        const label = info?.name || formatMintDisplayName(option.url);
                        return (
                          <option key={option.normalized} value={option.normalized}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                    <div className="pill-input lightning-mint-select__display">
                      <div className="lightning-mint-select__label">{selectedMintLabel}</div>
                      <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
                    </div>
                    <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                  </div>
                ) : (
                  <div className="text-sm text-secondary">
                    Add a mint in Wallet → Mint balances to start sending.
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
                onClick={canToggleCurrency ? handleTogglePrimary : undefined}
                disabled={!canToggleCurrency}
              >
                <div className="wallet-balance-card__amount lightning-amount-display__primary">{ecashPrimaryAmountText}</div>
                <div className="wallet-balance-card__secondary lightning-amount-display__secondary">{ecashSecondaryAmountText}</div>
              </button>
              {sendLockError && <div className="text-[11px] text-rose-500">{sendLockError}</div>}
              <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
                <button
                  type="button"
                  className="glass-panel pressable py-0.5"
                  onClick={() => openContactsFor("ecash")}
                >
                  Contacts
                </button>
                <button
                  type="button"
                  className="glass-panel pressable py-0.5"
                  onClick={() => {
                    void handlePasteEcashInput();
                  }}
                >
                  Paste
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(primaryCurrency === "usd"
                  ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
                  : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
                ).map((key) => {
                  const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
                  return (
                    <button
                      key={key}
                      type="button"
                      className="glass-panel pressable py-3 text-lg font-semibold"
                      onClick={() => handleEcashAmountKeypadInput(handlerKey)}
                    >
                      {key === "clear" ? "Clear" : key}
                    </button>
                  );
                })}
              </div>
              <button
                className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                onClick={handleCreateSendToken}
                disabled={!mintUrl || creatingSendToken || tokenAlreadyCreatedForAmount || !canCreateSendTokenAmount}
              >
                {creatingSendToken ? "Creating…" : "Get token"}
              </button>
              {tokenAlreadyCreatedForAmount && (
                <div className="text-xs text-secondary">
                  Token already created for this amount with the current lock settings. Update the parameters to mint another.
                </div>
              )}
            </div>
          </div>
	        )}
	        {ecashSendView === "contact" && ecashSendRecipient && (
	          <div className="space-y-4">
	            <div className="wallet-section space-y-5">
	              <div className="space-y-2 text-left">
	                <div className="text-[11px] uppercase tracking-wide text-secondary">Send from</div>
	                {mintSelectionOptions.length ? (
	                  <div className="relative">
	                    <select
	                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
	                      value={selectedMintValue}
	                      aria-label="Select mint"
	                      onChange={(event) => {
	                        const next = event.target.value;
	                        if (next && next !== selectedMintValue) {
	                          void setMintUrl(next);
	                        }
	                      }}
	                    >
	                      {mintSelectionOptions.map((option) => {
	                        const info = mintInfoByUrl[option.normalized];
	                        const label = info?.name || formatMintDisplayName(option.url);
	                        return (
	                          <option key={option.normalized} value={option.normalized}>
	                            {label}
	                          </option>
	                        );
	                      })}
	                    </select>
	                    <div className="pill-input lightning-mint-select__display">
	                      <div className="lightning-mint-select__label">{selectedMintLabel}</div>
	                      <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
	                    </div>
	                    <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
	                  </div>
	                ) : (
	                  <div className="text-sm text-secondary">Add a mint in Wallet → Mint balances to send eCash.</div>
	                )}
	              </div>
	              <button
	                type="button"
	                className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
	                onClick={canToggleCurrency ? handleTogglePrimary : undefined}
	                disabled={!canToggleCurrency}
	              >
	                <div className="wallet-balance-card__amount lightning-amount-display__primary">
	                  {ecashPrimaryAmountText}
	                </div>
	                <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
	                  {ecashSecondaryAmountText}
	                </div>
	              </button>
	              {sendLockError && <div className="text-[11px] text-rose-500">{sendLockError}</div>}
	              <div className="grid grid-cols-3 gap-3">
	                {(primaryCurrency === "usd"
	                  ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
	                  : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
	                ).map((key) => {
	                  const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
	                  return (
	                    <button
	                      key={key}
	                      type="button"
	                      className="glass-panel pressable py-3 text-lg font-semibold"
	                      onClick={() => handleEcashAmountKeypadInput(handlerKey)}
	                    >
	                      {key === "clear" ? "Clear" : key}
	                    </button>
	                  );
	                })}
	              </div>
	              <button
	                className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
	                onClick={() => {
	                  void applyEcashContact(ecashSendRecipient);
	                }}
	                disabled={!mintUrl || creatingSendToken || !canCreateSendTokenAmount}
	              >
	                {creatingSendToken ? (
	                  <span className="inline-flex items-center gap-1">
	                    Sending
	                    <AnimatedEllipsis />
	                  </span>
	                ) : (
	                  "Pay via nostr"
	                )}
	              </button>
	            </div>
	          </div>
	        )}
        {ecashSendView === "contact" && !ecashSendRecipient && (
          <div className="wallet-section text-sm text-secondary">Select a contact to continue.</div>
        )}
        {ecashSendView === "token" && sendTokenStr && (
          <div className="space-y-4">
            <div className="wallet-section space-y-4">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="flex items-center gap-2 text-secondary hover:text-primary transition-colors pressable"
                  onClick={handleOpenEcashAmountView}
                >
                  <BackIcon className="h-4 w-4" />
                  New token
                </button>
                {lastSendTokenLockLabel && (
                  <div className="text-sm font-medium text-secondary text-right">{lastSendTokenLockLabel}</div>
                )}
              </div>
              <div className="flex justify-center">
                <QrCodeCard
                  className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                  value={sendTokenStr}
                  label="Token"
                  copyLabel="Copy token"
                  extraActions={
                    peanutSendToken ? (
                      <button
                        type="button"
                        className="ghost-button button-sm pressable"
                        onClick={handleCopyNutToken}
                        aria-label="Copy nut-encoded token"
                        title="Copy nut-encoded token"
                      >
                        {nutTokenCopied ? "Copied" : "Nut"}
                      </button>
                    ) : undefined
                  }
                  size={240}
                  enableNut16Animation
                />
              </div>
              <div className="space-y-2 text-sm">
                {lastSendTokenAmount != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Amount</span>
                    <span className="font-semibold">{satFormatter.format(lastSendTokenAmount)} SAT</span>
                  </div>
                )}
                {walletConversionEnabled && btcUsdPrice != null && btcUsdPrice > 0 && lastSendTokenAmount != null && (
                  <div className="flex items-center justify-between text-secondary">
                    <span>USD</span>
                    <span>{formatUsdAmount((lastSendTokenAmount / SATS_PER_BTC) * btcUsdPrice)}</span>
                  </div>
                )}
                {lastSendTokenMint && (
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Mint</span>
                    <span className="font-medium break-all">{trimMintUrlScheme(lastSendTokenMint)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {ecashSendView === "token" && !sendTokenStr && (
          <div className="wallet-section text-sm text-secondary">Create a token to share.</div>
        )}
      </ActionSheet>

      <ActionSheet
        open={contactsOpen && contactsContext !== null}
        onClose={closeContactsSheet}
        title={contactsContext === "ecash" ? "eCash contacts" : "Lightning contacts"}
        stackLevel={60}
      >
        {contactsContext && (
          <div className="wallet-section space-y-3 text-sm">
            {contactsPanelContent(contactsContext)}
          </div>
        )}
      </ActionSheet>

      <ActionSheet
        open={contactsPanelOpen}
        onClose={closeContactsTab}
        header={contactsHeader}
        stackLevel={contactsPanelInline ? undefined : 70}
        panelClassName="sheet-panel--tall contacts-panel"
        inline={contactsPanelInline}
      >
        <div
          ref={contactsPanelRef}
          className="contacts-shell"
          aria-busy={contactSyncState.status === "loading" || contactsPublishState === "publishing"}
        >
          {contactView === "list" && (
            <div className="contacts-list-view">
              {(() => {
                const profileSubtitleIsNip05 =
                  !!profileCard.nip05 &&
                  !!myCardSubtitle &&
                  normalizeNip05(profileCard.nip05) === normalizeNip05(myCardSubtitle);
                const profileNip05Verified =
                  profileSubtitleIsNip05 &&
                  isNip05VerifiedFor(profileCard.id, profileCard.nip05, profileCard.npub);
                const profilePhoto = profileCard.picture?.trim();

                return (
                  <button
                    type="button"
                    className="contact-row contact-row--profile pressable"
                    onClick={() => {
                      setActiveContactId("profile");
                      setContactView("detail");
                    }}
                  >
                    <div
                      className={
                        profilePhoto
                          ? "contact-avatar contact-avatar--image contact-avatar--profile"
                          : "contact-avatar contact-avatar--profile"
                      }
                    >
                      {profilePhoto ? (
                        <img src={profilePhoto} alt={myCardName} className="contact-avatar__img" />
                      ) : (
                        contactInitials(myCardName)
                      )}
                    </div>
                    <div className="contact-row__text">
                      <div className="contact-row__name">{myCardName}</div>
                      <div
                        className={`contact-row__meta${
                          profileSubtitleIsNip05 ? " contact-row__meta--nip05" : ""
                        }`}
                      >
                        <span className="contact-row__meta-text">{myCardSubtitle}</span>
                        {profileSubtitleIsNip05 && profileNip05Verified && (
                          <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                        )}
                      </div>
                    </div>
                    <span className="contact-chevron">›</span>
                  </button>
                );
              })()}

              <div className="contact-list">
                {sortedContacts.length > 0 ? (
                  sortedContacts.map((contact) => {
                    const displayName = contactDisplayLabel(contact);
                    const displayNameTrimmed = truncateContactName(displayName);
                    const subtitle = contactSubtitle(contact) || "No details added";
                    const subtitleIsNip05 =
                      !!contact.nip05 &&
                      !!subtitle &&
                      normalizeNip05(contact.nip05) === normalizeNip05(subtitle);
                    const nip05Verified =
                      subtitleIsNip05 && isNip05VerifiedFor(contact.id, contact.nip05, contact.npub);
                    const photo = contact.picture?.trim();
                    return (
                      <button
                        key={contact.id}
                        type="button"
                        className="contact-row pressable"
                        onClick={() => {
                          setActiveContactId(contact.id);
                          setContactView("detail");
                        }}
                      >
                        <div className={photo ? "contact-avatar contact-avatar--image" : "contact-avatar"}>
                          {photo ? (
                            <img src={photo} alt={displayName} className="contact-avatar__img" />
                        ) : (
                          contactInitials(displayName)
                        )}
                      </div>
                      <div className="contact-row__text">
                        <div className="contact-row__name">{displayNameTrimmed}</div>
                        <div
                          className={`contact-row__meta${subtitleIsNip05 ? " contact-row__meta--nip05" : ""}`}
                        >
                          <span className="contact-row__meta-text">{subtitle}</span>
                          {subtitleIsNip05 && nip05Verified && (
                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                          )}
                        </div>
                      </div>
                      <span className="contact-chevron">›</span>
                    </button>
                  );
                })
                ) : (
                  <div className="contact-empty text-secondary">No saved contacts yet. Tap + to add one.</div>
                )}
              </div>
            </div>
          )}

          {contactView === "detail" && detailTarget && (
            <div className="contact-detail-view">
              <div className="contact-hero">
                <div className="contact-hero__center">
                  <div className="contact-qr-wrapper">
                    {detailShareValue ? (
                          <QrCodeCard
                          className="contact-qr-card"
                          value={detailShareValue}
                          label={detailTitle}
                          size={200}
                          flat
                          hideLabel
                          hideCopyButton
                        />
                    ) : (
                      <div className="contact-qr-placeholder text-secondary">No QR to share yet.</div>
                    )}
                  </div>
                  <div
                    className={`contact-heading${detailTarget.picture ? "" : " contact-heading--text-only"}`}
                  >
                    {detailTarget.picture && (
                      <img src={detailTarget.picture} alt={detailTitle} className="contact-portrait" />
                    )}
                <div className="contact-heading__text">
                  <div className="flex items-center gap-2">
                    <div className="contact-name-lg" title={detailTitle}>
                      {truncateContactName(detailTitle, 34)}
                    </div>
                    {activeContactId === "profile" && profileCard.npub && (
                      <button
                        type="button"
                        className="contact-pill contact-pill--circle pressable"
                        title="Share your npub"
                        onClick={() => {
                          setShareContactSource({ ...profileCard, relays: defaultNostrRelays } as Contact);
                          setShareContactStatus(null);
                          setShareContactPickerOpen(true);
                        }}
                      >
                        <ShareArrowIcon className="contact-pill__icon" />
                      </button>
                    )}
                  </div>
                  {detailUsername && (
                    <div className="contact-username" title={detailUsername}>
                      {truncateContactValue(detailUsername, 33)}
                    </div>
                  )}
                </div>
                  </div>
                </div>
              </div>

              {activeContact &&
                (detailHasLightning || detailCanShare) && (
                  <div className="contact-actions-row contact-actions-row--top contact-actions-row--wide">
                    {detailHasLightning && (
                      <button
                        type="button"
                        className="contact-pill pressable"
                        onClick={() => {
                          applyLightningContact(activeContact);
                          setContactsTabOpen(false);
                        }}
                      >
                        Pay lightning
                      </button>
                    )}
                    {detailCanShare && (
                      <button
                        type="button"
                        className="contact-pill pressable"
                        onClick={() => {
                          openEcashSendToContact(activeContact);
                          setContactsTabOpen(false);
                        }}
                      >
                        Pay eCash
                      </button>
                    )}
                    {detailCanShare && (
                      <button
                        type="button"
                        className="contact-pill contact-pill--circle pressable"
                        title="Share contact"
                        onClick={() => {
                          setShareContactSource(activeContact);
                          setShareContactStatus(null);
                          setShareContactPickerOpen(true);
                        }}
                      >
                        <ShareArrowIcon className="contact-pill__icon" />
                      </button>
                    )}
                  </div>
              )}

              <div className="contact-fields">
                {detailFields.length ? (
                  detailFields.map((field) => {
                    const isNip05Field = field.key === "nip05";
                    return (
                      <div key={field.key} className="contact-field">
                        <div className="contact-field__label">{field.label}</div>
                        <button
                          type="button"
                          className={`contact-field__value${field.multiline ? " contact-field__value--multiline" : ""}${
                            isNip05Field ? " contact-field__value--nip05" : ""
                          }`}
                          onClick={() => handleCopyContactField(field.value, field.label)}
                          title={field.value}
                        >
                          <span className={`contact-field__text${field.multiline ? " contact-field__text--multiline" : ""}`}>
                            {field.multiline ? field.value : truncateContactValue(field.value, 36)}
                          </span>
                          {isNip05Field && detailNip05Verified && (
                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                          )}
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="contact-empty text-secondary">No details saved for this contact yet.</div>
                )}
              </div>

              {activeContact && (
                <div className="contact-actions-row">
                  <button
                    type="button"
                    className="contact-pill contact-pill--danger pressable"
                    onClick={() => {
                      if (window.confirm("Remove this contact?")) {
                        handleDeleteContact(activeContact.id);
                        setContactView("list");
                        setActiveContactId(null);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}

          {contactView === "detail" && !detailTarget && (
            <div className="contact-empty text-secondary">
              Contact not found.{" "}
              <button
                type="button"
                className="inline-flex items-center gap-1 text-primary underline"
                onClick={() => {
                  setContactView("list");
                  setActiveContactId(null);
                }}
              >
                Go back
              </button>
            </div>
          )}

          {contactView === "edit" &&
            (() => {
              const profilePhoto = contactEditDraft.picture.trim();
              const profileInitials =
                contactEditDraft.displayName ||
                contactEditDraft.name ||
                contactEditDraft.username ||
                myCardName;
              const showContactFields = contactEditDraft.isProfile || showCustomContactFields;

              return (
                <form
                  id="contact-edit-form"
                  className="contact-edit-view"
                  onSubmit={(event) => event.preventDefault()}
                >
                  {contactEditDraft.isProfile ? (
                    <div className="contact-photo-card">
                      <div className="contact-photo-title">Profile photo</div>
                      <div className="contact-photo-body">
                        <div
                          className={
                            profilePhoto
                              ? "contact-avatar contact-avatar--image contact-avatar--xl"
                              : "contact-avatar contact-avatar--xl"
                          }
                        >
                          {profilePhoto ? (
                            <img src={profilePhoto} alt={profileInitials} className="contact-avatar__img" />
                          ) : (
                            contactInitials(profileInitials)
                          )}
                        </div>
                        <div className="contact-photo-actions">
                          <button
                            type="button"
                            className="accent-button pressable contact-photo-upload"
                            onClick={() => {
                              setProfilePhotoError("");
                              profilePhotoInputRef.current?.click();
                            }}
                            disabled={profilePhotoBusy}
                          >
                            {profilePhotoBusy ? "Processing…" : profilePhoto ? "Replace photo" : "Upload photo"}
                          </button>
                          {profilePhoto && (
                            <button
                              type="button"
                              className="ghost-button button-sm pressable contact-photo-remove"
                              onClick={handleClearProfilePhoto}
                              disabled={profilePhotoBusy}
                            >
                              Remove photo
                            </button>
                          )}
                        </div>
                        <input
                          ref={profilePhotoInputRef}
                          type="file"
                          accept="image/*"
                          style={{ display: "none" }}
                          onChange={handleProfilePhotoChange}
                        />
                        {profilePhotoError && <div className="contact-error">{profilePhotoError}</div>}
                      </div>
                    </div>
                  ) : (
                    <div className="contact-import-card">
                      <div className="contact-import-title">Import from npub / NIP-05</div>
                      <div className="contact-import-actions contact-import-actions--top">
                        <button
                          type="button"
                          className="ghost-button button-sm pressable contact-import-scan"
                          onClick={() => {
                            setShowScanner(true);
                          }}
                        >
                          Scan QR
                        </button>
                        <button
                          type="button"
                          className="ghost-button button-sm pressable contact-custom-toggle"
                          onClick={() => setShowCustomContactFields((prev) => !prev)}
                        >
                          {showCustomContactFields ? "Hide custom fields" : "Custom contact"}
                        </button>
                        {publicFollowOptions.length > 0 && (
                          <button
                            type="button"
                            className="ghost-button button-sm pressable contact-import-follow"
                            onClick={() => setPublicFollowPickerOpen(true)}
                          >
                            Pick from follows
                          </button>
                        )}
                      </div>
                      <div className="contact-import-row">
                        <input
                          className="contact-edit-input contact-import-input"
                          placeholder="npub1… or name@example.com"
                          value={contactLookupInput}
                          onChange={(e) => setContactLookupInput(e.target.value)}
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          className="accent-button pressable contact-import-button"
                          onClick={async () => {
                            await handleContactImportAction();
                          }}
                          disabled={contactLookupBusy}
                        >
                          {contactLookupBusy ? "…" : contactLookupInput.trim() ? "Import" : "Paste"}
                        </button>
                      </div>
                      {contactLookupError && <div className="contact-error">{contactLookupError}</div>}
                    </div>
                  )}

                  {showContactFields && (
                    <div className="contact-edit-grid">
                      {!contactEditDraft.isProfile && (
                        <input
                          className="contact-edit-input"
                          placeholder="Nickname"
                          value={contactEditDraft.name}
                          onChange={(e) => setContactEditDraft((prev) => ({ ...prev, name: e.target.value }))}
                        />
                      )}
                      <input
                        className="contact-edit-input"
                        placeholder="Display name"
                        value={contactEditDraft.displayName}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, displayName: e.target.value }))}
                      />
                      <input
                        className="contact-edit-input"
                        placeholder="Username"
                        value={contactEditDraft.username}
                        onChange={(e) => {
                          const sanitized = sanitizeUsername(e.target.value);
                          setContactEditDraft((prev) => ({ ...prev, username: sanitized }));
                        }}
                      />
                      <input
                        className="contact-edit-input"
                        placeholder="Lightning address"
                        autoComplete="off"
                        value={contactEditDraft.address}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, address: e.target.value }))}
                      />
                      <input
                        className="contact-edit-input"
                        placeholder="npub or hex pubkey"
                        autoComplete="off"
                        value={contactEditDraft.npub}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, npub: e.target.value }))}
                      />
                      <input
                        className="contact-edit-input"
                        placeholder="NIP-05 (name@example.com)"
                        autoComplete="off"
                        value={contactEditDraft.nip05}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, nip05: e.target.value }))}
                      />
                      <textarea
                        className="contact-edit-input contact-edit-textarea"
                        rows={3}
                        placeholder="About"
                        value={contactEditDraft.about}
                        onChange={(e) => setContactEditDraft((prev) => ({ ...prev, about: e.target.value }))}
                      />
                    </div>
                  )}

                  <div className="contact-edit-note text-secondary">
                    Saving publishes your updates to Nostr (contacts stay encrypted).
                  </div>

                  {contactEditError && <div className="contact-error">{contactEditError}</div>}
                </form>
              );
            })()}
        </div>
      </ActionSheet>

      <ActionSheet
        open={publicFollowPickerOpen}
        onClose={() => setPublicFollowPickerOpen(false)}
        title="Import from follows"
        stackLevel={75}
      >
        <div className="wallet-section space-y-3 text-sm">
          {publicFollowOptions.length ? (
            <div className="contact-list">
              {publicFollowOptions.map((follow) => {
                const formattedUsername = follow.username ? formatContactUsername(follow.username) : "";
                const nip05Label = follow.nip05 || "";
                const label = follow.petname || nip05Label || formattedUsername || follow.npub;
                const subtitle =
                  nip05Label || formattedUsername || follow.relay || follow.npub;
                return (
                  <button
                    key={follow.pubkey}
                    type="button"
                    className="contact-row pressable"
                    onClick={() => {
                      void handleImportPublicFollow(follow.npub);
                    }}
                  >
                    <div className="contact-avatar">{contactInitials(label)}</div>
                    <div className="contact-row__text">
                      <div className="contact-row__name">{truncateContactName(label)}</div>
                      <div className="contact-row__meta">
                        <span className="contact-row__meta-text">{truncateContactValue(subtitle)}</span>
                      </div>
                    </div>
                    <span className="contact-chevron">›</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-secondary">No public follows found yet. Sync contacts to load your follows.</div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet
        open={profileEditorOpen}
        onClose={() => setProfileEditorOpen(false)}
        title="Edit profile"
        stackLevel={80}
      >
        <div className="wallet-section space-y-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs text-secondary uppercase tracking-wide">Profile</div>
              <div className="font-semibold text-primary">Update your info</div>
            </div>
            <div className="text-right text-[11px] text-secondary">
              {profileStatus === "publishing"
                ? "Publishing…"
                : profileStatus === "loading"
                  ? "Loading…"
                  : profileUpdatedAt
                    ? `Updated ${new Date(profileUpdatedAt).toLocaleString()}`
                    : "Draft"}
            </div>
          </div>
          <div className="grid gap-2">
            <input
              className="pill-input"
              placeholder="Username"
              value={profileForm.username}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, username: e.target.value }))}
              autoComplete="username"
            />
            <input
              className="pill-input"
              placeholder="Display name"
              value={profileForm.displayName}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, displayName: e.target.value }))}
              autoComplete="name"
            />
            <input
              className="pill-input"
              placeholder="Lightning address"
              value={profileForm.lud16}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, lud16: e.target.value }))}
              autoComplete="off"
            />
            <input
              className="pill-input"
              placeholder="NIP-05 (name@example.com)"
              value={profileForm.nip05}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, nip05: e.target.value }))}
              autoComplete="off"
            />
            <textarea
              className="pill-textarea"
              rows={2}
              placeholder="About (optional)"
              value={profileForm.about}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, about: e.target.value }))}
            />
          </div>
          {profileMessage && (
            <div className={`text-[11px] ${profileStatus === "error" ? "text-rose-400" : "text-secondary"}`}>
              {profileMessage}
            </div>
          )}
          <div className="flex flex-wrap gap-2 text-xs">
            <button
              className="accent-button button-sm pressable"
              type="button"
              onClick={() => {
                void publishProfileMetadata();
              }}
              disabled={profileStatus === "publishing" || profileStatus === "loading"}
            >
              {profileStatus === "publishing" ? "Publishing…" : "Save & publish"}
            </button>
            <button
              className="ghost-button button-sm pressable"
              type="button"
              onClick={() => {
                void loadProfileMetadata();
              }}
              disabled={profileStatus === "loading"}
            >
              Refresh
            </button>
          </div>
          {profileShareValue && (
            <div className="flex flex-col items-center gap-2">
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={profileShareValue}
                label="Your profile"
                copyLabel="Copy profile"
                size={200}
              />
              <div className="text-[11px] text-secondary text-center">
                Share to add you, pay lightning, or send eCash via Nostr.
              </div>
            </div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet open={manualSendPlan !== null} onClose={closeManualSendPlan} title="Select notes">
        {manualSendPlan && (
          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary">
              {manualSendPlan.exactMatchSelection
                ? "Exact offline match selected automatically. Adjust the notes if you'd like a different amount."
                : "Exact offline match unavailable. Select notes to build your token."}
            </div>
            <div className="text-xs text-secondary">Target: {manualSendPlan.target} sats</div>
            {(manualSendPlan.closestBelow !== null || manualSendPlan.closestAbove !== null) && (
              <div className="space-y-2">
                <div className="space-y-1 text-[11px] text-secondary">
                  {manualSendPlan.closestBelow !== null && (
                    <div>Closest below: {manualSendPlan.closestBelow} sats</div>
                  )}
                  {manualSendPlan.closestAbove !== null && (
                    <div>Closest above: {manualSendPlan.closestAbove} sats</div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {manualSendPlan.exactMatchSelection && (
                    <button
                      type="button"
                      className={`${manualSelectionMatches(manualSendPlan.exactMatchSelection) ? "accent-button" : "ghost-button"} button-sm pressable`}
                      onClick={() => applyManualSendSelection(manualSendPlan.exactMatchSelection)}
                    >
                      Exact match ({manualSendPlan.target} sats)
                    </button>
                  )}
                  {manualSendPlan.closestBelowSelection && manualSendPlan.closestBelow !== null && (
                    <button
                      type="button"
                      className={`${manualSelectionMatches(manualSendPlan.closestBelowSelection) ? "accent-button" : "ghost-button"} button-sm pressable`}
                      onClick={() =>
                        applyManualSendSelection(manualSendPlan.closestBelowSelection, { autoCreate: true })
                      }
                    >
                      Closest below ({manualSendPlan.closestBelow} sats)
                    </button>
                  )}
                  {manualSendPlan.closestAboveSelection && manualSendPlan.closestAbove !== null && (
                    <button
                      type="button"
                      className={`${manualSelectionMatches(manualSendPlan.closestAboveSelection) ? "accent-button" : "ghost-button"} button-sm pressable`}
                      onClick={() =>
                        applyManualSendSelection(manualSendPlan.closestAboveSelection, { autoCreate: true })
                      }
                    >
                      Closest above ({manualSendPlan.closestAbove} sats)
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="text-[11px] text-secondary">Use the controls below to adjust the amount.</div>
            <div className="space-y-2">
              {manualSendPlan.groups.map((group) => {
                const totalCount = group.secrets.length;
                const selectedCount = group.secrets.reduce(
                  (count, secret) => (manualSendSelection.has(secret) ? count + 1 : count),
                  0,
                );
                return (
                  <div
                    key={`manual-group-${group.amount}`}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-surface bg-surface-muted px-3 py-2"
                  >
                    <div className="text-xs">
                      <div className="font-semibold text-primary">{group.amount} sats ×{totalCount}</div>
                      <div className="text-[11px] text-secondary">Selected: {selectedCount}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="ghost-button button-sm pressable"
                        onClick={() => adjustManualSendGroupSelection(group.amount, -1)}
                        disabled={selectedCount === 0}
                        aria-label={`Remove a ${group.amount} sat note`}
                      >
                        −
                      </button>
                      <span className="min-w-[2rem] text-center text-sm font-semibold text-primary">
                        {selectedCount}
                      </span>
                      <button
                        type="button"
                        className="ghost-button button-sm pressable"
                        onClick={() => adjustManualSendGroupSelection(group.amount, 1)}
                        disabled={selectedCount === totalCount}
                        aria-label={`Add a ${group.amount} sat note`}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="text-sm font-semibold text-primary">Selected: {manualSelectedTotal} sats</div>
            {manualSendPlan.lockActive && (
              <div className="text-[11px] text-secondary">
                Receiver locking isn't applied when manually selecting notes.
              </div>
            )}
            {manualSendError && <div className="text-[11px] text-rose-500">{manualSendError}</div>}
            <div className="flex gap-2 text-xs">
              <button
                className="accent-button button-sm pressable"
                onClick={handleManualSendConfirm}
                disabled={manualSendInProgress || manualSendSelection.size === 0}
              >
                {manualSendInProgress ? "Creating…" : "Create token"}
              </button>
              <button
                className="ghost-button button-sm pressable"
                onClick={closeManualSendPlan}
                disabled={manualSendInProgress}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </ActionSheet>

      <ActionSheet
        open={sendMode === "lightning"}
        onClose={closeLightningSendSheet}
        title="Pay Lightning"
        actions={(
          <button className="ghost-button button-sm pressable" onClick={openEcashSendSheet}>
            eCash
          </button>
        )}
        panelClassName={isCompactLightningSheetLayout ? "sheet-panel--compact" : undefined}
      >
        <div className="space-y-4">
          {lightningSendView === "input" && (
            <div className="space-y-4">
              <div className="wallet-section space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-secondary">
                  <button
                    className="ghost-button button-sm pressable"
                    type="button"
                    onClick={() => openContactsFor("lightning")}
                  >
                    Contacts
                  </button>
                  {lightningContactCount === 0 && <span>No saved lightning contacts yet.</span>}
                </div>
                <textarea
                  ref={lnRef}
                  className="pill-textarea wallet-textarea w-full"
                  placeholder="Enter invoice or lightning address"
                  value={lnInput}
                  onChange={(event) => {
                    setLnInput(event.target.value);
                    setLnError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                      event.preventDefault();
                      if (canReviewLightningInput) {
                        handleLightningInputReview();
                      }
                    }
                  }}
                />
                {lnError && <div className="text-xs text-rose-400">{lnError}</div>}
                {bolt11Details?.message && <div className="text-xs text-secondary">{bolt11Details.message}</div>}
                {bolt11Details?.error && <div className="text-xs text-rose-400">{bolt11Details.error}</div>}
              </div>
              <button
                type="button"
                className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                onClick={() => {
                  if (lnInput.trim()) {
                    handleLightningInputReview();
                  } else {
                    void handlePasteLightningInput();
                  }
                }}
              >
                {lnInput.trim() ? "Pay" : "Paste"}
              </button>
            </div>
          )}
          {lightningSendView === "invoice" && (
            <div className="space-y-4">
              <div className="wallet-section space-y-5">
                <div className="space-y-2 text-left">
                  <div className="text-[11px] uppercase tracking-wide text-secondary">Pay from</div>
                  {mintSelectionOptions.length ? (
                    <div className="relative">
                      <select
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                        value={selectedMintValue}
                        aria-label="Select mint"
                        onChange={(event) => {
                          const next = event.target.value;
                          if (next && next !== selectedMintValue) {
                            void setMintUrl(next);
                          }
                        }}
                      >
                        {mintSelectionOptions.map((option) => {
                          const info = mintInfoByUrl[option.normalized];
                          const label = info?.name || formatMintDisplayName(option.url);
                          return (
                            <option key={option.normalized} value={option.normalized}>
                              {label}
                            </option>
                          );
                        })}
                      </select>
                      <div className="pill-input lightning-mint-select__display">
                        <div className="lightning-mint-select__label">{selectedMintLabel}</div>
                        <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
                      </div>
                      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                    </div>
                  ) : (
                    <div className="text-sm text-secondary">
                      Add a mint in Wallet → Mint balances to start sending.
                    </div>
                  )}
                </div>
                <div className="rounded-2xl border border-surface bg-surface-muted p-4 space-y-2">
                  <div className="text-[11px] uppercase tracking-wide text-secondary">Amount</div>
                  <div className="text-3xl font-semibold text-primary">
                    {lightningInvoiceAmountSat != null
                      ? `${satFormatter.format(lightningInvoiceAmountSat)} SAT`
                      : "Amount not specified"}
                  </div>
                  {lightningInvoiceAmountSecondaryDisplay && (
                    <div className="text-sm text-secondary">≈ {lightningInvoiceAmountSecondaryDisplay}</div>
                  )}
                  {lightningInvoiceAmountSat == null && (
                    <div className="text-sm text-secondary">Invoice does not specify an amount.</div>
                  )}
                </div>
                <div className="space-y-2 text-sm">
                  <div>
                    <div className="text-secondary">Invoice</div>
                    <div className="font-mono text-[11px] break-all">{normalizedLnInput}</div>
                  </div>
                  {bolt11Details?.message && <div className="text-xs text-secondary">{bolt11Details.message}</div>}
                  {bolt11Details?.error && <div className="text-xs text-rose-400">{bolt11Details.error}</div>}
                </div>
                <button
                  className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                  onClick={handlePayInvoice}
                  disabled={!mintUrl || !lnInput || lnState === "sending"}
                >
                  {lnState === "sending" ? (
                    <span className="inline-flex items-center gap-1">
                      Paying
                      <AnimatedEllipsis />
                    </span>
                  ) : (
                    "Pay"
                  )}
                </button>
                {lnState === "error" && <div className="text-xs text-rose-400">{lnError}</div>}
              </div>
            </div>
          )}
          {lightningSendView === "address" && (
            <div className="space-y-4">
              <div className="wallet-section wallet-section--compact space-y-4">
                <div className="space-y-2 text-left">
                  <div className="text-[11px] uppercase tracking-wide text-secondary">Pay from</div>
                  {mintSelectionOptions.length ? (
                    <div className="relative">
                      <select
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                        value={selectedMintValue}
                        aria-label="Select mint"
                        onChange={(event) => {
                          const next = event.target.value;
                          if (next && next !== selectedMintValue) {
                            void setMintUrl(next);
                          }
                        }}
                      >
                        {mintSelectionOptions.map((option) => {
                          const info = mintInfoByUrl[option.normalized];
                          const label = info?.name || formatMintDisplayName(option.url);
                          return (
                            <option key={option.normalized} value={option.normalized}>
                              {label}
                            </option>
                          );
                        })}
                      </select>
                      <div className="pill-input lightning-mint-select__display">
                        <div className="lightning-mint-select__label">{selectedMintLabel}</div>
                        <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
                      </div>
                      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                    </div>
                  ) : (
                    <div className="text-sm text-secondary">
                      Add a mint in Wallet → Mint balances to start sending.
                    </div>
                  )}
                </div>
                <div className="space-y-2 text-left">
                  <div className="text-[11px] uppercase tracking-wide text-secondary">Send to</div>
                  <div className="glass-panel px-3 py-2 text-sm font-medium text-primary break-all">
                    {lightningDestinationDisplay}
                  </div>
                </div>
                {isLnurlInput && lnurlPayData && (
                  <div className="text-xs text-secondary">
                    Limits: {Math.ceil(lnurlPayData.minSendable / 1000)} – {Math.floor(lnurlPayData.maxSendable / 1000)} sats
                  </div>
                )}
                <button
                  type="button"
                  className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
                  onClick={canToggleCurrency ? handleTogglePrimary : undefined}
                  disabled={!canToggleCurrency}
                >
                  <div className="wallet-balance-card__amount lightning-amount-display__primary">
                    {lightningSendPrimaryAmountText}
                  </div>
                  <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
                    {lightningSendSecondaryAmountText}
                  </div>
                </button>
                <div className="wallet-keypad-grid grid grid-cols-3 gap-3">
                  {(primaryCurrency === "usd"
                    ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
                    : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
                  ).map((key) => {
                    const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
                    return (
                      <button
                        key={key}
                        type="button"
                        className="glass-panel wallet-keypad-grid__button pressable py-3 text-lg font-semibold"
                        onClick={() => handleLightningSendAmountKeypadInput(handlerKey)}
                      >
                        {key === "clear" ? "Clear" : key}
                      </button>
                    );
                  })}
                </div>
                <button
                  className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                  onClick={handlePayInvoice}
                  disabled={
                    !mintUrl ||
                    !lnInput ||
                    ((isLnAddress || lnurlRequiresAmount) && !lnAddrAmt) ||
                    lnState === "sending"
                  }
                >
                  {lnState === "sending" ? (
                    <span className="inline-flex items-center gap-1">
                      Paying
                      <AnimatedEllipsis />
                    </span>
                  ) : (
                    "Pay"
                  )}
                </button>
                {lnState === "error" && <div className="text-xs text-rose-400">{lnError}</div>}
              </div>
            </div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet
        open={sendMode === "paymentRequest"}
        onClose={closePaymentRequestSheet}
        title="Fulfill eCash Request"
        actions={(
          <button
            className="ghost-button button-sm pressable"
            onClick={() => {
              void handlePasteEcashRequest();
            }}
          >
            Paste
          </button>
        )}
      >
        {paymentRequestState ? (
          <div className="space-y-4">
            <div className="wallet-section space-y-5">
              <div className="space-y-2 text-left">
                <div className="text-[11px] uppercase tracking-wide text-secondary">Send from</div>
                {mintSelectionOptions.length ? (
                  <div className="relative">
                    <select
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                      value={selectedMintValue}
                      aria-label="Select mint"
                      onChange={(event) => {
                        const next = event.target.value;
                        if (next && next !== selectedMintValue) {
                          void setMintUrl(next);
                        }
                      }}
                    >
                      {mintSelectionOptions.map((option) => {
                        const info = mintInfoByUrl[option.normalized];
                        const label = info?.name || formatMintDisplayName(option.url);
                        return (
                          <option key={option.normalized} value={option.normalized}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                    <div className="pill-input lightning-mint-select__display">
                      <div className="lightning-mint-select__label">{selectedMintLabel}</div>
                      <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
                    </div>
                    <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                  </div>
                ) : (
                  <div className="text-sm text-secondary">Add a mint in Wallet → Mint balances to send eCash.</div>
                )}
              </div>
              <button
                type="button"
                className={`lightning-amount-display glass-panel${paymentRequestAmountButtonEnabled ? " pressable" : ""}`}
                onClick={
                  paymentRequestAmountButtonEnabled
                    ? () => {
                        if (canTogglePaymentRequestCurrency) {
                          handlePaymentRequestAmountUnitToggle();
                        }
                      }
                    : undefined
                }
                disabled={!paymentRequestAmountButtonEnabled}
              >
                <div className="wallet-balance-card__amount lightning-amount-display__primary">
                  {paymentRequestPrimaryAmountText}
                </div>
                <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
                  {paymentRequestSecondaryAmountText}
                </div>
              </button>
              {!paymentRequestHasFixedAmount && (
                <div className="grid grid-cols-3 gap-3">
                  {(primaryCurrency === "usd"
                    ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
                    : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
                  ).map((key) => {
                    const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
                    return (
                      <button
                        key={key}
                        type="button"
                        className="glass-panel pressable py-3 text-lg font-semibold"
                        onClick={() => handlePaymentRequestKeypadInput(handlerKey)}
                      >
                        {key === "clear" ? "Clear" : key}
                      </button>
                    );
                  })}
                </div>
              )}
              {(() => {
                const request = paymentRequestState.request;
                const detailItems: React.ReactNode[] = [];
                if (request.description) {
                  detailItems.push(
                    <div key="description">Memo: {request.description}</div>,
                  );
                }
                if (request.mints?.length) {
                  detailItems.push(
                    <div key="mints">Mint: {request.mints.map(normalizeMintUrl).join(", ")}</div>,
                  );
                }
                return detailItems.length ? (
                  <div className="space-y-1 text-xs text-secondary">{detailItems}</div>
                ) : null;
              })()}
              <button
                className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                onClick={handleFulfillPaymentRequest}
                disabled={
                  paymentRequestStatus === "sending" ||
                  (!paymentRequestState.request.amount && !paymentRequestManualAmount.trim())
                }
              >
                {paymentRequestActionLabel}
              </button>
              {paymentRequestStatus === "sending" && (
                <div className="text-xs text-secondary text-center">Sending…</div>
              )}
              {paymentRequestStatus === "error" && paymentRequestMessage && (
                <div className="text-xs text-rose-400 text-center">{paymentRequestMessage}</div>
              )}
              {paymentRequestStatus !== "error" && paymentRequestMessage && (
                <div className="text-xs text-secondary text-center">{paymentRequestMessage}</div>
              )}
              {paymentRequestError && (
                <div className="text-xs text-rose-400 text-center">{paymentRequestError}</div>
              )}
            </div>
          </div>
        ) : (
          <div className="wallet-section text-sm text-secondary">Scan an eCash withdrawal request to continue.</div>
        )}
      </ActionSheet>

      <ActionSheet
        open={showScanner}
        onClose={closeScanner}
        title="Scan Code"
        stackLevel={95}
        actions={(
          <button
            className="ghost-button button-sm pressable"
            onClick={() => {
              void handlePasteFromClipboard();
            }}
          >Paste</button>
        )}
      >
        <div className="wallet-section space-y-3">
          <QrScanner active={showScanner} onDetected={handleScannerDetected} onError={handleScannerError} />
          {scannerMessage && (
            <div className={`text-xs text-center ${scannerMessageTone === "error" ? "text-rose-400" : "text-secondary"}`}>
              {scannerMessage}
            </div>
          )}
        </div>
      </ActionSheet>

        <ActionSheet
          open={!!scannedContact}
          onClose={() => setScannedContact(null)}
          header={scannedContactHeader}
          stackLevel={75}
        >
          {scannedContact && (
            <div className="contact-detail-view">
              <div className="contact-hero">
                <div className="contact-hero__center">
                  <div className="contact-qr-wrapper">
                    {scannedContactShareValue ? (
                      <QrCodeCard
                        className="contact-qr-card"
                        value={scannedContactShareValue}
                        label={scannedContactTitle}
                        size={200}
                        flat
                        hideLabel
                        hideCopyButton
                      />
                    ) : (
                      <div className="contact-qr-placeholder text-secondary">No QR to share yet.</div>
                    )}
                  </div>
                  <div
                    className={`contact-heading${scannedContact.picture ? "" : " contact-heading--text-only"}`}
                  >
                    {scannedContact.picture && (
                      <img src={scannedContact.picture} alt={scannedContactTitle} className="contact-portrait" />
                    )}
                    <div className="contact-heading__text">
                      <div className="contact-name-lg" title={scannedContactTitle}>
                        {truncateContactName(scannedContactTitle, 34)}
                      </div>
                      {scannedContactUsername && (
                        <div className="contact-username" title={scannedContactUsername}>
                          {truncateContactValue(scannedContactUsername, 33)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {scannedContact &&
                (contactHasLightning(scannedContact) ||
                  scannedContactCanShare) && (
                <div className="contact-actions-row contact-actions-row--top contact-actions-row--wide">
                  {contactHasLightning(scannedContact) && (
                    <button
                      type="button"
                      className="contact-pill pressable"
                      onClick={() => {
                        applyLightningContact(scannedContact);
                        setScannedContact(null);
                      }}
                    >
                      Pay lightning
                    </button>
                  )}
                  {scannedContactCanShare && (
                    <button
                      type="button"
                      className="contact-pill pressable"
                      onClick={() => {
                        openEcashSendToContact(scannedContact);
                        setScannedContact(null);
                      }}
                    >
                      Pay eCash
                    </button>
                  )}
                  {scannedContactCanShare && (
                    <button
                      type="button"
                      className="contact-pill contact-pill--circle pressable"
                      title="Share contact"
                      onClick={() => {
                        setShareContactSource(scannedContact);
                        setShareContactStatus(null);
                        setShareContactPickerOpen(true);
                      }}
                    >
                      <ShareArrowIcon className="contact-pill__icon" />
                    </button>
                  )}
                </div>
              )}

              <div className="contact-fields">
                {scannedContactFields.length ? (
                  scannedContactFields.map((field) => {
                    const isNip05Field = field.key === "nip05";
                    return (
                      <div key={field.key} className="contact-field">
                        <div className="contact-field__label">{field.label}</div>
                        <button
                          type="button"
                          className={`contact-field__value${field.multiline ? " contact-field__value--multiline" : ""}${
                            isNip05Field ? " contact-field__value--nip05" : ""
                          }`}
                          onClick={() => handleCopyContactField(field.value, field.label)}
                          title={field.value}
                        >
                          <span
                            className={`contact-field__text${field.multiline ? " contact-field__text--multiline" : ""}`}
                          >
                            {field.multiline ? field.value : truncateContactValue(field.value, 36)}
                          </span>
                          {isNip05Field && scannedContactNip05Verified && (
                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                          )}
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="contact-empty text-secondary">No details saved for this contact yet.</div>
                )}
              </div>
            </div>
          )}
        </ActionSheet>

      <ActionSheet
        open={shareContactPickerOpen}
        onClose={() => {
          if (shareContactBusy) return;
          setShareContactPickerOpen(false);
          setShareContactSource(null);
          setShareContactStatus(null);
        }}
        title="Send contact"
        stackLevel={90}
      >
        {shareContactSource ? (
          <div className="text-sm text-secondary mb-2">
            Send <span className="font-semibold">{contactPrimaryName(shareContactSource)}</span> to a contact.
          </div>
        ) : (
          <div className="text-sm text-secondary mb-2">Choose who to send this contact to.</div>
        )}
        {shareContactStatus && <div className="text-sm text-rose-400 mb-2">{shareContactStatus}</div>}
        {shareRecipientOptions.length ? (
          <div className="space-y-2">
            {shareRecipientOptions.map((contact) => {
              const label = contactPrimaryName(contact);
              const subtitle = formatContactNpub(contact.npub);
              return (
                <button
                  key={contact.id}
                  type="button"
                  className="contact-row pressable"
                  disabled={shareContactBusy}
                  onClick={() => handleShareContactToContact(contact)}
                >
                  <div className="contact-avatar">{contactInitials(label)}</div>
                  <div className="contact-row__text">
                    <div className="contact-row__name">{label}</div>
                    {subtitle ? (
                      <div className="contact-row__meta">
                        <span className="contact-row__meta-text">{subtitle}</span>
                      </div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-secondary">Add another contact with an npub to share to.</div>
        )}
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            className="ghost-button button-sm pressable flex-1 justify-center"
            onClick={() => {
              if (shareContactBusy) return;
              setShareContactPickerOpen(false);
              setShareContactSource(null);
              setShareContactStatus(null);
            }}
            disabled={shareContactBusy}
          >
            Cancel
          </button>
        </div>
      </ActionSheet>

      <ActionSheet
        open={showHistory}
        onClose={() => {
          setShowHistory(false);
          setExpandedHistoryId(null);
        }}
        title="History"
        headerEnd={historyFilterControls}
      >
        {history.length ? (
          filteredHistory.length ? (
            <>
              {historyFilterControls && (
                <div className="wallet-history__filters-inline">{historyFilterControls}</div>
              )}
              <ul className="wallet-history">
                {filteredHistory.map((entry, index) => {
                  const isExpanded = expandedHistoryId === entry.id;
                  const detailKind = entry.detailKind;
                  const detailIsToken = isCashuTokenDetail(entry.detail, detailKind);
                  const resolvedType =
                    entry.type ?? (detailKind === "invoice" ? "lightning" : detailIsToken ? "ecash" : undefined);
                  const typeLabel =
                    resolvedType === "lightning" ? "Lightning" : resolvedType === "ecash" ? "Ecash" : "History";
                  const timeLabel = formatRelativeTime(entry.createdAt);
                  const amountLabel = formatHistoryAmount(entry);
                  const fiatLabel =
                    walletConversionEnabled && entry.fiatValueUsd != null
                      ? formatUsdAmount(entry.fiatValueUsd)
                      : null;
                  const mintLabel = resolveMintDisplay(entry);
                  const statusInfo = deriveHistoryStatus(entry);
                  const detailLabel = detailIsToken
                    ? "Cashu token"
                    : detailKind === "invoice"
                      ? "Lightning invoice"
                      : undefined;
                  const copyLabel = detailIsToken
                    ? "Copy token"
                    : detailKind === "invoice"
                      ? "Copy invoice"
                      : "Copy detail";
                  const redeemState = historyRedeemStates[entry.id];
                  const tokenCheckState = historyCheckStates[entry.id];
                  const mintQuoteState = historyMintQuoteStates[entry.id];
                  const pendingAction =
                    entry.pendingTokenId && entry.pendingStatus !== "redeemed"
                      ? {
                          ariaLabel: "Redeem saved token",
                          handler: () => handleRedeemPendingHistoryItem(entry),
                          busy: redeemState?.status === "pending",
                          status: redeemState,
                        }
                      : entry.mintQuote
                        ? {
                            ariaLabel: "Refresh invoice",
                            handler: () => handleCheckHistoryMintQuote(entry),
                            busy: mintQuoteState?.status === "pending",
                            status: mintQuoteState,
                          }
                        : entry.tokenState && entry.tokenState.lastState !== "SPENT"
                          ? {
                              ariaLabel: "Check token state",
                              handler: () => performTokenStateCheck(entry),
                              busy: tokenCheckState?.status === "pending",
                              status: tokenCheckState,
                            }
                          : null;
                  const showRedeemButton = entry.pendingTokenId && entry.pendingStatus !== "redeemed";
                  const canMarkTokenSpent = !!entry.tokenState && entry.tokenState.lastState !== "SPENT";
                  return (
                    <li
                      key={`${entry.id}-${index}`}
                      className={`wallet-history__item${isExpanded ? " wallet-history__item--open" : ""}`}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        className="wallet-history__summary"
                        onClick={() => setExpandedHistoryId(isExpanded ? null : entry.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setExpandedHistoryId(isExpanded ? null : entry.id);
                          }
                        }}
                        aria-expanded={isExpanded}
                        aria-label="Toggle history details"
                      >
                        <div className="wallet-history__icon" aria-hidden="true">
                          {resolvedType === "lightning" ? (
                            <LightningGlyph className="wallet-history__glyph" />
                          ) : (
                            <EcashGlyph className="wallet-history__glyph" />
                          )}
                        </div>
                        <div className="wallet-history__body">
                          <div className="wallet-history__title-row">
                            <span className="wallet-history__type">{typeLabel}</span>
                            {timeLabel && <span className="wallet-history__time">{timeLabel}</span>}
                          </div>
                          <div className="wallet-history__meta-row">
                            <span
                              className={`wallet-history__status${
                                statusInfo.tone ? ` wallet-history__status--${statusInfo.tone}` : ""
                              }`}
                            >
                              {statusInfo.label}
                            </span>
                            {mintLabel && <span className="wallet-history__mint">{mintLabel}</span>}
                          </div>
                        </div>
                        <div className="wallet-history__value">
                          {amountLabel && (
                            <span
                              className={`wallet-history__amount wallet-history__amount--${
                                entry.direction === "in" ? "in" : "out"
                              }`}
                            >
                              {amountLabel}
                            </span>
                          )}
                          {fiatLabel && <span className="wallet-history__fiat">{fiatLabel}</span>}
                          {pendingAction && (
                            <button
                              type="button"
                              className="wallet-history__refresh"
                              disabled={pendingAction.busy}
                              onClick={(event) => {
                                event.stopPropagation();
                                pendingAction.handler();
                              }}
                              aria-label={pendingAction.ariaLabel}
                            >
                              ↻
                            </button>
                          )}
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="wallet-history__details">
                          {detailLabel && entry.detail && (
                            <QrCodeCard
                              className="wallet-history__qr"
                              value={entry.detail}
                              label={detailLabel}
                              copyLabel={copyLabel}
                              size={220}
                              enableNut16Animation={detailIsToken}
                            />
                          )}
                          <div className="wallet-history__details-grid">
                            <div className="wallet-history__metric">
                              <span>Amount</span>
                              <span className="wallet-history__metric-value">
                                {entry.amountSat != null ? `${satFormatter.format(entry.amountSat)} sat` : "—"}
                              </span>
                            </div>
                            {walletConversionEnabled && fiatLabel && (
                              <div className="wallet-history__metric">
                                <span>Fiat</span>
                                <span className="wallet-history__metric-value">{fiatLabel}</span>
                              </div>
                            )}
                            {(entry.feeSat ?? 0) > 0 && (
                              <div className="wallet-history__metric">
                                <span>Fee paid</span>
                                <span className="wallet-history__metric-value">
                                  {satFormatter.format(entry.feeSat ?? 0)} sat
                                </span>
                              </div>
                            )}
                            <div className="wallet-history__metric">
                              <span>Status</span>
                              <span className="wallet-history__metric-value">{statusInfo.label}</span>
                            </div>
                            {entry.createdAt && (
                              <div className="wallet-history__metric">
                                <span>{entry.direction === "out" ? "Time sent" : "Time received"}</span>
                                <span className="wallet-history__metric-value">
                                  {new Date(entry.createdAt).toLocaleString()}
                                </span>
                              </div>
                            )}
                            {mintLabel && (
                              <div className="wallet-history__metric">
                                <span>Mint</span>
                                <span className="wallet-history__metric-value">{mintLabel}</span>
                              </div>
                            )}
                          </div>
                          {entry.summary && (
                            <div className="wallet-history__detail-note">
                              {entry.summary}
                              {entry.relatedTaskTitle && (
                                <div className="wallet-history__detail-task">
                                  Task: {entry.relatedTaskTitle}
                                </div>
                              )}
                            </div>
                          )}
                          {pendingAction?.status?.message && (
                            <div
                              className={`wallet-history__helper${
                                pendingAction.status.status === "error"
                                  ? " wallet-history__helper--error"
                                  : pendingAction.status.status === "success"
                                    ? " wallet-history__helper--success"
                                    : ""
                              }`}
                            >
                              {pendingAction.status.message}
                            </div>
                          )}
                          {showRedeemButton && (
                            <div className="wallet-history__section">
                              <div className="wallet-history__section-content">
                                <button
                                  className="accent-button button-sm pressable"
                                  onClick={() => handleRedeemPendingHistoryItem(entry)}
                                  disabled={historyRedeemStates[entry.id]?.status === "pending"}
                                >
                                  Redeem
                                </button>
                                {historyRedeemStates[entry.id]?.message && (
                                  <div
                                    className={`wallet-history__helper${
                                      historyRedeemStates[entry.id]?.status === "error"
                                        ? " wallet-history__helper--error"
                                        : historyRedeemStates[entry.id]?.status === "success"
                                          ? " wallet-history__helper--success"
                                          : ""
                                    }`}
                                  >
                                    {historyRedeemStates[entry.id]?.message}
                                  </div>
                                )}
                              </div>
                              {entry.pendingTokenMint && (
                                <div className="wallet-history__helper">Saved mint: {entry.pendingTokenMint}</div>
                              )}
                            </div>
                          )}
                          {entry.tokenState && (
                            <div className="wallet-history__section space-y-2">
                              <div className="wallet-history__section-title">Token state</div>
                              <div className="wallet-history__section-content space-y-2 text-xs text-secondary">
                                <div className="text-tertiary break-all">Mint: {entry.tokenState.mintUrl}</div>
                                <div className="flex flex-wrap gap-2 items-center">
                                  <button
                                    className="ghost-button button-sm pressable"
                                    onClick={() => performTokenStateCheck(entry)}
                                    disabled={historyCheckStates[entry.id]?.status === "pending"}
                                  >
                                    Check token state
                                  </button>
                                  {historyCheckStates[entry.id]?.status === "pending" && <span>Checking…</span>}
                                  {historyCheckStates[entry.id]?.status === "success" &&
                                    historyCheckStates[entry.id]?.message && (
                                      <span className="text-accent">{historyCheckStates[entry.id]?.message}</span>
                                    )}
                                  {historyCheckStates[entry.id]?.status === "error" &&
                                    historyCheckStates[entry.id]?.message && (
                                      <span className="text-rose-400">{historyCheckStates[entry.id]?.message}</span>
                                    )}
                                </div>
                                {typeof entry.tokenState.lastCheckedAt === "number" && (
                                  <div className="text-tertiary">
                                    Last checked: {new Date(entry.tokenState.lastCheckedAt).toLocaleString()}
                                  </div>
                                )}
                                {entry.tokenState.lastWitnesses && Object.keys(entry.tokenState.lastWitnesses).length > 0 && (
                                  <div className="space-y-1">
                                    <div className="text-tertiary">Witness data</div>
                                    {Object.entries(entry.tokenState.lastWitnesses).map(([y, witness]) => (
                                      <div key={y} className="break-all">
                                        <div className="text-tertiary">Y: {y}</div>
                                        <div>{witness}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {entry.mintQuote && (
                            <div className="wallet-history__section space-y-2">
                              <div className="wallet-history__section-title">Invoice</div>
                              <div className="wallet-history__section-content space-y-1 text-xs text-secondary">
                                {entry.mintQuote.mintUrl && (
                                  <div className="text-tertiary break-all">Mint: {entry.mintQuote.mintUrl}</div>
                                )}
                                <div className="text-tertiary">Amount: {entry.mintQuote.amount} sats</div>
                                <div className="flex flex-wrap gap-2 items-center">
                                  <button
                                    className="ghost-button button-sm pressable"
                                    onClick={() => handleCheckHistoryMintQuote(entry)}
                                    disabled={historyMintQuoteStates[entry.id]?.status === "pending"}
                                  >
                                    Check invoice
                                  </button>
                                  {historyMintQuoteStates[entry.id]?.status === "pending" && <span>Checking…</span>}
                                  {historyMintQuoteStates[entry.id]?.status === "success" &&
                                    historyMintQuoteStates[entry.id]?.message && (
                                      <span className="text-accent">{historyMintQuoteStates[entry.id]?.message}</span>
                                    )}
                                  {historyMintQuoteStates[entry.id]?.status === "error" &&
                                    historyMintQuoteStates[entry.id]?.message && (
                                      <span className="text-rose-400">{historyMintQuoteStates[entry.id]?.message}</span>
                                    )}
                                </div>
                                {entry.mintQuote.createdAt && (
                                  <div className="text-tertiary">
                                    Created: {new Date(entry.mintQuote.createdAt).toLocaleString()}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {entry.revertToken && (
                            <div className="wallet-history__section space-y-2">
                              <div className="wallet-history__section-title">Revert</div>
                              <div className="wallet-history__section-content flex flex-wrap gap-2 items-center text-xs text-secondary">
                                <button
                                  className="accent-button button-sm pressable"
                                  onClick={() => handleRevertHistoryToken(entry)}
                                  disabled={historyRevertState[entry.id]?.status === "pending"}
                                >
                                  Revert token
                                </button>
                                {historyRevertState[entry.id]?.status === "pending" && <span>Redeeming…</span>}
                                {historyRevertState[entry.id]?.status === "success" && historyRevertState[entry.id]?.message && (
                                  <span className="text-accent">{historyRevertState[entry.id]?.message}</span>
                                )}
                                {historyRevertState[entry.id]?.status === "error" && historyRevertState[entry.id]?.message && (
                                  <span className="text-rose-400">{historyRevertState[entry.id]?.message}</span>
                                )}
                              </div>
                            </div>
                          )}
                          <div className="wallet-history__section space-y-2">
                            <div className="wallet-history__section-title">Actions</div>
                            <div className="wallet-history__section-content flex flex-wrap gap-2 items-center text-xs text-secondary">
                              {canMarkTokenSpent && (
                                <button
                                  type="button"
                                  className="ghost-button button-sm pressable"
                                  onClick={() => handleMarkHistoryTokenSpent(entry)}
                                >
                                  Mark token spent
                                </button>
                              )}
                              <button
                                type="button"
                                className="ghost-button button-sm pressable"
                                onClick={() => handleDeleteHistoryEntry(entry)}
                              >
                                Delete entry
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div className="wallet-section text-sm text-secondary">
              {historyFilter === "pending" ? "No pending entries" : "No history yet"}
            </div>
          )
        ) : (
          <div className="wallet-section text-sm text-secondary">No history yet</div>
        )}
      </ActionSheet>

      {/* Mint balances */}
      <ActionSheet open={showMintBalances} onClose={()=>setShowMintBalances(false)} title="Mint balances">
        <div className="space-y-4 text-sm">
          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary uppercase tracking-wide">Active mint</div>
            <div className="flex gap-2 items-center">
              <input
                className="pill-input flex-1"
                value={mintInputSheet}
                onChange={(e)=>setMintInputSheet(e.target.value)}
                placeholder="https://mint.solife.me"
              />
              <button
                className="accent-button button-sm pressable"
                onClick={async ()=>{ try { await setMintUrl(mintInputSheet.trim()); refreshMintEntries(); } catch (e: any) { alert(e?.message || String(e)); } }}
              >Save</button>
            </div>
            <div className="text-xs text-secondary">Current: {mintUrl}</div>
          </div>

          <div className="wallet-section space-y-3">
            <div className="space-y-1">
              <div className="text-xs text-secondary uppercase tracking-wide">Saved mints</div>
              <div className="text-xs text-secondary">
                Keep the mints you use handy. We'll add new ones automatically when you receive eCash and keep them here until you remove them.
              </div>
            </div>
            {mintEntries.length === 0 ? (
              <div className="text-secondary">No saved mints yet. Add one above or receive eCash to get started.</div>
            ) : (
              <div className="space-y-2">
                {mintEntries.map((m) => (
                  <div key={m.url} className="bg-surface-muted border border-surface rounded-2xl p-3 flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="text-xs text-secondary">{m.url === mintUrl ? "Active" : "Mint"}</div>
                      <button
                        className="text-left text-primary underline decoration-dotted decoration-surface-border break-all"
                        title={m.url}
                        onClick={async ()=>{ try { await navigator.clipboard?.writeText(m.url); } catch {} }}
                      >{m.url}</button>
                    </div>
                    <div className="text-right space-y-1">
                      <div className="text-xs text-secondary">Balance</div>
                      <div className="font-semibold">{m.balance} sat</div>
                    </div>
                    <div className="flex flex-col gap-2 w-full sm:w-auto">
                      {m.url !== mintUrl && (
                        <button
                          className="accent-button button-sm pressable w-full"
                          onClick={async ()=>{ try { await setMintUrl(m.url); refreshMintEntries(); } catch (e: any) { alert(e?.message || String(e)); } }}
                        >
                          Set active
                        </button>
                      )}
                      <button
                        className="ghost-button button-sm pressable w-full text-rose-400"
                        onClick={()=>handleRemoveMintEntry(m.url)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </ActionSheet>

      <ActionSheet
        open={showNwcSheet}
        onClose={closeNwcSheets}
        title="Swap"
        actions={(
          <button className="ghost-button button-sm pressable" onClick={()=>setShowNwcManager(true)}>
            {hasNwcConnection ? "Manage NWC" : "Connect NWC"}
          </button>
        )}
      >
        <div className="space-y-4">
          <div className="wallet-section wallet-section--compact space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-secondary">From</div>
                {swapOptionList.length ? (
                  <div className="relative">
                    <select
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                      value={swapFromValue}
                      onChange={(event) => {
                        const next = event.target.value;
                        setSwapFromValue(next);
                        if (next && next === swapToValue) {
                          setSwapToValue("");
                        }
                      }}
                    >
                      <option value="">Select source</option>
                      {swapOptionList.map((option) => {
                        const meta = getSwapOptionMeta(option.value);
                        return (
                          <option key={`swap-from-${option.value}`} value={option.value}>
                            {meta.label}
                          </option>
                        );
                      })}
                    </select>
                    <div className="pill-input pill-input--compact lightning-mint-select__display lightning-mint-select__display--compact">
                      <div className="lightning-mint-select__label">
                        {swapFromValue ? getSwapOptionMeta(swapFromValue).label : "Select source"}
                      </div>
                      <div className="lightning-mint-select__balance">
                        {swapFromValue ? getSwapOptionMeta(swapFromValue).balanceLabel : "Choose a mint or wallet"}
                      </div>
                    </div>
                    <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                  </div>
                ) : (
                  <div className="text-sm text-secondary">Add a mint or connect NWC to start swapping.</div>
                )}
              </div>
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-secondary">To</div>
                {swapOptionList.length ? (
                  <div className="relative">
                    <select
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                      value={swapToValue}
                      onChange={(event) => {
                        const next = event.target.value;
                        setSwapToValue(next);
                        if (next && next === swapFromValue) {
                          setSwapFromValue("");
                        }
                      }}
                    >
                      <option value="">Select destination</option>
                      {swapOptionList.map((option) => {
                        const meta = getSwapOptionMeta(option.value);
                        return (
                          <option key={`swap-to-${option.value}`} value={option.value}>
                            {meta.label}
                          </option>
                        );
                      })}
                    </select>
                    <div className="pill-input pill-input--compact lightning-mint-select__display lightning-mint-select__display--compact">
                      <div className="lightning-mint-select__label">
                        {swapToValue ? getSwapOptionMeta(swapToValue).label : "Select destination"}
                      </div>
                      <div className="lightning-mint-select__balance">
                        {swapToValue ? getSwapOptionMeta(swapToValue).balanceLabel : "Choose a mint or wallet"}
                      </div>
                    </div>
                    <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                  </div>
                ) : (
                  <div className="text-sm text-secondary">Choose a destination mint or connect NWC.</div>
                )}
              </div>
            </div>
            <button
              type="button"
              className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
              onClick={canToggleCurrency ? handleTogglePrimary : undefined}
              disabled={!canToggleCurrency}
            >
              <div className="wallet-balance-card__amount lightning-amount-display__primary">{swapPrimaryAmountText}</div>
              <div className="wallet-balance-card__secondary lightning-amount-display__secondary">{swapSecondaryAmountText}</div>
            </button>
            <div className="grid grid-cols-3 gap-2">
              {(primaryCurrency === "usd"
                ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
                : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
              ).map((key) => {
                const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
                return (
                  <button
                    key={`swap-key-${key}`}
                    type="button"
                    className="glass-panel pressable py-2 text-lg font-semibold"
                    onClick={() => handleSwapAmountKeypadInput(handlerKey)}
                  >
                    {key === "clear" ? "Clear" : key}
                  </button>
                );
              })}
            </div>
            <button
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={handleSwapSubmit}
              disabled={!canSubmitSwap || swapInProgress}
            >
              {swapInProgress ? "Working…" : "Transfer"}
            </button>
            {swapScenario === "mint-to-mint" && mintSwapState !== "idle" && mintSwapState !== "error" && mintSwapStatusText && (
              <div className="text-xs text-secondary text-center">{mintSwapStatusText}</div>
            )}
            {swapScenario === "nwc-to-mint" && nwcFundInProgress && nwcFundStatusText && (
              <div className="text-xs text-secondary text-center">{nwcFundStatusText}</div>
            )}
            {swapScenario === "mint-to-nwc" && nwcWithdrawInProgress && nwcWithdrawStatusText && (
              <div className="text-xs text-secondary text-center">{nwcWithdrawStatusText}</div>
            )}
            {swapScenario === "mint-to-mint" && mintSwapState === "error" && mintSwapMessage && (
              <div className="text-xs text-rose-400 text-center">{mintSwapMessage}</div>
            )}
            {swapScenario === "nwc-to-mint" && nwcFundState === "error" && nwcFundMessage && (
              <div className="text-xs text-rose-400 text-center">{nwcFundMessage}</div>
            )}
            {swapScenario === "mint-to-nwc" && nwcWithdrawState === "error" && nwcWithdrawMessage && (
              <div className="text-xs text-rose-400 text-center">{nwcWithdrawMessage}</div>
            )}
            {swapScenario === "nwc-to-mint" && nwcFundInvoice && (
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={nwcFundInvoice}
                label="Mint invoice"
                copyLabel="Copy invoice"
                size={200}
              />
            )}
            {swapScenario === "mint-to-nwc" && nwcWithdrawInvoice && (
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={nwcWithdrawInvoice}
                label="Wallet invoice"
                copyLabel="Copy invoice"
                size={200}
              />
            )}
            {!swapOptionList.length && (
              <div className="text-xs text-secondary text-center">
                Add another mint or connect NWC to make a swap.
              </div>
            )}
          </div>
        </div>
      </ActionSheet>

      <ActionSheet
        open={showNwcManager}
        onClose={() => {
          setShowNwcManager(false);
          setNwcFeedback("");
          setNwcBusy(false);
        }}
        title="Manage NWC"
      >
        <div className="space-y-4 text-sm">
          {hasNwcConnection ? (
            <div className="wallet-section space-y-2 text-xs text-secondary">
              {nwcAlias && <div className="text-sm font-semibold text-primary">{nwcAlias}</div>}
              {nwcConnection?.walletLud16 && <div>{nwcConnection.walletLud16}</div>}
              <div className="break-all">Wallet npub: {nwcConnection?.walletNpub}</div>
              <div className="break-all">Client npub: {nwcConnection?.clientNpub}</div>
              <div className="break-all">Relay{(nwcConnection?.relayUrls?.length || 0) > 1 ? 's' : ''}: {nwcConnection?.relayUrls.join(", ")}</div>
              {nwcInfo?.methods && nwcInfo.methods.length > 0 && (
                <div>Methods: {nwcInfo.methods.join(", ")}</div>
              )}
              {nwcBalanceSats !== null && <div>Balance: {nwcBalanceSats} sats</div>}
              <div>Status: {nwcStatusLabel}</div>
            </div>
          ) : (
            <div className="wallet-section text-sm text-secondary">Paste your NWC connection string (nostr+walletconnect://…) to link an external wallet.</div>
          )}

          <div className="wallet-section space-y-3">
            <input
              className="pill-input w-full"
              placeholder="nostr+walletconnect://npub...?relay=wss://...&secret=..."
              value={nwcUrlInput}
              onChange={(e)=>setNwcUrlInput(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <button
                className="accent-button button-sm pressable"
                onClick={handleNwcConnect}
                disabled={nwcBusy || !nwcUrlInput.trim()}
              >{hasNwcConnection ? "Update connection" : "Connect"}</button>
              <button
                className="ghost-button button-sm pressable"
                onClick={handleNwcTest}
                disabled={nwcBusy || !hasNwcConnection}
              >Test</button>
              <button
                className="ghost-button button-sm pressable"
                onClick={handleNwcDisconnect}
                disabled={nwcBusy || !hasNwcConnection}
              >Disconnect</button>
            </div>
            {nwcBusy && <div className="text-xs text-secondary">Working…</div>}
            {nwcFeedback && <div className="text-xs text-secondary">{nwcFeedback}</div>}
            {nwcError && <div className="text-xs text-rose-400">{nwcError}</div>}
          </div>
        </div>
      </ActionSheet>
    </div>
  );

}
