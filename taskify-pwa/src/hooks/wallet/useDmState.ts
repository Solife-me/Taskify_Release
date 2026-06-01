// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR } from "../../storage/taskifyDb";
import {
  LS_CONTACT_PROFILE_CACHE,
  LS_DM_ARCHIVED_THREADS,
  LS_DM_BLOCKED_PEERS,
  LS_DM_DELETED_EVENTS,
  LS_DM_MESSAGE_CACHE,
  LS_DM_SYNC_META,
  LS_DM_TEMP_DELETED_EVENTS,
  LS_DM_THREAD_READ_STATE,
  LS_GROUP_CHATS,
  LS_GROUP_LEFT,
  LS_GROUP_MUTED,
} from "../../localStorageKeys";
import type { ContactProfile } from "../../lib/contacts";
import type { WalletMessageItem } from "../../types/walletMessages";
import { chatRetentionCutoffMs } from "../../domains/tasks/settingsTypes";
import { mergeGroupChats, normalizeGroupChatRecord, type GroupChat } from "../../lib/groupChatState";
import type { SharedTaskPayload } from "../../lib/shareInbox";
import { normalizeNostrPubkey } from "../../lib/nostr";

// ─── DM Types ───────────────────────────────────────────────────────────────

export type WalletDmAttachment =
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
  | {
      type: "event";
      title?: string | null;
      start?: string | null;
      end?: string | null;
      whenLabel?: string | null;
      inviteId?: string | null;
      status?: string | null;
      canonical?: string | null;
      view?: string | null;
    }
  | { type: "payment"; amountSat?: number | null; detail?: string | null; raw?: string | null }
  | {
      type: "file";
      url: string;
      mimeType: string;
      filename?: string | null;
      size?: number | null;
      width?: number | null;
      height?: number | null;
      algorithm: string;
      keyHex: string;
      nonceHex: string;
      sha256?: string | null;
    }
  | { type: "text" };

export type DecryptedNostrDm = {
  content: string;
  senderPubkey?: string | null;
  recipientPubkey?: string | null;
  recipientPubkeys?: string[] | null;
  createdAt?: number | null;
  kind?: number | null;
  tags?: string[][] | null;
  /** The inner rumor's event ID (NIP-17 canonical message ID for cross-client compat) */
  rumorId?: string | null;
};

export type DmReaction = {
  emoji: string;
  senderPubkey: string;
  reactEventId: string;
};

export type WalletDmMessage = {
  id: string;
  eventId: string;
  /** The inner NIP-17 rumor event ID — canonical cross-client identifier for reactions/replies */
  rumorEventId?: string;
  peerPubkey: string; // for DMs: peer hex; for groups: groupId
  isIncoming: boolean;
  createdAt: number;
  content: string;
  preview: string;
  attachment?: WalletDmAttachment;
  groupId?: string; // set for group messages
  senderPubkey?: string; // set for group messages — who sent this specific message
  replyToEventId?: string; // "e" tag from inner kind-14 rumor
};

export type WalletDmThread = {
  peerPubkey: string; // for DMs: peer hex; for groups: groupId
  messages: WalletDmMessage[];
  lastCreatedAt: number;
  lastPreview: string;
  isStranger: boolean;
  groupId?: string; // set for group threads
};

export type PendingDmMessage = {
  id: string;
  content: string;
  peerPubkey: string;
  createdAt: number;
  status: "sending" | "sent" | "done" | "failed";
  // File-attachment pending state (in-flight encrypt + upload + giftwrap)
  file?: {
    filename: string;
    mimeType: string;
    size: number;
    previewUrl?: string; // object URL for local preview of in-flight image
    progress: number; // 0..1
    phase: "encrypting" | "uploading" | "sending";
  } | null;
};

export type DmThreadListEntry =
  | { kind: "thread"; thread: WalletDmThread; lastCreatedAt: number }
  | { kind: "strangers"; lastCreatedAt: number; lastPreview: string };

export type DmSyncMeta = {
  lastCompletedSyncAt: number;
};

// ─── Constants & Helpers ────────────────────────────────────────────────────

export const MAX_GROUP_MEMBERS = 17;

