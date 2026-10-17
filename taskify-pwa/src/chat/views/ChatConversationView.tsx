// @ts-nocheck -- faithfully extracted from the legacy wallet Chat page; typing is tracked in the review.
import React from "react";
import { normalizeNostrPubkey } from "../../lib/nostr";
import {
  isAudioMime,
  isImageMime,
  isVideoMime,
} from "../../lib/messengerAttachmentCrypto";
import { sanitizeUsername } from "../../lib/contacts";
import type { WalletMessageItem } from "../../types/walletMessages";
import type { DmReaction } from "../hooks/useDmState";
import {
  BackIcon,
  CHAT_FILE_PICKER_ACCEPT,
  GroupAvatar,
  MessengerFileBubble,
  VerifiedBadgeIcon,
  formatDmDateSeparator,
  formatDmDay,
  formatDmTime,
  formatShortDate,
  parseDateLikeToUnixSeconds,
} from "../chatUi";
import {
  CHAT_TIMESTAMP_REVEAL_WIDTH,
  extractDomain,
  extractUrlsFromText,
  getCalendarInviteStatusLabel,
  getWalletMessageStatusLabel,
  renderFormattedText,
  type NostrEvent,
} from "../chatHelpers";
import { ChatTokenBubble } from "../ChatTokenBubble";
import { useChatRuntime } from "../ChatRuntime";

export function ChatConversationView() {
  const {
    activeBotCommands,
    activeGroupAvatarMembers,
    activeGroupChat,
    activeGroupLeft,
    activeThread,
    attachTrayOpen,
    buildDmCopyValue,
    cancelDmLongPress,
    chatCompose,
    chatComposeInputRef,
    chatFileInputRef,
    chatPhotoInputRef,
    chatView,
    closeAttachTray,
    compressedToRawHex,
    contactInitials,
    contacts,
    copyMessageValue,
    defaultNostrRelays,
    dmBlockedPeersRef,
    dmListViewRef,
    dmLongPressTimerRef,
    dmMessages,
    dmReactions,
    dragDirectionLocked,
    dragTouchStartX,
    dragTouchStartY,
    ensureNostrPool,
    formatCalendarInviteWhen,
    formatNpub,
    getPeerProfile,
    groupChatsRef,
    handleAddPeerToContacts,
    handleDmEvent,
    handleOpenChatContactPicker,
    handleOpenChatFilePicker,
    handleOpenChatPhotoPicker,
    handleToggleActiveGroupMembership,
    handleToggleAttachTray,
    messageItemsByEventId,
    messagesInnerRef,
    messagesScrollRef,
    myCardName,
    myCardNpub,
    onAcceptMessage,
    onCalendarInviteRsvp,
    onDeclineMessage,
    onDismissCalendarInvite,
    onDismissMessage,
    onMaybeMessage,
    openActiveGroupInfo,
    openSharedContactPreview,
    peerLabelFor,
    pendingCalendarInvitesByEventId,
    pendingMessageItemsByEventId,
    profileCard,
    publishNip17Giftwraps,
    readNostrIdentity,
    replyToMessage,
    resolveNip17Relays,
    safePublish,
    sendMessengerFileAttachments,
    setActiveContactId,
    setActiveGroupId,
    setActiveThreadPeer,
    setAttachTrayOpen,
    setChatCompose,
    setChatView,
    setContactDetailOverride,
    setContactEditDraft,
    setContactReturnView,
    setContactView,
    setDmMessageActions,
    setDmReactionDetail,
    setDmView,
    setPendingMessages,
    setReplyToMessage,
    sharedContactMetaFor,
    toggleBlockPeer,
    upsertContact,
    visiblePendingMessages,
  } = useChatRuntime();

  return (
    <>
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
    </>
  );
}
