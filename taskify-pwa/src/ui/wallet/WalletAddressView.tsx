import { useCallback, useEffect, useMemo, useState } from "react";
import type { Settings } from "../../domains/tasks/settingsTypes";
import { useCashu } from "../../context/CashuContext";
import { useNwc } from "../../context/NwcContext";
import { useWalletMode } from "../../wallet/walletMode";
import { setNwcReceiveAddress, useNwcReceiveAddressSetting } from "../../hooks/wallet/useNwcWalletMode";
import { useToast } from "../../context/ToastContext";
import { getSkSync as nostrSkSync } from "../../lib/nostrSkStore";
import { getMintList, normalizeMintUrl } from "../../wallet/storage";
import {
  claimSolifeCustomAddress,
  clearSolifeAddressNwcForward,
  fetchSolifeAccount,
  fetchSolifeConfig,
  SOLIFE_LIGHTNING_ADDRESS_DOMAIN,
  setSolifeAddressNwcForward,
  updateSolifeLightningAddressMint,
  verifySolifeAddressPurchase,
  type SolifeAddress,
  type SolifeAccount,
  type SolifeAddressPurchase,
  type SolifeConfig,
} from "../../wallet/solife";
import {
  formatSatAmount,
  normalizeWalletDenominationDisplay,
} from "../../wallet/denomination";
import { useWalletHistory } from "../../hooks/wallet/useWalletHistory";

type WalletAddressViewProps = {
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  defaultRelays: string[];
};

type StatusKind = "idle" | "loading" | "saving" | "success" | "error";
type PurchaseStatus = "idle" | "purchasing" | "success" | "error";

function compactMintLabel(url: string): string {
  const raw = (url || "").trim();
  if (!raw) return "Unknown mint";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.host || raw;
  } catch {
    return raw.replace(/^https?:\/\//i, "");
  }
}

