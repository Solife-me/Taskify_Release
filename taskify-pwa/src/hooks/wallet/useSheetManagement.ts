// @ts-nocheck
import { useCallback } from "react";
import type { Contact } from "../../lib/contacts";
import { removeMintFromList } from "../../wallet/storage";

interface UseSheetManagementOptions {
  // NWC state setters
  setNwcFundState: (state: string) => void;
  setNwcFundMessage: (msg: string) => void;
  setNwcFundInvoice: (inv: string) => void;
  setNwcWithdrawState: (state: string) => void;
  setNwcWithdrawMessage: (msg: string) => void;
  setNwcWithdrawInvoice: (inv: string) => void;
  // useMintBackup
  setShowNwcSheet: (show: boolean) => void;
  refreshMintEntries: () => void;
  // useNwcManager
  closeNwcManager: () => void;
  // useWalletSwapFlow
  setMintSwapState: (state: string) => void;
  setMintSwapMessage: (msg: string) => void;
  setSwapAmount: (amt: string) => void;
  setSwapFromValue: (val: string) => void;
  setSwapToValue: (val: string) => void;
  // useLightningFlow
  setLnurlWithdrawState: (state: string) => void;
  setLnurlWithdrawMessage: (msg: string) => void;
  setLnurlWithdrawInvoice: (inv: string) => void;
  setLnurlWithdrawAmt: (amt: string) => void;
  setLnurlWithdrawInfo: (info: any) => void;
  setLnInput: (input: string) => void;
  setLnAddrAmt: (amt: string) => void;
  setLnState: (state: string) => void;
  setLnError: (err: string) => void;
  setLnurlPayData: (data: any) => void;
  setLightningSendView: (view: string) => void;
  // useEcashReceiveState
  setReceiveLockVisible: (visible: boolean) => void;
  setEcashReceiveView: (view: string) => void;
  setEcashRequestAmt: (amt: string) => void;
  setEcashRequestMode: (mode: string) => void;
  setLastCreatedEcashRequest: (req: any) => void;
  // useEcashSendState
  setSendAmt: (amt: string) => void;
  setSendTokenStr: (str: string) => void;
  setEcashSendRecipient: (recipient: any) => void;
  setEcashSendView: (view: string) => void;
  setLastSendTokenAmount: (amt: any) => void;
  setLastSendTokenMint: (mint: any) => void;
  setLastSendTokenFingerprint: (fp: any) => void;
  setLastSendTokenLockLabel: (label: any) => void;
  setCreatingSendToken: (creating: boolean) => void;
  setSendLockPubkeyInput: (input: string) => void;
  setSendLockError: (err: string) => void;
  setLockSendToPubkey: (pubkey: any) => void;
  // component inline state
  setReceiveMode: (mode: any) => void;
  setSendMode: (mode: any) => void;
  setShowSendOptions: (show: boolean) => void;
  setRecvMsg: (msg: string) => void;
  setContactsOpen: (open: boolean) => void;
  // useLightningFlow (receive)
  setMintAmt: (amt: string) => void;
  setMintQuote: (quote: any) => void;
  setMintStatus: (status: string) => void;
  setMintError: (err: string) => void;
  setLightningReceiveView: (view: string) => void;
  setActiveMintInvoice: (invoice: any) => void;
  // reactive deps
  activeMintInvoice: any;
  npubCashLightningAddressEnabled: boolean;
  // npubCash
  setNpubCashClaimStatus: (status: string) => void;
  setNpubCashClaimMessage: (msg: string) => void;
  npubCashClaimingRef: React.MutableRefObject<boolean>;
  // payment request state
  setPaymentRequestState: (state: any) => void;
  setPaymentRequestStatus: (status: string) => void;
  setPaymentRequestMessage: (msg: string) => void;
  setPaymentRequestManualAmount: (amt: string) => void;
  // useNostrPoolState
  resetSendLockSettings: () => void;
  // contact form
  resetContactForm: () => void;
}

