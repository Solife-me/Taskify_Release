/**
 * The Settings tab: the account, the relays, and the way out.
 */
import React, { useState } from "react";
import { useApp } from "./state";
import { DEFAULT_RELAYS } from "../lib/session";

export function Settings() {
  const { identity, boards, accountRelays, refresh, signOut, setToast, loading } = useApp();
  const [busy, setBusy] = useState(false);

  const handleRefresh = async () => {
    setBusy(true);
    try {
      await refresh();
      setToast("Refreshed.");
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    if (!window.confirm("Sign out of Taskify on this device? The account itself is not changed.")) return;
    await signOut();
  };

  return (
    <div className="pad">
      <div className="sectionhead">Account</div>
      <div className="card">
        <div className="setting">
          <div className="setting__label">
            Public key
            <small>Your Nostr identity. The same one the web app and the agent use.</small>
          </div>
        </div>
        <div className="setting__value" style={{ maxWidth: "100%", textAlign: "left", marginTop: 4 }}>
          {identity?.pubkey ?? "—"}
        </div>
      </div>

      <div className="sectionhead">Sync</div>
      <div className="card">
        <div className="setting">
          <div className="setting__label">
            Relays
            <small>Where your boards and messages travel.</small>
          </div>
          <div className="setting__value">{accountRelays.length}</div>
        </div>
        <div className="setting">
          <div className="setting__label">
            Boards
            <small>Boards this account can read.</small>
          </div>
          <div className="setting__value">{boards.length}</div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn--block" onClick={() => void handleRefresh()} disabled={busy || loading}>
            {busy || loading ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      </div>

      <div className="sectionhead">This device</div>
      <div className="card">
        <div className="setting">
          <div className="setting__label">
            Your key
            <small>
              Stored encrypted in this browser, the same way the Taskify app keeps it. Clearing the
              browser's data for the extension removes it.
            </small>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn--block btn--danger" onClick={() => void handleSignOut()}>
            Sign out on this device
          </button>
        </div>
      </div>

      <div className="sectionhead">About</div>
      <div className="card">
        <p className="hint" style={{ margin: 0 }}>
          Taskify for Brave. Your data lives on the Nostr relays you already use, and the extension
          only ever talks to them and to the file server an attachment needs.
        </p>
        <p className="hint">
          Default relays: {DEFAULT_RELAYS.join(", ")}
        </p>
      </div>
    </div>
  );
}
