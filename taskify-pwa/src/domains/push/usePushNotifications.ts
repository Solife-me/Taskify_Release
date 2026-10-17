/**
 * Push notifications on this device: one browser push subscription (made with the Worker's VAPID
 * key) that carries both reminder alerts, registered with the Taskify Worker, and chat alerts,
 * registered with Taskify's push relay (see `chatPush.ts`).
 */
import { useEffect, useRef, useState } from "react";
import { normalizeRelayUrls } from "taskify-runtime-nostr";
import { currentIdentity } from "../../identity/identity";
import { toBufferSource } from "../../lib/binary";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";
import { withTimeout } from "../../lib/withTimeout";
import { NostrSession } from "../../nostr/NostrSession";
import type { NostrPublishFn } from "../../nostr/useNostrIdentity";
import { DEFAULT_PUSH_PREFERENCES, type SetSettingsFn } from "../tasks/settingsHook";
import type { PushPreferences, Settings } from "../tasks/settingsTypes";
import {
  advertisedInboxRelays,
  CHAT_PUSH_RELAY_URL,
  inboxPreferenceTemplate,
  inboxRelaysWithoutPushRelay,
  inboxRelaysWithPushRelay,
  NIP17_INBOX_PREFERENCE_KIND,
  registerChatPush,
  unregisterChatPush,
} from "./chatPush";
import type { PushPlatform } from "./pushUtils";
import { PUSH_OPERATION_TIMEOUT_MS } from "./reminderClient";
import { urlBase64ToUint8Array } from "./vapidKey";

