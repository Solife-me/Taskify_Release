import React, { useState, useCallback, useEffect, useMemo } from "react";
import type { Proof } from "@cashu/cashu-ts";
import { kvStorage } from "../../storage/kvStorage";
import { LS_BTC_USD_PRICE_CACHE } from "../../localStorageKeys";
import { loadStore as loadProofStore, getMintList, addMintToList } from "../../wallet/storage";
import { COINBASE_SPOT_PRICE_URL } from "../../lib/pricing";
import { SATS_PER_BTC } from "../../domains/appTypes";
import { ActionSheet } from "../../components/ActionSheet";
import type { LockRecipientSelection } from "./LockToNpubSheet";

function normalizeMintUrlLite(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

function formatMintLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname) return parsed.hostname;
  } catch {
    // ignore parse errors
  }
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function sumMintProofs(proofs: Proof[]): number {
  if (!Array.isArray(proofs)) return 0;
  return proofs.reduce((sum, proof) => {
    const value = (proof as any)?.amount;
    let amt = 0;
    try {
      if (typeof value === "number") {
        amt = value;
      } else if (typeof value === "bigint") {
        amt = value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
      } else if (typeof value?.toNumber === "function") {
        amt = value.toNumber();
      } else if (typeof value?.toNumberUnsafe === "function") {
        amt = value.toNumberUnsafe();
      } else {
        amt = Number(value);
      }
    } catch {
      amt = 0;
    }
    return sum + (amt > 0 ? Math.floor(amt) : 0);
  }, 0);
}

function ChevronDownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M5.22 7.97a.75.75 0 0 0-1.06 1.06l5 5a.75.75 0 0 0 1.06 0l5-5a.75.75 0 1 0-1.06-1.06L10 12.44 5.22 7.97Z" />
    </svg>
  );
}

