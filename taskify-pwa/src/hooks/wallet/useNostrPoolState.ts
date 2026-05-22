// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nip04, nip44 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { type PaymentRequestPayload } from "@cashu/cashu-ts";
import { encodePeanut } from "../../wallet/peanut";
import { normalizeNostrPubkey } from "../../lib/nostr";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR, TASKIFY_STORE_WALLET } from "../../storage/taskifyDb";
import {
  LS_PROFILE_EVENT_IDS,
  LS_SPENT_NOSTR_PAYMENTS,
} from "../../localStorageKeys";
import { LS_NOSTR_SK, TASKIFY_NOSTR_KEY_UPDATED_EVENT } from "../../nostrKeys";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";
import { DEFAULT_FILE_STORAGE_SERVER, normalizeFileServerUrl } from "../../lib/fileStorage";
import { SessionPool } from "../../nostr/SessionPool";
import {
  readStoredNostrIdentity,
  extractFirstCashuTokenFromText,
  EMPTY_NOSTR_IDENTITY_INFO,
  type NostrEvent,
  type NostrIdentity,
  type NostrIdentityInfo,
} from "../../wallet/walletModalHelpers";
import type { DecryptedNostrDm } from "./useDmState";

export interface UseNostrPoolStateOptions {
  walletDebugEnabled: boolean;
  paymentRequestsEnabled: boolean;
  fileStorageServer: string;
  sendTokenStr: string;
  nutTokenCopied: boolean;
  setNutTokenCopied: (v: boolean) => void;
  setLockSendToPubkey: (v: boolean) => void;
  setSendLockPubkeyInput: (v: string) => void;
  setSendLockError: (v: string) => void;
  textEncoderRef: React.MutableRefObject<TextEncoder | null>;
  spentIncomingPaymentsRef: React.MutableRefObject<Map<string, string>>;
  spentIncomingTokenFingerprintsRef: React.MutableRefObject<Set<string>>;
  dmSubscriptionCloseRef: React.MutableRefObject<(() => void) | null>;
  open: boolean;
  receiveMode: string | null;
  sendMode: string | null;
}

