import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Contact, ContactProfile } from "../../lib/contacts";
import type { GroupChat } from "../../lib/groupChatState";
import type {
  NostrIdentity,
  NostrIdentityInfo,
  PendingCalendarInvite,
  SharedContactPreview,
} from "../chatHelpers";
import type { ShareEnvelope, SharedContactPayload } from "../../lib/shareInbox";
import type { WalletMessageItem } from "../../types/walletMessages";
import type { WalletDmAttachment, WalletDmMessage, WalletDmThread } from "./useDmState";

type ChatView =
  | "threads"
  | "conversation"
  | "new-message"
  | "new-group-select"
  | "new-group-name"
  | "group-info"
  | "group-members"
  | "group-name-edit";

type DmView = "list" | "thread" | "strangers";

type ContactViewMode = "list" | "detail" | "edit";

type ProfileForm = {
  username: string;
  displayName: string;
  lud16: string;
  nip05: string;
  about: string;
  picture: string;
};

type ContactShareResult = { ok: true } | { ok: false; error?: string };

type Nip05Verifier = (
  contactId: string,
  nip05?: string | null,
  npub?: string | null,
) => boolean;

type KVStorageLike = {
  getItem: (key: string) => string | null;
};

export interface UseDmThreadUtilsOptions {
  inboxPendingItems: WalletMessageItem[] | undefined;
  messageItemsByEventId: Map<string, WalletMessageItem>;
  pendingMessageItemsByEventId: Map<string, WalletMessageItem>;
  pendingCalendarInvitesByEventId: Map<string, PendingCalendarInvite>;
  pendingCalendarInvites: PendingCalendarInvite[] | undefined;
  paymentHistoryByEventId: Map<string, { summary?: string }>;
  contactIndex: Map<string, { name: string; picture?: string }>;
  dmArchivedThreadsVersion: number;
  groupChats: GroupChat[];
  dmSearch: string;
  displayDmMessages: WalletDmMessage[];
  activeThreadPeer: string | null;
  attachTrayOpen: boolean;
  shareContactSource: Contact | null;
  profileForm: ProfileForm;
  setSharedContactPreview: Dispatch<SetStateAction<SharedContactPreview | null>>;
  setActiveThreadPeer: Dispatch<SetStateAction<string | null>>;
  setDmView: Dispatch<SetStateAction<DmView>>;
  setChatView: Dispatch<SetStateAction<ChatView>>;
  setContactView: Dispatch<SetStateAction<ContactViewMode>>;
  setActiveContactId: Dispatch<SetStateAction<string | "profile" | null>>;
  setContactDetailOverride: Dispatch<SetStateAction<Contact | null>>;
  setContactReturnView: Dispatch<SetStateAction<"new-message" | "group-members" | "group-info">>;
  setDmSearch: Dispatch<SetStateAction<string>>;
  setDmMessages: Dispatch<SetStateAction<WalletDmMessage[]>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setAttachTrayOpen: Dispatch<SetStateAction<boolean>>;
  setShareContactPickerOpen: Dispatch<SetStateAction<boolean>>;
  setShareContactPickerMode: Dispatch<SetStateAction<"recipient" | "chat-source">>;
  setShareContactSource: Dispatch<SetStateAction<Contact | null>>;
  setShareContactStatus: Dispatch<SetStateAction<string | null>>;
  setShareContactBusy: Dispatch<SetStateAction<boolean>>;
  dmArchivedThreadsRef: RefObject<Map<string, number>>;
  dmPeerProfilesRef: RefObject<Map<string, ContactProfile>>;
  nostrIdentityRef: RefObject<NostrIdentity | null>;
  isNip05VerifiedForRef: RefObject<Nip05Verifier | null>;
  chatComposeInputRef: RefObject<HTMLInputElement | null>;
  chatPhotoInputRef: RefObject<HTMLInputElement | null>;
  chatFileInputRef: RefObject<HTMLInputElement | null>;
  shareContactOpenedAtPeerRef: RefObject<string | null>;
  normalizeNostrPubkey: (value: string | null | undefined) => string | null;
  compressedToRawHex: (value: string) => string;
  formatNpubDisplay: (value: string | null | undefined) => string | null;
  shortenNpubDisplay: (value: string | null | undefined, lead?: number, tail?: number) => string;
  pickPreferredProfilePhoto: (...candidates: Array<string | null | undefined>) => string | undefined;
  makeContactId: () => string;
  normalizeContact: (input: Partial<Contact> & { id?: string }) => Contact | null;
  dmThreadKeyForThread: (thread: Pick<WalletDmThread, "peerPubkey" | "groupId"> | null | undefined) => string;
  formatContactNpub: (value: string | null | undefined) => string;
  formatNpub: (value: string) => string;
  buildContactShareEnvelope: (payload: SharedContactPayload) => ShareEnvelope;
  sendShareMessage: (
    payload: ShareEnvelope,
    recipientPubkey: string,
    senderSecretHex: string,
    relays: string[] | string,
  ) => Promise<void>;
  readNostrIdentity: () => NostrIdentityInfo;
  defaultNostrRelays: string[];
  buildWalletMessageSyntheticEventId: (item: WalletMessageItem) => string;
  buildCalendarInviteSyntheticEventId: (invite: PendingCalendarInvite) => string;
  normalizeDmPeerHex: (value: string | null | undefined) => string | null;
  showToast: (message: string, duration?: number) => void;
  LS_NOSTR_RELAYS: string;
  kvStorage: KVStorageLike;
}

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
  attachTrayOpen,
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
}: UseDmThreadUtilsOptions) {
  const isUnreadThreadStatus = useCallback((status: string | null | undefined) => {
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
    (messages: WalletDmMessage[], peerPubkey: string | null | undefined): string[] => {
      const unreadIds = new Set<string>();
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
      buildWalletMessageSyntheticEventId,
      buildCalendarInviteSyntheticEventId,
      normalizeDmPeerHex,
    ],
  );

  const dmPreviewForMessage = useCallback(
    (msg: WalletDmMessage): string => {
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
    (peerHex: string): {
      label: string;
      subtitle?: string;
      picture?: string;
      verifiedNip05: string | null;
    } => {
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
    [contactIndex, formatNpubDisplay, dmPeerProfilesRef, isNip05VerifiedForRef, pickPreferredProfilePhoto, shortenNpubDisplay],
  );

  const sharedContactMetaFor = useCallback(
    (npub: string | null | undefined, fallbackName: string | null | undefined, fallbackPicture: string | null | undefined): {
      label: string;
      subtitle?: string;
      picture?: string;
      verifiedNip05: string | null;
      npub: string;
    } => {
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
    [compressedToRawHex, formatNpubDisplay, normalizeNostrPubkey, dmPeerProfilesRef, isNip05VerifiedForRef, pickPreferredProfilePhoto, shortenNpubDisplay],
  );

  const buildSharedContactPreview = useCallback(
    (
      attachment: Extract<WalletDmAttachment, { type: "contact" }> | null | undefined,
      item: WalletMessageItem | null | undefined,
    ): SharedContactPreview | null => {
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
        status: (item?.status ?? attachment?.status ?? null) as SharedContactPreview["status"],
      };
    },
    [compressedToRawHex, makeContactId, normalizeContact, normalizeNostrPubkey, dmPeerProfilesRef, pickPreferredProfilePhoto],
  );

  const openSharedContactPreview = useCallback(
    (
      attachment: Extract<WalletDmAttachment, { type: "contact" }> | null | undefined,
      item: WalletMessageItem | null | undefined,
    ): void => {
      const preview = buildSharedContactPreview(attachment, item);
      if (!preview) {
        showToast("Unable to open shared contact", 2200);
        return;
      }
      setSharedContactPreview(preview);
    },
    [buildSharedContactPreview, showToast, setSharedContactPreview],
  );

  const isArchivedDmThread = useCallback(
    (thread: WalletDmThread): boolean => {
      void dmArchivedThreadsVersion;
      const key = dmThreadKeyForThread(thread);
      const archivedAt = key ? dmArchivedThreadsRef.current.get(key) ?? 0 : 0;
      if (archivedAt <= 0) return false;
      return !thread.messages.some(
        (message) => !message.eventId.startsWith("draft-") && message.createdAt * 1000 > archivedAt,
      );
    },
    [dmArchivedThreadsVersion, dmArchivedThreadsRef, dmThreadKeyForThread],
  );

  const matchesDmThreadSearch = useCallback(
    (thread: WalletDmThread): boolean => {
      if (!dmSearch.trim()) return true;
      const groupName = thread.groupId ? (groupChats.find((g) => g.groupId === thread.groupId)?.name ?? "") : "";
      const meta = thread.groupId ? { label: groupName, subtitle: undefined } : peerLabelFor(thread.peerPubkey);
      const haystack = `${meta.label} ${meta.subtitle ?? ""} ${groupName} ${thread.lastPreview} ${thread.peerPubkey}`.toLowerCase();
      return haystack.includes(dmSearch.trim().toLowerCase());
    },
    [dmSearch, groupChats, peerLabelFor],
  );

  const openConversationForPeer = useCallback(
    (peerHex: string | null | undefined): boolean => {
      // Normalise to raw 64-char hex (strip "02"/"03" prefix if present)
      const raw = (peerHex || "").trim().toLowerCase();
      const normalizedPeer = /^(02|03)[0-9a-f]{64}$/.test(raw) ? raw.slice(2) : raw;
      if (!normalizedPeer) return false;
      // Match regardless of whether stored peerPubkey uses raw or compressed form
      const peerMatches = (peerPubkey: string) => {
        const lc = peerPubkey.toLowerCase();
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
    [displayDmMessages, setDmMessages, setActiveThreadPeer, setDmView, setChatView, setContactView, setActiveContactId, setContactDetailOverride, setContactReturnView, setDmSearch],
  );

  const openConversationForGroup = useCallback(
    (groupId: string): boolean => {
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
    [displayDmMessages, nostrIdentityRef, setDmMessages, setActiveThreadPeer, setActiveGroupId, setDmView, setChatView, setContactView, setActiveContactId, setContactDetailOverride, setContactReturnView, setDmSearch],
  );

  const buildShareRelayList = useCallback(
    (relaySource: string[] | null | undefined): string[] => {
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
    [defaultNostrRelays, kvStorage, LS_NOSTR_RELAYS],
  );

  const sendContactShareToPubkeys = useCallback(
    async (sourceContact: Contact, recipientPubkeys: string[]): Promise<ContactShareResult> => {
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
      buildContactShareEnvelope,
      sendShareMessage,
    ],
  );

  const handleShareContactToContact = useCallback(
    async (recipient: Contact): Promise<void> => {
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
      } catch (error) {
        setShareContactStatus((error as { message?: string } | null)?.message || "Unable to send contact.");
      } finally {
        setShareContactBusy(false);
      }
    },
    [
      normalizeNostrPubkey,
      sendContactShareToPubkeys,
      shareContactSource,
      showToast,
      setShareContactStatus,
      setShareContactBusy,
      setShareContactPickerOpen,
      setShareContactPickerMode,
      setShareContactSource,
    ],
  );

  const closeAttachTray = useCallback(() => {
    setAttachTrayOpen(false);
  }, [setAttachTrayOpen]);

  const handleToggleAttachTray = useCallback(() => {
    setShareContactPickerOpen(false);
    setShareContactPickerMode("recipient");
    setShareContactSource(null);
    setShareContactStatus(null);
    setAttachTrayOpen((current) => !current);
  }, [setAttachTrayOpen, setShareContactPickerOpen, setShareContactPickerMode, setShareContactSource, setShareContactStatus]);

  useEffect(() => {
    if (!attachTrayOpen) return;
    const timer = window.setTimeout(() => chatComposeInputRef.current?.blur(), 0);
    return () => window.clearTimeout(timer);
  }, [attachTrayOpen, chatComposeInputRef]);

  const handleOpenChatPhotoPicker = useCallback(() => {
    chatPhotoInputRef.current?.click();
  }, [chatPhotoInputRef]);

  const handleOpenChatFilePicker = useCallback(() => {
    chatFileInputRef.current?.click();
  }, [chatFileInputRef]);

  const handleOpenChatContactPicker = useCallback(() => {
    closeAttachTray();
    shareContactOpenedAtPeerRef.current = activeThreadPeer;
    setShareContactPickerMode("chat-source");
    setShareContactSource(null);
    setShareContactStatus(null);
    setShareContactPickerOpen(true);
  }, [activeThreadPeer, closeAttachTray, shareContactOpenedAtPeerRef, setShareContactPickerMode, setShareContactSource, setShareContactStatus, setShareContactPickerOpen]);

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
