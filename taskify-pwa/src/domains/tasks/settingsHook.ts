import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER,
  DEFAULT_FILE_SERVERS,
  DEFAULT_FILE_STORAGE_SERVER,
  findServerEntry,
  normalizeFileServerUrl,
  parseFileServers,
  serializeFileServers,
} from "../../lib/fileStorage";
import { LS_MINT_BACKUP_ENABLED } from "../../localStorageKeys";
import { detectPushPlatformFromNavigator, INFERRED_PUSH_PLATFORM } from "../push/pushUtils";
import { SCRIPTURE_MEMORY_FREQUENCIES, SCRIPTURE_MEMORY_SORTS } from "../scripture/scriptureUtils";
import type { ScriptureMemoryFrequency, ScriptureMemorySort } from "../scripture/scriptureTypes";
import { LS_SETTINGS } from "../storageKeys";
import { kvStorage } from "../../storage/kvStorage";
import { normalizeAccentPalette, normalizeAccentPaletteList } from "../../theme/palette";
import { CHAT_RETENTION_OPTIONS } from "./settingsTypes";
import type { ChatMessageRetention, FastingRemindersMode, PushPreferences, Settings, StartupView } from "./settingsTypes";
import type { Board, Weekday } from "./taskTypes";
import { withBoardOrder } from "./boardUtils";

type StateSetter<T> = (value: T | ((prev: T) => T)) => void;
export type SetSettingsFn = (s: Partial<Settings>) => void;

export type UseSettingsSyncOptions = {
  bibleBoardId: string;
  boards: Board[];
  setBoards: StateSetter<Board[]>;
};

export type UseSettingsSyncResult = {
  currentBoardId: string;
  scriptureMemoryBoard: Board | null;
  scriptureMemoryFrequencyOption: (typeof SCRIPTURE_MEMORY_FREQUENCIES)[number];
  scriptureMemorySortLabel: string;
  setCurrentBoardId: StateSetter<string>;
  setSettings: SetSettingsFn;
  settings: Settings;
};

const EMPTY_BOARDS: Board[] = [];

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  enabled: false,
  platform: INFERRED_PUSH_PLATFORM,
  permission: (typeof Notification !== "undefined" ? Notification.permission : "default") as NotificationPermission,
};

function defaultPublicFileServers(): string {
  return serializeFileServers(DEFAULT_FILE_SERVERS.filter((server) => server.type !== "originless") || DEFAULT_FILE_SERVERS);
}

function defaultEncryptedFileServers(): string {
  return serializeFileServers(DEFAULT_FILE_SERVERS.filter((server) => server.type === "originless"));
}

function pickStartupBoard(boards: Board[], overrides?: Partial<Record<Weekday, string>>): string {
  const visible = boards.filter((board) => !board.archived && !board.hidden);
  const today = new Date().getDay() as Weekday;
  const overrideId = overrides?.[today];
  if (overrideId) {
    const match =
      visible.find((board) => board.id === overrideId) ||
      boards.find((board) => !board.archived && board.id === overrideId);
    if (match) return match.id;
  }
  if (visible.length) return visible[0].id;
  const firstUnarchived = boards.find((board) => !board.archived);
  if (firstUnarchived) return firstUnarchived.id;
  return boards[0]?.id || "";
}

function normalizeStartupView(value: unknown): StartupView {
  return value === "wallet" || value === "upcoming" || value === "chat" ? value : "main";
}

