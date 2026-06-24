// @ts-nocheck
import React from "react";
import { ActionSheet } from "../../components/ActionSheet";
import { QrCodeCard, ChevronDownIcon, BackIcon, formatMintDisplayName, trimMintUrlScheme } from "./walletModalUi";
import { SATS_PER_BTC } from "../../hooks/wallet/useWalletPrice";

export function EcashReceiveSheet(props) {
  const {
    receiveMode,
    closeReceiveEcashSheet,
    openReceiveLightningSheet,
    ecashReceiveView,
    paymentRequestsEnabled,
    overviewPaymentRequest,
    handleOpenEcashRequestAmountView,
    handleOpenReceiveLock,
    paymentRequestStatusMessage,
    paymentRequestError,
    nostrMissingReason,
    handlePasteEcashClipboard,
    recvMsg,
    mintSelectionOptions,
    selectedMintValue,
    setMintUrl,
    mintInfoByUrl,
    selectedMintLabel,
    selectedMintBalanceLabel,
    canToggleCurrency,
    handleLightningAmountUnitToggle,
    ecashRequestPrimaryAmountText,
    ecashRequestSecondaryAmountText,
    ecashRequestMode,
    handleSetEcashRequestMode,
    primaryCurrency,
    handleEcashRequestKeypadInput,
    canCreateEcashRequest,
    handleCreateEcashRequest,
    lastCreatedEcashRequest,
    formatSatAmount,
    walletConversionEnabled,
    btcUsdPrice,
    formatUsdAmount,
    mintUrl,
    ensureOpenPaymentRequest,
    setLastCreatedEcashRequest,
    setEcashReceiveView,
  } = props;

  return (
    <ActionSheet
      open={receiveMode === "ecash"}
      onClose={closeReceiveEcashSheet}
      title="Receive eCash"
      actions={(
        <button
          className="ghost-button button-sm pressable"
          onClick={() => {
            closeReceiveEcashSheet();
            openReceiveLightningSheet();
          }}
        >
          Lightning
        </button>
      )}
    >
      {ecashReceiveView === "overview" ? (
        <div className="space-y-4">
          <div className="wallet-section space-y-4">
            {paymentRequestsEnabled ? (
              <>
                <div className="flex items-center justify-between text-left">
                  <div className="text-sm font-medium">Payment request</div>
                  <span className="text-[11px] text-secondary">
                    {overviewPaymentRequest?.request.singleUse ? "Single-use" : "Multi-use"}
                  </span>
                </div>
                {overviewPaymentRequest?.encoded ? (
                  <>
                    <div className="flex justify-center">
                      <QrCodeCard
                        value={overviewPaymentRequest.encoded}
                        label="Payment request"
                        copyLabel="Copy"
                        size={220}
                        hideLabel
                        flat
                        className="wallet-qr-card--centered"
                        extraActions={
                          <div className="flex flex-wrap justify-center gap-2">
                            <button
                              className="ghost-button button-sm pressable"
                              onClick={handleOpenEcashRequestAmountView}
                            >
                              Get request
                            </button>
                            <button
                              className="ghost-button button-sm pressable"
                              onClick={handleOpenReceiveLock}
                              type="button"
                            >
                              Lock
                            </button>
                          </div>
                        }
                      />
                    </div>
                    {paymentRequestStatusMessage && !paymentRequestError && (
                      <div className="text-[11px] text-secondary text-center">
                        {paymentRequestStatusMessage}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-secondary text-center">
                    {nostrMissingReason
                      ? nostrMissingReason
                      : "Generate a NUT-18 payment request to collect eCash via Nostr."}
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-secondary text-center">
                Enable payment requests in Settings to generate a reusable eCash request.
              </div>
            )}
          </div>
          <button
            className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
            onClick={() => {
              void handlePasteEcashClipboard();
            }}
          >
            Paste
          </button>
          {paymentRequestError && (
            <div className="text-[11px] text-rose-500 text-center">{paymentRequestError}</div>
          )}
          {recvMsg && <div className="text-xs text-secondary text-center">{recvMsg}</div>}
        </div>
      ) : ecashReceiveView === "amount" ? (
        <div className="space-y-4">
          <div className="wallet-section wallet-section--compact space-y-4">
            <div className="space-y-2 text-left">
              <div className="text-[11px] uppercase tracking-wide text-secondary">Receive to</div>
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
                  Add a mint in Wallet → Mint balances to start receiving.
                </div>
              )}
            </div>
            <button
              type="button"
              className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
              onClick={canToggleCurrency ? handleLightningAmountUnitToggle : undefined}
              disabled={!canToggleCurrency}
            >
              <div className="wallet-balance-card__amount lightning-amount-display__primary">
                {ecashRequestPrimaryAmountText}
              </div>
              <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
                {ecashRequestSecondaryAmountText}
              </div>
            </button>
            <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
              <button
                type="button"
                className={`glass-panel pressable py-0.5 transition-colors ${
                  ecashRequestMode === "single"
                    ? "border border-accent text-accent"
                    : "border border-transparent text-secondary"
                }`}
                onClick={() => handleSetEcashRequestMode("single")}
              >
                Single-use
              </button>
              <button
                type="button"
                className={`glass-panel pressable py-0.5 transition-colors ${
                  ecashRequestMode === "multi"
                    ? "border border-accent text-accent"
                    : "border border-transparent text-secondary"
                }`}
                onClick={() => handleSetEcashRequestMode("multi")}
              >
                Multi-use
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
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
                    onClick={() => handleEcashRequestKeypadInput(handlerKey)}
                  >
                    {key === "clear" ? "Clear" : key}
                  </button>
                );
              })}
            </div>
            <button
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={() => {
                void handleCreateEcashRequest();
              }}
              disabled={!canCreateEcashRequest}
            >
              Get request
            </button>
            {paymentRequestError && (
              <div className="text-sm text-rose-400 text-center">{paymentRequestError}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {lastCreatedEcashRequest ? (
            <div className="wallet-section wallet-section--compact space-y-4">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="flex items-center gap-2 text-secondary hover:text-primary transition-colors pressable"
                  onClick={() => {
                    handleOpenEcashRequestAmountView();
                  }}
                >
                  <BackIcon className="h-4 w-4" />
                  New request
                </button>
                <div className="text-sm font-medium text-secondary">
                  {lastCreatedEcashRequest.request.singleUse ? "Single-use" : "Multi-use"}
                </div>
              </div>
              <div className="flex justify-center">
                <QrCodeCard
                  value={lastCreatedEcashRequest.encoded}
                  label="Payment request"
                  copyLabel="Copy request"
                  size={240}
                />
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-secondary">Amount</span>
                  <span className="font-semibold">
                    {typeof lastCreatedEcashRequest.amountSat === "number"
                      ? formatSatAmount(lastCreatedEcashRequest.amountSat)
                      : "Open amount"}
                  </span>
                </div>
                {walletConversionEnabled &&
                  btcUsdPrice != null &&
                  btcUsdPrice > 0 &&
                  typeof lastCreatedEcashRequest.amountSat === "number" && (
                    <div className="flex items-center justify-between text-secondary">
                      <span>USD</span>
                      <span>
                        {formatUsdAmount(
                          (lastCreatedEcashRequest.amountSat / SATS_PER_BTC) * btcUsdPrice,
                        )}
                      </span>
                    </div>
                  )}
                <div className="flex items-center justify-between">
                  <span className="text-secondary">Mint</span>
                  <span className="font-medium break-all">{trimMintUrlScheme(mintUrl || "—")}</span>
                </div>
                {lastCreatedEcashRequest.lockPubkey && (
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Lock</span>
                    <span className="font-medium break-all">{lastCreatedEcashRequest.lockPubkey}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="wallet-section text-sm text-secondary">Create a request to view its details.</div>
          )}
          <div className="flex flex-wrap justify-center gap-2 text-sm">
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                handleOpenEcashRequestAmountView();
              }}
            >
              New request
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                void ensureOpenPaymentRequest();
                setLastCreatedEcashRequest(null);
                setEcashReceiveView("overview");
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </ActionSheet>
  );
}
