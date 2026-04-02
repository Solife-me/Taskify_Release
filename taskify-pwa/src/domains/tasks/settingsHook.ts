import { useState, useEffect, useCallback, useRef } from "react";
import type { Settings } from "./settingsTypes";
import type { Weekday } from "./taskTypes";
import type { FastingRemindersMode } from "./settingsTypes";
import { kvStorage } from "../../storage/kvStorage";
import { LS_SETTINGS, LS_BACKGROUND_IMAGE } from "../storageKeys";
import { LS_MINT_BACKUP_ENABLED } from "../../localStorageKeys";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_TASKS } from "../../storage/taskifyDb";
import { normalizeAccentPalette, normalizeAccentPaletteList } from "../../theme/palette";
import { DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER, DEFAULT_FILE_STORAGE_SERVER, normalizeFileServerUrl } from "../../lib/fileStorage";
import { detectPushPlatformFromNavigator, INFERRED_PUSH_PLATFORM } from "../push/pushUtils";
import type { PushPreferences } from "../push/pushUtils";
import { SCRIPTURE_MEMORY_FREQUENCIES, SCRIPTURE_MEMORY_SORTS } from "../scripture/scriptureUtils";
import type { ScriptureMemoryFrequency, ScriptureMemorySort } from "../scripture/scriptureTypes";

const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  enabled: false,
  platform: INFERRED_PUSH_PLATFORM,
  permission: (typeof Notification !== 'undefined' ? Notification.permission : 'default') as NotificationPermission,
};

