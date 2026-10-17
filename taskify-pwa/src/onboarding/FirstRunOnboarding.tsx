import React, { useState } from "react";

type OnboardingPage = "home" | "existing";

type FirstRunOnboardingProps = {
  /** Makes an account key on this device and finishes first run. False if it could not. */
  onStart: () => boolean;
  /** Signs in with an nsec or hex key and finishes first run. False if the key is invalid. */
  onUseExistingKey: (value: string) => boolean;
  onRestoreFromBackupFile: (file: File) => Promise<void>;
};

/**
 * First run starts with tasks: one tap makes the account and opens the board. Saving the key is
 * asked later, once there is something to protect (see `KeyBackupBanner`), and notifications are
 * offered when the user first sets a reminder.
 */
export function FirstRunOnboarding({ onStart, onUseExistingKey, onRestoreFromBackupFile }: FirstRunOnboardingProps) {
  const [page, setPage] = useState<OnboardingPage>("home");
  const [existingKeyInput, setExistingKeyInput] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const handleStart = () => {
    setStartError(onStart() ? null : "Taskify couldn't set up your account. Try again.");
  };

  const handleUseExistingKey = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = existingKeyInput.trim();
    if (!trimmed) {
      setSignInError("Paste your nsec first.");
      return;
    }
    setSignInError(onUseExistingKey(trimmed) ? null : "That doesn't look like a valid nsec or 64-character secret key.");
  };

  const handleRestoreFromBackupFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setRestoreError(null);
    setRestoreBusy(true);
    try {
      await onRestoreFromBackupFile(file);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Unable to restore backup file.");
    } finally {
      setRestoreBusy(false);
    }
  };

  if (page === "home") {
    return (
      <div className="space-y-4 text-sm text-secondary">
        <p className="text-primary">
          Plan your week, keep lists and share boards. Your tasks stay private and sync across your devices.
        </p>
        <button type="button" className="accent-button pressable w-full justify-center" onClick={handleStart}>
          Start using Taskify
        </button>
        {startError && <div className="text-xs text-rose-400">{startError}</div>}
        <button
          type="button"
          className="ghost-button button-sm pressable w-full justify-center"
          onClick={() => setPage("existing")}
        >
          I already use Taskify
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm text-secondary">
      <form className="space-y-2 rounded-xl border border-surface bg-surface-muted p-3" onSubmit={handleUseExistingKey}>
        <label className="block text-sm font-medium text-primary" htmlFor="onboarding-nsec">
          Sign in with your key
        </label>
        <p className="text-xs">Use the nsec from your other device or password manager.</p>
        <input
          id="onboarding-nsec"
          className="pill-input w-full"
          placeholder="nsec1… or 64-character key"
          autoComplete="off"
          spellCheck={false}
          value={existingKeyInput}
          onChange={(event) => setExistingKeyInput(event.target.value)}
        />
        {signInError && <div className="text-xs text-rose-400">{signInError}</div>}
        <button type="submit" className="accent-button button-sm pressable">
          Sign in
        </button>
      </form>
      <div className="space-y-2 rounded-xl border border-surface bg-surface-muted p-3">
        <div className="text-sm font-medium text-primary">Restore a backup file</div>
        <label className="ghost-button button-sm pressable inline-flex cursor-pointer">
          {restoreBusy ? "Restoring…" : "Choose backup file"}
          <input
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(event) => {
              void handleRestoreFromBackupFile(event);
            }}
            disabled={restoreBusy}
          />
        </label>
        {restoreError && <div className="text-xs text-rose-400">{restoreError}</div>}
      </div>
      <button
        type="button"
        className="ghost-button button-sm pressable"
        onClick={() => {
          setSignInError(null);
          setRestoreError(null);
          setPage("home");
        }}
        disabled={restoreBusy}
      >
        Back
      </button>
    </div>
  );
}
