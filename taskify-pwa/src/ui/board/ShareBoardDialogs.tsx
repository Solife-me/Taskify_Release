import React, { useState } from "react";
import { useChatRuntime } from "../../chat/ChatRuntime";
import type { GroupChat } from "../../lib/groupChatState";
import { QRCodeCanvas } from "qrcode.react";
import type { Board } from "taskify-core";
import { ActionSheet } from "../../components/ActionSheet";
import { Modal } from "../Modal";
import {
  contactInitials,
} from "taskify-core";
import {
  contactPrimaryName,
  formatContactNpub,
  type Contact,
} from "../../lib/contacts";

type ShareBoardDialogsProps = {
  closeShareBoard: () => void;
  enableBoardSharing: (boardId: string) => void;
  handleOpenBoardPrint?: () => void;
  handleOpenBoardScan?: () => void;
  handleShareBoardRecipient: (recipient: Contact | GroupChat) => void;
  markBoardShared: (shareId: string) => void;
  setShareBoardMode: (mode: "board" | "template") => void;
  setShareContactPickerOpen: (open: boolean) => void;
  setShareContactStatus: (status: string | null) => void;
  setShareModeInfoOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShareTemplateStatus: (status: string | null) => void;
  shareBoardDisplayName: string;
  shareBoardId: string | null;
  shareBoardModalOpen: boolean;
  shareBoardMode: "board" | "template";
  shareBoardQrPayload: string | null;
  shareBoardTarget: Board | null;
  shareContactBusy: boolean;
  shareContactPickerOpen: boolean;
  shareContactStatus: string | null;
  shareModeInfoButtonRef: React.RefObject<HTMLButtonElement | null>;
  shareModeInfoOpen: boolean;
  shareModeInfoRef: React.RefObject<HTMLDivElement | null>;
  shareTemplateBusy: boolean;
  shareTemplateStatus: string | null;
  shareableContacts: Contact[];
};

