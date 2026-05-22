// @ts-nocheck
import { useCallback } from "react";
import { nip19 } from "nostr-tools";
import { Nut16Collector, parseNut16FrameString } from "../../wallet/nut16";
import { extractPeanutToken } from "../../wallet/peanut";
import { extractCashuUriPayload } from "../../wallet/cashuProofHelpers";
import { decodeLnurlString, extractDomain } from "../../wallet/walletModalHelpers";
import type { LnurlPayData } from "./useLightningFlow";
import type { LnurlWithdrawData } from "../../wallet/walletModalHelpers";
import { PaymentRequest } from "@cashu/cashu-ts";
import { normalizeNostrPubkey } from "../../lib/nostr";

export interface UseScannerFlowOptions {
  decodeContactPayload: (candidate: string) => any;
  formatNpub: (pubkey: string) => string;
  handleScannedContactPayload: (payload: any) => Promise<void>;
  nut16CollectorRef: React.MutableRefObject<any>;
  resetSendLockSettings: () => void;
  setLnAddrAmt: (amt: string) => void;
  setLnError: (err: string) => void;
  setLnInput: (input: string) => void;
  setLnState: (state: string) => void;
  setLightningSendView: (view: string) => void;
  setLnurlPayData: (data: LnurlPayData | null) => void;
  setLnurlWithdrawAmt: (amt: string) => void;
  setLnurlWithdrawInfo: (info: LnurlWithdrawData | null) => void;
  setLnurlWithdrawInvoice: (invoice: string) => void;
  setLnurlWithdrawMessage: (message: string) => void;
  setLnurlWithdrawState: (state: string) => void;
  setLockSendToPubkey: (lock: boolean) => void;
  setPendingScan: (scan: any) => void;
  setReceiveMode: (mode: any) => void;
  setScannerMessage: (message: string) => void;
  setSendLockError: (error: string) => void;
  setSendLockPubkeyInput: (input: string) => void;
  setSendMode: (mode: any) => void;
  setShowScanner: (show: boolean) => void;
  setShowSendOptions: (show: boolean) => void;
}

