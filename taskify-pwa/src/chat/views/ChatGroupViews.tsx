import React from "react";
import { nip19 } from "nostr-tools";
import type { GroupChat } from "../../lib/groupChatState";
import { normalizeNostrPubkey } from "../../lib/nostr";
import { contactDisplayLabel } from "../../lib/contacts";
import { generateGroupId, MAX_GROUP_MEMBERS, type WalletDmAttachment, type WalletDmMessage } from "../hooks/useDmState";
import { BackIcon, GroupAvatar, MessengerFileBubble } from "../chatUi";
import { useChatRuntime } from "../ChatRuntime";

export function ChatGroupInfoView() {
  const {
    activeGroupAvatarMembers,
    activeGroupChat,
    activeGroupLeft,
    activeGroupMembers,
    activeGroupMuted,
    activeThread,
    chatView,
    contactInitials,
    groupInfoTab,
    handleToggleActiveGroupMembership,
    handleToggleActiveGroupMute,
    openGroupNameEditor,
    setActiveContactId,
    setChatView,
    setContactDetailOverride,
    setContactReturnView,
    setContactView,
    setDmSearch,
    setGroupInfoTab,
    setGroupMembersSearch,
  } = useChatRuntime();
  return (
    <>
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
    </>
  );
}

export function ChatGroupMembersView() {
  const {
    activeGroupChat,
    activeGroupMembers,
    activeThread,
    chatView,
    contactInitials,
    filteredActiveGroupMembers,
    groupMembersSearch,
    openGroupMemberDetail,
    setChatView,
    setGroupMembersSearch,
    truncateContactValue,
  } = useChatRuntime();
  return (
    <>
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
    </>
  );
}

export function ChatGroupNameView() {
  const {
    activeGroupChat,
    activeThread,
    chatView,
    handleRenameGroupSubmit,
    renameGroupBusy,
    renameGroupDraft,
    setChatView,
    setRenameGroupDraft,
  } = useChatRuntime();
  return (
    <>
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
    </>
  );
}

export function ChatNewGroupMembersView() {
  const {
    chatView,
    compressedToRawHex,
    contactInitials,
    dmSearch,
    groupSelectMembers,
    nostrIdentityRef,
    setChatView,
    setDmSearch,
    setGroupSelectMembers,
    sortedContacts,
    truncateContactValue,
  } = useChatRuntime();
  return (
    <>
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
    </>
  );
}

export function ChatNewGroupNameView() {
  const {
    chatView,
    contactInitials,
    groupNameDraft,
    groupSelectMembers,
    myCardName,
    nostrIdentityRef,
    openConversationForGroup,
    peerLabelFor,
    profileCard,
    setChatView,
    setDmSearch,
    setGroupNameDraft,
    setGroupSelectMembers,
    upsertGroupChat,
  } = useChatRuntime();
  return (
    <>
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
    </>
  );
}
