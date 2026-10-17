import { useState } from "react";
import { keyBackupPrompt } from "./firstRunRules";
import { copyNsecToClipboard, snoozeKeyBackup, useKeyBackupState } from "./keyBackup";

/** Asks the user to save their key once losing it would cost them something. */
export function KeyBackupBanner({ taskCount }: { taskCount: number }) {
  const state = useKeyBackupState();
  const [copyFailed, setCopyFailed] = useState(false);
  const prompt = keyBackupPrompt(state, {
    now: Date.now(),
    taskCount,
    migrationNoticePending: state.migrationNoticePending,
  });
  if (!prompt) return null;

  const copy = async () => {
    setCopyFailed(!(await copyNsecToClipboard()));
  };

  return (
    <div className="sk-backup-banner" role="alert">
      <div className="sk-backup-banner__body">
        <span className="sk-backup-banner__dot" aria-hidden="true" />
        <span>
          {prompt === "migrated" ? (
            <>
              Your Nostr key is now encrypted on this device. Save your <strong>nsec</strong> somewhere safe so you can
              recover your account if this device is lost.
            </>
          ) : (
            <>
              Your tasks are tied to a key that exists only on this device. Save your <strong>nsec</strong> in a password
              manager to sign in elsewhere or recover your tasks.
            </>
          )}
          {copyFailed && <> Copying isn't available here; find your key in Settings → Nostr.</>}
        </span>
      </div>
      <div className="sk-backup-banner__actions">
        <button type="button" className="sk-backup-banner__primary pressable" onClick={() => void copy()}>
          Copy nsec
        </button>
        <button type="button" className="sk-backup-banner__secondary pressable" onClick={() => snoozeKeyBackup()}>
          {prompt === "migrated" ? "Got it" : "Not now"}
        </button>
      </div>
    </div>
  );
}
