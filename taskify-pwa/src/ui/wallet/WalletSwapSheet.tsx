// @ts-nocheck
import React from "react";
import { ActionSheet } from "../../components/ActionSheet";
import { ChevronDownIcon, QrCodeCard } from "./walletModalUi";

export function WalletSwapSheet(props) {
  const {
    showNwcSheet,
    closeNwcSheets,
    openNwcManager,
    hasNwcConnection,
    swapOptionList,
    swapFromValue,
    setSwapFromValue,
    swapToValue,
    setSwapToValue,
    getSwapOptionMeta,
    canToggleCurrency,
    handleTogglePrimary,
    swapPrimaryAmountText,
    swapSecondaryAmountText,
    primaryCurrency,
    handleSwapAmountKeypadInput,
    handleSwapSubmit,
    canSubmitSwap,
    swapInProgress,
    swapScenario,
    mintSwapState,
    mintSwapStatusText,
    mintSwapMessage,
    nwcFundInProgress,
    nwcFundStatusText,
    nwcFundState,
    nwcFundMessage,
    nwcFundInvoice,
    nwcWithdrawInProgress,
    nwcWithdrawStatusText,
    nwcWithdrawState,
    nwcWithdrawMessage,
    nwcWithdrawInvoice,
  } = props;

  return (
    <ActionSheet
      open={showNwcSheet}
      onClose={closeNwcSheets}
      title="Swap"
      actions={(
        <button className="ghost-button button-sm pressable" onClick={openNwcManager}>
          {hasNwcConnection ? "Manage NWC" : "Connect NWC"}
        </button>
      )}
    >
      <div className="space-y-4">
        <div className="wallet-section wallet-section--compact space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-secondary">From</div>
              {swapOptionList.length ? (
                <div className="relative">
                  <select
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                    value={swapFromValue}
                    onChange={(event) => {
                      const next = event.target.value;
                      setSwapFromValue(next);
                      if (next && next === swapToValue) {
                        setSwapToValue("");
                      }
                    }}
                  >
                    <option value="">Select source</option>
                    {swapOptionList.map((option) => {
                      const meta = getSwapOptionMeta(option.value);
                      return (
                        <option key={`swap-from-${option.value}`} value={option.value}>
                          {meta.label}
                        </option>
                      );
                    })}
                  </select>
                  <div className="pill-input pill-input--compact lightning-mint-select__display lightning-mint-select__display--compact">
                    <div className="lightning-mint-select__label">
                      {swapFromValue ? getSwapOptionMeta(swapFromValue).label : "Select source"}
                    </div>
                    <div className="lightning-mint-select__balance">
                      {swapFromValue ? getSwapOptionMeta(swapFromValue).balanceLabel : "Choose a mint or wallet"}
                    </div>
                  </div>
                  <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                </div>
              ) : (
                <div className="text-sm text-secondary">Add a mint or connect NWC to start swapping.</div>
              )}
            </div>
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-secondary">To</div>
              {swapOptionList.length ? (
                <div className="relative">
                  <select
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0 appearance-none z-10"
                    value={swapToValue}
                    onChange={(event) => {
                      const next = event.target.value;
                      setSwapToValue(next);
                      if (next && next === swapFromValue) {
                        setSwapFromValue("");
                      }
                    }}
                  >
                    <option value="">Select destination</option>
                    {swapOptionList.map((option) => {
                      const meta = getSwapOptionMeta(option.value);
                      return (
                        <option key={`swap-to-${option.value}`} value={option.value}>
                          {meta.label}
                        </option>
                      );
                    })}
                  </select>
                  <div className="pill-input pill-input--compact lightning-mint-select__display lightning-mint-select__display--compact">
                    <div className="lightning-mint-select__label">
                      {swapToValue ? getSwapOptionMeta(swapToValue).label : "Select destination"}
                    </div>
                    <div className="lightning-mint-select__balance">
                      {swapToValue ? getSwapOptionMeta(swapToValue).balanceLabel : "Choose a mint or wallet"}
                    </div>
                  </div>
                  <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                </div>
              ) : (
                <div className="text-sm text-secondary">Choose a destination mint or connect NWC.</div>
              )}
            </div>
          </div>
          <button
            type="button"
            className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
            onClick={canToggleCurrency ? handleTogglePrimary : undefined}
            disabled={!canToggleCurrency}
          >
            <div className="wallet-balance-card__amount lightning-amount-display__primary">{swapPrimaryAmountText}</div>
            <div className="wallet-balance-card__secondary lightning-amount-display__secondary">{swapSecondaryAmountText}</div>
          </button>
          <div className="grid grid-cols-3 gap-2">
            {(primaryCurrency === "usd"
              ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
              : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"]
            ).map((key) => {
              const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
              return (
                <button
                  key={`swap-key-${key}`}
                  type="button"
                  className="glass-panel pressable py-2 text-lg font-semibold"
                  onClick={() => handleSwapAmountKeypadInput(handlerKey)}
                >
                  {key === "clear" ? "Clear" : key}
                </button>
              );
            })}
          </div>
          <button
            className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
            onClick={handleSwapSubmit}
            disabled={!canSubmitSwap || swapInProgress}
          >
            {swapInProgress ? "Working…" : "Transfer"}
          </button>
          {swapScenario === "mint-to-mint" && mintSwapState !== "idle" && mintSwapState !== "error" && mintSwapStatusText && (
            <div className="text-xs text-secondary text-center">{mintSwapStatusText}</div>
          )}
          {swapScenario === "nwc-to-mint" && nwcFundInProgress && nwcFundStatusText && (
            <div className="text-xs text-secondary text-center">{nwcFundStatusText}</div>
          )}
          {swapScenario === "mint-to-nwc" && nwcWithdrawInProgress && nwcWithdrawStatusText && (
            <div className="text-xs text-secondary text-center">{nwcWithdrawStatusText}</div>
          )}
          {swapScenario === "mint-to-mint" && mintSwapState === "error" && mintSwapMessage && (
            <div className="text-xs text-rose-400 text-center">{mintSwapMessage}</div>
          )}
          {swapScenario === "nwc-to-mint" && nwcFundState === "error" && nwcFundMessage && (
            <div className="text-xs text-rose-400 text-center">{nwcFundMessage}</div>
          )}
          {swapScenario === "mint-to-nwc" && nwcWithdrawState === "error" && nwcWithdrawMessage && (
            <div className="text-xs text-rose-400 text-center">{nwcWithdrawMessage}</div>
          )}
          {swapScenario === "nwc-to-mint" && nwcFundInvoice && (
            <QrCodeCard
              className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
              value={nwcFundInvoice}
              label="Mint invoice"
              copyLabel="Copy invoice"
              size={200}
            />
          )}
          {swapScenario === "mint-to-nwc" && nwcWithdrawInvoice && (
            <QrCodeCard
              className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
              value={nwcWithdrawInvoice}
              label="Wallet invoice"
              copyLabel="Copy invoice"
              size={200}
            />
          )}
          {!swapOptionList.length && (
            <div className="text-xs text-secondary text-center">
              Add another mint or connect NWC to make a swap.
            </div>
          )}
        </div>
      </div>
    </ActionSheet>
  );
}
