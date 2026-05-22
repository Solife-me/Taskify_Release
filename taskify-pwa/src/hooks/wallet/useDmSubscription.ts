// @ts-nocheck
import { useCallback } from "react";
import { normalizeNostrPubkey } from "../../lib/nostr";
import { NostrSession } from "../../nostr/NostrSession";
import { isImageMime, isVideoMime, isAudioMime } from "../../lib/messengerAttachmentCrypto";
import { amountFromCashuToken } from "../../wallet/cashuProofHelpers";
import { parseShareEnvelope } from "../../lib/shareInbox";
import { truncatePreview } from "../../ui/wallet/walletModalUi";
import type { ContactProfile } from "../../lib/contacts";
import {
  parseProfileContent,
  loadContactProfileCache,
  pickPreferredProfilePhoto,
  isDataUrl,
  shouldCacheProfilePhoto,
  fetchProfilePhotoDataUrl,
  cachedContactProfileToDmProfile,
  type NostrEvent,
} from "../../wallet/walletModalHelpers";
import {
  generateGroupId,
  normalizeDmPeerHex,
  type WalletDmMessage,
  type WalletDmAttachment,
} from "../../hooks/wallet/useDmState";

export function useDmSubscription({
  compressedToRawHex,
  contactsRef,
  ensureNip05VerificationRef,
  dmPeerProfilesRef,
  dmPeerProfileLoadingRef,
  setDmPeerProfilesVersion,
  dmDeletedEventsRef,
  dmTempDeletedEventsRef,
  persistTempDeletedDmEvents,
  setDmTempDeletedEventsVersion,
  dmProcessedEventsRef,
  dmSubscriptionCloseRef,
  dmLastSyncRef,
  persistDmSyncMeta,
  dmBlockedPeersRef,
  messageItemsRef,
  setDmMessages,
  setDmReactions,
  groupChatsRef,
  upsertGroupChat,
  decryptNostrPaymentMessage,
  parseIncomingPaymentMessage,
  resolvePeerPubkey,
  stopDmSubscription,
  ensureNostrIdentity,
  defaultNostrRelays,
  handlePaymentRequestEventRef,
  DM_SYNC_LOOKBACK_SECONDS,
  persistDmPeerProfileCache,
  contactDisplayLabel,
}) {
  const ensurePeerProfile = useCallback(
    async (pubkey: string) => {
      const normalized = normalizeNostrPubkey(pubkey);
      if (!normalized) return null;
      const peerHex = compressedToRawHex(normalized).toLowerCase();
      if (dmPeerProfilesRef.current.has(peerHex)) return dmPeerProfilesRef.current.get(peerHex)!;
      const cachedProfiles = loadContactProfileCache();
      const cached = cachedProfiles[peerHex];
      const cachedProfile = cached?.profile ? cachedContactProfileToDmProfile(cached) : null;
      const contactEntry = contactsRef.current.find((c) => {
        const cn = normalizeNostrPubkey(c.npub || "");
        if (!cn) return false;
        return compressedToRawHex(cn).toLowerCase() === peerHex;
      });
      if (contactEntry) {
        dmPeerProfilesRef.current.set(peerHex, {
          username: contactEntry.username || contactEntry.name || cachedProfile?.username,
          displayName: contactDisplayLabel(contactEntry),
          lud16: contactEntry.address || undefined,
          paymentRequest: contactEntry.paymentRequest || undefined,
          nip05: contactEntry.nip05 || cachedProfile?.nip05 || undefined,
          picture: pickPreferredProfilePhoto(cached?.pictureDataUrl, contactEntry.picture, cachedProfile?.picture),
          about: contactEntry.about || cachedProfile?.about || undefined,
          creq: cachedProfile?.creq,
          relays:
            Array.isArray(contactEntry.relays) && contactEntry.relays.length
              ? contactEntry.relays
              : cachedProfile?.relays,
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
      if (cachedProfile) {
        dmPeerProfilesRef.current.set(peerHex, cachedProfile);
        setDmPeerProfilesVersion((v) => v + 1);
        if (cachedProfile.nip05) {
          ensureNip05VerificationRef.current?.(
            `dm-${peerHex}`,
            cachedProfile.nip05,
            pubkey,
            cached.updatedAt ?? null,
          );
        }
        return cachedProfile;
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
          const updatedAt = (profileEvent.created_at || 0) * 1000;
          const pictureUrl = typeof profile.picture === "string" ? profile.picture.trim() : "";
          const cachedPictureUrl = typeof cached?.profile.picture === "string" ? cached.profile.picture.trim() : "";
          const immediatePicture = pickPreferredProfilePhoto(
            pictureUrl && cached?.pictureDataUrl && pictureUrl === cachedPictureUrl ? cached.pictureDataUrl : undefined,
            profile.picture,
          );
          const displayProfile: ContactProfile = {
            ...profile,
            picture: immediatePicture,
          };
          dmPeerProfilesRef.current.set(peerHex, displayProfile);
          setDmPeerProfilesVersion((v) => v + 1);
          persistDmPeerProfileCache(
            peerHex,
            profile,
            updatedAt,
            immediatePicture && isDataUrl(immediatePicture) ? immediatePicture : undefined,
          );
          if (!immediatePicture && pictureUrl && shouldCacheProfilePhoto(pictureUrl)) {
            void fetchProfilePhotoDataUrl(pictureUrl).then((dataUrl) => {
              if (!dataUrl) return;
              const current = dmPeerProfilesRef.current.get(peerHex) || profile;
              dmPeerProfilesRef.current.set(peerHex, { ...current, picture: dataUrl });
              setDmPeerProfilesVersion((v) => v + 1);
              persistDmPeerProfileCache(peerHex, profile, updatedAt, dataUrl);
            });
          }
          if (profile.nip05) {
            ensureNip05VerificationRef.current?.(
              `dm-${peerHex}`,
              profile.nip05,
              pubkey,
              updatedAt,
            );
          }
          return displayProfile;
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
      defaultNostrRelays,
      normalizeNostrPubkey,
      parseProfileContent,
      persistDmPeerProfileCache,
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
      const tempDeletedExpiresAt = dmTempDeletedEventsRef.current.get(event.id) ?? 0;
      if (tempDeletedExpiresAt > Date.now()) {
        dmProcessedEventsRef.current.add(event.id);
        return;
      }
      if (tempDeletedExpiresAt > 0) {
        const nextTempDeleted = new Map(dmTempDeletedEventsRef.current);
        nextTempDeleted.delete(event.id);
        dmTempDeletedEventsRef.current = nextTempDeleted;
        persistTempDeletedDmEvents(nextTempDeleted);
        setDmTempDeletedEventsVersion((v) => v + 1);
      }
      const identity = ensureNostrIdentity();
      if (!identity) return;
      const decrypted = await decryptNostrPaymentMessage(event, identity.pubkey, identity.secret);
      if (!decrypted) {
        dmProcessedEventsRef.current.add(event.id);
        return;
      }
      const tempDeletedRumorExpiresAt = decrypted.rumorId
        ? dmTempDeletedEventsRef.current.get(decrypted.rumorId) ?? 0
        : 0;
      if (tempDeletedRumorExpiresAt > Date.now()) {
        dmProcessedEventsRef.current.add(event.id);
        return;
      }
      // Handle kind-7 emoji reactions (NIP-25 inside NIP-17 giftwrap)
      if (decrypted.kind === 7) {
        const tags = Array.isArray(decrypted.tags) ? decrypted.tags : [];
        const eTag = tags.find((t) => Array.isArray(t) && t[0] === "e");
        const reactedToEventId = typeof eTag?.[1] === "string" ? eTag[1] : null;
        if (reactedToEventId && decrypted.senderPubkey) {
          const emoji = (decrypted.content || "").trim() || "❤️";
          const sender = decrypted.senderPubkey.toLowerCase();
          setDmReactions((prev) => {
            const next = new Map(prev);
            const existing = next.get(reactedToEventId) || [];
            const filtered = existing.filter((r) => r.senderPubkey !== sender);
            if (emoji !== "-") filtered.push({ emoji, senderPubkey: sender, reactEventId: event.id });
            next.set(reactedToEventId, filtered);
            return next;
          });
        }
        dmProcessedEventsRef.current.add(event.id);
        return;
      }
      if (!decrypted.content) {
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
      const matchedItem = messageItemsRef.current.find((item) => item.dmEventId && item.dmEventId === event.id);

      // 0xchat-compatible encrypted file attachment (kind-15 rumor).
      // Inner rumor content is the plaintext URL to the encrypted blob; the crypto
      // parameters live in dedicated tags per nostr-dart nip_017.dart:69-72.
      const fileAttachment = (() => {
        if (decrypted.kind !== 15) return null;
        const tags = Array.isArray(decrypted.tags) ? decrypted.tags : [];
        let mimeType: string | null = null;
        let algorithm: string | null = null;
        let keyHex: string | null = null;
        let nonceHex: string | null = null;
        let sha256Tag: string | null = null;
        let sizeTag: number | null = null;
        let widthTag: number | null = null;
        let heightTag: number | null = null;
        let filenameTag: string | null = null;
        for (const tag of tags) {
          if (!Array.isArray(tag) || typeof tag[0] !== "string") continue;
          const name = tag[0];
          const value = typeof tag[1] === "string" ? tag[1] : "";
          if (name === "file-type" && value) mimeType = value;
          else if (name === "encryption-algorithm" && value) algorithm = value;
          else if (name === "decryption-key" && value) keyHex = value;
          else if (name === "decryption-nonce" && value) nonceHex = value;
          else if (name === "x" && value) sha256Tag = value;
          else if (name === "size" && value) {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) sizeTag = n;
          } else if (name === "dim" && value) {
            const parts = value.split(/x/i);
            const w = Number(parts[0]);
            const h = Number(parts[1]);
            if (Number.isFinite(w) && w > 0) widthTag = w;
            if (Number.isFinite(h) && h > 0) heightTag = h;
          } else if (name === "filename" && value) filenameTag = value;
        }
        const url = (decrypted.content || "").trim();
        if (!url || !keyHex || !nonceHex || !algorithm) return null;
        if (!/^https?:\/\//i.test(url)) return null;
        return {
          type: "file" as const,
          url,
          mimeType: mimeType || "application/octet-stream",
          filename: filenameTag,
          size: sizeTag,
          width: widthTag,
          height: heightTag,
          algorithm,
          keyHex,
          nonceHex,
          sha256: sha256Tag,
        };
      })();

      if (fileAttachment) {
        attachment = fileAttachment;
        const label = fileAttachment.filename || (isImageMime(fileAttachment.mimeType)
          ? "Photo"
          : isVideoMime(fileAttachment.mimeType)
            ? "Video"
            : isAudioMime(fileAttachment.mimeType)
              ? "Audio"
              : "File");
        preview = isImageMime(fileAttachment.mimeType)
          ? `📷 ${label}`
          : isVideoMime(fileAttachment.mimeType)
            ? `🎬 ${label}`
            : isAudioMime(fileAttachment.mimeType)
              ? `🎵 ${label}`
              : `📎 ${label}`;
      } else if (share && share.item.type === "board") {
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
            const decodedAmount = amountFromCashuToken(paymentPayload);
            amountSat = decodedAmount > 0 ? decodedAmount : null;
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

      const createdAt =
        (typeof decrypted.createdAt === "number" && Number.isFinite(decrypted.createdAt) && decrypted.createdAt > 0
          ? Math.floor(decrypted.createdAt)
          : 0) ||
        (typeof event.created_at === "number" && Number.isFinite(event.created_at) && event.created_at > 0
          ? Math.floor(event.created_at)
          : 0) ||
        Math.floor(Date.now() / 1000);
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
      // Detect group messages: 2+ p-tag recipients in the inner rumor
      const rumorRecipients = Array.isArray(decrypted.recipientPubkeys)
        ? decrypted.recipientPubkeys.map((p) => p.toLowerCase())
        : [];
      const rumorSender = (decrypted.senderPubkey || "").toLowerCase();
      const isGroupMessage = rumorRecipients.length >= 2;
      let groupId: string | undefined;
      let groupName = "";
      if (isGroupMessage && rumorSender) {
        const allMembers = [...new Set([rumorSender, ...rumorRecipients])];
        groupId = generateGroupId(allMembers);
        // Extract subject tag for group name
        const subjectTag = Array.isArray(decrypted.tags)
          ? decrypted.tags.find((t) => Array.isArray(t) && t[0] === "subject")
          : null;
        groupName = typeof subjectTag?.[1] === "string" ? subjectTag[1].trim() : "";
        // Auto-create or update group metadata
        const existing = groupChatsRef.current.find((g) => g.groupId === groupId);
        if (!existing) {
          upsertGroupChat({
            groupId,
            name: groupName || "Group",
            members: [...new Set([rumorSender, ...rumorRecipients])].sort(),
            createdAt,
            ...(groupName ? { nameUpdatedAt: createdAt } : {}),
          });
        } else if (groupName) {
          upsertGroupChat({ ...existing, name: groupName, nameUpdatedAt: createdAt });
        }
        // Fetch profiles for all group members
        for (const member of [rumorSender, ...rumorRecipients]) {
          void ensurePeerProfile(member);
        }
      }
      const isGroupMetadataOnly =
        isGroupMessage &&
        !!groupId &&
        !!groupName &&
        !attachment &&
        !decrypted.content.trim();
      if (isGroupMetadataOnly) {
        dmProcessedEventsRef.current.add(event.id);
        return;
      }

      // Extract reply-to event ID from the inner rumor's "e" tags (NIP-17 reply threading)
      const innerTags = Array.isArray(decrypted.tags) ? decrypted.tags : [];
      const replyETag = innerTags.find((t) => Array.isArray(t) && t[0] === "e");
      const replyToEventId = typeof replyETag?.[1] === "string" ? replyETag[1] : undefined;

      const message: WalletDmMessage = {
        id: crypto.randomUUID(),
        eventId: event.id,
        // rumorEventId is the inner rumor's canonical ID — used for cross-client reactions/replies.
        // The outer giftwrap id (event.id) differs per recipient; the rumor id is the same for all.
        ...(decrypted.rumorId ? { rumorEventId: decrypted.rumorId } : {}),
        peerPubkey: isGroupMessage && groupId ? groupId : (peerPubkey || event.pubkey).toLowerCase(),
        isIncoming,
        createdAt,
        content: decrypted.content,
        preview,
        attachment: attachment ?? { type: "text" },
        ...(isGroupMessage && groupId ? { groupId, senderPubkey: rumorSender } : {}),
        ...(replyToEventId ? { replyToEventId } : {}),
      };

      dmProcessedEventsRef.current.add(event.id);
      setDmMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.eventId === event.id);
        const next =
          existingIndex >= 0
            ? prev.map((entry, index) =>
                index === existingIndex ? { ...message, id: entry.id || message.id } : entry,
              )
            : [...prev, message];
        next.sort((a, b) => a.createdAt - b.createdAt);
        if (next.length > 400) next.shift();
        return next;
      });
    },
    [
      decryptNostrPaymentMessage,
      ensureNostrIdentity,
      ensurePeerProfile,
      normalizeNostrPubkey,
      parseIncomingPaymentMessage,
      persistTempDeletedDmEvents,
      resolvePeerPubkey,
      upsertGroupChat,
    ],
  );

  const startDmSubscription = useCallback(async () => {
    stopDmSubscription();
    const identity = ensureNostrIdentity();
    if (!identity) return;
    const relays = defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")).filter(Boolean);
    if (!relays.length) return;
    const now = Math.floor(Date.now() / 1000);
    const lastCompletedSyncAt = Math.floor(dmLastSyncRef.current / 1000);
    // NIP-17 giftwraps use random past timestamps (up to 2 days back per spec).
    // Look back 3 days before last sync to ensure all events with jittered timestamps are caught.
    const incrementalSince = lastCompletedSyncAt > 0 ? Math.max(0, lastCompletedSyncAt - 3 * 24 * 60 * 60) : 0;
    const since = incrementalSince > 0 ? incrementalSince : Math.max(0, now - DM_SYNC_LOOKBACK_SECONDS);
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
      const completedAt = Date.now();
      dmLastSyncRef.current = completedAt;
      persistDmSyncMeta({ lastCompletedSyncAt: completedAt });
    } catch (err) {
      console.warn("Failed to sync DMs", err);
    }
  }, [DM_SYNC_LOOKBACK_SECONDS, defaultNostrRelays, ensureNostrIdentity, handleDmEvent, persistDmSyncMeta, stopDmSubscription]);

  return {
    ensurePeerProfile,
    getPeerProfile,
    handleDmEvent,
    startDmSubscription,
  };
}