export function useSettingsSync(): readonly [Settings, SetSettingsFn];
export function useSettingsSync(options: UseSettingsSyncOptions): UseSettingsSyncResult;
export function useSettingsSync(
  options?: UseSettingsSyncOptions,
): readonly [Settings, SetSettingsFn] | UseSettingsSyncResult {
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
      const backgroundImage = typeof parsed?.backgroundImage === "string" ? parsed.backgroundImage : null;
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
      const startupView = normalizeStartupView(parsed?.startupView);
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

      const validRetentionIds = new Set(CHAT_RETENTION_OPTIONS.map((o) => o.id));
      const rawRetention = typeof parsed?.chatMessageRetention === "string" ? parsed.chatMessageRetention : "";
      const chatMessageRetention: ChatMessageRetention = validRetentionIds.has(rawRetention as ChatMessageRetention)
        ? (rawRetention as ChatMessageRetention)
        : "forever";

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
        deviceId: typeof pushRaw?.deviceId === "string" ? pushRaw.deviceId : undefined,
        subscriptionId: typeof pushRaw?.subscriptionId === "string" ? pushRaw.subscriptionId : undefined,
        permission:
          pushRaw?.permission === "granted" || pushRaw?.permission === "denied"
            ? pushRaw.permission
            : DEFAULT_PUSH_PREFERENCES.permission,
      };
      const validScriptureFrequencyIds = new Set(SCRIPTURE_MEMORY_FREQUENCIES.map((opt) => opt.id));
      const rawScriptureFrequency = typeof parsed?.scriptureMemoryFrequency === "string"
        ? parsed.scriptureMemoryFrequency
        : "";
      const scriptureMemoryFrequency: ScriptureMemoryFrequency = validScriptureFrequencyIds.has(rawScriptureFrequency as ScriptureMemoryFrequency)
        ? (rawScriptureFrequency as ScriptureMemoryFrequency)
        : "daily";
      const validScriptureSortIds = new Set(SCRIPTURE_MEMORY_SORTS.map((opt) => opt.id));
      const rawScriptureSort = typeof parsed?.scriptureMemorySort === "string" ? parsed.scriptureMemorySort : "";
      const scriptureMemorySort: ScriptureMemorySort = validScriptureSortIds.has(rawScriptureSort as ScriptureMemorySort)
        ? (rawScriptureSort as ScriptureMemorySort)
        : "needsReview";
      const scriptureMemoryBoardId = typeof parsed?.scriptureMemoryBoardId === "string" && parsed.scriptureMemoryBoardId
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
        fileServers: typeof parsed?.fileServers === "string" && parsed.fileServers.trim()
          ? parsed.fileServers.trim()
          : defaultPublicFileServers(),
        encryptedFileServers: typeof parsed?.encryptedFileServers === "string" && parsed.encryptedFileServers.trim()
          ? parsed.encryptedFileServers.trim()
          : defaultEncryptedFileServers(),
        walletMintBackupEnabled,
        npubCashLightningAddressEnabled,
        npubCashAutoClaim: npubCashLightningAddressEnabled ? npubCashAutoClaim : false,
        cloudBackupsEnabled: parsed?.cloudBackupsEnabled === true,
        nostrBackupEnabled,
        nostrBackupMetadataEnabled,
        pushNotifications: { ...DEFAULT_PUSH_PREFERENCES, ...pushPreferences },
        chatMessageRetention,
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
        fileServers: defaultPublicFileServers(),
        encryptedFileServers: defaultEncryptedFileServers(),
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
        chatMessageRetention: "forever",
      };
    }
  });

  const setSettings = useCallback<SetSettingsFn>((s) => {
    setSettingsRaw((prev) => {
      const next = { ...prev, ...s };
      if (s.pushNotifications) {
        next.pushNotifications = { ...prev.pushNotifications, ...DEFAULT_PUSH_PREFERENCES, ...s.pushNotifications };
        const detectedPlatform = detectPushPlatformFromNavigator();
        next.pushNotifications.platform = next.pushNotifications.platform === "android"
          ? "android"
          : detectedPlatform;
      }
      if (Object.prototype.hasOwnProperty.call(s, "fileServers")) {
        const servers = parseFileServers(s.fileServers);
        const currentSelected = normalizeFileServerUrl(next.fileStorageServer) || DEFAULT_FILE_STORAGE_SERVER;
        const entry = findServerEntry(servers, currentSelected);
        if (!entry && servers.length > 0) {
          next.fileStorageServer = normalizeFileServerUrl(servers[0].url) || DEFAULT_FILE_STORAGE_SERVER;
        }
      }
      if (Object.prototype.hasOwnProperty.call(s, "fileStorageServer")) {
        const rawServer = s.fileStorageServer;
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
        const rawServer = s.encryptedFileStorageServer;
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
      if (Object.prototype.hasOwnProperty.call(s, "fileServers")) {
        const rawServers = s.fileServers;
        next.fileServers = typeof rawServers === "string" && rawServers.trim()
          ? rawServers.trim()
          : defaultPublicFileServers();
      } else if (!next.fileServers) {
        next.fileServers = defaultPublicFileServers();
      }
      if (Object.prototype.hasOwnProperty.call(s, "encryptedFileServers")) {
        const rawServers = s.encryptedFileServers;
        next.encryptedFileServers = typeof rawServers === "string" && rawServers.trim()
          ? rawServers.trim()
          : defaultEncryptedFileServers();
      } else if (!next.encryptedFileServers) {
        next.encryptedFileServers = defaultEncryptedFileServers();
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
      if (typeof next.scriptureMemoryBoardId !== "string" || !next.scriptureMemoryBoardId) {
        next.scriptureMemoryBoardId = next.scriptureMemoryBoardId ? String(next.scriptureMemoryBoardId) : null;
        if (next.scriptureMemoryBoardId === "") next.scriptureMemoryBoardId = null;
      }
      if (!SCRIPTURE_MEMORY_FREQUENCIES.some((opt) => opt.id === next.scriptureMemoryFrequency)) {
        next.scriptureMemoryFrequency = "daily";
      }
      if (!SCRIPTURE_MEMORY_SORTS.some((opt) => opt.id === next.scriptureMemorySort)) {
        next.scriptureMemorySort = "needsReview";
      }
      if (next.scriptureMemoryEnabled !== true) {
        next.scriptureMemoryEnabled = false;
      }
      if (typeof next.scriptureMemoryBoardId === "undefined") {
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

  const settingsFirstRun = useRef(true);
  useEffect(() => {
    if (settingsFirstRun.current) {
      settingsFirstRun.current = false;
      return;
    }
    kvStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }, [settings]);

  const boards = options?.boards ?? EMPTY_BOARDS;
  const setBoards = options?.setBoards;
  const bibleBoardId = options?.bibleBoardId ?? "bible-reading";
  const syncBoardSettings = Boolean(options);
  const [currentBoardId, setCurrentBoardId] = useState(() => pickStartupBoard(boards, settings.startBoardByDay));

  useEffect(() => {
    try {
      kvStorage.setItem(LS_MINT_BACKUP_ENABLED, settings.walletMintBackupEnabled ? "1" : "0");
    } catch {
      // ignore persistence issues
    }
  }, [settings.walletMintBackupEnabled]);

  useEffect(() => {
    if (!setBoards) return;
    setBoards((prev) => {
      const hasBible = prev.some((board) => board.id === bibleBoardId);
      if (settings.bibleTrackerEnabled) {
        if (hasBible) {
          return prev.map((board) => {
            if (board.id !== bibleBoardId) return board;
            return {
              id: bibleBoardId,
              name: "Bible",
              kind: "bible",
              archived: false,
              hidden: false,
              order: board.order,
            } as Board;
          });
        }
        const insertionIndex = prev.findIndex((board) => board.archived);
        const bibleBoard: Board = {
          id: bibleBoardId,
          name: "Bible",
          kind: "bible",
          archived: false,
          hidden: false,
          order: insertionIndex === -1 ? prev.length : insertionIndex,
        };
        if (insertionIndex === -1) {
          return withBoardOrder([...prev, bibleBoard]);
        }
        const next = [...prev];
        next.splice(insertionIndex, 0, bibleBoard);
        return withBoardOrder(next);
      }
      if (!hasBible) return prev;
      return withBoardOrder(prev.filter((board) => board.id !== bibleBoardId));
    });
  }, [bibleBoardId, setBoards, settings.bibleTrackerEnabled]);

  useEffect(() => {
    const detected = detectPushPlatformFromNavigator();
    if (settings.pushNotifications.platform !== detected) {
      setSettings({ pushNotifications: { ...settings.pushNotifications, platform: detected } });
    }
  }, [settings.pushNotifications, setSettings]);

  const scriptureMemoryFrequencyOption = useMemo(
    () => SCRIPTURE_MEMORY_FREQUENCIES.find((opt) => opt.id === settings.scriptureMemoryFrequency) || SCRIPTURE_MEMORY_FREQUENCIES[0],
    [settings.scriptureMemoryFrequency],
  );
  const scriptureMemorySortLabel = useMemo(
    () => SCRIPTURE_MEMORY_SORTS.find((opt) => opt.id === settings.scriptureMemorySort)?.label || SCRIPTURE_MEMORY_SORTS[0].label,
    [settings.scriptureMemorySort],
  );
  const scriptureMemoryBoard = useMemo(
    () => (settings.scriptureMemoryBoardId ? boards.find((board) => board.id === settings.scriptureMemoryBoardId) || null : null),
    [boards, settings.scriptureMemoryBoardId],
  );
  const availableMemoryBoards = useMemo(
    () => boards.filter((board) => !board.archived && board.kind !== "bible"),
    [boards],
  );

  useEffect(() => {
    if (!syncBoardSettings) return;
    if (!settings.bibleTrackerEnabled && currentBoardId === bibleBoardId) {
      const fallbackBoards = boards.filter((board) => board.id !== bibleBoardId);
      const next = pickStartupBoard(fallbackBoards, settings.startBoardByDay);
      if (next !== currentBoardId) setCurrentBoardId(next);
    }
  }, [bibleBoardId, boards, currentBoardId, settings.bibleTrackerEnabled, settings.startBoardByDay, syncBoardSettings]);

  useEffect(() => {
    if (!syncBoardSettings) return;
    if (!settings.scriptureMemoryEnabled) return;
    if (scriptureMemoryBoard) return;
    const fallbackId = availableMemoryBoards[0]?.id;
    if (fallbackId && fallbackId !== settings.scriptureMemoryBoardId) {
      setSettings({ scriptureMemoryBoardId: fallbackId });
    }
  }, [
    availableMemoryBoards,
    scriptureMemoryBoard,
    setSettings,
    settings.scriptureMemoryBoardId,
    settings.scriptureMemoryEnabled,
    syncBoardSettings,
  ]);

  useEffect(() => {
    if (!syncBoardSettings) return;
    const current = boards.find((board) => board.id === currentBoardId);
    if (current && !current.archived && !current.hidden) return;
    const next = pickStartupBoard(boards, settings.startBoardByDay);
    if (next !== currentBoardId) setCurrentBoardId(next);
  }, [boards, currentBoardId, settings.startBoardByDay, syncBoardSettings]);

  useEffect(() => {
    if (!syncBoardSettings) return;
    const overrides = settings.startBoardByDay;
    if (!overrides || Object.keys(overrides).length === 0) return;
    const visibleIds = new Set(boards.filter((board) => !board.archived && !board.hidden).map((board) => board.id));
    let changed = false;
    const next: Partial<Record<Weekday, string>> = {};
    for (const key of Object.keys(overrides)) {
      const dayNum = Number(key);
      const boardId = (overrides as Record<string, string | undefined>)[key];
      if (!Number.isInteger(dayNum) || dayNum < 0 || dayNum > 6) {
        changed = true;
        continue;
      }
      if (typeof boardId !== "string" || !boardId || !visibleIds.has(boardId)) {
        changed = true;
        continue;
      }
      next[dayNum as Weekday] = boardId;
    }
    if (changed) setSettings({ startBoardByDay: next });
  }, [boards, setSettings, settings.startBoardByDay, syncBoardSettings]);

  if (options) {
    return {
      currentBoardId,
      scriptureMemoryBoard,
      scriptureMemoryFrequencyOption,
      scriptureMemorySortLabel,
      setCurrentBoardId,
      setSettings,
      settings,
    };
  }

  return [settings, setSettings] as const;
}

export const useSettings = useSettingsSync;
