import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { useNwc } from "../../context/NwcContext";
import { useWalletMode } from "../../wallet/walletMode";
import { kvStorage } from "../../storage/kvStorage";
import { LS_NWC_RECEIVE_ADDRESS } from "../../localStorageKeys";
import { decodeBolt11Amount } from "../../wallet/lightning";
import type { HistoryEntryInput, HistoryItem } from "../../wallet/walletHistoryTypes";

export type NwcReceiveInvoice = {
  request: string;
  paymentHash: string | null;
  amountSat: number;
  createdAt: number;
  status: "waiting" | "paid" | "error";
};

type PaymentResult = { state: string; feeReserveSat?: number | null; mintUrl?: string };

type Options = {
  open: boolean;
  showToast: (message: string, durationMs?: number) => void;
  formatSatAmount: (amount: number) => string;
  setHistory: Dispatch<SetStateAction<HistoryItem[]>>;
  buildHistoryEntry: (entry: HistoryEntryInput) => HistoryItem;
  payMintInvoice: (invoice: string) => Promise<PaymentResult>;
};

const LIGHTNING_ADDRESS = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

const addressListeners = new Set<() => void>();
function readReceiveAddress(): string {
  try {
    return (kvStorage.getItem(LS_NWC_RECEIVE_ADDRESS) ?? "").trim();
  } catch {
    return "";
  }
}
function subscribeReceiveAddress(listener: () => void) {
  addressListeners.add(listener);
  return () => {
    addressListeners.delete(listener);
  };
}

export function isValidLightningAddress(value: string): boolean {
  return LIGHTNING_ADDRESS.test(value.trim());
}

/** Sets the address shown on Receive in NWC mode ("" falls back to the wallet's own lud16). */
export function setNwcReceiveAddress(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed && !isValidLightningAddress(trimmed)) throw new Error("Enter a lightning address like name@example.com");
  if (trimmed) kvStorage.setItem(LS_NWC_RECEIVE_ADDRESS, trimmed);
  else kvStorage.removeItem(LS_NWC_RECEIVE_ADDRESS);
  addressListeners.forEach((listener) => listener());
}

export function useNwcReceiveAddressSetting(): string {
  return useSyncExternalStore(subscribeReceiveAddress, readReceiveAddress, readReceiveAddress);
}

