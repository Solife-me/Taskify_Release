// @ts-nocheck
import { useCallback } from "react";
import {
  NpubCashError,
  claimPendingEcashFromNpubCash,
  deriveNpubCashIdentity,
} from "../../wallet/npubCash";
import { getSkSync as nostrSkSync } from "../../lib/nostrSkStore";
import { amountFromCashuToken } from "../../wallet/cashuProofHelpers";
import {
  deriveSpentHistoryTokenStateFromToken,
  type HistoryEntryInput,
} from "../../wallet/walletHistoryTypes";

interface UseNpubCashClaimOptions {
  buildHistoryEntry: (opts: any) => any;
  mintUrl: string | null;
  npubCashLightningAddressEnabled: boolean;
  receiveToken: (token: string) => Promise<any>;
  setHistory: React.Dispatch<React.SetStateAction<any[]>>;
  showToast: (msg: string, ms?: number) => void;
  setNpubCashIdentity: (identity: any) => void;
  setNpubCashIdentityError: (err: any) => void;
  setNpubCashClaimStatus: (status: string) => void;
  setNpubCashClaimMessage: (msg: string) => void;
  npubCashClaimingRef: React.MutableRefObject<boolean>;
  backgroundNpubCashClaimRef: React.MutableRefObject<boolean>;
  npubCashClaimAbortRef: React.MutableRefObject<AbortController | null>;
}

