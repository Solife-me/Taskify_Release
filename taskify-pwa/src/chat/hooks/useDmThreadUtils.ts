// @ts-nocheck
import { useCallback } from "react";

export function useDmThreadUtils({
  // Reactive state values
  inboxPendingItems,
  messageItemsByEventId,
  pendingMessageItemsByEventId,
  pendingCalendarInvitesByEventId,
  pendingCalendarInvites,
  paymentHistoryByEventId,
  contactIndex,
  dmArchivedThreadsVersion,
  groupChats,
  dmSearch,
  displayDmMessages,
  activeThreadPeer,
  shareContactSource,
  profileForm,
  // Stable setters
  setSharedContactPreview,
  setActiveThreadPeer,
  setDmView,
  setChatView,
  setContactView,
  setActiveContactId,
  setContactDetailOverride,
  setContactReturnView,
  setDmSearch,
  setDmMessages,
  setActiveGroupId,
  setAttachTrayOpen,
  setShareContactPickerOpen,
  setShareContactPickerMode,
  setShareContactSource,
  setShareContactStatus,
  setShareContactBusy,
  // Stable refs
  dmArchivedThreadsRef,
  dmPeerProfilesRef,
  nostrIdentityRef,
  groupChatsRef,
  isNip05VerifiedForRef,
  chatComposeInputRef,
  chatPhotoInputRef,
  chatFileInputRef,
  shareContactOpenedAtPeerRef,
  // Stable functions/utilities
  normalizeNostrPubkey,
  compressedToRawHex,
  formatNpubDisplay,
  shortenNpubDisplay,
  pickPreferredProfilePhoto,
  makeContactId,
  normalizeContact,
  dmThreadKeyForThread,
  formatContactNpub,
  formatNpub,
  buildContactShareEnvelope,
  sendShareMessage,
  readNostrIdentity,
  defaultNostrRelays,
  buildWalletMessageSyntheticEventId,
  buildCalendarInviteSyntheticEventId,
  normalizeDmPeerHex,
  showToast,
  LS_NOSTR_RELAYS,
  kvStorage,
}) {
  const isUnreadThreadStatus = useCallback((status) => {
    if (!status) return false;
    return (
      status !== "accepted" &&
      status !== "deleted" &&
      status !== "dismissed" &&
      status !== "declined" &&
      status !== "tentative" &&
      status !== "read"
    );
  }, []);

  const collectUnreadThreadItemEventIds = useCallback(
    (messages, peerPubkey) => {
      const unreadIds = new Set();
      messages.forEach((message) => {
        const item = messageItemsByEventId.get(message.eventId) || pendingMessageItemsByEventId.get(message.eventId);
        if (isUnreadThreadStatus(item?.status)) {
          unreadIds.add(message.eventId);
        }
        const invite = pendingCalendarInvitesByEventId.get(message.eventId);
        if (isUnreadThreadStatus(invite?.status)) {
          unreadIds.add(message.eventId);
        }
      });
      const normalizedPeer = normalizeDmPeerHex(peerPubkey || messages[0]?.peerPubkey || "");
      if (normalizedPeer) {
        (inboxPendingItems || []).forEach((item) => {
          if (!isUnreadThreadStatus(item.status)) return;
          const itemPeer = normalizeDmPeerHex(item.sender?.pubkey || item.sender?.npub);
          if (itemPeer !== normalizedPeer) return;
          unreadIds.add(buildWalletMessageSyntheticEventId(item));
        });
        (pendingCalendarInvites || []).forEach((invite) => {
          if (!isUnreadThreadStatus(invite.status)) return;
          const invitePeer = normalizeDmPeerHex(invite.sender?.pubkey || invite.sender?.npub);
          if (invitePeer !== normalizedPeer) return;
          unreadIds.add(buildCalendarInviteSyntheticEventId(invite));
        });
      }
      return Array.from(unreadIds);
    },
    [
      inboxPendingItems,
      isUnreadThreadStatus,
      messageItemsByEventId,
      pendingCalendarInvites,
      pendingCalendarInvitesByEventId,
      pendingMessageItemsByEventId,
    ],
  );

  const dmPreviewForMessage = useCallback(
    (msg) => {
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

  const peerLabelFor = useCallback(
    (peerHex) => {
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
      const picture = pickPreferredProfilePhoto(profile?.picture, contact?.picture);
      return { label, subtitle, picture, verifiedNip05 };
    },
    [contactIndex, formatNpubDisplay],
  );

  const sharedContactMetaFor = useCallback(
    (npub, fallbackName, fallbackPicture) => {
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
      const picture = pickPreferredProfilePhoto(profile?.picture, fallbackPicture);
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

  const buildSharedContactPreview = useCallback(
    (attachment, item) => {
      const attachmentNpub = attachment?.npub || item?.contact?.npub || "";
      const normalizedNpub = normalizeNostrPubkey(attachmentNpub);
      const contactHex = normalizedNpub ? compressedToRawHex(normalizedNpub).toLowerCase() : null;
      const profile = contactHex ? dmPeerProfilesRef.current.get(contactHex) : undefined;
      const normalized = normalizeContact({
        id: item?.id ? `shared-contact-${item.id}` : makeContactId(),
        kind: attachmentNpub ? "nostr" : "custom",
        name:
          item?.contact?.name ||
          attachment?.contactName ||
          attachment?.displayName ||
          profile?.displayName ||
          attachment?.username ||
          profile?.username ||
          "",
        displayName: attachment?.displayName || item?.contact?.displayName || profile?.displayName || "",
        username: attachment?.username || item?.contact?.username || profile?.username || "",
        address: attachment?.address || item?.contact?.address || profile?.lud16 || "",
        npub: attachmentNpub,
        nip05: attachment?.nip05 || item?.contact?.nip05 || profile?.nip05 || "",
        about: profile?.about || "",
        picture: pickPreferredProfilePhoto(profile?.picture, attachment?.picture || item?.contact?.picture || null),
        source: "sync",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      if (!normalized) return null;
      return {
        contact: normalized,
        itemId: item?.id ?? attachment?.taskId ?? null,
        status: item?.status ?? attachment?.status ?? null,
      };
    },
    [compressedToRawHex, makeContactId, normalizeContact, normalizeNostrPubkey],
  );

  const openSharedContactPreview = useCallback(
    (attachment, item) => {
      const preview = buildSharedContactPreview(attachment, item);
      if (!preview) {
        showToast("Unable to open shared contact", 2200);
        return;
      }
      setSharedContactPreview(preview);
    },
    [buildSharedContactPreview, showToast],
  );

  const isArchivedDmThread = useCallback(
    (thread) => {
      void dmArchivedThreadsVersion;
      const key = dmThreadKeyForThread(thread);
      const archivedAt = key ? dmArchivedThreadsRef.current.get(key) ?? 0 : 0;
      if (archivedAt <= 0) return false;
      return !thread.messages.some(
        (message) => !message.eventId.startsWith("draft-") && message.createdAt * 1000 > archivedAt,
      );
    },
    [dmArchivedThreadsVersion],
  );

  const matchesDmThreadSearch = useCallback(
    (thread) => {
      if (!dmSearch.trim()) return true;
      const groupName = thread.groupId ? (groupChats.find((g) => g.groupId === thread.groupId)?.name ?? "") : "";
      const meta = thread.groupId ? { label: groupName, subtitle: undefined } : peerLabelFor(thread.peerPubkey);
      const haystack = `${meta.label} ${meta.subtitle ?? ""} ${groupName} ${thread.lastPreview} ${thread.peerPubkey}`.toLowerCase();
      return haystack.includes(dmSearch.trim().toLowerCase());
    },
    [dmSearch, groupChats, peerLabelFor],
  );

  const openConversationForPeer = useCallback(
    (peerHex) => {
      // Normalise to raw 64-char hex (strip "02"/"03" prefix if present)
      const raw = (peerHex || "").trim().toLowerCase();
      const normalizedPeer = /^(02|03)[0-9a-f]{64}$/.test(raw) ? raw.slice(2) : raw;
      if (!normalizedPeer) return false;
      // Match regardless of whether stored peerPubkey uses raw or compressed form
      const peerMatches = (mp) => {
        const lc = mp.toLowerCase();
        return lc === normalizedPeer || lc === `02${normalizedPeer}` || lc === `03${normalizedPeer}`;
      };
      const hasThread = displayDmMessages.some((message) => peerMatches(message.peerPubkey));
      if (!hasThread) {
        setDmMessages((prev) => {
          if (prev.some((message) => peerMatches(message.peerPubkey))) return prev;
          return [
            ...prev,
            {
              id: `draft-${normalizedPeer}`,
              eventId: `draft-${normalizedPeer}`,
              peerPubkey: normalizedPeer,
              isIncoming: false,
              createdAt: Math.floor(Date.now() / 1000),
              content: "",
              preview: "",
              attachment: { type: "text" },
            },
          ];
        });
      }
      setActiveThreadPeer(normalizedPeer);
      setDmView("thread");
      setChatView("conversation");
      setContactView("list");
      setActiveContactId(null);
      setContactDetailOverride(null);
      setContactReturnView("new-message");
      setDmSearch("");
      return true;
    },
    [displayDmMessages],
  );

  const openConversationForGroup = useCallback(
    (groupId) => {
      const hasThread = displayDmMessages.some((msg) => msg.groupId === groupId);
      if (!hasThread) {
        // Create a placeholder so the thread appears immediately
        setDmMessages((prev) => {
          if (prev.some((msg) => msg.groupId === groupId)) return prev;
          return [
            ...prev,
            {
              id: `draft-group-${groupId}`,
              eventId: `draft-group-${groupId}`,
              peerPubkey: groupId,
              isIncoming: false,
              createdAt: Math.floor(Date.now() / 1000),
              content: "",
              preview: "",
              attachment: { type: "text" },
              groupId,
              senderPubkey: (nostrIdentityRef.current?.pubkey || "").toLowerCase(),
            },
          ];
        });
      }
      setActiveThreadPeer(groupId);
      setActiveGroupId(groupId);
      setDmView("thread");
      setChatView("conversation");
      setContactView("list");
      setActiveContactId(null);
      setContactDetailOverride(null);
      setContactReturnView("new-message");
      setDmSearch("");
      return true;
    },
    [displayDmMessages],
  );

  const buildShareRelayList = useCallback(
    (relaySource) => {
      const storedRelays = (() => {
        try {
          const raw = kvStorage.getItem(LS_NOSTR_RELAYS);
          const parsed = raw ? JSON.parse(raw) : null;
          if (Array.isArray(parsed)) {
            return parsed.map((relay) => (typeof relay === "string" ? relay.trim() : "")).filter(Boolean);
          }
        } catch {
          // ignore
        }
        return [];
      })();
      return Array.from(
        new Set(
          [
            ...(Array.isArray(relaySource) ? relaySource : []),
            ...(storedRelays.length ? storedRelays : defaultNostrRelays),
            ...defaultNostrRelays,
          ]
            .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
            .filter(Boolean),
        ),
      );
    },
    [defaultNostrRelays],
  );

  const sendContactShareToPubkeys = useCallback(
    async (sourceContact, recipientPubkeys) => {
      const sourceNpub = formatContactNpub(sourceContact.npub);
      if (!sourceNpub) {
        return { ok: false, error: "This contact is missing a valid npub." };
      }
      const { identity, reason } = readNostrIdentity();
      if (!identity) {
        return {
          ok: false,
          error: reason || "Add your Taskify Nostr key in Settings → Nostr.",
        };
      }
      const relayList = buildShareRelayList(sourceContact.relays);
      if (!relayList.length) {
        return { ok: false, error: "Add at least one relay first." };
      }
      const envelope = buildContactShareEnvelope({
        type: "contact",
        npub: sourceNpub,
        relays: sourceContact.relays,
        sender: {
          npub: formatNpub(identity.pubkey),
          name: profileForm.displayName || profileForm.username || undefined,
        },
      });
      for (const recipientPubkey of recipientPubkeys) {
        await sendShareMessage(envelope, recipientPubkey, identity.secret, relayList);
      }
      return { ok: true };
    },
    [
      buildShareRelayList,
      formatContactNpub,
      formatNpub,
      profileForm.displayName,
      profileForm.username,
      readNostrIdentity,
    ],
  );

  const handleShareContactToContact = useCallback(
    async (recipient) => {
      if (!shareContactSource) {
        setShareContactStatus("Select a contact to share first.");
        return;
      }
      const normalizedRecipient = normalizeNostrPubkey(recipient.npub);
      if (!normalizedRecipient) {
        setShareContactStatus("Recipient contact is missing a valid npub.");
        return;
      }
      setShareContactBusy(true);
      setShareContactStatus(null);
      try {
        const result = await sendContactShareToPubkeys(shareContactSource, [normalizedRecipient]);
        if (!result.ok) {
          setShareContactStatus(result.error || "Unable to send contact.");
          return;
        }
        setShareContactPickerOpen(false);
        setShareContactPickerMode("recipient");
        setShareContactSource(null);
        showToast(`Contact sent to ${recipient.name || recipient.address || "contact"}`, 3000);
      } catch (err) {
        setShareContactStatus(err?.message || "Unable to send contact.");
      } finally {
        setShareContactBusy(false);
      }
    },
    [
      normalizeNostrPubkey,
      sendContactShareToPubkeys,
      shareContactSource,
      showToast,
    ],
  );

  const closeAttachTray = useCallback(() => {
    setAttachTrayOpen(false);
  }, []);

  const handleToggleAttachTray = useCallback(() => {
    setShareContactPickerOpen(false);
    setShareContactPickerMode("recipient");
    setShareContactSource(null);
    setShareContactStatus(null);
    setAttachTrayOpen((current) => {
      const next = !current;
      if (next) {
        window.setTimeout(() => {
          chatComposeInputRef.current?.blur();
        }, 0);
      }
      return next;
    });
  }, []);

  const handleOpenChatPhotoPicker = useCallback(() => {
    chatPhotoInputRef.current?.click();
  }, []);

  const handleOpenChatFilePicker = useCallback(() => {
    chatFileInputRef.current?.click();
  }, []);

  const handleOpenChatContactPicker = useCallback(() => {
    closeAttachTray();
    shareContactOpenedAtPeerRef.current = activeThreadPeer;
    setShareContactPickerMode("chat-source");
    setShareContactSource(null);
    setShareContactStatus(null);
    setShareContactPickerOpen(true);
  }, [activeThreadPeer, closeAttachTray]);

  return {
    isUnreadThreadStatus,
    collectUnreadThreadItemEventIds,
    dmPreviewForMessage,
    peerLabelFor,
    sharedContactMetaFor,
    buildSharedContactPreview,
    openSharedContactPreview,
    isArchivedDmThread,
    matchesDmThreadSearch,
    openConversationForPeer,
    openConversationForGroup,
    buildShareRelayList,
    sendContactShareToPubkeys,
    handleShareContactToContact,
    closeAttachTray,
    handleToggleAttachTray,
    handleOpenChatPhotoPicker,
    handleOpenChatFilePicker,
    handleOpenChatContactPicker,
  };
}
