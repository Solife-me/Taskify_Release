import { useCallback, useEffect, useMemo, useState } from "react";
import type { Proof } from "@cashu/cashu-ts";
import type { Settings } from "../../domains/tasks/settingsTypes";
import { useCashu } from "../../context/CashuContext";
import { useToast } from "../../context/ToastContext";
import { getSkSync as nostrSkSync } from "../../lib/nostrSkStore";
import { getMintList, normalizeMintUrl } from "../../wallet/storage";
import {
  claimSolifeCustomAddress,
  fetchSolifeAccount,
  fetchSolifeConfig,
  SOLIFE_LIGHTNING_ADDRESS_DOMAIN,
  updateSolifeLightningAddressMint,
  type SolifeAccount,
  type SolifeConfig,
} from "../../wallet/solife";
import {
  formatSatAmount,
  normalizeWalletDenominationDisplay,
} from "../../wallet/denomination";
import { computeProofY } from "../../wallet/cashuProofHelpers";
import type { StoredProofForState } from "../../wallet/walletHistoryTypes";
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

function proofStateFromProof(proof: Proof): StoredProofForState {
  const stored: StoredProofForState = {
    secret: proof.secret,
    amount: Number(proof.amount) || 0,
    id: proof.id,
    C: proof.C,
  };
  if (proof.witness) stored.witness = proof.witness;
  const y = computeProofY(proof.secret);
  if (y) stored.Y = y;
  return stored;
}

export function WalletAddressView({
  settings,
  setSettings,
  defaultRelays,
}: WalletAddressViewProps) {
  const { show: showToast } = useToast();
  const { mintUrl, createSendToken } = useCashu();
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
  const solifeSelected = provider === "solife.me";
  const npubCashSelected = provider === "npub.cash";
  const configuredDomain = config?.domain || SOLIFE_LIGHTNING_ADDRESS_DOMAIN;
  const defaultSolifeAddress = normalizeAddress(account?.lightningAddress);
  const selectedSolifeAddress = normalizeAddress(settings.solifeLightningAddress);
  const activeSolifeAddress =
    selectedSolifeAddress &&
    (account?.addresses || []).some((address) => normalizeAddress(address.address) === selectedSolifeAddress)
      ? selectedSolifeAddress
      : defaultSolifeAddress;

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
        const result = await updateSolifeLightningAddressMint(storedSk, normalized);
        setConfig(result.config);
        setAccount((current) =>
          current
            ? {
                ...current,
                lightningAddressMintUrl: result.mintUrl,
                lightningAddressMintOverride: result.mintOverride,
                addresses: current.addresses.map((address) => ({
                  ...address,
                  mintUrl: result.mintUrl,
                  mintOverride: result.mintOverride,
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
    [refreshSolife, showToast],
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
    setPurchaseMessage("Checking Solife address pricing...");
    let createdFeeToken = "";
    let createdFeeTokenMint = "";
    let createdFeeTokenProofs: Proof[] = [];

    try {
      const nextConfig = config || (await fetchSolifeConfig());
      setConfig(nextConfig);
      const feeSats = Math.max(0, Math.floor(Number(nextConfig.customAddressPriceSats) || 0));

      if (feeSats > 0) {
        setPurchaseMessage(`Creating ${formatSats(feeSats)} fee token from ${compactMintLabel(nextConfig.mintUrl)}...`);
        const tokenResult = await createSendToken(feeSats, { mintUrl: nextConfig.mintUrl });
        createdFeeToken = tokenResult.token;
        createdFeeTokenMint = tokenResult.mintUrl;
        createdFeeTokenProofs = tokenResult.proofs || [];
        setHistory((history) => [
          buildHistoryEntry({
            id: `solife-custom-fee-${Date.now()}`,
            summary: `Solife address fee for ${handle}@${configuredDomain}`,
            detail: createdFeeToken,
            detailKind: "token",
            revertToken: createdFeeToken,
            type: "ecash",
            direction: "out",
            amountSat: feeSats,
            mintUrl: createdFeeTokenMint,
            tokenState: createdFeeTokenProofs.length
              ? {
                  mintUrl: createdFeeTokenMint,
                  proofs: createdFeeTokenProofs.map(proofStateFromProof),
                }
              : undefined,
          }),
          ...history,
        ]);
      }

      setPurchaseMessage(`Claiming ${handle}@${nextConfig.domain || configuredDomain}...`);
      const result = await claimSolifeCustomAddress(storedSk, {
        handle,
        token: createdFeeToken,
        relays: defaultRelays,
      });
      setCustomHandle("");
      setPurchaseStatus("success");
      setPurchaseMessage(`Claimed ${result.address.address}`);
      setSettings({ solifeLightningAddress: normalizeAddress(result.address.address) });
      showToast(`Claimed ${result.address.address}`, 3000);
      void refreshSolife();
      setCustomPageOpen(false);
    } catch (error: any) {
      const tokenNote = createdFeeToken
        ? " The fee token was saved to wallet history in case you need to redeem it back."
        : "";
      setPurchaseStatus("error");
      setPurchaseMessage(`${error?.message || "Unable to claim Solife address."}${tokenNote}`);
    }
  }, [
    buildHistoryEntry,
    config,
    configuredDomain,
    createSendToken,
    customHandle,
    defaultRelays,
    formatSats,
    refreshSolife,
    setHistory,
    setSettings,
    showToast,
  ]);

  const currentSolifeMintValue = account?.lightningAddressMintOverride
    ? normalizeMintUrl(account.lightningAddressMintUrl)
    : "__default__";
  const mintOptions = useMemo(() => {
    const options = mintList.map((url) => normalizeMintUrl(url)).filter(Boolean);
    const current = account?.lightningAddressMintUrl ? normalizeMintUrl(account.lightningAddressMintUrl) : "";
    if (current && account?.lightningAddressMintOverride && !options.includes(current)) {
      options.unshift(current);
    }
    return options;
  }, [account?.lightningAddressMintOverride, account?.lightningAddressMintUrl, mintList]);

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
              disabled={status === "loading" || status === "saving"}
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
            {!mintOptions.length && (
              <div className="text-xs text-secondary">Add mints in Wallet &gt; Mints to choose a wallet mint here.</div>
            )}
          </div>

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
