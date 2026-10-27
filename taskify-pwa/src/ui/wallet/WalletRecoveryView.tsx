/**
 * After the Taskify wallet closed (December 1, 2026), devices that had it show this instead:
 * everything left in it as tokens to paste into another Cashu wallet, and the 12 words those
 * wallets can restore from. Reads stored data only; no mint is contacted (C6-2).
 */
import { useMemo, useState } from "react";
import { useToast } from "../../context/ToastContext";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_WALLET } from "../../storage/taskifyDb";
import { listPendingTokens, loadStore } from "../../wallet/storage";
import { collectRecoverableFunds, type RecoverableToken } from "../../wallet/walletRecovery";
import { walletRemovalDateLabel } from "../../wallet/walletPhaseOut";
import { formatMintDisplayName } from "../../wallet/mintDisplayName";

function readHistory(): unknown {
  try {
    return JSON.parse(idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashuHistory") || "[]");
  } catch {
    return [];
  }
}

function sats(amount: number): string {
  return `${amount.toLocaleString()} sat${amount === 1 ? "" : "s"}`;
}

export function WalletRecoveryView() {
  const { show: showToast } = useToast();
  const funds = useMemo(
    () => collectRecoverableFunds({ proofStore: loadStore(), pendingTokens: listPendingTokens(), history: readHistory() }),
    [],
  );
  const [seedWords, setSeedWords] = useState<string | null>(null);
  const [seedError, setSeedError] = useState("");

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      showToast("Token copied. Paste it into Cashu.me, Minibits or another Cashu wallet.", 3200);
    } catch {
      showToast("Unable to copy the token", 2400);
    }
  };

  const revealSeed = async () => {
    try {
      const seed = await import("../../wallet/seed");
      await seed.initWalletSeedStore();
      // Never creates a seed: only an existing one is shown.
      const existing = seed.getExistingWalletSeedBackup();
      if (existing) setSeedWords(existing.mnemonic);
      else setSeedError("This device has no wallet seed.");
    } catch {
      setSeedError("This device has no wallet seed.");
    }
  };

  const tokenRow = (entry: RecoverableToken) => (
    <div key={entry.id} className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm truncate">{entry.label}</div>
        <div className="text-xs text-secondary">
          {entry.sat > 0 ? sats(entry.sat) : "Amount unknown"}
          {entry.mintUrl ? ` · ${formatMintDisplayName(entry.mintUrl)}` : ""}
        </div>
      </div>
      <button type="button" className="ghost-button button-sm pressable shrink-0" onClick={() => copy(entry.token)}>
        Copy
      </button>
    </div>
  );

  const mintUrls = Array.from(new Set([...funds.mints, ...funds.savedTokens].map((entry) => entry.mintUrl).filter(Boolean)));

  return (
    <div className="space-y-4 max-w-xl">
      <div className="wallet-section space-y-1 text-sm text-secondary">
        <div className="text-base font-semibold text-primary">Recover your wallet funds</div>
        <p>
          The Taskify wallet closed on {walletRemovalDateLabel()}. Anything left in it is still yours: copy it into
          another Cashu wallet, such as Cashu.me or Minibits.
        </p>
        <p className="text-primary font-medium">
          {funds.totalSat > 0 ? `${sats(funds.totalSat)} to recover` : "No funds were left in this wallet."}
        </p>
      </div>

      {funds.mints.length > 0 && (
        <div className="wallet-section space-y-2">
          <div className="text-sm font-medium">Wallet balance</div>
          <div className="text-xs text-secondary">One token per mint. Paste each into another Cashu wallet to claim it.</div>
          {funds.mints.map((mint) =>
            tokenRow({ id: mint.mintUrl, mintUrl: mint.mintUrl, sat: mint.sat, token: mint.token, label: formatMintDisplayName(mint.mintUrl) }),
          )}
        </div>
      )}

      {funds.savedTokens.length > 0 && (
        <div className="wallet-section space-y-2">
          <div className="text-sm font-medium">Saved tokens</div>
          <div className="text-xs text-secondary">Tokens the wallet was keeping to redeem later.</div>
          {funds.savedTokens.map(tokenRow)}
        </div>
      )}

      {funds.sentTokens.length > 0 && (
        <div className="wallet-section space-y-2">
          <div className="text-sm font-medium">Tokens you sent</div>
          <div className="text-xs text-secondary">
            If nobody has claimed one of these yet, you can still take it back by redeeming it yourself.
          </div>
          {funds.sentTokens.map(tokenRow)}
        </div>
      )}

      <div className="wallet-section space-y-2">
        <div className="text-sm font-medium">Restore from your 12 words</div>
        <div className="text-xs text-secondary">
          Cashu wallets that support seed restore (NUT-13) can recover funds from your 12 words and the mints you used,
          including change from a payment that was still settling. Keep the words private: anyone with them can take the
          funds. Ecash bounties on tasks are recovered from the task itself.
        </div>
        {seedWords ? (
          <div className="space-y-2">
            <div className="font-mono text-sm break-words select-all">{seedWords}</div>
            {mintUrls.length > 0 && (
              <ul className="text-xs text-secondary space-y-0.5">
                {mintUrls.map((url) => (
                  <li key={url} className="break-all">{url}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <button type="button" className="ghost-button button-sm pressable" onClick={() => void revealSeed()}>
            Show my 12 words
          </button>
        )}
        {seedError && <div className="text-xs text-secondary">{seedError}</div>}
      </div>
    </div>
  );
}
