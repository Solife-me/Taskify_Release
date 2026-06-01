import { useCallback, useEffect, useState } from "react";
import { LS_BTC_USD_PRICE_CACHE } from "../../localStorageKeys";
import { COINBASE_SPOT_PRICE_URL } from "../../lib/pricing";
import { kvStorage } from "../../storage/kvStorage";

export const SATS_PER_BTC = 100_000_000;

export type WalletPriceStatus = "idle" | "loading" | "error";

type WalletPriceOptions = {
  enabled: boolean;
  active: boolean;
  refreshIntervalMs?: number;
  initialDelayMs?: number;
};

export function useWalletPrice({
  enabled,
  active,
  refreshIntervalMs = 300_000,
  initialDelayMs = 0,
}: WalletPriceOptions) {
  const [btcUsdPrice, setBtcUsdPrice] = useState<number | null>(null);
  const [priceStatus, setPriceStatus] = useState<WalletPriceStatus>("idle");
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<number | null>(null);

  const captureFiatValueUsd = useCallback(
    (amountSat?: number | null) => {
      if (!enabled || btcUsdPrice == null || btcUsdPrice <= 0) return undefined;
      if (typeof amountSat !== "number" || !Number.isFinite(amountSat)) return undefined;
      if (amountSat < 0) return undefined;
      const usdValue = (amountSat / SATS_PER_BTC) * btcUsdPrice;
      if (!Number.isFinite(usdValue)) return undefined;
      return Number(usdValue.toFixed(2));
    },
    [enabled, btcUsdPrice],
  );

  useEffect(() => {
    if (!enabled) return;
    try {
      const raw = kvStorage.getItem(LS_BTC_USD_PRICE_CACHE);
      if (!raw) return;
      const parsed: { price?: unknown; updatedAt?: unknown } = JSON.parse(raw);
      const cachedPrice = Number(parsed?.price);
      if (!Number.isFinite(cachedPrice) || cachedPrice <= 0) return;
      const cachedUpdatedAt = Number(parsed?.updatedAt);
      setBtcUsdPrice((current) => (current == null ? cachedPrice : current));
      setPriceUpdatedAt((current) => {
        if (current != null) return current;
        return Number.isFinite(cachedUpdatedAt) && cachedUpdatedAt > 0 ? cachedUpdatedAt : Date.now();
      });
    } catch (error) {
      console.warn("[wallet] Failed to read cached BTC/USD price", error);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !active) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let initialTimer: ReturnType<typeof setTimeout> | null = null;

    const loadPrice = async () => {
      try {
        setPriceStatus((prev) => (prev === "loading" ? prev : "loading"));
        const response = await fetch(COINBASE_SPOT_PRICE_URL, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: any = await response.json();
        const amount = Number(payload?.data?.amount);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid price data");
        if (cancelled) return;
        const fetchedAt = Date.now();
        setBtcUsdPrice(amount);
        setPriceUpdatedAt(fetchedAt);
        try {
          kvStorage.setItem(
            LS_BTC_USD_PRICE_CACHE,
            JSON.stringify({ price: amount, updatedAt: fetchedAt }),
          );
        } catch (error) {
          console.warn("[wallet] Failed to cache BTC/USD price", error);
        }
        setPriceStatus("idle");
      } catch {
        if (!cancelled) {
          setPriceStatus("error");
        }
      } finally {
        if (!cancelled) {
          refreshTimer = setTimeout(() => {
            void loadPrice();
          }, refreshIntervalMs);
        }
      }
    };

    const trigger = () => {
      if (!cancelled) {
        void loadPrice();
      }
    };

    if (initialDelayMs > 0) {
      initialTimer = setTimeout(trigger, initialDelayMs);
    } else {
      trigger();
    }

    return () => {
      cancelled = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [enabled, active, refreshIntervalMs, initialDelayMs]);

  useEffect(() => {
    if (!enabled) {
      setPriceStatus("idle");
    }
  }, [enabled]);

  return {
    btcUsdPrice,
    priceStatus,
    priceUpdatedAt,
    captureFiatValueUsd,
  };
}
