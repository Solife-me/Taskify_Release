// @ts-nocheck
import { useCallback, useMemo } from "react";
import {
  CHAT_ATTACH_TRAY_MAX_HEIGHT,
  CHAT_ATTACH_TRAY_MIN_HEIGHT,
} from "../../wallet/walletModalHelpers";
import type { Contact } from "../../lib/contacts";
import type { GroupChat } from "../../lib/groupChatState";
import type { GroupAvatarMember } from "../../ui/wallet/walletModalUi";
import type { WalletDmThread } from "./useDmState";

export function useChatGroupDerived({
  activeThread,
  activeGroupChat,
  contactByHex,
  sortedContacts,
  myCardNpub,
  myCardName,
  profileCard,
  groupMembersSearch,
  chatKeyboardHeight,
  chatKeyboardHeightCache,
  nostrIdentityInfo,
  nostrIdentityRef,
  dmPeerProfilesRef,
  getPeerProfile,
  peerLabelFor,
  compressedToRawHex,
  normalizeNostrPubkey,
  formatNpub,
  sanitizeUsername,
  contactDisplayLabel,
  formatContactUsername,
  formatContactNpub,
  pickPreferredProfilePhoto,
  shortenNpubDisplay,
  profileUpdatedAt,
}) {
  const activeConversationContact = useMemo(() => {
    if (!activeThread || activeThread.groupId) return null;
    const ownNpub = normalizeNostrPubkey(myCardNpub);
    const ownHex = ownNpub ? compressedToRawHex(ownNpub).toLowerCase() : "";
    if (ownHex && activeThread.peerPubkey === ownHex) return null;
    const peerMeta = getPeerProfile(activeThread.peerPubkey);
    const peerLabel = peerLabelFor(activeThread.peerPubkey);
    const existing = contactByHex.get(activeThread.peerPubkey);
    if (existing) {
      return {
        ...existing,
        address: existing.address.trim() || peerMeta?.lud16?.trim() || "",
        nip05: existing.nip05?.trim() || peerMeta?.nip05?.trim() || "",
        displayName: existing.displayName?.trim() || peerMeta?.displayName?.trim() || "",
        username: existing.username?.trim() || peerMeta?.username?.trim() || "",
        about: existing.about?.trim() || peerMeta?.about?.trim() || "",
        picture: existing.picture?.trim() || peerMeta?.picture?.trim() || peerLabel.picture?.trim() || "",
      } satisfies Contact;
    }
    return {
      id: `chat-peer-${activeThread.peerPubkey}`,
      kind: "nostr",
      name: peerMeta?.displayName || peerMeta?.username || peerLabel.label,
      displayName: peerMeta?.displayName || peerLabel.label,
      username: sanitizeUsername(peerMeta?.username || ""),
      address: peerMeta?.lud16 || "",
      paymentRequest: "",
      npub: formatNpub(activeThread.peerPubkey) || "",
      nip05: peerMeta?.nip05 || "",
      about: peerMeta?.about || "",
      picture: peerMeta?.picture || peerLabel.picture || "",
      updatedAt: Date.now(),
    } satisfies Contact;
  }, [
    activeThread,
    compressedToRawHex,
    contactByHex,
    formatNpub,
    getPeerProfile,
    myCardNpub,
    normalizeNostrPubkey,
    peerLabelFor,
    sanitizeUsername,
  ]);
  const chatAttachTrayHeight = useMemo(
    () =>
      Math.min(
        CHAT_ATTACH_TRAY_MAX_HEIGHT,
        Math.max(CHAT_ATTACH_TRAY_MIN_HEIGHT, chatKeyboardHeight || chatKeyboardHeightCache),
      ),
    [chatKeyboardHeight, chatKeyboardHeightCache],
  );
  const chatAttachContactOptions = useMemo(() => {
    const options: Contact[] = [];
    const seen = new Set<string>();
    const addContact = (contact: Contact) => {
      const normalizedNpub = formatContactNpub(contact.npub);
      if (!normalizedNpub) return;
      const normalizedHex = normalizeNostrPubkey(normalizedNpub) ?? normalizedNpub;
      const key = normalizedHex.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      options.push({ ...contact, npub: normalizedNpub });
    };
    addContact(profileCard as Contact);
    sortedContacts.forEach(addContact);
    return options;
  }, [formatContactNpub, normalizeNostrPubkey, profileCard, sortedContacts]);
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
    [myCardName, nostrIdentityInfo.identity?.pubkey, nostrIdentityRef, peerLabelFor, profileCard.picture],
  );
  const activeGroupAvatarMembers = useMemo(
    () =>
      activeThread?.groupId
        ? groupAvatarMembersFor(activeGroupChat, activeThread, activeGroupChat?.name || "Group")
        : [],
    [activeGroupChat, activeThread, groupAvatarMembersFor],
  );
  const activeGroupMembers = useMemo(() => {
    if (!activeGroupChat) return [];
    const ownHex = (nostrIdentityInfo.identity?.pubkey || nostrIdentityRef.current?.pubkey || "").toLowerCase();
    return activeGroupChat.members.map((memberHex, index) => {
      const normalizedHex = memberHex.toLowerCase();
      const isSelf = ownHex !== "" && normalizedHex === ownHex;
      const contact = isSelf ? null : contactByHex.get(normalizedHex) || null;
      const profile = isSelf ? null : dmPeerProfilesRef.current.get(normalizedHex);
      const peerMeta = isSelf ? null : peerLabelFor(normalizedHex);
      const label = isSelf ? myCardName : contact ? contactDisplayLabel(contact) : peerMeta?.label || "Contact";
      const picture = isSelf
        ? profileCard.picture?.trim() || undefined
        : pickPreferredProfilePhoto(profile?.picture, contact?.picture?.trim() || peerMeta?.picture);
      const npub = isSelf
        ? myCardNpub || formatNpub(normalizedHex)
        : contact?.npub?.trim() || formatNpub(normalizedHex);
      const subtitle = (() => {
        if (isSelf) {
          return profileCard.nip05.trim() || formatContactUsername(profileCard.username) || shortenNpubDisplay(myCardNpub);
        }
        return (
          contact?.nip05?.trim() ||
          profile?.nip05?.trim() ||
          formatContactUsername(contact?.username || profile?.username || "") ||
          peerMeta?.subtitle ||
          shortenNpubDisplay(npub, 12, 8)
        );
      })();
      return {
        id: contact?.id || `group-member-${normalizedHex}`,
        contactId: contact?.id || null,
        memberHex: normalizedHex,
        isSelf,
        label,
        picture,
        subtitle,
        detailContact: {
          id: contact?.id || `group-member-${normalizedHex}`,
          name: isSelf ? myCardName : contact?.name || label,
          displayName: isSelf ? profileCard.displayName || myCardName : contact?.displayName || profile?.displayName || label,
          username: isSelf ? profileCard.username || "" : contact?.username || profile?.username || "",
          address: isSelf ? profileCard.address || "" : contact?.address || profile?.lud16 || "",
          npub,
          nip05: isSelf ? profileCard.nip05 || "" : contact?.nip05 || profile?.nip05 || "",
          about: isSelf ? profileCard.about || "" : contact?.about || profile?.about || "",
          picture: picture || "",
          updatedAt: isSelf ? profileUpdatedAt : contact?.updatedAt ?? null,
        } as Contact,
        index,
      };
    });
  }, [
    activeGroupChat,
    contactByHex,
    contactDisplayLabel,
    formatContactUsername,
    formatNpub,
    myCardName,
    myCardNpub,
    nostrIdentityInfo.identity?.pubkey,
    peerLabelFor,
    pickPreferredProfilePhoto,
    profileCard.about,
    profileCard.address,
    profileCard.displayName,
    profileCard.nip05,
    profileCard.picture,
    profileCard.username,
    profileUpdatedAt,
    shortenNpubDisplay,
  ]);
  const filteredActiveGroupMembers = useMemo(() => {
    const query = groupMembersSearch.trim().toLowerCase();
    if (!query) return activeGroupMembers;
    return activeGroupMembers.filter((member) =>
      `${member.label} ${member.subtitle || ""} ${member.detailContact.npub || ""}`.toLowerCase().includes(query),
    );
  }, [activeGroupMembers, groupMembersSearch]);
  return {
    activeConversationContact,
    chatAttachTrayHeight,
    chatAttachContactOptions,
    activeGroupAvatarMembers,
    activeGroupMembers,
    filteredActiveGroupMembers,
    groupAvatarMembersFor,
  };
}
