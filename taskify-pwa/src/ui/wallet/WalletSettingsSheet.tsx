import { useMemo, useState } from "react";
import type { Settings } from "../../domains/tasks/settingsTypes";
import { checkWalletCloseOut, closeOutWallet } from "../../wallet/walletAvailability";
import { ActionSheet } from "../../components/ActionSheet";
import { WalletSection } from "../settings/WalletSection";

type Props = {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  defaultRelays: string[];
  onResetWalletTokenTracking: () => void;
  onOpenWallets: () => void;
  onOpenAddress: () => void;
  onOpenSwap: () => void;
  onOpenMints: () => void;
};

export function WalletSettingsSheet({
  open,
  onClose,
  settings,
  setSettings,
  defaultRelays,
  onResetWalletTokenTracking,
  onOpenWallets,
  onOpenAddress,
  onOpenSwap,
  onOpenMints,
}: Props) {
  const row = (title: string, detail: string, icon: string, action: () => void) => (
    <button type="button" className="wallet-settings-row pressable" onClick={action}>
      <span className="wallet-settings-row__icon" aria-hidden="true">{icon}</span>
      <span className="wallet-settings-row__copy"><strong>{title}</strong><small>{detail}</small></span>
      <span className="wallet-settings-row__chevron" aria-hidden="true">›</span>
    </button>
  );

  return (
    <ActionSheet open={open} onClose={onClose} title="Wallet Settings">
      <div className="space-y-3">
        {row("Wallets", "Add and switch between eCash and NWC", "◫", onOpenWallets)}
        {row("Lightning Address", "Choose what Receive shows for each wallet", "@", onOpenAddress)}
        {row("Swap", "Move funds between wallets", "⇄", onOpenSwap)}
        {row("Mints", "Manage eCash balances", "▤", onOpenMints)}
        <WalletSection
          settings={settings}
          setSettings={setSettings}
          defaultRelays={defaultRelays}
          onReloadNeeded={() => window.location.reload()}
          onResetWalletTokenTracking={onResetWalletTokenTracking}
          initiallyExpanded
        />
        {open && <WalletCloseOutSection onClosed={onClose} />}
      </div>
    </ActionSheet>
  );
}

/** Lets a user who has moved everything out return this device to the no-wallet state. */
function WalletCloseOutSection({ onClosed }: { onClosed: () => void }) {
  const check = useMemo(() => checkWalletCloseOut(), []);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const canClose = check.blockers.length === 0;

  return (
    <section className="wallet-section space-y-2 text-sm">
      <div className="font-semibold text-primary">Close out wallet</div>
      <p className="text-xs text-secondary">
        The Taskify wallet is being phased out. Once all your funds have been moved out, close it to remove the
        wallet from Taskify on this device.
      </p>
      {!canClose && (
        <div className="space-y-1 text-xs text-secondary">
          <div>Move these first:</div>
          <ul className="list-disc pl-5">
            {check.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}
      {canClose && confirming && (
        <div className="space-y-2 text-xs text-secondary">
          {check.unclaimedSentSat > 0 && (
            <p>
              {check.unclaimedSentSat.toLocaleString()} sats are in tokens you sent that haven&apos;t been redeemed yet. If
              they&apos;re never claimed, you can recover them by restoring your seed phrase in another Cashu wallet.
            </p>
          )}
          <p>
            Your seed phrase stays on this device. The wallet comes back automatically if funds ever arrive here
            again.
          </p>
        </div>
      )}
      {error && <div className="text-xs text-rose-500">{error}</div>}
      <div className="flex gap-2">
        {confirming && (
          <button type="button" className="ghost-button button-sm pressable" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="ghost-button button-sm pressable text-rose-500"
          disabled={!canClose}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            try {
              closeOutWallet();
              onClosed();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          {confirming ? "Close wallet" : "Close out wallet"}
        </button>
      </div>
    </section>
  );
}
