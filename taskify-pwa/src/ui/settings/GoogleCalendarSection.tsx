import React from "react";
import type { GcalCalendar, GcalConnectionStatus } from "../../hooks/useGoogleCalendar";

type Props = {
  connectionStatus: GcalConnectionStatus;
  calendars: GcalCalendar[];
  loading: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSync: () => void;
};

export function GoogleCalendarSection({
  connectionStatus,
  calendars,
  loading,
  onConnect,
  onDisconnect,
  onSync,
}: Props) {
  const safeCalendars = Array.isArray(calendars)
    ? calendars.filter((cal) => cal && typeof cal.id === "string" && typeof cal.name === "string")
    : [];

  const connected = Boolean(
    connectionStatus &&
      typeof connectionStatus === "object" &&
      (connectionStatus as { connected?: unknown }).connected === true,
  );
  const connectedStatus = connected
    ? (connectionStatus as Extract<GcalConnectionStatus, { connected: true }>)
    : null;
  const status = connectedStatus?.status ?? null;
  const needsReauth = status === "needs_reauth" || status === "token_expired";

  const formatLastSync = (ts: number | null) => {
    if (!ts) return "Never";
    const diff = Math.floor((Date.now() / 1000) - ts);
    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  return (
    <section className="wallet-section space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium">Connected Calendars</div>
      </div>

      {!connected ? (
        <div className="space-y-2">
          <p className="text-xs text-secondary">
            Connect Google Calendar to see your events alongside tasks in the Upcoming view.
          </p>
          <button
            type="button"
            className={pillButtonClass}
            onClick={onConnect}
            disabled={loading}
          >
            {loading ? "Connecting…" : "Connect Google Calendar"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Account info + status */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-secondary truncate max-w-[60%]">
                {connectedStatus?.googleEmail || "Google account"}
              </span>
              {needsReauth ? (
                <span className="text-xs text-red-400">Reconnect required</span>
              ) : status === "sync_failed" ? (
                <span className="text-xs text-yellow-400">Sync failed</span>
              ) : (
                <span className="text-xs text-secondary">
                  Synced {formatLastSync(connectedStatus?.lastSyncAt ?? null)}
                </span>
              )}
            </div>
            {connectedStatus?.lastError && (
              <div className="text-xs text-red-400 truncate">{connectedStatus.lastError}</div>
            )}
          </div>

          {safeCalendars.length > 0 && (
            <div className="text-xs text-secondary">
              {safeCalendars.length} calendar{safeCalendars.length === 1 ? "" : "s"} connected. Manage visibility from Upcoming filters.
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {needsReauth ? (
              <button
                type="button"
                className="ghost-button button-sm pressable"
                onClick={onConnect}
                disabled={loading}
              >
                Reconnect
              </button>
            ) : (
              <button
                type="button"
                className="ghost-button button-sm pressable"
                onClick={onSync}
                disabled={loading}
              >
                {loading ? "Syncing…" : "Sync now"}
              </button>
            )}
            <button
              type="button"
              className="ghost-button button-sm pressable text-rose-400"
              onClick={onDisconnect}
              disabled={loading}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
