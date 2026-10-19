import { useCallback, useState } from "react";
import { Modal } from "../Modal";
import { kvStorage } from "../../storage/kvStorage";
import { LS_WALLET_PHASE_OUT_NOTICE_SEEN } from "../../localStorageKeys";
import { walletRemovalDateLabel } from "../../wallet/walletPhaseOut";

export const WALLET_PHASE_OUT_NOTICE_TITLE = "The Taskify wallet is being phased out";

export const WALLET_PHASE_OUT_NOTICE_PARAGRAPHS: string[] = [
  "Dear Taskify User,",
  "We appreciate you choosing to use our app and are committed to providing the best possible user experience. As a result of this commitment we have decided to phase out the Taskify wallet. Removing the wallet will allow us to spend more time improving the core app experience and can improve the app performance.",
  `The wallet no longer takes in new funds, and it closes on ${walletRemovalDateLabel()}. After that, Taskify only shows how to recover what is left.`,
  "We encourage you to move any remaining funds immediately. If you're looking for another ecash wallet, Minibits and Cashu.me are both great options.",
  "As always feel free to reach out if you have any questions.",
];

function readSeen(): boolean {
  try {
    return kvStorage.getItem(LS_WALLET_PHASE_OUT_NOTICE_SEEN) === "1";
  } catch {
    return false;
  }
}

/** Shown once per device, only while the Taskify wallet holds a balance. */
export function WalletPhaseOutNotice({
  hasBalance,
  suppressed,
  onMoveFundsOut,
}: {
  hasBalance: boolean;
  /** True while something else (e.g. first-run onboarding) owns the screen. */
  suppressed: boolean;
  onMoveFundsOut: () => void;
}) {
  const [seen, setSeen] = useState(readSeen);

  const dismiss = useCallback(() => {
    setSeen(true);
    try {
      kvStorage.setItem(LS_WALLET_PHASE_OUT_NOTICE_SEEN, "1");
    } catch {
      // dismissed for this session
    }
  }, []);

  if (seen || suppressed || !hasBalance) return null;

  return (
    <Modal onClose={dismiss} title={WALLET_PHASE_OUT_NOTICE_TITLE} showClose={false}>
      <div className="space-y-3 text-sm text-secondary">
        {WALLET_PHASE_OUT_NOTICE_PARAGRAPHS.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="ghost-button button-sm pressable" onClick={dismiss}>
          Got it
        </button>
        <button
          type="button"
          className="accent-button button-sm pressable"
          onClick={() => {
            dismiss();
            onMoveFundsOut();
          }}
        >
          Move funds out
        </button>
      </div>
    </Modal>
  );
}
