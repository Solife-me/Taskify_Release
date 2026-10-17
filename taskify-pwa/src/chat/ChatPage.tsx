// @ts-nocheck -- the chat UI moved unchanged from CashuWalletModal; typing is tracked in the review.
/**
 * The Chat page: conversations, a conversation, new messages and groups, contacts and the user's
 * card. Everything it shows and does comes from `ChatRuntime` (`useChatRuntime`). Loaded when
 * Chat is first opened. On a mouse desktop the conversation list stays beside the open
 * conversation (`chat-page--two-pane`).
 *
 * The root keeps the `wallet-modal--chat` class names its styles were written for; renaming them
 * is cosmetic and left for the stylesheet cleanup.
 */
// TODO: Continue breaking up this still-large wallet surface. Extract more custom hooks
// (wallet state, mint management, send/receive flows, payment requests, NWC,
// nostr DM redemption, lightning, swaps) into src/hooks/wallet/ and split
// sub-views into smaller components to reduce this file's size.
import React from "react";


import { nip19 } from "nostr-tools";




import { type GroupChat } from "../lib/groupChatState";
import { normalizeNostrPubkey } from "../lib/nostr";


import {
  isImageMime,
  isVideoMime,
  isAudioMime,
} from "../lib/messengerAttachmentCrypto";




import { ActionSheet } from "../components/ActionSheet";
import type { Contact } from "../lib/contacts";
import {
  contactDisplayLabel,
  contactPrimaryName,
  formatContactNpub,
  formatContactUsername,
  sanitizeUsername,
} from "../lib/contacts";
import type { WalletMessageItem } from "../types/walletMessages";




import { type WalletDmAttachment, type DmReaction, type WalletDmMessage, MAX_GROUP_MEMBERS, generateGroupId } from "./hooks/useDmState";
import {
  loadCachedBotCommands,
} from "../lib/botCommands";


import {
  BackIcon,
  CHAT_FILE_PICKER_ACCEPT,
  CheckIcon,
  GroupAvatar,
  MessengerFileBubble,
  PencilIcon,
  QrCodeCard,
  QrScanner,
  ShareArrowIcon,
  VerifiedBadgeIcon,
  formatDmDateSeparator,
  formatDmDay,
  formatDmTime,
  formatShortDate,
  parseDateLikeToUnixSeconds,
} from "./chatUi";
import {
  getWalletMessageStatusLabel,
  getCalendarInviteStatusLabel,
  extractDomain,
  extractUrlsFromText,
  renderFormattedText,
  CHAT_TIMESTAMP_REVEAL_WIDTH,
  type NostrEvent,
} from "./chatHelpers";



import { useChatRuntime } from "./ChatRuntime";
import { ChatTokenBubble } from "./ChatTokenBubble";
import { ChatThreadsView } from "./views/ChatThreadsView";