export function useNostrPoolState({
  walletDebugEnabled,
  paymentRequestsEnabled,
  fileStorageServer,
  sendTokenStr,
  nutTokenCopied,
  setNutTokenCopied,
  setLockSendToPubkey,
  setSendLockPubkeyInput,
  setSendLockError,
  textEncoderRef,
  spentIncomingPaymentsRef,
  spentIncomingTokenFingerprintsRef,
  dmSubscriptionCloseRef,
  open,
  receiveMode,
  sendMode,
}: UseNostrPoolStateOptions) {
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
  const [nostrIdentityInfo, setNostrIdentityInfo] = useState<NostrIdentityInfo>(() =>
    paymentRequestsEnabled ? readStoredNostrIdentity() : EMPTY_NOSTR_IDENTITY_INFO,
  );

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

  const readNostrIdentity = useCallback(readStoredNostrIdentity, []);

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

  const PAYMENT_REQUEST_DEBUG = walletDebugEnabled;

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

          return {
            content,
            senderPubkey: event.pubkey,
            recipientPubkey,
            recipientPubkeys,
            createdAt:
              typeof event.created_at === "number" && Number.isFinite(event.created_at) && event.created_at > 0
                ? Math.floor(event.created_at)
                : null,
          };
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
          if (!rumor || (rumor.kind !== 14 && rumor.kind !== 15 && rumor.kind !== 7) || typeof rumor.content !== "string") {
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
          const rumorCreatedAt =
            typeof rumor.created_at === "number" && Number.isFinite(rumor.created_at) && rumor.created_at > 0
              ? Math.floor(rumor.created_at)
              : null;
          // The inner rumor's id is the canonical cross-client message identifier (NIP-17).
          // It is the same for all recipients of the same message, unlike the outer giftwrap id.
          const rumorId =
            typeof (rumor as any).id === "string" && /^[0-9a-f]{64}$/i.test((rumor as any).id)
              ? ((rumor as any).id as string)
              : null;
          return {
            content: rumor.content,
            senderPubkey,
            recipientPubkey: rumorRecipients[0] ?? null,
            recipientPubkeys: rumorRecipients,
            createdAt: rumorCreatedAt,
            kind: typeof rumor.kind === "number" ? rumor.kind : null,
            tags: Array.isArray(rumor.tags) ? (rumor.tags as string[][]) : null,
            rumorId,
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
      // Always return raw 64-char hex (no "02"/"03" prefix) so peerPubkey is consistent
      // with the format used in openConversationForPeer.
      const toRaw = (v: string | null | undefined): string | null => {
        if (!v) return null;
        const lc = v.toLowerCase();
        if (/^(02|03)[0-9a-f]{64}$/.test(lc)) return lc.slice(2);
        if (/^[0-9a-f]{64}$/.test(lc)) return lc;
        return null;
      };

      const normalizedIdentity = normalizeNostrPubkey(identityPubkey) ?? identityPubkey;
      const normalizedSender = senderPubkey ? normalizeNostrPubkey(senderPubkey) ?? senderPubkey : null;
      const normalizedRecipient = recipientPubkey ? normalizeNostrPubkey(recipientPubkey) ?? recipientPubkey : null;

      // Normal outgoing: sender is identity, recipient is someone else → peer is recipient
      if (normalizedRecipient && normalizedRecipient !== normalizedIdentity) {
        return toRaw(normalizedRecipient) ?? normalizedRecipient;
      }
      // Normal incoming: sender is someone else → peer is sender
      if (normalizedSender && normalizedSender !== normalizedIdentity) {
        return toRaw(normalizedSender) ?? normalizedSender;
      }
      // Self-send (NIP-17 note-to-self): both sender and recipient equal identity.
      // Do NOT fall through to event.pubkey (that's the ephemeral giftwrap key).
      if (normalizedSender === normalizedIdentity && normalizedRecipient === normalizedIdentity) {
        return toRaw(identityPubkey) ?? identityPubkey.toLowerCase();
      }

      // Fallback: use giftwrap's p-tag recipient if it differs from identity
      const pTag = Array.isArray(event.tags)
        ? event.tags.find((tag) => Array.isArray(tag) && tag[0] === "p" && typeof tag[1] === "string")
        : null;
      const peer = pTag?.[1];
      const normalizedPeer = peer ? normalizeNostrPubkey(peer) ?? peer : null;
      if (normalizedPeer && normalizedPeer !== normalizedIdentity) {
        return toRaw(normalizedPeer) ?? normalizedPeer;
      }

      return toRaw(normalizedSender) ?? toRaw(identityPubkey) ?? identityPubkey.toLowerCase();
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

  const refreshNostrIdentity = useCallback(() => {
    setNostrIdentityInfo(paymentRequestsEnabled ? readNostrIdentity() : EMPTY_NOSTR_IDENTITY_INFO);
  }, [paymentRequestsEnabled, readNostrIdentity]);

  useEffect(() => {
    refreshNostrIdentity();
  }, [open, receiveMode, refreshNostrIdentity, sendMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LS_NOSTR_SK) {
        refreshNostrIdentity();
      }
    };
    window.addEventListener(TASKIFY_NOSTR_KEY_UPDATED_EVENT, refreshNostrIdentity);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(TASKIFY_NOSTR_KEY_UPDATED_EVENT, refreshNostrIdentity);
      window.removeEventListener("storage", handleStorage);
    };
  }, [refreshNostrIdentity]);

  useEffect(() => {
    nostrIdentityRef.current = nostrIdentityInfo.identity;
  }, [nostrIdentityInfo]);

  return {
    claimingEventIds,
    setClaimingEventIds,
    defaultNostrRelays,
    preferredFileServer,
    nostrPoolRef,
    nostrPoolClosingRef,
    nostrSubscriptionActiveRef,
    nostrIdentityRef,
    nostrIdentityInfo,
    setNostrIdentityInfo,
    peanutSendToken,
    ensureNostrPool,
    closeNostrPool,
    isReplaceableRejection,
    safePublish,
    resetSendLockSettings,
    readNostrIdentity,
    readProfileEventId,
    persistProfileEventId,
    ensureNostrIdentity,
    fingerprintIncomingToken,
    rebuildSpentFingerprints,
    addSpentIncomingPayment,
    isIncomingPaymentSpent,
    decryptNostrPaymentMessage,
    parseIncomingPaymentMessage,
    resolvePeerPubkey,
    stopDmSubscription,
    refreshNostrIdentity,
  };
}
