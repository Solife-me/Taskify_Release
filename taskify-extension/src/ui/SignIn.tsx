/**
 * First run: the panel needs the account's key before it can show anything.
 *
 * The key is the same `nsec` the PWA, the iOS app and the agent use. It is stored encrypted on
 * this device, and never leaves it except to sign Nostr events.
 */
import React, { useState } from "react";
import { useApp } from "./state";

export function SignIn() {
  const { signIn, setToast } = useApp();
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!secretKey.trim() || busy) return;
    setBusy(true);
    try {
      await signIn(secretKey.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pad stack">
      <div>
        <div className="card__title">Connect your Taskify account</div>
        <p className="hint">
          Paste the <code>nsec</code> you use in Taskify. It is stored encrypted on this device and is
          never sent anywhere but the relays you already use.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="stack">
        <input
          className="field"
          type={showKey ? "text" : "password"}
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
          placeholder="nsec1… or 64-character key"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <div className="row">
          <button type="button" className="btn" onClick={() => setShowKey((value) => !value)}>
            {showKey ? "Hide" : "Show"}
          </button>
          <button type="submit" className="btn btn--primary" disabled={!secretKey.trim() || busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>

      <button
        type="button"
        className="btn"
        onClick={() =>
          setToast("Find your nsec in the Taskify app under Settings → Nostr, or in Settings → Backup.")
        }
      >
        Where do I find my nsec?
      </button>
    </div>
  );
}
