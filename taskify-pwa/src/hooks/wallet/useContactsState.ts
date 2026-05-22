// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey, nip19 } from "nostr-tools";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR } from "../../storage/taskifyDb";
import {
  LS_LIGHTNING_CONTACTS,
  LS_CONTACTS_SYNC_META,
  LS_CONTACT_NIP05_CACHE,
  LS_PROFILE_METADATA_CACHE,
  LS_PROFILE_EVENT_IDS,
} from "../../localStorageKeys";
import { getSkSync as nostrSkSync } from "../../lib/nostrSkStore";
import {
  loadContactsFromStorage,
  normalizeContact,
  makeContactId,
  formatContactNpub,
  sanitizeUsername,
} from "../../lib/contacts";
import type { Contact } from "../../lib/contacts";
import { normalizeNostrPubkey } from "../../lib/nostr";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ContactViewMode = "list" | "detail" | "edit";

export type ContactEditDraft = {
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

export type Nip05CheckState = {
  status: "pending" | "valid" | "invalid";
  nip05: string;
  npub: string;
  checkedAt: number;
  contactUpdatedAt: number | null;
};

export type ContactSyncMeta = {
  lastEventId: string | null;
  lastUpdatedAt: number | null;
  fingerprint: string | null;
  publicFollows: PublicFollow[];
};

type PublicFollow = {
  pubkey: string;
  relay?: string;
  petname?: string;
  username?: string;
  nip05?: string;
};

type NostrIdentity = {
  secret: string;
  pubkey: string;
};

type NostrIdentityInfo = {
  identity: NostrIdentity | null;
  reason: string | null;
};

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

// ─── Private constants ───────────────────────────────────────────────────────

const PROFILE_SHARE_CACHE_KEY = "taskify.profileSharePayload.v1";

// ─── Private helpers ─────────────────────────────────────────────────────────

function readStoredNostrIdentity(): NostrIdentityInfo {
  const raw = nostrSkSync().trim();
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

// ─── Hook Interface ───────────────────────────────────────────────────────────

export interface UseContactsStateOptions {
  isChatPage: boolean;
  showTabSwitcher: boolean;
  isContactsPage: boolean;
  chatView: string;
  setChatView: (view: any) => void;
  setWalletTab: (tab: string) => void;
  activeThreadPeer: string | null;
  persistProfileEventId: (pubkey: string, eventId: string | null) => void;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useContactsState({
  isChatPage,
  showTabSwitcher,
  isContactsPage,
  chatView,
  setChatView,
  setWalletTab,
  activeThreadPeer,
  persistProfileEventId,
}: UseContactsStateOptions) {
  const readNostrIdentity = useCallback(readStoredNostrIdentity, []);

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
  const [contactReturnView, setContactReturnView] = useState<"new-message" | "group-members" | "group-info">("new-message");
  const [contactDetailOverride, setContactDetailOverride] = useState<Contact | null>(null);
  const [shareContactPickerOpen, setShareContactPickerOpen] = useState(false);
  const [shareContactPickerMode, setShareContactPickerMode] = useState<"recipient" | "chat-source">("recipient");
  const [shareContactSource, setShareContactSource] = useState<Contact | null>(null);
  const [shareContactStatus, setShareContactStatus] = useState<string | null>(null);
  const [shareContactBusy, setShareContactBusy] = useState(false);
  // Tracks which thread peer was active when the chat-source picker was opened,
  // so the effect below only closes it when the user switches conversations.
  const shareContactOpenedAtPeerRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shareContactPickerOpen || shareContactPickerMode !== "chat-source" || chatView === "conversation") return;
    setShareContactPickerOpen(false);
    setShareContactPickerMode("recipient");
    setShareContactSource(null);
    setShareContactStatus(null);
  }, [chatView, shareContactPickerMode, shareContactPickerOpen]);
  useEffect(() => {
    if (!shareContactPickerOpen || shareContactPickerMode !== "chat-source") return;
    // Only close if the active thread actually changed since the picker was opened.
    if (activeThreadPeer === shareContactOpenedAtPeerRef.current) return;
    setShareContactPickerOpen(false);
    setShareContactPickerMode("recipient");
    setShareContactSource(null);
    setShareContactStatus(null);
  }, [activeThreadPeer, shareContactPickerMode, shareContactPickerOpen]);
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
  }, [resetContactEditDraft, setWalletTab]);
  const handleStartAddContact = useCallback(() => {
    resetContactEditDraft();
    setContactEditError("");
    setContactLookupError("");
    setContactLookupInput("");
    setShowCustomContactFields(false);
    setContactDetailOverride(null);
    setContactReturnView("new-message");
    setContactView("edit");
  }, [resetContactEditDraft]);
  const handleBackToContactsList = useCallback(() => {
    setContactView("list");
    setActiveContactId(null);
    setContactDetailOverride(null);
    if (isChatPage) {
      setChatView(contactReturnView);
    }
    setContactReturnView("new-message");
  }, [contactReturnView, isChatPage, setChatView]);
  const handleReturnToProfileCard = useCallback(() => {
    setActiveContactId("profile");
    setContactDetailOverride(null);
    setContactView("detail");
    if (isChatPage) {
      setChatView("new-message");
    }
  }, [isChatPage, setChatView]);
  const contactsPublishQueuedRef = useRef(false);
  const [contactsContext, setContactsContext] = useState<"lightning" | "ecash" | null>(null);
  const contactsContextRef = useRef<"lightning" | "ecash" | null>(null);
  const contactsFingerprintRef = useRef<string | null>(null);
  const nip51MigrationInFlightRef = useRef(false);
  const contactProfilesRefreshedRef = useRef(false);
  const textEncoderRef = useRef<TextEncoder | null>(null);
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

  return {
    contacts, setContacts,
    contactsOpen, setContactsOpen,
    nip05Checks, setNip05Checks,
    ensureNip05VerificationRef, isNip05VerifiedForRef,
    contactsRef, skipContactsEventRef, skipContactsTimerRef,
    contactsTabOpen, setContactsTabOpen,
    contactsPanelRef,
    contactSyncState, setContactSyncState,
    contactsPublishState, setContactsPublishState,
    setContactsPublishMessage,
    contactSyncMetaRef, contactSyncMeta, setContactSyncMeta,
    persistContactSyncMeta,
    profileForm, setProfileForm,
    profileSharePayload, setProfileSharePayload,
    profileEventIdRef, profileFormRef,
    profileStatus, setProfileStatus,
    profileMessage, setProfileMessage,
    profileUpdatedAt, setProfileUpdatedAt,
    profileEditorOpen, setProfileEditorOpen,
    contactLookupInput, setContactLookupInput,
    contactLookupBusy, setContactLookupBusy,
    contactLookupError, setContactLookupError,
    showCustomContactFields, setShowCustomContactFields,
    contactView, setContactView,
    activeContactId, setActiveContactId,
    contactReturnView, setContactReturnView,
    contactDetailOverride, setContactDetailOverride,
    shareContactPickerOpen, setShareContactPickerOpen,
    shareContactPickerMode, setShareContactPickerMode,
    shareContactSource, setShareContactSource,
    shareContactStatus, setShareContactStatus,
    shareContactBusy, setShareContactBusy,
    shareContactOpenedAtPeerRef,
    contactEditDraft, setContactEditDraft,
    contactEditError, setContactEditError,
    profilePhotoError, setProfilePhotoError,
    profilePhotoBusy, setProfilePhotoBusy,
    profilePhotoInputRef, profilePhotoUploadRef,
    publicFollowPickerOpen, setPublicFollowPickerOpen,
    resetContactEditDraft, closeContactsTab,
    handleStartAddContact, handleBackToContactsList, handleReturnToProfileCard,
    contactsPublishQueuedRef, contactsContext, setContactsContext,
    contactsContextRef, contactsFingerprintRef,
    nip51MigrationInFlightRef, contactProfilesRefreshedRef,
    computeContactsFingerprint,
    upsertContact, compressedToRawHex, formatNpub, formatNpubDisplay,
  };
}