export function generateGroupId(members: string[]): string {
  const sorted = [...new Set(members.map((m) => m.toLowerCase()))].sort();
  const data = new TextEncoder().encode(sorted.join(","));
  const hash = sha256(data);
  return bytesToHex(hash);
}

export function normalizeDmPeerHex(value: string | null | undefined): string | null {
  const normalized = normalizeNostrPubkey(value || "");
  const candidate = (normalized || value || "").trim();
  if (!candidate) return null;
  if (/^(02|03)[0-9a-fA-F]{64}$/.test(candidate)) return candidate.slice(-64).toLowerCase();
  if (/^0x[0-9a-fA-F]{64}$/.test(candidate)) return candidate.slice(-64).toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(candidate)) return candidate.toLowerCase();
  return candidate.toLowerCase();
}

// ─── Private helpers ────────────────────────────────────────────────────────

type CachedContactProfile = { profile: ContactProfile; updatedAt: number; pictureDataUrl?: string };

const PROFILE_PHOTO_CACHE_LIMIT_BYTES = 350_000;
const CHAT_ATTACH_TRAY_MIN_HEIGHT = 248;
const CHAT_ATTACH_TRAY_MAX_HEIGHT = 380;
const CHAT_ATTACH_TRAY_FALLBACK_RATIO = 0.38;

function measureDefaultChatAttachTrayHeight(): number {
  if (typeof window === "undefined") return 300;
  return Math.round(
    Math.min(
      CHAT_ATTACH_TRAY_MAX_HEIGHT,
      Math.max(CHAT_ATTACH_TRAY_MIN_HEIGHT, window.innerHeight * CHAT_ATTACH_TRAY_FALLBACK_RATIO),
    ),
  );
}

function estimateDataUrlSize(value: string): number {
  const parts = value.split(",", 2);
  if (parts.length < 2) return value.length;
  const base64 = parts[1];
  return Math.ceil((base64.length * 3) / 4);
}

function isDataUrl(value: string): boolean {
  return /^data:image\//i.test(value.trim());
}

function pickPreferredProfilePhoto(...candidates: Array<string | null | undefined>): string | undefined {
  const normalized = candidates
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  if (!normalized.length) return undefined;
  return normalized.find((value) => isDataUrl(value)) || normalized[0];
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

function readGroupChats(): GroupChat[] {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_GROUP_CHATS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => normalizeGroupChatRecord(entry)).filter((group): group is GroupChat => !!group);
  } catch {
    return [];
  }
}

function readStoredStringSet(storageKey: string): Set<string> {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function readStoredTimestampMap(storageKey: string): Map<string, number> {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, storageKey);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const now = Date.now();
      return new Map(
        parsed
          .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
          .filter(Boolean)
          .map((entry) => [entry, now] as const),
      );
    }
    if (!parsed || typeof parsed !== "object") return new Map();
    return new Map(
      Object.entries(parsed)
        .map(([key, value]) => {
          const normalizedKey = typeof key === "string" ? key.trim().toLowerCase() : "";
          const normalizedValue =
            typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
          return normalizedKey && normalizedValue > 0 ? ([normalizedKey, normalizedValue] as const) : null;
        })
        .filter(Boolean) as Array<readonly [string, number]>,
    );
  } catch {
    return new Map();
  }
}

function readStoredExpiryMap(storageKey: string): Map<string, number> {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, storageKey);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const now = Date.now();
    return new Map(
      Object.entries(parsed)
        .map(([key, value]) => {
          const normalizedKey = typeof key === "string" ? key.trim() : "";
          const expiresAt =
            typeof value === "number" && Number.isFinite(value) && value > now ? Math.floor(value) : 0;
          return normalizedKey && expiresAt > 0 ? ([normalizedKey, expiresAt] as const) : null;
        })
        .filter(Boolean) as Array<readonly [string, number]>,
    );
  } catch {
    return new Map();
  }
}

function isWalletDmAttachment(value: unknown): value is WalletDmAttachment {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string";
}

function isWalletDmMessage(value: unknown): value is WalletDmMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WalletDmMessage>;
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.peerPubkey === "string" &&
    typeof candidate.isIncoming === "boolean" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.content === "string" &&
    typeof candidate.preview === "string"
  );
}

