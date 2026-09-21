// @ts-nocheck
import React, { useEffect, useState } from "react";
import { ActionSheet } from "../../components/ActionSheet";
import {
  QrCodeCard,
  ChevronDownIcon,
  BackIcon,
  AnimatedEllipsis,
  formatMintDisplayName,
  trimMintUrlScheme,
} from "./walletModalUi";

export function LightningReceiveSheet(props) {
  const {
    receiveMode,
    closeReceiveLightningSheet,
    openReceiveEcashSheet,
    lightningReceiveView,
    lightningAddressProvider,
    npubCashLightningAddressEnabled,
    npubCashClaimEnabled,
    npubCashIdentity,
    npubCashClaimStatus,
    handleClaimNpubCash,
    handleCopyLightningAddress,
    lightningAddressDisplay,
    npubCashClaimMessage,
    npubCashIdentityError,
    handleOpenLightningAmountView,
    mintSelectionOptions,
    selectedMintValue,
    setMintUrl,
    mintInfoByUrl,
    selectedMintLabel,
    selectedMintBalanceLabel,
    canToggleCurrency,
    handleLightningAmountUnitToggle,
    lightningPrimaryAmountText,
    lightningSecondaryAmountText,
    primaryCurrency,
    handleLightningAmountKeypadInput,
    handleCreateInvoice,
    canCreateMintInvoice,
    creatingMintInvoice,
    mintError,
    mintQuote,
    activeMintInvoice,
    handleLightningInvoiceBack,
    lightningInvoiceStatusLabel,
    formatSatAmount,
    invoiceAmountSecondary,
    mintUrl,
    nwcMode,
    nwcWalletLabel,
    nwcReceiveAddress,
    nwcWalletLud16,
    nwcCustomAddress,
    onSaveNwcAddress,
  } = props;

  return (
    <ActionSheet
      open={receiveMode === "lightning"}
      onClose={closeReceiveLightningSheet}
      title="Receive Lightning"
      actions={nwcMode ? undefined : (
        <button
          className="ghost-button button-sm pressable"
          onClick={() => {
            closeReceiveLightningSheet();
            openReceiveEcashSheet();
          }}
        >
          ecash
        </button>
      )}
    >
      <div className="space-y-4">
        {lightningReceiveView === "address" && nwcMode && (
          <div className="space-y-4">
            <NwcReceiveAddress
              address={nwcReceiveAddress}
              walletLud16={nwcWalletLud16}
              customAddress={nwcCustomAddress}
              walletLabel={nwcWalletLabel}
              onCopy={handleCopyLightningAddress}
              onSave={onSaveNwcAddress}
            />
            <button
              type="button"
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={handleOpenLightningAmountView}
            >
              Create Invoice
            </button>
          </div>
        )}
        {lightningReceiveView === "address" && !nwcMode && (
          <div className="space-y-4">
            <div className="wallet-section space-y-4 text-center">
              {npubCashLightningAddressEnabled ? (
                npubCashIdentity ? (
                  <>
                    <div className="flex justify-center">
                      <QrCodeCard
                        value={npubCashIdentity.address}
                        label="Lightning address"
                        size={240}
                        flat
                        hideCopyButton
                        copyOnQrClick
                        onCopy={handleCopyLightningAddress}
                        className="wallet-qr-card--centered"
                      />
                    </div>
                    {npubCashClaimEnabled && (
                      <div className="flex justify-center gap-3">
                        <button
                          type="button"
                          className="ghost-button button-sm pressable"
                          onClick={() => {
                            void handleClaimNpubCash();
                          }}
                          disabled={!npubCashLightningAddressEnabled || npubCashClaimStatus === "checking"}
                        >
                          {npubCashClaimStatus === "checking" ? "Checking..." : "Redeem"}
                        </button>
                      </div>
                    )}
                    <div className="text-sm font-medium text-primary break-words">
                      {lightningAddressDisplay}
                    </div>
                    {npubCashClaimMessage && (
                      <div
                        className={`text-sm ${
                          npubCashClaimStatus === "error"
                            ? "text-rose-400"
                            : npubCashClaimStatus === "success"
                              ? "text-emerald-400"
                              : "text-secondary"
                        }`}
                      >
                        {npubCashClaimMessage}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-sm text-secondary">
                    {npubCashIdentityError ||
                      `Add your Taskify Nostr key to enable ${lightningAddressProvider === "solife.me" ? "solife.me" : "npub.cash"}.`}
                  </div>
                )
              ) : (
                <div className="text-sm text-secondary">
                  Lightning address disabled. Use Amount to create an invoice.
                </div>
              )}
            </div>
            <button
              type="button"
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={handleOpenLightningAmountView}
            >
              Create Invoice
            </button>
          </div>
        )}
        {lightningReceiveView === "amount" && (
          <div className="wallet-section space-y-5">
            <div className="space-y-2 text-left">
              <div className="text-[11px] uppercase tracking-wide text-secondary">Receive to</div>
              {nwcMode ? (
                <div className="pill-input lightning-mint-select__display">
                  <div className="lightning-mint-select__label">{nwcWalletLabel}</div>
                </div>
              ) : mintSelectionOptions.length ? (
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
                {lightningPrimaryAmountText}
              </div>
              <div className="wallet-balance-card__secondary lightning-amount-display__secondary">
                {lightningSecondaryAmountText}
              </div>
            </button>
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
                    onClick={() => handleLightningAmountKeypadInput(handlerKey)}
                  >
                    {key === "clear" ? "Clear" : key}
                  </button>
                );
              })}
            </div>
            <button
              className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
              onClick={handleCreateInvoice}
              disabled={!canCreateMintInvoice || creatingMintInvoice}
            >
              {creatingMintInvoice ? (
                <span className="inline-flex items-center gap-1">
                  Creating
                  <AnimatedEllipsis />
                </span>
              ) : (
                "Create invoice"
              )}
            </button>
            {mintError && <div className="text-sm text-rose-400 text-center">{mintError}</div>}
          </div>
        )}
        {lightningReceiveView === "invoice" && mintQuote && activeMintInvoice && (
          <div className="space-y-4">
            <div className="wallet-section space-y-4">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="flex items-center gap-2 text-secondary hover:text-primary transition-colors pressable"
                  onClick={handleLightningInvoiceBack}
                >
                  <BackIcon className="h-4 w-4" />
                  New invoice
                </button>
                <div className="text-sm font-medium text-secondary">{lightningInvoiceStatusLabel}</div>
              </div>
              <div className="flex justify-center">
                <QrCodeCard
                  value={mintQuote.request}
                  label="Lightning invoice"
                  copyLabel="Copy invoice"
                  size={240}
                />
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-secondary">Amount</span>
                  <span className="font-semibold">{formatSatAmount(activeMintInvoice.amountSat)}</span>
                </div>
                {invoiceAmountSecondary && (
                  <div className="flex items-center justify-between text-secondary">
                    <span>USD</span>
                    <span>{invoiceAmountSecondary}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-secondary">{nwcMode ? "Wallet" : "Mint"}</span>
                  <span className="font-medium break-all">
                    {nwcMode ? nwcWalletLabel : trimMintUrlScheme(mintUrl || "—")}
                  </span>
                </div>
              </div>
              {mintError && <div className="text-sm text-rose-400">{mintError}</div>}
            </div>
          </div>
        )}
      </div>
    </ActionSheet>
  );
}

/** Receive address for NWC mode: the wallet's own lud16, or one the user enters. */
function NwcReceiveAddress({ address, walletLud16, customAddress, walletLabel, onCopy, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(customAddress || "");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editing) setDraft(customAddress || "");
  }, [customAddress, editing]);

  const save = (value) => {
    try {
      onSave(value);
      setError("");
      setEditing(false);
    } catch (e) {
      setError(e?.message || String(e));
    }
  };

  if (editing || !address) {
    return (
      <div className="wallet-section space-y-3 text-left">
        <div className="text-sm text-secondary">
          {address
            ? `Show a different lightning address for ${walletLabel}.`
            : `${walletLabel} didn't share a lightning address. If it has one, enter it to show it here, or create an invoice for a specific amount.`}
        </div>
        <input
          className="pill-input w-full"
          placeholder="you@example.com"
          value={draft}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(event) => setDraft(event.target.value)}
        />
        {error && <div className="text-xs text-rose-400">{error}</div>}
        <div className="flex flex-wrap gap-2">
          <button className="accent-button button-sm pressable" onClick={() => save(draft)} disabled={!draft.trim()}>
            Save address
          </button>
          {customAddress && (
            <button className="ghost-button button-sm pressable" onClick={() => save("")}>
              {walletLud16 ? `Use ${walletLud16}` : "Remove address"}
            </button>
          )}
          {editing && (
            <button className="ghost-button button-sm pressable" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="wallet-section space-y-4 text-center">
      <div className="flex justify-center">
        <QrCodeCard
          value={address}
          label="Lightning address"
          size={240}
          flat
          hideCopyButton
          copyOnQrClick
          onCopy={onCopy}
          className="wallet-qr-card--centered"
        />
      </div>
      <div className="text-sm font-medium text-primary break-words">{address}</div>
      <div className="text-xs text-secondary">Payments go to {walletLabel}.</div>
      <button className="ghost-button button-sm pressable" onClick={() => setEditing(true)}>
        Change address
      </button>
    </div>
  );
}