function normalizeAddress(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function isSettledSolifePurchase(purchase: SolifeAddressPurchase): boolean {
  return purchase.status === "address_claimed" || purchase.status === "expired" || purchase.status === "error";
}

async function verifySolifePurchaseUntilSettled(
  secretKey: string,
  purchaseId: string,
): Promise<SolifeAddressPurchase> {
  let latest = (await verifySolifeAddressPurchase(secretKey, purchaseId)).purchase;
  for (let attempt = 0; attempt < 5 && !isSettledSolifePurchase(latest); attempt += 1) {
    await sleep(1500);
    latest = (await verifySolifeAddressPurchase(secretKey, purchaseId)).purchase;
  }
  return latest;
}

export function WalletAddressView({
  settings,
  setSettings,
  defaultRelays,
}: WalletAddressViewProps) {
  const { show: showToast } = useToast();
  const { mintUrl, payInvoice } = useCashu();
  const nwc = useNwc();
  const walletMode = useWalletMode();
  const nwcWalletActive = walletMode === "nwc" && !!nwc.connection;
  const nwcWalletLabel = nwc.info?.alias || nwc.connection?.walletName || "NWC wallet";
  const nwcReceiveAddress = useNwcReceiveAddressSetting();
  const [forwardInput, setForwardInput] = useState("");
  const [forwardStatus, setForwardStatus] = useState<"idle" | "saving" | "error">("idle");
  const [forwardMessage, setForwardMessage] = useState("");
  const { setHistory, buildHistoryEntry } = useWalletHistory({
    showToast,
    captureFiatValueUsd: () => undefined,
  });
  const satFormatter = useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }), []);
  const walletDenominationDisplay = normalizeWalletDenominationDisplay(settings.walletDenominationDisplay);
  const formatSats = useCallback(
    (amount: number) => formatSatAmount(amount, satFormatter, walletDenominationDisplay),
    [satFormatter, walletDenominationDisplay],
  );

  const [config, setConfig] = useState<SolifeConfig | null>(null);
  const [account, setAccount] = useState<SolifeAccount | null>(null);
  const [status, setStatus] = useState<StatusKind>("idle");
  const [message, setMessage] = useState("");
  const [mintList, setMintList] = useState<string[]>(() => getMintList());
  const [customPageOpen, setCustomPageOpen] = useState(false);
  const [customHandle, setCustomHandle] = useState("");
  const [purchaseStatus, setPurchaseStatus] = useState<PurchaseStatus>("idle");
  const [purchaseMessage, setPurchaseMessage] = useState("");

  const provider = settings.lightningAddressProvider;
  // In NWC mode the Solife section manages forwarding, whatever the ecash address type.
  const solifeSelected = provider === "solife.me" || nwcWalletActive;
  const npubCashSelected = provider === "npub.cash";
  const configuredDomain = config?.domain || SOLIFE_LIGHTNING_ADDRESS_DOMAIN;
  const defaultSolifeAddress = normalizeAddress(account?.lightningAddress);
  const selectedSolifeAddress = normalizeAddress(settings.solifeLightningAddress);
  const activeSolifeAddress =
    selectedSolifeAddress &&
    (account?.addresses || []).some((address) => normalizeAddress(address.address) === selectedSolifeAddress)
      ? selectedSolifeAddress
      : defaultSolifeAddress;
  const activeSolifeAddressRecord = useMemo(
    () => (account?.addresses || []).find((address) => normalizeAddress(address.address) === activeSolifeAddress) || null,
    [account?.addresses, activeSolifeAddress],
  );

  const refreshMintChoices = useCallback(() => {
    const choices = new Set<string>();
    for (const url of getMintList()) {
      const normalized = normalizeMintUrl(url);
      if (normalized) choices.add(normalized);
    }
    const activeMint = normalizeMintUrl(mintUrl || "");
    if (activeMint) choices.add(activeMint);
    setMintList(Array.from(choices).sort((a, b) => a.localeCompare(b)));
  }, [mintUrl]);

  const refreshSolife = useCallback(async () => {
    setStatus("loading");
    setMessage("");
    refreshMintChoices();
    try {
      const nextConfig = await fetchSolifeConfig();
      setConfig(nextConfig);
      const storedSk = nostrSkSync();
      if (!storedSk) {
        setAccount(null);
        setStatus("error");
        setMessage("Add your Taskify Nostr key in Settings -> Nostr to manage Solife addresses.");
        return;
      }
      const result = await fetchSolifeAccount(storedSk);
      setConfig(result.config);
      setAccount(result.account);
      setStatus("idle");
      setMessage("");
    } catch (error: any) {
      setStatus("error");
      setMessage(error?.message || "Unable to load Solife address settings.");
    }
  }, [refreshMintChoices]);

  useEffect(() => {
    refreshMintChoices();
  }, [refreshMintChoices]);

  useEffect(() => {
    if (!solifeSelected) return;
    void refreshSolife();
  }, [refreshSolife, solifeSelected]);

  const setProvider = useCallback(
    (nextProvider: Settings["lightningAddressProvider"]) => {
      if (nextProvider === "none") {
        setSettings({
          lightningAddressProvider: "none",
          npubCashLightningAddressEnabled: false,
          npubCashAutoClaim: false,
        });
        return;
      }
      setSettings({
        lightningAddressProvider: nextProvider,
        npubCashLightningAddressEnabled: true,
        npubCashAutoClaim: nextProvider === "npub.cash" ? settings.npubCashAutoClaim : false,
      });
    },
    [setSettings, settings.npubCashAutoClaim],
  );

  const handleSelectSolifeMint = useCallback(
    async (nextValue: string) => {
      if (!activeSolifeAddressRecord) {
        setStatus("error");
        setMessage("Select a custom Solife address before changing its payment mint.");
        return;
      }
      const storedSk = nostrSkSync();
      if (!storedSk) {
        setStatus("error");
        setMessage("Add your Taskify Nostr key in Settings -> Nostr before changing your Solife mint.");
        return;
      }
      const normalized = nextValue === "__default__" ? null : normalizeMintUrl(nextValue);
      if (nextValue !== "__default__" && !normalized) return;
      setStatus("saving");
      setMessage(normalized ? `Saving ${compactMintLabel(normalized)}...` : "Resetting to Solife default mint...");
      try {
        const result = await updateSolifeLightningAddressMint(storedSk, {
          handle: activeSolifeAddressRecord.handle,
          mintUrl: normalized,
        });
        setConfig(result.config);
        setAccount((current) =>
          current
            ? {
                ...current,
                addresses: current.addresses.map((address) => ({
                  ...address,
                  ...(address.handle === activeSolifeAddressRecord.handle
                    ? { mintUrl: result.mintUrl, mintOverride: result.mintOverride }
                    : {}),
                })),
              }
            : current,
        );
        setStatus("success");
        setMessage(
          result.mintOverride
            ? `Using ${compactMintLabel(result.mintUrl)} for Solife payments.`
            : "Using the Solife default mint.",
        );
        showToast("Solife mint updated", 2500);
        void refreshSolife();
      } catch (error: any) {
        setStatus("error");
        setMessage(error?.message || "Unable to update your Solife mint.");
      }
    },
    [activeSolifeAddressRecord, refreshSolife, showToast],
  );

  const handlePurchaseCustomAddress = useCallback(async () => {
    const handle = customHandle.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle)) {
      setPurchaseStatus("error");
      setPurchaseMessage("Handle must be 2-32 characters using lowercase letters, numbers, _ or -.");
      return;
    }
    const storedSk = nostrSkSync();
    if (!storedSk) {
      setPurchaseStatus("error");
      setPurchaseMessage("Add your Taskify Nostr key in Settings -> Nostr before claiming a Solife address.");
      return;
    }

    setPurchaseStatus("purchasing");
    setPurchaseMessage("Creating Solife address purchase...");

    try {
      const nextConfig = config || (await fetchSolifeConfig());
      setConfig(nextConfig);
      const feeSats = Math.max(0, Math.floor(Number(nextConfig.customAddressPriceSats) || 0));
      if (feeSats > 0 && nextConfig.lnbitsConfigured === false) {
        throw new Error("Paid Solife address claims are temporarily unavailable.");
      }

      setPurchaseMessage(`Claiming ${handle}@${nextConfig.domain || configuredDomain}...`);
      const result = await claimSolifeCustomAddress(storedSk, {
        handle,
        relays: defaultRelays,
      });
      let claimedAddress: string;
      if (result.claim.kind === "purchase") {
        const purchase = result.claim.purchase;
        if (!purchase.bolt11) {
          throw new Error("Solife did not return a payment invoice for this address claim.");
        }
        const priceSats = purchase.priceSats || feeSats;
        setPurchaseMessage(`Paying ${formatSats(priceSats)} Solife invoice...`);
        let paymentResult: { feeReserveSat?: number | null; mintUrl?: string } | null = null;
        if (nwcWalletActive) {
          try {
            await nwc.payInvoice(purchase.bolt11);
          } catch (error: any) {
            // A timed-out payment may still settle; Solife's verification below decides.
            if (!/timed out/i.test(String(error?.message ?? error))) throw error;
          }
        } else {
          paymentResult = await payInvoice(purchase.bolt11);
        }
        setHistory((history) => [
          buildHistoryEntry({
            id: `solife-custom-fee-${Date.now()}`,
            summary: `Solife address fee for ${purchase.address || `${handle}@${nextConfig.domain || configuredDomain}`}`,
            detail: purchase.bolt11,
            detailKind: "invoice",
            type: "lightning",
            direction: "out",
            amountSat: priceSats || undefined,
            feeSat: paymentResult?.feeReserveSat ?? undefined,
            mintUrl: nwcWalletActive ? undefined : paymentResult?.mintUrl ?? mintUrl ?? undefined,
          }),
          ...history,
        ]);
        setPurchaseMessage("Verifying Solife payment...");
        const verified = await verifySolifePurchaseUntilSettled(storedSk, purchase.purchaseId);
        if (verified.status === "expired") {
          throw new Error(`Solife invoice expired for ${verified.address || purchase.address}.`);
        }
        if (verified.status === "error") {
          throw new Error(verified.error || `Solife could not claim ${verified.address || purchase.address}.`);
        }
        if (verified.status !== "address_claimed") {
          throw new Error(`Payment sent, but Solife has not confirmed ${verified.address || purchase.address} yet.`);
        }
        claimedAddress = verified.address || purchase.address;
      } else {
        const address = result.claim.address as SolifeAddress;
        claimedAddress = address.address;
      }
      setCustomHandle("");
      setPurchaseStatus("success");
      setPurchaseMessage(`Claimed ${claimedAddress}`);
      setSettings({ solifeLightningAddress: normalizeAddress(claimedAddress) });
      showToast(`Claimed ${claimedAddress}`, 3000);
      void refreshSolife();
      setCustomPageOpen(false);
    } catch (error: any) {
      setPurchaseStatus("error");
      setPurchaseMessage(error?.message || "Unable to claim Solife address.");
    }
  }, [
    buildHistoryEntry,
    config,
    configuredDomain,
    customHandle,
    defaultRelays,
    formatSats,
    mintUrl,
    nwc,
    nwcWalletActive,
    payInvoice,
    refreshSolife,
    setHistory,
    setSettings,
    showToast,
  ]);

  const replaceAddress = useCallback((updated: SolifeAddress) => {
    setAccount((current) =>
      current
        ? {
            ...current,
            addresses: current.addresses.map((address) =>
              address.handle === updated.handle ? { ...address, ...updated } : address,
            ),
          }
        : current,
    );
  }, []);

  const handleSetForward = useCallback(async () => {
    if (!activeSolifeAddressRecord) return;
    const storedSk = nostrSkSync();
    if (!storedSk) {
      setForwardStatus("error");
      setForwardMessage("Add your Taskify Nostr key in Settings -> Nostr first.");
      return;
    }
    setForwardStatus("saving");
    setForwardMessage("Checking the connection with your wallet...");
    try {
      const updated = await setSolifeAddressNwcForward(storedSk, activeSolifeAddressRecord.handle, forwardInput);
      replaceAddress(updated);
      setForwardInput("");
      setForwardStatus("idle");
      setForwardMessage("");
      showToast(`${activeSolifeAddressRecord.address} now forwards to your wallet`, 3000);
    } catch (error: any) {
      setForwardStatus("error");
      setForwardMessage(error?.message || "Unable to set up forwarding.");
    }
  }, [activeSolifeAddressRecord, forwardInput, replaceAddress, showToast]);

  const handleClearForward = useCallback(async () => {
    if (!activeSolifeAddressRecord) return;
    const storedSk = nostrSkSync();
    if (!storedSk) return;
    setForwardStatus("saving");
    setForwardMessage("");
    try {
      const updated = await clearSolifeAddressNwcForward(storedSk, activeSolifeAddressRecord.handle);
      replaceAddress(updated);
      setForwardStatus("idle");
      showToast("Forwarding stopped; payments arrive as ecash again", 3000);
    } catch (error: any) {
      setForwardStatus("error");
      setForwardMessage(error?.message || "Unable to stop forwarding.");
    }
  }, [activeSolifeAddressRecord, replaceAddress, showToast]);

  const activeForward = activeSolifeAddressRecord?.nwcForward ?? null;

  const currentSolifeMintValue = activeSolifeAddressRecord?.mintOverride
    ? normalizeMintUrl(activeSolifeAddressRecord.mintUrl)
    : "__default__";
  const mintOptions = useMemo(() => {
    const options = mintList.map((url) => normalizeMintUrl(url)).filter(Boolean);
    const current = activeSolifeAddressRecord?.mintUrl ? normalizeMintUrl(activeSolifeAddressRecord.mintUrl) : "";
    if (current && activeSolifeAddressRecord?.mintOverride && !options.includes(current)) {
      options.unshift(current);
    }
    return options;
  }, [activeSolifeAddressRecord?.mintOverride, activeSolifeAddressRecord?.mintUrl, mintList]);

  const addressChoices = useMemo(() => {
    const choices = defaultSolifeAddress ? [{ address: defaultSolifeAddress, label: "Default npub address" }] : [];
    for (const address of account?.addresses || []) {
      choices.push({ address: normalizeAddress(address.address), label: address.address });
    }
    return choices;
  }, [account?.addresses, defaultSolifeAddress]);

  if (customPageOpen) {
    const price = Math.max(0, Math.floor(Number(config?.customAddressPriceSats) || 0));
    return (
      <div className="relative flex min-h-0 flex-1 flex-col gap-4">
        <div className="wallet-section space-y-3">
          <button
            type="button"
            className="ghost-button button-sm pressable"
            onClick={() => setCustomPageOpen(false)}
          >
            Back
          </button>
          <div>
            <div className="text-sm font-medium mb-1">New Custom Address</div>
            <div className="text-xs text-secondary">
              {price > 0 ? `${formatSats(price)} one-time fee.` : "Custom address claims are currently free."}
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs text-secondary uppercase tracking-wide" htmlFor="solife-custom-handle">
              Handle
            </label>
            <div className="flex min-w-0 items-center gap-2">
              <input
                id="solife-custom-handle"
                className="pill-input flex-1 min-w-0"
                value={customHandle}
                onChange={(event) => setCustomHandle(event.target.value.toLowerCase())}
                placeholder="nathan"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={purchaseStatus === "purchasing"}
              />
              <span className="text-sm text-secondary">@{configuredDomain}</span>
            </div>
          </div>
          <button
            type="button"
            className="accent-button pressable w-full"
            onClick={() => {
              void handlePurchaseCustomAddress();
            }}
            disabled={purchaseStatus === "purchasing"}
          >
            {purchaseStatus === "purchasing" ? "Purchasing..." : "Purchase Address"}
          </button>
          {purchaseMessage && (
            <div
              className={`text-sm ${
                purchaseStatus === "error"
                  ? "text-rose-400"
                  : purchaseStatus === "success"
                    ? "text-emerald-400"
                    : "text-secondary"
              }`}
            >
              {purchaseMessage}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-4">
      <section className="wallet-section space-y-4">
        <div>
          <div className="text-sm font-medium mb-1">Address Type</div>
          <div className="text-xs text-secondary mb-3">Choose the address shown when receiving Lightning.</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={solifeSelected ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
              onClick={() => setProvider("solife.me")}
            >
              solife.me
            </button>
            <button
              type="button"
              className={npubCashSelected ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
              onClick={() => setProvider("npub.cash")}
            >
              npub.cash
            </button>
            <button
              type="button"
              className={provider === "none" ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
              onClick={() => setProvider("none")}
            >
              None
            </button>
          </div>
        </div>

        {npubCashSelected && (
          <div>
            <div className="text-sm font-medium mb-1">Auto-claim npub.cash eCash</div>
            <div className="text-xs text-secondary mb-2">Automatically claim pending npub.cash tokens each time the wallet opens.</div>
            <div className="flex gap-2">
              <button
                type="button"
                className={settings.npubCashAutoClaim ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
                onClick={() => setSettings({ npubCashAutoClaim: true })}
              >
                On
              </button>
              <button
                type="button"
                className={!settings.npubCashAutoClaim ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
                onClick={() => setSettings({ npubCashAutoClaim: false })}
              >
                Off
              </button>
            </div>
          </div>
        )}
      </section>

      {solifeSelected && (
        <section className="wallet-section space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">Solife Address</div>
              <div className="text-xs text-secondary">
                {activeSolifeAddress || "Sign in with your Taskify Nostr key to load addresses."}
              </div>
            </div>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                void refreshSolife();
              }}
              disabled={status === "loading"}
            >
              Refresh
            </button>
          </div>

          <div className="space-y-2">
            <label className="text-xs text-secondary uppercase tracking-wide" htmlFor="solife-address-choice">
              Shown on Receive Lightning
            </label>
            {addressChoices.length ? (
              <select
                id="solife-address-choice"
                className="pill-select w-full"
                value={activeSolifeAddress}
                onChange={(event) => {
                  const nextAddress = normalizeAddress(event.target.value);
                  setSettings({
                    solifeLightningAddress:
                      nextAddress && nextAddress !== normalizeAddress(defaultSolifeAddress) ? nextAddress : "",
                  });
                }}
              >
                {addressChoices.map((choice) => (
                  <option key={choice.address} value={choice.address}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-sm text-secondary">No Solife addresses loaded yet.</div>
            )}
          </div>

          <NwcForwardSection
            address={activeSolifeAddressRecord}
            forward={activeForward}
            input={forwardInput}
            onInput={setForwardInput}
            status={forwardStatus}
            message={forwardMessage}
            onSave={() => void handleSetForward()}
            onClear={() => void handleClearForward()}
            nwcWalletActive={nwcWalletActive}
            nwcWalletLabel={nwcWalletLabel}
            shownOnReceive={
              !!activeSolifeAddressRecord && normalizeAddress(nwcReceiveAddress) === normalizeAddress(activeSolifeAddressRecord.address)
            }
            onShowOnReceive={(address) => {
              setNwcReceiveAddress(address);
              showToast("Shown on Receive", 2000);
            }}
          />

          {!activeForward && (
          <div className="space-y-2">
            <label className="text-xs text-secondary uppercase tracking-wide" htmlFor="solife-mint-choice">
              Payment Mint
            </label>
            <select
              id="solife-mint-choice"
              className="pill-select w-full"
              value={currentSolifeMintValue}
              onChange={(event) => {
                void handleSelectSolifeMint(event.target.value);
              }}
              disabled={!activeSolifeAddressRecord || status === "loading" || status === "saving"}
            >
              <option value="__default__">
                Solife default{config?.mintUrl ? ` (${compactMintLabel(config.mintUrl)})` : ""}
              </option>
              {mintOptions.map((url) => (
                <option key={url} value={url}>
                  {compactMintLabel(url)}
                </option>
              ))}
            </select>
            {!activeSolifeAddressRecord && (
              <div className="text-xs text-secondary">Choose a custom Solife address to change its payment mint.</div>
            )}
            {!mintOptions.length && (
              <div className="text-xs text-secondary">Add mints in Wallet &gt; Mints to choose a wallet mint here.</div>
            )}
          </div>
          )}

          <button
            type="button"
            className="accent-button pressable w-full"
            onClick={() => {
              setPurchaseStatus("idle");
              setPurchaseMessage("");
              setCustomPageOpen(true);
            }}
          >
            New Custom Address
          </button>

          {message && (
            <div
              className={`text-sm ${
                status === "error"
                  ? "text-rose-400"
                  : status === "success"
                    ? "text-emerald-400"
                    : "text-secondary"
              }`}
            >
              {message}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

type NwcForwardSectionProps = {
  address: SolifeAddress | null;
  forward: SolifeAddress["nwcForward"];
  input: string;
  onInput: (value: string) => void;
  status: "idle" | "saving" | "error";
  message: string;
  onSave: () => void;
  onClear: () => void;
  nwcWalletActive: boolean;
  nwcWalletLabel: string;
  shownOnReceive: boolean;
  onShowOnReceive: (address: string) => void;
};

/** Forward a custom Solife address to the user's own lightning wallet over a receive-only NWC connection. */
function NwcForwardSection({
  address,
  forward,
  input,
  onInput,
  status,
  message,
  onSave,
  onClear,
  nwcWalletActive,
  nwcWalletLabel,
  shownOnReceive,
  onShowOnReceive,
}: NwcForwardSectionProps) {
  if (!address) {
    return (
      <div className="space-y-1">
        <div className="text-xs text-secondary uppercase tracking-wide">Forward to your wallet</div>
        <div className="text-xs text-secondary">
          Custom addresses can send payments straight to your own lightning wallet instead of arriving as ecash.
          Choose or create a custom address to set this up.
        </div>
      </div>
    );
  }

  if (forward) {
    return (
      <div className="space-y-2">
        <div className="text-xs text-secondary uppercase tracking-wide">Forward to your wallet</div>
        <div className="text-sm">
          Payments to {address.address} go to{" "}
          <span className="font-semibold">{forward.walletAlias || "your NWC wallet"}</span>.
        </div>
        {forward.lastError && (
          <div className="text-xs text-amber-400">
            The last payment attempt failed: {forward.lastError}. Check that the wallet is online.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {nwcWalletActive && !shownOnReceive && (
            <button className="ghost-button button-sm pressable" onClick={() => onShowOnReceive(address.address)}>
              Show on Receive
            </button>
          )}
          <button className="ghost-button button-sm pressable" onClick={onClear} disabled={status === "saving"}>
            Stop forwarding
          </button>
        </div>
        {status === "error" && message && <div className="text-xs text-rose-400">{message}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-secondary uppercase tracking-wide">Forward to your wallet</div>
      <div className="text-xs text-secondary">
        Send payments to {address.address} straight to your own lightning wallet
        {nwcWalletActive ? ` (such as ${nwcWalletLabel})` : ""}. In your wallet, create a new NWC connection that can
        only receive (create invoices), then paste it here. Don't reuse the connection this app pays with: Solife
        refuses connections that can spend.
      </div>
      <input
        className="pill-input w-full"
        placeholder="nostr+walletconnect://..."
        value={input}
        onChange={(event) => onInput(event.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={status === "saving"}
      />
      <button
        className="accent-button button-sm pressable"
        onClick={onSave}
        disabled={status === "saving" || !input.trim()}
      >
        {status === "saving" ? "Checking..." : "Forward payments"}
      </button>
      {message && (
        <div className={`text-xs ${status === "error" ? "text-rose-400" : "text-secondary"}`}>{message}</div>
      )}
    </div>
  );
}
