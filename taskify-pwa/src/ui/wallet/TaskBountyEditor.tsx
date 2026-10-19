// @ts-nocheck -- wallet code (being phased out), moved unchanged out of the task editor. It is
// deleted with the wallet; tasks keep only the copy-only bounty view (ui/task/TaskBountyToken).
/**
 * Ecash bounties on a task, where the wallet is still enabled: revealing, signing over, copying
 * and removing an existing bounty, and pinning the task to the wallet's bounty list. The task
 * editor renders these through its bounty slot.
 *
 * The wallet is withdraw-only (C6-1): no new bounties are attached, and a bounty is not redeemed
 * into the Taskify wallet; its token is copied to redeem in any Cashu wallet.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Task } from "../../domains/tasks/taskTypes";
import { bountyStateLabel, ensureXOnlyHex, normalizeBounty, pubkeysEqual, taskHasBountyList } from "../../domains/tasks/taskUtils";
import { contactVerifiedNip05 } from "../../domains/tasks/contactUtils";
import { normalizeNostrPubkey } from "../../lib/nostr";
import { contactPrimaryName, type Contact } from "../../lib/contacts";
import { currentPubkey } from "../../identity/identity";
import { useToast } from "../../context/ToastContext";
import { EcashGlyph } from "../../components/EcashGlyph";
import { LockToNpubSheet, type LockRecipientSelection, type QuickLockOption } from "../bounty/LockToNpubSheet";
import { shortenPubkey, toNpubKey } from "../task/pubkeyLabels";
import type { TaskBountyEditorContext } from "../task/taskBountyExtension";

/** What the wallet adds to the editor's bounty slot, beyond what the editor provides. */
export type TaskBountyWalletProps = {
  onRevealBounty?: (taskId: string) => Promise<void>;
  onTransferBounty?: (taskId: string, recipientHex: string) => Promise<void>;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  bountyListEnabled: boolean;
  bountyListKey?: string | null;
  onAddToBountyList?: (taskId: string) => void;
  onRemoveFromBountyList?: (taskId: string) => void;
};