function BountyAttachSheet({
  open,
  onClose,
  onAttach,
  lockToSelf,
  onToggleLockToSelf,
  onOpenLockContacts,
  lockRecipient,
  onClearRecipient,
  walletConversionEnabled,
  walletPrimaryCurrency,
  mintUrl,
}: {
  open: boolean;
  onClose: () => void;
  onAttach: (amountSat: number, mintUrl?: string) => Promise<void>;
  lockToSelf: boolean;
  onToggleLockToSelf: () => void;
  onOpenLockContacts: () => void;
  lockRecipient: LockRecipientSelection | null;
  onClearRecipient: () => void;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  mintUrl: string;
}) {
  const [amountInput, setAmountInput] = useState("");
  const [primaryCurrency, setPrimaryCurrency] = useState<"sat" | "usd">(
    walletConversionEnabled && walletPrimaryCurrency === "usd" ? "usd" : "sat",
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [btcUsdPrice, setBtcUsdPrice] = useState<number | null>(null);
  const [priceStatus, setPriceStatus] = useState<"idle" | "loading" | "error">("idle");
  const [mintOptions, setMintOptions] = useState<{
    url: string;
    normalized: string;
    balance: number;
    isActive: boolean;
  }[]>([]);
  const [selectedMint, setSelectedMint] = useState("");
  const usdFormatter = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [],
  );
  const satFormatter = useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }), []);
  const canToggleCurrency = walletConversionEnabled;
  const shortenLabel = useCallback((value: string) => {
    if (value.length <= 28) return value;
    return `${value.slice(0, 12)}…${value.slice(-6)}`;
  }, []);

  useEffect(() => {
    if (!open) return;
    setAmountInput("");
    setSubmitError("");
    setPrimaryCurrency(walletConversionEnabled && walletPrimaryCurrency === "usd" ? "usd" : "sat");
  }, [open, walletConversionEnabled, walletPrimaryCurrency]);

  const refreshMintOptions = useCallback(() => {
    try {
      const store = loadProofStore();
      const storeEntries = new Map<string, { url: string; proofs: Proof[] }>();
      Object.entries(store).forEach(([url, proofs]) => {
        const normalized = normalizeMintUrlLite(url);
        if (!normalized) return;
        storeEntries.set(normalized, {
          url,
          proofs: Array.isArray(proofs) ? (proofs as Proof[]) : [],
        });
      });

      let trackedMints = getMintList();
      const trackedSet = new Set<string>();
      for (const url of trackedMints) {
        const normalized = normalizeMintUrlLite(url);
        if (!normalized) continue;
        trackedSet.add(normalized);
      }

      if (mintUrl) {
        const normalizedActive = normalizeMintUrlLite(mintUrl);
        if (normalizedActive && !trackedSet.has(normalizedActive)) {
          trackedMints = addMintToList(mintUrl);
          trackedSet.add(normalizedActive);
        }
      }

      storeEntries.forEach((payload, normalized) => {
        const hasBalance = sumMintProofs(payload.proofs) > 0;
        if (hasBalance && !trackedSet.has(normalized)) {
          trackedMints = addMintToList(payload.url);
          trackedSet.add(normalized);
        }
      });

      const entries: { url: string; normalized: string; balance: number; isActive: boolean }[] = [];
      const seen = new Set<string>();
      for (const url of trackedMints) {
        const normalized = normalizeMintUrlLite(url);
        if (!normalized || seen.has(normalized)) continue;
        const payload = storeEntries.get(normalized);
        const proofs = payload?.proofs ?? [];
        const balance = sumMintProofs(proofs);
        entries.push({
          url: payload?.url ?? url,
          normalized,
          balance,
          isActive: normalized === normalizeMintUrlLite(mintUrl),
        });
        seen.add(normalized);
      }

      entries.sort((a, b) => b.balance - a.balance || a.url.localeCompare(b.url));
      setMintOptions(entries);
    } catch {
      setMintOptions([]);
    }
  }, [mintUrl]);

  useEffect(() => {
    if (!open) return;
    refreshMintOptions();
  }, [open, refreshMintOptions]);

  useEffect(() => {
    if (!open) return;
    const normalizedActive = mintUrl ? normalizeMintUrlLite(mintUrl) : "";
    setSelectedMint((current) => {
      if (current && mintOptions.some((option) => option.normalized === current)) {
        return current;
      }
      if (normalizedActive && mintOptions.some((option) => option.normalized === normalizedActive)) {
        return normalizedActive;
      }
      return mintOptions[0]?.normalized ?? normalizedActive ?? "";
    });
  }, [mintOptions, mintUrl, open]);

  useEffect(() => {
    if (!open || !walletConversionEnabled) {
      setPriceStatus("idle");
      return;
    }
    let cancelled = false;
    try {
      const cachedRaw = kvStorage.getItem(LS_BTC_USD_PRICE_CACHE);
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw);
        const cached = Number(parsed?.price);
        if (Number.isFinite(cached) && cached > 0) {
          setBtcUsdPrice((current) => (current == null ? cached : current));
        }
      }
    } catch {
      // ignore cache parse errors
    }
    setPriceStatus("loading");
    (async () => {
      try {
        const response = await fetch(COINBASE_SPOT_PRICE_URL, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: any = await response.json();
        const amount = Number(payload?.data?.amount);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid price data");
        if (cancelled) return;
        setBtcUsdPrice(amount);
        setPriceStatus("idle");
        try {
          kvStorage.setItem(
            LS_BTC_USD_PRICE_CACHE,
            JSON.stringify({ price: amount, updatedAt: Date.now() }),
          );
        } catch {
          // ignore cache failures
        }
      } catch {
        if (!cancelled) {
          setPriceStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, walletConversionEnabled]);

  const keypadKeys = primaryCurrency === "usd"
    ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
    : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "⌫"];

  const handleKeypadInput = (key: string) => {
    setAmountInput((prev) => {
      if (key === "clear") return "";
      if (key === "backspace") return prev.slice(0, -1);
      if (primaryCurrency === "usd" && key === "decimal") {
        if (prev.includes(".")) return prev;
        return prev ? `${prev}.` : "0.";
      }
      if (key === "decimal") return prev;
      if (prev === "0" && key !== "decimal") {
        return key;
      }
      return `${prev}${key}`;
    });
  };

  const trimmedInput = amountInput.trim();
  const parsedAmount = useMemo(() => {
    if (!trimmedInput) return { sats: 0, error: "" };
    if (primaryCurrency === "usd") {
      const numeric = Number.parseFloat(trimmedInput);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return { sats: 0, error: "Enter a valid USD amount." };
      }
      if (!walletConversionEnabled) {
        return { sats: 0, error: "USD entry is disabled." };
      }
      if (!btcUsdPrice || btcUsdPrice <= 0) {
        return {
          sats: 0,
          error: priceStatus === "error" ? "USD price unavailable." : "Fetching BTC/USD price…",
        };
      }
      const sats = Math.floor((numeric / btcUsdPrice) * SATS_PER_BTC);
      if (sats <= 0) {
        return { sats: 0, error: "Amount is too small." };
      }
      return { sats, error: "" };
    }
    const numeric = Number.parseInt(trimmedInput, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return { sats: 0, error: "Enter an amount in sats." };
    }
    return { sats: numeric, error: "" };
  }, [trimmedInput, primaryCurrency, walletConversionEnabled, btcUsdPrice, priceStatus]);

  const primaryDisplay = useMemo(() => {
    if (primaryCurrency === "usd") {
      const numeric = Number.parseFloat(trimmedInput || "0");
      const displayValue = Number.isFinite(numeric) ? numeric : 0;
      return usdFormatter.format(displayValue);
    }
    return `${trimmedInput || "0"} sats`;
  }, [primaryCurrency, trimmedInput, usdFormatter]);

  const secondaryDisplay = useMemo(() => {
    if (primaryCurrency === "usd") {
      return parsedAmount.sats > 0 ? `${parsedAmount.sats} sats` : "≈ 0 sats";
    }
    if (!walletConversionEnabled) return "";
    if (!btcUsdPrice || btcUsdPrice <= 0) {
      return priceStatus === "error" ? "USD unavailable" : "";
    }
    const sats = Number.parseInt(trimmedInput || "0", 10);
    if (!Number.isFinite(sats) || sats <= 0) return "";
    const usdValue = (sats / SATS_PER_BTC) * btcUsdPrice;
    return `≈ ${usdFormatter.format(usdValue)}`;
  }, [btcUsdPrice, parsedAmount.sats, priceStatus, primaryCurrency, trimmedInput, usdFormatter, walletConversionEnabled]);

  const selectedMintOption = useMemo(
    () => mintOptions.find((option) => option.normalized === selectedMint) || null,
    [mintOptions, selectedMint],
  );

  const selectedMintLabel = selectedMintOption ? formatMintLabel(selectedMintOption.url) : "Choose a mint";
  const selectedMintBalanceLabel = selectedMintOption
    ? `${satFormatter.format(selectedMintOption.balance)} sat available`
    : "Select a mint to use";

  const lockRecipientLabel = useMemo(
    () => (lockRecipient?.label ? shortenLabel(lockRecipient.label) : ""),
    [lockRecipient?.label, shortenLabel],
  );

  const handleAttach = async () => {
    if (parsedAmount.sats <= 0 || parsedAmount.error) {
      setSubmitError(parsedAmount.error || "Enter an amount to attach.");
      return;
    }
    const targetMint = selectedMintOption?.url || mintUrl || undefined;
    setSubmitting(true);
    setSubmitError("");
    try {
      await onAttach(parsedAmount.sats, targetMint);
      setAmountInput("");
      onClose();
    } catch (error) {
      setSubmitError((error as Error)?.message || "Unable to attach bounty.");
    } finally {
      setSubmitting(false);
    }
  };

  const lockStatusLabel = lockRecipient
    ? `Locking to ${lockRecipientLabel}`
    : lockToSelf
      ? "Hidden until you reveal"
      : "Unlocked token";
  const lockStatusHint = lockRecipient
    ? "Only this recipient can decrypt it."
    : lockToSelf
      ? "Encrypted to your Nostr key."
      : "Anyone with the token can redeem it.";

  return (
    <ActionSheet open={open} onClose={onClose} title="Attach bounty" stackLevel={70} panelClassName="sheet-panel--tall">
      <div className="wallet-section space-y-4 text-sm">
        <div className="space-y-2 text-left">
          {mintOptions.length ? (
            <div className="relative">
              <select
                className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                aria-label="Select mint"
                value={selectedMint}
                onChange={(event) => setSelectedMint(event.target.value)}
              >
                {mintOptions.map((option) => (
                  <option key={option.normalized} value={option.normalized}>
                    {formatMintLabel(option.url)}
                  </option>
                ))}
              </select>
              <div className="pill-input lightning-mint-select__display">
                <div className="lightning-mint-select__label">{selectedMintLabel}</div>
                <div className="lightning-mint-select__balance">{selectedMintBalanceLabel}</div>
              </div>
              <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
            </div>
          ) : (
            <div className="text-sm text-secondary">Add a mint in Wallet → Mint balances to attach bounties.</div>
          )}
        </div>
        <button
          type="button"
          className={`lightning-amount-display glass-panel${canToggleCurrency ? " pressable" : ""}`}
          onClick={canToggleCurrency ? () => setPrimaryCurrency((prev) => (prev === "usd" ? "sat" : "usd")) : undefined}
          disabled={!canToggleCurrency}
        >
          <div className="wallet-balance-card__amount lightning-amount-display__primary">{primaryDisplay}</div>
          <div className="wallet-balance-card__secondary lightning-amount-display__secondary">{secondaryDisplay}</div>
        </button>
        <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
          <button
            type="button"
            className={`glass-panel pressable py-1${lockToSelf && !lockRecipient ? " ring-2 ring-accent/50" : ""}`}
            onClick={onToggleLockToSelf}
          >
            {lockToSelf ? "Lock to me (hidden)" : "Lock to me"}
          </button>
          <button
            type="button"
            className={`glass-panel pressable py-1${lockRecipient ? " ring-2 ring-accent/50" : ""}`}
            onClick={onOpenLockContacts}
          >
            {lockRecipient ? "Locking" : "Lock to npub"}
          </button>
        </div>
        <div className="rounded-2xl border border-surface bg-surface-muted p-3 space-y-1">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-10 w-10 items-center justify-center rounded-full ${
                lockRecipient
                  ? "bg-sky-500/15 text-sky-400"
                  : lockToSelf
                    ? "bg-accent/15 text-accent"
                    : "bg-surface text-secondary"
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <rect x={5} y={11} width={14} height={10} rx={2} />
                <path d="M8 11V7a4 4 0 1 1 8 0v4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <div className="text-sm font-semibold text-primary">{lockStatusLabel}</div>
              <div className="text-[11px] text-secondary">{lockStatusHint}</div>
            </div>
            {lockRecipient && (
              <button className="ghost-button button-sm pressable ml-auto" type="button" onClick={onClearRecipient}>
                Clear
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {keypadKeys.map((key) => {
            const handlerKey = key === "⌫" ? "backspace" : key === "." ? "decimal" : key;
            return (
              <button
                key={key}
                type="button"
                className="glass-panel pressable py-3 text-lg font-semibold"
                onClick={() => handleKeypadInput(handlerKey)}
              >
                {key === "clear" ? "Clear" : key}
              </button>
            );
          })}
        </div>
        <button
          className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
          onClick={handleAttach}
          disabled={submitting || parsedAmount.sats <= 0}
        >
          {submitting ? "Attaching…" : "Attach"}
        </button>
        {(submitError || parsedAmount.error) && (
          <div className="text-xs text-rose-500 text-center">{submitError || parsedAmount.error}</div>
        )}
        {!submitError && !parsedAmount.error && priceStatus === "loading" && walletConversionEnabled && (
          <div className="text-[11px] text-secondary text-center">Fetching BTC/USD price…</div>
        )}
      </div>
    </ActionSheet>
  );
}

export { normalizeMintUrlLite, formatMintLabel, sumMintProofs, BountyAttachSheet };
