// @ts-nocheck
import React from "react";
import { ActionSheet } from "../../components/ActionSheet";
import { ChevronDownIcon, formatMintDisplayName } from "./walletModalUi";
import { normalizeMintUrl } from "../../wallet/cashuProofHelpers";

export function PaymentRequestFulfillSheet(props) {
  const {
    sendMode,
    closePaymentRequestSheet,
    handlePasteEcashRequest,
    paymentRequestState,
    mintSelectionOptions,
    selectedMintValue,
    setMintUrl,
    mintInfoByUrl,
    selectedMintLabel,
    selectedMintBalanceLabel,
    paymentRequestAmountButtonEnabled,
    canTogglePaymentRequestCurrency,
    handlePaymentRequestAmountUnitToggle,
    paymentRequestPrimaryAmountText,
    paymentRequestSecondaryAmountText,
    paymentRequestHasFixedAmount,
    primaryCurrency,
    handlePaymentRequestKeypadInput,
    handleFulfillPaymentRequest,
    paymentRequestStatus,
    paymentRequestManualAmount,
    paymentRequestActionLabel,
    paymentRequestMessage,
    paymentRequestError,
  } = props;

  return (
    <ActionSheet
      open={sendMode === "paymentRequest"}
      onClose={closePaymentRequestSheet}
      title="Fulfill eCash Request"
      actions={(
        <button
          className="ghost-button button-sm pressable"
          onClick={() => {
            void handlePasteEcashRequest();
          }}
        >
          Paste
        </button>
      )}
    >
      {paymentRequestState ? (
        <div className="space-y-4">
          <div className="wallet-section space-y-5">
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
              className={`lightning-amount-display glass-panel${paymentRequestAmountButtonEnabled ? " pressable" : ""}`}
              onClick={
                paymentRequestAmountButtonEnabled
                  ? () => {
                      if (canTogglePaymentRequestCurrency) {
                        handlePaymentRequestAmountUnitToggle();
                      }
                    }
                  : undefined
              }
              disabled={!paymentRequestAmountButtonEnabled}
            >
              <div className="wallet-balance-card__amount lightning-amount-display__primary">
                {paymentRequestPrimaryAmountText}
              </div>
              <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
                {paymentRequestSecondaryAmountText}
              </div>
            </button>
            {!paymentRequestHasFixedAmount && (
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
                      onClick={() => handlePaymentRequestKeypadInput(handlerKey)}
                    >
                      {key === "clear" ? "Clear" : key}
                    </button>
                  );
                })}
              </div>
            )}
            {(() => {
              const request = paymentRequestState.request;
              const detailItems: React.ReactNode[] = [];
              if (request.description) {
                detailItems.push(
                  <div key="description">Memo: {request.description}</div>,
                );
              }
              if (request.mints?.length) {
                detailItems.push(
                  <div key="mints">Mint: {request.mints.map(normalizeMintUrl).join(", ")}</div>,
                );
              }
              return detailItems.length ? (
                <div className="space-y-1 text-xs text-secondary">{detailItems}</div>
              ) : null;
            })()}
            <button
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={handleFulfillPaymentRequest}
              disabled={
                paymentRequestStatus === "sending" ||
                (!paymentRequestState.request.amount && !paymentRequestManualAmount.trim())
              }
            >
              {paymentRequestActionLabel}
            </button>
            {paymentRequestStatus === "sending" && (
              <div className="text-xs text-secondary text-center">Sending…</div>
            )}
            {paymentRequestStatus === "error" && paymentRequestMessage && (
              <div className="text-xs text-rose-400 text-center">{paymentRequestMessage}</div>
            )}
            {paymentRequestStatus !== "error" && paymentRequestMessage && (
              <div className="text-xs text-secondary text-center">{paymentRequestMessage}</div>
            )}
            {paymentRequestError && (
              <div className="text-xs text-rose-400 text-center">{paymentRequestError}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="wallet-section text-sm text-secondary">Scan an eCash withdrawal request to continue.</div>
      )}
    </ActionSheet>
  );
}
