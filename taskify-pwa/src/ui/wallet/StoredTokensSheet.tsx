import { useEffect, useMemo, useState } from "react";
import { ActionSheet } from "../../components/ActionSheet";
import { AnimatedEllipsis, formatMintDisplayName } from "./walletModalUi";
import type { PendingTokenEntry } from "../../wallet/storage";
import type { StoredTokenState } from "../../hooks/wallet/useNwcSweeps";

type Props = {
  open: boolean;
  onClose: () => void;
  walletLabel: string;
  tokens: PendingTokenEntry[];
  tokenStates: Record<string, StoredTokenState>;
  tokenError: string;
  busy: boolean;
  formatSatAmount: (amount: number) => string;
  onCheck: () => void;
  onSweep: (ids: string[]) => void;
  onCopy: (token: string) => void;
  onDelete: (id: string) => void;
};

function stateLabel(state: StoredTokenState | undefined, formatSatAmount: (n: number) => string) {
  if (!state || state.status === "checking") return { text: "Checking…", tone: "text-secondary" };
  if (state.status === "error") return { text: "Couldn't reach mint", tone: "text-amber-400" };
  if (state.spendableSat === 0) return { text: "Already claimed", tone: "text-secondary" };
  if (state.spentSat > 0) return { text: `${formatSatAmount(state.spentSat)} already claimed`, tone: "text-amber-400" };
  return { text: "Unclaimed", tone: "text-emerald-400" };
}

export function StoredTokensSheet({
  open,
  onClose,
  walletLabel,
  tokens,
  tokenStates,
  tokenError,
  busy,
  formatSatAmount,
  onCheck,
  onSweep,
  onCopy,
  onDelete,
}: Props) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (open) onCheck();
    if (!open) setConfirmDeleteId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sweepable = useMemo(
    () =>
      tokens.filter((entry) => {
        const state = tokenStates[entry.id];
        return state?.status === "ready" && state.spendableSat > 0;
      }),
    [tokenStates, tokens],
  );
  const sweepableSat = sweepable.reduce((sum, entry) => {
    const state = tokenStates[entry.id];
    return sum + (state?.status === "ready" ? state.spendableSat : 0);
  }, 0);

  return (
    <ActionSheet open={open} onClose={busy ? () => {} : onClose} title="Ecash tokens">
      <div className="space-y-4">
        <div className="wallet-section text-sm text-secondary">
          Ecash sent to you is kept here as tokens, not claimed into a wallet. Move them to {walletLabel}, or copy a
          token to redeem it in another ecash wallet.
        </div>

        {tokens.length === 0 ? (
          <div className="wallet-section text-sm text-secondary text-center">No ecash tokens.</div>
        ) : (
          <>
            <button
              className="accent-button accent-button--tall pressable w-full"
              disabled={busy || sweepable.length === 0}
              onClick={() => onSweep(sweepable.map((entry) => entry.id))}
            >
              {busy ? (
                <span className="inline-flex items-center gap-1">Moving<AnimatedEllipsis /></span>
              ) : sweepable.length ? (
                `Move ${formatSatAmount(sweepableSat)} to ${walletLabel}`
              ) : (
                "Nothing to move"
              )}
            </button>
            {tokenError && <div className="text-sm text-rose-400">{tokenError}</div>}

            <div className="space-y-2">
              {tokens.map((entry) => {
                const state = tokenStates[entry.id];
                const label = stateLabel(state, formatSatAmount);
                const canSweep = state?.status === "ready" && state.spendableSat > 0;
                const unclaimedSat = state?.status === "ready" ? state.spendableSat : null;
                return (
                  <div key={entry.id} className="wallet-section space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">
                        {typeof entry.amount === "number" ? formatSatAmount(entry.amount) : "Token"}
                      </span>
                      <span className={`text-xs ${label.tone}`}>{label.text}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs text-secondary">
                      <span className="truncate">{formatMintDisplayName(entry.mint)}</span>
                      <span>{new Date(entry.addedAt).toLocaleDateString()}</span>
                    </div>
                    {confirmDeleteId === entry.id ? (
                      <div className="space-y-2">
                        <div className="text-xs text-rose-400">
                          {unclaimedSat
                            ? `This token still holds ${formatSatAmount(unclaimedSat)}. Deleting it loses those funds unless you've copied it. Delete anyway?`
                            : "Remove this token from the list?"}
                        </div>
                        <div className="flex gap-2">
                          <button
                            className="ghost-button button-sm pressable text-rose-400"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              onDelete(entry.id);
                            }}
                          >
                            Delete
                          </button>
                          <button className="ghost-button button-sm pressable" onClick={() => setConfirmDeleteId(null)}>
                            Keep
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="ghost-button button-sm pressable"
                          disabled={busy || !canSweep}
                          onClick={() => onSweep([entry.id])}
                        >
                          Move to {walletLabel}
                        </button>
                        <button className="ghost-button button-sm pressable" onClick={() => onCopy(entry.token)}>
                          Copy token
                        </button>
                        <button
                          className="ghost-button button-sm pressable"
                          disabled={busy}
                          onClick={() => setConfirmDeleteId(entry.id)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button className="ghost-button button-sm pressable" onClick={onCheck} disabled={busy}>
              Refresh status
            </button>
          </>
        )}
      </div>
    </ActionSheet>
  );
}
