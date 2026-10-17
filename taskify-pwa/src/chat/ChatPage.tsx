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










import { ActionSheet } from "../components/ActionSheet";
import {
  contactPrimaryName,
  formatContactNpub,
  formatContactUsername,
} from "../lib/contacts";




import { type DmReaction } from "./hooks/useDmState";




import {
  QrCodeCard,
  QrScanner,
  ShareArrowIcon,
  VerifiedBadgeIcon,
} from "./chatUi";





import { useChatRuntime } from "./ChatRuntime";
import { ChatThreadsView } from "./views/ChatThreadsView";
import { ChatConversationView } from "./views/ChatConversationView";
import { ChatContactsView } from "./views/ChatContactsView";
import { ChatGroupInfoView, ChatGroupMembersView, ChatGroupNameView, ChatNewGroupMembersView, ChatNewGroupNameView } from "./views/ChatGroupViews";

export default function ChatPage() {
  const {
    chatAttachContactOptions,
    chatView,
    closeScanner,
    contactInitials,
    contacts,
    copyMessageValue,
    dmForwardMessage,
    dmInfoMessage,
    dmMessageActions,
    dmPeerProfilesRef,
    dmReactionDetail,
    dmReactions,
    dmThreads,
    handleCopyContactField,
    handleDeleteDmMessage,
    handleForwardMessage,
    handleImportPublicFollow,
    handlePasteFromClipboard,
    handleScannerDetected,
    handleScannerError,
    handleSendReaction,
    handleShareContactToContact,
    isChatPage,
    loadProfileMetadata,
    nostrIdentityRef,
    onAddTaskAgain,
    profileEditorOpen,
    profileForm,
    profileMessage,
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
    setDmForwardMessage,
    setDmInfoMessage,
    setDmMessageActions,
    setDmReactionDetail,
    setProfileEditorOpen,
    setProfileForm,
    setPublicFollowPickerOpen,
    setReplyToMessage,
    setScannedContact,
    setShareContactPickerMode,
    setShareContactPickerOpen,
    setShareContactSource,
    setShareContactStatus,
    setSharedContactPreview,
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
    showScanner,
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

          <ChatContactsView />

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
