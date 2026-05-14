import React from "react";
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
  handleOpenBoardPrint: () => void;
  handleOpenBoardScan: () => void;
  handleShareBoardToContact: (contact: Contact) => void;
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
  handleShareBoardToContact,
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
                              await navigator.clipboard?.writeText(shareBoardId);
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
                        setShareContactStatus(null);
                        setShareContactPickerOpen(true);
                      }}
                      disabled={!shareBoardId || (shareBoardMode === "template" && shareTemplateBusy)}
                    >
                      Contacts
                    </button>
                  </div>
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
        title="Send board ID"
        stackLevel={75}
      >
        {shareBoardTarget ? (
          <div className="text-sm text-secondary mb-2">
            Choose a contact to send <span className="font-semibold">{shareBoardDisplayName}</span>.
          </div>
        ) : (
          <div className="text-sm text-secondary mb-2">Select a board to share first.</div>
        )}
        {shareContactStatus && (
          <div className="text-sm text-rose-400 mb-2">{shareContactStatus}</div>
        )}
        {shareableContacts.length ? (
          <div className="space-y-2">
            {shareableContacts.map((contact) => {
              const label = contactPrimaryName(contact);
              const subtitle = formatContactNpub(contact.npub);
              return (
                <button
                  key={contact.id}
                  type="button"
                  className="contact-row pressable"
                  disabled={shareContactBusy || !shareBoardId}
                  onClick={() => handleShareBoardToContact(contact)}
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
          <div className="text-sm text-secondary">Add a contact with an npub to share.</div>
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
