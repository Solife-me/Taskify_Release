import { lazy, Suspense } from "react";
import type { Settings } from "../../domains/tasks/settingsTypes";

export const loadCashuWalletModal = () => import("../../components/CashuWalletModal");
const CashuWalletModal = lazy(loadCashuWalletModal);

type CashuWalletShellProps = {
  closeWallet: () => void;
  defaultRelays: string[];
  /** The "Move funds out" page: the wallet opens at that sheet. */
  moveFundsOut: boolean;
  onMoveFundsOutClosed: () => void;
  openWalletBounties: () => void;
  onResetWalletTokenTracking: () => void;
  setSettings: (patch: Partial<Settings>) => void;
  settings: Settings;
  showWalletShell: boolean;
  walletTokenStateResetNonce: number;
};

export function CashuWalletShell({
  closeWallet,
  defaultRelays,
  moveFundsOut,
  onMoveFundsOutClosed,
  openWalletBounties,
  onResetWalletTokenTracking,
  setSettings,
  settings,
  showWalletShell,
  walletTokenStateResetNonce,
}: CashuWalletShellProps) {
  return (
    <Suspense fallback={null}>
      <CashuWalletModal
        open={showWalletShell}
        onClose={closeWallet}
        openMoveFundsOut={moveFundsOut}
        onMoveFundsOutClosed={onMoveFundsOutClosed}
        onOpenBounties={openWalletBounties}
        showBottomNav
        walletConversionEnabled={settings.walletConversionEnabled}
        walletSettings={settings}
        setWalletSettings={setSettings}
        defaultRelays={defaultRelays}
        onResetWalletTokenTracking={onResetWalletTokenTracking}
        walletPrimaryCurrency={settings.walletPrimaryCurrency}
        walletDenominationDisplay={settings.walletDenominationDisplay}
        setWalletPrimaryCurrency={(currency) => setSettings({ walletPrimaryCurrency: currency })}
        lightningAddressProvider={settings.lightningAddressProvider}
        solifeLightningAddress={settings.solifeLightningAddress}
        npubCashAutoClaim={settings.lightningAddressProvider === "npub.cash" && settings.npubCashAutoClaim}
        sentTokenStateChecksEnabled={settings.walletSentStateChecksEnabled}
        paymentRequestsEnabled={settings.walletPaymentRequestsEnabled}
        paymentRequestsBackgroundChecksEnabled={
          settings.walletPaymentRequestsEnabled && settings.walletPaymentRequestsBackgroundChecksEnabled
        }
        tokenStateResetNonce={walletTokenStateResetNonce}
        mintBackupEnabled={settings.walletMintBackupEnabled}
        fileStorageServer={settings.fileStorageServer}
      />
    </Suspense>
  );
}
