// @ts-nocheck
import React, { useState, useEffect, useCallback } from "react";
import type { Settings, ChatMessageRetention } from "../../domains/tasks/settingsTypes";
import { CHAT_RETENTION_OPTIONS } from "../../domains/tasks/settingsTypes";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR } from "../../storage/taskifyDb";
import { LS_DM_MESSAGE_CACHE } from "../../localStorageKeys";
import { pillButtonClass } from "./settingsConstants";

function getMessageCount(): number {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_DM_MESSAGE_CACHE);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

async function getStorageEstimateMb(): Promise<number | null> {
  try {
    if (!navigator?.storage?.estimate) return null;
    const { usage } = await navigator.storage.estimate();
    if (typeof usage !== "number") return null;
    return Math.round((usage / (1024 * 1024)) * 10) / 10;
  } catch {
    return null;
  }
}

export function ChatSection({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: (s: Partial<Settings>) => void;
}) {
  const [messageCount, setMessageCount] = useState<number>(() => getMessageCount());
  const [storageMb, setStorageMb] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearDone, setClearDone] = useState(false);

  useEffect(() => {
    getStorageEstimateMb().then(setStorageMb);
  }, []);

  const refreshCount = useCallback(() => {
    setMessageCount(getMessageCount());
    getStorageEstimateMb().then(setStorageMb);
  }, []);

  const handleClearHistory = useCallback(() => {
    if (!window.confirm("Delete all chat message history? This cannot be undone.")) return;
    setClearing(true);
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_DM_MESSAGE_CACHE, JSON.stringify([]));
      window.dispatchEvent(new CustomEvent("taskify:clear-chat-history"));
      setMessageCount(0);
      setClearDone(true);
      setTimeout(() => setClearDone(false), 3000);
    } finally {
      setClearing(false);
    }
    getStorageEstimateMb().then(setStorageMb);
  }, []);

  return (
    <section className="wallet-section space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium">Chat</div>
        <button
          className="ghost-button button-sm pressable ml-auto"
          onClick={refreshCount}
          title="Refresh counts"
        >
          Refresh
        </button>
      </div>

      {/* Retention */}
      <div className="space-y-1.5">
        <div className="text-xs text-secondary">Keep message history</div>
        <div className="flex flex-wrap gap-1.5">
          {CHAT_RETENTION_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={pillButtonClass(settings.chatMessageRetention === opt.id)}
              onClick={() => setSettings({ chatMessageRetention: opt.id })}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {settings.chatMessageRetention !== "forever" && (
          <div className="text-xs text-secondary">
            Messages older than this will be removed when the app loads.
          </div>
        )}
      </div>

      {/* Storage info */}
      <div className="space-y-2">
        <div className="text-xs text-secondary">
          {messageCount.toLocaleString()} message{messageCount !== 1 ? "s" : ""} stored
          {storageMb != null ? ` · ~${storageMb} MB total app storage` : ""}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="ghost-button button-sm pressable"
            onClick={handleClearHistory}
            disabled={clearing || messageCount === 0}
          >
            {clearing ? "Clearing…" : clearDone ? "Cleared" : "Clear all message history"}
          </button>
        </div>
        {clearDone && (
          <div className="text-xs text-emerald-400">Message history cleared.</div>
        )}
      </div>
    </section>
  );
}
