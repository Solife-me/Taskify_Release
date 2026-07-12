import React, { useState } from "react";

type GeneratedBackup = {
  nsec: string;
};

type OnboardingPage = "home" | "sign-in" | "create" | "restore" | "notifications";

type FirstRunOnboardingProps = {
  pushSupported: boolean;
  pushConfigured: boolean;
  onUseExistingKey: (value: string) => boolean;
  onGenerateNewKey: () => GeneratedBackup | null;
  onRestoreFromBackupFile: (file: File) => Promise<void>;
  onEnableNotifications: () => Promise<void>;
  onComplete: () => void;
};

export function FirstRunOnboarding({
  pushSupported,
  pushConfigured,
  onUseExistingKey,
  onGenerateNewKey,
  onRestoreFromBackupFile,
  onEnableNotifications,
  onComplete,
}: FirstRunOnboardingProps) {
  const [page, setPage] = useState<OnboardingPage>("home");
  const [existingKeyInput, setExistingKeyInput] = useState("");
  const [createdNsec, setCreatedNsec] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);

  const goHome = () => {
    setPage("home");
    setSignInError(null);
    setCreateError(null);
    setRestoreError(null);
    setCreateMessage(null);
    setNotificationError(null);
  };

  const copyValue = async (value: string, label: string) => {
    if (!value) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard not available");
      }
      await navigator.clipboard.writeText(value);
      setCreateMessage(`${label} copied`);
    } catch {
      setCreateMessage(`Unable to copy ${label.toLowerCase()} on this device`);
    }
  };

  const saveNsecToFile = (value: string) => {
    if (!value) return;
    try {
      const blob = new Blob([`${value}\n`], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "taskify-nsec.txt";
      a.click();
      URL.revokeObjectURL(url);
      setCreateMessage("nsec file downloaded");
    } catch {
      setCreateMessage("Unable to save key file on this device");
    }
  };

  const handleOpenCreatePage = () => {
    setCreateError(null);
    setCreateMessage(null);
    if (!createdNsec) {
      const generated = onGenerateNewKey();
      if (!generated) {
        setCreateError("Unable to generate a key right now. Try again.");
        setPage("create");
        return;
      }
      setCreatedNsec(generated.nsec);
    }
    setPage("create");
  };

  const handleUseExistingKey = () => {
    setSignInError(null);
    const trimmed = existingKeyInput.trim();
    if (!trimmed) {
      setSignInError("Enter your nsec first.");
      return;
    }
    const ok = onUseExistingKey(trimmed);
    if (!ok) {
      setSignInError("That nsec looks invalid. Paste a valid nsec or 64-character secret key.");
      return;
    }
    setPage("notifications");
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
      const message = err instanceof Error ? err.message : "Unable to restore backup file.";
      setRestoreError(message);
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleEnableNotifications = async () => {
    setNotificationBusy(true);
    setNotificationError(null);
    try {
      await onEnableNotifications();
      onComplete();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to enable notifications.";
      setNotificationError(message);
    } finally {
      setNotificationBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {page === "home" && (
        <div className="space-y-4 text-sm text-secondary">
          <p className="text-primary">
            Choose how you want to get started.
          </p>
          <div className="space-y-2 rounded-xl border border-surface bg-surface-muted p-3">
            <button
              type="button"
              className="accent-button button-sm pressable w-full justify-center"
              onClick={() => {
                setSignInError(null);
                setPage("sign-in");
              }}
            >
              Sign in with nsec
            </button>
          </div>
          <div className="space-y-2 rounded-xl border border-surface bg-surface-muted p-3">
            <button
              type="button"
              className="ghost-button button-sm pressable w-full justify-center"
              onClick={handleOpenCreatePage}
            >
              Create new login
            </button>
          </div>
          <div className="space-y-2 rounded-xl border border-surface bg-surface-muted p-3">
            <button
              type="button"
              className="ghost-button button-sm pressable w-full justify-center"
              onClick={() => {
                setRestoreError(null);
                setPage("restore");
              }}
            >
              Restore from backup
            </button>
          </div>
        </div>
      )}

      {page === "sign-in" && (
        <div className="space-y-4 text-sm text-secondary">
          <div className="text-sm font-medium text-primary">Sign in with nsec</div>
          <input
            className="pill-input w-full"
            placeholder="nsec1... or 64-character key"
            value={existingKeyInput}
            onChange={(event) => setExistingKeyInput(event.target.value)}
          />
          {signInError && <div className="text-xs text-rose-400">{signInError}</div>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={goHome}
            >
              Back
            </button>
            <button
              type="button"
              className="accent-button button-sm pressable"
              onClick={handleUseExistingKey}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {page === "create" && (
        <div className="space-y-4 text-sm text-secondary">
          <div className="text-sm font-medium text-primary">Create new login</div>
          <p>
            This private key acts as a password to login to your account. Store it somewhere safe like a password manager.
          </p>
          <textarea
            className="pill-input min-h-[78px] w-full"
            value={createdNsec}
            readOnly
            placeholder="Generating key..."
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                void copyValue(createdNsec, "nsec");
              }}
              disabled={!createdNsec}
            >
              Copy nsec
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => saveNsecToFile(createdNsec)}
              disabled={!createdNsec}
            >
              Save to file
            </button>
          </div>
          {createMessage && <div className="text-xs text-secondary">{createMessage}</div>}
          {createError && <div className="text-xs text-rose-400">{createError}</div>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={goHome}
            >
              Back
            </button>
            <button
              type="button"
              className="accent-button button-sm pressable"
              onClick={() => setPage("notifications")}
              disabled={!createdNsec}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {page === "restore" && (
        <div className="space-y-4 text-sm text-secondary">
          <div className="text-sm font-medium text-primary">Restore from backup</div>
          <div className="space-y-2 rounded-xl border border-surface bg-surface-muted p-3">
            <div className="text-sm font-medium text-primary">Restore from file</div>
            <label className="ghost-button button-sm pressable inline-flex cursor-pointer">
              {restoreBusy ? "Restoring..." : "Choose backup file"}
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(event) => {
                  void handleRestoreFromBackupFile(event);
                }}
                disabled={!!restoreBusy}
              />
            </label>
          </div>
          {restoreError && <div className="text-xs text-rose-400">{restoreError}</div>}
          <div>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={goHome}
              disabled={!!restoreBusy}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {page === "notifications" && (
        <div className="space-y-4 text-sm text-secondary">
          <p className="text-primary">Enable reminder notifications?</p>
          <p>
            Taskify only sends notifications for reminders you create on tasks or events. Taskify never sends unsolicited notifications.
          </p>
          {!pushSupported && (
            <div className="text-xs text-secondary">
              This device/browser does not support push notifications. You can still use Taskify normally.
            </div>
          )}
          {pushSupported && !pushConfigured && (
            <div className="text-xs text-secondary">
              Push notifications are not fully configured in this app build yet. You can enable them later in Settings when available.
            </div>
          )}
          {notificationError && <div className="text-xs text-rose-400">{notificationError}</div>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={onComplete}
              disabled={notificationBusy}
            >
              Not now
            </button>
            <button
              type="button"
              className="accent-button button-sm pressable"
              onClick={() => {
                if (!pushSupported || !pushConfigured) {
                  onComplete();
                  return;
                }
                void handleEnableNotifications();
              }}
              disabled={notificationBusy}
            >
              {notificationBusy ? "Enabling..." : "Enable notifications"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