export function useNpubCashClaim(opts: UseNpubCashClaimOptions) {
  const {
    buildHistoryEntry,
    mintUrl,
    npubCashLightningAddressEnabled,
    receiveToken,
    setHistory,
    showToast,
    setNpubCashIdentity,
    setNpubCashIdentityError,
    setNpubCashClaimStatus,
    setNpubCashClaimMessage,
    npubCashClaimingRef,
    backgroundNpubCashClaimRef,
    npubCashClaimAbortRef,
  } = opts;

  const handleClaimNpubCash = useCallback(
    async (options?: { auto?: boolean }) => {
      if (!npubCashLightningAddressEnabled) return;
      if (npubCashClaimingRef.current) return;
      const auto = options?.auto === true;
      const storedSk = nostrSkSync();
      if (!storedSk) {
        setNpubCashIdentity(null);
        const message = "Add your Taskify Nostr key in Settings → Nostr to use npub.cash.";
        setNpubCashIdentityError(message);
        if (!auto) {
          setNpubCashClaimStatus("error");
          setNpubCashClaimMessage(message);
        }
        return;
      }

      let identity: ReturnType<typeof deriveNpubCashIdentity> | null = null;
      try {
        identity = deriveNpubCashIdentity(storedSk);
        setNpubCashIdentity({ npub: identity.npub, address: identity.address });
        setNpubCashIdentityError(null);
      } catch (err: any) {
        const message = err?.message || "Unable to derive npub.cash address.";
        setNpubCashIdentity(null);
        setNpubCashIdentityError(message);
        if (!auto) {
          setNpubCashClaimStatus("error");
          setNpubCashClaimMessage(message);
        }
        return;
      }

      if (!mintUrl) {
        if (!auto) {
          setNpubCashClaimStatus("error");
          setNpubCashClaimMessage("Select an active mint before claiming from npub.cash.");
        }
        return;
      }

      if (auto) {
        backgroundNpubCashClaimRef.current = true;
      }
      const controller = new AbortController();
      npubCashClaimAbortRef.current = controller;
      npubCashClaimingRef.current = true;
      setNpubCashClaimStatus("checking");
      setNpubCashClaimMessage("Checking npub.cash for pending tokens…");

      try {
        const result = await claimPendingEcashFromNpubCash(storedSk, { signal: controller.signal });
        const tokens = Array.isArray(result.tokens) ? result.tokens : [];
        const reportedBalance = Number.isFinite(result.balance)
          ? Math.max(0, Math.floor(result.balance))
          : 0;
        if (reportedBalance > 0) {
          setNpubCashClaimMessage(
            `npub.cash reports ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"} ready to claim…`,
          );
        }
        if (!tokens.length) {
          if (reportedBalance > 0) {
            setNpubCashClaimStatus("error");
            setNpubCashClaimMessage(
              `npub.cash reported ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"}, but no token was returned. Please try again later.`,
            );
          } else {
            setNpubCashClaimStatus("idle");
            setNpubCashClaimMessage("No pending eCash found.");
          }
          return;
        }

        let successCount = 0;
        let totalRedeemedSat = 0;
        let savedForLaterCount = 0;
        let totalSavedSat = 0;
        let lastError: string | null = null;
        const successTokens: string[] = [];
        const crossMintMints = new Set<string>();
        const tokenHistoryEntries: HistoryEntryInput[] = [];
        let tokenEntryCounter = 0;
        for (const token of tokens) {
          try {
            const normalizedToken = typeof token === "string" ? token.trim() : "";
            if (!normalizedToken) {
              continue;
            }
            let decodedAmount = 0;
            decodedAmount = amountFromCashuToken(normalizedToken);

            decodedAmount = Math.max(0, Math.floor(decodedAmount));

            const res = await receiveToken(normalizedToken);
            if (res.savedForLater) {
              savedForLaterCount += 1;
              totalSavedSat += decodedAmount;
            } else {
              successCount += 1;
              totalRedeemedSat += decodedAmount;
            }
            successTokens.push(normalizedToken);
            if (res.crossMint && res.usedMintUrl) {
              crossMintMints.add(res.usedMintUrl);
            }
            const resolvedMintUrl = res.usedMintUrl ?? mintUrl ?? undefined;
            const amountSummary =
              decodedAmount > 0 ? `${decodedAmount} sat${decodedAmount === 1 ? "" : "s"}` : "token";
            const capitalizedAmountSummary = decodedAmount > 0 ? amountSummary : "Token";
            const crossMintNote = res.crossMint && res.usedMintUrl ? ` at ${res.usedMintUrl}` : "";
            const tokenSummary = res.savedForLater
              ? `Saved ${capitalizedAmountSummary} via npub.cash${crossMintNote}`
              : `Received ${capitalizedAmountSummary} via npub.cash${crossMintNote}`;
            const tokenState = !res.savedForLater
              ? deriveSpentHistoryTokenStateFromToken(normalizedToken, Date.now())
              : undefined;
            const historyEntry: HistoryEntryInput = {
              id: `npubcash-token-${Date.now()}-${tokenEntryCounter++}`,
              summary: tokenSummary,
              detail: normalizedToken,
              detailKind: "token",
              type: "ecash",
              direction: "in",
              amountSat: decodedAmount || undefined,
              mintUrl: resolvedMintUrl,
            };
            if (tokenState) {
              historyEntry.tokenState = tokenState;
            }
            if (res.savedForLater) {
              if (res.pendingTokenId) {
                historyEntry.pendingTokenId = res.pendingTokenId;
                historyEntry.pendingStatus = "pending";
              }
              historyEntry.pendingTokenAmount = decodedAmount || undefined;
              historyEntry.pendingTokenMint = resolvedMintUrl;
            }
            tokenHistoryEntries.push(historyEntry);
          } catch (err: any) {
            lastError = err?.message || String(err);
          }
        }

        if (lastError) {
          setNpubCashClaimStatus("error");
          const prefix = successCount ? `Claimed ${successCount} token${successCount === 1 ? "" : "s"}, but ` : "";
          setNpubCashClaimMessage(`${prefix}${lastError}`);
        } else {
          setNpubCashClaimStatus("success");
          const mintedNote = crossMintMints.size
            ? `Stored at ${Array.from(crossMintMints).join(", ")}`
            : "";
          const reportNote =
            reportedBalance > 0 ? `npub.cash reported ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"}` : "";
          const messageParts: string[] = [];
          if (successCount > 0) {
            const satText = totalRedeemedSat
              ? ` for ${totalRedeemedSat} sat${totalRedeemedSat === 1 ? "" : "s"}`
              : "";
            messageParts.push(`Redeemed ${successCount} token${successCount === 1 ? "" : "s"}${satText}`);
          }
          if (savedForLaterCount > 0) {
            const satText = totalSavedSat
              ? ` totaling ${totalSavedSat} sat${totalSavedSat === 1 ? "" : "s"}`
              : "";
            messageParts.push(
              `${savedForLaterCount} token${savedForLaterCount === 1 ? "" : "s"} saved for later redemption${satText}`,
            );
          }
          const suffixParts = [mintedNote, reportNote].filter(Boolean);
          const details = suffixParts.length ? `Details: ${suffixParts.join("; ")}` : "";
          const summaryMessage = messageParts.length ? messageParts.join(". ") : "No tokens claimed.";
          setNpubCashClaimMessage([summaryMessage, details].filter(Boolean).join(" • "));
          let toastMessage: string;
          if (successCount > 0) {
            toastMessage = totalRedeemedSat
              ? `received ${totalRedeemedSat} sat${totalRedeemedSat === 1 ? "" : "s"}`
              : `received ${successCount} token${successCount === 1 ? "" : "s"}`;
          } else if (savedForLaterCount > 0) {
            toastMessage = `saved ${savedForLaterCount} token${savedForLaterCount === 1 ? "" : "s"} for later`;
          } else {
            toastMessage = "received token";
          }
          showToast(toastMessage, 3000);
          const detailParts = [`Address ${identity.address}`];
          if (identity.npub) detailParts.push(`npub ${identity.npub}`);
          if (totalRedeemedSat) {
            detailParts.push(`${totalRedeemedSat} sat${totalRedeemedSat === 1 ? "" : "s"}`);
          }
          if (savedForLaterCount) {
            detailParts.push(`Saved ${savedForLaterCount} token${savedForLaterCount === 1 ? "" : "s"} for later`);
          }
          if (crossMintMints.size) {
            detailParts.push(`Stored at ${Array.from(crossMintMints).join(", ")}`);
          }
          if (reportedBalance > 0) {
            detailParts.push(`npub.cash reported ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"}`);
          }
          const summary = totalRedeemedSat
            ? `Claimed ${totalRedeemedSat} sat${totalRedeemedSat === 1 ? "" : "s"} via npub.cash`
            : savedForLaterCount
              ? `Saved ${savedForLaterCount} token${savedForLaterCount === 1 ? "" : "s"} via npub.cash`
              : `Claimed token via npub.cash`;
          setHistory((prev) => {
            const crossMintSummaryUrl =
              crossMintMints.size === 1
                ? Array.from(crossMintMints)[0]
                : crossMintMints.size === 0
                  ? mintUrl || undefined
                  : undefined;
            const summaryEntry: HistoryEntryInput = {
              id: `npubcash-${Date.now()}`,
              summary,
              detail: detailParts.join(" · "),
              detailKind: "note",
            };
            if (crossMintSummaryUrl) {
              summaryEntry.mintUrl = crossMintSummaryUrl;
            }
            const additions: HistoryItem[] = [];
            if (tokenHistoryEntries.length) {
              additions.push(...tokenHistoryEntries.map((entry) => buildHistoryEntry(entry)));
            } else {
              additions.push(buildHistoryEntry(summaryEntry));
            }
            return [...additions, ...prev];
          });
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        if (err instanceof NpubCashError && err.status === 504) {
          const message = err.message || "npub.cash request timed out. Please try again later.";
          setNpubCashClaimStatus(auto ? "idle" : "error");
          setNpubCashClaimMessage(message);
          return;
        }
        const message = err?.message || "Unable to claim eCash from npub.cash.";
        setNpubCashClaimStatus("error");
        setNpubCashClaimMessage(message);
      } finally {
        npubCashClaimingRef.current = false;
        if (npubCashClaimAbortRef.current === controller) {
          npubCashClaimAbortRef.current = null;
        }
        if (auto) {
          backgroundNpubCashClaimRef.current = false;
        }
      }
    },
    [
      buildHistoryEntry,
      mintUrl,
      npubCashLightningAddressEnabled,
      receiveToken,
      setHistory,
      showToast,
    ],
  );

  return { handleClaimNpubCash };
}
