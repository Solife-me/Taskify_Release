import type { Settings } from "../../domains/tasks/settingsTypes";
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
      </div>
    </ActionSheet>
  );
}
