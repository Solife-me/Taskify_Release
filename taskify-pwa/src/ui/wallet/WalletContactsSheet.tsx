// @ts-nocheck
import React from "react";
import { ActionSheet } from "../../components/ActionSheet";
import {
  QrCodeCard,
  ShareArrowIcon,
  VerifiedBadgeIcon,
} from "./walletModalUi";
import { contactDisplayLabel } from "../../lib/contacts";

export function WalletContactsSheet(props) {
  const {
    contactsPanelOpen,
    closeContactsTab,
    contactsHeader,
    contactsPanelInline,
    contactsPanelRef,
    contactSyncState,
    contactsPublishState,
    contactView,
    sortedContacts,
    profileCard,
    myCardName,
    myCardSubtitle,
    normalizeNip05,
    isNip05VerifiedFor,
    contactInitials,
    setActiveContactId,
    setContactView,
    detailTarget,
    detailShareValue,
    detailTitle,
    detailFields,
    detailNip05Verified,
    activeContact,
    activeContactId,
    detailHasLightning,
    detailCanShare,
    detailUsername,
    truncateContactName,
    truncateContactValue,
    applyLightningContact,
    setContactsTabOpen,
    openEcashSendToContact,
    setShareContactSource,
    setShareContactStatus,
    setShareContactPickerMode,
    setShareContactPickerOpen,
    defaultNostrRelays,
    handleDeleteContact,
    publicFollowOptions,
    setPublicFollowPickerOpen,
    showCustomContactFields,
    setShowCustomContactFields,
    contactEditDraft,
    setContactEditDraft,
    sanitizeUsername,
    contactLookupInput,
    setContactLookupInput,
    contactLookupBusy,
    handleContactImportAction,
    contactLookupError,
    contactEditError,
    handleProfilePhotoChange,
    handleClearProfilePhoto,
    profilePhotoBusy,
    profilePhotoError,
    profilePhotoInputRef,
    setProfilePhotoError,
    setShowScanner,
    contactSubtitle,
    handleCopyContactField,
  } = props;

  return (
    <ActionSheet
      open={contactsPanelOpen}
      onClose={closeContactsTab}
      header={contactsHeader}
      stackLevel={contactsPanelInline ? undefined : 70}
      panelClassName="sheet-panel--tall contacts-panel"
      inline={contactsPanelInline}
    >
      <div
        ref={contactsPanelRef}
        className="contacts-shell"
        aria-busy={contactSyncState.status === "loading" || contactsPublishState === "publishing"}
      >
        {contactView === "list" && (
          <div className="contacts-list-view">
            {(() => {
              const profileSubtitleIsNip05 =
                !!profileCard.nip05 &&
                !!myCardSubtitle &&
                normalizeNip05(profileCard.nip05) === normalizeNip05(myCardSubtitle);
              const profileNip05Verified =
                profileSubtitleIsNip05 &&
                isNip05VerifiedFor(profileCard.id, profileCard.nip05, profileCard.npub);
              const profilePhoto = profileCard.picture?.trim();

              return (
                <button
                  type="button"
                  className="contact-row contact-row--profile pressable"
                  onClick={() => {
                    setActiveContactId("profile");
                    setContactView("detail");
                  }}
                >
                  <div
                    className={
                      profilePhoto
                        ? "contact-avatar contact-avatar--image contact-avatar--profile"
                        : "contact-avatar contact-avatar--profile"
                    }
                  >
                    {profilePhoto ? (
                      <img src={profilePhoto} alt={myCardName} className="contact-avatar__img" />
                    ) : (
                      contactInitials(myCardName)
                    )}
                  </div>
                  <div className="contact-row__text">
                    <div className="contact-row__name">{myCardName}</div>
                    <div
                      className={`contact-row__meta${
                        profileSubtitleIsNip05 ? " contact-row__meta--nip05" : ""
                      }`}
                    >
                      <span className="contact-row__meta-text">{myCardSubtitle}</span>
                      {profileSubtitleIsNip05 && profileNip05Verified && (
                        <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                      )}
                    </div>
                  </div>
                  <span className="contact-chevron">›</span>
                </button>
              );
            })()}

            <div className="contact-list">
              {sortedContacts.length > 0 ? (
                sortedContacts.map((contact) => {
                  const displayName = contactDisplayLabel(contact);
                  const displayNameTrimmed = truncateContactName(displayName);
                  const subtitle = contactSubtitle(contact) || "No details added";
                  const subtitleIsNip05 =
                    !!contact.nip05 &&
                    !!subtitle &&
                    normalizeNip05(contact.nip05) === normalizeNip05(subtitle);
                  const nip05Verified =
                    subtitleIsNip05 && isNip05VerifiedFor(contact.id, contact.nip05, contact.npub);
                  const photo = contact.picture?.trim();
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      className="contact-row pressable"
                      onClick={() => {
                        setActiveContactId(contact.id);
                        setContactView("detail");
                      }}
                    >
                      <div className={photo ? "contact-avatar contact-avatar--image" : "contact-avatar"}>
                        {photo ? (
                          <img src={photo} alt={displayName} className="contact-avatar__img" />
                        ) : (
                          contactInitials(displayName)
                        )}
                      </div>
                      <div className="contact-row__text">
                        <div className="contact-row__name">{displayNameTrimmed}</div>
                        <div
                          className={`contact-row__meta${subtitleIsNip05 ? " contact-row__meta--nip05" : ""}`}
                        >
                          <span className="contact-row__meta-text">{subtitle}</span>
                          {subtitleIsNip05 && nip05Verified && (
                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                          )}
                        </div>
                      </div>
                      <span className="contact-chevron">›</span>
                    </button>
                  );
                })
              ) : (
                <div className="contact-empty text-secondary">No saved contacts yet. Tap + to add one.</div>
              )}
            </div>
          </div>
        )}

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
                <div
                  className={`contact-heading${detailTarget.picture ? "" : " contact-heading--text-only"}`}
                >
                  {detailTarget.picture && (
                    <img src={detailTarget.picture} alt={detailTitle} className="contact-portrait" />
                  )}
                  <div className="contact-heading__text">
                    <div className="flex items-center gap-2">
                      <div className="contact-name-lg" title={detailTitle}>
                        {truncateContactName(detailTitle, 34)}
                      </div>
                      {activeContactId === "profile" && profileCard.npub && (
                        <button
                          type="button"
                          className="contact-pill contact-pill--circle pressable"
                          title="Share your npub"
                          onClick={() => {
                            setShareContactSource({ ...profileCard, relays: defaultNostrRelays });
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

            {activeContact &&
              (detailHasLightning || detailCanShare) && (
                <div className="contact-actions-row contact-actions-row--top contact-actions-row--wide">
                  {detailHasLightning && (
                    <button
                      type="button"
                      className="contact-pill pressable"
                      onClick={() => {
                        applyLightningContact(activeContact);
                        setContactsTabOpen(false);
                      }}
                    >
                      Pay lightning
                    </button>
                  )}
                  {detailCanShare && (
                    <button
                      type="button"
                      className="contact-pill pressable"
                      onClick={() => {
                        openEcashSendToContact(activeContact);
                        setContactsTabOpen(false);
                      }}
                    >
                      Pay eCash
                    </button>
                  )}
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
              onClick={() => {
                setContactView("list");
                setActiveContactId(null);
              }}
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
    </ActionSheet>
  );
}