export function useScannerFlow({
  decodeContactPayload,
  formatNpub,
  handleScannedContactPayload,
  nut16CollectorRef,
  resetSendLockSettings,
  setLnAddrAmt,
  setLnError,
  setLnInput,
  setLnState,
  setLightningSendView,
  setLnurlPayData,
  setLnurlWithdrawAmt,
  setLnurlWithdrawInfo,
  setLnurlWithdrawInvoice,
  setLnurlWithdrawMessage,
  setLnurlWithdrawState,
  setLockSendToPubkey,
  setPendingScan,
  setReceiveMode,
  setScannerMessage,
  setSendLockError,
  setSendLockPubkeyInput,
  setSendMode,
  setShowScanner,
  setShowSendOptions,
}: UseScannerFlowOptions) {
  const handleScannerError = useCallback((message: string) => {
    setScannerMessage(message);
  }, []);

  const handleScannerDetected = useCallback(async (rawValue: string) => {
    const text = rawValue.trim();
    if (!text) return false;

    const compact = text.replace(/\s+/g, "");

    if (/^https?:\/\//i.test(compact) || /^www\./i.test(compact)) {
      setScannerMessage("Unsupported QR code. Only Cashu tokens and Lightning requests are allowed.");
      return false;
    }

    let candidate = compact;

    const collector = nut16CollectorRef.current ?? (nut16CollectorRef.current = new Nut16Collector());

    if (/^bitcoin:/i.test(candidate)) {
      const [, query = ""] = candidate.split("?");
      if (query) {
        const params = new URLSearchParams(query);
        const lightningParam = params.get("lightning") || params.get("lightning_pay");
        const tokenParam = params.get("token");
        if (lightningParam) {
          try {
            candidate = decodeURIComponent(lightningParam);
          } catch {
            candidate = lightningParam;
          }
        } else if (tokenParam?.toLowerCase().startsWith("cashu")) {
          try {
            candidate = decodeURIComponent(tokenParam);
          } catch {
            candidate = tokenParam;
          }
        }
      }
    }

    candidate = candidate.replace(/^lightning:/i, "").trim();

    if (/^cashu:/i.test(candidate)) {
      candidate = extractCashuUriPayload(candidate);
    }

    const peanutDecoded = extractPeanutToken(candidate);
    if (peanutDecoded) {
      candidate = peanutDecoded;
    }

    candidate = candidate.replace(/^nostr:/i, "").trim();

    const contactPayload = decodeContactPayload(candidate);
    if (contactPayload) {
      await handleScannedContactPayload(contactPayload);
      return true;
    }

    try {
      const decoded = nip19.decode(candidate);
      if (decoded.type === "nprofile") {
        const data = decoded.data as { pubkey?: string; relays?: string[] };
        if (data?.pubkey) {
          await handleScannedContactPayload({
            npub: formatNpub(data.pubkey),
            relays: Array.isArray(data.relays)
              ? data.relays.filter((entry) => typeof entry === "string" && entry.trim())
              : undefined,
          });
          return true;
        }
      } else if (decoded.type === "npub") {
        const npub =
          typeof decoded.data === "string"
            ? decoded.data
            : Array.isArray(decoded.data)
              ? nip19.npubEncode(Uint8Array.from(decoded.data))
              : null;
        if (npub) {
          await handleScannedContactPayload({ npub });
          return true;
        }
      }
    } catch {
      // not a nostr profile
    }

    const lowerCandidate = candidate.toLowerCase();

    const nut16Frame = parseNut16FrameString(candidate);
    if (nut16Frame) {
      const result = collector.addFrame(nut16Frame);
      if (result.status === "complete") {
        setPendingScan({ type: "ecash", token: result.token });
        setShowScanner(false);
        setScannerMessage("Animated Cashu token assembled.");
        collector.reset();
        return true;
      }
      if (result.status === "error") {
        setScannerMessage(result.error.message || "Failed to assemble animated token.");
        collector.reset();
        return false;
      }
      const received = typeof result.received === "number" ? result.received : nut16Frame.index;
      const total = typeof result.total === "number" && result.total > 0 ? result.total : nut16Frame.total || 0;
      const remaining =
        typeof result.missing === "number"
          ? result.missing
          : total > 0
            ? Math.max(total - received, 0)
            : null;
      const progressLabel = total ? `${Math.min(received, total)}/${total}` : `${Math.max(received, 1)}`;
      const remainingLabel =
        remaining != null
          ? `${remaining} frame${remaining === 1 ? "" : "s"} remaining…`
          : "Processing…";
      const statusLabel = result.status === "duplicate" ? "Frame already captured" : "Captured frame";
      setScannerMessage(`${statusLabel} ${progressLabel}. ${remainingLabel}`);
      return false;
    }

    if (lowerCandidate.startsWith("cashu")) {
      setPendingScan({ type: "ecash", token: candidate });
      setShowScanner(false);
      return true;
    }

    if (/^creqa[0-9a-z]+$/i.test(candidate)) {
      setPendingScan({ type: "paymentRequest", request: candidate });
      setShowScanner(false);
      return true;
    }

    if (/^ln(bc|tb|sb|bcrt)[0-9]/.test(lowerCandidate)) {
      setPendingScan({ type: "bolt11", invoice: lowerCandidate });
      setShowScanner(false);
      return true;
    }

    if (/^[^@\s]+@[^@\s]+$/.test(candidate)) {
      setPendingScan({ type: "lightningAddress", address: candidate.toLowerCase() });
      setShowScanner(false);
      return true;
    }

    if (/^lnurl[0-9a-z]+$/i.test(candidate)) {
      setPendingScan({ type: "lnurl", data: candidate });
      setShowScanner(false);
      return true;
    }

    try {
      PaymentRequest.fromEncodedRequest(candidate);
      setPendingScan({ type: "paymentRequest", request: candidate });
      setShowScanner(false);
      return true;
    } catch {
      // fall through to error message
    }

    const maybeLockKeyInput = candidate.replace(/^p2pk:/i, "");
    const normalizedLockKey = normalizeNostrPubkey(maybeLockKeyInput);
    if (normalizedLockKey) {
      resetSendLockSettings();
      setLockSendToPubkey(true);
      setSendLockPubkeyInput(maybeLockKeyInput);
      setSendLockError("");
      setReceiveMode(null);
      setSendMode("ecash");
      setShowSendOptions(true);
      setPendingScan(null);
      setScannerMessage("");
      setShowScanner(false);
      return true;
    }

    setScannerMessage("Unrecognized code. Scan a Cashu token, Lightning invoice/address, LNURL or payment request.");
    return false;
  }, [decodeContactPayload, formatNpub, handleScannedContactPayload, resetSendLockSettings]);

  const handlePasteFromClipboard = useCallback(async () => {
    setScannerMessage("");
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        setScannerMessage("Clipboard access unavailable. Paste the code manually.");
        return;
      }

      const pasted = await navigator.clipboard.readText();
      const trimmed = pasted.trim();
      if (!trimmed) {
        setScannerMessage("Clipboard is empty.");
        return;
      }

      await handleScannerDetected(trimmed);
    } catch (err: any) {
      console.error("Clipboard read failed", err);
      setScannerMessage(err?.message || "Failed to read from clipboard.");
    }
  }, [handleScannerDetected]);

  const handleLnurlScan = useCallback(async (lnurlValue: string) => {
    try {
      const url = decodeLnurlString(lnurlValue);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`LNURL request failed (${res.status})`);
      const data = await res.json();
      const tag = String(data?.tag || "").toLowerCase();
      const domain = extractDomain(url);

      if (tag === "payrequest") {
        const minSendable = Number(data?.minSendable ?? 0);
        const maxSendable = Number(data?.maxSendable ?? 0);
        const commentAllowed = Number(data?.commentAllowed ?? 0);
        if (!data?.callback) throw new Error("LNURL pay is missing callback URL");
        if (!minSendable || !maxSendable) throw new Error("LNURL pay missing sendable range");

        const payload: LnurlPayData = {
          lnurl: lnurlValue.trim(),
          callback: data.callback,
          domain,
          minSendable,
          maxSendable,
          commentAllowed,
          metadata: typeof data?.metadata === "string" ? data.metadata : undefined,
        };

        setLnurlPayData(payload);
        setLnurlWithdrawInfo(null);
        setReceiveMode(null);
        setSendMode("lightning");
        setShowSendOptions(true);
        setLnInput(lnurlValue.trim());
        setLightningSendView("address");
        if (minSendable === maxSendable) {
          setLnAddrAmt(String(Math.floor(minSendable / 1000)));
        } else {
          setLnAddrAmt("");
        }
        setLnState("idle");
        setLnError("");
        setScannerMessage("");
        return;
      }

      if (tag === "withdrawrequest") {
        if (!data?.callback || !data?.k1) throw new Error("LNURL withdraw missing callback parameters");
        const minWithdrawable = Number(data?.minWithdrawable ?? 0);
        const maxWithdrawable = Number(data?.maxWithdrawable ?? 0);
        if (!minWithdrawable || !maxWithdrawable) throw new Error("LNURL withdraw missing withdrawable range");

        const info: LnurlWithdrawData = {
          lnurl: lnurlValue.trim(),
          callback: data.callback,
          domain,
          k1: data.k1,
          minWithdrawable,
          maxWithdrawable,
          defaultDescription: typeof data?.defaultDescription === "string" ? data.defaultDescription : undefined,
        };

        setLnurlWithdrawInfo(info);
        const maxSat = Math.floor(maxWithdrawable / 1000);
        setLnurlWithdrawAmt(maxSat > 0 ? String(maxSat) : "");
        setLnurlWithdrawState("idle");
        setLnurlWithdrawMessage("");
        setLnurlWithdrawInvoice("");
        setLnurlPayData(null);
        setSendMode(null);
        setShowSendOptions(false);
        setReceiveMode("lnurlWithdraw");
        setScannerMessage("");
        return;
      }

      throw new Error("Unsupported LNURL tag");
    } catch (err: any) {
      console.error("handleLnurlScan failed", err);
      setScannerMessage(err?.message || String(err));
    }
  }, [setLnInput]);

  const openScanner = useCallback(async () => {
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    };
    if (navigator?.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stream.getTracks().forEach((track) => track.stop());
      } catch (err: any) {
        setScannerMessage(err?.message || "Camera permission denied");
        setPendingScan(null);
        setShowScanner(true);
        return;
      }
    }
    nut16CollectorRef.current?.reset();
    setScannerMessage("");
    setPendingScan(null);
    setReceiveMode(null);
    setShowSendOptions(false);
    setSendMode(null);
    setShowScanner(true);
  }, []);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    setScannerMessage("");
    setPendingScan(null);
    nut16CollectorRef.current?.reset();
  }, []);

  return {
    handleScannerError,
    handleScannerDetected,
    handlePasteFromClipboard,
    handleLnurlScan,
    openScanner,
    closeScanner,
  };
}
