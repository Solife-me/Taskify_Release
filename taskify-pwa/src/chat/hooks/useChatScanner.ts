import { useCallback } from "react";
import { nip19 } from "nostr-tools";
import { decodeContactPayload } from "../chatHelpers";

type ScannedContact = { npub?: string; relays?: string[] } & Record<string, unknown>;

/**
 * Chat's QR scanner: adds people. It reads Taskify contact cards and Nostr profiles (`npub`,
 * `nprofile`, with or without `nostr:`); anything else, such as payment codes, gets a message
 * rather than an action, since chat has no wallet.
 */
export function useChatScanner({
  formatNpub,
  handleScannedContactPayload,
  setScannerMessage,
  setShowScanner,
}: {
  formatNpub: (pubkeyHex: string) => string;
  handleScannedContactPayload: (payload: ScannedContact) => Promise<void>;
  setScannerMessage: (message: string) => void;
  setShowScanner: (open: boolean) => void;
}) {
  const handleScannerDetected = useCallback(
    async (rawValue: string): Promise<boolean> => {
      const candidate = rawValue.trim().replace(/^nostr:/i, "");
      if (!candidate) return false;
      const contact = decodeContactPayload(candidate);
      if (contact) {
        await handleScannedContactPayload(contact as ScannedContact);
        return true;
      }
      try {
        const decoded = nip19.decode(candidate);
        if (decoded.type === "nprofile" && decoded.data.pubkey) {
          await handleScannedContactPayload({
            npub: formatNpub(decoded.data.pubkey),
            relays: (decoded.data.relays ?? []).filter((relay) => typeof relay === "string" && relay.trim()),
          });
          return true;
        }
        if (decoded.type === "npub") {
          await handleScannedContactPayload({ npub: nip19.npubEncode(decoded.data) });
          return true;
        }
      } catch {
        // not a Nostr profile
      }
      setScannerMessage("That code isn't a contact. Scan a Taskify contact card or a Nostr profile (npub).");
      return false;
    },
    [formatNpub, handleScannedContactPayload, setScannerMessage],
  );

  const handlePasteFromClipboard = useCallback(async () => {
    setScannerMessage("");
    try {
      if (!navigator.clipboard?.readText) {
        setScannerMessage("Clipboard access unavailable. Paste the code manually.");
        return;
      }
      const pasted = (await navigator.clipboard.readText()).trim();
      if (!pasted) {
        setScannerMessage("Clipboard is empty.");
        return;
      }
      await handleScannerDetected(pasted);
    } catch (err) {
      setScannerMessage(err instanceof Error ? err.message : "Failed to read from clipboard.");
    }
  }, [handleScannerDetected, setScannerMessage]);

  const handleScannerError = useCallback((message: string) => setScannerMessage(message), [setScannerMessage]);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    setScannerMessage("");
  }, [setScannerMessage, setShowScanner]);

  return { handleScannerDetected, handlePasteFromClipboard, handleScannerError, closeScanner };
}
