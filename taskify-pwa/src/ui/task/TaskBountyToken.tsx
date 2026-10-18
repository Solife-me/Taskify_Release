/**
 * A task's ecash bounty without the wallet: its amount and state, a way to reveal a token locked
 * to this user (Nostr keys only), and the token to copy so it can be redeemed in any wallet.
 */
import { useState } from "react";
import { useToast } from "../../context/ToastContext";
import { currentPubkey } from "../../identity/identity";
import { pubkeysEqual } from "../../domains/tasks/taskUtils";
import type { Task } from "../../domains/tasks/taskTypes";

const STATE_LABEL: Record<NonNullable<Task["bounty"]>["state"], string> = {
  locked: "Locked",
  unlocked: "Ready to redeem",
  claimed: "Redeemed",
  revoked: "Revoked",
};

export function TaskBountyToken({ task, onReveal }: { task: Task; onReveal?: (taskId: string) => Promise<void> }) {
  const { show: showToast } = useToast();
  const [revealing, setRevealing] = useState(false);
  const bounty = task.bounty;
  if (!bounty) return null;

  const token = bounty.token?.trim() || "";
  const alg = bounty.enc?.alg;
  // A token locked to this user, or hidden by its funder (who is this user), can be decrypted here.
  const canReveal = !!bounty.enc && !token
    && ((bounty.receiver && pubkeysEqual(bounty.receiver, currentPubkey())) || alg === "aes-gcm-256");

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      showToast("Bounty token copied", 1800);
    } catch {
      showToast("Unable to copy the bounty token", 2400);
    }
  };

  const reveal = async () => {
    if (!onReveal) return;
    setRevealing(true);
    try {
      await onReveal(task.id);
    } finally {
      setRevealing(false);
    }
  };

  return (
    <section className="edit-card space-y-2" aria-label="Bounty">
      <div className="edit-card__title">Bounty (ecash)</div>
      <div className="text-sm">
        {typeof bounty.amount === "number" ? `${bounty.amount} sats` : "Ecash"} · {STATE_LABEL[bounty.state] ?? bounty.state}
      </div>
      {token ? (
        <>
          <div className="text-xs text-secondary break-all font-mono" data-testid="bounty-token">{token}</div>
          <div className="text-xs text-secondary">Copy the token to redeem it in any Cashu wallet.</div>
          <button type="button" className="accent-button button-sm pressable" onClick={() => void copyToken()}>
            Copy token
          </button>
        </>
      ) : canReveal && onReveal ? (
        <button type="button" className="ghost-button button-sm pressable" onClick={() => void reveal()} disabled={revealing}>
          {revealing ? "Revealing…" : "Reveal token"}
        </button>
      ) : null}
    </section>
  );
}
