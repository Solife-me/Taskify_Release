import type { Settings } from "../domains/tasks/settingsTypes";

export interface CashuWalletModalProps {
  open: boolean;
  onClose: () => void;
  /** Open straight into "Move funds out" (the phase-out notice links here). */
  openMoveFundsOut?: boolean;
  onMoveFundsOutClosed?: () => void;
  onOpenBounties?: () => void;
  showBottomNav?: boolean;
  walletConversionEnabled: boolean;
  walletSettings: Settings;
  setWalletSettings: (patch: Partial<Settings>) => void;
  defaultRelays: string[];
  onResetWalletTokenTracking: () => void;
  walletPrimaryCurrency: "sat" | "usd";
  walletDenominationDisplay: "bitcoin-symbol" | "sat";
  setWalletPrimaryCurrency: (currency: "sat" | "usd") => void;
  lightningAddressProvider?: "solife.me" | "npub.cash" | "none";
  solifeLightningAddress?: string;
  npubCashAutoClaim: boolean;
  sentTokenStateChecksEnabled: boolean;
  paymentRequestsEnabled: boolean;
  paymentRequestsBackgroundChecksEnabled: boolean;
  tokenStateResetNonce: number;
  mintBackupEnabled: boolean;
  fileStorageServer: string;
}