export function TaskBountySection({
  task,
  saveWith: save,
  contacts,
  nip05Cache,
  onRevealBounty,
  onTransferBounty,
}: TaskBountyEditorContext & TaskBountyWalletProps) {
  const { show: showToast } = useToast();
  const [, setBountyState] = useState<Task["bounty"]["state"]>(task.bounty?.state || "locked");
  const [signOverSheetOpen, setSignOverSheetOpen] = useState(false);
  const [bountyExpanded, setBountyExpanded] = useState(false);
  const [signingBounty, setSigningBounty] = useState(false);
  const contactsByHex = useMemo(() => {
    const map = new Map<string, Contact>();
    contacts.forEach((contact) => {
      const hex = normalizeNostrPubkey(contact.npub);
      if (hex) map.set(hex, contact);
    });
    return map;
  }, [contacts]);
  const lockLabelForContact = useCallback(
    (contact: Contact | null | undefined, fallback: string) => {
      const verifiedNip05 = contact ? contactVerifiedNip05(contact, nip05Cache) : null;
      if (verifiedNip05) return verifiedNip05;
      const primaryName = contact ? contactPrimaryName(contact) : "";
      if (primaryName && primaryName !== "Contact" && primaryName !== contact?.npub?.trim()) {
        return primaryName;
      }
      return fallback;
    },
    [nip05Cache],
  );
  const quickLockOptions = useMemo<QuickLockOption[]>(() => {
    const options: QuickLockOption[] = [];
    const ownerHex = normalizeNostrPubkey(task.createdBy || "");
    if (ownerHex) {
      const contact = contactsByHex.get(ownerHex);
      const sourceValue = contact?.npub?.trim() || (task.createdBy ? toNpubKey(task.createdBy) : ownerHex);
      const label = lockLabelForContact(contact, shortenPubkey(sourceValue));
      options.push({
        id: "creator",
        title: "Task creator",
        value: sourceValue,
        label,
        contactId: contact?.id,
      });
    }
    const completerHex = normalizeNostrPubkey(task.completedBy || "");
    if (completerHex) {
      const contact = contactsByHex.get(completerHex);
      const sourceValue = contact?.npub?.trim() || (task.completedBy ? toNpubKey(task.completedBy) : completerHex);
      const label = lockLabelForContact(contact, shortenPubkey(sourceValue));
      options.push({
        id: "completer",
        title: "Task fulfiller",
        value: sourceValue,
        label,
        contactId: contact?.id,
      });
    }
    return options;
  }, [contactsByHex, lockLabelForContact, task.completedBy, task.createdBy]);
  useEffect(() => {
    setSigningBounty(false);
  }, [task.id]);

  const me = currentPubkey() ?? undefined;
  const meHex = ensureXOnlyHex(me);



  const currentReceiverDisplay = useMemo(() => {
    const receiver = task.bounty?.receiver;
    if (!receiver) return null;
    return shortenPubkey(toNpubKey(receiver));
  }, [task.bounty?.receiver]);

  const bountyReceiverIsViewer = useMemo(() => {
    const receiver = task.bounty?.receiver;
    if (!receiver) return false;
    return pubkeysEqual(receiver, currentPubkey());
  }, [task.bounty?.receiver]);

  const bountySenderIsViewer = useMemo(() => {
    if (!task.bounty?.sender || !meHex) return false;
    return pubkeysEqual(task.bounty.sender, meHex);
  }, [meHex, task.bounty?.sender]);

  const canRemoveBounty = useMemo(() => {
    if (!task.bounty) return false;
    return task.bounty.state === "unlocked" || bountySenderIsViewer;
  }, [bountySenderIsViewer, task.bounty]);

  const bountyOwnerIsViewer = useMemo(() => {
    if (!task.bounty?.owner || !meHex) return false;
    return pubkeysEqual(task.bounty.owner, meHex);
  }, [meHex, task.bounty?.owner]);

  const hasTransferableBounty = !!(task.bounty && (task.bounty.token || task.bounty.enc));

  const bountyHasReceiver = !!task.bounty?.receiver;
  const bountyReceiverGate = bountyHasReceiver ? bountyReceiverIsViewer : true;

  const bountySignerHasKey = useMemo(() => {
    if (!task.bounty || !meHex) return false;
    const tokenAvailable = !!task.bounty.token?.trim();
    if (tokenAvailable) {
      return bountySenderIsViewer || bountyOwnerIsViewer || bountyReceiverIsViewer;
    }
    const enc = task.bounty.enc as any;
    if (!enc) return false;
    if (enc.alg === "aes-gcm-256") return bountySenderIsViewer || bountyOwnerIsViewer;
    if (enc.alg === "nip04") return bountyReceiverIsViewer;
    return false;
  }, [bountyOwnerIsViewer, bountyReceiverIsViewer, bountySenderIsViewer, meHex, task.bounty]);

  const bountyTokenReady = !!task.bounty?.token?.trim();

  const canSignOverBounty = useMemo(() => {
    if (!hasTransferableBounty || !bountySignerHasKey || !onTransferBounty) return false;
    if (!task.bounty) return false;
    return task.bounty.state !== "revoked" && task.bounty.state !== "claimed";
  }, [bountySignerHasKey, hasTransferableBounty, onTransferBounty, task.bounty]);

  const canRedeemBounty = useMemo(() => {
    if (!task.bounty || !bountyReceiverGate) return false;
    return task.bounty.state === "unlocked" && bountyTokenReady;
  }, [bountyReceiverGate, bountyTokenReady, task.bounty]);

  const canRevealBounty = useMemo(() => {
    if (!task.bounty?.enc) return false;
    const alg = (task.bounty.enc as any).alg;
    return bountyReceiverIsViewer || alg === "aes-gcm-256";
  }, [bountyReceiverIsViewer, task.bounty?.enc]);

  useEffect(() => {
    if (!task.bounty) {
      setBountyExpanded(false);
    }
  }, [task.bounty]);

  async function handleSignOver(recipientHex: string, displayHint?: string) {
    if (!onTransferBounty || signingBounty) return;
    setSigningBounty(true);
    try {
      await onTransferBounty(task.id, recipientHex);
      setBountyState("locked");
      const label = displayHint || shortenPubkey(toNpubKey(recipientHex));
      if (label) {
        showToast(`Bounty locked to ${label}`, 2500);
      } else {
        showToast("Bounty locked to recipient", 2500);
      }
    } catch (error) {
      const message = (error as Error)?.message || String(error) || "Unknown error";
      alert(`Unable to sign bounty: ${message}`);
    } finally {
      setSigningBounty(false);
    }
  }

  function handleSignOverSelection(selection: LockRecipientSelection) {
    const trimmed = selection.value.trim();
    if (!trimmed) return;
    const normalized = normalizeNostrPubkey(trimmed);
    if (!normalized) {
      alert("Enter a valid recipient npub or hex.");
      return;
    }
    if (task.bounty?.receiver && pubkeysEqual(task.bounty.receiver, normalized)) {
      alert("Bounty is already locked to that recipient.");
      return;
    }
    handleSignOver(normalized, selection.label);
    setSignOverSheetOpen(false);
  }

  const handleCopyBountyToken = useCallback(async () => {
    const token = task.bounty?.token?.trim();
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      showToast("Bounty token copied. Redeem it in any Cashu wallet.", 2600);
    } catch (error) {
      console.error("Failed to copy bounty token", error);
      alert("Unable to copy bounty token.");
    }
  }, [showToast, task.bounty?.token]);

  function handleMarkBountyClaimed() {
    if (!task.bounty) return;
    const next = normalizeBounty({
      ...task.bounty,
      token: "",
      state: "claimed",
      updatedAt: new Date().toISOString(),
    });
    if (!next) return;
    setBountyState("claimed");
    save({ bounty: next });
  }

  function handleRemoveBounty() {
    if (!task.bounty || !canRemoveBounty) return;
    save({ bounty: undefined });
  }

  return (
    <>
        {task.bounty ? (
          <section className="edit-card space-y-2">
            <div className="edit-card__title">Bounty (ecash)</div>
            <div className={`wallet-history__item bounty-card${bountyExpanded ? " wallet-history__item--open" : ""}`}>
              <button
                type="button"
                className="wallet-history__summary bounty-card__summary"
                onClick={() => setBountyExpanded((prev) => !prev)}
                aria-expanded={bountyExpanded}
              >
                <div className="wallet-history__icon" aria-hidden="true">
                  <EcashGlyph className="wallet-history__glyph" />
                </div>
                <div className="wallet-history__body">
                  <div className="wallet-history__title-row">
                    <span className="wallet-history__type">Ecash bounty</span>
                    <span className="wallet-history__time">{bountyStateLabel(task.bounty)}</span>
                  </div>
                </div>
                <div className="wallet-history__value">
                  {typeof task.bounty.amount === "number" && (
                    <span className="wallet-history__amount wallet-history__amount--in">+{task.bounty.amount} sats</span>
                  )}
                </div>
              </button>

              {!bountyExpanded && (
                <div className="bounty-card__actions px-4 pb-3">
                  {task.bounty.state === "locked" && canRevealBounty && bountySignerHasKey && (
                    <button
                      className="accent-button button-sm pressable"
                      onClick={async () => {
                        try {
                          await onRevealBounty?.(task.id);
                          setBountyState("unlocked");
                        } catch (error) {
                          alert((error as Error)?.message || "Unable to reveal bounty token.");
                        }
                      }}
                      disabled={!canRevealBounty}
                    >
                      {bountyReceiverIsViewer ? "Unlock" : "Reveal"}
                    </button>
                  )}

                  {canSignOverBounty && (
                    <button
                      className="ghost-button button-sm pressable"
                      onClick={() => setSignOverSheetOpen(true)}
                      disabled={signingBounty}
                    >
                      {signingBounty ? "Signing…" : "Sign over"}
                    </button>
                  )}

                  {canRedeemBounty && (
                    <>
                      <button
                        className="accent-button button-sm pressable"
                        onClick={handleCopyBountyToken}
                        disabled={!bountyTokenReady}
                      >
                        Copy
                      </button>
                    </>
                  )}
                </div>
              )}

              {bountyExpanded && (
                <div className="bounty-card__details">
                  <div className="bounty-card__meta">
                    <div>
                      <div className="bounty-card__label">Status</div>
                      <div className="bounty-card__value">{bountyStateLabel(task.bounty)}</div>
                    </div>
                    <div>
                      <div className="bounty-card__label">Amount</div>
                      <div className="bounty-card__value font-semibold">
                        {typeof task.bounty.amount === "number" ? `${task.bounty.amount} sats` : "Unknown"}
                      </div>
                    </div>
                    {task.bounty.receiver && (
                      <div>
                        <div className="bounty-card__label">Locked to</div>
                        <div className="bounty-card__value">{currentReceiverDisplay || "recipient"}</div>
                      </div>
                    )}
                    {task.bounty.mint && (
                      <div>
                        <div className="bounty-card__label">Mint</div>
                        <div className="bounty-card__value break-all">{task.bounty.mint}</div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="bounty-card__label">Token</div>
                    {task.bounty.enc && !task.bounty.token ? (
                      <div className="bounty-card__token-note">
                        {((task.bounty.enc as any).alg === "aes-gcm-256")
                          ? "Hidden (encrypted by funder). Only the funder can reveal."
                          : "Locked to recipient's Nostr key (nip04). Only the recipient can decrypt."}
                      </div>
                    ) : (
                      <textarea
                        readOnly
                        value={task.bounty.token || ""}
                        className="pill-textarea w-full"
                        rows={3}
                      />
                    )}
                  </div>

                  <div className="bounty-card__actions">
                    {task.bounty.state === "locked" && task.bounty.enc && bountySignerHasKey && (
                      <button
                        className="accent-button button-sm pressable"
                        onClick={async () => {
                          try {
                            await onRevealBounty?.(task.id);
                            setBountyState("unlocked");
                          } catch (error) {
                            alert((error as Error)?.message || "Unable to reveal bounty token.");
                          }
                        }}
                        disabled={!canRevealBounty}
                      >
                        {bountyReceiverIsViewer ? "Unlock" : "Reveal"}
                      </button>
                    )}

                    {canSignOverBounty && (
                      <button
                        className="ghost-button button-sm pressable"
                        onClick={() => setSignOverSheetOpen(true)}
                        disabled={signingBounty}
                      >
                        {signingBounty ? "Signing…" : "Sign over"}
                      </button>
                    )}

                    {canRedeemBounty && (
                      <>
                        <button
                          className="accent-button button-sm pressable"
                          onClick={(e) => redeemCurrentBounty((e.currentTarget as HTMLElement).getBoundingClientRect())}
                          disabled={!bountyTokenReady}
                        >
                          Redeem
                        </button>
                        <button
                          className="ghost-button button-sm pressable"
                          onClick={handleCopyBountyToken}
                          disabled={!bountyTokenReady}
                        >
                          Copy
                        </button>
                        <button
                          className="ghost-button button-sm pressable"
                          onClick={handleMarkBountyClaimed}
                          disabled={!bountyTokenReady}
                        >
                          Mark as claimed
                        </button>
                      </>
                    )}

                    {task.bounty && canRemoveBounty && (
                      <button
                        className="ghost-button button-sm pressable text-rose-500"
                        onClick={handleRemoveBounty}
                      >
                        Remove bounty
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        ) : null}
    <LockToNpubSheet
      open={signOverSheetOpen}
      onClose={() => setSignOverSheetOpen(false)}
      contacts={contacts}
      quickOptions={quickLockOptions}
      nip05Cache={nip05Cache}
      onSelect={handleSignOverSelection}
      selected={null}
    />
    </>
  );
}

/** "Pin task" / "Unpin task": adds the task to the wallet's bounty list. */
export function TaskBountyPinButton({
  task,
  bountyListEnabled,
  bountyListKey,
  onAddToBountyList,
  onRemoveFromBountyList,
}: { task: Task } & TaskBountyWalletProps) {
  const bountyButtonActive = bountyListEnabled && !!bountyListKey;
  const taskInBountyList = bountyButtonActive && bountyListKey ? taskHasBountyList(task, bountyListKey) : false;
  const handleToggleBountyList = useCallback(() => {
    if (!bountyButtonActive) return;
    if (taskInBountyList) {
      onRemoveFromBountyList?.(task.id);
    } else {
      onAddToBountyList?.(task.id);
    }
  }, [bountyButtonActive, onAddToBountyList, onRemoveFromBountyList, task.id, taskInBountyList]);
  if (!bountyButtonActive) return null;
  return (
    <button type="button" className="ghost-button button-sm pressable" onClick={handleToggleBountyList}>
      {taskInBountyList ? "Unpin task" : "Pin task"}
    </button>
  );
}
