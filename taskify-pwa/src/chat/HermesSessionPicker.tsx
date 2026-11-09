import { useState } from "react";
import {
  buildHermesSessionResumeCommand,
  type HermesSessionListing,
} from "taskify-core";

export type HermesSessionPickerProps = {
  peerPubkey: string;
  listing: HermesSessionListing;
  sendDirectTextMessage: (peerPubkey: string, content: string) => Promise<void>;
};

export function HermesSessionPicker({
  peerPubkey,
  listing,
  sendDirectTextMessage,
}: HermesSessionPickerProps) {
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [sentSessionId, setSentSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const resumeSession = async (sessionId: string) => {
    if (resumingSessionId) return;
    setResumingSessionId(sessionId);
    setSentSessionId(null);
    setActionError(null);
    try {
      await sendDirectTextMessage(peerPubkey, buildHermesSessionResumeCommand(sessionId));
      setSentSessionId(sessionId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not resume the session.");
    } finally {
      setResumingSessionId(null);
    }
  };

  return (
    <div className="hermes-model-picker hermes-session-picker" aria-label="Hermes named sessions">
      <div className="hermes-model-picker__title-row">
        <span className="hermes-model-picker__gear" aria-hidden="true">▤</span>
        <div className="hermes-model-picker__title-copy">
          <div className="hermes-model-picker__title">Named sessions</div>
          <div className="hermes-model-picker__current">Choose a session to resume</div>
        </div>
        <span className="hermes-session-picker__count">{listing.sessions.length}</span>
      </div>

      <div className="hermes-session-picker__list">
        {listing.sessions.map((session) => (
          <button
            key={session.sessionId}
            type="button"
            className={`hermes-session-picker__session pressable${session.isCurrent ? " is-current" : ""}`}
            onClick={() => void resumeSession(session.sessionId)}
            disabled={!!resumingSessionId}
            aria-label={`Resume session: ${session.title}`}
            title={`/resume ${session.sessionId}`}
          >
            <span className="hermes-session-picker__copy">
              <span className="hermes-session-picker__name">{session.title}</span>
              <span className="hermes-session-picker__id">{session.sessionId}</span>
            </span>
            <span className="hermes-session-picker__state">
              {resumingSessionId === session.sessionId ? (
                <span className="hermes-model-picker__spinner" aria-label="Resuming" />
              ) : sentSessionId === session.sessionId ? (
                <span role="status">Sent ✓</span>
              ) : session.isCurrent ? (
                "Current"
              ) : (
                <span aria-hidden="true">›</span>
              )}
            </span>
          </button>
        ))}
      </div>
      {actionError && <div className="hermes-model-picker__error" role="alert">{actionError}</div>}
    </div>
  );
}
