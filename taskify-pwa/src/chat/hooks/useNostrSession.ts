/**
 * The Nostr connection chat runs on: one relay pool, the user's identity, publishing, and NIP-04 /
 * NIP-17 direct-message decryption. Extracted from the wallet's `useNostrPoolState` (which now
 * builds on this) so chat works with the wallet turned off.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nip04, nip44 } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";
import { nip17MessageRecipients, openNip17GiftWrap } from "taskify-core";
import { nip17Crypto } from "taskify-runtime-nostr";
import { LocalKeySigner } from "../../identity/signer";
import { normalizeNostrPubkey } from "../../lib/nostr";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR } from "../../storage/taskifyDb";
import { LS_PROFILE_EVENT_IDS } from "../../localStorageKeys";
import { LS_NOSTR_SK, TASKIFY_NOSTR_KEY_UPDATED_EVENT } from "../../nostrKeys";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";
import { DEFAULT_FILE_STORAGE_SERVER, normalizeFileServerUrl } from "../../lib/fileStorage";
import { SessionPool } from "../../nostr/SessionPool";
import {
  readStoredNostrIdentity,
  EMPTY_NOSTR_IDENTITY_INFO,
  type NostrEvent,
  type NostrIdentity,
  type NostrIdentityInfo,
} from "../chatHelpers";
import { findCashuToken } from "../cashuTokenText";
import type { DecryptedNostrDm } from "./useDmState";

export interface UseNostrSessionOptions {
  debug: boolean;
  fileStorageServer: string;
  dmSubscriptionCloseRef: React.MutableRefObject<(() => void) | null>;
  /** Chat always loads the identity; the wallet only does when payment requests are on. */
  identityEnabled: boolean;
  /** Re-read on the wallet's open, receive-mode and send-mode transitions. */
  identityRefreshKeys?: readonly [open?: boolean, receiveMode?: string | null, sendMode?: string | null];
}

/** Chat messages, file messages and reactions. */
const NIP17_CHAT_RUMOR_KINDS = new Set([14, 15, 7]);

export function useNostrSession({
  debug,
  fileStorageServer,
  dmSubscriptionCloseRef,
  identityEnabled,
  identityRefreshKeys = [],
}: UseNostrSessionOptions) {
  const [refreshOpen, refreshReceiveMode, refreshSendMode] = identityRefreshKeys;
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
    identityEnabled ? readStoredNostrIdentity() : EMPTY_NOSTR_IDENTITY_INFO,
  );

  const ensureNostrPool = useCallback(() => {
    if (!nostrPoolRef.current) {
      if (debug) {
        console.debug("[wallet] Initialising nostr pool", defaultNostrRelays);
      }
      nostrPoolRef.current = new SessionPool();
      nostrPoolClosingRef.current = false;
    }
    return nostrPoolRef.current;
  }, [defaultNostrRelays, debug]);

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
          pool.close();
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
    async (pool: SessionPool, relays: string[], event: NostrEvent) => {
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
      if (debug) {
        console.debug("[wallet] Loaded nostr identity", identity.pubkey.slice(0, 8));
      }
      return identity;
    }
    return null;
  }, [readNostrIdentity, debug]);

  const decryptNostrDm = useCallback(
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
          if (debug) {
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
                if (debug) {
                  console.debug("[wallet] Failed to decrypt DM", event.id, inner);
                }
                return null;
              }
            } else {
              if (debug) {
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
        if (event.kind === 1059) {
          // taskify-core's NIP-17 rules, shared with iOS and the CLI (fixtures/nip17-vectors.json).
          const opened = await openNip17GiftWrap(event, new LocalKeySigner(secretHex), nip17Crypto);
          if (!opened || !NIP17_CHAT_RUMOR_KINDS.has(opened.rumor.kind)) return null;
          const recipients = nip17MessageRecipients(opened, normalizedIdentity);
          if (!recipients) return null;
          const { rumor } = opened;
          return {
            content: rumor.content,
            senderPubkey: opened.senderPubkey,
            recipientPubkey: recipients[0] ?? null,
            recipientPubkeys: recipients,
            createdAt: rumor.created_at > 0 ? Math.floor(rumor.created_at) : null,
            kind: rumor.kind,
            tags: rumor.tags,
            // The rumor's id is the cross-client message id (the same for every recipient).
            rumorId: rumor.id,
          };
        }
      } catch (err) {
        if (debug) {
          console.debug("[wallet] Failed to decrypt payment request message", event.id, err);
        }
      }
      return null;
    },
    [debug],
  );

  /**
   * A structured payment (JSON) or a Cashu token found in a message, which chat shows as a token
   * card the user can copy. Chat never redeems anything.
   */
  const parseIncomingPaymentMessage = useCallback((plain: string): Record<string, unknown> | string | null => {
    const trimmed = (plain || "").trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // not JSON
    }
    return findCashuToken(trimmed);
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
    [],
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
  }, [dmSubscriptionCloseRef]);

  const refreshNostrIdentity = useCallback(() => {
    setNostrIdentityInfo(identityEnabled ? readNostrIdentity() : EMPTY_NOSTR_IDENTITY_INFO);
  }, [identityEnabled, readNostrIdentity]);

  useEffect(() => {
    refreshNostrIdentity();
  }, [refreshNostrIdentity, refreshOpen, refreshReceiveMode, refreshSendMode]);

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
    defaultNostrRelays,
    preferredFileServer,
    nostrPoolRef,
    nostrPoolClosingRef,
    nostrSubscriptionActiveRef,
    nostrIdentityRef,
    nostrIdentityInfo,
    setNostrIdentityInfo,
    ensureNostrPool,
    closeNostrPool,
    isReplaceableRejection,
    safePublish,
    readNostrIdentity,
    readProfileEventId,
    persistProfileEventId,
    ensureNostrIdentity,
    decryptNostrDm,
    /** @deprecated name kept for the wallet; same function as decryptNostrDm. */
    decryptNostrPaymentMessage: decryptNostrDm,
    parseIncomingPaymentMessage,
    resolvePeerPubkey,
    stopDmSubscription,
    refreshNostrIdentity,
  };
}
