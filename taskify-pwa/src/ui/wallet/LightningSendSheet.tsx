// @ts-nocheck
import React from "react";
import { ActionSheet } from "../../components/ActionSheet";
import {
  AnimatedEllipsis,
  ChevronDownIcon,
  formatMintDisplayName,
} from "./walletModalUi";

export function LightningSendSheet(props) {
  const {
    sendMode,
    closeLightningSendSheet,
    openEcashSendSheet,
    isCompactLightningSheetLayout,
    lightningSendView,
    openContactsFor,
    lightningContactCount,
    lnRef,
    lnInput,
    setLnInput,
    lnError,
    bolt11Details,
    commitLightningInputFromDom,
    handleLightningInputReview,
    handlePasteLightningInput,
    mintSelectionOptions,
    selectedMintValue,
    setMintUrl,
    mintInfoByUrl,
    selectedMintLabel,
    selectedMintBalanceLabel,
    satFormatter,
    lightningInvoiceAmountSat,
    lightningInvoiceAmountSecondaryDisplay,
    normalizedLnInput,
    handlePayInvoice,
    mintUrl,
    lnState,
    canToggleCurrency,
    handleTogglePrimary,
    lightningSendPrimaryAmountText,
    lightningSendSecondaryAmountText,
    primaryCurrency,
    handleLightningSendAmountKeypadInput,
    lightningDestinationDisplay,
    isLnurlInput,
    lnurlPayData,
    isLnAddress,
    lnurlRequiresAmount,
    lnAddrAmt,
  } = props;

  return (
    <ActionSheet
      open={sendMode === "lightning"}
      onClose={closeLightningSendSheet}
      title="Pay Lightning"
      actions={(
        <button className="ghost-button button-sm pressable" onClick={openEcashSendSheet}>
          eCash
        </button>
      )}
      panelClassName={isCompactLightningSheetLayout ? "sheet-panel--compact" : undefined}
    >
      <div className="space-y-4">
        {lightningSendView === "input" && (
          <div className="space-y-4">
            <div className="wallet-section space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-secondary">
                <button
                  className="ghost-button button-sm pressable"
                  type="button"
                  onClick={() => openContactsFor("lightning")}
                >
                  Contacts
                </button>
                {lightningContactCount === 0 && <span>No saved lightning contacts yet.</span>}
              </div>
              <textarea
                ref={lnRef}
                className="pill-textarea wallet-textarea w-full"
                placeholder="Enter invoice or lightning address"
                defaultValue={lnInput}
                onChange={(event) => {
                  setLnInput(event.currentTarget.value, { defer: true });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                    event.preventDefault();
                    const current = event.currentTarget.value.trim().replace(/^lightning:/i, "").trim();
                    const canReviewCurrent =
                      /^ln(bc|tb|sb|bcrt)[0-9]/i.test(current) ||
                      /^[^@\s]+@[^@\s]+$/.test(current) ||
                      /^lnurl[0-9a-z]+$/i.test(current);
                    if (canReviewCurrent) {
                      handleLightningInputReview();
                    }
                  }
                }}
              />
              {lnError && <div className="text-xs text-rose-400">{lnError}</div>}
              {bolt11Details?.message && <div className="text-xs text-secondary">{bolt11Details.message}</div>}
              {bolt11Details?.error && <div className="text-xs text-rose-400">{bolt11Details.error}</div>}
            </div>
            <button
              type="button"
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={() => {
                const current = commitLightningInputFromDom();
                if (current.trim()) {
                  handleLightningInputReview();
                } else {
                  void handlePasteLightningInput();
                }
              }}
            >
              {lnInput.trim() ? "Pay" : "Paste"}
            </button>
          </div>
        )}
        {lightningSendView === "invoice" && (
          <div className="space-y-4">
            <div className="wallet-section space-y-5">
              <div className="space-y-2 text-left">
                <div className="text-[11px] uppercase tracking-wide text-secondary">Pay from</div>
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
              <div className="rounded-2xl border border-surface bg-surface-muted p-4 space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-secondary">Amount</div>
                <div className="text-3xl font-semibold text-primary">
                  {lightningInvoiceAmountSat != null
                    ? `${satFormatter.format(lightningInvoiceAmountSat)} SAT`
                    : "Amount not specified"}
                </div>
                {lightningInvoiceAmountSecondaryDisplay && (
                  <div className="text-sm text-secondary">≈ {lightningInvoiceAmountSecondaryDisplay}</div>
                )}
                {lightningInvoiceAmountSat == null && (
                  <div className="text-sm text-secondary">Invoice does not specify an amount.</div>
                )}
              </div>
              <div className="space-y-2 text-sm">
                <div>
                  <div className="text-secondary">Invoice</div>
                  <div className="font-mono text-[11px] break-all">{normalizedLnInput}</div>
                </div>
                {bolt11Details?.message && <div className="text-xs text-secondary">{bolt11Details.message}</div>}
                {bolt11Details?.error && <div className="text-xs text-rose-400">{bolt11Details.error}</div>}
              </div>
              <button
                className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                onClick={handlePayInvoice}
                disabled={!mintUrl || !lnInput || lnState === "sending"}
              >
                {lnState === "sending" ? (
                  <span className="inline-flex items-center gap-1">
                    Paying
                    <AnimatedEllipsis />
                  </span>
                ) : (
                  "Pay"
                )}
              </button>
              {lnState === "error" && <div className="text-xs text-rose-400">{lnError}</div>}
            </div>
          </div>
        )}
        {lightningSendView === "address" && (
          <div className="space-y-4">
            <div className="wallet-section wallet-section--compact space-y-4">
              <div className="space-y-2 text-left">
                <div className="text-[11px] uppercase tracking-wide text-secondary">Pay from</div>
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
              <div className="space-y-2 text-left">
                <div className="text-[11px] uppercase tracking-wide text-secondary">Send to</div>
                <div className="glass-panel px-3 py-2 text-sm font-medium text-primary break-all">
                  {lightningDestinationDisplay}
                </div>
              </div>
              {isLnurlInput && lnurlPayData && (
                <div className="text-xs text-secondary">
                  Limits: {Math.ceil(lnurlPayData.minSendable / 1000)} – {Math.floor(lnurlPayData.maxSendable / 1000)} sats
                </div>
              )}
              <button
                type="button"
                className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
                onClick={canToggleCurrency ? handleTogglePrimary : undefined}
                disabled={!canToggleCurrency}
              >
                <div className="wallet-balance-card__amount lightning-amount-display__primary">
                  {lightningSendPrimaryAmountText}
                </div>
                <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
                  {lightningSendSecondaryAmountText}
                </div>
              </button>
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
                      className="glass-panel wallet-keypad-grid__button pressable py-3 text-lg font-semibold"
                      onClick={() => handleLightningSendAmountKeypadInput(handlerKey)}
                    >
                      {key === "clear" ? "Clear" : key}
                    </button>
                  );
                })}
              </div>
              <button
                className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
                onClick={handlePayInvoice}
                disabled={
                  !mintUrl ||
                  !lnInput ||
                  ((isLnAddress || lnurlRequiresAmount) && !lnAddrAmt) ||
                  lnState === "sending"
                }
              >
                {lnState === "sending" ? (
                  <span className="inline-flex items-center gap-1">
                    Paying
                    <AnimatedEllipsis />
                  </span>
                ) : (
                  "Pay"
                )}
              </button>
              {lnState === "error" && <div className="text-xs text-rose-400">{lnError}</div>}
            </div>
          </div>
        )}
      </div>
    </ActionSheet>
  );
}