export default function ChatPage() {
  const {
    activeBotCommands,
    activeContact,
    activeContactId,
    activeGroupAvatarMembers,
    activeGroupChat,
    activeGroupLeft,
    activeGroupMembers,
    activeGroupMuted,
    activeThread,
    attachTrayOpen,
    buildDmCopyValue,
    cancelDmLongPress,
    chatAttachContactOptions,
    chatCompose,
    chatComposeInputRef,
    chatFileInputRef,
    chatPhotoInputRef,
    chatView,
    closeAttachTray,
    closeScanner,
    collectUnreadThreadItemEventIds,
    compressedToRawHex,
    contactEditDraft,
    contactEditError,
    contactInitials,
    contactLookupBusy,
    contactLookupError,
    contactLookupInput,
    contactReturnView,
    contactSyncState,
    contactView,
    contacts,
    contactsPanelRef,
    contactsPublishState,
    copyMessageValue,
    defaultNostrRelays,
    detailCanAddContact,
    detailCanShare,
    detailContactCanFollow,
    detailContactFollowed,
    detailFields,
    detailIsNostrContact,
    detailNip05Verified,
    detailShareValue,
    detailTarget,
    detailTitle,
    detailUsername,
    dmBlockedPeersRef,
    dmForwardMessage,
    dmInfoMessage,
    dmListViewRef,
    dmLongPressTimerRef,
    dmMessageActions,
    dmMessages,
    dmPeerProfilesRef,
    dmReactionDetail,
    dmReactions,
    dmSearch,
    dmThreadListEntries,
    dmThreads,
    dmView,
    dragDirectionLocked,
    dragTouchStartX,
    dragTouchStartY,
    ensureNostrPool,
    filteredActiveGroupMembers,
    formatCalendarInviteWhen,
    formatNpub,
    getPeerProfile,
    groupAvatarMembersFor,
    groupChats,
    groupChatsRef,
    groupInfoTab,
    groupMembersSearch,
    groupNameDraft,
    groupSelectMembers,
    handleAddPeerToContacts,
    handleArchiveDmThread,
    handleBackToContactsList,
    handleCancelContactEdit,
    handleClearProfilePhoto,
    handleContactEditSubmit,
    handleContactImportAction,
    handleCopyContactField,
    handleDeleteContact,
    handleDeleteDmMessage,
    handleDeleteDmThread,
    handleDmEvent,
    handleForwardMessage,
    handleImportPublicFollow,
    handleOpenChatContactPicker,
    handleOpenChatFilePicker,
    handleOpenChatPhotoPicker,
    handlePasteFromClipboard,
    handleProfilePhotoChange,
    handleRenameGroupSubmit,
    handleReturnToProfileCard,
    handleScannerDetected,
    handleScannerError,
    handleSendReaction,
    handleShareContactToContact,
    handleStartAddContact,
    handleStartEditCurrentContact,
    handleToggleActiveGroupMembership,
    handleToggleActiveGroupMute,
    handleToggleAttachTray,
    handleToggleFollowDetailContact,
    isChatPage,
    isDmMessageExpanded,
    loadProfileMetadata,
    messageItemsByEventId,
    messageSearchResults,
    messagesInnerRef,
    messagesScrollRef,
    myCardName,
    myCardNpub,
    myCardSubtitle,
    nostrIdentityRef,
    onAcceptMessage,
    onAddTaskAgain,
    onCalendarInviteRsvp,
    onDeclineMessage,
    onDismissCalendarInvite,
    onDismissMessage,
    onMarkMessagesRead,
    onMaybeMessage,
    openActiveGroupInfo,
    openConversationForGroup,
    openConversationForPeer,
    openGroupMemberDetail,
    openGroupNameEditor,
    openSharedContactPreview,
    peerLabelFor,
    pendingCalendarInvitesByEventId,
    pendingMessageItemsByEventId,
    profileCard,
    profileEditorOpen,
    profileForm,
    profileMessage,
    profilePhotoBusy,
    profilePhotoError,
    profilePhotoInputRef,
    profileShareValue,
    profileStatus,
    profileUpdatedAt,
    publicFollowOptions,
    publicFollowPickerOpen,
    publishNip17Giftwraps,
    publishProfileMetadata,
    readNostrIdentity,
    renameGroupBusy,
    renameGroupDraft,
    replyToMessage,
    resolveNip17Relays,
    safePublish,
    scannedContact,
    scannedContactCanShare,
    scannedContactFields,
    scannedContactHeader,
    scannedContactNip05Verified,
    scannedContactShareValue,
    scannedContactTitle,
    scannedContactUsername,
    scannerMessage,
    sendMessengerFileAttachments,
    setActiveContactId,
    setActiveGroupId,
    setActiveThreadPeer,
    setAttachTrayOpen,
    setChatCompose,
    setChatView,
    setContactDetailOverride,
    setContactEditDraft,
    setContactLookupInput,
    setContactReturnView,
    setContactView,
    setDmForwardMessage,
    setDmInfoMessage,
    setDmMessageActions,
    setDmReactionDetail,
    setDmSearch,
    setDmView,
    setGroupInfoTab,
    setGroupMembersSearch,
    setGroupNameDraft,
    setGroupSelectMembers,
    setPendingMessages,
    setProfileEditorOpen,
    setProfileForm,
    setProfilePhotoError,
    setPublicFollowPickerOpen,
    setRenameGroupDraft,
    setReplyToMessage,
    setScannedContact,
    setScannerMessage,
    setScrollToMessageId,
    setShareContactPickerMode,
    setShareContactPickerOpen,
    setShareContactSource,
    setShareContactStatus,
    setSharedContactPreview,
    setShowCustomContactFields,
    setShowScanner,
    shareContactBusy,
    shareContactPickerMode,
    shareContactPickerOpen,
    shareContactSource,
    shareContactStatus,
    shareRecipientOptions,
    sharedContactMetaFor,
    sharedContactPreview,
    sharedContactPreviewCanShare,
    sharedContactPreviewContact,
    sharedContactPreviewFields,
    sharedContactPreviewHeader,
    sharedContactPreviewNip05Verified,
    sharedContactPreviewShareValue,
    sharedContactPreviewTitle,
    sharedContactPreviewUsername,
    showCustomContactFields,
    showScanner,
    sortedContacts,
    strangerUnreadCount,
    threadUnreadMap,
    toggleBlockPeer,
    truncateContactName,
    truncateContactValue,
    upsertContact,
    upsertGroupChat,
    visiblePendingMessages,
  } = useChatRuntime();
  const inConversation = chatView === "conversation";
  // Phones hide the tab bar outside the conversation list; desktop keeps the rail (desktop-layout.css).
  const hideAppTabSwitcher = chatView !== "threads";
  const rootClass = `wallet-modal wallet-modal--chat${hideAppTabSwitcher ? " wallet-modal--app-nav-hidden" : " wallet-modal--with-nav"}${inConversation ? " wallet-modal--chat-convo" : ""}`;

  return (
    <div className={rootClass}>
{isChatPage && (
        <div className="chat-page">
          {chatView === "threads" && <ChatThreadsView />}
          {chatView === "conversation" && activeThread && (
            <div className="chat-conversation">
              {/* Conversation header */}
              <div className="chat-conversation__header">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => {
                    setChatView("threads");
                    setActiveThreadPeer(null);
                    setActiveGroupId(null);
                    setDmView(dmListViewRef.current);
                  }}
                  aria-label="Back to threads"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                {(() => {
                  // Group conversation header
                  if (activeThread.groupId) {
                    const groupMeta = activeGroupChat;
                    const groupLabel = groupMeta?.name || "Group";
                    const memberCount = groupMeta?.members.length || 0;
                    return (
                      <button
                        type="button"
                        className="chat-conversation__peer-center pressable"
                        onClick={openActiveGroupInfo}
                        aria-label={`Open group info for ${groupLabel}`}
                      >
                        <div className="chat-conversation__peer-avatar chat-conversation__peer-avatar--lg chat-conversation__peer-avatar--group">
                          <GroupAvatar members={activeGroupAvatarMembers} />
                        </div>
                        <div className="chat-conversation__peer-name">{groupLabel}</div>
                        {memberCount > 0 && (
                          <div className="chat-conversation__peer-subtitle">{memberCount} members</div>
                        )}
                      </button>
                    );
                  }
                  // DM conversation header
                  const ownNormalized = normalizeNostrPubkey(myCardNpub);
                  const ownHex = ownNormalized ? compressedToRawHex(ownNormalized).toLowerCase() : "";
                  const isSelf = ownHex !== "" && activeThread.peerPubkey === ownHex;
                  const meta = isSelf
                    ? { label: myCardName, picture: profileCard.picture?.trim() || undefined, subtitle: undefined, verifiedNip05: null }
                    : peerLabelFor(activeThread.peerPubkey);
                  const openContact = () => {
                    if (isSelf) return;
                    const existingContact = contacts.find((contact) => {
                      const normalized = normalizeNostrPubkey(contact.npub || "");
                      const contactHex = normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                      return contactHex === activeThread.peerPubkey;
                    });
                    if (existingContact) {
                      setContactReturnView("new-message");
                      setActiveContactId(existingContact.id);
                      setContactDetailOverride(null);
                      setContactView("detail");
                    } else {
                      const peerMeta = getPeerProfile(activeThread.peerPubkey);
                      const created = upsertContact({
                        npub: formatNpub(activeThread.peerPubkey) || "",
                        name: peerMeta.displayName || peerMeta.username || peerMeta.label,
                        displayName: peerMeta.displayName || peerMeta.label,
                        username: sanitizeUsername(peerMeta.username || ""),
                        address: peerMeta.lud16 || "",
                        nip05: peerMeta.nip05 || "",
                        about: peerMeta.about || "",
                        picture: peerMeta.picture || "",
                      });
                      if (created) {
                        setContactReturnView("new-message");
                        setActiveContactId(created.id);
                        setContactDetailOverride(null);
                        setContactView("detail");
                      } else {
                        setActiveContactId(null);
                        setContactDetailOverride(null);
                        setContactEditDraft({
                          id: null,
                          name: peerMeta.displayName || peerMeta.username || peerMeta.label,
                          displayName: peerMeta.displayName || peerMeta.label,
                          username: sanitizeUsername(peerMeta.username || ""),
                          address: peerMeta.lud16 || "",
                          npub: formatNpub(activeThread.peerPubkey) || "",
                          nip05: peerMeta.nip05 || "",
                          about: peerMeta.about || "",
                          picture: peerMeta.picture || "",
                          isProfile: false,
                        });
                        setContactView("edit");
                      }
                    }
                    setChatView("new-message");
                  };
                  return (
                    <button
                      type="button"
                      className={`chat-conversation__peer-center${isSelf ? "" : " pressable"}`}
                      onClick={openContact}
                      aria-label={isSelf ? "My notes" : `Open contact card for ${meta.label}`}
                    >
                      <div className="chat-conversation__peer-avatar chat-conversation__peer-avatar--lg">
                        {meta.picture ? (
                          <img src={meta.picture} alt={meta.label} />
                        ) : (
                          <span>{meta.label.slice(0, 2)}</span>
                        )}
                      </div>
                      <div className="chat-conversation__peer-name">{meta.label}</div>
                    </button>
                  );
                })()}
                <div className="chat-conversation__header-spacer" />
              </div>

              {/* Stranger actions */}
              {activeThread.isStranger && (() => {
                const ownNormalized = normalizeNostrPubkey(myCardNpub);
                const ownHex = ownNormalized ? compressedToRawHex(ownNormalized).toLowerCase() : "";
                return ownHex === "" || activeThread.peerPubkey !== ownHex;
              })() && (
                <div className="chat-conversation__stranger-bar">
                  <button
                    type="button"
                    className="ghost-button button-xs pressable"
                    onClick={() => toggleBlockPeer(activeThread.peerPubkey)}
                  >
                    {dmBlockedPeersRef.current.has(activeThread.peerPubkey) ? "Unblock" : "Block"}
                  </button>
                  <button
                    type="button"
                    className="accent-button button-xs pressable"
                    onClick={() => handleAddPeerToContacts(activeThread.peerPubkey)}
                  >
                    Add to contacts
                  </button>
                </div>
              )}

              {/* Messages */}
              <div
                ref={messagesScrollRef}
                className="chat-conversation__messages"
                style={{ ["--chat-timestamp-reveal-width" as any]: `${CHAT_TIMESTAMP_REVEAL_WIDTH}px` }}
                onTouchStart={(e) => {
                  dragTouchStartX.current = e.touches[0].clientX;
                  dragTouchStartY.current = e.touches[0].clientY;
                  dragDirectionLocked.current = null;
                  if (messagesInnerRef.current) {
                    messagesInnerRef.current.style.setProperty("--chat-timestamp-reveal-duration", "0ms");
                  }
                }}
                onTouchMove={(e) => {
                  const dx = dragTouchStartX.current - e.touches[0].clientX;
                  const dy = Math.abs(e.touches[0].clientY - dragTouchStartY.current);
                  if (!dragDirectionLocked.current) {
                    if (Math.abs(dx) > dy + 4) dragDirectionLocked.current = "horizontal";
                    else if (dy > Math.abs(dx) + 4) dragDirectionLocked.current = "vertical";
                  }
                  if (dragDirectionLocked.current !== "horizontal") return;
                  const offset = Math.max(0, Math.min(CHAT_TIMESTAMP_REVEAL_WIDTH, dx));
                  if (messagesInnerRef.current) {
                    messagesInnerRef.current.style.setProperty("--chat-timestamp-reveal-offset", `${offset}px`);
                  }
                }}
                onTouchEnd={() => {
                  dragDirectionLocked.current = null;
                  if (messagesInnerRef.current) {
                    messagesInnerRef.current.style.setProperty("--chat-timestamp-reveal-duration", "300ms");
                    messagesInnerRef.current.style.setProperty("--chat-timestamp-reveal-offset", "0px");
                  }
                }}
              >
                <div ref={messagesInnerRef} className="chat-messages-inner">
                  {activeThread.messages.filter((msg) => !msg.eventId.startsWith("draft-")).map((msg, idx, arr) => {
                    const prevMsg = idx > 0 ? arr[idx - 1] : null;
                    const prevDay = prevMsg ? new Date(prevMsg.createdAt * 1000) : null;
                    const msgDay = new Date(msg.createdAt * 1000);
                    const showDateSep = !prevDay ||
                      prevDay.getFullYear() !== msgDay.getFullYear() ||
                      prevDay.getMonth() !== msgDay.getMonth() ||
                      prevDay.getDate() !== msgDay.getDate();
                    const matchedItem =
                      messageItemsByEventId.get(msg.eventId) || pendingMessageItemsByEventId.get(msg.eventId);
                    const matchedInvite = pendingCalendarInvitesByEventId.get(msg.eventId);
                    const isPayment = msg.attachment?.type === "payment";
                    const isContact = msg.attachment?.type === "contact";
                    const isBoard = msg.attachment?.type === "board";
                    const isTask = msg.attachment?.type === "task";
                    const isEvent = msg.attachment?.type === "event";
                    const isStructured = !!msg.attachment && msg.attachment.type !== "text";
                    const bubbleClass = `chat-bubble${msg.isIncoming ? " chat-bubble--in" : " chat-bubble--out"}${isStructured ? " chat-bubble--card" : ""}${isContact ? " chat-bubble--contact-shell" : ""}${isTask ? " chat-bubble--task-share-shell" : ""}`;
                    const isIncomingGroupMessage = !!(activeThread.groupId && msg.isIncoming && msg.senderPubkey);
                    const senderMeta =
                      isIncomingGroupMessage && msg.senderPubkey ? peerLabelFor(msg.senderPubkey) : null;
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
                          contactAttachment.picture || matchedItem?.contact?.picture || null,
                        )
                      : null;
                    const taskAttachment = isTask ? msg.attachment?.task || matchedItem?.task || null : null;
                    const taskDueSeconds = taskAttachment?.dueISO
                      ? Math.floor(new Date(taskAttachment.dueISO).getTime() / 1000)
                      : null;
                    const taskHasDue = !!(taskDueSeconds && Number.isFinite(taskDueSeconds) && taskDueSeconds > 0);
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
                    const taskCopyValue = isTask
                      ? buildDmCopyValue(msg, { taskPayload: taskAttachment || matchedItem?.task || null })
                      : "";
                    const eventAttachment = isEvent ? msg.attachment : null;
                    const eventReferenceSeconds =
                      eventAttachment?.start ? parseDateLikeToUnixSeconds(eventAttachment.start, msg.createdAt) : msg.createdAt;
                    const eventDayLabel = `${new Date(eventReferenceSeconds * 1000).getDate()}`.padStart(2, "0");
                    const eventCardDate = formatShortDate(eventReferenceSeconds);
                    const eventWhenLabel =
                      eventAttachment?.whenLabel ||
                      (matchedInvite && formatCalendarInviteWhen ? formatCalendarInviteWhen(matchedInvite) : "") ||
                      "Event invite";
                    const eventTitle = eventAttachment?.title || matchedInvite?.title || "Event invite";
                    const eventCopyValue =
                      (
                        eventAttachment?.view ||
                        matchedInvite?.view ||
                        eventAttachment?.canonical ||
                        matchedInvite?.canonical ||
                        [eventTitle, eventWhenLabel].filter(Boolean).join("\n")
                      ).trim() || eventTitle;
                    const actionStatus = matchedItem?.status || matchedInvite?.status;
                    const showActionButtons =
                      actionStatus !== "accepted" &&
                      actionStatus !== "declined" &&
                      actionStatus !== "tentative" &&
                      actionStatus !== "deleted" &&
                      actionStatus !== "dismissed";
                    const contactStatusLabel = getWalletMessageStatusLabel("contact", actionStatus as WalletMessageItem["status"]);
                    const taskStatusLabel = getWalletMessageStatusLabel("task", actionStatus as WalletMessageItem["status"]);
                    const eventStatusLabel = getCalendarInviteStatusLabel(actionStatus);
                    const hasReactions = (dmReactions.get(msg.rumorEventId || msg.eventId)?.length ?? 0) > 0;

                    return (
                      <React.Fragment key={msg.eventId}>
                        {showDateSep && (
                          <div className="chat-date-separator">{formatDmDateSeparator(msg.createdAt)}</div>
                        )}
                        <div data-msg-id={msg.eventId} className={`chat-message ${msg.isIncoming ? "chat-message--in" : "chat-message--out"}`}>
                          <div className={`chat-message__body${senderMeta ? " chat-message__body--group-in" : ""}`}>
                            {senderMeta && (
                              <div className={`chat-message__sender-avatar${senderMeta.picture ? " chat-message__sender-avatar--image" : ""}`}>
                                {senderMeta.picture ? (
                                  <img src={senderMeta.picture} alt={senderMeta.label} className="contact-avatar__img" />
                                ) : (
                                  contactInitials(senderMeta.label)
                                )}
                              </div>
                            )}
                            <div className={`chat-message__content${senderMeta ? " chat-message__content--group-in" : ""}`}>
                              {senderMeta && <div className="chat-message__sender-name">{senderMeta.label}</div>}
                              <div className={`chat-bubble-wrap${hasReactions ? " chat-bubble-wrap--reacted" : ""}`}>
                              <div
                                className={bubbleClass}
                                onContextMenu={(ev) => {
                                  ev.preventDefault();
                                  ev.stopPropagation();
                                  cancelDmLongPress();
                                  setDmMessageActions({ eventId: msg.eventId, copyValue: buildDmCopyValue(msg, {}), msg });
                                }}
                                onPointerDown={(ev) => {
                                  if ((ev.target as HTMLElement | null)?.closest("button,a")) return;
                                  cancelDmLongPress();
                                  dmLongPressTimerRef.current = window.setTimeout(() => {
                                    setDmMessageActions({ eventId: msg.eventId, copyValue: buildDmCopyValue(msg, {}), msg });
                                  }, 420);
                                }}
                                onPointerUp={cancelDmLongPress}
                                onPointerLeave={cancelDmLongPress}
                                onPointerCancel={cancelDmLongPress}
                              >
                              {isBoard && (
                                <div className="chat-bubble__card">
                                  <div className="chat-bubble__card-title">{msg.attachment?.boardName || "Shared board"}</div>
                                  <div className="chat-bubble__card-meta">Add this board to your workspace</div>
                                  {showActionButtons && (
                                    <div className="chat-bubble__card-actions">
                                      <button type="button" className="accent-button button-xs pressable" onClick={() => matchedItem && onAcceptMessage(matchedItem.id)}>Add board</button>
                                      <button type="button" className="ghost-button button-xs pressable" onClick={() => matchedItem && onDismissMessage(matchedItem.id)}>Dismiss</button>
                                    </div>
                                  )}
                                  {!showActionButtons && actionStatus && (
                                    <div className="chat-bubble__card-status">{actionStatus}</div>
                                  )}
                                </div>
                              )}
                              {isContact && (() => {
                                const contactName =
                                  contactMeta?.label ||
                                  contactAttachment?.contactName ||
                                  contactAttachment?.displayName ||
                                  contactAttachment?.username ||
                                  "Contact";
                                const contactSubtitle = contactMeta?.subtitle || "Shared contact";
                                return (
                                  <div className="chat-bubble__card chat-bubble__card--contact-preview">
                                    <button
                                      type="button"
                                      className="chat-bubble__contact-preview pressable"
                                      onClick={() => openSharedContactPreview(contactAttachment, matchedItem)}
                                    >
                                      <div className="chat-bubble__contact-avatar">
                                        {contactMeta?.picture ? (
                                          <img src={contactMeta.picture} alt={contactName} className="contact-avatar__img" />
                                        ) : (
                                          contactInitials(contactName)
                                        )}
                                      </div>
                                      <div className="chat-bubble__contact-copy">
                                        <div className="chat-bubble__contact-name">{contactName}</div>
                                        <div className="chat-bubble__contact-subtitle">
                                          <span>{contactSubtitle}</span>
                                          {contactMeta?.verifiedNip05 && (
                                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                                          )}
                                        </div>
                                      </div>
                                      <span className="chat-bubble__contact-chevron" aria-hidden="true">›</span>
                                    </button>
                                    {!showActionButtons && contactStatusLabel && (
                                      <div className="chat-bubble__card-status">{contactStatusLabel}</div>
                                    )}
                                  </div>
                                );
                              })()}
                              {isTask && (() => {
                                const taskMetaLabel = isTaskAssignment
                                  ? "Task assignment"
                                  : taskHasDue
                                    ? taskDueLabel
                                    : "";
                                const taskHasBoardDetail = !!taskAttachment?.note?.trim() || taskSubtasks.length > 0;
                                return (
                                  <div className="chat-bubble__task-share">
                                    <div className="task-card" data-form={taskHasBoardDetail ? "stacked" : "pill"}>
                                      <div className="flex items-start gap-3">
                                        <div
                                          className="icon-button flex-shrink-0 chat-bubble__task-check"
                                          style={{ ["--icon-size" as any]: "1.85rem" }}
                                          aria-hidden="true"
                                        />
                                        <div className="flex-1 min-w-0 space-y-1">
                                          <div className="task-card__title">{taskAttachment?.title || "Shared task"}</div>
                                          {taskMetaLabel && <div className="task-card__meta">{taskMetaLabel}</div>}
                                        </div>
                                      </div>
                                      {taskAttachment?.note && (
                                        <div
                                          className="task-card__details text-xs text-secondary break-words"
                                          style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                                        >
                                          {taskAttachment.note}
                                        </div>
                                      )}
                                      {taskSubtasks.length > 0 && (
                                        <ul className="task-card__details mt-2 space-y-1.5 text-xs text-secondary">
                                          {taskSubtasks.slice(0, 6).map((title) => (
                                            <li key={title} className="subtask-row">
                                              <input type="checkbox" checked={false} readOnly disabled className="subtask-row__checkbox" />
                                              <span className="subtask-row__text text-secondary">{title}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                    {showActionButtons && (
                                      <div className="chat-bubble__task-action-bar">
                                        {isTaskAssignment ? (
                                          <>
                                            <button type="button" className="accent-button button-xs pressable" onClick={() => matchedItem && onAcceptMessage(matchedItem.id)}>Accept</button>
                                            <button type="button" className="ghost-button button-xs pressable" onClick={() => matchedItem && onMaybeMessage(matchedItem.id)}>Maybe</button>
                                            <button type="button" className="ghost-button button-xs pressable text-rose-400" onClick={() => matchedItem && onDeclineMessage(matchedItem.id)}>Decline</button>
                                          </>
                                        ) : (
                                          <>
                                            <button type="button" className="accent-button button-xs pressable" onClick={() => matchedItem && onAcceptMessage(matchedItem.id)}>Add task</button>
                                            <button type="button" className="ghost-button button-xs pressable" onClick={() => void copyMessageValue(taskCopyValue, "Task")}>Copy</button>
                                            <button type="button" className="ghost-button button-xs pressable" onClick={() => matchedItem && onDismissMessage(matchedItem.id)}>Dismiss</button>
                                          </>
                                        )}
                                      </div>
                                    )}
                                    {!showActionButtons && taskStatusLabel && (
                                      <div className="chat-bubble__task-status">{taskStatusLabel}</div>
                                    )}
                                  </div>
                                );
                              })()}
                              {isEvent && (
                                <div className="chat-bubble__card chat-bubble__card--structured">
                                  <div className="chat-bubble__card-shell">
                                    <div className="wallet-message__card-icon">{eventDayLabel}</div>
                                    <div className="wallet-message__card-body">
                                      <div className="wallet-message__card-title">{eventTitle}</div>
                                      <div className="wallet-message__card-subtitle">{eventWhenLabel}</div>
                                    </div>
                                    <div className="wallet-message__card-meta">{eventCardDate}</div>
                                  </div>
                                  {showActionButtons && (
                                    <div className="wallet-message__card-actions">
                                      <button type="button" className="accent-button button-xs pressable" onClick={() => matchedInvite && onCalendarInviteRsvp?.(matchedInvite, "accepted")}>Add event</button>
                                      <button type="button" className="ghost-button button-xs pressable" onClick={() => void copyMessageValue(eventCopyValue, "Event")}>Copy</button>
                                      <button type="button" className="ghost-button button-xs pressable" onClick={() => matchedInvite && onDismissCalendarInvite?.(matchedInvite)}>Dismiss</button>
                                    </div>
                                  )}
                                  {!showActionButtons && eventStatusLabel && (
                                    <div className="chat-bubble__card-status">{eventStatusLabel}</div>
                                  )}
                                </div>
                              )}
                              {isPayment && (
                                <ChatTokenBubble
                                  token={msg.attachment?.raw || msg.content}
                                  onCopy={(value) => void copyMessageValue(value, "Token")}
                                />
                              )}
                              {msg.attachment?.type === "text" && (() => {
                                const msgUrls = extractUrlsFromText(msg.content);
                                const repliedMsg = msg.replyToEventId
                                  ? dmMessages.find(
                                      (m) => m.eventId === msg.replyToEventId || m.rumorEventId === msg.replyToEventId,
                                    )
                                  : null;
                                return (
                                  <div className="chat-bubble__card chat-bubble__card--text">
                                    {repliedMsg && (
                                      <div className="chat-reply-quote">
                                        <div className="chat-reply-quote__bar" />
                                        <div className="chat-reply-quote__text">
                                          {repliedMsg.content.length > 80 ? repliedMsg.content.slice(0, 80) + "…" : repliedMsg.content}
                                        </div>
                                      </div>
                                    )}
                                    <div className="chat-bubble__text">{renderFormattedText(msg.content)}</div>
                                    {msgUrls.length > 0 && (
                                      <div className="chat-link-previews">
                                        {msgUrls.map((url) => {
                                          const domain = extractDomain(url);
                                          const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
                                          const displayUrl = url.length > 55 ? url.slice(0, 52) + "…" : url;
                                          return (
                                            <a
                                              key={url}
                                              href={url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="chat-link-preview pressable"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <img
                                                src={faviconUrl}
                                                alt=""
                                                className="chat-link-preview__favicon"
                                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                              />
                                              <div className="chat-link-preview__copy">
                                                <div className="chat-link-preview__domain">{domain}</div>
                                                <div className="chat-link-preview__url">{displayUrl}</div>
                                              </div>
                                              <span className="chat-link-preview__arrow" aria-hidden="true">↗</span>
                                            </a>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                              {msg.attachment?.type === "file" && (
                                <MessengerFileBubble
                                  descriptor={{
                                    url: msg.attachment.url,
                                    mimeType: msg.attachment.mimeType,
                                    filename: msg.attachment.filename,
                                    size: msg.attachment.size,
                                    width: msg.attachment.width,
                                    height: msg.attachment.height,
                                    algorithm: msg.attachment.algorithm,
                                    keyHex: msg.attachment.keyHex,
                                    nonceHex: msg.attachment.nonceHex,
                                  }}
                                  isIncoming={msg.isIncoming}
                                />
                              )}
                            </div>
                            {(() => {
                              const reactionKey = msg.rumorEventId || msg.eventId;
                              const msgReactions = dmReactions.get(reactionKey);
                              if (!msgReactions?.length) return null;
                              const grouped = new Map<string, DmReaction[]>();
                              for (const r of msgReactions) {
                                const arr = grouped.get(r.emoji) || [];
                                arr.push(r);
                                grouped.set(r.emoji, arr);
                              }
                              return (
                                <div className={`chat-tapbacks${msg.isIncoming ? " chat-tapbacks--in" : " chat-tapbacks--out"}`}>
                                  {Array.from(grouped.entries()).map(([emoji, reactions]) => (
                                    <button
                                      key={emoji}
                                      type="button"
                                      className="chat-tapback pressable"
                                      onClick={() => setDmReactionDetail({ eventId: reactionKey })}
                                    >
                                      <span className="chat-tapback__emoji">{emoji}</span>
                                      {reactions.length > 1 && <span className="chat-tapback__count">{reactions.length}</span>}
                                    </button>
                                  ))}
                                </div>
                              );
                            })()}
                              </div>
                            </div>
                          </div>
                          <div className="chat-message__timestamp">{formatDmTime(msg.createdAt)}</div>
                        </div>
                      </React.Fragment>
                    );
                  })}
                  {/* Pending messages */}
                  {visiblePendingMessages.map((pm) => (
                    <div key={pm.id} className="chat-message chat-message--out">
                      <div className="chat-message__body">
                        <div className="chat-message__bubble-wrap">
                          <div className="chat-bubble chat-bubble--out chat-bubble--pending">
                            {pm.file ? (
                              <div className={`chat-bubble__card chat-bubble__card--file${isImageMime(pm.file.mimeType) ? " chat-bubble__card--image" : isVideoMime(pm.file.mimeType) ? " chat-bubble__card--video" : isAudioMime(pm.file.mimeType) ? " chat-bubble__card--audio" : " chat-bubble__card--doc"} chat-bubble__card--pending`}>
                                {pm.file.previewUrl && isImageMime(pm.file.mimeType) ? (
                                  <div className="chat-file__image-frame">
                                    <img
                                      src={pm.file.previewUrl}
                                      alt={pm.file.filename}
                                      className="chat-file__image chat-file__image--pending"
                                    />
                                    <div className="chat-file__progress-overlay">
                                      <div className="chat-file__progress-label">
                                        {pm.file.phase === "encrypting"
                                          ? "Encrypting…"
                                          : pm.file.phase === "uploading"
                                            ? `Uploading ${Math.round((pm.file.progress || 0) * 100)}%`
                                            : "Sending…"}
                                      </div>
                                      <div className="chat-file__progress-track">
                                        <div
                                          className="chat-file__progress-bar"
                                          style={{ width: `${Math.round((pm.file.progress || 0) * 100)}%` }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="chat-file__doc chat-file__doc--pending">
                                    <div className="chat-file__doc-icon">
                                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
                                        <polyline points="13 2 13 9 20 9" />
                                      </svg>
                                    </div>
                                    <div className="chat-file__doc-body">
                                      <div className="chat-file__name" title={pm.file.filename}>{pm.file.filename}</div>
                                      <div className="chat-file__size">
                                        {pm.file.phase === "encrypting"
                                          ? "Encrypting…"
                                          : pm.file.phase === "uploading"
                                            ? `Uploading ${Math.round((pm.file.progress || 0) * 100)}%`
                                            : "Sending…"}
                                      </div>
                                      <div className="chat-file__progress-track chat-file__progress-track--doc">
                                        <div
                                          className="chat-file__progress-bar"
                                          style={{ width: `${Math.round((pm.file.progress || 0) * 100)}%` }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="chat-bubble__card chat-bubble__card--text">
                                <div className="chat-bubble__text">{renderFormattedText(pm.content)}</div>
                              </div>
                            )}
                          </div>
                          {pm.status === "sending" && <div className="chat-sending-spinner" />}
                          {pm.status === "sent" && <div className="chat-sending-check" key={`check-${pm.id}`}>✓</div>}
                        </div>
                      </div>
                      <div className="chat-message__timestamp">{formatDmTime(pm.createdAt)}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Compose bar */}
              {activeThread.groupId && activeGroupLeft ? (
                <div className="chat-group-rejoin">
                  <div className="chat-group-rejoin__note">You left this group.</div>
                  <button
                    type="button"
                    className="chat-group-rejoin__button pressable"
                    onClick={handleToggleActiveGroupMembership}
                  >
                    Join Group
                  </button>
                </div>
              ) : (
                <div className="chat-compose-stack">
                  {!activeThread.groupId && activeBotCommands && chatCompose.startsWith("/") && (() => {
                    const query = chatCompose.slice(1).toLowerCase();
                    const matched = activeBotCommands.filter((command) => command.name.startsWith(query));
                    if (!matched.length) return null;
                    return (
                      <div className="chat-command-menu" role="listbox" aria-label="Bot commands">
                        {matched.map((command) => (
                          <button
                            key={command.name}
                            type="button"
                            className="chat-command-menu__item pressable"
                            role="option"
                            aria-selected={false}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setChatCompose(`/${command.name} `);
                              chatComposeInputRef.current?.focus();
                            }}
                          >
                            <span className="chat-command-menu__name">/{command.name}</span>
                            {command.description && (
                              <span className="chat-command-menu__description">{command.description}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                  {replyToMessage && (
                    <div className="chat-reply-banner">
                      <div className="chat-reply-banner__bar" />
                      <div className="chat-reply-banner__body">
                        <div className="chat-reply-banner__label">Reply</div>
                        <div className="chat-reply-banner__text">
                          {replyToMessage.content.length > 80 ? replyToMessage.content.slice(0, 80) + "…" : replyToMessage.content}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="chat-reply-banner__close pressable"
                        aria-label="Cancel reply"
                        onClick={() => setReplyToMessage(null)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                  )}
                  <input
                    ref={chatPhotoInputRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    tabIndex={-1}
                    aria-hidden="true"
                    style={{ position: "fixed", bottom: 0, left: 0, width: 1, height: 1, opacity: 0 }}
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      e.target.value = "";
                      if (files.length) {
                        closeAttachTray();
                        void sendMessengerFileAttachments(files, activeThread.peerPubkey);
                      }
                    }}
                  />
                  <input
                    ref={chatFileInputRef}
                    type="file"
                    accept={CHAT_FILE_PICKER_ACCEPT}
                    multiple
                    tabIndex={-1}
                    aria-hidden="true"
                    style={{ position: "fixed", bottom: 0, left: 0, width: 1, height: 1, opacity: 0 }}
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      e.target.value = "";
                      if (files.length) {
                        closeAttachTray();
                        void sendMessengerFileAttachments(files, activeThread.peerPubkey);
                      }
                    }}
                  />
                  <div className="chat-compose">
                    <button
                      type="button"
                      className={`chat-compose__attach chat-compose__attach--toggle pressable${attachTrayOpen ? " is-open" : ""}`}
                      onClick={handleToggleAttachTray}
                      aria-label={attachTrayOpen ? "Close attachments" : "Open attachments"}
                      aria-expanded={attachTrayOpen}
                      title={attachTrayOpen ? "Close attachments" : "Open attachments"}
                    >
                      <span className="chat-compose__attach-icon" aria-hidden="true">
                        <span className="chat-compose__attach-line chat-compose__attach-line--horizontal" />
                        <span className="chat-compose__attach-line chat-compose__attach-line--vertical" />
                      </span>
                    </button>
                    <input
                      ref={chatComposeInputRef}
                      className="chat-compose__input"
                      placeholder="Message"
	                      value={chatCompose}
	                      onFocus={() => {
	                        setAttachTrayOpen(false);
	                      }}
                      onChange={(e) => setChatCompose(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && chatCompose.trim()) {
                          e.preventDefault();
                          const capturedReply = replyToMessage;
                          void (async () => {
                            const text = chatCompose.trim();
                            if (!text) return;
                            setChatCompose("");
                            setReplyToMessage(null);
                            const pendingId = crypto.randomUUID();
                            const pendingCreatedAt = Math.floor(Date.now() / 1000);
                            setPendingMessages(prev => [
                              ...prev,
                              {
                                id: pendingId,
                                content: text,
                                peerPubkey: activeThread.peerPubkey,
                                createdAt: pendingCreatedAt,
                                status: "sending",
                              },
                            ]);
                            try {
                              const { identity } = readNostrIdentity();
                              if (!identity) return;
                              const senderHex = identity.pubkey.toLowerCase();
                              const isGroup = !!activeThread.groupId;
                              const groupMeta = isGroup ? groupChatsRef.current.find((g) => g.groupId === activeThread.groupId) : null;
                              const groupRecipients = groupMeta ? groupMeta.members.filter((m) => m !== senderHex) : [];
                              const recipientHex = isGroup ? groupRecipients[0] || "" : activeThread.peerPubkey.toLowerCase();
                              const relayTargets = isGroup ? groupRecipients : [recipientHex];
                              const allRelays = new Set<string>();
                              for (const target of relayTargets) {
                                const relays = await resolveNip17Relays(target, defaultNostrRelays);
                                relays.forEach((r) => allRelays.add(r));
                              }
                              const publishRelays = Array.from(allRelays);
                              if (!publishRelays.length) return;
                              const pool = ensureNostrPool();
                              const publish = (event: NostrEvent) => safePublish(pool, publishRelays, event);
                              const extraTags: string[][] = [];
                              if (isGroup && groupMeta?.name) extraTags.push(["subject", groupMeta.name]);
                              if (capturedReply) {
                                extraTags.push(["e", capturedReply.rumorEventId || capturedReply.eventId]);
                              }
                              const { selfWrapEvent } = await publishNip17Giftwraps({
                                relays: publishRelays,
                                content: text,
                                senderHex,
                                recipientHex,
                                senderSecret: identity.secret,
                                publish,
                                ...(isGroup ? { recipientHexes: groupRecipients, extraTags } : { extraTags: capturedReply ? extraTags : undefined }),
                              });
                              if (selfWrapEvent) {
                                await handleDmEvent(selfWrapEvent);
                              }
                              setPendingMessages(prev => prev.map(m => m.id === pendingId ? { ...m, status: "sent" as const } : m));
                              setTimeout(() => setPendingMessages(prev => prev.filter(m => m.id !== pendingId)), 2000);
                            } catch (err) {
                              setPendingMessages(prev => prev.filter(m => m.id !== pendingId));
                              console.warn("[chat] send failed", err);
                              setChatCompose(text);
                            }
                          })();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="chat-compose__send pressable"
                      disabled={!chatCompose.trim()}
                      onClick={() => {
                        const capturedReply = replyToMessage;
                        void (async () => {
                          const text = chatCompose.trim();
                          if (!text) return;
                          setChatCompose("");
                          setReplyToMessage(null);
                          const pendingId = crypto.randomUUID();
                          const pendingCreatedAt = Math.floor(Date.now() / 1000);
                          setPendingMessages(prev => [
                            ...prev,
                            {
                              id: pendingId,
                              content: text,
                              peerPubkey: activeThread.peerPubkey,
                              createdAt: pendingCreatedAt,
                              status: "sending",
                            },
                          ]);
                          try {
                            const { identity } = readNostrIdentity();
                            if (!identity) return;
                            const senderHex = identity.pubkey.toLowerCase();
                            const isGroup = !!activeThread.groupId;
                            const groupMeta = isGroup ? groupChatsRef.current.find((g) => g.groupId === activeThread.groupId) : null;
                            const groupRecipients = groupMeta ? groupMeta.members.filter((m) => m !== senderHex) : [];
                            const recipientHex = isGroup ? groupRecipients[0] || "" : activeThread.peerPubkey.toLowerCase();
                            const relayTargets = isGroup ? groupRecipients : [recipientHex];
                            const allRelays = new Set<string>();
                            for (const target of relayTargets) {
                              const relays = await resolveNip17Relays(target, defaultNostrRelays);
                              relays.forEach((r) => allRelays.add(r));
                            }
                            const publishRelays = Array.from(allRelays);
                            if (!publishRelays.length) return;
                            const pool = ensureNostrPool();
                            const publish = (event: NostrEvent) => safePublish(pool, publishRelays, event);
                            const extraTags: string[][] = [];
                            if (isGroup && groupMeta?.name) extraTags.push(["subject", groupMeta.name]);
                            if (capturedReply) {
                              extraTags.push(["e", capturedReply.rumorEventId || capturedReply.eventId]);
                            }
                            const { selfWrapEvent } = await publishNip17Giftwraps({
                              relays: publishRelays,
                              content: text,
                              senderHex,
                              recipientHex,
                              senderSecret: identity.secret,
                              publish,
                              ...(isGroup ? { recipientHexes: groupRecipients, extraTags } : { extraTags: capturedReply ? extraTags : undefined }),
                            });
                            if (selfWrapEvent) {
                              await handleDmEvent(selfWrapEvent);
                            }
                            setPendingMessages(prev => prev.map(m => m.id === pendingId ? { ...m, status: "sent" as const } : m));
                            setTimeout(() => setPendingMessages(prev => prev.filter(m => m.id !== pendingId)), 2000);
                          } catch (err) {
                            setPendingMessages(prev => prev.filter(m => m.id !== pendingId));
                            console.warn("[chat] send failed", err);
                            setChatCompose(text);
                          }
                        })();
                      }}
                      aria-label="Send message"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                      </svg>
                    </button>
                  </div>
                  <div
                    className={`chat-compose-tray${attachTrayOpen ? " is-open" : ""}`}
                    style={{ ["--chat-compose-tray-height" as any]: `${chatAttachTrayHeight}px` }}
                    aria-hidden={!attachTrayOpen}
                  >
                    <div className="chat-compose-tray__surface">
                      <div className="chat-compose-tray__grid">
                        <button type="button" className="chat-compose-tray__action pressable" onClick={handleOpenChatPhotoPicker}>
                          <span className="chat-compose-tray__action-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3.5" y="5" width="17" height="14" rx="3" />
                              <circle cx="8.5" cy="10" r="1.5" />
                              <path d="m6.5 16 4.2-4.2a1.2 1.2 0 0 1 1.7 0L17.5 17" />
                              <path d="m13.5 14 1.2-1.2a1.2 1.2 0 0 1 1.7 0l1.6 1.6" />
                            </svg>
                          </span>
                          <span className="chat-compose-tray__action-label">Photos</span>
                        </button>
                        <button type="button" className="chat-compose-tray__action pressable" onClick={handleOpenChatFilePicker}>
                          <span className="chat-compose-tray__action-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M8 3.5h6l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z" />
                              <path d="M14 3.5V8h4" />
                            </svg>
                          </span>
                          <span className="chat-compose-tray__action-label">File</span>
                        </button>
                        <button type="button" className="chat-compose-tray__action pressable" onClick={handleOpenChatContactPicker}>
                          <span className="chat-compose-tray__action-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="8.25" r="3.25" />
                              <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
                            </svg>
                          </span>
                          <span className="chat-compose-tray__action-label">Contact</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {chatView === "group-info" && activeThread?.groupId && activeGroupChat && (() => {
            const groupMediaMessages = activeThread.messages.filter(
              (m) => m.attachment?.type === "file",
            );
            const URL_RE = /https?:\/\/[^\s<>"']+/g;
            const groupLinkMessages = activeThread.messages
              .filter((m) => !m.attachment || m.attachment.type === "text")
              .map((m) => {
                const urls = m.content.match(URL_RE) || [];
                return urls.length ? { message: m, urls } : null;
              })
              .filter(Boolean) as { message: WalletDmMessage; urls: string[] }[];
            return (
              <div className="chat-group-info">
                {/* Header */}
                <div className="chat-page__header chat-page__header--safe-area">
                  <button
                    className="glass-icon-button pressable"
                    onClick={() => setChatView("conversation")}
                    aria-label="Back to conversation"
                  >
                    <BackIcon className="h-5 w-5" />
                  </button>
                  <div className="chat-group-info__header-avatar">
                    <GroupAvatar members={activeGroupAvatarMembers} />
                  </div>
                  <button
                    type="button"
                    className="chat-group-info__edit-btn pressable"
                    onClick={openGroupNameEditor}
                  >
                    Edit
                  </button>
                </div>

                {/* Group name */}
                <div className="chat-group-info__name">{activeGroupChat.name || "Group"}</div>

                {/* Tab bar */}
                <div className="chat-group-info__tab-bar">
                  {(["info", "photos", "links"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      className={`chat-group-info__tab-btn pressable${groupInfoTab === tab ? " chat-group-info__tab-btn--active" : ""}`}
                      onClick={() => setGroupInfoTab(tab)}
                    >
                      {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className="chat-group-info__tab-body">
                  {groupInfoTab === "info" && (
                    <>
                      {/* Member grid */}
                      <div className="chat-group-info__member-grid">
                        {activeGroupMembers.map((member) => (
                          <button
                            key={member.memberHex}
                            type="button"
                            className="chat-group-info__member-cell pressable"
                            onClick={() => {
                              setContactReturnView("group-info");
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
                            }}
                          >
                            <div className={`chat-group-info__member-circle${member.picture ? " chat-group-info__member-circle--image" : ""}`}>
                              {member.picture ? (
                                <img src={member.picture} alt={member.label} className="chat-group-info__member-avatar-img" />
                              ) : (
                                <span>{contactInitials(member.label)}</span>
                              )}
                            </div>
                            <span className="chat-group-info__member-name">{member.label.split(" ")[0]}</span>
                          </button>
                        ))}
                        <button
                          type="button"
                          className="chat-group-info__member-cell pressable"
                          onClick={() => { setGroupMembersSearch(""); setChatView("group-members"); }}
                        >
                          <div className="chat-group-info__member-circle chat-group-info__member-circle--add">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                          </div>
                          <span className="chat-group-info__member-name">Add</span>
                        </button>
                      </div>
                      {/* Mute + leave */}
                      <div className="chat-group-info__card" style={{ margin: "0 1rem" }}>
                        <div className="chat-group-info__row">
                          <span className="chat-group-info__row-label">Mute</span>
                          <button
                            type="button"
                            className={`edit-toggle pressable${activeGroupMuted ? " is-on" : ""}`}
                            onClick={handleToggleActiveGroupMute}
                            aria-label={activeGroupMuted ? "Unmute group" : "Mute group"}
                            aria-pressed={activeGroupMuted}
                          >
                            <span className="edit-toggle__thumb" />
                          </button>
                        </div>
                        <button
                          type="button"
                          className={`chat-group-info__leave-button pressable${activeGroupLeft ? " chat-group-info__leave-button--join" : ""}`}
                          onClick={handleToggleActiveGroupMembership}
                        >
                          {activeGroupLeft ? "Join Group" : "Leave Group"}
                        </button>
                      </div>
                    </>
                  )}

                  {groupInfoTab === "photos" && (
                    groupMediaMessages.length === 0 ? (
                      <div className="chat-group-info__empty">No photos shared yet.</div>
                    ) : (
                      <div className="chat-group-info__photo-grid">
                        {groupMediaMessages.map((msg) => {
                          const att = msg.attachment as Extract<WalletDmAttachment, { type: "file" }>;
                          return (
                            <div key={msg.eventId} className="chat-group-info__photo-cell">
                              <MessengerFileBubble
                                descriptor={{
                                  url: att.url,
                                  mimeType: att.mimeType,
                                  filename: att.filename ?? undefined,
                                  size: att.size ?? undefined,
                                  width: att.width ?? undefined,
                                  height: att.height ?? undefined,
                                  algorithm: att.algorithm,
                                  keyHex: att.keyHex,
                                  nonceHex: att.nonceHex,
                                }}
                                isIncoming={msg.isIncoming}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )
                  )}

                  {groupInfoTab === "links" && (
                    groupLinkMessages.length === 0 ? (
                      <div className="chat-group-info__empty">No links shared yet.</div>
                    ) : (
                      <div className="chat-group-info__links-grid">
                        {groupLinkMessages.flatMap(({ message, urls }) =>
                          urls.map((url, i) => {
                            const domain = (() => { try { return new URL(url).hostname; } catch { return url; } })();
                            const pathSegments = (() => { try { return new URL(url).pathname.split("/").filter(Boolean); } catch { return []; } })();
                            const cardTitle = pathSegments.length > 0
                              ? decodeURIComponent(pathSegments[pathSegments.length - 1]).replace(/[-_]/g, " ").replace(/\.[^.]+$/, "")
                              : domain;
                            const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
                            return (
                              <a
                                key={`${message.eventId}-${i}`}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="chat-group-info__link-card pressable"
                              >
                                <div className="chat-group-info__link-card__preview">
                                  <img
                                    src={faviconUrl}
                                    alt=""
                                    className="chat-group-info__link-card__favicon"
                                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0"; }}
                                  />
                                </div>
                                <div className="chat-group-info__link-card__footer">
                                  <div className="chat-group-info__link-card__title">{cardTitle || domain}</div>
                                  <div className="chat-group-info__link-card__domain">{domain}</div>
                                </div>
                              </a>
                            );
                          })
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })()}

          {chatView === "group-members" && activeThread?.groupId && activeGroupChat && (
            <div className="chat-group-members">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => setChatView("group-info")}
                  aria-label="Back to group info"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">
                  Members ({activeGroupMembers.length})
                </div>
                <div className="chat-conversation__header-spacer" aria-hidden="true" />
              </div>
              <div className="chat-page__search">
                <div className="chat-page__search-shell">
                  <input
                    className="chat-page__search-input"
                    placeholder="Search members"
                    value={groupMembersSearch}
                    onChange={(event) => setGroupMembersSearch(event.target.value)}
                  />
                  {groupMembersSearch.length > 0 && (
                    <button
                      type="button"
                      className="chat-page__search-clear pressable"
                      aria-label="Clear search"
                      title="Clear search"
                      onClick={() => setGroupMembersSearch("")}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <div className="chat-group-members__list">
                {filteredActiveGroupMembers.map((member) => (
                  <button
                    key={member.memberHex}
                    type="button"
                    className="contact-row pressable"
                    onClick={() => openGroupMemberDetail(member.memberHex)}
                  >
                    <div className={`contact-avatar${member.picture ? " contact-avatar--image" : ""}`}>
                      {member.picture ? (
                        <img src={member.picture} alt={member.label} className="contact-avatar__img" />
                      ) : (
                        contactInitials(member.label)
                      )}
                    </div>
                    <div className="contact-row__text">
                      <div className="contact-row__name">{member.label}</div>
                      {member.subtitle && (
                        <div className="contact-row__meta">
                          <span className="contact-row__meta-text">{truncateContactValue(member.subtitle, 32)}</span>
                        </div>
                      )}
                    </div>
                    <span className="contact-row__chevron">&rsaquo;</span>
                  </button>
                ))}
                {filteredActiveGroupMembers.length === 0 && (
                  <div className="chat-page__empty">No members match your search.</div>
                )}
              </div>
            </div>
          )}

          {chatView === "group-name-edit" && activeThread?.groupId && activeGroupChat && (
            <div className="chat-group-name-edit">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => {
                    if (renameGroupBusy) return;
                    setChatView("group-info");
                  }}
                  aria-label="Back to group info"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">Edit Group Name</div>
                <button
                  type="button"
                  className={`chat-page__header-action-text pressable${renameGroupBusy || !renameGroupDraft.trim() ? " chat-page__header-action-text--disabled" : ""}`}
                  onClick={() => {
                    if (!renameGroupBusy && renameGroupDraft.trim()) {
                      void handleRenameGroupSubmit();
                    }
                  }}
                >
                  {renameGroupBusy ? "Saving…" : "Done"}
                </button>
              </div>
              <div className="chat-group-name-edit__body">
                <div className="chat-group-name-edit__title">Edit Group Name</div>
                <label className="chat-new-group__label">Group Name</label>
                <input
                  className="chat-group-name-edit__input"
                  value={renameGroupDraft}
                  onChange={(event) => setRenameGroupDraft(event.target.value)}
                  maxLength={100}
                  autoFocus
                  placeholder="Group Name"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && renameGroupDraft.trim() && !renameGroupBusy) {
                      event.preventDefault();
                      void handleRenameGroupSubmit();
                    }
                  }}
                />
              </div>
            </div>
          )}

          {chatView === "new-message" && (
            <div className="chat-new-message">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => {
                    if (contactView === "edit") {
                      if (contactEditDraft.isProfile) {
                        handleReturnToProfileCard();
                      } else {
                        handleCancelContactEdit();
                      }
                      return;
                    }
                    if (contactView === "detail") {
                      if (contactReturnView === "group-members") {
                        handleBackToContactsList();
                        return;
                      }
                      if (activeContactId === "profile") {
                        setChatView("threads");
                        setContactView("list");
                        setActiveContactId(null);
                        setContactDetailOverride(null);
                        setContactReturnView("new-message");
                        setDmSearch("");
                      } else {
                        handleBackToContactsList();
                      }
                      return;
                    }
                    setChatView("threads");
                    setContactView("list");
                    setActiveContactId(null);
                    setContactDetailOverride(null);
                    setContactReturnView("new-message");
                    setDmSearch("");
                  }}
                  aria-label={contactView === "edit" ? (contactEditDraft.isProfile ? "Back to profile" : "Cancel") : contactView === "detail" ? (contactReturnView === "group-members" ? "Back to members" : activeContactId === "profile" ? "Back to chats" : "Back to contacts") : "Back to chats"}
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">
                  {contactView === "edit"
                    ? contactEditDraft.isProfile
                      ? "Edit My Card"
                      : contactEditDraft.id
                        ? "Edit Contact"
                        : "New Contact"
                    : contactView === "detail"
                      ? activeContactId === "profile"
                        ? "My Profile"
                        : "Contact"
                      : "New Message"}
                </div>
                {contactView === "list" ? (
                  <button
                    type="button"
                    className="glass-icon-button glass-icon-button--accent pressable"
                    onClick={handleStartAddContact}
                    title="Add contact"
                    aria-label="Add contact"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                ) : contactView === "detail" ? (
                  activeContactId === "profile" ? (
                    <button
                      className="glass-icon-button glass-icon-button--accent pressable"
                      onClick={handleStartEditCurrentContact}
                      aria-label="Edit profile"
                      title="Edit profile"
                    >
                      <PencilIcon className="h-4 w-4" />
                    </button>
                  ) : detailCanAddContact ? (
                    <button
                      type="button"
                      className="contact-pill contact-pill--accent contact-pill--compact pressable"
                      onClick={handleStartEditCurrentContact}
                    >
                      Add contact
                    </button>
                  ) : detailIsNostrContact ? (
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
                      title="Edit contact"
                    >
                      <PencilIcon className="h-4 w-4" />
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="glass-icon-button glass-icon-button--accent pressable"
                    aria-label={contactEditDraft.isProfile ? "Save profile" : "Save contact"}
                    onClick={() => {
                      void handleContactEditSubmit();
                    }}
                    disabled={contactsPublishState === "publishing" || profileStatus === "publishing" || profilePhotoBusy}
                  >
                    <CheckIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
              {contactView === "list" && (
                <>
                  <div className="chat-page__search">
                    <div className="chat-page__search-shell">
                      <input
                        className="chat-page__search-input"
                        placeholder="Search contacts"
                        value={dmSearch}
                        onChange={(event) => setDmSearch(event.target.value)}
                      />
                      {dmSearch.length > 0 && (
                        <button
                          type="button"
                          className="chat-page__search-clear pressable"
                          aria-label="Clear search"
                          title="Clear search"
                          onClick={() => setDmSearch("")}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18" />
                            <path d="m6 6 12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="chat-new-message__list">
                    <div className="chat-new-message__actions">
                      <button
                        type="button"
                        className="chat-new-message__action pressable"
                        onClick={() => {
                          setScannerMessage("");
                          setShowScanner(true);
                        }}
                      >
                        <span className="chat-new-message__action-icon" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="5" height="5" rx="1" /><rect x="16" y="3" width="5" height="5" rx="1" /><rect x="3" y="16" width="5" height="5" rx="1" /><path d="M10 4h2" /><path d="M10 8h4" /><path d="M4 10v2" /><path d="M8 10v4" /><path d="M10 10h2" /><path d="M14 10v2" /><path d="M16 10h2" /><path d="M20 10v4" /><path d="M10 14h4" /><path d="M16 14h2" /><path d="M10 18v2" /><path d="M14 16v5" /><path d="M18 18h3" /></svg>
                        </span>
                        <span className="chat-new-message__action-copy">
                          <span className="chat-new-message__action-title">Scan QR</span>
                          <span className="chat-new-message__action-subtitle">Add a contact or start a chat from a code</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="chat-new-message__action pressable"
                        onClick={() => {
                          setGroupSelectMembers(new Set());
                          setGroupNameDraft("");
                          setChatView("new-group-select");
                        }}
                      >
                        <span className="chat-new-message__action-icon" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="7" r="4" /><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="16" y1="11" x2="22" y2="11" /></svg>
                        </span>
                        <span className="chat-new-message__action-copy">
                          <span className="chat-new-message__action-title">New Group</span>
                          <span className="chat-new-message__action-subtitle">Create a private group chat</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="chat-new-message__action pressable"
                        onClick={handleStartAddContact}
                      >
                        <span className="chat-new-message__action-icon" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                        </span>
                        <span className="chat-new-message__action-copy">
                          <span className="chat-new-message__action-title">Add contact</span>
                          <span className="chat-new-message__action-subtitle">Create a contact card manually</span>
                        </span>
                      </button>
                    </div>
                    <div className="chat-new-message__section-label">Contacts</div>
                    <button
                      type="button"
                      className="contact-row contact-row--profile pressable"
                      onClick={() => {
                        const normalized = normalizeNostrPubkey(myCardNpub);
                        const hex = normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                        if (hex) {
                          openConversationForPeer(hex);
                        } else {
                          setContactReturnView("new-message");
                          setActiveContactId("profile");
                          setContactDetailOverride(null);
                          setContactView("detail");
                        }
                      }}
                    >
                      <div className={`contact-avatar${profileCard.picture?.trim() ? " contact-avatar--image" : ""}`}>
                        {profileCard.picture?.trim() ? (
                          <img src={profileCard.picture.trim()} alt={myCardName} className="contact-avatar__img" />
                        ) : (
                          contactInitials(myCardName)
                        )}
                      </div>
                      <div className="contact-row__text">
                        <div className="contact-row__name">{myCardName}</div>
                        {myCardSubtitle && (
                          <div className="contact-row__meta">
                            <span className="contact-row__meta-text">{myCardSubtitle}</span>
                          </div>
                        )}
                      </div>
                      <span className="contact-row__chevron">&rsaquo;</span>
                    </button>
                    {sortedContacts
                      .filter((c) => {
                        if (!dmSearch.trim()) return true;
                        const hay = `${c.name} ${c.displayName || ""} ${c.username || ""} ${c.npub} ${c.nip05 || ""}`.toLowerCase();
                        return hay.includes(dmSearch.trim().toLowerCase());
                      })
                      .map((contact) => {
                        const contactLabel = contactDisplayLabel(contact);
                        const photo = contact.picture?.trim();
                        const subtitle = contact.nip05 || contact.npub || contact.address || "";
                        return (
                          <button
                            key={contact.id}
                            className="contact-row pressable"
                            onClick={() => {
                              const normalized = normalizeNostrPubkey(contact.npub || "");
                              const hex = normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                              if (hex && openConversationForPeer(hex)) {
                                return;
                              }
                              setContactReturnView("new-message");
                              setActiveContactId(contact.id);
                              setContactDetailOverride(null);
                              setContactView("detail");
                            }}
                          >
                            <div className={`contact-avatar${photo ? " contact-avatar--image" : ""}`}>
                              {photo ? (
                                <img src={photo} alt={contactLabel} className="contact-avatar__img" />
                              ) : (
                                contactInitials(contactLabel)
                              )}
                            </div>
                            <div className="contact-row__text">
                              <div className="contact-row__name">{contactLabel}</div>
                              {subtitle && (
                                <div className="contact-row__meta">
                                  <span className="contact-row__meta-text">{truncateContactValue(subtitle, 32)}</span>
                                </div>
                              )}
                            </div>
                            <span className="contact-row__chevron">&rsaquo;</span>
                          </button>
                        );
                      })}
                    {sortedContacts.length === 0 && (
                      <div className="wallet-messages__empty text-secondary text-sm text-center" style={{ padding: "2rem 1rem" }}>
                        No contacts yet. Add one or scan a QR to start chatting.
                      </div>
                    )}
                  </div>
                </>
              )}
              {contactView !== "list" && (
                <div className="chat-new-message__list chat-new-message__list--detail">
                  <div ref={contactsPanelRef} className="contacts-shell" aria-busy={contactSyncState.status === "loading" || contactsPublishState === "publishing"}>
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
                            <div className={`contact-heading${detailTarget.picture ? "" : " contact-heading--text-only"}`}>
                              {detailTarget.picture && (
                                <img src={detailTarget.picture} alt={detailTitle} className="contact-portrait" />
                              )}
                              <div className="contact-heading__text">
                                <div className="flex items-center gap-2">
                                  <div className="contact-name-lg" title={detailTitle}>
                                    {truncateContactName(detailTitle, 34)}
                                  </div>
                                  {(() => {
                                    const detailBotHex = detailTarget.npub
                                      ? compressedToRawHex(normalizeNostrPubkey(detailTarget.npub) ?? detailTarget.npub).toLowerCase()
                                      : "";
                                    return detailBotHex && loadCachedBotCommands(detailBotHex) ? (
                                      <span className="contact-bot-badge" title="This peer has published a bot commands list">BOT</span>
                                    ) : null;
                                  })()}
                                  {activeContactId === "profile" && profileCard.npub && (
                                    <button
                                      type="button"
                                      className="contact-pill contact-pill--circle pressable"
                                      title="Share your npub"
                                      onClick={() => {
                                        setShareContactSource({ ...profileCard, relays: defaultNostrRelays } as Contact);
                                        setShareContactStatus(null);
                                        setShareContactPickerMode("recipient");
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

                        {activeContact && detailCanShare && (
                          <div className="contact-actions-row contact-actions-row--top contact-actions-row--wide">
                            {detailCanShare && (
                              <button
                                type="button"
                                className="contact-pill contact-pill--circle pressable"
                                title="Share contact"
                                onClick={() => {
                                  setShareContactSource(activeContact);
                                  setShareContactStatus(null);
                                  setShareContactPickerMode("recipient");
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
                          onClick={handleBackToContactsList}
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
                </div>
              )}
            </div>
          )}

          {/* ── New Group: Member Selection ──────────────────────────────── */}
          {chatView === "new-group-select" && (
            <div className="chat-new-message">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => {
                    setChatView("new-message");
                    setGroupSelectMembers(new Set());
                  }}
                  aria-label="Back"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">
                  New Group ({groupSelectMembers.size}/{MAX_GROUP_MEMBERS})
                </div>
                <button
                  type="button"
                  className={`chat-page__header-action-text pressable${groupSelectMembers.size < 2 ? " chat-page__header-action-text--disabled" : ""}`}
                  disabled={groupSelectMembers.size < 2}
                  onClick={() => {
                    if (groupSelectMembers.size >= 2) {
                      setChatView("new-group-name");
                    }
                  }}
                >
                  Next
                </button>
              </div>
              <div className="chat-page__search">
                <div className="chat-page__search-shell">
                  <input
                    className="chat-page__search-input"
                    placeholder="Who would you like to add?"
                    value={dmSearch}
                    onChange={(event) => setDmSearch(event.target.value)}
                  />
                  {dmSearch.length > 0 && (
                    <button
                      type="button"
                      className="chat-page__search-clear pressable"
                      aria-label="Clear search"
                      onClick={() => setDmSearch("")}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <div className="chat-new-message__list">
                {(() => {
                  const ownHex = (nostrIdentityRef.current?.pubkey || "").toLowerCase();
                  // Group contacts by first letter
                  const filteredContacts = sortedContacts.filter((c) => {
                    const hex = (() => {
                      const normalized = normalizeNostrPubkey(c.npub || "");
                      return normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                    })();
                    // Skip self
                    if (hex === ownHex) return false;
                    // Must have a valid nostr pubkey
                    if (!hex) return false;
                    if (!dmSearch.trim()) return true;
                    const hay = `${c.name} ${c.displayName || ""} ${c.username || ""} ${c.npub} ${c.nip05 || ""}`.toLowerCase();
                    return hay.includes(dmSearch.trim().toLowerCase());
                  });
                  // Group by first letter
                  const groups = new Map<string, typeof filteredContacts>();
                  filteredContacts.forEach((c) => {
                    const label = contactDisplayLabel(c);
                    const letter = (label[0] || "#").toUpperCase();
                    const group = groups.get(letter) || [];
                    group.push(c);
                    groups.set(letter, group);
                  });
                  const sortedLetters = [...groups.keys()].sort();
                  return sortedLetters.map((letter) => (
                    <React.Fragment key={letter}>
                      <div className="chat-new-message__section-label">{letter}</div>
                      {groups.get(letter)!.map((contact) => {
                        const contactLabel = contactDisplayLabel(contact);
                        const photo = contact.picture?.trim();
                        const normalized = normalizeNostrPubkey(contact.npub || "");
                        const hex = normalized ? compressedToRawHex(normalized).toLowerCase() : "";
                        const subtitle = contact.nip05 || (hex ? `${nip19.npubEncode(hex).slice(0, 12)}...${nip19.npubEncode(hex).slice(-6)}` : "");
                        const isSelected = hex ? groupSelectMembers.has(hex) : false;
                        return (
                          <button
                            key={contact.id}
                            className={`contact-row contact-row--selectable pressable${isSelected ? " contact-row--selected" : ""}`}
                            onClick={() => {
                              if (!hex) return;
                              setGroupSelectMembers((prev) => {
                                const next = new Set(prev);
                                if (next.has(hex)) {
                                  next.delete(hex);
                                } else if (next.size < MAX_GROUP_MEMBERS - 1) {
                                  // -1 because self is always included
                                  next.add(hex);
                                }
                                return next;
                              });
                            }}
                          >
                            <div className={`contact-avatar${photo ? " contact-avatar--image" : ""}`}>
                              {photo ? (
                                <img src={photo} alt={contactLabel} className="contact-avatar__img" />
                              ) : (
                                contactInitials(contactLabel)
                              )}
                            </div>
                            <div className="contact-row__text">
                              <div className="contact-row__name">{contactLabel}</div>
                              {subtitle && (
                                <div className="contact-row__meta">
                                  <span className="contact-row__meta-text">{truncateContactValue(subtitle, 32)}</span>
                                </div>
                              )}
                            </div>
                            <div className={`contact-row__checkbox${isSelected ? " contact-row__checkbox--checked" : ""}`}>
                              {isSelected && (
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </React.Fragment>
                  ));
                })()}
                {sortedContacts.length === 0 && (
                  <div className="wallet-messages__empty text-secondary text-sm text-center" style={{ padding: "2rem 1rem" }}>
                    No contacts yet. Add contacts first to create a group.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── New Group: Name & Create ─────────────────────────────────── */}
          {chatView === "new-group-name" && (
            <div className="chat-new-message">
              <div className="chat-page__header chat-page__header--safe-area">
                <button
                  className="glass-icon-button pressable"
                  onClick={() => setChatView("new-group-select")}
                  aria-label="Back"
                >
                  <BackIcon className="h-5 w-5" />
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">
                  New Group ({groupSelectMembers.size + 1})
                </div>
                <button
                  type="button"
                  className={`chat-page__header-action-text pressable${!groupNameDraft.trim() ? " chat-page__header-action-text--disabled" : ""}`}
                  disabled={!groupNameDraft.trim()}
                  onClick={() => {
                    const name = groupNameDraft.trim();
                    if (!name) return;
                    const ownHex = (nostrIdentityRef.current?.pubkey || "").toLowerCase();
                    const allMembers = [...new Set([ownHex, ...groupSelectMembers])].filter(Boolean).sort();
                    const groupId = generateGroupId(allMembers);
                    const createdAt = Math.floor(Date.now() / 1000);
                    const group: GroupChat = {
                      groupId,
                      name,
                      members: allMembers,
                      createdAt,
                      nameUpdatedAt: createdAt,
                    };
                    upsertGroupChat(group);
                    // Open the group conversation
                    openConversationForGroup(groupId);
                    setGroupSelectMembers(new Set());
                    setGroupNameDraft("");
                    setDmSearch("");
                  }}
                >
                  Create
                </button>
              </div>
              <div className="chat-new-group__form">
                <div className="chat-new-group__name-section">
                  <label className="chat-new-group__label">Group Name</label>
                  <input
                    className="chat-new-group__name-input"
                    placeholder="Please Enter a Group Name"
                    value={groupNameDraft}
                    onChange={(e) => setGroupNameDraft(e.target.value)}
                    maxLength={100}
                    autoFocus
                  />
                </div>
                <div className="chat-new-group__members-section">
                  <label className="chat-new-group__label">Members</label>
                  {(() => {
                    const ownHex = (nostrIdentityRef.current?.pubkey || "").toLowerCase();
                    const memberHexes = [ownHex, ...Array.from(groupSelectMembers)].filter(Boolean);
                    return memberHexes.map((hex) => {
                      const isOwn = hex === ownHex;
                      const meta = isOwn
                        ? { label: myCardName, picture: profileCard.picture?.trim() || undefined }
                        : peerLabelFor(hex);
                      const npubShort = (() => {
                        try {
                          const full = nip19.npubEncode(hex);
                          return `${full.slice(0, 12)}...${full.slice(-6)}`;
                        } catch { return ""; }
                      })();
                      return (
                        <div key={hex} className="contact-row">
                          <div className={`contact-avatar${meta.picture ? " contact-avatar--image" : ""}`}>
                            {meta.picture ? (
                              <img src={meta.picture} alt={meta.label} className="contact-avatar__img" />
                            ) : (
                              contactInitials(meta.label)
                            )}
                          </div>
                          <div className="contact-row__text">
                            <div className="contact-row__name">{meta.label}</div>
                            {npubShort && (
                              <div className="contact-row__meta">
                                <span className="contact-row__meta-text">{npubShort}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>
          )}

        </div>
      )}
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

      <ActionSheet
        open={shareContactPickerOpen}
        onClose={() => {
          if (shareContactBusy) return;
          setShareContactPickerOpen(false);
          setShareContactPickerMode("recipient");
          setShareContactSource(null);
          setShareContactStatus(null);
        }}
        title="Send contact"
        stackLevel={90}
      >
        {shareContactPickerMode === "chat-source" ? (
          <>
            <div className="text-sm text-secondary mb-2">Choose a contact card to send into this conversation.</div>
            {shareContactStatus && <div className="text-sm text-rose-400 mb-2">{shareContactStatus}</div>}
            {chatAttachContactOptions.length ? (
              <div className="space-y-2">
                {chatAttachContactOptions.map((contact) => {
                  const label = contactPrimaryName(contact);
                  const subtitle = formatContactNpub(contact.npub) || formatContactUsername(contact.username);
                  const picture = contact.picture?.trim();
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      className="contact-row pressable"
                      disabled={shareContactBusy}
                      onClick={() => {
                        void handleSendChatContactAttachment(contact);
                      }}
                    >
                      <div className={`contact-avatar${picture ? " contact-avatar--image" : ""}`}>
                        {picture ? (
                          <img src={picture} alt={label} className="contact-avatar__img" />
                        ) : (
                          contactInitials(label)
                        )}
                      </div>
                      <div className="contact-row__text">
                        <div className="contact-row__name">{label}</div>
                        {subtitle ? (
                          <div className="contact-row__meta">
                            <span className="contact-row__meta-text">{truncateContactValue(subtitle, 32)}</span>
                          </div>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-secondary">Add a contact with a valid npub first.</div>
            )}
          </>
        ) : (
          <>
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
          </>
        )}
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            className="ghost-button button-sm pressable flex-1 justify-center"
            onClick={() => {
              if (shareContactBusy) return;
              setShareContactPickerOpen(false);
              setShareContactPickerMode("recipient");
              setShareContactSource(null);
              setShareContactStatus(null);
            }}
            disabled={shareContactBusy}
          >
            Cancel
          </button>
        </div>
      </ActionSheet>

      {/* ── Message action overlay (long-press menu) ── */}
      {dmMessageActions && (
        <div
          className="dm-action-overlay"
          onPointerDown={(e) => { if (e.target === e.currentTarget) setDmMessageActions(null); }}
        >
          <div className="dm-action-panel">
            <div className="dm-action-panel__reactions">
              {["❤️", "👍", "👎", "😂", "😮", "😢"].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="dm-action-panel__reaction pressable"
                  onClick={() => { void handleSendReaction(dmMessageActions.msg, emoji); setDmMessageActions(null); }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="dm-action-panel__list">
              {dmMessageActions.msg.attachment?.type === "task" && dmMessageActions.msg.attachment.task && (
                <button type="button" className="dm-action-panel__item pressable" onClick={() => {
                  const message = dmMessageActions.msg;
                  const senderPubkey = message.senderPubkey || (message.isIncoming ? message.peerPubkey : nostrIdentityRef.current?.pubkey);
                  onAddTaskAgain(message.attachment.task, senderPubkey ? { pubkey: senderPubkey } : undefined);
                  setDmMessageActions(null);
                }}>
                  <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3M11 14h7M14.5 10.5v7"/></svg>
                  Add again
                </button>
              )}
              <button
                type="button"
                className="dm-action-panel__item pressable"
                onClick={() => { setReplyToMessage(dmMessageActions.msg); setDmMessageActions(null); }}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>
                Reply
              </button>
              <button
                type="button"
                className="dm-action-panel__item pressable"
                onClick={() => { setDmForwardMessage(dmMessageActions.msg); setDmMessageActions(null); }}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>
                Forward
              </button>
              <button
                type="button"
                className="dm-action-panel__item pressable"
                onClick={() => { void copyMessageValue(dmMessageActions.copyValue, "Message"); setDmMessageActions(null); }}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                Copy
              </button>
              <button
                type="button"
                className="dm-action-panel__item pressable"
                onClick={() => { setDmInfoMessage(dmMessageActions.msg); setDmMessageActions(null); }}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                Info
              </button>
              <button
                type="button"
                className="dm-action-panel__item dm-action-panel__item--danger pressable"
                onClick={() => handleDeleteDmMessage(dmMessageActions.eventId)}
              >
                <svg className="dm-action-panel__item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reaction detail sheet ── */}
      {dmReactionDetail && (() => {
        const reactions = dmReactions.get(dmReactionDetail.eventId) || [];
        const grouped = new Map<string, DmReaction[]>();
        for (const r of reactions) {
          const arr = grouped.get(r.emoji) || [];
          arr.push(r);
          grouped.set(r.emoji, arr);
        }
        return (
          <div
            className="dm-action-overlay"
            onPointerDown={(e) => { if (e.target === e.currentTarget) setDmReactionDetail(null); }}
          >
            <div className="dm-info-panel">
              <div className="dm-info-panel__header">
                <span className="dm-info-panel__title">Reactions</span>
                <button type="button" className="dm-info-panel__close pressable" onClick={() => setDmReactionDetail(null)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              {Array.from(grouped.entries()).map(([emoji, reactors]) => (
                <div key={emoji} className="dm-reaction-detail__group">
                  <div className="dm-reaction-detail__emoji">{emoji}</div>
                  <div className="dm-reaction-detail__reactors">
                    {reactors.map((r) => {
                      const rp = dmPeerProfilesRef.current.get(r.senderPubkey);
                      const label = rp?.displayName || rp?.name || r.senderPubkey.slice(0, 12) + "…";
                      return (
                        <div key={r.senderPubkey} className="dm-reaction-detail__reactor">
                          <div className="dm-reaction-detail__reactor-avatar">
                            {rp?.picture
                              ? <img src={rp.picture} alt={label} className="contact-avatar__img" />
                              : contactInitials(label)}
                          </div>
                          <span className="dm-reaction-detail__reactor-name">{label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Info modal ── */}
      {dmInfoMessage && (
        <div
          className="dm-action-overlay"
          onPointerDown={(e) => { if (e.target === e.currentTarget) setDmInfoMessage(null); }}
        >
          <div className="dm-info-panel">
            <div className="dm-info-panel__header">
              <span className="dm-info-panel__title">Message Info</span>
              <button type="button" className="dm-info-panel__close pressable" onClick={() => setDmInfoMessage(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="dm-info-panel__row">
              <span className="dm-info-panel__label">Time</span>
              <span className="dm-info-panel__value">{new Date(dmInfoMessage.createdAt * 1000).toLocaleString()}</span>
            </div>
            <div className="dm-info-panel__row">
              <span className="dm-info-panel__label">Direction</span>
              <span className="dm-info-panel__value">{dmInfoMessage.isIncoming ? "Received" : "Sent"}</span>
            </div>
            <div className="dm-info-panel__row">
              <span className="dm-info-panel__label">Event ID</span>
              <button
                type="button"
                className="dm-info-panel__value dm-info-panel__value--mono dm-info-panel__value--tap pressable"
                onClick={() => void navigator.clipboard.writeText(dmInfoMessage.eventId)}
                title="Tap to copy"
              >
                {dmInfoMessage.eventId.slice(0, 20)}…
              </button>
            </div>
            {dmInfoMessage.senderPubkey && (
              <div className="dm-info-panel__row">
                <span className="dm-info-panel__label">Sender</span>
                <button
                  type="button"
                  className="dm-info-panel__value dm-info-panel__value--mono dm-info-panel__value--tap pressable"
                  onClick={() => void navigator.clipboard.writeText(dmInfoMessage.senderPubkey!)}
                  title="Tap to copy"
                >
                  {dmInfoMessage.senderPubkey.slice(0, 20)}…
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Forward modal ── */}
      {dmForwardMessage && (
        <div
          className="dm-action-overlay"
          onPointerDown={(e) => { if (e.target === e.currentTarget) setDmForwardMessage(null); }}
        >
          <div className="dm-forward-panel">
            <div className="dm-forward-panel__header">
              <span className="dm-forward-panel__title">Forward to</span>
              <button type="button" className="dm-info-panel__close pressable" onClick={() => setDmForwardMessage(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="dm-forward-panel__preview">
              {dmForwardMessage.content.length > 60 ? dmForwardMessage.content.slice(0, 60) + "…" : dmForwardMessage.content}
            </div>
            <div className="dm-forward-panel__list">
              {dmThreads.filter((t) => t.peerPubkey !== dmForwardMessage.peerPubkey).map((thread) => {
                const profile = dmPeerProfilesRef.current.get(thread.peerPubkey);
                const label = profile?.displayName || profile?.name || thread.peerPubkey.slice(0, 12) + "…";
                return (
                  <button
                    key={thread.peerPubkey}
                    type="button"
                    className="dm-forward-panel__thread pressable"
                    onClick={() => { void handleForwardMessage(dmForwardMessage, thread.peerPubkey); setDmForwardMessage(null); }}
                  >
                    <div className="dm-forward-panel__thread-avatar">
                      {profile?.picture
                        ? <img src={profile.picture} alt={label} className="contact-avatar__img" />
                        : contactInitials(label)}
                    </div>
                    <span className="dm-forward-panel__thread-name">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
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
            <div className="text-xs text-center text-secondary">
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
                scannedContactCanShare && (
                <div className="contact-actions-row contact-actions-row--top contact-actions-row--wide">
                  {scannedContactCanShare && (
                    <button
                      type="button"
                      className="contact-pill contact-pill--circle pressable"
                      title="Share contact"
                      onClick={() => {
                        setShareContactSource(scannedContact);
                        setShareContactStatus(null);
                        setShareContactPickerMode("recipient");
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
          open={!!sharedContactPreview}
          onClose={() => setSharedContactPreview(null)}
          header={sharedContactPreviewHeader}
          stackLevel={76}
        >
          {sharedContactPreviewContact && (
            <div className="contact-detail-view">
              <div className="contact-hero">
                <div className="contact-hero__center">
                  <div className="contact-qr-wrapper">
                    {sharedContactPreviewShareValue ? (
                      <QrCodeCard
                        className="contact-qr-card"
                        value={sharedContactPreviewShareValue}
                        label={sharedContactPreviewTitle}
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
                    className={`contact-heading${sharedContactPreviewContact.picture ? "" : " contact-heading--text-only"}`}
                  >
                    {sharedContactPreviewContact.picture && (
                      <img
                        src={sharedContactPreviewContact.picture}
                        alt={sharedContactPreviewTitle}
                        className="contact-portrait"
                      />
                    )}
                    <div className="contact-heading__text">
                      <div className="contact-name-lg" title={sharedContactPreviewTitle}>
                        {truncateContactName(sharedContactPreviewTitle, 34)}
                      </div>
                      {sharedContactPreviewUsername && (
                        <div className="contact-username" title={sharedContactPreviewUsername}>
                          {truncateContactValue(sharedContactPreviewUsername, 33)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {sharedContactPreviewCanShare && (
                <div className="contact-actions-row contact-actions-row--top contact-actions-row--wide">
                  {sharedContactPreviewCanShare && (
                    <button
                      type="button"
                      className="contact-pill contact-pill--circle pressable"
                      title="Share contact"
                      onClick={() => {
                        setShareContactSource(sharedContactPreviewContact);
                        setShareContactStatus(null);
                        setShareContactPickerMode("recipient");
                        setShareContactPickerOpen(true);
                      }}
                    >
                      <ShareArrowIcon className="contact-pill__icon" />
                    </button>
                  )}
                </div>
              )}

              <div className="contact-fields">
                {sharedContactPreviewFields.length ? (
                  sharedContactPreviewFields.map((field) => {
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
                          {isNip05Field && sharedContactPreviewNip05Verified && (
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
    </div>
  );
}
