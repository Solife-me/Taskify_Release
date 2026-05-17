// @ts-nocheck
import { useCallback } from "react";
import type { Contact } from "../../lib/contacts";
import type { GroupChat } from "../../lib/groupChatState";
import type { GroupAvatarMember } from "../../ui/wallet/walletModalUi";
import type { WalletDmThread } from "./useDmState";
import type { FileServerType } from "../../lib/fileStorage";
import { contactHasNpub } from "../../lib/contacts";
import { uploadAvatar } from "../../nostr/Nip96Client";
import { parseFileServers, findServerEntry } from "../../lib/fileStorage";

const PROFILE_PHOTO_MAX_DIMENSION = 400;
const PROFILE_PHOTO_CACHE_LIMIT_BYTES = 512 * 1024; // 512 KB

interface UseContactDetailOptions {
  // State values
  nip05Checks: Record<string, any>;
  contacts: Contact[];
  contactsRef: React.RefObject<Contact[]>;
  contactSyncMeta: any;
  contactsSyncEnabled: boolean;
  scannedContact: Contact | null;
  sharedContactPreview: any | null;
  contactDetailOverride: Contact | null;
  activeContactId: string | null;
  contactEditDraft: any;
  profileForm: any;
  profileUpdatedAt: number | null;
  nostrIdentityInfo: any;
  myCardName: string;
  profileCard: any;
  detailTarget: Contact | any | null;
  activeContact: Contact | null;
  detailContactFollowed: boolean;
  scannedContactSaved: boolean;
  scannedContactFollowed: boolean;
  sharedContactPreviewSaved: boolean;
  sharedContactPreviewCanAccept: boolean;
  activeGroupMembers: any[];
  activeConversationContact: Contact | null;
  nostrMissingReason: string | null;
  preferredFileServer: string;
  fileServers: string;
  profilePhotoBusy: boolean;

  // Stable refs
  nostrIdentityRef: React.RefObject<any>;
  contactsPublishQueuedRef: React.RefObject<boolean>;
  profilePhotoUploadRef: React.RefObject<any>;

  // Stable setters / callbacks
  setNip05Checks: (fn: any) => void;
  setScannedContact: (contact: Contact | null | ((prev: any) => any)) => void;
  setSharedContactPreview: (preview: any | null | ((prev: any) => any)) => void;
  setContactDetailOverride: (contact: Contact | null) => void;
  setActiveContactId: (id: string | null) => void;
  setContactEditDraft: (draft: any | ((prev: any) => any)) => void;
  setContactReturnView: (view: string) => void;
  setContactView: (view: string) => void;
  setDmSearch: (search: string) => void;
  setChatView: (view: string) => void;
  setContactEditError: (error: string) => void;
  setContactLookupError: (error: string) => void;
  setContactLookupInput: (input: string) => void;
  setShowCustomContactFields: (show: boolean) => void;
  setProfilePhotoError: (error: string) => void;
  setProfilePhotoBusy: (busy: boolean) => void;
  setProfileStatus: (status: string) => void;
  setProfileMessage: (message: string) => void;
  setProfileForm: (form: any | ((prev: any) => any)) => void;

  // Functions from other hooks (stable callbacks)
  normalizeNip05: (nip05: string | null) => string | null;
  normalizeNostrPubkey: (npub: string | null) => string | null;
  compressedToRawHex: (npub: string) => string;
  resolveNip05Record: (nip05: string) => Promise<{ pubkey: string }>;
  upsertContact: (contact: Partial<Contact>) => Contact | null;
  publishContactsToNostr: (opts?: { silent?: boolean; publicFollowsOverride?: any[] }) => Promise<void>;
  persistContactSyncMeta: (meta: Partial<any>) => any | null;
  sanitizeUsername: (username: string) => string;
  formatContactNpub: (npub: string) => string;
  formatContactUsername: (username: string) => string;
  showToast: (message: string, duration?: number) => void;
  peerLabelFor: (hex: string) => { label: string; picture?: string; subtitle?: string };
  openEcashSendToContact: (contact: Contact) => void;
  openEcashSendSheet: () => void;
  openLightningSendSheet: () => void;
  applyLightningContact: (contact: Contact) => void;
  closeAttachTray: () => void;
  onAcceptMessage: (itemId: string) => void;
  handleReturnToProfileCard: () => void;
  resetContactEditDraft: () => void;
  ensureNostrIdentity: () => any | null;
  publishProfileMetadata: (draft: any) => Promise<boolean>;
  deriveDefaultLightningAddress: () => string;
  isDataUrl: (url: string) => boolean;
  estimateDataUrlSize: (dataUrl: string) => number;
}

