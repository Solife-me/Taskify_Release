// @ts-nocheck
import React from "react";
import { ActionSheet } from "../../components/ActionSheet";
import { QrCodeCard, LightningGlyph } from "./walletModalUi";
import { EcashGlyph } from "../../components/EcashGlyph";
import { isCashuTokenDetail } from "../../wallet/walletHistoryTypes";

export function WalletHistorySheet(props) {
  const {
    showHistory,
    setShowHistory,
    setExpandedHistoryId,
    historyFilterControls,
    history,
    filteredHistory,
    expandedHistoryId,
    walletConversionEnabled,
    formatRelativeTime,
    formatHistoryAmount,
    formatUsdAmount,
    resolveMintDisplay,
    deriveHistoryStatus,
    historyRedeemStates,
    historyCheckStates,
    historyMintQuoteStates,
    historyRevertState,
    handleRedeemPendingHistoryItem,
    handleCheckHistoryMintQuote,
    performTokenStateCheck,
    handleRevertHistoryToken,
    handleMarkHistoryTokenSpent,
    handleDeleteHistoryEntry,
    formatSatAmount,
    historyFilter,
  } = props;

  return (
    <ActionSheet
      open={showHistory}
      onClose={() => {
        setShowHistory(false);
        setExpandedHistoryId(null);
      }}
      title="History"
      headerEnd={historyFilterControls}
    >
      {history.length ? (
        filteredHistory.length ? (
          <>
            {historyFilterControls && (
              <div className="wallet-history__filters-inline">{historyFilterControls}</div>
            )}
            <ul className="wallet-history">
              {filteredHistory.map((entry, index) => {
                const isExpanded = expandedHistoryId === entry.id;
                const detailKind = entry.detailKind;
                const detailIsToken = isCashuTokenDetail(entry.detail, detailKind);
                const resolvedType =
                  entry.type ?? (detailKind === "invoice" ? "lightning" : detailIsToken ? "ecash" : undefined);
                const typeLabel =
                  resolvedType === "lightning" ? "Lightning" : resolvedType === "ecash" ? "Ecash" : "History";
                const timeLabel = formatRelativeTime(entry.createdAt);
                const amountLabel = formatHistoryAmount(entry);
                const fiatLabel =
                  walletConversionEnabled && entry.fiatValueUsd != null
                    ? formatUsdAmount(entry.fiatValueUsd)
                    : null;
                const mintLabel = resolveMintDisplay(entry);
                const statusInfo = deriveHistoryStatus(entry);
                const detailLabel = detailIsToken
                  ? "Cashu token"
                  : detailKind === "invoice"
                    ? "Lightning invoice"
                    : undefined;
                const copyLabel = detailIsToken
                  ? "Copy token"
                  : detailKind === "invoice"
                    ? "Copy invoice"
                    : "Copy detail";
                const redeemState = historyRedeemStates[entry.id];
                const tokenCheckState = historyCheckStates[entry.id];
                const mintQuoteState = historyMintQuoteStates[entry.id];
                const pendingAction =
                  entry.pendingTokenId && entry.pendingStatus !== "redeemed"
                    ? {
                        ariaLabel: "Redeem saved token",
                        handler: () => handleRedeemPendingHistoryItem(entry),
                        busy: redeemState?.status === "pending",
                        status: redeemState,
                      }
                    : entry.mintQuote
                      ? {
                          ariaLabel: "Refresh invoice",
                          handler: () => handleCheckHistoryMintQuote(entry),
                          busy: mintQuoteState?.status === "pending",
                          status: mintQuoteState,
                        }
                      : entry.tokenState && entry.tokenState.lastState !== "SPENT"
                        ? {
                            ariaLabel: "Check token state",
                            handler: () => performTokenStateCheck(entry),
                            busy: tokenCheckState?.status === "pending",
                            status: tokenCheckState,
                          }
                        : null;
                const showRedeemButton = entry.pendingTokenId && entry.pendingStatus !== "redeemed";
                const canMarkTokenSpent = !!entry.tokenState && entry.tokenState.lastState !== "SPENT";
                return (
                  <li
                    key={`${entry.id}-${index}`}
                    className={`wallet-history__item${isExpanded ? " wallet-history__item--open" : ""}`}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      className="wallet-history__summary"
                      onClick={() => setExpandedHistoryId(isExpanded ? null : entry.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setExpandedHistoryId(isExpanded ? null : entry.id);
                        }
                      }}
                      aria-expanded={isExpanded}
                      aria-label="Toggle history details"
                    >
                      <div className="wallet-history__icon" aria-hidden="true">
                        {resolvedType === "lightning" ? (
                          <LightningGlyph className="wallet-history__glyph" />
                        ) : (
                          <EcashGlyph className="wallet-history__glyph" />
                        )}
                      </div>
                      <div className="wallet-history__body">
                        <div className="wallet-history__title-row">
                          <span className="wallet-history__type">{typeLabel}</span>
                          {timeLabel && <span className="wallet-history__time">{timeLabel}</span>}
                        </div>
                        <div className="wallet-history__meta-row">
                          <span
                            className={`wallet-history__status${
                              statusInfo.tone ? ` wallet-history__status--${statusInfo.tone}` : ""
                            }`}
                          >
                            {statusInfo.label}
                          </span>
                          {mintLabel && <span className="wallet-history__mint">{mintLabel}</span>}
                        </div>
                      </div>
                      <div className="wallet-history__value">
                        {amountLabel && (
                          <span
                            className={`wallet-history__amount wallet-history__amount--${
                              entry.direction === "in" ? "in" : "out"
                            }`}
                          >
                            {amountLabel}
                          </span>
                        )}
                        {fiatLabel && <span className="wallet-history__fiat">{fiatLabel}</span>}
                        {pendingAction && (
                          <button
                            type="button"
                            className="wallet-history__refresh"
                            disabled={pendingAction.busy}
                            onClick={(event) => {
                              event.stopPropagation();
                              pendingAction.handler();
                            }}
                            aria-label={pendingAction.ariaLabel}
                          >
                            ↻
                          </button>
                        )}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="wallet-history__details">
                        {detailLabel && entry.detail && (
                          <QrCodeCard
                            className="wallet-history__qr"
                            value={entry.detail}
                            label={detailLabel}
                            copyLabel={copyLabel}
                            size={220}
                            enableNut16Animation={detailIsToken}
                          />
                        )}
                        <div className="wallet-history__details-grid">
                          <div className="wallet-history__metric">
                            <span>Amount</span>
                            <span className="wallet-history__metric-value">
                              {entry.amountSat != null ? formatSatAmount(entry.amountSat) : "—"}
                            </span>
                          </div>
                          {walletConversionEnabled && fiatLabel && (
                            <div className="wallet-history__metric">
                              <span>Fiat</span>
                              <span className="wallet-history__metric-value">{fiatLabel}</span>
                            </div>
                          )}
                          {(entry.feeSat ?? 0) > 0 && (
                            <div className="wallet-history__metric">
                              <span>Fee paid</span>
                              <span className="wallet-history__metric-value">
                                {formatSatAmount(entry.feeSat ?? 0)}
                              </span>
                            </div>
                          )}
                          <div className="wallet-history__metric">
                            <span>Status</span>
                            <span className="wallet-history__metric-value">{statusInfo.label}</span>
                          </div>
                          {entry.createdAt && (
                            <div className="wallet-history__metric">
                              <span>{entry.direction === "out" ? "Time sent" : "Time received"}</span>
                              <span className="wallet-history__metric-value">
                                {new Date(entry.createdAt).toLocaleString()}
                              </span>
                            </div>
                          )}
                          {mintLabel && (
                            <div className="wallet-history__metric">
                              <span>Mint</span>
                              <span className="wallet-history__metric-value">{mintLabel}</span>
                            </div>
                          )}
                        </div>
                        {entry.summary && (
                          <div className="wallet-history__detail-note">
                            {entry.summary}
                            {entry.relatedTaskTitle && (
                              <div className="wallet-history__detail-task">
                                Task: {entry.relatedTaskTitle}
                              </div>
                            )}
                          </div>
                        )}
                        {pendingAction?.status?.message && (
                          <div
                            className={`wallet-history__helper${
                              pendingAction.status.status === "error"
                                ? " wallet-history__helper--error"
                                : pendingAction.status.status === "success"
                                  ? " wallet-history__helper--success"
                                  : ""
                            }`}
                          >
                            {pendingAction.status.message}
                          </div>
                        )}
                        {showRedeemButton && (
                          <div className="wallet-history__section">
                            <div className="wallet-history__section-content">
                              <button
                                className="accent-button button-sm pressable"
                                onClick={() => handleRedeemPendingHistoryItem(entry)}
                                disabled={historyRedeemStates[entry.id]?.status === "pending"}
                              >
                                Redeem
                              </button>
                              {historyRedeemStates[entry.id]?.message && (
                                <div
                                  className={`wallet-history__helper${
                                    historyRedeemStates[entry.id]?.status === "error"
                                      ? " wallet-history__helper--error"
                                      : historyRedeemStates[entry.id]?.status === "success"
                                        ? " wallet-history__helper--success"
                                        : ""
                                  }`}
                                >
                                  {historyRedeemStates[entry.id]?.message}
                                </div>
                              )}
                            </div>
                            {entry.pendingTokenMint && (
                              <div className="wallet-history__helper">Saved mint: {entry.pendingTokenMint}</div>
                            )}
                          </div>
                        )}
                        {entry.tokenState && (
                          <div className="wallet-history__section space-y-2">
                            <div className="wallet-history__section-title">Token state</div>
                            <div className="wallet-history__section-content space-y-2 text-xs text-secondary">
                              <div className="text-tertiary break-all">Mint: {entry.tokenState.mintUrl}</div>
                              <div className="flex flex-wrap gap-2 items-center">
                                <button
                                  className="ghost-button button-sm pressable"
                                  onClick={() => performTokenStateCheck(entry)}
                                  disabled={historyCheckStates[entry.id]?.status === "pending"}
                                >
                                  Check token state
                                </button>
                                {historyCheckStates[entry.id]?.status === "pending" && <span>Checking…</span>}
                                {historyCheckStates[entry.id]?.status === "success" &&
                                  historyCheckStates[entry.id]?.message && (
                                    <span className="text-accent">{historyCheckStates[entry.id]?.message}</span>
                                  )}
                                {historyCheckStates[entry.id]?.status === "error" &&
                                  historyCheckStates[entry.id]?.message && (
                                    <span className="text-rose-400">{historyCheckStates[entry.id]?.message}</span>
                                  )}
                              </div>
                              {typeof entry.tokenState.lastCheckedAt === "number" && (
                                <div className="text-tertiary">
                                  Last checked: {new Date(entry.tokenState.lastCheckedAt).toLocaleString()}
                                </div>
                              )}
                              {entry.tokenState.lastWitnesses && Object.keys(entry.tokenState.lastWitnesses).length > 0 && (
                                <div className="space-y-1">
                                  <div className="text-tertiary">Witness data</div>
                                  {Object.entries(entry.tokenState.lastWitnesses).map(([y, witness]) => (
                                    <div key={y} className="break-all">
                                      <div className="text-tertiary">Y: {y}</div>
                                      <div>{witness}</div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        {entry.mintQuote && (
                          <div className="wallet-history__section space-y-2">
                            <div className="wallet-history__section-title">Invoice</div>
                            <div className="wallet-history__section-content space-y-1 text-xs text-secondary">
                              {entry.mintQuote.mintUrl && (
                                <div className="text-tertiary break-all">Mint: {entry.mintQuote.mintUrl}</div>
                              )}
                              <div className="text-tertiary">Amount: {formatSatAmount(entry.mintQuote.amount)}</div>
                              <div className="flex flex-wrap gap-2 items-center">
                                <button
                                  className="ghost-button button-sm pressable"
                                  onClick={() => handleCheckHistoryMintQuote(entry)}
                                  disabled={historyMintQuoteStates[entry.id]?.status === "pending"}
                                >
                                  Check invoice
                                </button>
                                {historyMintQuoteStates[entry.id]?.status === "pending" && <span>Checking…</span>}
                                {historyMintQuoteStates[entry.id]?.status === "success" &&
                                  historyMintQuoteStates[entry.id]?.message && (
                                    <span className="text-accent">{historyMintQuoteStates[entry.id]?.message}</span>
                                  )}
                                {historyMintQuoteStates[entry.id]?.status === "error" &&
                                  historyMintQuoteStates[entry.id]?.message && (
                                    <span className="text-rose-400">{historyMintQuoteStates[entry.id]?.message}</span>
                                  )}
                              </div>
                              {entry.mintQuote.createdAt && (
                                <div className="text-tertiary">
                                  Created: {new Date(entry.mintQuote.createdAt).toLocaleString()}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        {entry.revertToken && (
                          <div className="wallet-history__section space-y-2">
                            <div className="wallet-history__section-title">Revert</div>
                            <div className="wallet-history__section-content flex flex-wrap gap-2 items-center text-xs text-secondary">
                              <button
                                className="accent-button button-sm pressable"
                                onClick={() => handleRevertHistoryToken(entry)}
                                disabled={historyRevertState[entry.id]?.status === "pending"}
                              >
                                Revert token
                              </button>
                              {historyRevertState[entry.id]?.status === "pending" && <span>Redeeming…</span>}
                              {historyRevertState[entry.id]?.status === "success" && historyRevertState[entry.id]?.message && (
                                <span className="text-accent">{historyRevertState[entry.id]?.message}</span>
                              )}
                              {historyRevertState[entry.id]?.status === "error" && historyRevertState[entry.id]?.message && (
                                <span className="text-rose-400">{historyRevertState[entry.id]?.message}</span>
                              )}
                            </div>
                          </div>
                        )}
                        <div className="wallet-history__section space-y-2">
                          <div className="wallet-history__section-title">Actions</div>
                          <div className="wallet-history__section-content flex flex-wrap gap-2 items-center text-xs text-secondary">
                            {canMarkTokenSpent && (
                              <button
                                type="button"
                                className="ghost-button button-sm pressable"
                                onClick={() => handleMarkHistoryTokenSpent(entry)}
                              >
                                Mark token spent
                              </button>
                            )}
                            <button
                              type="button"
                              className="ghost-button button-sm pressable"
                              onClick={() => handleDeleteHistoryEntry(entry)}
                            >
                              Delete entry
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <div className="wallet-section text-sm text-secondary">
            {historyFilter === "pending" ? "No pending entries" : "No history yet"}
          </div>
        )
      ) : (
        <div className="wallet-section text-sm text-secondary">No history yet</div>
      )}
    </ActionSheet>
  );
}
