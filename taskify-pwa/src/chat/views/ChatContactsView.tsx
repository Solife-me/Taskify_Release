import { normalizeNostrPubkey } from "../../lib/nostr";
import type { Contact } from "../../lib/contacts";
import {
  contactDisplayLabel,
  sanitizeUsername,
} from "../../lib/contacts";
import { loadCachedBotCommands } from "../../lib/botCommands";
import {
  BackIcon,
  CheckIcon,
  PencilIcon,
  QrCodeCard,
  ShareArrowIcon,
  VerifiedBadgeIcon,
} from "../chatUi";
import { useChatRuntime } from "../ChatRuntime";

export function ChatContactsView() {
  const {
    activeContact,
    activeContactId,
    chatView,
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
    contactsPanelRef,
    contactsPublishState,
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
    dmSearch,
    handleBackToContactsList,
    handleCancelContactEdit,
    handleClearProfilePhoto,
    handleContactEditSubmit,
    handleContactImportAction,
    handleCopyContactField,
    handleDeleteContact,
    handleProfilePhotoChange,
    handleReturnToProfileCard,
    handleStartAddContact,
    handleStartEditCurrentContact,
    handleToggleFollowDetailContact,
    myCardName,
    myCardNpub,
    myCardSubtitle,
    openConversationForPeer,
    profileCard,
    profilePhotoBusy,
    profilePhotoError,
    profilePhotoInputRef,
    profileStatus,
    publicFollowOptions,
    setActiveContactId,
    setChatView,
    setContactDetailOverride,
    setContactEditDraft,
    setContactLookupInput,
    setContactReturnView,
    setContactView,
    setDmSearch,
    setGroupNameDraft,
    setGroupSelectMembers,
    setProfilePhotoError,
    setPublicFollowPickerOpen,
    setScannerMessage,
    setShareContactPickerMode,
    setShareContactPickerOpen,
    setShareContactSource,
    setShareContactStatus,
    setShowCustomContactFields,
    setShowScanner,
    showCustomContactFields,
    sortedContacts,
    truncateContactName,
    truncateContactValue,
  } = useChatRuntime();

  return (
    <>
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
    </>
  );
}
