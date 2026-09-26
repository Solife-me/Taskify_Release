import { useState } from "react";
import { ActionSheet } from "../../components/ActionSheet";
import { useNwc } from "../../context/NwcContext";
import { isValidLightningAddress } from "../../hooks/wallet/useNwcWalletMode";
import { setWalletMode, type WalletMode } from "../../wallet/walletMode";

type Props = {
  showNwcManager: boolean;
  closeNwcManager: () => void;
  walletMode: WalletMode;
  formatSatAmount: (amount: number) => string;
};

export function WalletNwcManagerSheet({
  showNwcManager,
  closeNwcManager,
  walletMode,
  formatSatAmount,
}: Props) {
  const nwc = useNwc();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");
  const [receiveAddress, setReceiveAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const resetEditor = () => {
    setEditingId(null);
    setName("");
    setUri("");
    setReceiveAddress("");
    setMessage("");
  };

  const edit = (id: string) => {
    const wallet = nwc.wallets.find((entry) => entry.id === id);
    if (!wallet) return;
    setEditingId(wallet.id);
    setName(wallet.name);
    setUri(wallet.uri);
    setReceiveAddress(wallet.receiveAddress || "");
    setMessage("");
  };

  const save = async () => {
    const normalizedAddress = receiveAddress.trim().toLowerCase();
    if (normalizedAddress && !isValidLightningAddress(normalizedAddress)) {
      setMessage("Enter a lightning address like name@example.com");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await nwc.connect(uri, name, editingId || undefined, normalizedAddress || null);
      setWalletMode("nwc");
      resetEditor();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const select = (id: string) => {
    nwc.selectWallet(id);
    setWalletMode("nwc");
  };

  const activeBalance = typeof nwc.info?.balanceMsat === "number"
    ? formatSatAmount(Math.floor(nwc.info.balanceMsat / 1000))
    : null;

  return (
    <ActionSheet open={showNwcManager} onClose={busy ? () => {} : closeNwcManager} title="Wallets">
      <div className="space-y-3 text-sm">
        <button
          type="button"
          className={`wallet-picker-row pressable${walletMode === "ecash" ? " wallet-picker-row--selected" : ""}`}
          onClick={() => setWalletMode("ecash")}
        >
          <span className="wallet-picker-row__icon">₿</span>
          <span className="wallet-picker-row__copy">
            <strong>Taskify eCash</strong>
            <small>Built-in Cashu wallet</small>
          </span>
          {walletMode === "ecash" && <span className="wallet-picker-row__check">✓</span>}
        </button>

        {nwc.wallets.map((wallet) => {
          const selected = walletMode === "nwc" && wallet.id === nwc.activeWalletId;
          return (
            <div key={wallet.id} className={`wallet-picker-row${selected ? " wallet-picker-row--selected" : ""}`}>
              <button type="button" className="wallet-picker-row__main pressable" onClick={() => select(wallet.id)}>
                <span className="wallet-picker-row__icon">⚡</span>
                <span className="wallet-picker-row__copy">
                  <strong>{wallet.name}</strong>
                  <small>{wallet.receiveAddress || (wallet.id === nwc.activeWalletId ? nwc.connection?.walletLud16 : "") || "Lightning via NWC"}</small>
                  {selected && activeBalance && <small>{activeBalance} available</small>}
                </span>
                {selected && <span className="wallet-picker-row__check">✓</span>}
              </button>
              <button type="button" className="ghost-button button-sm pressable" onClick={() => edit(wallet.id)}>
                Edit
              </button>
            </div>
          );
        })}

        {editingId !== null || name || uri ? (
          <div className="wallet-section space-y-3">
            <div className="text-sm font-semibold">{editingId ? "Edit wallet" : "Connect a wallet"}</div>
            <input className="pill-input w-full" placeholder="Wallet name" value={name} onChange={(event) => setName(event.target.value)} />
            <textarea
              className="pill-input w-full min-h-24"
              placeholder="nostr+walletconnect://…"
              value={uri}
              onChange={(event) => setUri(event.target.value)}
              spellCheck={false}
            />
            <div>
              <input
                className="pill-input w-full"
                placeholder="Lightning address shown for this wallet (optional)"
                value={receiveAddress}
                onChange={(event) => setReceiveAddress(event.target.value)}
              />
              <div className="mt-1 text-xs text-secondary">Leave blank to use the address included by the wallet.</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="accent-button button-sm pressable" onClick={() => void save()} disabled={busy || !uri.trim()}>
                {busy ? "Checking…" : editingId ? "Save wallet" : "Connect"}
              </button>
              <button className="ghost-button button-sm pressable" onClick={resetEditor} disabled={busy}>Cancel</button>
              {editingId && (
                <button
                  className="ghost-button button-sm pressable text-rose-400"
                  onClick={() => {
                    if (!window.confirm("Remove this NWC wallet from Taskify?")) return;
                    nwc.removeWallet(editingId);
                    resetEditor();
                  }}
                  disabled={busy}
                >
                  Remove
                </button>
              )}
            </div>
            {message && <div className="text-xs text-rose-400">{message}</div>}
          </div>
        ) : (
          <button
            className="accent-button accent-button--tall pressable w-full"
            onClick={() => { setName("NWC wallet"); setMessage(""); }}
          >
            Connect a wallet
          </button>
        )}
      </div>
    </ActionSheet>
  );
}
