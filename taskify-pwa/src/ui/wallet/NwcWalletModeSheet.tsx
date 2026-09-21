import { useMemo, useState } from "react";
import { ActionSheet } from "../../components/ActionSheet";
import { AnimatedEllipsis, formatMintDisplayName } from "./walletModalUi";
import type { SweepJournal, SweepSourceStatus } from "../../wallet/nwcSweep";
import { summarizeSweepJournal } from "../../wallet/nwcSweep";
import type { MintBalance } from "../../hooks/wallet/useNwcSweeps";
import type { WalletMode } from "../../wallet/walletMode";

const REQUIRED_METHODS = ["pay_invoice", "make_invoice"];

const STATUS_LABEL: Record<SweepSourceStatus, string> = {
  pending: "Waiting",
  in_progress: "Moving…",
  swept: "Moved",
  dust: "Too small to move",
  awaiting_settlement: "Payment still settling",
  failed: "Not moved",
};

type Props = {
  open: boolean;
  onClose: () => void;
  mode: WalletMode;
  hasConnection: boolean;
  walletLabel: string;
  walletMethods?: string[];
  mintBalances: MintBalance[];
  journal: SweepJournal | null;
  migrationError: string;
  busy: boolean;
  formatSatAmount: (amount: number) => string;
  onOpenNwcManager: () => void;
  onMigrate: () => Promise<SweepJournal | null>;
  onSwitch: (mode: WalletMode) => void;
};

