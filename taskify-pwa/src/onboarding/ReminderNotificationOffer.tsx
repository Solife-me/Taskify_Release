import { useCallback, useState } from "react";
import type { PushPlatform } from "../domains/push/pushUtils";
import { kvStorage } from "../storage/kvStorage";
import { LS_REMINDER_NOTIFICATIONS_OFFER, shouldOfferReminderNotifications } from "./firstRunRules";

function browserCanPush(): boolean {
  return typeof window !== "undefined"
    && window.isSecureContext
    && "Notification" in window
    && Notification.permission !== "denied"
    && "serviceWorker" in navigator
    && "PushManager" in window;
}

function offerDeclined(): boolean {
  try {
    return kvStorage.getItem(LS_REMINDER_NOTIFICATIONS_OFFER) === "declined";
  } catch {
    return false;
  }
}

type OfferState = { busy: boolean; error: string | null };

/**
 * Offers push notifications at the moment they matter: when an item first gets a reminder and
 * notifications are off. Call `noteReminderSave` after saving a task or event.
 */
export function useReminderNotificationOffer(params: {
  pushEnabled: boolean;
  pushConfigured: boolean;
  pushPlatform: PushPlatform;
  enablePush: (platform: PushPlatform) => Promise<void>;
}) {
  const { pushEnabled, pushConfigured, pushPlatform, enablePush } = params;
  const [offer, setOffer] = useState<OfferState | null>(null);

  const noteReminderSave = useCallback((hadReminders: boolean, hasReminders: boolean) => {
    const show = shouldOfferReminderNotifications({
      hadReminders,
      hasReminders,
      pushEnabled,
      pushAvailable: pushConfigured && browserCanPush(),
      declined: offerDeclined(),
    });
    if (show) setOffer((current) => current ?? { busy: false, error: null });
  }, [pushConfigured, pushEnabled]);

  const accept = useCallback(async () => {
    setOffer({ busy: true, error: null });
    try {
      await enablePush(pushPlatform);
      setOffer(null);
    } catch (err) {
      setOffer({ busy: false, error: err instanceof Error ? err.message : "Unable to turn on notifications." });
    }
  }, [enablePush, pushPlatform]);

  const decline = useCallback(() => {
    try {
      kvStorage.setItem(LS_REMINDER_NOTIFICATIONS_OFFER, "declined");
    } catch {}
    setOffer(null);
  }, []);

  return { noteReminderSave, offer: offer ? { ...offer, accept, decline } : null };
}

export function ReminderNotificationOffer({
  offer,
}: {
  offer: (OfferState & { accept: () => Promise<void>; decline: () => void }) | null;
}) {
  if (!offer) return null;
  return (
    <div className="sk-backup-banner" role="status">
      <div className="sk-backup-banner__body">
        <span className="sk-backup-banner__dot" aria-hidden="true" />
        <span>
          Get a notification when this reminder is due? Taskify only notifies you about reminders you set.
          {offer.error && <> {offer.error}</>}
        </span>
      </div>
      <div className="sk-backup-banner__actions">
        <button
          type="button"
          className="sk-backup-banner__primary pressable"
          onClick={() => void offer.accept()}
          disabled={offer.busy}
        >
          {offer.busy ? "Turning on…" : "Turn on"}
        </button>
        <button type="button" className="sk-backup-banner__secondary pressable" onClick={offer.decline} disabled={offer.busy}>
          Not now
        </button>
      </div>
    </div>
  );
}
