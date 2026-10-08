import { ChatBubbleIcon, PersonIcon, WalletGlyphIcon } from "./walletModalUi";

export type WalletModalTab = "wallet" | "messages" | "contacts";

interface WalletTabSwitcherProps {
  activeTab: WalletModalTab;
  unreadMessages: number;
  onSelectWallet: () => void;
  onSelectMessages: () => void;
  onSelectContacts: () => void;
}

export function WalletTabSwitcher({
  activeTab,
  unreadMessages,
  onSelectWallet,
  onSelectMessages,
  onSelectContacts,
}: WalletTabSwitcherProps) {
  return (
    <div className="wallet-tab-switcher">
      <div className="wallet-tab-switcher__pill">
        <button
          className={`wallet-tab-switcher__btn pressable${activeTab === "wallet" ? " wallet-tab-switcher__btn--active" : ""}`}
          onClick={onSelectWallet}
        >
          <div className="wallet-tab-switcher__icon">
            <WalletGlyphIcon className="wallet-tab-switcher__icon-svg" />
          </div>
          <div className="wallet-tab-switcher__label">Wallet</div>
        </button>
        <button
          className={`wallet-tab-switcher__btn pressable${activeTab === "messages" ? " wallet-tab-switcher__btn--active" : ""}`}
          onClick={onSelectMessages}
        >
          <div className="wallet-tab-switcher__icon">
            <ChatBubbleIcon className="wallet-tab-switcher__icon-svg" />
          </div>
          <div className="wallet-tab-switcher__label">
            Messages{unreadMessages > 0 ? ` (${unreadMessages})` : ""}
          </div>
        </button>
        <button
          className={`wallet-tab-switcher__btn pressable${activeTab === "contacts" ? " wallet-tab-switcher__btn--active" : ""}`}
          onClick={onSelectContacts}
        >
          <div className="wallet-tab-switcher__icon">
            <PersonIcon className="wallet-tab-switcher__icon-svg" />
          </div>
          <div className="wallet-tab-switcher__label">Contacts</div>
        </button>
      </div>
    </div>
  );
}