function isResolvedPendingDm(pending: PendingDmMessage, messages: WalletDmMessage[]): boolean {
  return messages.some(
    (message) =>
      !message.isIncoming &&
      message.peerPubkey === pending.peerPubkey &&
      message.content === pending.content &&
      Math.abs(message.createdAt - pending.createdAt) < 15,
  );
}

function readDmCache(): WalletDmMessage[] {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_DM_MESSAGE_CACHE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isWalletDmMessage)
      .map((entry) => ({
        id: entry.id || entry.eventId,
        eventId: entry.eventId,
        peerPubkey: entry.peerPubkey.toLowerCase(),
        isIncoming: entry.isIncoming,
        createdAt: entry.createdAt,
        content: entry.content,
        preview: entry.preview,
        attachment: isWalletDmAttachment(entry.attachment) ? entry.attachment : { type: "text" },
        ...(typeof entry.groupId === "string" ? { groupId: entry.groupId } : {}),
        ...(typeof entry.senderPubkey === "string" ? { senderPubkey: entry.senderPubkey.toLowerCase() } : {}),
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

function readDmSyncMeta(): DmSyncMeta {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_DM_SYNC_META);
    if (!raw) return { lastCompletedSyncAt: 0 };
    const parsed = JSON.parse(raw) as Partial<DmSyncMeta> | null;
    const value = typeof parsed?.lastCompletedSyncAt === "number" ? parsed.lastCompletedSyncAt : 0;
    return { lastCompletedSyncAt: Number.isFinite(value) ? value : 0 };
  } catch {
    return { lastCompletedSyncAt: 0 };
  }
}

function cachedContactProfileToDmProfile(entry: CachedContactProfile): ContactProfile {
  return {
    ...entry.profile,
    picture: pickPreferredProfilePhoto(entry.pictureDataUrl, entry.profile.picture),
  };
}

function buildInitialDmPeerProfiles(messages: WalletDmMessage[]): Map<string, ContactProfile> {
  const cachedProfiles = loadContactProfileCache();
  const next = new Map<string, ContactProfile>();
  messages.forEach((message) => {
    const peerHex = normalizeDmPeerHex(message.peerPubkey);
    if (!peerHex || next.has(peerHex)) return;
    const cached = cachedProfiles[peerHex];
    if (!cached?.profile) return;
    next.set(peerHex, cachedContactProfileToDmProfile(cached));
  });
  return next;
}

// ─── Hook Interface ──────────────────────────────────────────────────────────

export interface UseDmStateOptions {
  open: boolean;
  isChatPage: boolean;
  chatMessageRetention: string;
  showToast: (msg: string, duration?: number) => void;
  messageItems: any[];
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useDmState({
  open,
  isChatPage,
  chatMessageRetention,
  showToast,
  messageItems,
}: UseDmStateOptions) {
  const [chatView, setChatView] = useState<
    "threads" | "conversation" | "new-message" | "new-group-select" | "new-group-name" | "group-info" | "group-members" | "group-name-edit"
  >("threads");
  const [chatCompose, setChatCompose] = useState("");
  const [pendingMessages, setPendingMessages] = useState<PendingDmMessage[]>([]);
  const [groupChats, setGroupChats] = useState<GroupChat[]>(() => readGroupChats());
  const [groupSelectMembers, setGroupSelectMembers] = useState<Set<string>>(new Set());
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [renameGroupDraft, setRenameGroupDraft] = useState("");
  const [renameGroupBusy, setRenameGroupBusy] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [groupMembersSearch, setGroupMembersSearch] = useState("");
  const [groupInfoTab, setGroupInfoTab] = useState<"info" | "photos" | "links">("info");
  const groupChatsRef = useRef<GroupChat[]>(groupChats);
  useEffect(() => { groupChatsRef.current = groupChats; }, [groupChats]);
  const dmMutedGroupsRef = useRef<Map<string, number>>(readStoredTimestampMap(LS_GROUP_MUTED));
  const [dmMutedGroupsVersion, setDmMutedGroupsVersion] = useState(0);
  const dmLeftGroupsRef = useRef<Set<string>>(readStoredStringSet(LS_GROUP_LEFT));
  const [dmLeftGroupsVersion, setDmLeftGroupsVersion] = useState(0);
  const dmThreadReadAtRef = useRef<Map<string, number>>(readStoredTimestampMap(LS_DM_THREAD_READ_STATE));
  const [dmThreadReadAtVersion, setDmThreadReadAtVersion] = useState(0);
  const [attachTrayOpen, setAttachTrayOpen] = useState(false);
  const [chatKeyboardHeight, setChatKeyboardHeight] = useState(0);
  const [chatKeyboardHeightCache, setChatKeyboardHeightCache] = useState(() => measureDefaultChatAttachTrayHeight());
  const chatComposeInputRef = useRef<HTMLInputElement>(null);
  const chatPhotoInputRef = useRef<HTMLInputElement>(null);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesInnerRef = useRef<HTMLDivElement>(null);
  const dragTouchStartX = useRef(0);
  const dragTouchStartY = useRef(0);
  const dragDirectionLocked = useRef<"horizontal" | "vertical" | null>(null);
  const dmListViewRef = useRef<"list" | "strangers">("list");
  const scrollToMessageIdRef = useRef<string | null>(null);
  const dmAutoScrollStateRef = useRef<{ threadPeer: string | null; itemCount: number }>({
    threadPeer: null,
    itemCount: 0,
  });
  const chatModeUsesContacts = isChatPage && (chatView === "new-message" || chatView === "new-group-select" || chatView === "new-group-name");
  const initialDmMessages = useMemo(() => readDmCache(), []);
  const initialDmPeerProfiles = useMemo(() => buildInitialDmPeerProfiles(initialDmMessages), [initialDmMessages]);
  const [dmMessages, setDmMessages] = useState<WalletDmMessage[]>(() => initialDmMessages);
  const [dmExpandedMessages, setDmExpandedMessages] = useState<Set<string>>(new Set());
  const [dmMessageActions, setDmMessageActions] = useState<{ eventId: string; copyValue: string; msg: WalletDmMessage } | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<WalletDmMessage | null>(null);
  const [dmReactions, setDmReactions] = useState<Map<string, DmReaction[]>>(new Map());
  const [dmInfoMessage, setDmInfoMessage] = useState<WalletDmMessage | null>(null);
  const [dmForwardMessage, setDmForwardMessage] = useState<WalletDmMessage | null>(null);
  const [dmReactionDetail, setDmReactionDetail] = useState<{ eventId: string } | null>(null);
  useEffect(() => {
    if (!open || !isChatPage || typeof window === "undefined") return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateKeyboardHeight = () => {
      const layoutHeight = Math.max(window.innerHeight, document.documentElement?.clientHeight || 0);
      const nextHeight = Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop));
      if (nextHeight > 120) {
        setChatKeyboardHeight(nextHeight);
        setChatKeyboardHeightCache(
          Math.min(
            CHAT_ATTACH_TRAY_MAX_HEIGHT,
            Math.max(CHAT_ATTACH_TRAY_MIN_HEIGHT, nextHeight),
          ),
        );
      } else {
        setChatKeyboardHeight(0);
      }
    };
    updateKeyboardHeight();
    viewport.addEventListener("resize", updateKeyboardHeight);
    viewport.addEventListener("scroll", updateKeyboardHeight);
    window.addEventListener("orientationchange", updateKeyboardHeight);
    return () => {
      viewport.removeEventListener("resize", updateKeyboardHeight);
      viewport.removeEventListener("scroll", updateKeyboardHeight);
      window.removeEventListener("orientationchange", updateKeyboardHeight);
    };
  }, [isChatPage, open]);
  useEffect(() => {
    if (chatView === "conversation") return;
    setAttachTrayOpen(false);
  }, [chatView]);
  const dmLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dmDeletedEventsRef = useRef<Set<string>>(new Set());
  const [dmDeletedEventsVersion, setDmDeletedEventsVersion] = useState(0);
  const dmTempDeletedEventsRef = useRef<Map<string, number>>(readStoredExpiryMap(LS_DM_TEMP_DELETED_EVENTS));
  const [dmTempDeletedEventsVersion, setDmTempDeletedEventsVersion] = useState(0);
  const dmArchivedThreadsRef = useRef<Map<string, number>>(readStoredTimestampMap(LS_DM_ARCHIVED_THREADS));
  const [dmArchivedThreadsVersion, setDmArchivedThreadsVersion] = useState(0);
  const dmBlockedPeersRef = useRef<Set<string>>(new Set());
  const [, setDmBlockedPeersVersion] = useState(0);
  const dmPeerProfilesRef = useRef<Map<string, ContactProfile>>(initialDmPeerProfiles);
  const dmPeerProfileLoadingRef = useRef<Set<string>>(new Set());
  const [, setDmPeerProfilesVersion] = useState(0);
  const dmProcessedEventsRef = useRef<Set<string>>(new Set());
  const dmSubscriptionCloseRef = useRef<(() => void) | null>(null);
  const dmLastSyncRef = useRef<number>(readDmSyncMeta().lastCompletedSyncAt || 0);
  const messageItemsRef = useRef<WalletMessageItem[]>(messageItems);
  useEffect(() => {
    messageItemsRef.current = messageItems;
  }, [messageItems]);
  const [dmView, setDmView] = useState<"list" | "thread" | "strangers">("list");
  const [activeThreadPeer, setActiveThreadPeer] = useState<string | null>(null);
  const [dmSearch, setDmSearch] = useState("");
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);
  useEffect(() => {
    setAttachTrayOpen(false);
  }, [activeThreadPeer]);
  useEffect(() => {
    setPendingMessages([]);
  }, [activeThreadPeer]);
  const visiblePendingMessages = useMemo(
    () => pendingMessages.filter((message) => !isResolvedPendingDm(message, dmMessages)),
    [dmMessages, pendingMessages],
  );
  // Remove optimistic pending bubbles from state once the real outgoing DM is present.
  useEffect(() => {
    setPendingMessages(prev =>
      {
        const next = prev.filter((message) => !isResolvedPendingDm(message, dmMessages));
        return next.length === prev.length ? prev : next;
      },
    );
  }, [dmMessages]);
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
  const persistTempDeletedDmEvents = useCallback((events: Map<string, number>) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_DM_TEMP_DELETED_EVENTS, JSON.stringify(Object.fromEntries(events)));
    } catch {
      // ignore storage failures
    }
  }, []);
  const persistArchivedDmThreads = useCallback((threads: Map<string, number>) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_DM_ARCHIVED_THREADS, JSON.stringify(Object.fromEntries(threads)));
    } catch {
      // ignore storage failures
    }
  }, []);
  const pruneTempDeletedDmEvents = useCallback(() => {
    const now = Date.now();
    const next = new Map(
      Array.from(dmTempDeletedEventsRef.current.entries()).filter(([, expiresAt]) => expiresAt > now),
    );
    if (next.size === dmTempDeletedEventsRef.current.size) return false;
    dmTempDeletedEventsRef.current = next;
    persistTempDeletedDmEvents(next);
    setDmTempDeletedEventsVersion((v) => v + 1);
    return true;
  }, [persistTempDeletedDmEvents]);
  const persistBlockedPeers = useCallback((peers: Set<string>) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_DM_BLOCKED_PEERS, JSON.stringify(Array.from(peers)));
    } catch {
      // ignore storage failures
    }
  }, []);
  const persistDmMessages = useCallback((messages: WalletDmMessage[]) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_DM_MESSAGE_CACHE, JSON.stringify(messages));
    } catch {
      // ignore storage failures
    }
  }, []);
  const persistDmThreadReadState = useCallback((next: Map<string, number>) => {
    try {
      idbKeyValue.setItem(
        TASKIFY_STORE_NOSTR,
        LS_DM_THREAD_READ_STATE,
        JSON.stringify(Object.fromEntries(Array.from(next.entries()))),
      );
    } catch {
      // ignore storage failures
    }
  }, []);
  const persistGroupChats = useCallback((groups: GroupChat[]) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_GROUP_CHATS, JSON.stringify(groups));
    } catch {
      // ignore storage failures
    }
  }, []);
  const persistGroupStateSet = useCallback((storageKey: string, values: Set<string>) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, storageKey, JSON.stringify(Array.from(values)));
    } catch {
      // ignore storage failures
    }
  }, []);
  const upsertGroupChat = useCallback(
    (group: GroupChat) => {
      setGroupChats((prev) => {
        const idx = prev.findIndex((g) => g.groupId === group.groupId);
        const nextGroup = idx >= 0 ? mergeGroupChats(prev[idx], group) : mergeGroupChats(null, group);
        const next = idx >= 0 ? [...prev.slice(0, idx), nextGroup, ...prev.slice(idx + 1)] : [...prev, nextGroup];
        persistGroupChats(next);
        return next;
      });
    },
    [persistGroupChats],
  );
  const persistDmSyncMeta = useCallback((meta: DmSyncMeta) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_DM_SYNC_META, JSON.stringify(meta));
      dmLastSyncRef.current = meta.lastCompletedSyncAt || 0;
    } catch {
      // ignore storage failures
    }
  }, []);
  useEffect(() => {
    pruneTempDeletedDmEvents();
    const timer = window.setInterval(() => {
      pruneTempDeletedDmEvents();
    }, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [pruneTempDeletedDmEvents]);

  useEffect(() => {
    const cutoff = chatRetentionCutoffMs(chatMessageRetention as any);
    if (cutoff == null) return;
    setDmMessages((prev) => {
      const next = prev.filter((m) => m.createdAt * 1000 >= cutoff);
      if (next.length === prev.length) return prev;
      persistDmMessages(next);
      return next;
    });
  }, [chatMessageRetention, persistDmMessages]);

  useEffect(() => {
    const handler = () => {
      setDmMessages([]);
      persistDmMessages([]);
    };
    window.addEventListener("taskify:clear-chat-history", handler);
    return () => window.removeEventListener("taskify:clear-chat-history", handler);
  }, [persistDmMessages]);
  const persistDmPeerProfileCache = useCallback(
    (peerHex: string, profile: ContactProfile, updatedAt: number, pictureDataUrl?: string) => {
      const normalizedPeerHex = normalizeDmPeerHex(peerHex);
      if (!normalizedPeerHex) return;
      const cache = loadContactProfileCache();
      const existing = cache[normalizedPeerHex];
      const existingUpdatedAt = existing?.updatedAt ?? 0;
      const incomingUpdatedAt =
        Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : existingUpdatedAt;
      const preferIncoming = incomingUpdatedAt >= existingUpdatedAt;
      const mergeString = (incoming?: string, current?: string) => {
        const incomingValue = typeof incoming === "string" ? incoming.trim() : "";
        const currentValue = typeof current === "string" ? current.trim() : "";
        return preferIncoming ? incomingValue || currentValue || undefined : currentValue || incomingValue || undefined;
      };
      const normalizeRelays = (value?: string[]) =>
        Array.isArray(value) && value.length
          ? Array.from(
              new Set(
                value
                  .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
                  .filter(Boolean),
              ),
            )
          : undefined;
      const incomingPictureUrl = typeof profile.picture === "string" ? profile.picture.trim() : "";
      const existingPictureUrl = typeof existing?.profile.picture === "string" ? existing.profile.picture.trim() : "";
      const nextPictureDataUrl =
        (pictureDataUrl && isDataUrl(pictureDataUrl) ? pictureDataUrl.trim() : "") ||
        (existing?.pictureDataUrl && incomingPictureUrl && incomingPictureUrl === existingPictureUrl
          ? existing.pictureDataUrl
          : undefined);
      const nextEntry = normalizeCachedContactProfile({
        profile: {
          username: mergeString(profile.username, existing?.profile.username),
          displayName: mergeString(profile.displayName, existing?.profile.displayName),
          about: mergeString(profile.about, existing?.profile.about),
          picture: mergeString(profile.picture, existing?.profile.picture),
          lud16: mergeString(profile.lud16, existing?.profile.lud16),
          nip05: mergeString(profile.nip05, existing?.profile.nip05),
          paymentRequest: mergeString(profile.paymentRequest, existing?.profile.paymentRequest),
          creq: mergeString(profile.creq, existing?.profile.creq),
          relays: preferIncoming
            ? normalizeRelays(profile.relays) || normalizeRelays(existing?.profile.relays)
            : normalizeRelays(existing?.profile.relays) || normalizeRelays(profile.relays),
        },
        updatedAt: Math.max(existingUpdatedAt, incomingUpdatedAt),
        pictureDataUrl: nextPictureDataUrl,
      });
      if (!nextEntry) return;
      cache[normalizedPeerHex] = nextEntry;
      persistContactProfileCache(cache);
    },
    [],
  );
  useEffect(() => {
    persistDmMessages(dmMessages);
  }, [dmMessages, persistDmMessages]);

  useEffect(() => {
    if (!isChatPage || !open || chatView !== "threads") return;
    if (dmMessages.length > 0) return;
    const cached = readDmCache();
    if (cached.length > 0) {
      setDmMessages(cached);
    }
  }, [chatView, dmMessages.length, isChatPage, open]);

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
      if ((dmTempDeletedEventsRef.current.get(msg.eventId) ?? 0) > Date.now()) {
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
  }, [dmDeletedEventsVersion, dmMessages, dmTempDeletedEventsVersion]);
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
    setReplyToMessage(null);
  }, [activeThreadPeer, cancelDmLongPress, dmView]);

  return {
    chatView, setChatView,
    chatCompose, setChatCompose,
    pendingMessages, setPendingMessages,
    groupChats, setGroupChats,
    groupSelectMembers, setGroupSelectMembers,
    groupNameDraft, setGroupNameDraft,
    renameGroupDraft, setRenameGroupDraft,
    renameGroupBusy, setRenameGroupBusy,
    activeGroupId, setActiveGroupId,
    groupMembersSearch, setGroupMembersSearch,
    groupInfoTab, setGroupInfoTab,
    groupChatsRef,
    dmMutedGroupsRef, dmMutedGroupsVersion, setDmMutedGroupsVersion,
    dmLeftGroupsRef, dmLeftGroupsVersion, setDmLeftGroupsVersion,
    dmThreadReadAtRef, dmThreadReadAtVersion, setDmThreadReadAtVersion,
    attachTrayOpen, setAttachTrayOpen,
    chatKeyboardHeight, setChatKeyboardHeight,
    chatKeyboardHeightCache, setChatKeyboardHeightCache,
    chatComposeInputRef, chatPhotoInputRef, chatFileInputRef,
    messagesScrollRef, messagesInnerRef,
    dragTouchStartX, dragTouchStartY, dragDirectionLocked,
    dmListViewRef, scrollToMessageIdRef, dmAutoScrollStateRef,
    chatModeUsesContacts,
    dmMessages, setDmMessages,
    dmExpandedMessages, setDmExpandedMessages,
    dmMessageActions, setDmMessageActions,
    replyToMessage, setReplyToMessage,
    dmReactions, setDmReactions,
    dmInfoMessage, setDmInfoMessage,
    dmForwardMessage, setDmForwardMessage,
    dmReactionDetail, setDmReactionDetail,
    dmLongPressTimerRef,
    dmDeletedEventsRef, dmDeletedEventsVersion, setDmDeletedEventsVersion,
    dmTempDeletedEventsRef, dmTempDeletedEventsVersion, setDmTempDeletedEventsVersion,
    dmArchivedThreadsRef, dmArchivedThreadsVersion, setDmArchivedThreadsVersion,
    dmBlockedPeersRef, setDmBlockedPeersVersion,
    dmPeerProfilesRef, dmPeerProfileLoadingRef, setDmPeerProfilesVersion,
    dmProcessedEventsRef, dmSubscriptionCloseRef, dmLastSyncRef,
    messageItemsRef,
    dmView, setDmView,
    activeThreadPeer, setActiveThreadPeer,
    dmSearch, setDmSearch,
    scrollToMessageId, setScrollToMessageId,
    visiblePendingMessages,
    toggleDmMessageExpanded, isDmMessageExpanded,
    copyMessageValue,
    persistDeletedDmEvents, persistTempDeletedDmEvents, persistArchivedDmThreads,
    pruneTempDeletedDmEvents, persistBlockedPeers, persistDmMessages,
    persistDmThreadReadState, persistGroupChats, persistGroupStateSet,
    upsertGroupChat, persistDmSyncMeta, persistDmPeerProfileCache,
    buildDmCopyValue, handleDeleteDmMessage, cancelDmLongPress,
  };
}