/** Everything the wallet modal does differently when an NWC wallet is the active wallet. */
export function useNwcWalletMode({
  open,
  showToast,
  formatSatAmount,
  setHistory,
  buildHistoryEntry,
  payMintInvoice,
}: Options) {
  const nwc = useNwc();
  const walletMode = useWalletMode();
  const nwcWalletActive = walletMode === "nwc" && !!nwc.connection;
  const walletLabel = nwc.info?.alias || nwc.connection?.walletName || "NWC wallet";
  const balanceSat = typeof nwc.info?.balanceMsat === "number" ? Math.floor(nwc.info.balanceMsat / 1000) : null;

  // --- Receive address -----------------------------------------------------
  const customAddress = useNwcReceiveAddressSetting();
  const receiveAddress = customAddress || nwc.connection?.walletLud16 || "";
  const setCustomReceiveAddress = setNwcReceiveAddress;

  // --- Balance ---------------------------------------------------------------
  const { getBalanceMsat, refreshInfo } = nwc;
  const refreshBalance = useCallback(() => {
    getBalanceMsat().catch(() => null);
  }, [getBalanceMsat]);

  // A restored connection has no get_info yet (alias, methods); fetch it with the balance.
  useEffect(() => {
    if (open && nwcWalletActive) refreshInfo().catch(() => null);
  }, [open, nwcWalletActive, refreshInfo]);

  // --- Sending ---------------------------------------------------------------
  const { payInvoice, lookupInvoice } = nwc;
  const payViaNwc = useCallback(
    async (invoice: string): Promise<PaymentResult> => {
      try {
        const res = await payInvoice(invoice);
        const feesMsat = typeof res?.fees_paid === "number" ? res.fees_paid : null;
        refreshBalance();
        return { state: "Paid", feeReserveSat: feesMsat !== null ? Math.ceil(feesMsat / 1000) : null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/timed out/i.test(message)) throw error;
        // No answer is not a failure: the payment may still be in flight. Check before
        // telling the user anything that could make them pay twice.
        const status = await lookupInvoice({ invoice }).catch(() => null);
        const settled =
          String(status?.state ?? "").toLowerCase() === "settled" ||
          (typeof status?.settled_at === "number" && status.settled_at > 0);
        if (settled) {
          refreshBalance();
          return { state: "Paid" };
        }
        throw new Error(
          "Your wallet hasn't confirmed this payment yet. Check your wallet's history before trying again.",
        );
      }
    },
    [lookupInvoice, payInvoice, refreshBalance],
  );

  const payLightningInvoice = useCallback(
    (invoice: string) => (nwcWalletActive ? payViaNwc(invoice) : payMintInvoice(invoice)),
    [nwcWalletActive, payMintInvoice, payViaNwc],
  );

  // --- Receiving -------------------------------------------------------------
  const [receiveInvoice, setReceiveInvoice] = useState<NwcReceiveInvoice | null>(null);
  const [receiveError, setReceiveError] = useState("");
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const { makeInvoice } = nwc;

  const createReceiveInvoice = useCallback(
    async (amountSat: number, memo?: string) => {
      if (creatingInvoice) return null;
      setReceiveError("");
      setCreatingInvoice(true);
      try {
        if (!Number.isSafeInteger(amountSat) || amountSat <= 0) throw new Error("Enter an amount");
        const res = await makeInvoice(amountSat * 1000, memo);
        const request = res.invoice.trim();
        // Show only an invoice for exactly what was asked for.
        const { amountMsat } = decodeBolt11Amount(request);
        if (amountMsat !== null && amountMsat !== BigInt(amountSat) * 1000n) {
          throw new Error("Your wallet returned an invoice for a different amount");
        }
        const next: NwcReceiveInvoice = {
          request,
          paymentHash: typeof res.payment_hash === "string" ? res.payment_hash : null,
          amountSat,
          createdAt: Date.now(),
          status: "waiting",
        };
        setReceiveInvoice(next);
        return next;
      } catch (error) {
        setReceiveError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        setCreatingInvoice(false);
      }
    },
    [creatingInvoice, makeInvoice],
  );

  const clearReceiveInvoice = useCallback(() => {
    setReceiveInvoice(null);
    setReceiveError("");
  }, []);

  const onReceivedRef = useRef<(() => void) | null>(null);
  const setOnReceived = useCallback((handler: (() => void) | null) => {
    onReceivedRef.current = handler;
  }, []);

  useEffect(() => {
    if (!receiveInvoice || receiveInvoice.status !== "waiting") return;
    let cancelled = false;
    let inFlight = false;
    const { request, paymentHash, amountSat } = receiveInvoice;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const res = await lookupInvoice(paymentHash ? { paymentHash } : { invoice: request });
        const settled =
          String(res?.state ?? "").toLowerCase() === "settled" ||
          (typeof res?.settled_at === "number" && res.settled_at > 0);
        if (settled && !cancelled) {
          cancelled = true;
          setReceiveInvoice((current) => (current?.request === request ? { ...current, status: "paid" } : current));
          setHistory((h) => [
            buildHistoryEntry({
              id: `nwc-in-${paymentHash ?? Date.now()}`,
              summary: `Received ${amountSat} sats`,
              detail: request,
              detailKind: "invoice",
              type: "lightning",
              direction: "in",
              amountSat,
              stateLabel: "Paid",
            }),
            ...h,
          ]);
          showToast(`received ${formatSatAmount(amountSat)}`, 3500);
          refreshBalance();
          onReceivedRef.current?.();
        }
      } catch {
        // wallets without lookup_invoice: the user still sees the invoice and balance
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [buildHistoryEntry, formatSatAmount, lookupInvoice, receiveInvoice, refreshBalance, setHistory, showToast]);

  return useMemo(
    () => ({
      nwcWalletActive,
      walletLabel,
      balanceSat,
      refreshBalance,
      receiveAddress,
      customReceiveAddress: customAddress,
      walletLud16: nwc.connection?.walletLud16 ?? "",
      setCustomReceiveAddress,
      payLightningInvoice,
      receiveInvoice,
      receiveError,
      creatingInvoice,
      createReceiveInvoice,
      clearReceiveInvoice,
      setOnReceived,
    }),
    [
      balanceSat,
      clearReceiveInvoice,
      createReceiveInvoice,
      creatingInvoice,
      customAddress,
      nwc.connection?.walletLud16,
      nwcWalletActive,
      payLightningInvoice,
      receiveAddress,
      receiveError,
      receiveInvoice,
      refreshBalance,
      setCustomReceiveAddress,
      setOnReceived,
      walletLabel,
    ],
  );
}
