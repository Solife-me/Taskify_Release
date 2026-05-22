import { useState } from "react";
import type { Contact } from "../../lib/contacts";

export type EcashSendView = "amount" | "token" | "contact";

export function useEcashSendState() {
  const [sendAmt, setSendAmt] = useState("");
  const [sendTokenStr, setSendTokenStr] = useState("");
  const [nutTokenCopied, setNutTokenCopied] = useState(false);
  const [ecashSendView, setEcashSendView] = useState<EcashSendView>("amount");
  const [ecashSendRecipient, setEcashSendRecipient] = useState<Contact | null>(null);
  const [lastSendTokenAmount, setLastSendTokenAmount] = useState<number | null>(null);
  const [lastSendTokenMint, setLastSendTokenMint] = useState<string | null>(null);
  const [creatingSendToken, setCreatingSendToken] = useState(false);
  const [lastSendTokenFingerprint, setLastSendTokenFingerprint] = useState<string | null>(null);
  const [lastSendTokenLockLabel, setLastSendTokenLockLabel] = useState<string | null>(null);
  const [lockSendToPubkey, setLockSendToPubkey] = useState(false);
  const [sendLockPubkeyInput, setSendLockPubkeyInput] = useState("");
  const [sendLockError, setSendLockError] = useState("");

  return {
    sendAmt,
    setSendAmt,
    sendTokenStr,
    setSendTokenStr,
    nutTokenCopied,
    setNutTokenCopied,
    ecashSendView,
    setEcashSendView,
    ecashSendRecipient,
    setEcashSendRecipient,
    lastSendTokenAmount,
    setLastSendTokenAmount,
    lastSendTokenMint,
    setLastSendTokenMint,
    creatingSendToken,
    setCreatingSendToken,
    lastSendTokenFingerprint,
    setLastSendTokenFingerprint,
    lastSendTokenLockLabel,
    setLastSendTokenLockLabel,
    lockSendToPubkey,
    setLockSendToPubkey,
    sendLockPubkeyInput,
    setSendLockPubkeyInput,
    sendLockError,
    setSendLockError,
  };
}
