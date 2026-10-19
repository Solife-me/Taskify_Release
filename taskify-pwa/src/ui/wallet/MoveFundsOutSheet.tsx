/**
 * "Move funds out": every way to take money out of the phasing-out Taskify wallet, in one place.
 * Lightning to the user's own wallet, each mint's funds as an ecash token to paste into another
 * Cashu wallet, a sweep to a connected NWC wallet, claiming what is still waiting at npub.cash,
 * and, as a last resort, the 12 words another Cashu wallet can restore from.
 */
import { useEffect, useState } from "react";
import { ActionSheet } from "../../components/ActionSheet";
import { formatMintDisplayName } from "./walletModalUi";

export type MintBalance = { mintUrl: string; sat: number };

type Props = {
  open: boolean;
  onClose: () => void;
  removalDateLabel: string;
  mints: MintBalance[];
  formatSatAmount: (amount: number) => string;
  /** The mint whose funds are being turned into a token, while that runs. */
  busyMint: string | null;
  error: string;
  onSendLightning: () => void;
  onExportMint: (mintUrl: string) => void;
  nwcAvailable: boolean;
  onSendNwc: () => void;
  npubCashAvailable: boolean;
  onClaimNpubCash: () => void;
  /** The wallet's 12 words, or null when there is no seed. */
  revealSeed: () => string | null;
};

export function MoveFundsOutSheet({
  open,
  onClose,
  removalDateLabel,
  mints,
  formatSatAmount,
  busyMint,
  error,
  onSendLightning,
  onExportMint,
  nwcAvailable,
  onSendNwc,
  npubCashAvailable,
  onClaimNpubCash,
  revealSeed,
}: Props) {
  const [seedWords, setSeedWords] = useState<string | null>(null);
  useEffect(() => {
    if (!open) setSeedWords(null);
  }, [open]);

  const funded = mints.filter((mint) => mint.sat > 0);
  const total = funded.reduce((sum, mint) => sum + mint.sat, 0);

  return (
    <ActionSheet open={open} onClose={busyMint ? () => {} : onClose} title="Move funds out">
      <div className="space-y-4">
        <div className="wallet-section text-sm text-secondary space-y-1">
          <p>
            The Taskify wallet closes on {removalDateLabel}. It no longer takes in new funds; move what it holds to a
            wallet you will keep.
          </p>
          <p className="text-primary font-medium">{total > 0 ? `${formatSatAmount(total)} to move` : "Nothing left to move."}</p>
        </div>

        <div className="wallet-section space-y-2">
          <div className="text-sm font-medium">To a Lightning wallet</div>
          <div className="text-xs text-secondary">Pay an invoice or Lightning address from your own wallet.</div>
          <button type="button" className="accent-button button-sm pressable" onClick={onSendLightning} disabled={total <= 0}>
            Send with Lightning
          </button>
        </div>

        {funded.length > 0 && (
          <div className="wallet-section space-y-2">
            <div className="text-sm font-medium">As ecash, to another Cashu wallet</div>
            <div className="text-xs text-secondary">
              Turns each mint's funds into one token to paste into Cashu.me, Minibits or another Cashu wallet. Until it is
              claimed, you can take it back from History.
            </div>
            {funded.map((mint) => (
              <div key={mint.mintUrl} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm truncate">{formatMintDisplayName(mint.mintUrl)}</div>
                  <div className="text-xs text-secondary">{formatSatAmount(mint.sat)}</div>
                </div>
                <button
                  type="button"
                  className="ghost-button button-sm pressable shrink-0"
                  onClick={() => onExportMint(mint.mintUrl)}
                  disabled={!!busyMint}
                >
                  {busyMint === mint.mintUrl ? "Making token…" : "Make token"}
                </button>
              </div>
            ))}
          </div>
        )}

        {(nwcAvailable || npubCashAvailable) && (
          <div className="wallet-section space-y-2">
            {nwcAvailable && (
              <button type="button" className="ghost-button button-sm pressable w-full" onClick={onSendNwc}>
                Send to your connected wallet (NWC)
              </button>
            )}
            {npubCashAvailable && (
              <button type="button" className="ghost-button button-sm pressable w-full" onClick={onClaimNpubCash}>
                Claim funds waiting at npub.cash
              </button>
            )}
          </div>
        )}

        <div className="wallet-section space-y-2">
          <div className="text-sm font-medium">Restore in another Cashu wallet</div>
          <div className="text-xs text-secondary">
            Cashu wallets that support seed restore (NUT-13), such as Cashu.me and Minibits, can recover these funds from
            your 12 words and the mints below. Keep the words private: anyone with them can take the funds.
          </div>
          {seedWords ? (
            <div className="space-y-2">
              <div className="font-mono text-sm break-words select-all">{seedWords}</div>
              <ul className="text-xs text-secondary space-y-0.5">
                {mints.map((mint) => (
                  <li key={mint.mintUrl} className="break-all">{mint.mintUrl}</li>
                ))}
              </ul>
            </div>
          ) : (
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => setSeedWords(revealSeed() ?? "This wallet has no seed.")}
            >
              Show my 12 words
            </button>
          )}
        </div>

        {error && <div className="text-xs text-rose-400">{error}</div>}
      </div>
    </ActionSheet>
  );
}
