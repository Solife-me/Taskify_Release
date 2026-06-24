// @ts-nocheck
import React from "react";
import { ActionSheet } from "../../components/ActionSheet";

export function WalletNwcManagerSheet(props) {
  const {
    showNwcManager,
    closeNwcManager,
    hasNwcConnection,
    nwcAlias,
    nwcConnection,
    nwcInfo,
    nwcBalanceSats,
    nwcStatusLabel,
    nwcUrlInput,
    setNwcUrlInput,
    nwcBusy,
    nwcFeedback,
    nwcError,
    formatSatAmount,
    handleNwcConnect,
    handleNwcTest,
    handleNwcDisconnect,
  } = props;

  return (
    <ActionSheet
      open={showNwcManager}
      onClose={closeNwcManager}
      title="Manage NWC"
    >
      <div className="space-y-4 text-sm">
        {hasNwcConnection ? (
          <div className="wallet-section space-y-2 text-xs text-secondary">
            {nwcAlias && <div className="text-sm font-semibold text-primary">{nwcAlias}</div>}
            {nwcConnection?.walletLud16 && <div>{nwcConnection.walletLud16}</div>}
            <div className="break-all">Wallet npub: {nwcConnection?.walletNpub}</div>
            <div className="break-all">Client npub: {nwcConnection?.clientNpub}</div>
            <div className="break-all">Relay{(nwcConnection?.relayUrls?.length || 0) > 1 ? 's' : ''}: {nwcConnection?.relayUrls.join(", ")}</div>
            {nwcInfo?.methods && nwcInfo.methods.length > 0 && (
              <div>Methods: {nwcInfo.methods.join(", ")}</div>
            )}
            {nwcBalanceSats !== null && <div>Balance: {formatSatAmount(nwcBalanceSats)}</div>}
            <div>Status: {nwcStatusLabel}</div>
          </div>
        ) : (
          <div className="wallet-section text-sm text-secondary">Paste your NWC connection string (nostr+walletconnect://…) to link an external wallet.</div>
        )}

        <div className="wallet-section space-y-3">
          <input
            className="pill-input w-full"
            placeholder="nostr+walletconnect://npub...?relay=wss://...&secret=..."
            value={nwcUrlInput}
            onChange={(e)=>setNwcUrlInput(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              className="accent-button button-sm pressable"
              onClick={handleNwcConnect}
              disabled={nwcBusy || !nwcUrlInput.trim()}
            >{hasNwcConnection ? "Update connection" : "Connect"}</button>
            <button
              className="ghost-button button-sm pressable"
              onClick={handleNwcTest}
              disabled={nwcBusy || !hasNwcConnection}
            >Test</button>
            <button
              className="ghost-button button-sm pressable"
              onClick={handleNwcDisconnect}
              disabled={nwcBusy || !hasNwcConnection}
            >Disconnect</button>
          </div>
          {nwcBusy && <div className="text-xs text-secondary">Working…</div>}
          {nwcFeedback && <div className="text-xs text-secondary">{nwcFeedback}</div>}
          {nwcError && <div className="text-xs text-rose-400">{nwcError}</div>}
        </div>
      </div>
    </ActionSheet>
  );
}
