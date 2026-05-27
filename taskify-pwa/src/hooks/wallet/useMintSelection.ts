import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { formatMintDisplayName } from "../../ui/wallet/walletModalUi";
import { normalizeMintUrl } from "../../wallet/cashuProofHelpers";
import type { MintEntry } from "./useMintBackup";

export type MintInfo = {
  name?: string;
  unit?: string;
};

export type MintSelectionOption = {
  url: string;
  normalized: string;
  balance: number;
  isActive: boolean;
};

export type SwapOption = {
  value: string;
  type: "mint" | "nwc";
};

export type SwapOptionMeta = {
  label: string;
  balanceLabel: string;
};

export type UseMintSelectionOptions = {
  activeMintInfo?: MintInfo | null;
  hasNwcConnection: boolean;
  mintEntries: MintEntry[];
  mintUrl?: string | null;
  nwcAlias?: string | null;
  nwcBalanceSats?: number | null;
  preloadMintInfo: boolean;
  refreshMintEntries: () => void;
  setSwapFromValue: Dispatch<SetStateAction<string>>;
  setSwapToValue: Dispatch<SetStateAction<string>>;
  showNwcSheet: boolean;
  swapFromValue: string;
  swapToValue: string;
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const { signal, ...rest } = init;
  if (signal) {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export function useMintSelection({
  activeMintInfo,
  hasNwcConnection,
  mintEntries,
  mintUrl,
  nwcAlias,
  nwcBalanceSats,
  preloadMintInfo,
  refreshMintEntries,
  setSwapFromValue,
  setSwapToValue,
  showNwcSheet,
  swapFromValue,
  swapToValue,
}: UseMintSelectionOptions) {
  const [mintInfoByUrl, setMintInfoByUrl] = useState<Record<string, MintInfo>>({});
  const pendingMintInfoRef = useRef<Set<string>>(new Set());
  const satFormatter = useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }), []);

  const ensureMintInfo = useCallback(
    async (url: string) => {
      const normalized = normalizeMintUrl(url);
      if (!normalized) return;
      if (mintInfoByUrl[normalized] || pendingMintInfoRef.current.has(normalized)) return;
      pendingMintInfoRef.current.add(normalized);
      const fallbackName = formatMintDisplayName(normalized);
      const targets = ["info", "v1/info", "api/v1/info"].map((segment) => `${normalized}/${segment}`);
      let resolvedName: string | undefined;
      let resolvedUnit: string | undefined;
      try {
        for (const target of targets) {
          try {
            const response = await fetchWithTimeout(target, { headers: { accept: "application/json" } }, 10000);
            if (!response.ok) {
              continue;
            }
            const data = await response.json().catch(() => null);
            if (!data || typeof data !== "object") {
              continue;
            }
            const candidateName = typeof (data as any)?.name === "string" ? (data as any).name.trim() : "";
            const candidateUnit = typeof (data as any)?.unit === "string" ? (data as any).unit.trim() : undefined;
            if (candidateName && !resolvedName) {
              resolvedName = candidateName;
            }
            if (candidateUnit && !resolvedUnit) {
              resolvedUnit = candidateUnit;
            }
            if (resolvedName && resolvedUnit) {
              break;
            }
          } catch {
            continue;
          }
        }
      } finally {
        setMintInfoByUrl((prev) => ({
          ...prev,
          [normalized]: {
            name: resolvedName || prev[normalized]?.name || fallbackName,
            unit: resolvedUnit ?? prev[normalized]?.unit,
          },
        }));
        pendingMintInfoRef.current.delete(normalized);
      }
    },
    [mintInfoByUrl],
  );

  useEffect(() => {
    if (!mintUrl) return;
    const normalized = normalizeMintUrl(mintUrl);
    if (!normalized) return;
    const derivedName = activeMintInfo?.name?.trim();
    const derivedUnit = activeMintInfo?.unit;
    setMintInfoByUrl((prev) => {
      const existing = prev[normalized];
      const nextName = derivedName || existing?.name || formatMintDisplayName(normalized);
      const nextUnit = derivedUnit ?? existing?.unit;
      if (existing && existing.name === nextName && existing.unit === nextUnit) {
        return prev;
      }
      return {
        ...prev,
        [normalized]: {
          name: nextName,
          unit: nextUnit,
        },
      };
    });
  }, [mintUrl, activeMintInfo?.name, activeMintInfo?.unit]);

  const mintEntriesByNormalized = useMemo(() => {
    const map = new Map<string, MintEntry>();
    mintEntries.forEach((entry) => {
      const normalized = normalizeMintUrl(entry.url);
      if (!normalized) return;
      map.set(normalized, entry);
    });
    return map;
  }, [mintEntries]);

  const mintSelectionOptions = useMemo(() => {
    const options: MintSelectionOption[] = [];
    const seen = new Set<string>();
    const normalizedActive = mintUrl ? normalizeMintUrl(mintUrl) : null;

    if (normalizedActive) {
      const activeEntry = mintEntriesByNormalized.get(normalizedActive);
      options.push({
        url: activeEntry?.url ?? mintUrl!,
        normalized: normalizedActive,
        balance: activeEntry?.balance ?? 0,
        isActive: true,
      });
      seen.add(normalizedActive);
    }

    for (const entry of mintEntries) {
      const normalized = normalizeMintUrl(entry.url);
      if (!normalized || seen.has(normalized)) continue;
      options.push({ url: entry.url, normalized, balance: entry.balance, isActive: false });
      seen.add(normalized);
    }

    return options;
  }, [mintEntries, mintEntriesByNormalized, mintUrl]);

  const swapOptionList = useMemo(() => {
    const options: SwapOption[] = mintSelectionOptions.map((option) => ({
      value: option.normalized,
      type: "mint",
    }));
    if (hasNwcConnection) {
      options.push({ value: "nwc", type: "nwc" });
    }
    return options;
  }, [hasNwcConnection, mintSelectionOptions]);

  const getSwapOptionMeta = useCallback(
    (value: string): SwapOptionMeta => {
      if (!value) {
        return { label: "No selection", balanceLabel: "Choose a mint or wallet" };
      }
      if (value === "nwc") {
        if (!hasNwcConnection) {
          return { label: "NWC wallet", balanceLabel: "Not connected" };
        }
        const alias = nwcAlias?.trim();
        const label = alias || "NWC wallet";
        const balanceLabel =
          nwcBalanceSats != null
            ? `${satFormatter.format(nwcBalanceSats)} sat available`
            : "Balance unknown";
        return { label, balanceLabel };
      }
      const entry = mintEntriesByNormalized.get(value);
      const info = mintInfoByUrl[value];
      const fallbackName = entry ? formatMintDisplayName(entry.url) : formatMintDisplayName(value);
      const label = info?.name || fallbackName;
      const balance = entry?.balance ?? 0;
      return { label, balanceLabel: `${satFormatter.format(balance)} sat available` };
    },
    [hasNwcConnection, mintEntriesByNormalized, mintInfoByUrl, nwcAlias, nwcBalanceSats, satFormatter],
  );

  useEffect(() => {
    if (!showNwcSheet) return;
    refreshMintEntries();
  }, [refreshMintEntries, showNwcSheet]);

  useEffect(() => {
    if (!showNwcSheet) return;
    setSwapFromValue((current) => (current ? "" : current));
    setSwapToValue((current) => (current ? "" : current));
  }, [setSwapFromValue, setSwapToValue, showNwcSheet]);

  useEffect(() => {
    if (!showNwcSheet) return;
    const mintedValues = mintSelectionOptions.map((option) => option.normalized);
    const availableOptions = hasNwcConnection ? ["nwc", ...mintedValues] : [...mintedValues];
    let fromCandidate = swapFromValue;
    if (fromCandidate === "nwc" && !hasNwcConnection) {
      fromCandidate = "";
    } else if (fromCandidate && !availableOptions.includes(fromCandidate)) {
      fromCandidate = "";
    }
    let toCandidate = swapToValue;
    if (toCandidate === "nwc" && !hasNwcConnection) {
      toCandidate = "";
    } else if (toCandidate && !availableOptions.includes(toCandidate)) {
      toCandidate = "";
    }
    if (fromCandidate && fromCandidate === toCandidate) {
      toCandidate = "";
    }
    if (fromCandidate !== swapFromValue) {
      setSwapFromValue(fromCandidate);
    }
    if (toCandidate !== swapToValue) {
      setSwapToValue(toCandidate);
    }
  }, [
    hasNwcConnection,
    mintSelectionOptions,
    setSwapFromValue,
    setSwapToValue,
    showNwcSheet,
    swapFromValue,
    swapToValue,
  ]);

  useEffect(() => {
    if (!preloadMintInfo) return;
    mintSelectionOptions.forEach((option) => {
      void ensureMintInfo(option.url);
    });
  }, [ensureMintInfo, mintSelectionOptions, preloadMintInfo]);

  const selectedMintOption = useMemo(
    () => mintSelectionOptions.find((option) => option.isActive) || null,
    [mintSelectionOptions],
  );
  const selectedMintBalance = selectedMintOption?.balance ?? 0;
  const selectedMintValue = selectedMintOption?.normalized ?? "";
  const selectedMintLabel = selectedMintOption
    ? mintInfoByUrl[selectedMintOption.normalized]?.name || formatMintDisplayName(selectedMintOption.url)
    : "Select mint";
  const selectedMintBalanceLabel =
    selectedMintBalance > 0
      ? `${satFormatter.format(selectedMintBalance)} sat available`
      : "No eCash stored yet";

  return {
    mintInfoByUrl,
    mintEntriesByNormalized,
    mintSelectionOptions,
    swapOptionList,
    getSwapOptionMeta,
    selectedMintValue,
    selectedMintLabel,
    selectedMintBalanceLabel,
  };
}