export function useContactDetail(options: UseContactDetailOptions) {
  const {
    nip05Checks,
    contacts,
    contactsRef,
    contactSyncMeta,
    contactsSyncEnabled,
    scannedContact,
    sharedContactPreview,
    contactDetailOverride,
    activeContactId,
    contactEditDraft,
    profileForm,
    profileUpdatedAt,
    nostrIdentityInfo,
    myCardName,
    profileCard,
    detailTarget,
    activeContact,
    detailContactFollowed,
    scannedContactSaved,
    scannedContactFollowed,
    sharedContactPreviewSaved,
    sharedContactPreviewCanAccept,
    activeGroupMembers,
    activeConversationContact,
    nostrMissingReason,
    preferredFileServer,
    fileServers,
    profilePhotoBusy,
    nostrIdentityRef,
    contactsPublishQueuedRef,
    profilePhotoUploadRef,
    setNip05Checks,
    setScannedContact,
    setSharedContactPreview,
    setContactDetailOverride,
    setActiveContactId,
    setContactEditDraft,
    setContactReturnView,
    setContactView,
    setDmSearch,
    setChatView,
    setContactEditError,
    setContactLookupError,
    setContactLookupInput,
    setShowCustomContactFields,
    setProfilePhotoError,
    setProfilePhotoBusy,
    setProfileStatus,
    setProfileMessage,
    setProfileForm,
    normalizeNip05,
    normalizeNostrPubkey,
    compressedToRawHex,
    resolveNip05Record,
    upsertContact,
    publishContactsToNostr,
    persistContactSyncMeta,
    sanitizeUsername,
    formatContactNpub,
    formatContactUsername,
    showToast,
    peerLabelFor,
    openEcashSendToContact,
    openEcashSendSheet,
    openLightningSendSheet,
    applyLightningContact,
    closeAttachTray,
    onAcceptMessage,
    handleReturnToProfileCard,
    resetContactEditDraft,
    ensureNostrIdentity,
    publishProfileMetadata,
    deriveDefaultLightningAddress,
    isDataUrl,
    estimateDataUrlSize,
  } = options;

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

  const handleOpenChatEcash = useCallback(() => {
    closeAttachTray();
    if (activeConversationContact && (contactHasNpub(activeConversationContact) || activeConversationContact.paymentRequest.trim().length > 0)) {
      openEcashSendToContact(activeConversationContact);
      return;
    }
    openEcashSendSheet();
  }, [activeConversationContact, closeAttachTray, openEcashSendSheet, openEcashSendToContact]);

  const handleOpenChatLightning = useCallback(() => {
    closeAttachTray();
    if (activeConversationContact?.address.trim()) {
      applyLightningContact(activeConversationContact);
      return;
    }
    openLightningSendSheet();
  }, [activeConversationContact, applyLightningContact, closeAttachTray, openLightningSendSheet]);

  const groupAvatarMembersFor = useCallback(
    (group: GroupChat | null | undefined, thread?: WalletDmThread | null, fallbackLabel?: string): GroupAvatarMember[] => {
      const ownHex = (nostrIdentityInfo.identity?.pubkey || nostrIdentityRef.current?.pubkey || "").toLowerCase();
      const resolvedMembers = (group?.members || [])
        .map((memberHex, index) => {
          const normalizedHex = memberHex.toLowerCase();
          const isSelf = ownHex !== "" && normalizedHex === ownHex;
          const meta = isSelf
            ? { label: myCardName, picture: profileCard.picture?.trim() || undefined }
            : peerLabelFor(normalizedHex);
          return {
            key: normalizedHex,
            memberHex: normalizedHex,
            index,
            label: meta.label,
            picture: meta.picture?.trim() || undefined,
          };
        })
        .filter((member) => !!member.key);
      if (!resolvedMembers.length) {
        return [
          {
            key: group?.groupId || fallbackLabel || "group",
            label: fallbackLabel || group?.name || "Group",
          },
        ];
      }
      const memberMap = new Map(resolvedMembers.map((member) => [member.memberHex, member]));
      const recentMemberHexes: string[] = [];
      const recentSeen = new Set<string>();
      if (thread) {
        for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
          const message = thread.messages[index];
          const candidateHex = ((message.isIncoming ? message.senderPubkey : ownHex) || "").toLowerCase();
          if (!candidateHex || recentSeen.has(candidateHex) || !memberMap.has(candidateHex)) continue;
          recentSeen.add(candidateHex);
          recentMemberHexes.push(candidateHex);
          if (recentMemberHexes.length >= 4) break;
        }
      }
      const recentMembers = recentMemberHexes
        .map((memberHex) => memberMap.get(memberHex))
        .filter(Boolean);
      const remainingMembers = resolvedMembers
        .filter((member) => !recentSeen.has(member.memberHex))
        .sort((left, right) => Number(Boolean(right.picture)) - Number(Boolean(left.picture)) || left.index - right.index);
      return [...recentMembers, ...remainingMembers]
        .slice(0, 4)
        .map(({ key, label, picture }) => ({ key, label, picture }));
    },
    [myCardName, nostrIdentityInfo.identity?.pubkey, peerLabelFor, profileCard.picture],
  );

  const openGroupMemberDetail = useCallback(
    (memberHex: string) => {
      const member = activeGroupMembers.find((entry) => entry.memberHex === memberHex);
      if (!member) return;
      setContactReturnView("group-members");
      setContactView("detail");
      setDmSearch("");
      if (member.isSelf) {
        setActiveContactId("profile");
        setContactDetailOverride(null);
      } else if (member.contactId) {
        setActiveContactId(member.contactId);
        setContactDetailOverride(null);
      } else {
        setActiveContactId(null);
        setContactDetailOverride(member.detailContact);
      }
      setChatView("new-message");
    },
    [activeGroupMembers],
  );

  const buildContactFields = useCallback(
    (contact: Contact | any | null | undefined) => {
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

  const handleSaveSharedContactPreview = useCallback(() => {
    if (!sharedContactPreview) return;
    let nextContact = sharedContactPreview.contact;
    if (!sharedContactPreviewSaved) {
      const saved = upsertContact({
        ...sharedContactPreview.contact,
        source: sharedContactPreview.contact.source ?? "sync",
      });
      if (!saved) {
        showToast("Unable to add contact", 2500);
        return;
      }
      nextContact = saved;
      contactsPublishQueuedRef.current = true;
      if (contactsSyncEnabled) {
        void publishContactsToNostr({ silent: true });
      }
    }
    if (sharedContactPreview.itemId && sharedContactPreviewCanAccept) {
      onAcceptMessage(sharedContactPreview.itemId);
    }
    setSharedContactPreview((current) =>
      current
        ? {
            ...current,
            contact: nextContact,
            status: sharedContactPreviewCanAccept ? "accepted" : current.status,
          }
        : current,
    );
    showToast("Contact added", 2000);
  }, [
    contactsPublishQueuedRef,
    contactsSyncEnabled,
    onAcceptMessage,
    publishContactsToNostr,
    sharedContactPreview,
    sharedContactPreviewCanAccept,
    sharedContactPreviewSaved,
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

  const handleStartEditCurrentContact = useCallback(() => {
    const source = activeContactId === "profile" ? profileCard : activeContact || contactDetailOverride;
    const isExistingContact = !!activeContact && activeContactId !== "profile";
    if (!source) {
      resetContactEditDraft();
    } else {
      setContactEditDraft({
        id: source.id === "profile" || !isExistingContact ? null : source.id,
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
  }, [activeContact, activeContactId, contactDetailOverride, profileCard, resetContactEditDraft]);

  const handleCancelContactEdit = useCallback(() => {
    setContactEditError("");
    setContactLookupError("");
    setShowCustomContactFields(false);
    if (contactEditDraft.isProfile) {
      handleReturnToProfileCard();
      return;
    }
    setContactView(detailTarget ? "detail" : "list");
  }, [contactEditDraft.isProfile, detailTarget, handleReturnToProfileCard]);

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

  return {
    contactSubtitle,
    handleOpenChatEcash,
    handleOpenChatLightning,
    groupAvatarMembersFor,
    openGroupMemberDetail,
    buildContactFields,
    verifyContactNip05,
    ensureNip05Verification,
    isNip05VerifiedFor,
    handleSaveScannedContact,
    handleSaveSharedContactPreview,
    handleToggleFollowScannedContact,
    handleStartEditCurrentContact,
    handleCancelContactEdit,
    handleToggleFollowDetailContact,
    handleCopyContactField,
    processProfilePhotoFile,
    handleProfilePhotoChange,
    handleClearProfilePhoto,
    handleContactEditSubmit,
  };
}