function useSettings() {
  const [settings, setSettingsRaw] = useState<Settings>(() => {
    try {
      const parsed = JSON.parse(kvStorage.getItem(LS_SETTINGS) || "{}");
      const baseFontSize =
        typeof parsed.baseFontSize === "number" ? parsed.baseFontSize : null;
      const startBoardByDay: Partial<Record<Weekday, string>> = {};
      if (parsed && typeof parsed.startBoardByDay === "object" && parsed.startBoardByDay) {
        for (const [key, value] of Object.entries(parsed.startBoardByDay as Record<string, unknown>)) {
          const day = Number(key);
          if (!Number.isInteger(day) || day < 0 || day > 6) continue;
          if (typeof value !== "string" || !value) continue;
          startBoardByDay[day as Weekday] = value;
        }
      }
      // Read backgroundImage from IndexedDB first, fall back to localStorage settings for migration
      const bgFromIdb = idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_BACKGROUND_IMAGE);
      const bgFromSettings = typeof parsed?.backgroundImage === "string" ? parsed.backgroundImage : null;
      const backgroundImage = bgFromIdb ?? bgFromSettings;
      // One-time migration: copy from localStorage to IndexedDB
      if (backgroundImage && !bgFromIdb) {
        idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BACKGROUND_IMAGE, backgroundImage);
      }
      let backgroundAccents = normalizeAccentPaletteList(parsed?.backgroundAccents) ?? null;
      let backgroundAccentIndex = typeof parsed?.backgroundAccentIndex === "number" ? parsed.backgroundAccentIndex : null;
      let backgroundAccent = normalizeAccentPalette(parsed?.backgroundAccent) ?? null;
      if (!backgroundAccents || backgroundAccents.length === 0) {
        backgroundAccents = null;
        backgroundAccentIndex = null;
      } else {
        if (backgroundAccentIndex == null || backgroundAccentIndex < 0 || backgroundAccentIndex >= backgroundAccents.length) {
          backgroundAccentIndex = 0;
        }
        if (!backgroundAccent) backgroundAccent = backgroundAccents[backgroundAccentIndex];
      }
      if (!backgroundImage) {
        backgroundAccents = null;
        backgroundAccentIndex = null;
        backgroundAccent = null;
      }
      const backgroundBlur = parsed?.backgroundBlur === "blurred" ? "blurred" : "sharp";
      let accent: Settings["accent"] = "blue";
      if (parsed?.accent === "green") accent = "green";
      else if (parsed?.accent === "background" && backgroundImage && backgroundAccent) accent = "background";
      const hideCompletedSubtasks = parsed?.hideCompletedSubtasks === true;
      const startupView = parsed?.startupView === "wallet" ? "wallet" : "main";
      const walletConversionEnabled = parsed?.walletConversionEnabled !== false;
      const walletPrimaryCurrency = parsed?.walletPrimaryCurrency === "usd" ? "usd" : "sat";
      const walletSentStateChecksEnabled = parsed?.walletSentStateChecksEnabled !== false;
      const walletPaymentRequestsEnabled = parsed?.walletPaymentRequestsEnabled !== false;
      const walletPaymentRequestsBackgroundChecksEnabled =
        parsed?.walletPaymentRequestsBackgroundChecksEnabled !== false;
      let walletMintBackupEnabled = parsed?.walletMintBackupEnabled !== false;
      if (parsed?.walletMintBackupEnabled == null) {
        try {
          walletMintBackupEnabled = kvStorage.getItem(LS_MINT_BACKUP_ENABLED) !== "0";
        } catch {
          walletMintBackupEnabled = true;
        }
      }
      const walletContactsSyncEnabled = parsed?.walletContactsSyncEnabled !== false;
      const npubCashLightningAddressEnabled = parsed?.npubCashLightningAddressEnabled !== false;
      const npubCashAutoClaim = npubCashLightningAddressEnabled && parsed?.npubCashAutoClaim !== false;
      const fileStorageServer =
        normalizeFileServerUrl(
          typeof parsed?.fileStorageServer === "string" && parsed.fileStorageServer.trim()
            ? parsed.fileStorageServer.trim()
            : DEFAULT_FILE_STORAGE_SERVER,
        ) || DEFAULT_FILE_STORAGE_SERVER;
      const encryptedFileStorageServer =
        normalizeFileServerUrl(
          typeof parsed?.encryptedFileStorageServer === "string" && parsed.encryptedFileStorageServer.trim()
            ? parsed.encryptedFileStorageServer.trim()
            : DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER,
        ) || DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER;
      const nostrBackupEnabled = parsed?.nostrBackupEnabled !== false;
      const nostrBackupMetadataEnabled = nostrBackupEnabled;

      const pushRaw = parsed?.pushNotifications;
      const inferredPlatform = detectPushPlatformFromNavigator();
      const storedPlatform = pushRaw?.platform === "android"
        ? "android"
        : pushRaw?.platform === "ios"
          ? "ios"
          : inferredPlatform;
      const pushPreferences: PushPreferences = {
        enabled: pushRaw?.enabled === true,
        platform: storedPlatform,
        deviceId: typeof pushRaw?.deviceId === 'string' ? pushRaw.deviceId : undefined,
        subscriptionId: typeof pushRaw?.subscriptionId === 'string' ? pushRaw.subscriptionId : undefined,
        permission:
          pushRaw?.permission === 'granted' || pushRaw?.permission === 'denied'
            ? pushRaw.permission
            : DEFAULT_PUSH_PREFERENCES.permission,
      };
      const validScriptureFrequencyIds = new Set(SCRIPTURE_MEMORY_FREQUENCIES.map(opt => opt.id));
      const rawScriptureFrequency = typeof parsed?.scriptureMemoryFrequency === 'string'
        ? parsed.scriptureMemoryFrequency
        : '';
      const scriptureMemoryFrequency: ScriptureMemoryFrequency = validScriptureFrequencyIds.has(rawScriptureFrequency as ScriptureMemoryFrequency)
        ? (rawScriptureFrequency as ScriptureMemoryFrequency)
        : 'daily';
      const validScriptureSortIds = new Set(SCRIPTURE_MEMORY_SORTS.map(opt => opt.id));
      const rawScriptureSort = typeof parsed?.scriptureMemorySort === 'string' ? parsed.scriptureMemorySort : '';
      const scriptureMemorySort: ScriptureMemorySort = validScriptureSortIds.has(rawScriptureSort as ScriptureMemorySort)
        ? (rawScriptureSort as ScriptureMemorySort)
        : 'needsReview';
      const scriptureMemoryBoardId = typeof parsed?.scriptureMemoryBoardId === 'string' && parsed.scriptureMemoryBoardId
        ? parsed.scriptureMemoryBoardId
        : null;
      const scriptureMemoryEnabled = parsed?.scriptureMemoryEnabled === true;
      const fastingRemindersEnabled = parsed?.fastingRemindersEnabled === true;
      const fastingRemindersMode: FastingRemindersMode = parsed?.fastingRemindersMode === "random" ? "random" : "weekday";
      const fastingRemindersPerMonthRaw = Number(parsed?.fastingRemindersPerMonth);
      const fastingRemindersPerMonthMax = fastingRemindersMode === "random" ? 31 : 5;
      const fastingRemindersPerMonth =
        Number.isFinite(fastingRemindersPerMonthRaw) && fastingRemindersPerMonthRaw > 0
          ? Math.min(fastingRemindersPerMonthMax, Math.max(1, Math.round(fastingRemindersPerMonthRaw)))
          : 4;
      const fastingRemindersWeekdayRaw = Number(parsed?.fastingRemindersWeekday);
      const fastingRemindersWeekday: Weekday =
        Number.isInteger(fastingRemindersWeekdayRaw) && fastingRemindersWeekdayRaw >= 0 && fastingRemindersWeekdayRaw <= 6
          ? (fastingRemindersWeekdayRaw as Weekday)
          : 1;
      const fastingRemindersRandomSeed =
        typeof parsed?.fastingRemindersRandomSeed === "string" && parsed.fastingRemindersRandomSeed.trim()
          ? parsed.fastingRemindersRandomSeed.trim()
          : crypto.randomUUID();
      if (parsed && typeof parsed === "object") {
        delete (parsed as Record<string, unknown>).theme;
        delete (parsed as Record<string, unknown>).backgroundAccents;
        delete (parsed as Record<string, unknown>).backgroundAccentIndex;
        delete (parsed as Record<string, unknown>).walletPaymentRequestsAutoClaim;
        delete (parsed as Record<string, unknown>).walletBountiesEnabled;
        delete (parsed as Record<string, unknown>).walletBountyList;
      }
      return {
        weekStart: 0,
        newTaskPosition: "top",
        streaksEnabled: true,
        completedTab: true,
        showFullWeekRecurring: false,
        ...parsed,
        bibleTrackerEnabled: parsed?.bibleTrackerEnabled === true,
        scriptureMemoryEnabled,
        scriptureMemoryBoardId,
        scriptureMemoryFrequency,
        scriptureMemorySort,
        fastingRemindersEnabled,
        fastingRemindersMode,
        fastingRemindersPerMonth,
        fastingRemindersWeekday,
        fastingRemindersRandomSeed,
        hideCompletedSubtasks,
        baseFontSize,
        startBoardByDay,
        accent,
        backgroundImage,
        backgroundAccent,
        backgroundAccents,
        backgroundAccentIndex,
        backgroundBlur,
        startupView,
        walletConversionEnabled,
        walletPrimaryCurrency: walletConversionEnabled ? walletPrimaryCurrency : "sat",
        walletSentStateChecksEnabled,
        walletPaymentRequestsEnabled,
        walletPaymentRequestsBackgroundChecksEnabled: walletPaymentRequestsEnabled
          ? walletPaymentRequestsBackgroundChecksEnabled
          : false,
        walletContactsSyncEnabled,
        fileStorageServer,
        encryptedFileStorageServer,
        walletMintBackupEnabled,
        npubCashLightningAddressEnabled,
        npubCashAutoClaim: npubCashLightningAddressEnabled ? npubCashAutoClaim : false,
        cloudBackupsEnabled: parsed?.cloudBackupsEnabled === true,
        nostrBackupEnabled,
        nostrBackupMetadataEnabled,
        pushNotifications: { ...DEFAULT_PUSH_PREFERENCES, ...pushPreferences },

      };
    } catch {
      return {
        weekStart: 0,
        newTaskPosition: "top",
        streaksEnabled: true,
        completedTab: true,
        bibleTrackerEnabled: false,
        showFullWeekRecurring: false,
        baseFontSize: null,
        startBoardByDay: {},
        accent: "blue",
        backgroundImage: null,
        backgroundAccent: null,
        backgroundAccents: null,
        backgroundAccentIndex: null,
        backgroundBlur: "sharp",
        hideCompletedSubtasks: false,
        startupView: "main",
        walletConversionEnabled: true,
        walletPrimaryCurrency: "sat",
        walletMintBackupEnabled: true,
        walletSentStateChecksEnabled: true,
        walletPaymentRequestsEnabled: true,
        walletPaymentRequestsBackgroundChecksEnabled: true,
        walletContactsSyncEnabled: true,
        fileStorageServer: DEFAULT_FILE_STORAGE_SERVER,
        encryptedFileStorageServer: DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER,
        npubCashLightningAddressEnabled: true,
        npubCashAutoClaim: true,
        cloudBackupsEnabled: false,
        nostrBackupEnabled: true,
        nostrBackupMetadataEnabled: true,

        scriptureMemoryEnabled: false,
        scriptureMemoryBoardId: null,
        scriptureMemoryFrequency: "daily",
        scriptureMemorySort: "needsReview",
        fastingRemindersEnabled: false,
        fastingRemindersMode: "weekday",
        fastingRemindersPerMonth: 4,
        fastingRemindersWeekday: 1,
        fastingRemindersRandomSeed: crypto.randomUUID(),
        pushNotifications: { ...DEFAULT_PUSH_PREFERENCES },
      };
    }
  });
  const setSettings = useCallback((s: Partial<Settings>) => {
    setSettingsRaw(prev => {
      const next = { ...prev, ...s };
      if (s.pushNotifications) {
        next.pushNotifications = { ...prev.pushNotifications, ...DEFAULT_PUSH_PREFERENCES, ...s.pushNotifications };
        const detectedPlatform = detectPushPlatformFromNavigator();
        next.pushNotifications.platform = next.pushNotifications.platform === 'android'
          ? 'android'
          : detectedPlatform;
      }
      if (Object.prototype.hasOwnProperty.call(s, "fileStorageServer")) {
        const rawServer = (s as any).fileStorageServer;
        const normalizedServer =
          typeof rawServer === "string" && rawServer.trim()
            ? normalizeFileServerUrl(rawServer) || DEFAULT_FILE_STORAGE_SERVER
            : DEFAULT_FILE_STORAGE_SERVER;
        next.fileStorageServer = normalizedServer;
      } else if (!next.fileStorageServer) {
        next.fileStorageServer = DEFAULT_FILE_STORAGE_SERVER;
      } else {
        next.fileStorageServer =
          normalizeFileServerUrl(next.fileStorageServer) || DEFAULT_FILE_STORAGE_SERVER;
      }
      if (Object.prototype.hasOwnProperty.call(s, "encryptedFileStorageServer")) {
        const rawServer = (s as any).encryptedFileStorageServer;
        const normalizedServer =
          typeof rawServer === "string" && rawServer.trim()
            ? normalizeFileServerUrl(rawServer) || DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER
            : DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER;
        next.encryptedFileStorageServer = normalizedServer;
      } else if (!next.encryptedFileStorageServer) {
        next.encryptedFileStorageServer = DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER;
      } else {
        next.encryptedFileStorageServer =
          normalizeFileServerUrl(next.encryptedFileStorageServer) || DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER;
      }
      if (!next.backgroundImage) {
        next.backgroundImage = null;
        next.backgroundAccent = null;
        next.backgroundAccents = null;
        next.backgroundAccentIndex = null;
      } else {
        next.backgroundAccent = normalizeAccentPalette(next.backgroundAccent) ?? next.backgroundAccent ?? null;
        const normalizedList = normalizeAccentPaletteList(next.backgroundAccents);
        next.backgroundAccents = normalizedList && normalizedList.length ? normalizedList : null;
        if (next.backgroundAccents?.length) {
          if (typeof next.backgroundAccentIndex !== "number" || next.backgroundAccentIndex < 0 || next.backgroundAccentIndex >= next.backgroundAccents.length) {
            next.backgroundAccentIndex = 0;
          }
          next.backgroundAccent = next.backgroundAccents[next.backgroundAccentIndex];
        } else {
          next.backgroundAccents = null;
          next.backgroundAccentIndex = null;
          if (next.backgroundAccent) {
            next.backgroundAccents = [next.backgroundAccent];
            next.backgroundAccentIndex = 0;
          }
        }
      }
      if (!next.walletPaymentRequestsEnabled) {
        next.walletPaymentRequestsBackgroundChecksEnabled = false;
      }
      next.walletContactsSyncEnabled = next.walletContactsSyncEnabled !== false;
      if (next.backgroundBlur !== "sharp" && next.backgroundBlur !== "blurred") {
        next.backgroundBlur = "sharp";
      }
      if (next.accent === "background" && (!next.backgroundImage || !next.backgroundAccent)) {
        next.accent = "blue";
      }
      if (!next.walletConversionEnabled) {
        next.walletPrimaryCurrency = "sat";
      } else if (next.walletPrimaryCurrency !== "usd") {
        next.walletPrimaryCurrency = "sat";
      }
      if (!next.npubCashLightningAddressEnabled) {
        next.npubCashLightningAddressEnabled = false;
        next.npubCashAutoClaim = false;
      } else if (next.npubCashAutoClaim !== true && next.npubCashAutoClaim !== false) {
        next.npubCashAutoClaim = true;
      }
      if (next.cloudBackupsEnabled !== true) {
        next.cloudBackupsEnabled = false;
      }
      next.nostrBackupEnabled = next.nostrBackupEnabled !== false;
      next.nostrBackupMetadataEnabled = next.nostrBackupEnabled;

      if (!next.bibleTrackerEnabled) {
        next.bibleTrackerEnabled = false;
        next.scriptureMemoryEnabled = false;
        next.scriptureMemoryBoardId = null;
      }
      if (typeof next.scriptureMemoryBoardId !== 'string' || !next.scriptureMemoryBoardId) {
        next.scriptureMemoryBoardId = next.scriptureMemoryBoardId ? String(next.scriptureMemoryBoardId) : null;
        if (next.scriptureMemoryBoardId === '') next.scriptureMemoryBoardId = null;
      }
      if (!SCRIPTURE_MEMORY_FREQUENCIES.some(opt => opt.id === next.scriptureMemoryFrequency)) {
        next.scriptureMemoryFrequency = 'daily';
      }
      if (!SCRIPTURE_MEMORY_SORTS.some(opt => opt.id === next.scriptureMemorySort)) {
        next.scriptureMemorySort = 'needsReview';
      }
      if (next.scriptureMemoryEnabled !== true) {
        next.scriptureMemoryEnabled = false;
      }
      if (typeof next.scriptureMemoryBoardId === 'undefined') {
        next.scriptureMemoryBoardId = null;
      }
      if (next.fastingRemindersEnabled !== true) {
        next.fastingRemindersEnabled = false;
      }
      next.fastingRemindersMode = next.fastingRemindersMode === "random" ? "random" : "weekday";
      const fastingPerMonthRaw = Number(next.fastingRemindersPerMonth);
      const fastingPerMonthMax = next.fastingRemindersMode === "random" ? 31 : 5;
      if (!Number.isFinite(fastingPerMonthRaw) || fastingPerMonthRaw <= 0) {
        next.fastingRemindersPerMonth = 4;
      } else {
        next.fastingRemindersPerMonth = Math.min(
          fastingPerMonthMax,
          Math.max(1, Math.round(fastingPerMonthRaw)),
        );
      }
      const fastingWeekdayRaw = Number(next.fastingRemindersWeekday);
      next.fastingRemindersWeekday =
        Number.isInteger(fastingWeekdayRaw) && fastingWeekdayRaw >= 0 && fastingWeekdayRaw <= 6
          ? (fastingWeekdayRaw as Weekday)
          : 1;
      if (typeof next.fastingRemindersRandomSeed !== "string" || !next.fastingRemindersRandomSeed.trim()) {
        next.fastingRemindersRandomSeed = crypto.randomUUID();
      } else {
        next.fastingRemindersRandomSeed = next.fastingRemindersRandomSeed.trim();
      }
      return next;
    });
  }, []);
  // Keep a ref to latest settings for the flush-on-unmount cleanup
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Debounced settings persistence — strips backgroundImage (stored separately in IndexedDB)
  useEffect(() => {
    const timer = setTimeout(() => {
      const { backgroundImage: _bg, ...rest } = settingsRef.current;
      kvStorage.setItem(LS_SETTINGS, JSON.stringify(rest));
    }, 500);
    return () => clearTimeout(timer);
  }, [settings]);

  // Flush settings to localStorage on unmount to prevent data loss
  useEffect(() => {
    return () => {
      const { backgroundImage: _bg, ...rest } = settingsRef.current;
      kvStorage.setItem(LS_SETTINGS, JSON.stringify(rest));
    };
  }, []);

  // Persist backgroundImage to IndexedDB separately (only when it changes)
  const prevBgRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Skip the initial render — migration is handled in the useState initializer
    if (prevBgRef.current === undefined) {
      prevBgRef.current = settings.backgroundImage;
      return;
    }
    if (settings.backgroundImage === prevBgRef.current) return;
    prevBgRef.current = settings.backgroundImage;
    if (settings.backgroundImage) {
      idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BACKGROUND_IMAGE, settings.backgroundImage);
    } else {
      idbKeyValue.removeItem(TASKIFY_STORE_TASKS, LS_BACKGROUND_IMAGE);
    }
  }, [settings.backgroundImage]);

  return [settings, setSettings] as const;
}

export { useSettings, DEFAULT_PUSH_PREFERENCES };
