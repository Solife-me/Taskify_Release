// @ts-nocheck
import { useMemo } from "react";
import { estimateInvoiceAmountSat, decodeBolt11Amount, formatMsatAsSat } from "../../wallet/lightning";
import { formatLightningAddressDisplay } from "../../ui/wallet/walletModalUi";
import { extractDomain } from "../../wallet/walletModalHelpers";

export interface UseLightningInputDerivedOptions {
  lnInput: string;
  lnurlPayData: any;
}

export function useLightningInputDerived({ lnInput, lnurlPayData }: UseLightningInputDerivedOptions) {
  const normalizedLnInput = useMemo(() => lnInput.trim().replace(/^lightning:/i, "").trim(), [lnInput]);
  const isLnAddress = useMemo(() => /^[^@\s]+@[^@\s]+$/.test(normalizedLnInput), [normalizedLnInput]);
  const isLnurlInput = useMemo(() => /^lnurl[0-9a-z]+$/i.test(normalizedLnInput), [normalizedLnInput]);
  const isBolt11Input = useMemo(() => /^ln(bc|tb|sb|bcrt)[0-9]/i.test(normalizedLnInput), [normalizedLnInput]);
  const lightningSendAddressDisplay = useMemo(() => {
    if (!isLnAddress) return "";
    return formatLightningAddressDisplay(normalizedLnInput);
  }, [isLnAddress, normalizedLnInput]);
  const lightningDestinationDisplay = useMemo(() => {
    if (!normalizedLnInput) return "";
    if (isLnAddress) return lightningSendAddressDisplay;
    if (isLnurlInput) return `LNURL (${lnurlPayData?.domain || extractDomain(normalizedLnInput)})`;
    return normalizedLnInput;
  }, [isLnAddress, isLnurlInput, lnurlPayData, lightningSendAddressDisplay, normalizedLnInput]);
  const lightningInvoiceAmountSat = useMemo(
    () => (isBolt11Input ? estimateInvoiceAmountSat(normalizedLnInput) : null),
    [isBolt11Input, normalizedLnInput],
  );
  const bolt11Details = useMemo(() => {
    if (!isBolt11Input) return null;
    try {
      const { amountMsat } = decodeBolt11Amount(normalizedLnInput);
      if (amountMsat === null) {
        return { message: "Invoice amount: not specified" };
      }
      return { message: `Invoice amount: ${formatMsatAsSat(amountMsat)}` };
    } catch (err: any) {
      return { error: err?.message || "Unable to decode invoice" };
    }
  }, [isBolt11Input, normalizedLnInput]);
  const lnurlRequiresAmount = useMemo(() => {
    if (!isLnurlInput) return false;
    if (!lnurlPayData) return true;
    if (lnurlPayData.lnurl.trim().toLowerCase() !== normalizedLnInput.toLowerCase()) return true;
    return lnurlPayData.minSendable !== lnurlPayData.maxSendable;
  }, [isLnurlInput, lnurlPayData, normalizedLnInput]);

  return {
    normalizedLnInput,
    isLnAddress,
    isLnurlInput,
    isBolt11Input,
    lightningSendAddressDisplay,
    lightningDestinationDisplay,
    lightningInvoiceAmountSat,
    bolt11Details,
    lnurlRequiresAmount,
  };
}
