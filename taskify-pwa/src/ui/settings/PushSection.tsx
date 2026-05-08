// @ts-nocheck
import React, { useState, useCallback } from "react";
import type { PushPlatform, PushPreferences } from "../../domains/tasks/settingsTypes";

export function PushSection({
  pushPrefs,
  pushWorkState,
  pushError,
  onEnablePush,
  onDisablePush,
  workerBaseUrl,
  vapidPublicKey,
}: {
  pushPrefs: PushPreferences;
  pushWorkState: "idle" | "enabling" | "disabling";
  pushError: string | null;
  onEnablePush: (platform: PushPlatform) => Promise<void>;
  onDisablePush: () => Promise<void>;
  workerBaseUrl: string;
  vapidPublicKey: string;
}) {
  const [showPushAdvanced, setShowPushAdvanced] = useState(false);
  const secureContext = typeof window !== 'undefined' ? window.isSecureContext : false;
  const pushSupported = typeof window !== 'undefined'
    && secureContext
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window;
  const workerConfigured = !!workerBaseUrl;
  const vapidConfigured = !!vapidPublicKey;
  const pushBusy = pushWorkState !== 'idle';
  const permissionLabel = pushPrefs.permission ?? (typeof Notification !== 'undefined' ? Notification.permission : 'default');
  const pushSupportHint = !secureContext
    ? 'Push notifications require HTTPS (or localhost during development).'
    : 'Push notifications need a browser with Service Worker and Push API support.';

  const handleEnablePush = useCallback(async () => {
    try {
      await onEnablePush(pushPrefs.platform);
    } catch {}
  }, [onEnablePush, pushPrefs.platform]);

  const handleDisablePush = useCallback(async () => {
    try {
      await onDisablePush();
    } catch {}
  }, [onDisablePush]);

  return (
    <section className="wallet-section space-y-3">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-sm font-medium">Push notifications</div>
        <div className="ml-auto flex items-center gap-2">
          <span className={`text-xs ${pushPrefs.enabled ? 'text-emerald-400' : 'text-secondary'}`}>
            {pushPrefs.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <button
            className="ghost-button button-sm pressable"
            onClick={() => setShowPushAdvanced((v) => !v)}
          >
            {showPushAdvanced ? 'Hide advanced' : 'Advanced'}
          </button>
        </div>
      </div>
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            className={`${pushPrefs.enabled ? 'ghost-button' : 'accent-button'} button-sm pressable w-full sm:w-auto`}
            onClick={pushPrefs.enabled ? handleDisablePush : handleEnablePush}
            disabled={pushBusy || !pushSupported || !workerConfigured || !vapidConfigured}
          >
            {pushBusy ? 'Working…' : pushPrefs.enabled ? 'Disable push' : 'Enable push'}
          </button>
          {showPushAdvanced && (
            <div className="text-xs text-secondary sm:ml-auto">
              Permission: {permissionLabel}
            </div>
          )}
        </div>
        {showPushAdvanced && (
          <>
            <div>
              <div className="text-sm font-medium mb-2">Detected platform</div>
              <div className="text-xs text-secondary">
                {pushPrefs.platform === 'ios'
                  ? 'Using Apple Push Notification service (Safari / iOS / macOS).'
                  : 'Using the standard Web Push service (FCM-compatible browsers).'}
              </div>
            </div>
            {!pushSupported && (
              <div className="text-xs text-secondary">
                {pushSupportHint}
              </div>
            )}
            {(!workerConfigured || !vapidConfigured) && (
              <div className="text-xs text-secondary">
                Configure the Worker runtime (or set VITE_WORKER_BASE_URL and VITE_VAPID_PUBLIC_KEY) to enable push registration.
              </div>
            )}
            {pushError && (
              <div className="text-xs text-rose-400 break-words">{pushError}</div>
            )}
            {pushPrefs.enabled && pushPrefs.deviceId && (
              <div className="text-xs text-secondary break-words">
                Device ID: {pushPrefs.deviceId}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