export function NwcWalletModeSheet({
  open,
  onClose,
  mode,
  hasConnection,
  walletLabel,
  walletMethods,
  mintBalances,
  journal,
  migrationError,
  busy,
  formatSatAmount,
  onOpenNwcManager,
  onMigrate,
  onSwitch,
}: Props) {
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);

  const ecashSat = useMemo(() => mintBalances.reduce((sum, entry) => sum + entry.sat, 0), [mintBalances]);
  const missingMethods = useMemo(
    () => (walletMethods ? REQUIRED_METHODS.filter((method) => !walletMethods.includes(method)) : []),
    [walletMethods],
  );
  const canLookup = !walletMethods || walletMethods.includes("lookup_invoice");

  // Show a run's results for the run started here, or any run that didn't finish.
  const visibleJournal = journal && (journal.runId === lastRunId || journal.status !== "completed") ? journal : null;
  const summary = visibleJournal ? summarizeSweepJournal(visibleJournal) : null;
  // The last run found nothing that could cover a lightning fee; retrying won't help.
  const onlyDustLeft =
    !!visibleJournal &&
    visibleJournal.status === "completed" &&
    visibleJournal.sources.every((source) => source.status === "dust" || (source.remainingSat ?? 0) === 0);

  const migrate = async () => {
    setConfirmSkip(false);
    const result = await onMigrate();
    if (!result) return;
    setLastRunId(result.runId);
    if (result.status === "completed" && mode === "ecash") onSwitch("nwc");
  };

  const walletName = <span className="font-semibold text-primary">{walletLabel}</span>;

  const body = (() => {
    if (!hasConnection) {
      return (
        <div className="space-y-4">
          <div className="wallet-section space-y-2 text-sm text-secondary">
            <p>
              Use an external lightning wallet over Nostr Wallet Connect (NWC) instead of this app's ecash wallet.
              Payments you send and receive go straight to that wallet.
            </p>
            <p>First connect the wallet with its NWC connection string.</p>
          </div>
          <button className="accent-button accent-button--tall pressable w-full" onClick={onOpenNwcManager}>
            Connect NWC wallet
          </button>
        </div>
      );
    }

    if (missingMethods.length) {
      return (
        <div className="wallet-section space-y-3 text-sm">
          <div className="text-rose-400">
            {walletLabel} doesn't allow {missingMethods.join(" and ")}, which this app needs to send and receive.
          </div>
          <div className="text-secondary">
            Create a new connection in your wallet with send and receive permissions, then update it here.
          </div>
          <button className="ghost-button button-sm pressable" onClick={onOpenNwcManager}>
            Update connection
          </button>
        </div>
      );
    }

    const progress = visibleJournal && (
      <div className="wallet-section space-y-3 text-sm">
        <div className="text-[11px] uppercase tracking-wide text-secondary">Transfer to {walletLabel}</div>
        {visibleJournal.sources.map((source) => (
          <div key={source.sourceId} className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate">{formatMintDisplayName(source.sourceId)}</span>
              <span className={source.status === "failed" ? "text-rose-400" : "text-secondary"}>
                {STATUS_LABEL[source.status]}
              </span>
            </div>
            {source.sentSat > 0 && (
              <div className="text-xs text-secondary">
                Sent {formatSatAmount(source.sentSat)}
                {source.feesSat > 0 ? ` · fees ${formatSatAmount(source.feesSat)}` : ""}
                {source.remainingSat ? ` · ${formatSatAmount(source.remainingSat)} left in ecash` : ""}
              </div>
            )}
            {source.status === "awaiting_settlement" && (
              <div className="text-xs text-secondary">
                The mint hasn't finished this payment. Your funds are safe; check again in a few minutes.
              </div>
            )}
            {source.error && <div className="text-xs text-rose-400">{source.error}</div>}
          </div>
        ))}
        {summary && visibleJournal.status !== "running" && summary.sentSat > 0 && (
          <div className="border-t border-white/10 pt-2 text-xs text-secondary">
            Moved {formatSatAmount(summary.sentSat)} in total
            {summary.feesSat > 0 ? `, ${formatSatAmount(summary.feesSat)} in fees` : ""}.
            {summary.remainingSat > 0 &&
              ` ${formatSatAmount(summary.remainingSat)} of returned fee reserve stays in the ecash wallet.`}
          </div>
        )}
        {summary && summary.unconfirmedSat > 0 && visibleJournal.status !== "running" && (
          <div className="text-xs text-amber-400">
            The mint reports {formatSatAmount(summary.unconfirmedSat)} as paid, but {walletLabel} hasn't confirmed
            receiving it. Check {walletLabel}'s history.
          </div>
        )}
      </div>
    );

    if (mode === "nwc") {
      return (
        <div className="space-y-4">
          <div className="wallet-section text-sm text-secondary">
            You're using {walletName} for payments. The ecash wallet and its recovery seed are kept; switch back any
            time.
          </div>
          {progress}
          {ecashSat > 0 && (
            <div className="wallet-section space-y-3 text-sm">
              <div className="text-secondary">
                {formatSatAmount(ecashSat)} is still in the ecash wallet
                {onlyDustLeft ? ", too little to cover a lightning fee. Switch back to spend it as ecash." : "."}
              </div>
              {!onlyDustLeft && (
                <button className="accent-button button-sm pressable" onClick={migrate} disabled={busy}>
                  {busy ? <span>Moving<AnimatedEllipsis /></span> : `Move ${formatSatAmount(ecashSat)} to ${walletLabel}`}
                </button>
              )}
            </div>
          )}
          {migrationError && <div className="text-sm text-rose-400">{migrationError}</div>}
          <button className="ghost-button pressable w-full" onClick={() => onSwitch("ecash")} disabled={busy}>
            Switch back to ecash wallet
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="wallet-section space-y-2 text-sm text-secondary">
          <p>
            Switch to {walletName}? Sending and receiving will use it, and only lightning payments will show. Ecash
            sent to you will be kept as tokens you can move to {walletLabel} or redeem elsewhere.
          </p>
          {!canLookup && (
            <p>This connection can't look up invoices, so incoming payments won't be confirmed automatically.</p>
          )}
        </div>

        {ecashSat > 0 ? (
          <>
            <div className="wallet-section space-y-2 text-sm">
              <div className="text-[11px] uppercase tracking-wide text-secondary">Ecash balance</div>
              {mintBalances.map((entry) => (
                <div key={entry.mintUrl} className="flex items-center justify-between gap-3">
                  <span className="truncate">{formatMintDisplayName(entry.mintUrl)}</span>
                  <span className="font-medium">{formatSatAmount(entry.sat)}</span>
                </div>
              ))}
              <div className="text-xs text-secondary">
                Moving pays each mint's lightning fee. A few sats of returned fee reserve may stay in ecash.
              </div>
            </div>
            {progress}
            <button className="accent-button accent-button--tall pressable w-full" onClick={migrate} disabled={busy}>
              {busy ? (
                <span className="inline-flex items-center gap-1">Moving<AnimatedEllipsis /></span>
              ) : visibleJournal && visibleJournal.status !== "completed" ? (
                "Try again"
              ) : (
                `Move ${formatSatAmount(ecashSat)} and switch`
              )}
            </button>
            {migrationError && <div className="text-sm text-rose-400">{migrationError}</div>}
            {confirmSkip ? (
              <div className="wallet-section space-y-3 text-sm">
                <div className="text-secondary">
                  Your {formatSatAmount(ecashSat)} stays in this app's ecash wallet. You won't see it while using{" "}
                  {walletLabel}; switch back to spend or move it.
                </div>
                <div className="flex gap-2">
                  <button className="accent-button button-sm pressable" onClick={() => onSwitch("nwc")} disabled={busy}>
                    Switch without moving
                  </button>
                  <button className="ghost-button button-sm pressable" onClick={() => setConfirmSkip(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button className="ghost-button pressable w-full" onClick={() => setConfirmSkip(true)} disabled={busy}>
                Switch without moving funds
              </button>
            )}
          </>
        ) : (
          <>
            {progress}
            <button
              className="accent-button accent-button--tall pressable w-full"
              onClick={() => onSwitch("nwc")}
              disabled={busy}
            >
              Use {walletLabel}
            </button>
          </>
        )}
      </div>
    );
  })();

  return (
    <ActionSheet open={open} onClose={busy ? () => {} : onClose} title="Wallet">
      {body}
    </ActionSheet>
  );
}
