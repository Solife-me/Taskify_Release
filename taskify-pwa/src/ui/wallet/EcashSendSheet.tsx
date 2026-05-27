// @ts-nocheck
import React from "react";
import { ActionSheet } from "../../components/ActionSheet";
import {
  QrCodeCard,
  ChevronDownIcon,
  BackIcon,
  AnimatedEllipsis,
  LockIcon,
  formatMintDisplayName,
  trimMintUrlScheme,
} from "./walletModalUi";
import { SATS_PER_BTC } from "../../hooks/wallet/useWalletPrice";
import { contactPrimaryName } from "../../lib/contacts";

export function EcashSendSheet(props) {
  const {
    sendMode,
    closeEcashSendSheet,
    openLightningSendSheet,
    ecashSendView,
    ecashSendRecipient,
    isNip05VerifiedFor,
    truncateContactName,
    openContactsFor,
    lockSendToPubkey,
    handleClearSendLock,
    handlePasteSendLock,
    mintSelectionOptions,
    selectedMintValue,
    setMintUrl,
    mintInfoByUrl,
    selectedMintLabel,
    selectedMintBalanceLabel,
    canToggleCurrency,
    handleTogglePrimary,
    ecashPrimaryAmountText,
    ecashSecondaryAmountText,
    sendLockError,
    primaryCurrency,
    handleEcashAmountKeypadInput,
    sendTokenStr,
    setEcashSendView,
    handleCreateSendToken,
    creatingSendToken,
    tokenAlreadyCreatedForAmount,
    canCreateSendTokenAmount,
    applyEcashContact,
    handleOpenEcashAmountView,
    lastSendTokenLockLabel,
    peanutSendToken,
    handleCopyNutToken,
    nutTokenCopied,
    lastSendTokenAmount,
    satFormatter,
    walletConversionEnabled,
    btcUsdPrice,
    formatUsdAmount,
    lastSendTokenMint,
    handlePasteEcashInput,
    mintUrl,
  } = props;

  return (
    <ActionSheet
      open={sendMode === "ecash"}
      onClose={closeEcashSendSheet}
      header={
        ecashSendView === "contact" && ecashSendRecipient ? (
          <>
            <div className="text-sm font-semibold">
              {(() => {
                const nip05 = ecashSendRecipient.nip05?.trim() || "";
                const nip05Verified = nip05 && isNip05VerifiedFor(ecashSendRecipient.id, nip05, ecashSendRecipient.npub);
                const label = nip05Verified ? nip05 : contactPrimaryName(ecashSendRecipient);
                return `Send to ${truncateContactName(label, 34)}`;
              })()}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <button
                className="ghost-button button-sm pressable"
                onClick={() => openContactsFor("ecash")}
              >
                Contacts
              </button>
              <button className="ghost-button button-sm pressable" onClick={closeEcashSendSheet}>
                Close
              </button>
            </div>
          </>
        ) : undefined
      }
      title={
        ecashSendView === "contact" && ecashSendRecipient
          ? (() => {
              const nip05 = ecashSendRecipient.nip05?.trim() || "";
              const nip05Verified = nip05 && isNip05VerifiedFor(ecashSendRecipient.id, nip05, ecashSendRecipient.npub);
              const label = nip05Verified ? nip05 : contactPrimaryName(ecashSendRecipient);
              return `Send to ${truncateContactName(label, 34)}`;
            })()
          : "Send eCash"
      }
      actions={
        ecashSendView === "contact" ? (
          <button
            className="ghost-button button-sm pressable"
            onClick={() => openContactsFor("ecash")}
          >
            Contacts
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              className="glass-panel pressable rounded-full p-2"
              type="button"
              onClick={() => {
                if (lockSendToPubkey) {
                  handleClearSendLock();
                } else {
                  void handlePasteSendLock();
                }
              }}
              title={lockSendToPubkey ? "Clear P2PK lock" : "Paste P2PK locking key"}
              aria-label={lockSendToPubkey ? "Clear P2PK lock" : "Paste P2PK locking key"}
            >
              <LockIcon className={`h-4 w-4 ${lockSendToPubkey ? "text-accent" : "text-white"}`} />
            </button>
            <button
              className="ghost-button button-sm pressable"
              onClick={() => {
                closeEcashSendSheet();
                openLightningSendSheet();
              }}
            >
              Lightning
            </button>
          </div>
        )
      }
      panelClassName={ecashSendView === "contact" ? "sheet-panel--compact" : undefined}
    >
      {ecashSendView === "amount" && (
        <div className="space-y-4">
          <div className="wallet-section wallet-section--compact space-y-3">
            {sendTokenStr && (
              <button
                type="button"
                className="ghost-button button-sm pressable w-full justify-between"
                onClick={() => setEcashSendView("token")}
              >
                <span>View last token</span>
                <span className="text-tertiary">→</span>
              </button>
            )}
            <div className="space-y-2 text-left">
              <div className="text-[11px] uppercase tracking-wide text-secondary">Send from</div>
              {mintSelectionOptions.length ? (
                <div className="relative">
                  <select
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                    value={selectedMintValue}
                    aria-label="Select mint"
                    onChange={(event) => {
                      const next = event.target.value;
                      if (next && next !== selectedMintValue) {
                        void setMintUrl(next);
                      }
                    }}
                  >
                    {mintSelectionOptions.map((option) => {
                      const info = mintInfoByUrl[option.normalized];
                      const label = info?.name || formatMintDisplayName(option.url);
                      return (
                        <option key={option.normalized} value={option.normalized}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                  <div className="pill-input lightning-mint-select__display">
                    <div className="lightning-mint-select__label">{selectedMintLabel}</div>
                    <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
                  </div>
                  <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                </div>
              ) : (
                <div className="text-sm text-secondary">
                  Add a mint in Wallet → Mint balances to start sending.
                </div>
              )}
            </div>
            <button
              type="button"
              className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
              onClick={canToggleCurrency ? handleTogglePrimary : undefined}
              disabled={!canToggleCurrency}
            >
              <div className="wallet-balance-card__amount lightning-amount-display__primary">{ecashPrimaryAmountText}</div>
              <div className="wallet-balance-card__secondary lightning-amount-display__secondary">{ecashSecondaryAmountText}</div>
            </button>
            {sendLockError && <div className="text-[11px] text-rose-500">{sendLockError}</div>}
            <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
              <button
                type="button"
                className="glass-panel pressable py-0.5"
                onClick={() => openContactsFor("ecash")}
              >
                Contacts
              </button>
              <button
                type="button"
                className="glass-panel pressable py-0.5"
                onClick={() => {
                  void handlePasteEcashInput();
                }}
              >
                Paste
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(primaryCurrency === "usd"
                ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
                : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
              ).map((key) => {
                const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
                return (
                  <button
                    key={key}
                    type="button"
                    className="glass-panel pressable py-3 text-lg font-semibold"
                    onClick={() => handleEcashAmountKeypadInput(handlerKey)}
                  >
                    {key === "clear" ? "Clear" : key}
                  </button>
                );
              })}
            </div>
            <button
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={handleCreateSendToken}
              disabled={!mintUrl || creatingSendToken || tokenAlreadyCreatedForAmount || !canCreateSendTokenAmount}
            >
              {creatingSendToken ? "Creating…" : "Get token"}
            </button>
            {tokenAlreadyCreatedForAmount && (
              <div className="text-xs text-secondary">
                Token already created for this amount with the current lock settings. Update the parameters to mint another.
              </div>
            )}
          </div>
        </div>
      )}
      {ecashSendView === "contact" && ecashSendRecipient && (
        <div className="space-y-4">
          <div className="wallet-section wallet-section--compact space-y-3">
            <div className="space-y-2 text-left">
              <div className="text-[11px] uppercase tracking-wide text-secondary">Send from</div>
              {mintSelectionOptions.length ? (
                <div className="relative">
                  <select
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                    value={selectedMintValue}
                    aria-label="Select mint"
                    onChange={(event) => {
                      const next = event.target.value;
                      if (next && next !== selectedMintValue) {
                        void setMintUrl(next);
                      }
                    }}
                  >
                    {mintSelectionOptions.map((option) => {
                      const info = mintInfoByUrl[option.normalized];
                      const label = info?.name || formatMintDisplayName(option.url);
                      return (
                        <option key={option.normalized} value={option.normalized}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                  <div className="pill-input lightning-mint-select__display">
                    <div className="lightning-mint-select__label">{selectedMintLabel}</div>
                    <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
                  </div>
                  <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                </div>
              ) : (
                <div className="text-sm text-secondary">Add a mint in Wallet → Mint balances to send eCash.</div>
              )}
            </div>
            <button
              type="button"
              className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
              onClick={canToggleCurrency ? handleTogglePrimary : undefined}
              disabled={!canToggleCurrency}
            >
              <div className="wallet-balance-card__amount lightning-amount-display__primary">
                {ecashPrimaryAmountText}
              </div>
              <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
                {ecashSecondaryAmountText}
              </div>
            </button>
            {sendLockError && <div className="text-[11px] text-rose-500">{sendLockError}</div>}
            <div className="grid grid-cols-3 gap-2">
              {(primaryCurrency === "usd"
                ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
                : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
              ).map((key) => {
                const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
                return (
                  <button
                    key={key}
                    type="button"
                    className="glass-panel pressable py-3 text-lg font-semibold"
                    onClick={() => handleEcashAmountKeypadInput(handlerKey)}
                  >
                    {key === "clear" ? "Clear" : key}
                  </button>
                );
              })}
            </div>
            <button
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={() => {
                void applyEcashContact(ecashSendRecipient);
              }}
              disabled={!mintUrl || creatingSendToken || !canCreateSendTokenAmount}
            >
              {creatingSendToken ? (
                <span className="inline-flex items-center gap-1">
                  Sending
                  <AnimatedEllipsis />
                </span>
              ) : (
                "Pay via nostr"
              )}
            </button>
          </div>
        </div>
      )}
      {ecashSendView === "contact" && !ecashSendRecipient && (
        <div className="wallet-section text-sm text-secondary">Select a contact to continue.</div>
      )}
      {ecashSendView === "token" && sendTokenStr && (
        <div className="space-y-4">
          <div className="wallet-section space-y-4">
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="flex items-center gap-2 text-secondary hover:text-primary transition-colors pressable"
                onClick={handleOpenEcashAmountView}
              >
                <BackIcon className="h-4 w-4" />
                New token
              </button>
              {lastSendTokenLockLabel && (
                <div className="text-sm font-medium text-secondary text-right">{lastSendTokenLockLabel}</div>
              )}
            </div>
            <div className="flex justify-center">
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={sendTokenStr}
                label="Token"
                copyLabel="Copy token"
                extraActions={
                  peanutSendToken ? (
                    <button
                      type="button"
                      className="ghost-button button-sm pressable"
                      onClick={handleCopyNutToken}
                      aria-label="Copy nut-encoded token"
                      title="Copy nut-encoded token"
                    >
                      {nutTokenCopied ? "Copied" : "Nut"}
                    </button>
                  ) : undefined
                }
                size={240}
                enableNut16Animation
              />
            </div>
            <div className="space-y-2 text-sm">
              {lastSendTokenAmount != null && (
                <div className="flex items-center justify-between">
                  <span className="text-secondary">Amount</span>
                  <span className="font-semibold">{satFormatter.format(lastSendTokenAmount)} SAT</span>
                </div>
              )}
              {walletConversionEnabled && btcUsdPrice != null && btcUsdPrice > 0 && lastSendTokenAmount != null && (
                <div className="flex items-center justify-between text-secondary">
                  <span>USD</span>
                  <span>{formatUsdAmount((lastSendTokenAmount / SATS_PER_BTC) * btcUsdPrice)}</span>
                </div>
              )}
              {lastSendTokenMint && (
                <div className="flex items-center justify-between">
                  <span className="text-secondary">Mint</span>
                  <span className="font-medium break-all">{trimMintUrlScheme(lastSendTokenMint)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {ecashSendView === "token" && !sendTokenStr && (
        <div className="wallet-section text-sm text-secondary">Create a token to share.</div>
      )}
    </ActionSheet>
  );
}