export function ShareBoardDialogs({
  closeShareBoard,
  enableBoardSharing,
  handleOpenBoardPrint,
  handleOpenBoardScan,
  handleShareBoardRecipient,
  markBoardShared,
  setShareBoardMode,
  setShareContactPickerOpen,
  setShareContactStatus,
  setShareModeInfoOpen,
  setShareTemplateStatus,
  shareBoardDisplayName,
  shareBoardId,
  shareBoardModalOpen,
  shareBoardMode,
  shareBoardQrPayload,
  shareBoardTarget,
  shareContactBusy,
  shareContactPickerOpen,
  shareContactStatus,
  shareModeInfoButtonRef,
  shareModeInfoOpen,
  shareModeInfoRef,
  shareTemplateBusy,
  shareTemplateStatus,
  shareableContacts,
}: ShareBoardDialogsProps) {
  const { boardShareGroups } = useChatRuntime();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const groups = boardShareGroups.filter((group) => group.name.toLowerCase().includes(query));
  const contacts = shareableContacts.filter((contact) => [
    contact.name, contact.displayName, contact.username, contact.username && `@${contact.username}`, contact.npub,
  ].some((value) => value?.toLowerCase().includes(query)));
  return (
    <>
      {shareBoardModalOpen && (
        <Modal onClose={closeShareBoard} title={`Share ${shareBoardDisplayName}`}>
          {shareBoardTarget ? (
            shareBoardTarget.nostr?.boardId ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="share-mode-header">
                    <div className="text-xs uppercase tracking-wide text-secondary">Share mode</div>
                    <button
                      type="button"
                      className="share-mode-info-button pressable"
                      aria-label="About share modes"
                      aria-expanded={shareModeInfoOpen}
                      aria-controls="share-mode-info"
                      onClick={() => setShareModeInfoOpen((prev) => !prev)}
                      ref={shareModeInfoButtonRef}
                    >
                      <span className="share-mode-info-button__icon" aria-hidden="true">i</span>
                    </button>
                    {shareModeInfoOpen && (
                      <div
                        className="share-mode-info"
                        role="tooltip"
                        id="share-mode-info"
                        ref={shareModeInfoRef}
                      >
                        <div className="share-mode-info__row">
                          <div className="share-mode-info__label">Board</div>
                          <div className="share-mode-info__text">
                            Shares the live board ID and keeps changes in sync.
                          </div>
                        </div>
                        <div className="share-mode-info__row">
                          <div className="share-mode-info__label">Template</div>
                          <div className="share-mode-info__text">
                            Creates a new board ID and publishes a snapshot that won't sync future changes.
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="share-mode-toggle" role="group" aria-label="Share mode">
                    <button
                      type="button"
                      className="pill-select share-mode-toggle__button pressable"
                      data-active={shareBoardMode === "board"}
                      aria-pressed={shareBoardMode === "board"}
                      onClick={() => {
                        setShareBoardMode("board");
                        setShareTemplateStatus(null);
                        setShareModeInfoOpen(false);
                      }}
                    >
                      Board
                    </button>
                    <button
                      type="button"
                      className="pill-select share-mode-toggle__button pressable"
                      data-active={shareBoardMode === "template"}
                      aria-pressed={shareBoardMode === "template"}
                      onClick={() => {
                        setShareBoardMode("template");
                        setShareTemplateStatus(null);
                        setShareModeInfoOpen(false);
                      }}
                    >
                      Template
                    </button>
                  </div>
                </div>
                {shareTemplateStatus && (
                  <div className="text-sm text-rose-400">{shareTemplateStatus}</div>
                )}
                <div className="space-y-1">
                  <div className="wallet-qr-card wallet-qr-card--flat wallet-qr-card--centered">
                    <div className="wallet-qr-card__code">
                      {shareBoardId ? (
                        <button
                          type="button"
                          className="wallet-qr-card__canvas wallet-qr-card__canvas--pressable pressable"
                          style={{ maxWidth: "16rem" }}
                          aria-label="Copy board ID"
                          onClick={async () => {
                            try {
                              if (!navigator.clipboard) return;
                              await navigator.clipboard.writeText(shareBoardId);
                              if (shareBoardMode === "board") markBoardShared(shareBoardId);
                            } catch {}
                          }}
                        >
                          <QRCodeCanvas
                            value={shareBoardQrPayload ?? shareBoardId}
                            size={256}
                            includeMargin={true}
                            className="wallet-qr-card__qr"
                          />
                        </button>
                      ) : (
                        <div className="contact-qr-placeholder text-secondary">
                          {shareTemplateBusy ? "Generating template share..." : "No QR to share yet."}
                        </div>
                      )}
                    </div>
                  </div>
                  {shareBoardId && (
                    <div className="wallet-qr-card__helper">Tap to copy</div>
                  )}
                  <div className="flex gap-2">
                    <button
                      className="ghost-button button-sm pressable flex-1 justify-center"
                      onClick={() => {
                        setSearch("");
                        setShareContactStatus(null);
                        setShareContactPickerOpen(true);
                      }}
                      disabled={!shareBoardId || (shareBoardMode === "template" && shareTemplateBusy)}
                    >
                      Send to chat
                    </button>
                  </div>
                  {handleOpenBoardPrint && handleOpenBoardScan && (
                    <div className="flex gap-2 mt-2">
                      <button
                        className="ghost-button button-sm pressable flex-1 justify-center"
                        onClick={handleOpenBoardPrint}
                      >
                        Print
                      </button>
                      <button
                        className="ghost-button button-sm pressable flex-1 justify-center"
                        onClick={handleOpenBoardScan}
                      >
                        Scan
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  className="accent-button button-sm pressable w-full justify-center"
                  onClick={() => enableBoardSharing(shareBoardTarget.id)}
                >
                  Enable sharing
                </button>
              </div>
            )
          ) : (
            <div className="text-sm text-secondary">Select a board to share first.</div>
          )}
        </Modal>
      )}

      <ActionSheet
        open={shareContactPickerOpen}
        onClose={() => {
          if (shareContactBusy) return;
          setShareContactPickerOpen(false);
          setShareContactStatus(null);
        }}
        title="Send board to chat"
        stackLevel={75}
      >
        {shareBoardTarget ? (
          <div className="text-sm text-secondary mb-2">
            Choose a contact or group to send <span className="font-semibold">{shareBoardDisplayName}</span>.
          </div>
        ) : (
          <div className="text-sm text-secondary mb-2">Select a board to share first.</div>
        )}
        {shareContactStatus && (
          <div className="text-sm text-rose-400 mb-2">{shareContactStatus}</div>
        )}
        <input
          type="search"
          className="pill-input w-full mb-2"
          aria-label="Search contacts and groups"
          placeholder="Search contacts and groups"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {groups.length > 0 && (
          <div role="group" aria-label="Group chats" className="space-y-2 mb-2">
            {groups.map((group) => (
              <button
                key={group.groupId}
                type="button"
                className="contact-row pressable"
                disabled={shareContactBusy || !shareBoardId}
                onClick={() => handleShareBoardRecipient(group)}
              >
                <div className="contact-avatar">{contactInitials(group.name)}</div>
                <div className="contact-row__text">
                  <div className="contact-row__name">{group.name}</div>
                  <div className="contact-row__meta">{group.members.length} members</div>
                </div>
              </button>
            ))}
          </div>
        )}
        {contacts.length > 0 && (
          <div role="group" aria-label="Contacts" className="space-y-2">
            {contacts.map((contact) => {
              const label = contactPrimaryName(contact);
              const subtitle = formatContactNpub(contact.npub);
              return (
                <button
                  key={contact.id}
                  type="button"
                  className="contact-row pressable"
                  disabled={shareContactBusy || !shareBoardId}
                  onClick={() => handleShareBoardRecipient(contact)}
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
        )}
        {!groups.length && !contacts.length && (
          <div className="text-sm text-secondary">{query ? "No matching contacts or groups." : "Add a contact or create a group to share."}</div>
        )}
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            className="ghost-button button-sm pressable flex-1 justify-center"
            onClick={() => {
              if (shareContactBusy) return;
              setShareContactPickerOpen(false);
              setShareContactStatus(null);
            }}
            disabled={shareContactBusy}
          >
            Cancel
          </button>
        </div>
      </ActionSheet>
    </>
  );
}
