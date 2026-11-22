import { useCallback, useEffect, useState } from "react";
import { Modal } from "../Modal";
import {
  listenForBlossomFallbackConsent,
  respondToBlossomFallbackConsent,
  type BlossomFallbackConsentRequest,
} from "../../lib/blossomRetention";

export function BlossomFallbackConsentHost() {
  const [request, setRequest] = useState<BlossomFallbackConsentRequest | null>(null);
  const finish = useCallback((accepted: boolean) => {
    if (!request) return;
    respondToBlossomFallbackConsent({ requestId: request.requestId, accepted });
    setRequest(null);
  }, [request]);

  useEffect(() => listenForBlossomFallbackConsent((next) => setRequest(next)), []);

  if (!request) return null;
  return (
    <Modal
      title={request.termsChanged ? "Storage retention terms changed" : "Standard storage fallback"}
      onClose={() => finish(false)}
      desktop="dialog"
      actions={(
        <button type="button" className="accent-button button-sm pressable" onClick={() => finish(true)}>
          Use standard storage
        </button>
      )}
    >
      <div className="space-y-3 text-sm text-secondary">
        <p>
          This upload can&apos;t fit in your protected storage on {request.serverUrl}. If you continue,
          Blossom will store this file under the server&apos;s standard retention rules instead of a
          protection date.
        </p>
        <p>
          Standard-retention files can expire after a period of inactivity. New uploads will still ask
          for protected storage first. Choose this once and Taskify will remember it for this account
          on this server.
        </p>
        {request.termsChanged ? (
          <p className="text-amber-400">
            The server&apos;s standard retention terms changed since you last opted in. Please confirm again.
          </p>
        ) : null}
        {request.reason ? <p className="text-xs text-tertiary">{request.reason}</p> : null}
      </div>
    </Modal>
  );
}