export function useSheetManagement(opts: UseSheetManagementOptions) {
  const {
    setNwcFundState,
    setNwcFundMessage,
    setNwcFundInvoice,
    setNwcWithdrawState,
    setNwcWithdrawMessage,
    setNwcWithdrawInvoice,
    setShowNwcSheet,
    refreshMintEntries,
    closeNwcManager,
    setMintSwapState,
    setMintSwapMessage,
    setSwapAmount,
    setSwapFromValue,
    setSwapToValue,
    setLnurlWithdrawState,
    setLnurlWithdrawMessage,
    setLnurlWithdrawInvoice,
    setLnurlWithdrawAmt,
    setLnurlWithdrawInfo,
    setLnInput,
    setLnAddrAmt,
    setLnState,
    setLnError,
    setLnurlPayData,
    setLightningSendView,
    setReceiveLockVisible,
    setEcashReceiveView,
    setEcashRequestAmt,
    setEcashRequestMode,
    setLastCreatedEcashRequest,
    setSendAmt,
    setSendTokenStr,
    setEcashSendRecipient,
    setEcashSendView,
    setLastSendTokenAmount,
    setLastSendTokenMint,
    setLastSendTokenFingerprint,
    setLastSendTokenLockLabel,
    setCreatingSendToken,
    setSendLockPubkeyInput,
    setSendLockError,
    setLockSendToPubkey,
    setReceiveMode,
    setSendMode,
    setShowSendOptions,
    setRecvMsg,
    setContactsOpen,
    setMintAmt,
    setMintQuote,
    setMintStatus,
    setMintError,
    setLightningReceiveView,
    setActiveMintInvoice,
    activeMintInvoice,
    npubCashLightningAddressEnabled,
    setNpubCashClaimStatus,
    setNpubCashClaimMessage,
    npubCashClaimingRef,
    setPaymentRequestState,
    setPaymentRequestStatus,
    setPaymentRequestMessage,
    setPaymentRequestManualAmount,
    resetSendLockSettings,
    resetContactForm,
  } = opts;

  const resetNwcFundState = useCallback(() => {
    setNwcFundState("idle");
    setNwcFundMessage("");
    setNwcFundInvoice("");
  }, []);

  const resetNwcWithdrawState = useCallback(() => {
    setNwcWithdrawState("idle");
    setNwcWithdrawMessage("");
    setNwcWithdrawInvoice("");
  }, []);

  const closeNwcSheets = useCallback(() => {
    closeNwcManager();
    setShowNwcSheet(false);
    resetNwcFundState();
    resetNwcWithdrawState();
    setMintSwapState("idle");
    setMintSwapMessage("");
    setSwapAmount("");
    setSwapFromValue("");
    setSwapToValue("");
  }, [closeNwcManager, resetNwcFundState, resetNwcWithdrawState, setShowNwcSheet]);

  const resetLnurlWithdrawView = useCallback(() => {
    setLnurlWithdrawState("idle");
    setLnurlWithdrawMessage("");
    setLnurlWithdrawInvoice("");
    setLnurlWithdrawAmt("");
    setLnurlWithdrawInfo(null);
  }, []);

  const openReceiveEcashSheet = useCallback(() => {
    setReceiveMode("ecash");
    setReceiveLockVisible(false);
    setEcashReceiveView("overview");
    setEcashRequestAmt("");
    setEcashRequestMode("multi");
    setRecvMsg("");
    setLastCreatedEcashRequest(null);
  }, []);

  const closeReceiveEcashSheet = useCallback(() => {
    setReceiveMode(null);
    setReceiveLockVisible(false);
    setEcashReceiveView("overview");
    setEcashRequestAmt("");
    setEcashRequestMode("multi");
    setRecvMsg("");
    setLastCreatedEcashRequest(null);
  }, []);

  const openReceiveLightningSheet = useCallback(() => {
    setReceiveMode("lightning");
    setMintAmt("");
    setMintQuote(null);
    setMintStatus(activeMintInvoice ? "waiting" : "idle");
    setMintError("");
    if (!npubCashClaimingRef.current) {
      setNpubCashClaimStatus("idle");
      setNpubCashClaimMessage("");
    }
    const defaultView = activeMintInvoice
      ? "invoice"
      : npubCashLightningAddressEnabled
        ? "address"
        : "amount";
    setLightningReceiveView(defaultView);
    refreshMintEntries();
  }, [activeMintInvoice, npubCashLightningAddressEnabled, refreshMintEntries]);

  const resetLightningInvoiceState = useCallback(() => {
    setMintQuote(null);
    setActiveMintInvoice(null);
    setMintStatus("idle");
    setMintError("");
  }, []);

  const closeReceiveLightningSheet = useCallback(() => {
    setReceiveMode(null);
    setMintAmt("");
    resetLightningInvoiceState();
    setLightningReceiveView("address");
    setNpubCashClaimStatus("idle");
    setNpubCashClaimMessage("");
  }, [resetLightningInvoiceState]);

  const closeReceiveLnurlWithdrawSheet = useCallback(() => {
    resetLnurlWithdrawView();
    setReceiveMode(null);
  }, [resetLnurlWithdrawView]);

  const resetLightningSendForm = useCallback(() => {
    setLnInput("");
    setLnAddrAmt("");
    setLnState("idle");
    setLnError("");
    setLnurlPayData(null);
    setContactsOpen(false);
    resetContactForm();
    setLightningSendView("input");
  }, [resetContactForm, setLnInput]);

  const handleRemoveMintEntry = useCallback(
    (url: string) => {
      removeMintFromList(url);
      refreshMintEntries();
    },
    [refreshMintEntries],
  );

  const resetEcashSendForm = useCallback(() => {
    setSendAmt("");
    setSendTokenStr("");
    setEcashSendRecipient(null);
    setEcashSendView("amount");
    setLastSendTokenAmount(null);
    setLastSendTokenMint(null);
    setLastSendTokenFingerprint(null);
    setLastSendTokenLockLabel(null);
    resetSendLockSettings();
    setCreatingSendToken(false);
  }, [resetSendLockSettings]);

  const openLightningSendSheet = useCallback(() => {
    resetEcashSendForm();
    resetLightningSendForm();
    setSendMode("lightning");
    setShowSendOptions(false);
  }, [resetEcashSendForm, resetLightningSendForm]);

  const closeLightningSendSheet = useCallback(() => {
    setSendMode(null);
    setShowSendOptions(false);
    resetLightningSendForm();
  }, [resetLightningSendForm]);

  const openEcashSendSheet = useCallback(() => {
    resetEcashSendForm();
    resetLightningSendForm();
    setSendMode("ecash");
    setShowSendOptions(false);
  }, [resetEcashSendForm, resetLightningSendForm]);

  const openEcashSendToContact = useCallback(
    (contact: Contact) => {
      resetEcashSendForm();
      resetLightningSendForm();
      setEcashSendRecipient(contact);
      setEcashSendView("contact");
      setSendMode("ecash");
      setShowSendOptions(false);
    },
    [resetEcashSendForm, resetLightningSendForm],
  );

  const closeEcashSendSheet = useCallback(() => {
    setSendMode(null);
    setShowSendOptions(false);
    resetEcashSendForm();
  }, [resetEcashSendForm]);

  const closePaymentRequestSheet = useCallback(() => {
    setSendMode(null);
    setShowSendOptions(false);
    setPaymentRequestState(null);
    setPaymentRequestStatus("idle");
    setPaymentRequestMessage("");
    setPaymentRequestManualAmount("");
  }, []);

  return {
    resetNwcFundState,
    resetNwcWithdrawState,
    closeNwcSheets,
    resetLnurlWithdrawView,
    openReceiveEcashSheet,
    closeReceiveEcashSheet,
    openReceiveLightningSheet,
    resetLightningInvoiceState,
    closeReceiveLightningSheet,
    closeReceiveLnurlWithdrawSheet,
    resetLightningSendForm,
    handleRemoveMintEntry,
    resetEcashSendForm,
    openLightningSendSheet,
    closeLightningSendSheet,
    openEcashSendSheet,
    openEcashSendToContact,
    closeEcashSendSheet,
    closePaymentRequestSheet,
  };
}
