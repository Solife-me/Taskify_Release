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


import { normalizeNostrPubkey } from "../lib/nostr";








import { ActionSheet } from "../components/ActionSheet";
import type { Contact } from "../lib/contacts";
import {
  contactDisplayLabel,
  contactPrimaryName,
  formatContactNpub,
  formatContactUsername,
  sanitizeUsername,
} from "../lib/contacts";




import { type DmReaction } from "./hooks/useDmState";
import {
  loadCachedBotCommands,
} from "../lib/botCommands";


import {
  BackIcon,
  CheckIcon,
  PencilIcon,
  QrCodeCard,
  QrScanner,
  ShareArrowIcon,
  VerifiedBadgeIcon,
} from "./chatUi";





import { useChatRuntime } from "./ChatRuntime";
import { ChatThreadsView } from "./views/ChatThreadsView";
import { ChatConversationView } from "./views/ChatConversationView";
import { ChatGroupInfoView, ChatGroupMembersView, ChatGroupNameView, ChatNewGroupMembersView, ChatNewGroupNameView } from "./views/ChatGroupViews";

export default function ChatPage() {
  const {
    activeContact,
    activeContactId,
    chatAttachContactOptions,
    chatView,
    closeScanner,
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
    dmForwardMessage,
    dmInfoMessage,
    dmMessageActions,
    dmPeerProfilesRef,
    dmReactionDetail,
    dmReactions,
    dmSearch,
    dmThreads,
    handleBackToContactsList,
    handleCancelContactEdit,
    handleClearProfilePhoto,
    handleContactEditSubmit,
    handleContactImportAction,
    handleCopyContactField,
    handleDeleteContact,
    handleDeleteDmMessage,
    handleForwardMessage,
    handleImportPublicFollow,
    handlePasteFromClipboard,
    handleProfilePhotoChange,
    handleReturnToProfileCard,
    handleScannerDetected,
    handleScannerError,
    handleSendReaction,
    handleShareContactToContact,
    handleStartAddContact,
    handleStartEditCurrentContact,
    handleToggleFollowDetailContact,
    isChatPage,
    loadProfileMetadata,
    myCardName,
    myCardNpub,
    myCardSubtitle,
    nostrIdentityRef,
    onAddTaskAgain,
    openConversationForPeer,
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
    publishProfileMetadata,
    scannedContact,
    scannedContactCanShare,
    scannedContactFields,
    scannedContactHeader,
    scannedContactNip05Verified,
    scannedContactShareValue,
    scannedContactTitle,
    scannedContactUsername,
    scannerMessage,
    setActiveContactId,
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
    setGroupNameDraft,
    setGroupSelectMembers,
    setProfileEditorOpen,
    setProfileForm,
    setProfilePhotoError,
    setPublicFollowPickerOpen,
    setReplyToMessage,
    setScannedContact,
    setScannerMessage,
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
    truncateContactName,
    truncateContactValue,
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
          <ChatConversationView />

          <ChatGroupInfoView />

          <ChatGroupMembersView />

          <ChatGroupNameView />

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
          <ChatNewGroupMembersView />

          <ChatNewGroupNameView />

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
