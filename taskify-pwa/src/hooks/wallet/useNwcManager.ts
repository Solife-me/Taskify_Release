import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormatSatAmountOptions } from "../../wallet/denomination";
import type { ParsedNwcUri } from "../../wallet/nwc";

type NwcStatus = "idle" | "connecting" | "connected" | "error";

type NwcInfo = {
  alias?: string;
  methods?: string[];
  balanceMsat?: number;
  maxSendMsat?: number;
  maxReceiveMsat?: number;
  rawInfo?: Record<string, unknown>;
  rawBalance?: Record<string, unknown>;
};

type UseNwcManagerOptions = {
  connectNwc: (uri: string) => Promise<void>;
  disconnectNwc: () => void;
  formatSatAmount: (amount: number, options?: FormatSatAmountOptions) => string;
  getNwcBalanceMsat: () => Promise<number | null>;
  nwcConnection: ParsedNwcUri | null;
  nwcInfo: NwcInfo | null;
  nwcStatus: NwcStatus;
  open: boolean;
  refreshNwcInfo: () => Promise<NwcInfo | null>;
};

export function useNwcManager({
  connectNwc,
  disconnectNwc,
  formatSatAmount,
  getNwcBalanceMsat,
  nwcConnection,
  nwcInfo,
  nwcStatus,
  open,
  refreshNwcInfo,
}: UseNwcManagerOptions) {
  const [showNwcManager, setShowNwcManager] = useState(false);
  const [nwcUrlInput, setNwcUrlInput] = useState("");
  const [nwcBusy, setNwcBusy] = useState(false);
  const [nwcFeedback, setNwcFeedback] = useState("");

  const hasNwcConnection = !!nwcConnection;
  const nwcAlias = nwcInfo?.alias || nwcConnection?.walletName || "";
  const nwcBalanceSats =
    typeof nwcInfo?.balanceMsat === "number" ? Math.floor(nwcInfo.balanceMsat / 1000) : null;

  const nwcStatusLabel = useMemo(() => {
    if (!hasNwcConnection) return "Not connected";
    switch (nwcStatus) {
      case "connecting":
        return "Connecting…";
      case "error":
        return "Error";
      default:
        return "Connected";
    }
  }, [hasNwcConnection, nwcStatus]);

  useEffect(() => {
    if (open) return;
    setShowNwcManager(false);
    setNwcUrlInput(nwcConnection?.uri || "");
    setNwcBusy(false);
    setNwcFeedback("");
  }, [open, nwcConnection]);

  useEffect(() => {
    if (!showNwcManager) return;
    setNwcUrlInput(nwcConnection?.uri || "");
    setNwcFeedback("");
  }, [showNwcManager, nwcConnection]);

  const openNwcManager = useCallback(() => {
    setShowNwcManager(true);
  }, []);

  const closeNwcManager = useCallback(() => {
    setShowNwcManager(false);
    setNwcFeedback("");
    setNwcBusy(false);
  }, []);

  const handleNwcConnect = useCallback(async () => {
    const url = nwcUrlInput.trim();
    if (!url) {
      setNwcFeedback("Enter NWC connection URL");
      return;
    }
    setNwcBusy(true);
    setNwcFeedback("");
    try {
      await connectNwc(url);
      await refreshNwcInfo().catch(() => null);
      await getNwcBalanceMsat().catch(() => null);
      setNwcFeedback("NWC wallet connected");
    } catch (e: any) {
      setNwcFeedback(e?.message || String(e));
    } finally {
      setNwcBusy(false);
    }
  }, [connectNwc, getNwcBalanceMsat, nwcUrlInput, refreshNwcInfo]);

  const handleNwcTest = useCallback(async () => {
    setNwcBusy(true);
    setNwcFeedback("");
    try {
      const latest = await refreshNwcInfo().catch(() => null);
      const balanceMsat = await getNwcBalanceMsat().catch(() => latest?.balanceMsat ?? null);
      if (typeof balanceMsat === "number") {
        setNwcFeedback(`Balance: ${formatSatAmount(Math.floor(balanceMsat / 1000))}`);
      } else {
        setNwcFeedback("Connection OK");
      }
    } catch (e: any) {
      setNwcFeedback(e?.message || String(e));
    } finally {
      setNwcBusy(false);
    }
  }, [formatSatAmount, getNwcBalanceMsat, refreshNwcInfo]);

  const handleNwcDisconnect = useCallback(() => {
    disconnectNwc();
    setNwcUrlInput("");
    setNwcFeedback("Disconnected");
  }, [disconnectNwc]);

  return {
    showNwcManager,
    openNwcManager,
    closeNwcManager,
    nwcUrlInput,
    setNwcUrlInput,
    nwcBusy,
    nwcFeedback,
    hasNwcConnection,
    nwcAlias,
    nwcBalanceSats,
    nwcStatusLabel,
    handleNwcConnect,
    handleNwcTest,
    handleNwcDisconnect,
  };
}
