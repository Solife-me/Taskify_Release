// @ts-nocheck
import { useCallback, useRef } from "react";

export function useTokenHistoryActions({
  // Reactive state values
  mintUrl,
  // Stable setters
  setHistory,
  setHistoryCheckStates,
  setHistoryMintQuoteStates,
  setHistoryRevertState,
  // Stable refs
  proofStateSubscriptionsRef,
  proofStateSubscriptionMetadataRef,
  proofSubscriptionCooldownRef,
  unsupportedProofSubscriptionMintsRef,
  mintQuoteSubscriptionCooldownRef,
  unsupportedMintQuoteSubscriptionMintsRef,
  initialTokenCheckIdsRef,
  tokenStateCheckRunningRef,
  // Stable functions
  buildHistoryEntry,
  receiveToken,
  showToast,
  formatSatAmount,
  checkProofStates,
  checkMintQuote,
  claimMint,
  normalizeMintUrl,
  sumProofAmounts,
  deriveSpentHistoryTokenStateFromToken,
  sanitizeProofStateValue,
  aggregateStoredProofStates,
  summarizeStoredProofStates,
  extractWitnesses,
  computeProofY,
  buildTokenSpentToastMessage,
  shouldSuppressProofStateChecks,
  deriveTimestampFromId,
  UNPAID_MINT_QUOTE_RETENTION_MS,
}) {
  // Internal ref — only used by claimMintQuoteById and handleMintQuoteClaimSuccess
  const mintQuoteClaimingRef = useRef(new Set());

  const handleRevertHistoryToken = useCallback(
    async (item) => {
      if (!item.revertToken) return;
      setHistoryRevertState((prev) => ({
        ...prev,
        [item.id]: { status: "pending" },
      }));
      try {
        const res = await receiveToken(item.revertToken);
        if (res.savedForLater) {
          showToast("Token saved for later redemption. We'll redeem it when you're back online.");
          setHistoryRevertState((prev) => ({
            ...prev,
            [item.id]: { status: "idle" },
          }));
          return;
        }
        const amt = sumProofAmounts(res.proofs);
        const crossNote = res.crossMint && res.usedMintUrl ? ` • Stored at ${res.usedMintUrl}` : "";
        const successMessage = amt
          ? `Redeemed ${formatSatAmount(amt)}${crossNote}`
          : `Redeemed token${crossNote}`;
        const tokenState = deriveSpentHistoryTokenStateFromToken(item.revertToken, Date.now());
        setHistory((prev) => {
          const updated = prev.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  summary: entry.summary.includes("(reverted)")
                    ? entry.summary
                    : `${entry.summary} (reverted)`,
                  revertToken: undefined,
                  tokenState: undefined,
                }
              : entry,
          );
          return [
            buildHistoryEntry({
              id: `reverted-${Date.now()}`,
              summary: amt
                ? `Reverted token for ${amt} sat${amt === 1 ? "" : "s"}`
                : "Reverted token",
              detail: item.revertToken,
              detailKind: "token",
              type: "ecash",
              direction: "in",
              amountSat: amt || undefined,
              mintUrl: res.usedMintUrl ?? mintUrl ?? undefined,
              ...(tokenState ? { tokenState } : {}),
            }),
            ...updated,
          ];
        });
        setHistoryCheckStates((prev) => {
          if (!(item.id in prev)) return prev;
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setHistoryRevertState((prev) => ({
          ...prev,
          [item.id]: { status: "success", message: successMessage },
        }));
        showToast(successMessage, 3000);
      } catch (err) {
        const message = err?.message || String(err);
        setHistoryRevertState((prev) => ({
          ...prev,
          [item.id]: { status: "error", message },
        }));
      }
    },
    [buildHistoryEntry, formatSatAmount, mintUrl, receiveToken, showToast],
  );

  const handleMintQuoteClaimSuccess = useCallback(
    (historyId, amountSat, mintHint) => {
      setHistory((prev) => [
        buildHistoryEntry({
          id: `mint-${Date.now()}`,
          summary: `Minted ${amountSat} sats`,
          type: "lightning",
          direction: "in",
          amountSat,
          mintUrl: mintHint ?? undefined,
          stateLabel: "Paid",
        }),
        ...prev.filter((entry) => entry.id !== historyId),
      ]);
      setHistoryMintQuoteStates((prev) => {
        if (!(historyId in prev)) return prev;
        const next = { ...prev };
        delete next[historyId];
        return next;
      });
      showToast(`received ${formatSatAmount(amountSat)}`, 3500);
    },
    [buildHistoryEntry, formatSatAmount, setHistory, setHistoryMintQuoteStates, showToast],
  );

  const claimMintQuoteById = useCallback(
    async (quoteId, amountSat, options) => {
      if (!quoteId) return;
      if (mintQuoteClaimingRef.current.has(quoteId)) return;
      mintQuoteClaimingRef.current.add(quoteId);
      const historyKey = options?.historyItemId ?? quoteId;
      if (historyKey) {
        setHistoryMintQuoteStates((prev) => ({
          ...prev,
          [historyKey]: { status: "pending" },
        }));
      }
      try {
        const state = await checkMintQuote(quoteId, { mintUrl: options?.mintUrl });
        if (state === "ISSUED") {
          throw new Error("Mint quote is already issued. Restore from wallet seed if balance is missing.");
        }
        if (state !== "PAID") {
          throw new Error("Mint invoice is not paid yet");
        }
        await claimMint(quoteId, amountSat, { mintUrl: options?.mintUrl });
        handleMintQuoteClaimSuccess(historyKey, amountSat, options?.mintUrl ?? null);
      } catch (err) {
        const message = err?.message || String(err ?? "");
        if (historyKey) {
          setHistoryMintQuoteStates((prev) => ({
            ...prev,
            [historyKey]: { status: "error", message },
          }));
        }
        throw err;
      } finally {
        mintQuoteClaimingRef.current.delete(quoteId);
      }
    },
    [checkMintQuote, claimMint, handleMintQuoteClaimSuccess, setHistoryMintQuoteStates],
  );

  const performTokenStateCheck = useCallback(
    async (item, options) => {
      const tokenState = item.tokenState;
      if (!tokenState || !tokenState.proofs.length) return;
      if (!options?.silent) {
        setHistoryCheckStates((prev) => ({
          ...prev,
          [item.id]: { status: "pending" },
        }));
      }
      try {
        const proofsForCheck = tokenState.proofs.map((proof) => ({
          amount: proof.amount,
          secret: proof.secret,
          id: proof.id,
          C: proof.C,
          witness: proof.witness,
        }));
        const states = await checkProofStates(tokenState.mintUrl, proofsForCheck);
        const responseStateWrappers = states.map((state) => ({
          lastState: sanitizeProofStateValue(state.state),
        }));
        const aggregatedFromResponse = aggregateStoredProofStates(responseStateWrappers);
        const summaryFromResponse = summarizeStoredProofStates(responseStateWrappers);
        const witnessMap = extractWitnesses(states);
        let toastMessage = null;
        const timestamp = Date.now();
        setHistory((prev) =>
          prev.map((entry) => {
            if (entry.id !== item.id || !entry.tokenState) return entry;
            const updatedProofs = entry.tokenState.proofs.map((proof, index) => {
              const stateEntry = states[index];
              const normalizedState = sanitizeProofStateValue(stateEntry?.state);
              const yFromResponse = stateEntry?.Y;
              const witnessFromState = stateEntry?.witness;
              let nextProof = proof;
              if (yFromResponse && proof.Y !== yFromResponse) {
                nextProof = { ...nextProof, Y: yFromResponse };
              } else if (!proof.Y) {
                const computed = computeProofY(proof.secret);
                if (computed) {
                  nextProof = { ...nextProof, Y: computed };
                }
              }
              if (typeof witnessFromState === "string" && witnessFromState !== proof.witness) {
                nextProof = { ...nextProof, witness: witnessFromState };
              }
              if (normalizedState && normalizedState !== proof.lastState) {
                nextProof = { ...nextProof, lastState: normalizedState };
              }
              return nextProof;
            });
            const aggregated =
              aggregateStoredProofStates(updatedProofs) ?? entry.tokenState.lastState;
            const summaryValue = summarizeStoredProofStates(updatedProofs);
            const mergedWitnesses = { ...(entry.tokenState.lastWitnesses ?? {}) };
            if (witnessMap) {
              for (const [y, witness] of Object.entries(witnessMap)) {
                mergedWitnesses[y] = witness;
              }
            }
            const shouldNotify = aggregated === "SPENT" && entry.tokenState.notifiedSpent !== true;
            if (shouldNotify) {
              toastMessage = buildTokenSpentToastMessage(updatedProofs);
            }
            const mergedWitnessesValue = Object.keys(mergedWitnesses).length
              ? mergedWitnesses
              : entry.tokenState.lastWitnesses;
            const nextTokenState = {
              ...entry.tokenState,
              proofs: updatedProofs,
              lastState: aggregated ?? entry.tokenState.lastState,
              lastSummary: summaryValue || entry.tokenState.lastSummary,
              lastCheckedAt: timestamp,
              lastWitnesses: mergedWitnessesValue,
              notifiedSpent: aggregated === "SPENT" ? true : entry.tokenState.notifiedSpent,
            };
            if (aggregated === "SPENT") {
              nextTokenState.suppressChecks = true;
            } else if (entry.tokenState.suppressChecks) {
              nextTokenState.suppressChecks = entry.tokenState.suppressChecks;
            } else {
              delete nextTokenState.suppressChecks;
            }
            delete nextTokenState.lastError;
            delete nextTokenState.lastErrorAt;
            if (entry.tokenState.errorCount != null) {
              delete nextTokenState.errorCount;
            }
            return {
              ...entry,
              summary:
                aggregated === "SPENT" && !entry.summary.includes("(spent)")
                  ? `${entry.summary} (spent)`
                  : entry.summary,
              tokenState: nextTokenState,
            };
          })
        );
        if (!options?.silent) {
          const baseLabel = aggregatedFromResponse ?? item.tokenState.lastState;
          const summaryLabel = summaryFromResponse || item.tokenState.lastSummary || "";
          const label = baseLabel ?? (summaryLabel ? "Updated" : "State updated");
          const message = summaryLabel ? `${label}${label ? " • " : ""}${summaryLabel}` : label ?? "State updated";
          setHistoryCheckStates((prev) => ({
            ...prev,
            [item.id]: { status: "success", message },
          }));
        }
        if (toastMessage) {
          showToast(toastMessage, 3500);
        }
      } catch (err) {
        const message = err?.message || String(err);
        const timestamp = Date.now();
        const suppressChecks = shouldSuppressProofStateChecks(err);
        const alreadySpent = /already spent/i.test(message);
        setHistory((prev) =>
          prev.map((entry) => {
            if (entry.id !== item.id || !entry.tokenState) return entry;
            if (alreadySpent) {
              const updatedProofs = entry.tokenState.proofs.map((proof) =>
                proof.lastState === "SPENT" ? proof : { ...proof, lastState: "SPENT" },
              );
              const summaryValue = summarizeStoredProofStates(updatedProofs);
              const nextTokenState = {
                ...entry.tokenState,
                proofs: updatedProofs,
                lastState: "SPENT",
                lastSummary: summaryValue || entry.tokenState.lastSummary || "SPENT",
                lastCheckedAt: timestamp,
                notifiedSpent: true,
                suppressChecks: true,
              };
              delete nextTokenState.lastError;
              delete nextTokenState.lastErrorAt;
              if (nextTokenState.errorCount != null) {
                delete nextTokenState.errorCount;
              }
              return {
                ...entry,
                summary:
                  entry.summary.includes("(spent)")
                    ? entry.summary
                    : `${entry.summary} (spent)`,
                tokenState: nextTokenState,
              };
            }
            const errorCount = (entry.tokenState.errorCount ?? 0) + 1;
            const nextTokenState = {
              ...entry.tokenState,
              lastCheckedAt: timestamp,
              lastError: message,
              lastErrorAt: timestamp,
              errorCount,
            };
            if (suppressChecks) {
              nextTokenState.suppressChecks = true;
            }
            return {
              ...entry,
              tokenState: nextTokenState,
            };
          })
        );
        if (!options?.silent) {
          setHistoryCheckStates((prev) => ({
            ...prev,
            [item.id]: alreadySpent
              ? { status: "success", message: "Token marked spent" }
              : { status: "error", message },
          }));
        }
        if (alreadySpent && !options?.silent) {
          showToast("Token marked spent", 3000);
        }
      }
    },
    [checkProofStates, setHistory, setHistoryCheckStates, showToast],
  );

  const handleCheckHistoryMintQuote = useCallback(
    async (item) => {
      const mintQuote = item.mintQuote;
      if (!mintQuote) return;
      const targetMintRaw = mintQuote.mintUrl || mintUrl || "";
      const targetMint = targetMintRaw ? normalizeMintUrl(targetMintRaw) : null;
      if (!targetMint) {
        setHistoryMintQuoteStates((prev) => ({
          ...prev,
          [item.id]: {
            status: "error",
            message: "Mint unavailable. Select a mint to claim this invoice.",
          },
        }));
        return;
      }
      setHistoryMintQuoteStates((prev) => ({
        ...prev,
        [item.id]: { status: "pending" },
      }));
      try {
        const state = await checkMintQuote(mintQuote.quote, { mintUrl: targetMintRaw });
        if (state === "PAID") {
          await claimMint(mintQuote.quote, mintQuote.amount, { mintUrl: targetMintRaw });
          setHistory((prev) => [
            buildHistoryEntry({
              id: `mint-${Date.now()}`,
              summary: `Minted ${mintQuote.amount} sats`,
              type: "lightning",
              direction: "in",
              amountSat: mintQuote.amount,
              mintUrl: targetMintRaw ?? undefined,
              stateLabel: "Paid",
            }),
            ...prev.filter((entry) => entry.id !== item.id),
          ]);
          setHistoryMintQuoteStates((prev) => {
            const next = { ...prev };
            delete next[item.id];
            return next;
          });
          showToast(`received ${formatSatAmount(mintQuote.amount)}`, 3500);
          return;
        }
        const normalizedState =
          typeof state === "string" && state ? state.toUpperCase() : String(state ?? "").toUpperCase();
        setHistory((prev) =>
          prev.map((entry) =>
            entry.id === item.id && entry.mintQuote
              ? { ...entry, mintQuote: { ...entry.mintQuote, state: normalizedState } }
              : entry,
          ),
        );
        if (normalizedState === "EXPIRED") {
          setHistory((prev) => prev.filter((entry) => entry.id !== item.id));
          setHistoryMintQuoteStates((prev) => {
            const next = { ...prev };
            delete next[item.id];
            return next;
          });
          showToast("Invoice expired", 3000);
          return;
        }
        if (normalizedState === "ISSUED") {
          setHistoryMintQuoteStates((prev) => ({
            ...prev,
            [item.id]: {
              status: "error",
              message: "Quote already issued. Restore from wallet seed if balance is missing.",
            },
          }));
          return;
        }
        const message =
          normalizedState === "UNPAID" ? "Invoice not paid yet" : `Status: ${normalizedState || state || "Unknown"}`;
        setHistoryMintQuoteStates((prev) => ({
          ...prev,
          [item.id]: { status: "success", message },
        }));
      } catch (err) {
        const message = err?.message || String(err);
        setHistoryMintQuoteStates((prev) => ({
          ...prev,
          [item.id]: { status: "error", message },
        }));
      }
    },
    [buildHistoryEntry, checkMintQuote, claimMint, formatSatAmount, mintUrl, setHistory, setHistoryMintQuoteStates, showToast],
  );

  const clearProofStateSubscriptions = useCallback(() => {
    proofStateSubscriptionsRef.current.forEach((cancel) => {
      try {
        cancel();
      } catch (err) {
        console.warn("Error closing proof state subscription", err);
      }
    });
    proofStateSubscriptionsRef.current.clear();
    proofStateSubscriptionMetadataRef.current.clear();
  }, []);

  const resetTokenTracking = useCallback(() => {
    clearProofStateSubscriptions();
    proofSubscriptionCooldownRef.current.clear();
    unsupportedProofSubscriptionMintsRef.current.clear();
    mintQuoteSubscriptionCooldownRef.current.clear();
    unsupportedMintQuoteSubscriptionMintsRef.current.clear();
    initialTokenCheckIdsRef.current.clear();
    tokenStateCheckRunningRef.current = false;
    setHistoryCheckStates({});
    setHistoryMintQuoteStates({});
    setHistory((prev) => {
      let changed = false;
      const next = prev.map((entry) => {
        let nextTokenState = entry.tokenState;
        let tokenChanged = false;
        if (nextTokenState) {
          const suppress = nextTokenState.suppressChecks === true;
          const hasErrorMeta =
            !!nextTokenState.lastError ||
            !!nextTokenState.lastErrorAt ||
            (nextTokenState.errorCount ?? 0) > 0;
          if (!suppress || hasErrorMeta) {
            nextTokenState = {
              ...nextTokenState,
              suppressChecks: true,
            };
            delete nextTokenState.lastError;
            delete nextTokenState.lastErrorAt;
            delete nextTokenState.errorCount;
            tokenChanged = true;
          }
        }
        let nextMintQuote = entry.mintQuote;
        let quoteChanged = false;
        if (nextMintQuote) {
          const suppress = nextMintQuote.suppressChecks === true;
          const hasErrorMeta =
            !!nextMintQuote.lastError ||
            !!nextMintQuote.lastErrorAt ||
            (nextMintQuote.errorCount ?? 0) > 0;
          if (!suppress || hasErrorMeta) {
            nextMintQuote = {
              ...nextMintQuote,
              suppressChecks: true,
            };
            delete nextMintQuote.lastError;
            delete nextMintQuote.lastErrorAt;
            delete nextMintQuote.errorCount;
            quoteChanged = true;
          }
        }
        if (!tokenChanged && !quoteChanged) {
          return entry;
        }
        changed = true;
        return {
          ...entry,
          ...(tokenChanged ? { tokenState: nextTokenState } : {}),
          ...(quoteChanged ? { mintQuote: nextMintQuote } : {}),
        };
      });
      return changed ? next : prev;
    });
  }, [
    clearProofStateSubscriptions,
    setHistory,
    setHistoryCheckStates,
    setHistoryMintQuoteStates,
  ]);

  const isHistoryEntryPending = useCallback((entry) => {
    if (entry.pendingTokenId && entry.pendingStatus !== "redeemed") return true;
    if (entry.tokenState && entry.tokenState.lastState !== "SPENT") return true;
    if (entry.mintQuote) return true;
    return false;
  }, []);

  const expireStaleMintQuotes = useCallback(() => {
    setHistory((prev) => {
      const now = Date.now();
      let changed = false;
      const removedIds = [];
      const next = prev.filter((entry) => {
        const expiresAt = entry.mintQuote?.expiresAt;
        if (!expiresAt) return true;
        if (expiresAt > now) return true;
        changed = true;
        removedIds.push(entry.id);
        return false;
      });
      if (changed) {
        setHistoryMintQuoteStates((prevStates) => {
          if (!removedIds.length) return prevStates;
          const updated = { ...prevStates };
          removedIds.forEach((id) => {
            if (id in updated) {
              delete updated[id];
            }
          });
          return updated;
        });
      }
      return changed ? next : prev;
    });
  }, [setHistory, setHistoryMintQuoteStates]);

  const pruneStaleUnpaidMintQuotes = useCallback(() => {
    setHistory((prev) => {
      const now = Date.now();
      let changed = false;
      const removedIds = [];
      const next = prev.filter((entry) => {
        const mintQuote = entry.mintQuote;
        if (!mintQuote) return true;
        const normalizedState =
          typeof mintQuote.state === "string" && mintQuote.state
            ? mintQuote.state.toUpperCase()
            : "";
        if (normalizedState === "PAID" || normalizedState === "ISSUED") return true;
        const createdAt =
          typeof mintQuote.createdAt === "number"
            ? mintQuote.createdAt
            : typeof entry.createdAt === "number"
              ? entry.createdAt
              : deriveTimestampFromId(entry.id);
        if (!Number.isFinite(createdAt) || createdAt <= 0) return true;
        if (now - createdAt < UNPAID_MINT_QUOTE_RETENTION_MS) return true;
        changed = true;
        removedIds.push(entry.id);
        return false;
      });
      if (!changed) return prev;
      setHistoryMintQuoteStates((prevStates) => {
        if (!removedIds.some((id) => id in prevStates)) return prevStates;
        const updated = { ...prevStates };
        removedIds.forEach((id) => {
          if (id in updated) {
            delete updated[id];
          }
        });
        return updated;
      });
      return next;
    });
  }, [setHistory, setHistoryMintQuoteStates]);

  return {
    handleRevertHistoryToken,
    handleMintQuoteClaimSuccess,
    claimMintQuoteById,
    performTokenStateCheck,
    handleCheckHistoryMintQuote,
    clearProofStateSubscriptions,
    resetTokenTracking,
    isHistoryEntryPending,
    expireStaleMintQuotes,
    pruneStaleUnpaidMintQuotes,
  };
}
