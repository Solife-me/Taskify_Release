import { lazy, Suspense } from "react";
import type { CalendarInvite } from "../../domains/calendar/calendarInvitesHook";
import type { Settings } from "../../domains/tasks/settingsTypes";
import type { WalletMessageItem } from "../../types/walletMessages";

export const loadCashuWalletModal = () => import("../../components/CashuWalletModal");
const CashuWalletModal = lazy(loadCashuWalletModal);

type CashuWalletShellProps = {
  acceptInboxMessage: (id: string) => void;
  closeWallet: () => void;
  declineInboxMessage: (id: string) => void;
  dismissCalendarInvite: (invite: CalendarInvite) => void;
  dismissInboxMessage: (id: string) => void;
  formatCalendarInviteWhen: (invite: CalendarInvite) => string;
  handleCalendarInviteRsvp: (invite: CalendarInvite, status: string) => void;
  inboxPendingItems: WalletMessageItem[];
  maybeInboxMessage: (id: string) => void;
  messagesUnreadCount: number;
  markInboxMessagesRead: (ids: string[]) => void;
  openWalletBounties: () => void;
  pendingCalendarInvites: CalendarInvite[];
  setDmUnreadCount: (count: number) => void;
  setSettings: (patch: Partial<Settings>) => void;
  settings: Settings;
  showChat: boolean;
  showWalletShell: boolean;
  walletMessageItems: WalletMessageItem[];
  walletTokenStateResetNonce: number;
};

export function CashuWalletShell({
  acceptInboxMessage,
  closeWallet,
  declineInboxMessage,
  dismissCalendarInvite,
  dismissInboxMessage,
  formatCalendarInviteWhen,
  handleCalendarInviteRsvp,
  inboxPendingItems,
  maybeInboxMessage,
  messagesUnreadCount,
  markInboxMessagesRead,
  openWalletBounties,
  pendingCalendarInvites,
  setDmUnreadCount,
  setSettings,
  settings,
  showChat,
  showWalletShell,
  walletMessageItems,
  walletTokenStateResetNonce,
}: CashuWalletShellProps) {
  return (
    <Suspense fallback={null}>
      <CashuWalletModal
        open={showWalletShell}
        onClose={closeWallet}
        onOpenBounties={openWalletBounties}
        page={showChat ? "chat" : "wallet"}
        showTabSwitcher={false}
        showBottomNav
        walletConversionEnabled={settings.walletConversionEnabled}
        walletPrimaryCurrency={settings.walletPrimaryCurrency}
        setWalletPrimaryCurrency={(currency) => setSettings({ walletPrimaryCurrency: currency })}
        npubCashLightningAddressEnabled={settings.npubCashLightningAddressEnabled}
        npubCashAutoClaim={settings.npubCashLightningAddressEnabled && settings.npubCashAutoClaim}
        sentTokenStateChecksEnabled={settings.walletSentStateChecksEnabled}
        paymentRequestsEnabled={settings.walletPaymentRequestsEnabled}
        paymentRequestsBackgroundChecksEnabled={
          settings.walletPaymentRequestsEnabled && settings.walletPaymentRequestsBackgroundChecksEnabled
        }
        tokenStateResetNonce={walletTokenStateResetNonce}
        mintBackupEnabled={settings.walletMintBackupEnabled}
        contactsSyncEnabled={settings.walletContactsSyncEnabled}
        fileStorageServer={settings.fileStorageServer}
        fileServers={settings.fileServers}
        encryptedFileStorageServer={settings.encryptedFileStorageServer}
        encryptedFileServers={settings.encryptedFileServers}
        messageItems={walletMessageItems}
        messagesUnreadCount={messagesUnreadCount}
        onAcceptMessage={acceptInboxMessage}
        onMaybeMessage={maybeInboxMessage}
        onDeclineMessage={declineInboxMessage}
        onDismissMessage={dismissInboxMessage}
        onMarkMessagesRead={markInboxMessagesRead}
        inboxPendingItems={inboxPendingItems}
        pendingCalendarInvites={pendingCalendarInvites}
        onCalendarInviteRsvp={handleCalendarInviteRsvp as unknown as (invite: any, status: string) => void}
        onDismissCalendarInvite={dismissCalendarInvite}
        formatCalendarInviteWhen={formatCalendarInviteWhen}
        onDmUnreadCountChange={setDmUnreadCount}
      />
    </Suspense>
  );
}
