import { useState, useSyncExternalStore } from "react";
import {
  isInstallPromptAvailable,
  requestAppInstall,
  subscribeInstallPrompt,
} from "../../pwa/installPrompt";
import { SettingsAccordion } from "./SettingsAccordion";

export function InstallAppSettingsGroup() {
  const available = useSyncExternalStore(
    subscribeInstallPrompt,
    isInstallPromptAvailable,
    () => false,
  );
  const [busy, setBusy] = useState(false);
  if (!available) return null;

  return (
    <SettingsAccordion
      title="Install Taskify"
      summary="Add Taskify to your home screen for faster launches"
    >
      <div className="space-y-3 text-sm text-secondary">
        <p>Install the app for a full-screen experience, offline access, and quicker opening.</p>
        <button
          type="button"
          className="accent-button button-sm pressable"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await requestAppInstall();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Opening…" : "Install app"}
        </button>
      </div>
    </SettingsAccordion>
  );
}
