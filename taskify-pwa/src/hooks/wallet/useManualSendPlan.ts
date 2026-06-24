// @ts-nocheck
import { useCallback, useMemo, useState } from "react";
import { computeProofY } from "../../wallet/cashuProofHelpers";
import { totalForSelection } from "../../wallet/walletModalHelpers";
import type { StoredProofForState } from "../../wallet/walletHistoryTypes";

type ManualSendNoteGroup = {
  amount: number;
  secrets: string[];
};

type ManualSendPlan = {
  target: number;
  notes: { secret: string; amount: number }[];
  groups: ManualSendNoteGroup[];
  closestBelow: number | null;
  closestBelowSelection: string[] | null;
  closestAbove: number | null;
  closestAboveSelection: string[] | null;
  exactMatchSelection: string[] | null;
  lockActive: boolean;
};

export function useManualSendPlan({
  createTokenFromProofSelection,
  setSendTokenStr,
  setLastSendTokenAmount,
  setLastSendTokenMint,
  setLastSendTokenFingerprint,
  setLastSendTokenLockLabel,
  setEcashSendView,
  buildHistoryEntry,
  setHistory,
  showToast,
  mintUrl,
  formatSatAmount,
}) {
  const [manualSendPlan, setManualSendPlan] = useState<ManualSendPlan | null>(null);
  const [manualSendSelection, setManualSendSelection] = useState<Set<string>>(() => new Set());
  const [manualSendError, setManualSendError] = useState("");
  const [manualSendInProgress, setManualSendInProgress] = useState(false);

  const manualSelectedTotal = useMemo(() => {
    if (!manualSendPlan) return 0;
    let sum = 0;
    manualSendPlan.notes.forEach((note) => {
      if (manualSendSelection.has(note.secret)) {
        sum += note.amount;
      }
    });
    return sum;
  }, [manualSendPlan, manualSendSelection]);

  const finalizeManualSelection = useCallback(
    async (params: { selection: string[]; selectedTotal: number; target: number }) => {
      const { selection, selectedTotal, target } = params;
      const res = await createTokenFromProofSelection(selection);
      setSendTokenStr(res.token);
      setLastSendTokenAmount(selectedTotal);
      setLastSendTokenMint(mintUrl ?? null);
      setLastSendTokenFingerprint(`${selectedTotal}|manual`);
      setLastSendTokenLockLabel(null);
      setEcashSendView("token");
      setHistory((h) => [
        buildHistoryEntry({
          id: `token-manual-${Date.now()}`,
          summary:
            selectedTotal === target
              ? `Token for ${selectedTotal} sats`
              : `Manual token for ${selectedTotal} sats (target ${target} sats)`,
          detail: res.token,
          detailKind: "token",
          revertToken: res.token,
          type: "ecash",
          direction: "out",
          amountSat: selectedTotal,
          mintUrl: res.mintUrl,
          tokenState:
            res.proofs?.length
              ? {
                  mintUrl: res.mintUrl,
                  proofs: res.proofs.map((proof) => {
                    const stored: StoredProofForState = {
                      secret: proof.secret,
                      amount: proof.amount,
                      id: proof.id,
                      C: proof.C,
                    };
                    if (proof.witness) stored.witness = proof.witness;
                    const y = computeProofY(proof.secret);
                    if (y) stored.Y = y;
                    return stored;
                  }),
                  lastState: "UNSPENT",
                }
              : undefined,
        }),
        ...h,
      ]);
      showToast(`Token created for ${formatSatAmount(selectedTotal)}`, 3000);
      return res;
    },
    [
      buildHistoryEntry,
      createTokenFromProofSelection,
      formatSatAmount,
      mintUrl,
      setHistory,
      setLastSendTokenAmount,
      setLastSendTokenMint,
      setLastSendTokenFingerprint,
      setLastSendTokenLockLabel,
      setSendTokenStr,
      setEcashSendView,
      showToast,
    ],
  );

  const closeManualSendPlan = useCallback(() => {
    setManualSendPlan(null);
    setManualSendSelection(() => new Set());
    setManualSendError("");
    setManualSendInProgress(false);
  }, []);

  const applyManualSendSelection = useCallback(
    async (secrets: string[] | null, options?: { autoCreate?: boolean }) => {
      if (!secrets) return;
      if (options?.autoCreate && manualSendPlan) {
        setManualSendInProgress(true);
        setManualSendError("");
        try {
          const selectedTotal = totalForSelection(manualSendPlan.notes, secrets);
          if (!selectedTotal) {
            setManualSendError("Select at least one note.");
            return;
          }
          await finalizeManualSelection({
            selection: secrets,
            selectedTotal,
            target: manualSendPlan.target,
          });
          closeManualSendPlan();
        } catch (err: any) {
          setManualSendError(err?.message || String(err));
        } finally {
          setManualSendInProgress(false);
        }
        return;
      }
      setManualSendSelection(() => new Set(secrets));
      setManualSendError("");
    },
    [
      closeManualSendPlan,
      finalizeManualSelection,
      manualSendPlan,
      setManualSendError,
      setManualSendInProgress,
      setManualSendSelection,
    ],
  );

  const adjustManualSendGroupSelection = useCallback(
    (amount: number, delta: number) => {
      setManualSendSelection((prev) => {
        if (!manualSendPlan) return prev;
        const group = manualSendPlan.groups.find((entry) => entry.amount === amount);
        if (!group) return prev;
        const next = new Set(prev);
        if (delta > 0) {
          const secretToAdd = group.secrets.find((secret) => !next.has(secret));
          if (!secretToAdd) return prev;
          next.add(secretToAdd);
        } else if (delta < 0) {
          const selectedSecrets = group.secrets.filter((secret) => next.has(secret));
          const secretToRemove = selectedSecrets[selectedSecrets.length - 1];
          if (!secretToRemove) return prev;
          next.delete(secretToRemove);
        } else {
          return prev;
        }
        return next;
      });
    },
    [manualSendPlan],
  );

  const manualSelectionMatches = useCallback(
    (candidate: string[] | null) => {
      if (!candidate) return false;
      if (candidate.length !== manualSendSelection.size) return false;
      return candidate.every((secret) => manualSendSelection.has(secret));
    },
    [manualSendSelection],
  );

  return {
    manualSendPlan,
    setManualSendPlan,
    manualSendSelection,
    setManualSendSelection,
    manualSendError,
    setManualSendError,
    manualSendInProgress,
    setManualSendInProgress,
    manualSelectedTotal,
    finalizeManualSelection,
    closeManualSendPlan,
    applyManualSendSelection,
    adjustManualSendGroupSelection,
    manualSelectionMatches,
  };
}