export function usePushNotifications({
  settings,
  setSettings,
  workerBaseUrl,
  vapidPublicKey,
  defaultRelays,
  nostrPublish,
}: {
  settings: Settings;
  setSettings: SetSettingsFn;
  workerBaseUrl: string;
  vapidPublicKey: string;
  defaultRelays: string[];
  nostrPublish: NostrPublishFn;
}) {
  const [pushWorkState, setPushWorkState] = useState<"idle" | "enabling" | "disabling">("idle");
  const [pushError, setPushError] = useState<string | null>(null);
  const [chatPushBusy, setChatPushBusy] = useState(false);
  const reminderPayloadRef = useRef<string | null>(null);
  // Async flows finish after other settings changes; they patch the latest preferences.
  const latestPushPrefsRef = useRef<PushPreferences>(settings.pushNotifications);
  latestPushPrefsRef.current = settings.pushNotifications;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const pushPrefs = settings.pushNotifications ?? DEFAULT_PUSH_PREFERENCES;
    const permission = typeof Notification !== 'undefined' ? Notification.permission : pushPrefs.permission;

    const applyUpdates = (patch: Partial<PushPreferences>): boolean => {
      const keys = Object.keys(patch) as (keyof PushPreferences)[];
      if (!keys.length) return false;
      let changed = false;
      for (const key of keys) {
        if (patch[key] !== (pushPrefs as any)[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return false;
      setSettings({ pushNotifications: { ...pushPrefs, ...patch } });
      return true;
    };

    const ensureDisabled = () => {
      const patch: Partial<PushPreferences> = {};
      if (pushPrefs.enabled) patch.enabled = false;
      if (pushPrefs.subscriptionId !== undefined) patch.subscriptionId = undefined;
      if (permission !== pushPrefs.permission) patch.permission = permission;
      const changed = applyUpdates(patch);
      if (changed) {
        reminderPayloadRef.current = null;
      }
    };

    if (!pushPrefs.enabled) {
      if (permission !== pushPrefs.permission) {
        applyUpdates({ permission });
      }
      return;
    }

    const pushApiSupported = 'serviceWorker' in navigator && 'PushManager' in window;
    if (!pushApiSupported) {
      ensureDisabled();
      return;
    }

    let cancelled = false;
    (async () => {
      let registration: ServiceWorkerRegistration | null | undefined;
      try {
        registration = typeof navigator.serviceWorker.getRegistration === 'function'
          ? await withTimeout(
            navigator.serviceWorker.getRegistration(),
            PUSH_OPERATION_TIMEOUT_MS,
            'Timed out while checking the service worker registration.',
          )
          : undefined;
      } catch {}
      if (!registration) {
        try {
          registration = await withTimeout(
            navigator.serviceWorker.ready,
            PUSH_OPERATION_TIMEOUT_MS,
            'Timed out waiting for the service worker to become ready.',
          );
        } catch {}
      }
      if (cancelled) return;
      if (!registration) {
        ensureDisabled();
        return;
      }

      let subscription: PushSubscription | null = null;
      try {
        subscription = await withTimeout(
          registration.pushManager.getSubscription(),
          PUSH_OPERATION_TIMEOUT_MS,
          'Timed out while checking the existing push subscription.',
        );
      } catch {}
      if (cancelled) return;
      if (!subscription || permission !== 'granted') {
        ensureDisabled();
        return;
      }

      if (permission !== pushPrefs.permission) {
        applyUpdates({ permission });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setSettings, settings.pushNotifications]);

  function normalizePushError(err: unknown): string {
    if (!(err instanceof Error)) return 'Failed to enable push notifications.';
    const message = err.message || 'Failed to enable push notifications.';
    const lower = message.toLowerCase();
    if (lower.includes('push service error')) {
      return 'The browser\'s push service rejected the registration. Check that notifications are allowed for this site (Safari → Settings → Websites → Notifications on macOS) and try again.';
    }
    if (lower.includes('not allowed')) {
      return 'The browser blocked the subscription request. Grant notification permission and try again.';
    }
    if (lower.includes('secure context')) {
      return 'Push notifications require HTTPS (or localhost during development). Reload the app over a secure origin and try again.';
    }
    if (lower.includes('invalid vapid public key')) {
      return 'The configured VAPID public key appears to be invalid. Update both the Worker and the app with matching VAPID keys.';
    }
    return message;
  }

  function isRecoverablePushError(err: unknown): boolean {
    if (!err) return false;
    const message = typeof (err as any)?.message === 'string' ? (err as any).message.toLowerCase() : '';
    if (!message) return false;
    return message.includes('push service error')
      || message.includes('not allowed')
      || message.includes('denied')
      || message.includes('aborted');
  }

  async function purgeExistingPushSubscriptions(): Promise<void> {
    if (!navigator.serviceWorker) return;
    const hasGetRegistrations = typeof navigator.serviceWorker.getRegistrations === 'function';
    const registrations: ServiceWorkerRegistration[] = [];
    try {
      if (hasGetRegistrations) {
        registrations.push(...await navigator.serviceWorker.getRegistrations());
      } else if (typeof navigator.serviceWorker.getRegistration === 'function') {
        const single = await navigator.serviceWorker.getRegistration();
        if (single) registrations.push(single);
      }
    } catch {
      return;
    }
    await Promise.all(registrations.map(async (registration) => {
      try {
        const sub = await registration.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch {}
    }));
  }

  async function subscribeWithRecovery(
    registration: ServiceWorkerRegistration,
    applicationServerKey: Uint8Array,
  ): Promise<PushSubscription> {
    const subscribe = () =>
      withTimeout(
        registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: toBufferSource(applicationServerKey),
        }),
        PUSH_OPERATION_TIMEOUT_MS,
        'Timed out while creating a push subscription.',
      );
    try {
      return await subscribe();
    } catch (err) {
      if (!isRecoverablePushError(err)) throw err;
      await purgeExistingPushSubscriptions();
      return await subscribe();
    }
  }

  async function resolvePushServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Push notifications are not supported on this device.');
    }

    let registration: ServiceWorkerRegistration | null | undefined;
    if (typeof navigator.serviceWorker.getRegistration === 'function') {
      try {
        registration = await withTimeout(
          navigator.serviceWorker.getRegistration(),
          PUSH_OPERATION_TIMEOUT_MS,
          'Timed out while checking the service worker registration.',
        );
      } catch {}
    }

    if (!registration && typeof navigator.serviceWorker.register === 'function') {
      try {
        registration = await withTimeout(
          navigator.serviceWorker.register('/sw.js'),
          PUSH_OPERATION_TIMEOUT_MS,
          'Timed out while registering the service worker.',
        );
      } catch {}
    }

    if (registration?.active) return registration;

    try {
      return await withTimeout(
        navigator.serviceWorker.ready,
        PUSH_OPERATION_TIMEOUT_MS,
        'Timed out waiting for the service worker to become ready.',
      );
    } catch {
      throw new Error('Service worker is not ready yet. Reload Taskify and try again.');
    }
  }

  async function enablePushNotifications(platform: PushPlatform): Promise<void> {
    if (pushWorkState === 'enabling') return;
    setPushWorkState('enabling');
    setPushError(null);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('Push notifications are not supported on this device.');
      }
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        throw new Error('Push notifications require HTTPS (or localhost).');
      }
      if (!vapidPublicKey) {
        throw new Error('Missing VAPID public key.');
      }
      if (!workerBaseUrl) {
        throw new Error('Missing worker base URL.');
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Notifications permission was not granted.');
      }

      const registration = await resolvePushServiceWorkerRegistration();
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey.trim());
      let subscription = await withTimeout(
        registration.pushManager.getSubscription(),
        PUSH_OPERATION_TIMEOUT_MS,
        'Timed out while checking the existing push subscription.',
      );
      if (!subscription) {
        subscription = await subscribeWithRecovery(registration, applicationServerKey);
      }

      const deviceId = settings.pushNotifications.deviceId || crypto.randomUUID();
      const subscriptionJson = subscription.toJSON();
      const normalizedPlatform: PushPlatform = platform === 'android' ? 'android' : 'ios';

      const res = await withTimeout(
        fetch(`${workerBaseUrl}/api/devices`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId,
            subscriptionId: settings.pushNotifications.subscriptionId,
            platform: normalizedPlatform,
            subscription: subscriptionJson,
          }),
        }),
        PUSH_OPERATION_TIMEOUT_MS,
        'Timed out while registering this device for notifications.',
      );
      if (!res.ok) {
        throw new Error(`Failed to register device (${res.status})`);
      }
      let subscriptionId: string | undefined;
      let resolvedDeviceId = deviceId;
      try {
        const data = await res.json();
        if (data && typeof data.subscriptionId === 'string') subscriptionId = data.subscriptionId;
        if (data && typeof data.deviceId === 'string' && data.deviceId) resolvedDeviceId = data.deviceId;
      } catch {}

      const updated: PushPreferences = {
        ...settings.pushNotifications,
        enabled: true,
        platform: normalizedPlatform,
        deviceId: resolvedDeviceId,
        subscriptionId,
        permission,
      };

      setSettings({ pushNotifications: updated });
      reminderPayloadRef.current = null;
      if (updated.chatEnabled && updated.deviceId) {
        void startChatAlerts(updated.deviceId, subscriptionJson).catch((error) => {
          console.warn('Failed to refresh chat notifications', error);
        });
      }
    } catch (err) {
      const message = normalizePushError(err);
      setPushError(message);
      if (typeof Notification !== 'undefined') {
        setSettings({ pushNotifications: { ...settings.pushNotifications, permission: Notification.permission } });
      }
      throw err;
    } finally {
      setPushWorkState('idle');
    }
  }

  async function disablePushNotifications(): Promise<void> {
    if (pushWorkState === 'disabling') return;
    setPushWorkState('disabling');
    setPushError(null);
    try {
      if (settings.pushNotifications.chatEnabled) await stopChatAlerts();
      if ('serviceWorker' in navigator) {
        try {
          let registration: ServiceWorkerRegistration | null | undefined = undefined;
          if (typeof navigator.serviceWorker.getRegistration === 'function') {
            try {
              registration = await withTimeout(
                navigator.serviceWorker.getRegistration(),
                PUSH_OPERATION_TIMEOUT_MS,
                'Timed out while checking the service worker registration.',
              );
            } catch {}
          }
          if (!registration) {
            try {
              registration = await withTimeout(
                navigator.serviceWorker.ready,
                PUSH_OPERATION_TIMEOUT_MS,
                'Timed out waiting for the service worker to become ready.',
              );
            } catch {}
          }
          if (registration) {
            try {
              const subscription = await registration.pushManager.getSubscription();
              if (subscription) await subscription.unsubscribe();
            } catch {}
          }
        } catch {}
      }

      if (workerBaseUrl && settings.pushNotifications.deviceId) {
        try {
          await withTimeout(
            fetch(`${workerBaseUrl}/api/devices/${settings.pushNotifications.deviceId}`, {
              method: 'DELETE',
              headers: settings.pushNotifications.subscriptionId
                ? { 'X-Taskify-Subscription': settings.pushNotifications.subscriptionId }
                : undefined,
            }),
            PUSH_OPERATION_TIMEOUT_MS,
            'Timed out while unregistering this device from notifications.',
          );
        } catch {}
      }

      const permission = typeof Notification !== 'undefined'
        ? Notification.permission
        : settings.pushNotifications.permission;

      setSettings({
        pushNotifications: {
          ...settings.pushNotifications,
          enabled: false,
          chatEnabled: false,
          subscriptionId: undefined,
          permission,
        },
      });
      reminderPayloadRef.current = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to disable push notifications';
      setPushError(message);
      if (typeof Notification !== 'undefined') {
        setSettings({ pushNotifications: { ...settings.pushNotifications, permission: Notification.permission } });
      }
      throw err;
    } finally {
      setPushWorkState('idle');
    }
  }

  // ---- Chat alerts (Taskify push relay) ----

  /** Adds or removes the push relay in the account's NIP-17 inbox preference. */
  async function updateInboxPreference(change: "add" | "remove"): Promise<void> {
    const identity = currentIdentity();
    if (!identity) throw new Error("Sign in to change chat notifications.");
    const fallback = normalizeRelayUrls(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    const discovery = normalizeRelayUrls([...fallback, CHAT_PUSH_RELAY_URL]);
    const session = await NostrSession.init(discovery);
    // A failed lookup must not be mistaken for "no preference": that would replace the user's list.
    const events = await session.fetchEvents(
      [{ kinds: [NIP17_INBOX_PREFERENCE_KIND], authors: [identity.pubkey] }],
      discovery,
    );
    const advertised = advertisedInboxRelays(events, identity.pubkey);
    const next = change === "add"
      ? inboxRelaysWithPushRelay(advertised, fallback)
      : inboxRelaysWithoutPushRelay(advertised);
    if (!next) return;
    const accepted = await nostrPublish(normalizeRelayUrls([...discovery, ...next]), inboxPreferenceTemplate(next));
    if (!accepted) throw new Error("Couldn't publish your message inbox settings. Try again.");
  }

  async function startChatAlerts(installationId: string, subscription: PushSubscriptionJSON): Promise<void> {
    const identity = currentIdentity();
    if (!identity) throw new Error("Sign in to get chat notifications.");
    await registerChatPush({ signer: identity.signer, installationId, subscription });
    try {
      await updateInboxPreference("add");
    } catch (err) {
      await unregisterChatPush({ signer: identity.signer, installationId }).catch(() => {});
      throw err;
    }
  }

  async function stopChatAlerts(): Promise<void> {
    const identity = currentIdentity();
    const installationId = latestPushPrefsRef.current.deviceId;
    if (!identity || !installationId) return;
    try {
      const response = await unregisterChatPush({ signer: identity.signer, installationId });
      // Other devices on this account (an iPhone, another browser) still need the relay listed.
      if (response.remainingRegistrations === 0) await updateInboxPreference("remove");
    } catch (err) {
      console.warn("Failed to turn off chat notifications", err);
    }
  }

  async function enableChatPush(): Promise<void> {
    if (chatPushBusy) return;
    setChatPushBusy(true);
    setPushError(null);
    try {
      const prefs = latestPushPrefsRef.current;
      if (!prefs.enabled || !prefs.deviceId) throw new Error("Turn on push notifications first.");
      const registration = await resolvePushServiceWorkerRegistration();
      const subscription = await withTimeout(
        registration.pushManager.getSubscription(),
        PUSH_OPERATION_TIMEOUT_MS,
        "Timed out while checking the existing push subscription.",
      );
      if (!subscription) throw new Error("This browser lost its push subscription. Turn push notifications off and on again.");
      await startChatAlerts(prefs.deviceId, subscription.toJSON());
      setSettings({ pushNotifications: { ...latestPushPrefsRef.current, chatEnabled: true } });
    } catch (err) {
      setPushError(err instanceof Error ? err.message : "Failed to turn on chat notifications.");
    } finally {
      setChatPushBusy(false);
    }
  }

  async function disableChatPush(): Promise<void> {
    if (chatPushBusy) return;
    setChatPushBusy(true);
    setPushError(null);
    try {
      await stopChatAlerts();
      setSettings({ pushNotifications: { ...latestPushPrefsRef.current, chatEnabled: false } });
    } finally {
      setChatPushBusy(false);
    }
  }

  // The relay forgets a registration after 90 days without a refresh, and browsers can replace a
  // subscription, so an enabled device registers again once per launch.
  const chatRefreshedRef = useRef(false);
  const chatEnabled = !!settings.pushNotifications.enabled && !!settings.pushNotifications.chatEnabled;
  useEffect(() => {
    if (!chatEnabled || chatRefreshedRef.current) return;
    const installationId = latestPushPrefsRef.current.deviceId;
    const identity = currentIdentity();
    if (!installationId || !identity || !("serviceWorker" in navigator)) return;
    chatRefreshedRef.current = true;
    void (async () => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;
      await registerChatPush({ signer: identity.signer, installationId, subscription: subscription.toJSON() });
    })().catch((err) => console.warn("Failed to refresh chat notifications", err));
  }, [chatEnabled]);

  return {
    chatPushBusy,
    disableChatPush,
    disablePushNotifications,
    enableChatPush,
    enablePushNotifications,
    pushError,
    pushWorkState,
    reminderPayloadRef,
    setPushError,
  };
}
