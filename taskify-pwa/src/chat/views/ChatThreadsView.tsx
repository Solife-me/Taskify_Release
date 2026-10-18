import React from "react";
import { GroupAvatar, SwipeableDmThreadRow, formatShortDate } from "../chatUi";
import { useChatRuntime } from "../ChatRuntime";

export function ChatThreadsView() {
  const {
    collectUnreadThreadItemEventIds, contactInitials, contactView, dmListViewRef, dmSearch,
    dmThreadListEntries, dmView, groupAvatarMembersFor, groupChats, handleArchiveDmThread,
    handleDeleteDmThread, messageSearchResults, myCardName, onMarkMessagesRead, peerLabelFor,
    profileCard, setActiveContactId, setActiveGroupId, setActiveThreadPeer, setChatView,
    setContactView, setDmSearch, setDmView, setScrollToMessageId, strangerUnreadCount,
    threadUnreadMap,
  } = useChatRuntime();
  return (
            <div className="chat-page__threads">
              {/* Header */}
              <div className={`chat-page__header chat-page__header--safe-area${contactView !== "list" ? " chat-page__header--compact" : ""}`}>
                <button
                  type="button"
                  className={`contact-avatar pressable${profileCard.picture?.trim() ? " contact-avatar--image contact-avatar--profile" : " contact-avatar--profile"}`}
                  onClick={() => {
                    setActiveContactId("profile");
                    setContactView("detail");
                    setChatView("new-message");
                  }}
                  aria-label="Open profile"
                >
                  {profileCard.picture?.trim() ? (
                    <img src={profileCard.picture.trim()} alt={myCardName} className="contact-avatar__img" />
                  ) : (
                    contactInitials(myCardName)
                  )}
                </button>
                <div className="chat-page__header-title chat-page__header-title--centered">Chat</div>
                <button
                  type="button"
                  className="glass-icon-button glass-icon-button--accent pressable"
                  onClick={() => setChatView("new-message")}
                  title="New message"
                  aria-label="New message"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </div>

              {/* Search */}
              <div className="chat-page__search">
                <div className="chat-page__search-shell">
                  <input
                    className="chat-page__search-input"
                    placeholder="Search"
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
		              {/* Thread list */}
		              <div className="chat-page__thread-list">
		                {dmView === "strangers" && !dmSearch.trim() && (
		                  <button
		                    className="wallet-messages__thread pressable"
		                    onClick={() => {
		                      dmListViewRef.current = "list";
		                      setDmView("list");
		                      setActiveThreadPeer(null);
		                    }}
		                  >
		                    <div className="wallet-messages__avatar wallet-messages__avatar--stranger">&larr;</div>
		                    <div className="wallet-messages__thread-body">
		                      <div className="wallet-messages__thread-title">Back to everyone</div>
		                      <div className="wallet-messages__thread-preview">View all conversations</div>
		                    </div>
		                  </button>
		                )}
		                {dmThreadListEntries.map((entry) => {
		                  if (entry.kind === "strangers") {
		                    return (
		                      <button
		                        key="strangers-group"
		                        className="wallet-messages__thread wallet-messages__thread--stranger pressable"
		                        onClick={() => {
		                          dmListViewRef.current = "strangers";
		                          setDmView("strangers");
		                          setActiveThreadPeer(null);
		                        }}
		                      >
		                        <div className="wallet-messages__avatar wallet-messages__avatar--stranger">&#9678;</div>
		                        <div className="wallet-messages__thread-body">
		                          <div className="wallet-messages__thread-title">
		                            Strangers{strangerUnreadCount > 0 ? ` (${strangerUnreadCount})` : ""}
		                          </div>
		                          <div className="wallet-messages__thread-preview">{entry.lastPreview}</div>
		                        </div>
		                        <div className="wallet-messages__thread-meta">
		                          <span className="wallet-messages__thread-date">
		                            {formatShortDate(entry.lastCreatedAt)}
		                          </span>
		                          {strangerUnreadCount > 0 && (
		                            <span className="chat-unread-badge">{strangerUnreadCount}</span>
		                          )}
		                        </div>
		                      </button>
		                    );
		                  }
		                  const thread = entry.thread;
		                  const isGroupThread = !!thread.groupId;
		                  const groupMeta = isGroupThread ? groupChats.find((g) => g.groupId === thread.groupId) : null;
		                  const groupAvatarMembers = isGroupThread ? groupAvatarMembersFor(groupMeta, thread, groupMeta?.name || "Group") : [];
		                  const meta = isGroupThread
		                    ? { label: groupMeta?.name || "Group", picture: undefined, subtitle: `${groupMeta?.members.length || 0} members`, verifiedNip05: null }
		                    : peerLabelFor(thread.peerPubkey);
		                  const unreadCount = threadUnreadMap.get(thread.peerPubkey) || 0;
		                  return (
		                    <SwipeableDmThreadRow
		                      key={thread.peerPubkey}
		                      onArchive={() => handleArchiveDmThread(thread)}
		                      onDelete={() => handleDeleteDmThread(thread)}
		                    >
		                      <button
		                        className="wallet-messages__thread pressable"
		                        onClick={() => {
		                          dmListViewRef.current = dmView === "strangers" ? "strangers" : "list";
		                          setActiveThreadPeer(thread.peerPubkey);
		                          if (isGroupThread) setActiveGroupId(thread.groupId!);
		                          setChatView("conversation");
		                          setDmView("thread");
		                          const unreadIds = collectUnreadThreadItemEventIds(thread.messages, thread.peerPubkey);
		                          if (unreadIds.length) {
		                            onMarkMessagesRead(unreadIds);
		                          }
		                        }}
		                      >
		                        <div className={`wallet-messages__avatar${isGroupThread ? " wallet-messages__avatar--group" : ""}`}>
		                          {isGroupThread ? (
		                            <GroupAvatar members={groupAvatarMembers} />
		                          ) : meta.picture ? (
		                            <img src={meta.picture} alt={meta.label} className="wallet-messages__avatar-img" />
		                          ) : (
		                            <span>{meta.label.slice(0, 2)}</span>
		                          )}
		                        </div>
		                        <div className="wallet-messages__thread-body">
		                          <div className="wallet-messages__thread-title">
		                            {meta.label}
		                          </div>
		                          <div className="wallet-messages__thread-preview">{thread.lastPreview}</div>
		                        </div>
		                        <div className="wallet-messages__thread-meta">
		                          <span className="wallet-messages__thread-date">
		                            {formatShortDate(thread.lastCreatedAt)}
		                          </span>
		                          {unreadCount > 0 && (
		                            <span className="chat-unread-badge">{unreadCount}</span>
		                          )}
		                        </div>
		                      </button>
		                    </SwipeableDmThreadRow>
		                  );
		                })}
		                {dmThreadListEntries.length === 0 && messageSearchResults.length === 0 && (
		                  <div className="wallet-messages__empty text-secondary text-sm text-center" style={{ padding: "3rem 1rem" }}>
		                    {dmView === "strangers" && !dmSearch.trim()
		                      ? "No stranger messages yet."
		                      : "No messages yet. Start a conversation or incoming DMs will appear here."}
		                  </div>
		                )}
		                {dmSearch.trim() && messageSearchResults.length > 0 && (
		                  <>
		                    <div className="chat-page__section-label" style={{ marginTop: "0.5rem" }}>Messages</div>
		                    {messageSearchResults.map(({ thread, message }) => {
		                      const isGroupThread = !!thread.groupId;
		                      const groupMeta = isGroupThread ? groupChats.find((g) => g.groupId === thread.groupId) : null;
		                      const threadMeta = isGroupThread
		                        ? { label: groupMeta?.name || "Group", picture: undefined }
		                        : peerLabelFor(thread.peerPubkey);
		                      const q = dmSearch.trim().toLowerCase();
		                      const matchIdx = message.content.toLowerCase().indexOf(q);
		                      const previewBefore = matchIdx > 0 ? message.content.slice(Math.max(0, matchIdx - 30), matchIdx) : "";
		                      const matchText = message.content.slice(matchIdx, matchIdx + q.length);
		                      const previewAfter = message.content.slice(matchIdx + q.length, matchIdx + q.length + 60);
		                      return (
		                        <button
		                          key={`${thread.peerPubkey}-${message.eventId}`}
		                          className="wallet-messages__thread pressable"
		                          onClick={() => {
		                            dmListViewRef.current = "list";
		                            setDmSearch("");
		                            setActiveThreadPeer(thread.peerPubkey);
		                            if (isGroupThread) setActiveGroupId(thread.groupId!);
		                            setChatView("conversation");
		                            setDmView("thread");
		                            setScrollToMessageId(message.eventId);
		                          }}
		                        >
		                          <div className={`wallet-messages__avatar${isGroupThread ? " wallet-messages__avatar--group" : ""}`}>
		                            {isGroupThread ? (
		                              <GroupAvatar members={groupAvatarMembersFor(groupMeta, thread, threadMeta.label)} />
		                            ) : threadMeta.picture ? (
		                              <img src={threadMeta.picture} alt={threadMeta.label} className="wallet-messages__avatar-img" />
		                            ) : (
		                              <span>{threadMeta.label.slice(0, 2)}</span>
		                            )}
		                          </div>
		                          <div className="wallet-messages__thread-body">
		                            <div className="wallet-messages__thread-title">{threadMeta.label}</div>
		                            <div className="wallet-messages__thread-preview">
		                              {previewBefore && <span style={{ opacity: 0.7 }}>{matchIdx > 0 ? "…" : ""}{previewBefore}</span>}
		                              <mark className="chat-msg-result__mark">{matchText}</mark>
		                              {previewAfter && <span style={{ opacity: 0.7 }}>{previewAfter}{previewAfter.length === 60 ? "…" : ""}</span>}
		                            </div>
		                          </div>
		                          <div className="wallet-messages__thread-meta">
		                            <span className="wallet-messages__thread-date">{formatShortDate(message.createdAt)}</span>
		                          </div>
		                        </button>
		                      );
		                    })}
		                  </>
		                )}
		              </div>

            </div>
  );
}
