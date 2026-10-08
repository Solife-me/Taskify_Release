import type { InboxSender, SharedTaskPayload } from "taskify-core";

import type { CalendarInvite } from "../domains/calendar/calendarInvitesHook";
import type { Settings } from "../domains/tasks/settingsTypes";
import type { WalletMessageItem } from "../types/walletMessages";
import type { PendingCalendarInvite } from "../wallet/walletModalHelpers";

export type CashuWalletPage = "wallet" | "contacts" | "chat";

export interface CashuWalletModalProps {
  open: boolean;
  onClose: () => void;
  onOpenAddress?: () => void;
  onOpenBounties?: () => void;
  page?: CashuWalletPage;
  showTabSwitcher?: boolean;
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
  npubCashLightningAddressEnabled: boolean;
  npubCashAutoClaim: boolean;
  sentTokenStateChecksEnabled: boolean;
  paymentRequestsEnabled: boolean;
  paymentRequestsBackgroundChecksEnabled: boolean;
  tokenStateResetNonce: number;
  mintBackupEnabled: boolean;
  contactsSyncEnabled: boolean;
  fileStorageServer: string;
  fileServers?: string;
  encryptedFileStorageServer?: string;
  encryptedFileServers?: string;
  messageItems: WalletMessageItem[];
  messagesUnreadCount: number;
  onAcceptMessage: (id: string) => void;
  onAddTaskAgain: (task: SharedTaskPayload, sender?: InboxSender) => void;
  onMaybeMessage: (id: string) => void;
  onDeclineMessage: (id: string) => void;
  onDismissMessage: (id: string) => void;
  onMarkMessagesRead: (dmEventIds: string[]) => void;
  inboxPendingItems?: WalletMessageItem[];
  pendingCalendarInvites?: PendingCalendarInvite[];
  onCalendarInviteRsvp?: (invite: CalendarInvite, status: string) => void;
  onDismissCalendarInvite?: (invite: CalendarInvite) => void;
  formatCalendarInviteWhen?: (invite: CalendarInvite) => string;
  onDmUnreadCountChange?: (count: number) => void;
  chatMessageRetention?: string;
}
