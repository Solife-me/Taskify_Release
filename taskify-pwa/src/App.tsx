import { prepareRelayEvent } from "./nostr/prepareRelayEvent";
import { SharedTaskDestinationSheet, type SharedTaskDestination } from "./components/SharedTaskDestinationSheet";
import { useReminderSync } from "./domains/push/useReminderSync";
import { loadBoardPrintJob, persistBoardPrintJob } from "./storage/boardPrintJobs";
import { useAppRouter } from "./routing/appRouter";
import { routeForPage, type ActivePage, type AppOverlayRoute, type AppSheetRoute } from "./routing/appRoute";
import { useOverlayHistory, useRouteOverlayOpener } from "./routing/useOverlayHistory";
import { useNotificationTaps } from "./routing/useNotificationTaps";
import { compareDefault, sortBoardTasks as sortTasksForBoard, taskCreatedAt } from "./domains/tasks/taskSort";
import {
  boardUpcomingEvents,
  boardUpcomingTasks,
  groupUpcomingByDay,
  selectUpcomingEvents,
  selectUpcomingTasks,
  upcomingBoardOrder,
  upcomingDayGroups,
  type UpcomingSortOptions,
} from "./domains/upcoming/upcomingModel";
import React, { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";


import { type EventTemplate, nip04, nip19 } from "nostr-tools";
import {
  BIBLE_BOARD_ID,
  FASTING_REMINDER_SERIES_ID,
  isAssignedSharedTask,
  DEFAULT_DATE_REMINDER_TIME,
  ISO_DATE_PATTERN,
  normalizeTaskRecurrence,
  compressedToRawHex,
  isExternalCalendarEvent,
  isListLikeBoard,
  normalizeReminderTime,
  reminderPresetIdForMode,
  sanitizeReminderList,
  type Board,
  type CalendarEvent,
  type CalendarEventBase,
  type CalendarEventParticipant,
  type EditingState,
  type InboxItem,
  type InboxSender,
  type ListColumn,
  type Recurrence,
  type Subtask,
  type Task,
  type TaskAssignee,
  type TaskAssigneeStatus,
  type Weekday,
} from "taskify-core";
import {
  type BibleTrackerProgress,
  type BibleTrackerState,
  cloneBibleProgress,
  cloneBibleVerses,
  cloneBibleVerseCounts,
  cloneBibleCompletedBooks,
  getBibleBookChapterCount,
  getBibleBookTitle,
  getBibleBookOrder,
  MAX_VERSE_COUNT,
} from "./components/BibleTracker";
import { type BiblePrintMeta } from "./components/BibleTrackerPrintSheet";
import { type BoardPrintJob, type BoardPrintTask } from "./components/BoardPrintLayout";
import { type PrintPaperSize } from "./components/printPaper";
import { type AddScripturePayload, type ScriptureMemoryListItem } from "./components/ScriptureMemoryCard";
import { getBibleChapterVerseCount } from "./data/bibleVerseCounts";
import { useCashu } from "./context/walletContexts";
import { useWalletEnabled } from "./wallet/walletAvailability";
import { WalletPhaseOutNotice } from "./ui/wallet/WalletPhaseOutNotice";
import { idbKeyValue } from "./storage/idbKeyValue";
import { TASKIFY_STORE_TASKS, TASKIFY_STORE_NOSTR } from "./storage/taskifyDb";

import { encryptToBoard, decryptFromBoard, boardTag } from "./boardCrypto";
import { useToast } from "./context/ToastContext";
import { useAppAppearance } from "./theme/useAppAppearance";
import {
  ensureDocumentPreview,
  normalizeDocumentList,
  type TaskDocument,
} from "./lib/documents";
import { normalizeNostrPubkey } from "./lib/nostr";
import type {
  ScriptureMemoryEntry,
  ScriptureMemoryState,
} from "./domains/scripture/scriptureTypes";
import {
  updateScriptureMemoryState,
  markScriptureEntryReviewed,
  scheduleScriptureEntry,
  formatScriptureReference,
  formatDueInLabel,
  computeScriptureStats,
} from "./domains/scripture/scriptureUtils";
import {
  useBibleTracker,
  useScriptureMemory,
} from "./domains/scripture/scriptureHook";
import {
  fastingReminderTargetBoard,
} from "./domains/calendar/holidayUtils";
import {
  PINNED_BOUNTY_LIST_KEY,
  normalizeTaskPriority,
  normalizeTaskCreatedAt,
  taskHasBountyList,
  withTaskAddedToBountyList,
  withTaskRemovedFromBountyList,
  isRecoverableBountyTask,
  normalizeBounty,
  normalizeTaskBounty,
  ensureXOnlyHex,
  pubkeysEqual,
  recurringInstanceId,
  dedupeRecurringInstances,
} from "./domains/tasks/taskUtils";
import {
  mergeTaskAssigneeResponse,
  normalizeAgentPubkey,
  normalizeNostrPubkeyHex,
  normalizeTaskAssignees,
} from "./domains/tasks/assignmentUtils";
import { calendarEventsStore, recurringCutoffsStore, tasksStore, useBoards, useCalendarEvents, useTasks } from "./state/appStores";
import {
  planCalendarRecurrenceWindow,
} from "./domains/calendar/calendarRecurrenceWindow";
import {
  buildCalendarRsvpEventTemplate,
  findReusableAcceptedInvite,
  planAddAcceptedInviteToCalendar,
  planApplyPublishedCalendarRsvp,
  planCalendarRsvpPublication,
  planDeleteCalendarEvent,
  planMoveCalendarEvents,
  planSaveCalendarEvent,
  selectAcceptedInviteDestination,
  type ResolvedCalendarInviteView,
} from "./domains/calendar/calendarCommands";
import { planFastingReminders, planScriptureReviewTask } from "./domains/tasks/generatedTasks";
import {
  planAssignmentResponse,
  planClearCompleted,
  planCompleteTask,
  planDeleteTask,
  planMoveTask,
  planMoveTaskToBoard,
  planMoveTasksToColumn,
  planPostponeTask,
  planRestoreTask,
  planSaveTask,
  planToggleSubtask,
  planUpdateTaskNote,
} from "./domains/tasks/taskCommands";
import {
  TaskPublishVersionTracker,
} from "./domains/tasks/taskMovePersistence";
import {
  applyRecurringSeriesCutoffs,
  updateRecurringSeriesCutoff,
} from "./domains/tasks/recurrenceCutoffs";
import {
  CALENDAR_SERIES_CUTOFFS_KEY,
  applyCalendarSeriesCutoff,
  applyCalendarSeriesCutoffs,
  parseCalendarSeriesCutoffs,
  serializeCalendarSeriesCutoffs,
  updateCalendarSeriesCutoff,
} from "./domains/calendar/recurrenceCutoffs";
import {
  useCalendarInvites,
  type CalendarInvite,
  type CalendarInviteStatus,
} from "./domains/calendar/calendarInvitesHook";
import type {
  CompleteTaskFn,
  CompleteTaskResult,
  PublishCalendarEventFn,
  PublishTaskFn,
} from "./domains/tasks/taskTypes";
import {
  formatDateKeyLocal,
  formatTimeLabel,
  isoDatePart,
  isoFromDateTime,
  isoTimePart,
  normalizeTimeZone,
  parseDateKey,
  parseTimeValue,
  resolveSystemTimeZone,
  startOfDay,
  taskDateKey,
  taskWeekday,
  weekdayFromISO,
} from "./domains/dateTime/dateUtils";
import {
  decryptEcashTokenForFunder,
  decryptEcashTokenForRecipient,
  encryptEcashTokenForRecipient,
  hexToBytes,
} from "./domains/nostr/nostrCrypto";
import {
  deriveBoardNostrKeys,
  type BoardNostrKeyPair,
} from "./domains/nostr/nostrKeyUtils";
import {
  appendWalletHistoryEntry,
} from "./domains/backup/backupUtils";
import { useSettingsSync } from "./domains/tasks/settingsHook";
import {
  withBoardOrder,
  nextOccurrence,
  boardScopeIds,
  isVisibleNow,
  applyHiddenForCalendarEvent,
  nextOrderForCalendarBoard,
  nextOrderForBoard,
  isFrequentRecurrence,
  applyHiddenForFuture,
  findBoardByCompoundChildId,
} from "./domains/tasks/boardUtils";
import {
  isCalendarEventVisibleOnListBoard,
  startOfWeek,
} from "./domains/calendar/calendarUtils";
import { ShareBoardIcon } from "./ui/icons";
import {
  ensureWeekRecurrencesForCurrentWeek,
  buildRunningStreakLookup,
  isoForWeekdayLocal,
  tasksInSameSeries,
} from "taskify-core";
import {
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
  calendarAddress,
  parseCalendarAddress,
  encryptCalendarPayloadForBoard,
  decryptCalendarPayloadForBoard,
  encryptCalendarPayloadWithEventKey,
  decryptCalendarPayloadWithEventKey,
  encryptCalendarRsvpPayload,
  deriveBoardRsvpToken,
  parseCalendarCanonicalPayload,
  parseCalendarViewPayload,
  type CalendarRsvpFb,
  type CalendarRsvpStatus,
} from "./lib/privateCalendar";
import { DEFAULT_NOSTR_RELAYS, relaysOrDefaults, boardSyncRelays } from "./lib/relays";
import type { FinalTask } from "./nostr/useVoiceSession";
import type { Contact } from "./lib/contacts";
import {
  contactPrimaryName,
  formatContactNpub,
  loadContactsFromStorage,
  makeContactId,
  normalizeContact,
  saveContactsToStorage,
} from "./lib/contacts";

import { parseFileServers, findServerEntry } from "./lib/fileStorage";
import { encryptAndUploadAttachment, parseDataUrl, decryptAttachment } from "./lib/attachmentCrypto";
import { SessionPool } from "./nostr/SessionPool";
import { NostrSession } from "./nostr/NostrSession";
import {
  loadDefaultRelays,
  saveDefaultRelays,
  type NostrEvent,
} from "./domains/nostr/nostrPool";
import { useBoardSync, type BoardSyncRelayBatchEntry } from "./nostr/useBoardSync";
import { useCalendarEventManagement } from "./nostr/useCalendarEventManagement";
import { useNostrSubscriptions, type CalendarViewSubscriptionTarget, type SubscribeManyPool } from "./nostr/useNostrSubscriptions";
import { useDragAndDrop } from "./ui/dnd/useDragAndDrop";
import { useSelectionMode } from "./ui/selection/useSelectionMode";
import { useBoardViewScrollState } from "./ui/board/useBoardViewScrollState";
import { useShareBoardState } from "./ui/board/useShareBoardState";
import { CashuWalletShell, loadCashuWalletModal } from "./ui/wallet/CashuWalletShell";
import { useNostrChatStateSync } from "./nostr/useNostrChatStateSync";
import { PublishFingerprints } from "./domains/nostr/publishFingerprints";
import {
  applyInboxResponsesToCalendarInvites,
  applyInboxResponsesToTasks,
  collectCalendarInviteResponses,
  collectInboxResponses,
  pendingCalendarInviteEventIds,
  pendingInboxEventIds,
} from "./domains/inbox/inboxResponseSync";
import type { ChatInboxResponse } from "taskify-core";
import { useMessagesBoardId, useWalletMessages } from "./ui/wallet/useWalletMessages";
import { useWalletShellState } from "./ui/wallet/useWalletShellState";
import { useBoardSort } from "./ui/board/useBoardSort";
import { WD_SHORT } from "./domains/appTypes";
import { BoardSortSheet } from "./ui/board/BoardSortSheet";
import { RailBoardList } from "./ui/layout/RailBoardList";
import { BoardPage } from "./ui/board/BoardPage";
import { TaskActionsProvider, type TaskActions, type TaskView } from "./ui/task/taskActions";
import { useUpcomingPreferences } from "./domains/upcoming/upcomingPreferences";
import { UpdateToast } from "./ui/app/UpdateToast";
import { SelectionOverlays } from "./ui/selection/SelectionOverlays";
import { InlineTaskOverlays } from "./ui/task/InlineTaskOverlays";
import { useTaskPersistence } from "./nostr/useTaskPersistence";
import { BoardSyncLedger } from "./nostr/boardSyncLedger";
import { BoardPublisher } from "./nostr/boardPublisher";
import { sameDocumentList, sameStringList } from "./nostr/boardWire";
import { mergeInviteTokens } from "./nostr/calendarWire";
import { mergeIncomingTask, parseTaskEvent } from "./nostr/taskEventMerge";
import { mergeIncomingCalendarEvent, parseCalendarEvent } from "./nostr/calendarEventMerge";
import { useNostrIdentity } from "./nostr/useNostrIdentity";
import {
  normalizeNostrRelayList as normalizeRelayList,
  useNostrAppBackupSync,
} from "./nostr/useNostrAppBackupSync";
import { useFirstRunOnboarding } from "./onboarding/useFirstRunOnboarding";
import { usePushNotifications } from "./domains/push/usePushNotifications";
import { KeyBackupBanner } from "./onboarding/KeyBackupBanner";
import { ReminderNotificationOffer, useReminderNotificationOffer } from "./onboarding/ReminderNotificationOffer";
import { useClipboardWriteToast } from "./hooks/useClipboardWriteToast";
import { useBiblePrintPaperSize, usePrintPortal } from "./hooks/usePrintState";
import { useRuntimeConfig } from "./hooks/useRuntimeConfig";

import {
  buildBoardShareEnvelope,
  buildCalendarEventInviteEnvelope,
  buildTaskAssignmentResponseEnvelope,
  buildTaskShareEnvelope,
  parseShareEnvelope,
  sendShareMessage,
  unwrapShareGiftWrap,
  type ShareEnvelope,
  type SharedCalendarEventInvitePayload,
  type SharedTaskAssignmentResponsePayload,
  type SharedContactPayload,
  type SharedTaskPayload,
} from "./lib/shareInbox";

// ---- UI component imports (extracted subcomponents) ----
import { getDraggedTaskIds } from "./ui/task/Card";
import { currentPubkey } from "./identity/identity";

const AppModalStack = lazy(() =>
  import("./ui/app/AppModalStack").then((module) => ({ default: module.AppModalStack })),
);
const EditModal = lazy(() =>
  import("./ui/task/EditModal").then((module) => ({ default: module.EditModal })),
);
const EventEditModal = lazy(() => import("./ui/calendar/EventEditModal"));
/** The wallet's providers and the Cashu SDK: only where the wallet is enabled (see walletContexts). */
const WalletRuntime = lazy(() => import("./wallet/WalletRuntime"));
/** Background DM sync loads after the app shell; the Chat page remains another lazy boundary. */
const ChatShell = lazy(() => import("./chat/ChatShell"));
const UpcomingPage = lazy(() => import("./ui/upcoming/UpcomingPage"));
// Opened on demand: kept out of startup (scripts/startup-budget.mjs).
const ShareBoardDialogs = lazy(() => import("./ui/board/ShareBoardDialogs").then((m) => ({ default: m.ShareBoardDialogs })));
const WalletBountiesView = lazy(() => import("./ui/wallet/WalletBountiesView").then((m) => ({ default: m.WalletBountiesView })));
const WalletAddressView = lazy(() => import("./ui/wallet/WalletAddressView").then((m) => ({ default: m.WalletAddressView })));
const NoteViewerModal = lazy(() =>
  import("./ui/task/NoteModals").then((module) => ({ default: module.NoteViewerModal })),
);
const SettingsModal = lazy(() =>
  import("./ui/board/SettingsModal").then((module) => ({ default: module.SettingsModal })),
);

const ADD_BOARD_OPTION_ID = "__add-board__";
const BOARD_PRINT_LAYOUT_VERSION = "v2";
const BOARD_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;


const LS_INBOX_PROCESSED = "taskify_inbox_processed_v1";
const MESSAGES_COLUMN_ID = "messages-shared";
const SHARE_DM_LOOKBACK_SECONDS = 3 * 24 * 60 * 60;


function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

const RAW_WORKER_BASE = (import.meta as any)?.env?.VITE_WORKER_BASE_URL || "";
const FALLBACK_WORKER_BASE_URL = RAW_WORKER_BASE ? String(RAW_WORKER_BASE).replace(/\/$/, "") : "";
const FALLBACK_VAPID_PUBLIC_KEY = (import.meta as any)?.env?.VITE_VAPID_PUBLIC_KEY || "";

function taskHasReminders(task: Task): boolean {
  if (task.completed) return false;
  if (task.dueDateEnabled === false) return false;
  return Array.isArray(task.reminders) && task.reminders.length > 0;
}

function calendarEventHasReminders(event: CalendarEvent): boolean {
  if (!Array.isArray(event.reminders) || event.reminders.length === 0) return false;
  if (event.kind === "date") return ISO_DATE_PATTERN.test(event.startDate);
  return !Number.isNaN(Date.parse(event.startISO));
}

function reminderScheduleISOForTask(task: Task, systemTimeZone: string): string | null {
  if (!taskHasReminders(task)) return null;
  if (task.dueTimeEnabled) {
    return Number.isNaN(Date.parse(task.dueISO)) ? null : task.dueISO;
  }
  const dateKey = isoDatePart(task.dueISO, normalizeTimeZone(task.dueTimeZone) ?? systemTimeZone);
  if (!ISO_DATE_PATTERN.test(dateKey)) return null;
  const reminderClock = normalizeReminderTime(task.reminderTime) ?? DEFAULT_DATE_REMINDER_TIME;
  const reminderISO = isoFromDateTime(dateKey, reminderClock, systemTimeZone);
  return Number.isNaN(Date.parse(reminderISO)) ? null : reminderISO;
}

function reminderScheduleISOForCalendarEvent(event: CalendarEvent, systemTimeZone: string): string | null {
  if (!calendarEventHasReminders(event)) return null;
  if (event.kind === "time") {
    return Number.isNaN(Date.parse(event.startISO)) ? null : event.startISO;
  }
  const reminderClock = normalizeReminderTime(event.reminderTime) ?? DEFAULT_DATE_REMINDER_TIME;
  const reminderISO = isoFromDateTime(event.startDate, reminderClock, systemTimeZone);
  return Number.isNaN(Date.parse(reminderISO)) ? null : reminderISO;
}

type CompoundIndexGroup = {
  key: string;
  boardId: string;
  boardName: string;
  columns: { id: string; name: string }[];
};

function compoundColumnKey(boardId: string, columnId: string): string {
  return `${boardId}::${columnId}`;
}

const LS_BOARD_SYNC_CURSORS = "taskify_board_sync_cursors_v1";
// Persistent task-deletion tombstones, keyed by board tag → task id → unix-secs
// of the deletion. Survives reloads so a stale CREATE event from a slow/unaware
// relay cannot resurrect a task whose deletion publish never reached the relay
// (e.g., offline, network failure, app killed before debounce flush).
const LS_TASK_TOMBSTONES = "taskify_task_tombstones_v1";
// Cap per board to bound storage growth. Older tombstones are evicted by
// timestamp — the most recent N deletions are always retained, which is what
// matters for protecting against stale relay re-creates.
const TASK_TOMBSTONES_PER_BOARD_MAX = 500;
/* ================= Date helpers ================= */

const isoForWeekday = isoForWeekdayLocal;

function isoForToday(base = new Date()): string {
  return startOfDay(base).toISOString();
}

/* ================= App ================= */
export default function App() {
  const { show: showToast } = useToast();
  const { vapidPublicKey, workerBaseUrl } = useRuntimeConfig({
    fallbackVapidPublicKey: FALLBACK_VAPID_PUBLIC_KEY,
    fallbackWorkerBaseUrl: FALLBACK_WORKER_BASE_URL,
  });
  useClipboardWriteToast(showToast);
  const messagesBoardId = useMessagesBoardId();
  const [boards, setBoards] = useBoards();
  const {
    currentBoardId,
    scriptureMemoryBoard,
    scriptureMemoryFrequencyOption,
    scriptureMemorySortLabel,
    setCurrentBoardId: setCurrentBoardIdState,
    setSettings,
    settings,
  } = useSettingsSync({ boards, setBoards, bibleBoardId: BIBLE_BOARD_ID });
  const currentBoard = boards.find(b => b.id === currentBoardId);
  const isListBoard = currentBoard?.kind === "lists";
  const visibleBoards = useMemo(() => boards.filter(b => !b.archived && !b.hidden), [boards]);
  const { route: appRoute, router: appRouter } = useAppRouter();
  const activePage = appRoute.page;
  const setActivePage = useCallback<React.Dispatch<React.SetStateAction<ActivePage>>>((nextPage) => {
    const resolved = typeof nextPage === "function" ? nextPage(activePage) : nextPage;
    appRouter.navigate(routeForPage(resolved, currentBoardId));
  }, [activePage, appRouter, currentBoardId]);

  useEffect(() => {
    if (appRoute.page !== "boards" || !appRoute.boardId) return;
    const requested = boards.find(
      (board) => board.id === appRoute.boardId || board.nostr?.boardId === appRoute.boardId,
    );
    if (!requested || requested.id === currentBoardId) return;
    setCurrentBoardIdState(requested.id);
  }, [appRoute, boards, currentBoardId, setCurrentBoardIdState]);

  useEffect(() => {
    if (appRoute.page !== "boards" || appRoute.overlay || appRoute.boardId || !currentBoardId) return;
    appRouter.navigate({ page: "boards", boardId: currentBoardId }, { replace: true });
  }, [appRoute, appRouter, currentBoardId]);

  const [tasks, setTasks] = useTasks();
  const recordRecurringSeriesCutoff = useCallback((task: Task, cutoffISO: string) => {
    recurringCutoffsStore().set((current) => updateRecurringSeriesCutoff(current, task, cutoffISO));
  }, []);
  const sanitizeRecurringTasks = useCallback(<TTask extends Task,>(items: TTask[]): TTask[] => (
    applyRecurringSeriesCutoffs(items, recurringCutoffsStore().get())
  ), []);
  const calendarSeriesCutoffsRef = useRef(
    parseCalendarSeriesCutoffs(
      idbKeyValue.getItem(TASKIFY_STORE_TASKS, CALENDAR_SERIES_CUTOFFS_KEY),
    ),
  );
  const recordCalendarSeriesCutoff = useCallback((
    boardId: string,
    seriesId: string,
    cutoffISO: string,
  ) => {
    const current = calendarSeriesCutoffsRef.current;
    const next = updateCalendarSeriesCutoff(current, boardId, seriesId, cutoffISO);
    if (next === current) return;
    calendarSeriesCutoffsRef.current = next;
    idbKeyValue.setItem(
      TASKIFY_STORE_TASKS,
      CALENDAR_SERIES_CUTOFFS_KEY,
      serializeCalendarSeriesCutoffs(next),
    );
  }, []);
  const sanitizeCalendarEvents = useCallback(<TEvent extends CalendarEvent,>(
    events: TEvent[],
  ): TEvent[] => (
    applyCalendarSeriesCutoffs(events, calendarSeriesCutoffsRef.current)
  ), []);
  const [calendarEvents, setCalendarEvents] = useCalendarEvents();
  useEffect(() => {
    setCalendarEvents((events) => sanitizeCalendarEvents(events));
  }, [sanitizeCalendarEvents, setCalendarEvents]);
  const {
    clearSelection,
    exitSelectionMode,
    isSelectionMode,
    selectedCount,
    selectedEvents,
    selectedItemIds,
    selectedItemIdSet,
    selectedTasks,
    selectionMoveBoardId,
    selectionMoveSheetOpen,
    selectionMoveStep,
    setSelectedItemIds,
    setSelectionMoveBoardId,
    setSelectionMoveSheetOpen,
    setSelectionMoveStep,
    toggleItemSelection,
  } = useSelectionMode({ calendarEvents, tasks });
  const {
    calendarInvites,
    calendarInvitesRef,
    formatCalendarInviteWhen,
    pendingCalendarInvites,
    setCalendarInvites,
    unreadCalendarInviteCount,
  } = useCalendarInvites();
  // Set once `addAcceptedInviteToCalendar` is defined further down; the chat state sync above it
  // uses this to show an invite another device accepted.
  const acceptedInviteMaterializerRef = useRef<
    ((invite: CalendarInvite, status: CalendarRsvpStatus) => Promise<unknown>) | null
  >(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [noteViewerTaskId, setNoteViewerTaskId] = useState<string | null>(null);
  const calendarViewClockRef = useRef<Map<string, number>>(new Map());
  const {
    closeShareBoard,
    openShareBoardForTarget,
    shareBoardModalOpen,
    shareBoardModalOpenRef,
    shareBoardMode,
    shareBoardTarget,
    shareBoardTargetId,
    shareBoardTargetIdRef,
    shareContactBusy,
    shareContactPickerOpen,
    shareContactStatus,
    shareModeInfoButtonRef,
    shareModeInfoOpen,
    shareModeInfoRef,
    shareTemplateBusy,
    shareTemplateShare,
    shareTemplateStatus,
    shareableContacts,
    setShareBoardMode,
    setShareContactBusy,
    setShareContactPickerOpen,
    setShareContactStatus,
    setShareModeInfoOpen,
    setShareTemplateBusy,
    setShareTemplateShare,
    setShareTemplateStatus,
  } = useShareBoardState(boards);
  const boardMap = useMemo(() => {
    const map = new Map<string, Board>();
    boards.forEach((board) => map.set(board.id, board));
    return map;
  }, [boards]);
  const {
    chatUnreadCount,
    inboxPendingItems,
    messagesUnreadCount,
    setDmUnreadCount,
    walletMessageItems,
  } = useWalletMessages({ messagesBoardId, tasks, unreadCalendarInviteCount });
  const activeBountyListKey = PINNED_BOUNTY_LIST_KEY;
  const bountyListEnabled = true;
  const [bibleTracker, setBibleTracker] = useBibleTracker();
  const bibleTrackerRef = useRef<BibleTrackerState>(bibleTracker);
  useEffect(() => { bibleTrackerRef.current = bibleTracker; }, [bibleTracker]);
  const [biblePrintPaperSize, setBiblePrintPaperSize] = useBiblePrintPaperSize();
  const [biblePrintOpen, setBiblePrintOpen] = useState(false);
  const [biblePrintMeta, setBiblePrintMeta] = useState<BiblePrintMeta | null>(null);
  const [biblePrintPdfBusy, setBiblePrintPdfBusy] = useState(false);
  const [bibleScanOpen, setBibleScanOpen] = useState(false);
  const biblePrintPortal = usePrintPortal("bible-print-portal");
  const [boardPrintOpen, setBoardPrintOpen] = useState(false);
  const [boardScanOpen, setBoardScanOpen] = useState(false);
  const [boardPrintJob, setBoardPrintJob] = useState<BoardPrintJob | null>(null);
  const [boardPrintPdfBusy, setBoardPrintPdfBusy] = useState(false);
  const boardPrintPortal = usePrintPortal("board-print-portal");
  const [scriptureMemory, setScriptureMemory] = useScriptureMemory();
  const [defaultRelays, setDefaultRelays] = useState<string[]>(() => loadDefaultRelays());
  useEffect(() => { saveDefaultRelays(defaultRelays); }, [defaultRelays]);
  const handleAddScriptureMemory = useCallback((payload: AddScripturePayload) => {
    setScriptureMemory((prev) => {
      const entries = prev.entries ? [...prev.entries] : [];
      const chapterCount = getBibleBookChapterCount(payload.bookId) ?? payload.chapter;
      const chapter = Math.min(Math.max(1, Math.floor(payload.chapter)), chapterCount);
      const verseCount = getBibleChapterVerseCount(payload.bookId, chapter) ?? MAX_VERSE_COUNT;
      let startVerse = payload.startVerse != null ? Math.floor(payload.startVerse) : null;
      let endVerse = payload.endVerse != null ? Math.floor(payload.endVerse) : startVerse;
      if (startVerse != null) startVerse = Math.max(1, Math.min(verseCount, startVerse));
      if (endVerse != null) endVerse = Math.max(1, Math.min(verseCount, endVerse));
      if (startVerse != null && endVerse != null && endVerse < startVerse) {
        [startVerse, endVerse] = [endVerse, startVerse];
      }
      const entry: ScriptureMemoryEntry = {
        id: crypto.randomUUID(),
        bookId: payload.bookId,
        chapter,
        startVerse,
        endVerse: endVerse ?? startVerse,
        addedAtISO: new Date().toISOString(),
        lastReviewISO: undefined,
        scheduledAtISO: undefined,
        stage: 0,
        totalReviews: 0,
      };
      return updateScriptureMemoryState(prev, [...entries, entry]);
    });
  }, [setScriptureMemory]);
  const handleRemoveScriptureMemory = useCallback((id: string) => {
    setScriptureMemory((prev) => updateScriptureMemoryState(prev, prev.entries.filter((entry) => entry.id !== id)));
    setTasks((prev) => prev.filter((task) => task.scriptureMemoryId !== id));
  }, [setScriptureMemory, setTasks]);
  const scriptureMemoryItems = useMemo<ScriptureMemoryListItem[]>(() => {
    if (!scriptureMemory.entries.length) return [];
    const baseDays = scriptureMemoryFrequencyOption?.days ?? 1;
    const now = new Date();
    const total = scriptureMemory.entries.length;
    const decorated = scriptureMemory.entries.map((entry) => ({
      entry,
      stats: computeScriptureStats(entry, baseDays, total, now),
    }));
    decorated.sort((a, b) => {
      switch (settings.scriptureMemorySort) {
        case "canonical": {
          const orderA = getBibleBookOrder(a.entry.bookId) ?? 0;
          const orderB = getBibleBookOrder(b.entry.bookId) ?? 0;
          if (orderA !== orderB) return orderA - orderB;
          if (a.entry.chapter !== b.entry.chapter) return a.entry.chapter - b.entry.chapter;
          const startA = a.entry.startVerse ?? 0;
          const startB = b.entry.startVerse ?? 0;
          if (startA !== startB) return startA - startB;
          return (a.entry.endVerse ?? 0) - (b.entry.endVerse ?? 0);
        }
        case "oldest": {
          const timeA = new Date(a.entry.addedAtISO).getTime();
          const timeB = new Date(b.entry.addedAtISO).getTime();
          return timeA - timeB;
        }
        case "newest": {
          const timeA = new Date(a.entry.addedAtISO).getTime();
          const timeB = new Date(b.entry.addedAtISO).getTime();
          return timeB - timeA;
        }
        case "needsReview":
        default: {
          if (a.stats.score === b.stats.score) {
            return a.stats.dueInDays - b.stats.dueInDays;
          }
          return b.stats.score - a.stats.score;
        }
      }
    });
    return decorated.map(({ entry, stats }) => ({
      id: entry.id,
      reference: formatScriptureReference(entry),
      addedAtISO: entry.addedAtISO,
      lastReviewISO: entry.lastReviewISO,
      stage: entry.stage ?? 0,
      totalReviews: entry.totalReviews ?? 0,
      dueLabel: formatDueInLabel(stats.dueInDays),
      dueNow: stats.dueNow,
    }));
  }, [
    scriptureMemory.entries,
    scriptureMemoryFrequencyOption?.days,
    settings.scriptureMemorySort,
  ]);
  const completedNostrInitialSyncRef = useRef<Set<string>>(new Set());
  const [pendingNostrInitialSyncByBoardTag, setPendingNostrInitialSyncByBoardTag] = useState<Record<string, true>>({});
  // Deleted calendar occurrence ids, from local deletes and relay tombstones, so a series never
  // regenerates one. Rebuilt from history on each launch; generation waits for initial sync.
  const deletedCalendarOccurrenceIdsRef = useRef(new Set<string>());
  // Generated tasks (recurring instances, fasting reminders, the first scripture review) use ids
  // every device derives the same way. On a shared board, generating one before the relays have
  // delivered the board would republish an instance another device already completed, with the
  // same id and a newer timestamp, and reopen it. So generation waits for the board's initial
  // sync (which also completes on its timeout, so offline use still gets them).
  const boardsForGenerationRef = useRef(boards);
  boardsForGenerationRef.current = boards;
  const isBoardReadyForGeneratedTasks = useCallback((boardId: string) => {
    const board = findBoardByCompoundChildId(boardsForGenerationRef.current, boardId)
      ?? boardsForGenerationRef.current.find((candidate) => candidate.id === boardId);
    const nostrBoardId = board?.nostr?.boardId;
    if (!nostrBoardId) return true;
    return completedNostrInitialSyncRef.current.has(boardTag(nostrBoardId));
  }, []);
  const maybePublishTaskRef = useRef<PublishTaskFn | null>(null);
  const publishTaskDeletedRef = useRef<((task: Task) => Promise<void>) | null>(null);
  const maybePublishCalendarEventRef = useRef<PublishCalendarEventFn | null>(null);
  const publishBoardMetadataRef = useRef<((board: Board) => Promise<void>) | null>(null);
  const boardMetadataFingerprintsRef = useRef(new PublishFingerprints());
  const publishBoardMetadataSnapshotRef = useRef<((board: Board, boardId: string, relays: string[]) => Promise<void>) | null>(null);
  const publishCalendarEventDeletedRef = useRef<((event: CalendarEvent) => Promise<void>) | null>(null);
  const completeTaskRef = useRef<CompleteTaskFn | null>(null);
  const scriptureLastReviewRef = useRef<string | null>(null);
  const handleReviewScriptureMemory = useCallback(
    (id: string) => {
      const pending = tasks.find((task) => task.scriptureMemoryId === id && !task.completed);
      if (pending) {
        const update = completeTaskRef.current?.(pending.id, { skipScriptureMemoryUpdate: true });
        const completedAt = update?.scriptureMemory?.completedAt ?? new Date().toISOString();
        scriptureLastReviewRef.current = completedAt;
        const stageBefore = update?.scriptureMemory?.stageBefore ?? (
          typeof pending.scriptureMemoryStage === "number" ? pending.scriptureMemoryStage : undefined
        );
        const nextScheduled = update?.scriptureMemory?.nextScheduled;
        setScriptureMemory((prev) => {
          let nextState = markScriptureEntryReviewed(prev, id, completedAt, stageBefore);
          if (nextScheduled) {
            nextState = scheduleScriptureEntry(nextState, nextScheduled.entryId, nextScheduled.scheduledAtISO);
          }
          return nextState;
        });
        return;
      }
      const completedAt = new Date().toISOString();
      scriptureLastReviewRef.current = completedAt;
      setScriptureMemory((prev) => markScriptureEntryReviewed(prev, id, completedAt));
    },
    [tasks, setScriptureMemory, completeTaskRef]
  );
  useEffect(() => {
    if (!tasks.length) return;
    if (!scriptureMemory.entries.length) return;
    let updatedState: ScriptureMemoryState | null = null;
    let latestReviewISO: string | null = null;
    let latestReviewTime = Number.NEGATIVE_INFINITY;
    for (const task of tasks) {
      if (!task.completed) continue;
      if (!task.scriptureMemoryId) continue;
      const completedAt = normalizeIsoTimestamp(task.completedAt);
      if (!completedAt) continue;
      const baseState = updatedState ?? scriptureMemory;
      const entry = baseState.entries.find((item) => item.id === task.scriptureMemoryId);
      if (!entry) continue;
      const entryLastReview = entry.lastReviewISO ? new Date(entry.lastReviewISO).getTime() : Number.NEGATIVE_INFINITY;
      const completedTime = new Date(completedAt).getTime();
      if (!Number.isFinite(completedTime)) continue;
      if (Number.isFinite(entryLastReview) && entryLastReview >= completedTime) continue;
      const stageBefore = typeof task.scriptureMemoryStage === "number"
        ? task.scriptureMemoryStage
        : entry.stage ?? 0;
      updatedState = markScriptureEntryReviewed(baseState, task.scriptureMemoryId, completedAt, stageBefore);
      if (!Number.isFinite(latestReviewTime) || latestReviewTime < completedTime) {
        latestReviewISO = completedAt;
        latestReviewTime = completedTime;
      }
    }
    if (updatedState && updatedState !== scriptureMemory) {
      if (latestReviewISO) {
        scriptureLastReviewRef.current = latestReviewISO;
      }
      setScriptureMemory(updatedState);
    }
  }, [tasks, scriptureMemory, setScriptureMemory]);

  useEffect(() => {
    const latest = scriptureMemory.lastReviewISO ?? null;
    if (!latest) {
      scriptureLastReviewRef.current = null;
      return;
    }
    const current = scriptureLastReviewRef.current;
    if (!current) {
      scriptureLastReviewRef.current = latest;
      return;
    }
    if (new Date(latest).getTime() > new Date(current).getTime()) {
      scriptureLastReviewRef.current = latest;
    }
  }, [scriptureMemory.lastReviewISO]);

  useEffect(() => {
    if (!settings.scriptureMemoryEnabled) return;
    if (!scriptureMemory.entries.length) return;
    const targetBoard = scriptureMemoryBoard && scriptureMemoryBoard.kind !== "bible"
      ? scriptureMemoryBoard
      : null;
    if (!targetBoard) return;
    if (!isBoardReadyForGeneratedTasks(targetBoard.id)) return;
    if (targetBoard.kind === "lists" && (!targetBoard.columns || targetBoard.columns.length === 0)) return;
    const now = new Date();
    const plan = planScriptureReviewTask(tasksStore().get(), recurringCutoffsStore().get(), {
      targetBoard,
      entries: scriptureMemory.entries,
      baseDays: scriptureMemoryFrequencyOption?.days ?? 1,
      now,
      settings,
    });
    if (!plan) return;
    setTasks(plan.tasks);
    if (plan.created && plan.scheduledEntryId) {
      maybePublishTaskRef.current?.(plan.created)?.catch(() => {});
      const scheduledEntryId = plan.scheduledEntryId;
      setScriptureMemory((prev) => scheduleScriptureEntry(prev, scheduledEntryId, now.toISOString()));
    }
  }, [
    settings.scriptureMemoryEnabled,
    scriptureMemory.entries,
    scriptureMemoryBoard,
    scriptureMemoryFrequencyOption?.days,
    settings.weekStart,
    settings.newTaskPosition,
    setTasks,
    maybePublishTaskRef,
    sanitizeRecurringTasks,
    setScriptureMemory,
    isBoardReadyForGeneratedTasks,
    pendingNostrInitialSyncByBoardTag,
  ]);

  useEffect(() => {
    // Follows the board that already holds reminders, so every device uses the same one.
    const targetBoard = fastingReminderTargetBoard(boards, tasksRef.current, FASTING_REMINDER_SERIES_ID);

    // Every shared board's history must be in first: reminders another device made may be on any
    // of them, and they decide where reminders live.
    if (
      settings.fastingRemindersEnabled &&
      (!targetBoard || boards.some((b) => b.nostr?.boardId && !isBoardReadyForGeneratedTasks(b.id)))
    ) {
      return;
    }
    const plan = planFastingReminders(tasksStore().get(), { targetBoard: targetBoard ?? undefined, now: new Date(), settings });
    if (!plan) return;
    setTasks(plan.tasks);
    plan.publish.forEach((task) => maybePublishTaskRef.current?.(task, targetBoard ?? undefined)?.catch(() => {}));
    plan.publishDeleted.forEach((task) => publishTaskDeletedRef.current?.(task)?.catch(() => {}));
  }, [
    boards,
    settings.fastingRemindersEnabled,
    settings.fastingRemindersMode,
    settings.fastingRemindersPerMonth,
    settings.fastingRemindersRandomSeed,
    settings.fastingRemindersWeekday,
    settings.newTaskPosition,
    settings.weekStart,
    setTasks,
    maybePublishTaskRef,
    isBoardReadyForGeneratedTasks,
    pendingNostrInitialSyncByBoardTag,
  ]);

  useEffect(() => {
    if (!settings.showFullWeekRecurring) return;
    setTasks(ensureWeekRecurrences(tasksStore().get()));
    // Re-run as each shared board finishes its initial sync.
  }, [settings.showFullWeekRecurring, settings.weekStart, pendingNostrInitialSyncByBoardTag]);

  useAppAppearance(settings);

  const {
    applyCustomNostrKey,
    nostrPK,
    nostrPublish,
    nostrPublishRef,
    nostrSK,
    nostrSkHex,
    pool,
    rotateNostrKey,
    setCustomNostrKey,
  } = useNostrIdentity({ defaultRelays });
  const {
    clearOptimisticNostrCalendarEventSyncPending,
    clearOptimisticNostrTaskSyncPending,
    markNostrCalendarEventSyncPending,
    markNostrTaskSyncPending,
    pendingNostrCalendarEventIds,
    pendingNostrTaskIds,
  } = useTaskPersistence();
  // Clocks, in-flight publishes and deletion tombstones for every shared board (see BoardSyncLedger).
  const ledgerRef = useRef<BoardSyncLedger | null>(null);
  ledgerRef.current ??= new BoardSyncLedger(
    {
      load: () => idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_TASK_TOMBSTONES),
      save: (serialized) => idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_TASK_TOMBSTONES, serialized),
    },
    TASK_TOMBSTONES_PER_BOARD_MAX,
  );
  const ledger = ledgerRef.current;
  const recordTaskTombstone = useCallback(
    (bTag: string, taskId: string, at: number) => ledger.recordTombstone(bTag, taskId, at),
    [ledger],
  );
  const clearTaskTombstone = useCallback(
    (bTag: string, taskId: string) => ledger.clearTombstone(bTag, taskId),
    [ledger],
  );
  const taskPublishVersionsRef = useRef(new TaskPublishVersionTracker());
  const seenBoardTasksRef = useRef<Map<string, Set<string>>>(new Map());
  // Set of bTags where all relays have fired EOSE — used to determine live vs batch mode.
  const [boardHistoryResyncNonce, setBoardHistoryResyncNonce] = useState(0);
  // In-memory cursor: tracks the highest created_at seen per board tag this session.
  // Persisted to IDB after EOSE so subsequent opens only fetch new events.
  // NOTE: useRef does NOT lazy-initialize like useState. The previous
  // `useRef(() => {...})` form stored the function as the value, so persisted
  // cursors were never loaded — every reload fell back to a 30-day refetch
  // which heavily inflated the window for stale CREATE events to revert
  // locally-deleted tasks. The IIFE form below actually invokes the loader.
  const boardSyncCursorsRef = useRef<Record<string, number>>(((): Record<string, number> => {
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  })());
  // Per-relay batch accumulator. Events from each relay are collected here until
  // that relay fires EOSE. On EOSE the relay's batch is clock-protected-merged into
  // the task state and IDB data is shown immediately (no blocking spinner).
  // Map<bTag, Map<relayUrl, Map<"boardId::taskId", Task | { _deleted:true; _nostrAt:number }>>>
  const relayBatchRef = useRef<Map<string, Map<string, Map<string, BoardSyncRelayBatchEntry>>>>(new Map());

  // Tracks which relay URLs still have pending EOSE for each board.
  // When empty for a board, all relays are done and we're in live mode.
  // Map<bTag, Set<relayUrl>>
  const pendingRelaysByBoardRef = useRef<Map<string, Set<string>>>(new Map());

  // Live-mode micro-batch coalescer. After the initial batch flush, post-EOSE events
  // (e.g. from slow relays still streaming, or live peer updates) are accumulated for
  // LIVE_BATCH_MS before a single setTasks is called. This prevents slow-relay events
  // from triggering individual renders that briefly show stale state — by the time the
  // window fires, both CREATE and DELETE events for a task have arrived, and the clock
  // check ensures only the latest wins. Initial load speed is completely unaffected.
  //
  // Updater functions (not pre-built tasks) are buffered so all existing merge logic
  // (bounty merging, subtask merging, etc.) runs intact inside a single setTasks call.
  const LIVE_BATCH_MS = 150;
  type TaskUpdater = (prev: Task[]) => Task[];
  const liveBatchRef = useRef<Map<string, { updaters: TaskUpdater[]; timer: number }>>(new Map());

  const markNostrBoardInitialSyncComplete = useCallback((bTag: string) => {
    if (!bTag) return;
    completedNostrInitialSyncRef.current.add(bTag);
    setPendingNostrInitialSyncByBoardTag((prev) => {
      if (!prev[bTag]) return prev;
      const next = { ...prev };
      delete next[bTag];
      return next;
    });
  }, []);
  const boardsRef = useRef<Board[]>(boards);
  useEffect(() => { boardsRef.current = boards; }, [boards]);
  const tasksRef = useRef<Task[]>(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const calendarEventsRef = useRef<CalendarEvent[]>(calendarEvents);
  useEffect(() => { calendarEventsRef.current = calendarEvents; }, [calendarEvents]);
  const [inboxProcessedSeed] = useState<string[]>(() => {
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_INBOX_PROCESSED);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
            .slice(-400);
        }
      }
    } catch {}
    return [];
  });
  const inboxProcessedRef = useRef<Set<string>>(new Set(inboxProcessedSeed));
  const persistInboxProcessed = useCallback(() => {
    try {
      const trimmed = Array.from(inboxProcessedRef.current).slice(-400);
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_INBOX_PROCESSED, JSON.stringify(trimmed));
    } catch {
      // ignore persistence errors
    }
  }, []);
  const inboxPoolRef = useRef<SessionPool | null>(null);

  const inboxRelays = useMemo(
    () =>
      Array.from(
        new Set(
          (defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS))
            .map((r) => r.trim())
            .filter(Boolean),
        ),
      ),
    [defaultRelays],
  );
  const ensureInboxPool = useCallback((): SessionPool => {
    if (inboxPoolRef.current) return inboxPoolRef.current;
    inboxPoolRef.current = new SessionPool();
    return inboxPoolRef.current;
  }, []);
  const toNpub = useCallback((value: string): string => {
    const raw = compressedToRawHex(normalizeNostrPubkey(value) || value);
    try {
      if (typeof (nip19 as any)?.npubEncode === "function") {
        return (nip19 as any).npubEncode(raw);
      }
    } catch {
      // fall through
    }
    return raw;
  }, []);
  const shortenNpub = useCallback((value: string): string => {
    if (!value) return "";
    return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
  }, []);
  const fetchProfileMetadata = useCallback(
    async (
      pubkey: string,
    ): Promise<{ name?: string; displayName?: string; username?: string; nip05?: string } | null> => {
      const hex = normalizeNostrPubkey(pubkey);
      if (!hex) return null;
      const relays = inboxRelays.length ? inboxRelays : Array.from(DEFAULT_NOSTR_RELAYS);
      try {
        const pool = ensureInboxPool();
        const ev = await pool.get(relays, { kinds: [0], authors: [hex] });
        if (ev?.content) {
          try {
            const parsed = JSON.parse(ev.content);
            if (parsed && typeof parsed === "object") {
              return {
                name: typeof parsed.name === "string" ? parsed.name : undefined,
                displayName: typeof parsed.display_name === "string" ? parsed.display_name : undefined,
                username: typeof parsed.username === "string" ? parsed.username : undefined,
                nip05: typeof parsed.nip05 === "string" ? parsed.nip05 : undefined,
              };
            }
          } catch {
            // ignore parse errors
          }
        }
      } catch (err) {
        console.warn("Failed to fetch profile metadata", err);
      }
      return null;
    },
    [ensureInboxPool, inboxRelays],
  );
  const extractPTagPubkeys = useCallback((tags: string[][] | undefined): string[] => {
    if (!Array.isArray(tags)) return [];
    return tags
      .filter((tag) => Array.isArray(tag) && tag[0] === "p" && typeof tag[1] === "string")
      .map((tag) => tag[1]!.trim())
      .map((value) => normalizeNostrPubkey(value) || value)
      .filter((value) => value.length > 0)
      .map((value) => value.toLowerCase());
  }, []);
  const decryptShareMessage = useCallback(
    async (
      event: NostrEvent,
    ): Promise<{ content: string; senderPubkey: string; recipientPubkeys: string[] } | null> => {
      if (!nostrSkHex) return null;
      try {
        if (event.kind === 4) {
          const content = await nip04.decrypt(nostrSkHex, event.pubkey, event.content);
          return {
            content,
            senderPubkey: event.pubkey,
            recipientPubkeys: extractPTagPubkeys(event.tags),
          };
        }
        if (event.kind === 1059) {
          const opened = unwrapShareGiftWrap(event, nostrSkHex);
          if (!opened) return null;
          return {
            content: opened.content,
            senderPubkey: opened.senderPubkey,
            recipientPubkeys: extractPTagPubkeys(opened.tags),
          };
        }
      } catch (err) {
        console.warn("Failed to decrypt shared inbox message", err);
      }
      return null;
    },
    [extractPTagPubkeys, nostrSkHex],
  );
  const formatSenderLabel = useCallback(
    (sender: InboxSender): string => {
      const contacts = loadContactsFromStorage();
      const normalized = normalizeNostrPubkey(sender.pubkey);
      if (normalized) {
        const match = contacts.find(
          (contact) => normalizeNostrPubkey(contact.npub || "") === normalized,
        );
        if (match) return contactPrimaryName(match);
      }
      if (sender.name?.trim()) return sender.name.trim();
      const senderNpub = sender.npub || (normalized ? toNpub(normalized) : "");
      if (senderNpub) return shortenNpub(senderNpub);
      if (normalized) return shortenNpub(normalized);
      return shortenNpub(sender.pubkey);
    },
    [shortenNpub, toNpub],
  );
  const sendInboxDeletion = useCallback(
    async (eventId: string) => {
      if (!eventId || !nostrSkHex) return;
      if (!inboxRelays.length) return;
      try {
        const pool = ensureInboxPool();
        const deletion: EventTemplate = {
          kind: 5,
          content: "Handled shared item",
          tags: [["e", eventId]],
          created_at: Math.floor(Date.now() / 1000),
        };
        const signed = await prepareRelayEvent(deletion, hexToBytes(nostrSkHex), inboxRelays);
        await Promise.resolve(pool.publish(inboxRelays, signed));
      } catch (err) {
        console.warn("Failed to delete shared inbox DM", err);
      }
    },
    [ensureInboxPool, inboxRelays, nostrSkHex],
  );
  const addInboxTask = useCallback(
    (item: ShareEnvelope["item"], sender: InboxSender, dmEventId: string) => {
      const existing = tasksRef.current.find((task) => task.inboxItem?.dmEventId === dmEventId);
      if (existing) return;
      const senderLabel = formatSenderLabel(sender);
      const lines: string[] = [`From ${senderLabel}`];
      let contactPayload: SharedContactPayload | null = null;
      let taskPayload: SharedTaskPayload | null = null;
      if (item.type === "board") {
        lines.push(`Board ID: ${item.boardId}`);
        if (item.relays?.length) {
          lines.push(`Relays: ${item.relays.join(", ")}`);
        }
      } else if (item.type === "contact") {
        contactPayload = (item as any).contact ?? (item as any);
        if (!contactPayload || !contactPayload.npub) return;
        lines.push(`npub: ${shortenNpub(toNpub(contactPayload.npub))}`);
        if (contactPayload.nip05) lines.push(`NIP-05: ${contactPayload.nip05}`);
        if (contactPayload.lud16) lines.push(`Lightning: ${contactPayload.lud16}`);
      } else if (item.type === "task") {
        taskPayload = item as SharedTaskPayload;
        const title = taskPayload.title?.trim();
        if (!title) return;
        const isAssignment = isAssignedSharedTask(taskPayload);
        if (isAssignment) {
          lines.push("Assignment request");
        }
        if (taskPayload.dueISO && taskPayload.dueDateEnabled !== false) {
          const dateKey = isoDatePart(taskPayload.dueISO, taskPayload.dueTimeZone);
          const dueDate = new Date(`${dateKey}T00:00:00`);
          if (!Number.isNaN(dueDate.getTime())) {
            const dateLabel = dueDate.toLocaleDateString([], { month: "short", day: "numeric" });
            const timeLabel = taskPayload.dueTimeEnabled
              ? formatTimeLabel(taskPayload.dueISO, taskPayload.dueTimeZone)
              : "";
            lines.push(`Due: ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ""}`);
          }
        }
        const subtaskTitles = (taskPayload.subtasks || [])
          .map((subtask) => subtask.title?.trim())
          .filter(Boolean) as string[];
        if (subtaskTitles.length) {
          lines.push(`Subtasks: ${subtaskTitles.join(", ")}`);
        }
        if (taskPayload.note?.trim()) {
          lines.push("", taskPayload.note.trim());
        }
      }
      const note = lines.join("\n");
      const nowISO = new Date().toISOString();
      const order = nextOrderForBoard(messagesBoardId, tasksRef.current, settings.newTaskPosition);
      const inboxItem: InboxItem =
        item.type === "board"
          ? {
              type: "board",
              boardId: item.boardId,
              boardName: item.boardName,
              relays: item.relays,
              sender,
              receivedAt: nowISO,
              status: "pending",
              dmEventId,
            }
          : item.type === "contact"
            ? {
                type: "contact",
                contact: contactPayload || { type: "contact", npub: "" },
                sender,
                receivedAt: nowISO,
                status: "pending",
                dmEventId,
              }
            : {
                type: "task",
                task: taskPayload || { type: "task", title: "Shared task" },
                sender,
                receivedAt: nowISO,
                status: "pending",
                dmEventId,
              };
      const task: Task = {
        id: crypto.randomUUID(),
        boardId: messagesBoardId,
        columnId: MESSAGES_COLUMN_ID,
        title:
          item.type === "board"
            ? item.boardName?.trim() || "Shared board"
            : item.type === "contact"
              ? contactPayload?.name?.trim() ||
                contactPayload?.displayName?.trim() ||
                (contactPayload?.npub ? shortenNpub(toNpub(contactPayload.npub)) : "") ||
                "Shared contact"
              : taskPayload?.title?.trim() || "Shared task",
        note,
        createdAt: Date.now(),
        dueISO: nowISO,
        completed: false,
        order,
        createdBy: normalizeAgentPubkey(sender.pubkey) ?? sender.pubkey,
        lastEditedBy: normalizeAgentPubkey(sender.pubkey) ?? sender.pubkey,
        inboxItem,
      };
      setTasks((prev) => [...prev, task]);
      maybePublishTaskRef.current?.(task).catch(() => {});
      const toastLabel =
        item.type === "board"
          ? `New board from ${senderLabel}`
          : item.type === "contact"
            ? `New contact from ${senderLabel}`
            : isAssignedSharedTask(taskPayload)
              ? `New assignment from ${senderLabel}`
              : `New task from ${senderLabel}`;
      showToast(toastLabel);
    },
    [
      formatSenderLabel,
      maybePublishTaskRef,
      messagesBoardId,
      setTasks,
      settings.newTaskPosition,
      shortenNpub,
      showToast,
      toNpub,
    ],
  );

  const upsertCalendarInvite = useCallback((invite: CalendarInvite) => {
    setCalendarInvites((prev) => {
      const idx = prev.findIndex((existing) => existing.canonical === invite.canonical);
      if (idx < 0) return [...prev, invite];
      const existing = prev[idx];
      const merged: CalendarInvite = {
        ...existing,
        ...invite,
        id: existing.id || invite.id,
        status: existing.status,
        respondedAt: existing.respondedAt,
        dmEventIds: Array.from(new Set([...(existing.dmEventIds ?? []), ...(invite.dmEventIds ?? [])])),
        sender: existing.sender ?? invite.sender,
        relays: existing.relays?.length ? existing.relays : invite.relays,
        receivedAt: existing.receivedAt || invite.receivedAt,
        source: existing.source || invite.source,
      };
      const copy = prev.slice();
      copy[idx] = merged;
      return copy;
    });
  }, [setCalendarInvites]);

  const addInboxCalendarInvite = useCallback((item: SharedCalendarEventInvitePayload, sender: InboxSender, dmEventId: string) => {
    const nowISO = new Date().toISOString();
    upsertCalendarInvite({
      id: item.canonical,
      source: "dm",
      dmEventIds: dmEventId ? [dmEventId.trim().toLowerCase()] : undefined,
      eventId: item.eventId,
      canonical: item.canonical,
      view: item.view,
      eventKey: item.eventKey,
      inviteToken: item.inviteToken,
      title: item.title?.trim() || undefined,
      start: item.start?.trim() || undefined,
      end: item.end?.trim() || undefined,
      relays: item.relays?.length ? item.relays : undefined,
      sender,
      receivedAt: nowISO,
      status: "pending",
    });
  }, [upsertCalendarInvite]);

  const applyTaskAssignmentResponse = useCallback(
    (item: SharedTaskAssignmentResponsePayload, sender: InboxSender) => {
      const taskId = (item.taskId || "").trim();
      if (!taskId) return;
      const responderPubkey = normalizeAgentPubkey(sender.pubkey) ?? normalizeNostrPubkeyHex(sender.npub || "");
      if (!responderPubkey) return;
      const status = item.status === "accepted" || item.status === "declined" || item.status === "tentative"
        ? item.status
        : null;
      if (!status) return;
      const parsedRespondedAt = item.respondedAt ? Date.parse(item.respondedAt) : Number.NaN;
      const respondedAtMs = Number.isFinite(parsedRespondedAt) ? parsedRespondedAt : Date.now();
      const plan = planAssignmentResponse(tasksStore().get(), taskId, responderPubkey, status, respondedAtMs);
      if (plan) {
        setTasks(plan.tasks);
        maybePublishTaskRef.current?.(plan.updated).catch(() => {});
        const senderLabel = formatSenderLabel(sender);
        const statusLabel = status === "accepted" ? "accepted" : status === "tentative" ? "maybe" : "declined";
        showToast(`${senderLabel} responded: ${statusLabel}`);
      }
    },
    [formatSenderLabel, setTasks, showToast],
  );

  const handleIncomingShareEvent = useCallback(
    async (event: NostrEvent) => {
      if (!event?.id || inboxProcessedRef.current.has(event.id)) return;
      if (event.kind !== 4 && event.kind !== 1059) return;
      const decrypted = await decryptShareMessage(event);
      if (!decrypted) return;
      const { content, senderPubkey, recipientPubkeys } = decrypted;
      const normalizedViewer = normalizeNostrPubkey(nostrPK || "") || (nostrPK || "").toLowerCase();
      if (recipientPubkeys.length && normalizedViewer && !recipientPubkeys.includes(normalizedViewer)) {
        return;
      }
      let envelope = parseShareEnvelope(content);
      if (!envelope) {
        // Fallback: try to parse arbitrary JSON with an npub field
        try {
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed === "object") {
            const npubField =
              typeof (parsed as any).npub === "string"
                ? (parsed as any).npub
                : typeof (parsed as any).pubkey === "string"
                  ? (parsed as any).pubkey
                  : undefined;
            const npubGuess =
              npubField && (normalizeNostrPubkey(npubField) || (npubField.trim().startsWith("npub") ? npubField.trim() : null));
            if (npubGuess) {
              envelope = {
                v: 1,
                kind: "taskify-share",
                item: { type: "contact", npub: npubGuess },
              };
            }
          }
        } catch {
          // ignore parse errors
        }
      }
      if (!envelope) {
        // Fallback: allow raw npub/hex strings to be treated as contact shares.
        const npubGuess =
          normalizeNostrPubkey(content) || (content.trim().startsWith("npub") ? content.trim() : null);
        if (npubGuess) {
          envelope = {
            v: 1,
            kind: "taskify-share",
            item: {
              type: "contact",
              npub: npubGuess,
            } as any,
          };
        }
      }
      if (!envelope) return;
      inboxProcessedRef.current.add(event.id);
      persistInboxProcessed();
      let senderName = envelope.sender?.name;
      if (!senderName) {
        const senderProfile = await fetchProfileMetadata(senderPubkey);
        senderName =
          senderProfile?.displayName ||
          senderProfile?.name ||
          senderProfile?.username ||
          senderProfile?.nip05;
      }
      const sender: InboxSender = {
        pubkey: senderPubkey,
        name: senderName || envelope.sender?.name,
        npub: envelope.sender?.npub,
      };
      if (envelope.item.type === "event") {
        addInboxCalendarInvite(envelope.item as SharedCalendarEventInvitePayload, sender, event.id);
        void sendInboxDeletion(event.id);
        return;
      }
      if (envelope.item.type === "task-assignment-response") {
        applyTaskAssignmentResponse(envelope.item as SharedTaskAssignmentResponsePayload, sender);
        void sendInboxDeletion(event.id);
        return;
      }
      let itemToAdd: ShareEnvelope["item"] = envelope.item;
      if (envelope.item.type === "contact") {
        const baseContact: SharedContactPayload = (envelope.item as any).contact ?? (envelope.item as any);
        let enrichedContact = { ...baseContact };
        if (
          !enrichedContact.name &&
          !enrichedContact.displayName &&
          !enrichedContact.username &&
          !enrichedContact.nip05
        ) {
          const profile = await fetchProfileMetadata(baseContact.npub);
          if (profile) {
            enrichedContact = {
              ...enrichedContact,
              name: profile.displayName || profile.name || undefined,
              displayName: profile.displayName,
              username: profile.username,
              nip05: profile.nip05,
            };
          }
        }
        itemToAdd = { type: "contact", contact: enrichedContact } as any;
      }
      addInboxTask(itemToAdd, sender, event.id);
      void sendInboxDeletion(event.id);
    },
    [
      addInboxCalendarInvite,
      addInboxTask,
      applyTaskAssignmentResponse,
      decryptShareMessage,
      fetchProfileMetadata,
      nostrPK,
      persistInboxProcessed,
      sendInboxDeletion,
    ],
  );

  const tagValue = useCallback((ev: NostrEvent, name: string): string | undefined => {
    const t = ev.tags.find((x) => x[0] === name);
    return t ? t[1] : undefined;
  }, []);

  const applyCalendarViewSubscriptionEvent = useCallback(
    async (ev: NostrEvent, target: CalendarViewSubscriptionTarget) => {
      const viewAddress = target.viewAddress;
      let payload: ReturnType<typeof parseCalendarViewPayload> | null = null;
      try {
        const raw = await decryptCalendarPayloadWithEventKey(ev.content, target.eventKey);
        payload = parseCalendarViewPayload(raw);
      } catch (err) {
        console.warn("Failed to decrypt event view", err);
        return;
      }
      if (!payload || payload.eventId !== target.eventId) return;
      if (payload.deleted) {
        setCalendarEvents((prev) =>
          prev.filter((event) => !(event.id === target.eventId && event.viewAddress === viewAddress)),
        );
        return;
      }
      setCalendarEvents((prev) => {
        const idx = prev.findIndex((event) => event.viewAddress === viewAddress);
        if (idx < 0) return prev;
        const existing = prev[idx];
        const payloadCreatedBy = normalizeAgentPubkey(payload.createdBy);
        const payloadLastEditedBy = normalizeAgentPubkey(payload.lastEditedBy) ?? payloadCreatedBy;
        let updated: CalendarEvent | null = null;
        if (payload.kind === "date") {
          if (!payload.startDate || !ISO_DATE_PATTERN.test(payload.startDate)) return prev;
          const endDate =
            payload.endDate && ISO_DATE_PATTERN.test(payload.endDate) && payload.endDate >= payload.startDate
              ? payload.endDate
              : undefined;
          updated = {
            ...existing,
            kind: "date",
            startDate: payload.startDate,
            ...(endDate ? { endDate } : { endDate: undefined }),
          } as CalendarEvent;
        } else if (payload.kind === "time") {
          const startISO = payload.startISO || "";
          const startMs = Date.parse(startISO);
          if (!startISO || Number.isNaN(startMs)) return prev;
          const endISO = payload.endISO && Date.parse(payload.endISO) > startMs ? payload.endISO : undefined;
          const startTzid = normalizeTimeZone(payload.startTzid) ?? undefined;
          const endTzid = normalizeTimeZone(payload.endTzid) ?? undefined;
          updated = {
            ...existing,
            kind: "time",
            startISO,
            ...(endISO ? { endISO } : { endISO: undefined }),
            ...(startTzid ? { startTzid } : { startTzid: undefined }),
            ...(endTzid ? { endTzid } : { endTzid: undefined }),
          } as CalendarEvent;
        } else {
          return prev;
        }
        updated = {
          ...updated,
          title: payload.title || "Untitled",
          summary: payload.summary,
          description: payload.description || "",
          image: payload.image,
          locations: payload.locations?.length ? payload.locations : undefined,
          geohash: payload.geohash,
          hashtags: payload.hashtags?.length ? payload.hashtags : undefined,
          references: payload.references?.length ? payload.references : undefined,
          ...(payloadCreatedBy ? { createdBy: payloadCreatedBy } : {}),
          ...(payloadLastEditedBy ? { lastEditedBy: payloadLastEditedBy } : {}),
        } as CalendarEvent;
        const copy = prev.slice();
        copy[idx] = updated;
        return copy;
      });
    },
    [setCalendarEvents],
  );

  // header view
  const [view, setView] = useState<"board" | "completed" | "board-upcoming" | "bible">("board");
  const walletEnabled = useWalletEnabled();
  useEffect(() => {
    // Closing the wallet out from its own settings leaves nothing to show on its pages.
    if (walletEnabled) return;
    if (activePage === "wallet" || activePage === "wallet-bounties" || activePage === "wallet-address") {
      startTransition(() => appRouter.navigate(routeForPage("boards", currentBoardId), { replace: true }));
    }
  }, [activePage, appRouter, currentBoardId, walletEnabled]);
  const {
    handleOnboardingRestoreFromBackupFile,
    handleOnboardingStart,
    handleOnboardingUseExistingKey,
    isOnboardingActiveRef,
    showFirstRunOnboarding,
  } = useFirstRunOnboarding({
    activePage,
    applyCustomNostrKey,
    rotateNostrKey,
    setActivePage,
  });
  useEffect(() => {
    if (currentBoard?.kind === "bible") {
      if (view !== "completed") setView("bible");
    } else if (view === "bible") {
      setView("board");
    }
  }, [currentBoard?.kind, view]);
  const showSettings = activePage === "settings";
  const [addBoardOpen, setAddBoardOpen] = useState(false);

  useNostrAppBackupSync({
    bibleTracker,
    bibleTrackerRef,
    boards,
    defaultRelays,
    nostrPK,
    nostrPublishRef,
    nostrSK,
    pool,
    scriptureMemory,
    setBibleTracker,
    setBoards,
    setDefaultRelays,
    setScriptureMemory,
    setSettings,
    settings,
    showSettings,
    showToast,
    tagValue,
  });

  const localInboxResponses = useMemo(
    () => ({ ...collectInboxResponses(tasks), ...collectCalendarInviteResponses(calendarInvites) }),
    [calendarInvites, tasks],
  );
  const pendingInboxIds = useMemo(
    () => [...pendingInboxEventIds(tasks), ...pendingCalendarInviteEventIds(calendarInvites)].sort(),
    [calendarInvites, tasks],
  );
  const applyRemoteInboxResponses = useCallback(
    (responses: Record<string, ChatInboxResponse>) => {
      setTasks((prev) => applyInboxResponsesToTasks(prev, responses));
      const { invites, accepted } = applyInboxResponsesToCalendarInvites(calendarInvitesRef.current, responses);
      if (invites === calendarInvitesRef.current) return;
      calendarInvitesRef.current = invites;
      setCalendarInvites(invites);
      // Another device accepted: show the event here too. Adding it is local; the RSVP was
      // already sent by the device that answered.
      for (const invite of accepted) {
        const status = invite.status === "tentative" ? "tentative" : "accepted";
        void acceptedInviteMaterializerRef.current?.(invite, status);
      }
    },
    [calendarInvitesRef, setCalendarInvites, setTasks],
  );
  useNostrChatStateSync({
    enabled: settings.nostrBackupEnabled,
    defaultRelays,
    nostrPK,
    nostrPublishRef,
    nostrSK,
    pool,
    tagValue,
    localInboxResponses,
    pendingInboxEventIds: pendingInboxIds,
    applyRemoteInboxResponses,
  });

  useNostrSubscriptions({
    sharedInbox: {
      enabled: true,
      ensurePool: ensureInboxPool as unknown as () => SubscribeManyPool,
      handleEvent: handleIncomingShareEvent,
      lookbackSeconds: SHARE_DM_LOOKBACK_SECONDS,
      nostrPK,
      nostrSkHex,
      relays: inboxRelays,
    },
    calendarViews: {
      enabled: true,
      clockRef: calendarViewClockRef,
      defaultRelays,
      events: calendarEvents,
      handleEvent: applyCalendarViewSubscriptionEvent,
      inboxRelays,
      pool,
    },
  });

  const {
    handleReloadLater,
    handleReloadNow,
    handleResetWalletTokenTracking,
    prefetchWalletModal,
    showChat,
    showWalletShell,
    updateToastVisible,
    walletTokenStateResetNonce,
  } = useWalletShellState({
    activePage,
    loadWalletModal: loadCashuWalletModal,
    showToast,
  });
  const shouldReloadForNavigation = useCallback(() => false, []);

  const changeBoard = useCallback(
    (id: string) => {
      if (shouldReloadForNavigation()) return;
      setCurrentBoardIdState(id);
      if (activePage === "boards") appRouter.navigate({ page: "boards", boardId: id });
    },
    [activePage, appRouter, setCurrentBoardIdState, shouldReloadForNavigation],
  );

  const openSettings = useCallback(() => {
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    startTransition(() => setActivePage("settings"));
  }, [shouldReloadForNavigation]);
  const closeSettings = useCallback(() => {
    startTransition(() => setActivePage("boards"));
  }, []);
  const openAddBoard = useCallback(() => {
    if (shouldReloadForNavigation()) return;
    startTransition(() => setAddBoardOpen(true));
  }, [shouldReloadForNavigation]);
  const closeAddBoard = useCallback(() => {
    startTransition(() => setAddBoardOpen(false));
  }, []);

  const openWallet = useCallback(() => {
    if (!walletEnabled) return;
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    prefetchWalletModal();
    startTransition(() => setActivePage("wallet"));
  }, [prefetchWalletModal, shouldReloadForNavigation, walletEnabled]);
  const openWalletBounties = useCallback(() => {
    if (!walletEnabled) return;
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    startTransition(() => setActivePage("wallet-bounties"));
  }, [shouldReloadForNavigation, walletEnabled]);
  const openWalletAddress = useCallback(() => {
    if (!walletEnabled) return;
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    startTransition(() => setActivePage("wallet-address"));
  }, [shouldReloadForNavigation, walletEnabled]);
  const closeWallet = useCallback(() => {
    startTransition(() => setActivePage("boards"));
  }, []);

  const openUpcoming = useCallback(() => {
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    startTransition(() => setActivePage("upcoming"));
  }, [shouldReloadForNavigation]);
  const openBoardsPage = useCallback(() => {
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    if (activePage === "boards") {
      const selector = boardSelectorBottomRef.current ?? boardSelectorRef.current;
      if (selector) {
        const showPicker = (selector as HTMLSelectElement & { showPicker?: () => void }).showPicker;
        if (showPicker) {
          showPicker.call(selector);
        } else {
          selector.click();
        }
      }
      return;
    }
    startTransition(() => setActivePage("boards"));
  }, [activePage, shouldReloadForNavigation]);
  const openChatPage = useCallback(() => {
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    startTransition(() => setActivePage("chat"));
  }, [shouldReloadForNavigation]);

  const openShareBoard = useCallback(() => {
    if (shouldReloadForNavigation()) return;
    if (!currentBoard) return;
    openShareBoardForTarget(currentBoard.id);
  }, [currentBoard, openShareBoardForTarget, shouldReloadForNavigation]);

  const createBoardFromName = useCallback(
    (name: string, type: "lists" | "compound", shared = true) => {
      if (shouldReloadForNavigation()) return null;
      const trimmed = name.trim();
      if (!trimmed) return null;
      const id = crypto.randomUUID();
      const nostrBoardId = shared ? crypto.randomUUID() : undefined;
      const relayList = defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS);
      let board: Board;
      if (type === "compound") {
        board = {
          id,
          name: trimmed,
          kind: "compound",
          children: [],
          archived: false,
          hidden: false,
          clearCompletedDisabled: false,
          indexCardEnabled: false,
          hideChildBoardNames: false,
          ...(nostrBoardId ? { nostr: { boardId: nostrBoardId, relays: relayList } } : {}),
        } as Board;
      } else {
        board = {
          id,
          name: trimmed,
          kind: "lists",
          columns: [{ id: crypto.randomUUID(), name: "List 1" }],
          archived: false,
          hidden: false,
          clearCompletedDisabled: false,
          indexCardEnabled: false,
          ...(nostrBoardId ? { nostr: { boardId: nostrBoardId, relays: relayList } } : {}),
        } as Board;
      }
      setBoards((prev) => withBoardOrder([...prev, board]));
      changeBoard(id);
      if (shared && nostrBoardId) {
        publishBoardMetadataRef.current?.(board).catch(() => {});
      }
      return id;
    },
    [changeBoard, defaultRelays, setBoards, shouldReloadForNavigation],
  );

  const joinSharedBoard = useCallback(
    (nostrId: string, name?: string, relayCsv?: string) => {
      if (shouldReloadForNavigation()) return;
      const relays = (relayCsv || "").split(",").map((s) => s.trim()).filter(Boolean);
      const id = nostrId.trim();
      if (!id) return;
      const defaultCols: ListColumn[] = [{ id: crypto.randomUUID(), name: "Items" }];
      const newBoard: Board = {
        id,
        name: name || "Shared Board",
        kind: "lists",
        columns: defaultCols,
        nostr: { boardId: id, relays: relays.length ? relays : defaultRelays },
        archived: false,
        hidden: false,
        clearCompletedDisabled: false,
        indexCardEnabled: false,
      };
      setBoards((prev) => {
        const existingIndex = prev.findIndex((b) => b.id === id || b.nostr?.boardId === id);
        if (existingIndex >= 0) {
          const existing = prev[existingIndex];
          const columns = existing.kind === "lists" ? existing.columns : newBoard.columns;
          const indexCardEnabled = existing.kind === "lists"
            ? (typeof existing.indexCardEnabled === "boolean" ? existing.indexCardEnabled : newBoard.indexCardEnabled)
            : newBoard.indexCardEnabled;
          const merged: Board = {
            ...newBoard,
            id: existing.id,
            name: name || existing.name || newBoard.name,
            columns,
            archived: false,
            hidden: false,
            clearCompletedDisabled: existing.clearCompletedDisabled ?? newBoard.clearCompletedDisabled,
            indexCardEnabled,
            order: existing.order,
          };
          const copy = prev.slice();
          copy[existingIndex] = merged;
          return copy;
        }
        return withBoardOrder([...prev, newBoard]);
      });
      changeBoard(id);
    },
    [changeBoard, defaultRelays, setBoards, shouldReloadForNavigation],
  );
  const startupViewHandledRef = useRef(false);
  useEffect(() => {
    if (startupViewHandledRef.current) return;
    startupViewHandledRef.current = true;
    // Do not redirect on startup while onboarding is blocking the app.
    if (isOnboardingActiveRef.current) return;
    if (appRouter.initialRouteWasExplicit) return;
    const startupView = settings.startupView;
    if (startupView === "wallet" && !walletEnabled) return;
    if (startupView === "wallet" || startupView === "upcoming" || startupView === "chat") {
      if (startupView === "wallet" || startupView === "chat") {
        prefetchWalletModal();
      }
      startTransition(() => setActivePage(startupView));
    }
  }, [appRouter, prefetchWalletModal, setActivePage, settings.startupView, walletEnabled]);
  const { receiveToken, totalBalance: walletTotalBalance } = useCashu();

  useEffect(() => {
    if (!settings.completedTab) setView("board");
  }, [settings.completedTab]);

  useEffect(() => {
    if (!settings.bibleTrackerEnabled && view === "bible") {
      setView("board");
    }
  }, [settings.bibleTrackerEnabled, view]);

  const handleToggleBibleBook = useCallback((bookId: string) => {
    const normalizedBookId = String(bookId || "");
    if (!normalizedBookId) return;
    setBibleTracker((prev) => {
      const current = prev.expandedBooks || {};
      const nextExpanded = { ...current };
      const wasExpanded = !!nextExpanded[normalizedBookId];
      if (wasExpanded) {
        delete nextExpanded[normalizedBookId];
      } else {
        nextExpanded[normalizedBookId] = true;
      }
      if (wasExpanded === !!nextExpanded[normalizedBookId]) {
        return prev;
      }
      return { ...prev, expandedBooks: nextExpanded };
    });
  }, [setBibleTracker]);

  const handleToggleBibleChapter = useCallback((bookId: string, chapter: number) => {
    const normalizedBookId = String(bookId || "");
    const normalizedChapter = Number.isFinite(chapter) ? Math.trunc(chapter) : NaN;
    if (!normalizedBookId || !Number.isFinite(normalizedChapter) || normalizedChapter <= 0) return;
    setBibleTracker((prev) => {
      const previousChapters = prev.progress[normalizedBookId] ?? [];
      const alreadyChecked = previousChapters.includes(normalizedChapter);
      let nextChapters: number[];

      if (alreadyChecked) {
        nextChapters = previousChapters.filter((value) => value !== normalizedChapter);
      } else {
        nextChapters = [...previousChapters, normalizedChapter];
      }

      if (nextChapters.length === previousChapters.length) {
        return prev;
      }

      if (nextChapters.length > 1) {
        nextChapters.sort((a, b) => a - b);
      }

      const nextProgress = { ...prev.progress };
      if (nextChapters.length === 0) {
        delete nextProgress[normalizedBookId];
      } else {
        nextProgress[normalizedBookId] = nextChapters;
      }

      let nextVerses = prev.verses;
      const existingChapterVerses = prev.verses?.[normalizedBookId]?.[normalizedChapter];
      if (existingChapterVerses || alreadyChecked) {
        const updatedVerses = { ...prev.verses } as typeof prev.verses;
        const chapterMap = { ...(updatedVerses[normalizedBookId] || {}) };
        if (chapterMap[normalizedChapter]) {
          delete chapterMap[normalizedChapter];
        }
        if (Object.keys(chapterMap).length === 0) {
          delete updatedVerses[normalizedBookId];
        } else {
          updatedVerses[normalizedBookId] = chapterMap;
        }
        nextVerses = updatedVerses;
      }

      const totalChapters = getBibleBookChapterCount(normalizedBookId) ?? 0;
      let nextCompletedBooks = prev.completedBooks;
      if (totalChapters <= 0 || nextChapters.length < totalChapters) {
        if (prev.completedBooks?.[normalizedBookId]) {
          const updated = { ...prev.completedBooks };
          delete updated[normalizedBookId];
          nextCompletedBooks = updated;
        }
      }

      const didChangeProgress = nextProgress !== prev.progress;
      const didChangeVerses = nextVerses !== prev.verses;
      const didChangeCompleted = nextCompletedBooks !== prev.completedBooks;

      if (!didChangeProgress && !didChangeVerses && !didChangeCompleted) {
        return prev;
      }

      const base = { ...prev };
      if (didChangeProgress) base.progress = nextProgress;
      if (didChangeVerses) base.verses = nextVerses;
      if (didChangeCompleted) base.completedBooks = nextCompletedBooks;
      return base;
    });
  }, [setBibleTracker]);

  const handleUpdateBibleChapterVerses = useCallback((bookId: string, chapter: number, verses: number[], verseCount: number) => {
    const normalizedBookId = String(bookId || "");
    const normalizedChapter = Number.isFinite(chapter) ? Math.trunc(chapter) : NaN;
    if (!normalizedBookId || !Number.isFinite(normalizedChapter) || normalizedChapter <= 0) return;
    setBibleTracker((prev) => {
      const chapterLimit = Math.min(
        Math.max(getBibleChapterVerseCount(normalizedBookId, normalizedChapter) ?? MAX_VERSE_COUNT, 1),
        MAX_VERSE_COUNT
      );
      const normalizedVerses = Array.from(
        new Set(
          (Array.isArray(verses) ? verses : [])
            .map((value) => (typeof value === "number" ? Math.trunc(value) : NaN))
            .filter((value) => Number.isFinite(value) && value > 0 && value <= chapterLimit)
        )
      ).sort((a, b) => a - b);

      const normalizedCount = Number.isFinite(verseCount)
        ? Math.min(Math.max(Math.trunc(verseCount), 0), chapterLimit)
        : 0;
      const effectiveCount = normalizedCount > 0 ? normalizedCount : 0;
      const filteredVerses = effectiveCount > 0 ? normalizedVerses.filter((value) => value <= effectiveCount) : normalizedVerses;

      let nextVerses = prev.verses;
      const prevBookVerses = prev.verses?.[normalizedBookId];
      const prevChapterVerses = prevBookVerses?.[normalizedChapter] ?? [];
      if (filteredVerses.length > 0) {
        const updatedBookVerses = { ...(prevBookVerses || {}) };
        updatedBookVerses[normalizedChapter] = filteredVerses;
        const updatedVerses = { ...prev.verses, [normalizedBookId]: updatedBookVerses };
        nextVerses = updatedVerses;
      } else if (prevChapterVerses.length > 0 || prevBookVerses) {
        const updatedBookVerses = { ...(prevBookVerses || {}) };
        if (updatedBookVerses[normalizedChapter]) {
          delete updatedBookVerses[normalizedChapter];
        }
        const updatedVerses = { ...prev.verses } as typeof prev.verses;
        if (Object.keys(updatedBookVerses).length === 0) {
          delete updatedVerses[normalizedBookId];
        } else {
          updatedVerses[normalizedBookId] = updatedBookVerses;
        }
        nextVerses = updatedVerses;
      }

      let nextVerseCounts = prev.verseCounts;
      const prevBookCounts = prev.verseCounts?.[normalizedBookId];
      const prevChapterCount = prevBookCounts?.[normalizedChapter];
      if (effectiveCount > 0) {
        const updatedBookCounts = { ...(prevBookCounts || {}) };
        updatedBookCounts[normalizedChapter] = effectiveCount;
        nextVerseCounts = { ...prev.verseCounts, [normalizedBookId]: updatedBookCounts };
      } else if (prevChapterCount) {
        const updatedBookCounts = { ...(prevBookCounts || {}) };
        delete updatedBookCounts[normalizedChapter];
        const updatedCounts = { ...prev.verseCounts } as typeof prev.verseCounts;
        if (Object.keys(updatedBookCounts).length === 0) {
          delete updatedCounts[normalizedBookId];
        } else {
          updatedCounts[normalizedBookId] = updatedBookCounts;
        }
        nextVerseCounts = updatedCounts;
      }

      let nextProgress = prev.progress;
      const previousChapters = prev.progress[normalizedBookId] ?? [];
      const hasChapter = previousChapters.includes(normalizedChapter);

      const shouldComplete = effectiveCount > 0 && filteredVerses.length === effectiveCount && effectiveCount > 0;
      if (shouldComplete) {
        if (!hasChapter) {
          const updatedChapters = [...previousChapters, normalizedChapter].sort((a, b) => a - b);
          nextProgress = { ...prev.progress, [normalizedBookId]: updatedChapters };
        }
        const bookVerses = nextVerses?.[normalizedBookId];
        if (bookVerses?.[normalizedChapter]) {
          const updatedBookVerses = { ...bookVerses };
          delete updatedBookVerses[normalizedChapter];
          const updatedVerses = { ...nextVerses } as typeof nextVerses;
          if (Object.keys(updatedBookVerses).length === 0) {
            delete updatedVerses[normalizedBookId];
          } else {
            updatedVerses[normalizedBookId] = updatedBookVerses;
          }
          nextVerses = updatedVerses;
        }
      } else if (hasChapter) {
        const updatedChapters = previousChapters.filter((value) => value !== normalizedChapter);
        const updatedProgress = { ...prev.progress };
        if (updatedChapters.length === 0) {
          delete updatedProgress[normalizedBookId];
        } else {
          updatedProgress[normalizedBookId] = updatedChapters;
        }
        nextProgress = updatedProgress;
      }

      const totalChapters = getBibleBookChapterCount(normalizedBookId) ?? 0;
      let nextCompletedBooks = prev.completedBooks;
      const chapterTotal = Array.isArray(nextProgress[normalizedBookId])
        ? nextProgress[normalizedBookId].length
        : 0;
      if (totalChapters <= 0 || chapterTotal < totalChapters) {
        if (prev.completedBooks?.[normalizedBookId]) {
          const updated = { ...prev.completedBooks };
          delete updated[normalizedBookId];
          nextCompletedBooks = updated;
        }
      }

      const didChangeVerses = nextVerses !== prev.verses;
      const didChangeCounts = nextVerseCounts !== prev.verseCounts;
      const didChangeProgress = nextProgress !== prev.progress;
      const didChangeCompleted = nextCompletedBooks !== prev.completedBooks;

      if (!didChangeVerses && !didChangeCounts && !didChangeProgress && !didChangeCompleted) {
        return prev;
      }

      return {
        ...prev,
        ...(didChangeProgress ? { progress: nextProgress } : {}),
        ...(didChangeVerses ? { verses: nextVerses } : {}),
        ...(didChangeCounts ? { verseCounts: nextVerseCounts } : {}),
        ...(didChangeCompleted ? { completedBooks: nextCompletedBooks } : {}),
      };
    });
  }, [setBibleTracker]);

  const handleOpenBiblePrint = useCallback(() => {
    const meta: BiblePrintMeta = {
      id: crypto.randomUUID(),
      printedAtISO: new Date().toISOString(),
    };
    setBiblePrintMeta(meta);
    setBiblePrintOpen(true);
  }, []);

  const handleBiblePaperSizeChange = useCallback((paperSize: PrintPaperSize) => {
    setBiblePrintPaperSize(paperSize);
  }, []);

  const openOrSharePdf = useCallback(async (blob: Blob, fileName: string, title: string) => {
    if (typeof window === "undefined") return;
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
      canShare?: (data: ShareData) => boolean;
    };

    try {
      const file = new File([blob], fileName, { type: "application/pdf" });
      if (typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title });
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
        }
        return;
      }
    } catch {}

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.rel = "noopener";
    anchor.target = "_blank";
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  const sanitizeFileNamePart = useCallback((value: string) => {
    const cleaned = String(value || "").trim().replace(/[^a-z0-9]+/gi, "-");
    return cleaned.replace(/^-+|-+$/g, "") || "print";
  }, []);

  const handlePrintBibleWindow = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!biblePrintMeta || !biblePrintPortal) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      showToast("Popup blocked. Allow popups to print.", 3000);
      return;
    }
    try {
      printWindow.opener = null;
    } catch {}
    const { buildBiblePrintLayout } = await import("./components/BibleTrackerPrintLayout");
    const layout = buildBiblePrintLayout(biblePrintPaperSize);
    const pageWidthMm = layout.page.widthMm;
    const pageHeightMm = layout.page.heightMm;
    const printCss = `
      * { box-sizing: border-box; }
      @page { size: ${pageWidthMm}mm ${pageHeightMm}mm; margin: 0; }
      html, body { margin: 0; padding: 0; background: #ffffff; color: #101828; height: auto; overflow: visible; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .bible-print-root { width: 100%; }
      .bible-print-controls { display: none; }
      .bible-print-pages { display: block; }
      .bible-print-page {
        position: relative;
        width: ${pageWidthMm}mm;
        height: ${pageHeightMm}mm;
        margin: 0;
        background: #ffffff;
        color: #101828;
        page-break-after: always;
        break-after: page;
      }
      .bible-print-marker {
        position: absolute;
        background: #101828;
        border-radius: 2px;
        overflow: hidden;
      }
      .bible-print-marker[data-marker-style="finder"]::after {
        content: "";
        position: absolute;
        width: 45%;
        height: 45%;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: #ffffff;
        border-radius: 1px;
      }
      .bible-print-page-id__bit {
        position: absolute;
        border-radius: 0.4mm;
        border: 0.2mm solid rgba(16, 24, 40, 0.2);
        background: #ffffff;
      }
      .bible-print-page-id__bit[data-filled="true"] {
        background: #101828;
        border-color: #101828;
      }
      .bible-print-header {
        position: absolute;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.75rem;
      }
      .bible-print-header__left { display: flex; flex-direction: column; gap: 0.1rem; }
      .bible-print-header__title { font-size: 8.5pt; font-weight: 600; }
      .bible-print-header__meta { font-size: 7pt; color: rgba(16, 24, 40, 0.72); }
      .bible-print-header__right { text-align: right; font-size: 7pt; color: rgba(16, 24, 40, 0.72); }
      .bible-print-header__page { font-weight: 600; color: #101828; }
      .bible-print-book { position: absolute; font-size: 7pt; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bible-print-root[data-paper-size="a6"] .bible-print-book { font-size: 6.5pt; line-height: 1; }
      .bible-print-box {
        position: absolute;
        box-sizing: border-box;
        border: 0.3mm solid #1f2937;
        border-radius: 0.6mm;
        background: #ffffff;
      }
      .bible-print-box[data-filled="true"] {
        background: #101828;
        border-color: #101828;
      }
      .bible-print-box-number {
        position: absolute;
        top: 0.1mm;
        left: 0.2mm;
        font-size: 5pt;
        line-height: 1;
        color: rgba(16, 24, 40, 0.7);
      }
      .bible-print-root[data-paper-size="a6"] .bible-print-box-number { font-size: 4.6pt; }
      .bible-print-box[data-filled="true"] .bible-print-box-number {
        color: rgba(255, 255, 255, 0.8);
      }
      @media print {
        .bible-print-page:last-child { break-after: auto; page-break-after: auto; }
      }
    `;
    const markup = biblePrintPortal.innerHTML;
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Bible tracker print</title><style>${printCss}</style></head><body>${markup}</body></html>`);
    printWindow.document.close();
    const triggerPrint = () => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch {}
    };
    if (printWindow.document.readyState === "complete") {
      setTimeout(triggerPrint, 80);
    } else {
      printWindow.addEventListener("load", () => setTimeout(triggerPrint, 80), { once: true });
    }
    printWindow.addEventListener("afterprint", () => {
      printWindow.close();
    }, { once: true });
  }, [biblePrintMeta, biblePrintPaperSize, biblePrintPortal, showToast]);

  const handleExportBiblePdf = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!biblePrintMeta) return;
    if (biblePrintPdfBusy) return;
    setBiblePrintPdfBusy(true);
    try {
      const { buildBibleTrackerPrintPdf } = await import("./lib/printPdf");
      const blob = await buildBibleTrackerPrintPdf({
        state: bibleTrackerRef.current,
        meta: biblePrintMeta,
        paperSize: biblePrintPaperSize,
      });
      const fileName = `taskify-bible-tracker-${sanitizeFileNamePart(biblePrintPaperSize)}-${biblePrintMeta.id.slice(0, 8)}.pdf`;
      await openOrSharePdf(blob, fileName, "Bible tracker print");
    } catch (err) {
      console.warn("Failed to generate Bible tracker PDF", err);
      showToast("Failed to generate PDF. Try again.", 3000);
    } finally {
      setBiblePrintPdfBusy(false);
    }
  }, [biblePrintMeta, biblePrintPaperSize, biblePrintPdfBusy, openOrSharePdf, sanitizeFileNamePart, showToast]);

  const handleOpenBibleScan = useCallback(() => {
    setBibleScanOpen(true);
  }, []);

  const handleApplyBibleScan = useCallback((scanProgress: BibleTrackerProgress) => {
    if (!scanProgress || Object.keys(scanProgress).length === 0) {
      showToast("No chapters detected in the scan.", 2500);
      return;
    }
    let addedCount = 0;
    setBibleTracker((prev) => {
      let nextProgress = prev.progress;
      let nextVerses = prev.verses;
      let progressChanged = false;
      let versesChanged = false;

      for (const [bookIdRaw, chaptersRaw] of Object.entries(scanProgress)) {
        const normalizedBookId = String(bookIdRaw || "");
        const chapterTotal = getBibleBookChapterCount(normalizedBookId) ?? 0;
        if (!chapterTotal || !Array.isArray(chaptersRaw)) continue;
        const cleaned = Array.from(
          new Set(
            chaptersRaw
              .map((value) => (typeof value === "number" ? Math.trunc(value) : NaN))
              .filter((value) => Number.isFinite(value) && value > 0 && value <= chapterTotal)
          )
        ).sort((a, b) => a - b);
        if (cleaned.length === 0) continue;

        const existing = prev.progress[normalizedBookId] ?? [];
        const existingSet = new Set(existing);
        const merged = [...existing];
        const newlyAdded: number[] = [];

        for (const chapter of cleaned) {
          if (!existingSet.has(chapter)) {
            existingSet.add(chapter);
            merged.push(chapter);
            newlyAdded.push(chapter);
          }
        }

        if (newlyAdded.length === 0) continue;
        merged.sort((a, b) => a - b);

        if (nextProgress === prev.progress) {
          nextProgress = { ...prev.progress };
        }
        nextProgress[normalizedBookId] = merged;
        progressChanged = true;
        addedCount += newlyAdded.length;

        if (newlyAdded.length > 0) {
          const bookVerses = nextVerses?.[normalizedBookId];
          if (bookVerses) {
            const updatedBookVerses = { ...bookVerses };
            let bookChanged = false;
            for (const chapter of newlyAdded) {
              if (updatedBookVerses[chapter]) {
                delete updatedBookVerses[chapter];
                bookChanged = true;
              }
            }
            if (bookChanged) {
              if (!versesChanged) {
                nextVerses = { ...prev.verses };
                versesChanged = true;
              }
              if (Object.keys(updatedBookVerses).length === 0) {
                delete nextVerses[normalizedBookId];
              } else {
                nextVerses[normalizedBookId] = updatedBookVerses;
              }
            }
          }
        }
      }

      if (!progressChanged && !versesChanged) {
        return prev;
      }
      return {
        ...prev,
        ...(progressChanged ? { progress: nextProgress } : {}),
        ...(versesChanged ? { verses: nextVerses } : {}),
      };
    });
    if (addedCount > 0) {
      showToast(`Added ${addedCount} chapter${addedCount === 1 ? "" : "s"} from scan.`, 2500);
    } else {
      showToast("No new chapters detected.", 2500);
    }
  }, [setBibleTracker, showToast]);

  const handleResetBibleTracker = useCallback(() => {
    let confirmed = true;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      confirmed = window.confirm("Reset your Bible reading progress? This archives your current progress and clears the tracker.");
    }
    if (!confirmed) return;
    setBibleTracker((prev) => {
      const nowISO = new Date().toISOString();
      const snapshot = {
        id: crypto.randomUUID(),
        savedAtISO: nowISO,
        lastResetISO: prev.lastResetISO,
        progress: cloneBibleProgress(prev.progress),
        verses: cloneBibleVerses(prev.verses),
        verseCounts: cloneBibleVerseCounts(prev.verseCounts),
        completedBooks: cloneBibleCompletedBooks(prev.completedBooks),
      };
      return {
        ...prev,
        lastResetISO: nowISO,
        progress: {},
        verses: {},
        verseCounts: {},
        completedBooks: {},
        archive: [snapshot, ...prev.archive],
        expandedBooks: {},
      };
    });
  }, [setBibleTracker]);

  const handleDeleteBibleArchive = useCallback((archiveId: string) => {
    if (!archiveId) return;
    let confirmed = true;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      confirmed = window.confirm("Delete this archived progress snapshot?");
    }
    if (!confirmed) return;
    setBibleTracker((prev) => {
      const nextArchive = prev.archive.filter((entry) => entry.id !== archiveId);
      if (nextArchive.length === prev.archive.length) return prev;
      return { ...prev, archive: nextArchive };
    });
  }, [setBibleTracker]);

  const handleRestoreBibleArchive = useCallback((archiveId: string) => {
    if (!archiveId) return;
    let confirmed = true;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      confirmed = window.confirm("Restore this archived Bible reading progress? This will replace your current progress.");
    }
    if (!confirmed) return;
    setBibleTracker((prev) => {
      const entry = prev.archive.find((item) => item.id === archiveId);
      if (!entry) return prev;
      return {
        ...prev,
        lastResetISO: entry.lastResetISO,
        progress: cloneBibleProgress(entry.progress),
        verses: cloneBibleVerses(entry.verses),
        verseCounts: cloneBibleVerseCounts(entry.verseCounts),
        completedBooks: cloneBibleCompletedBooks(entry.completedBooks),
        expandedBooks: {},
      };
    });
  }, [setBibleTracker]);

  const handleCompleteBibleBook = useCallback(
    (bookId: string, rect?: DOMRect | null) => {
      const normalizedBookId = String(bookId || "");
      if (!normalizedBookId) return;
      let didComplete = false;
      setBibleTracker((prev) => {
        const totalChapters = getBibleBookChapterCount(normalizedBookId) ?? 0;
        if (totalChapters <= 0) return prev;
        const chaptersRead = prev.progress[normalizedBookId] ?? [];
        if (!Array.isArray(chaptersRead) || chaptersRead.length < totalChapters) {
          return prev;
        }
        if (prev.completedBooks?.[normalizedBookId]) {
          return prev;
        }
        const nextCompletedBooks = {
          ...prev.completedBooks,
          [normalizedBookId]: { completedAtISO: new Date().toISOString() },
        };
        const nextExpanded = { ...prev.expandedBooks };
        if (nextExpanded[normalizedBookId]) {
          delete nextExpanded[normalizedBookId];
        }
        didComplete = true;
        return { ...prev, completedBooks: nextCompletedBooks, expandedBooks: nextExpanded };
      });
      if (didComplete && rect && settings.completedTab) {
        try {
          flyToCompleted(rect);
        } catch {}
      }
    },
    [setBibleTracker, settings.completedTab]
  );

  const handleRestoreBibleBook = useCallback((bookId: string) => {
    const normalizedBookId = String(bookId || "");
    if (!normalizedBookId) return;
    setBibleTracker((prev) => {
      if (!prev.completedBooks?.[normalizedBookId]) return prev;
      const nextCompletedBooks = { ...prev.completedBooks };
      delete nextCompletedBooks[normalizedBookId];
      return { ...prev, completedBooks: nextCompletedBooks };
    });
  }, [setBibleTracker]);

  const {
    chatPushBusy,
    disableChatPush,
    disablePushNotifications,
    enableChatPush,
    enablePushNotifications,
    pushError,
    pushWorkState,
    reminderPayloadRef,
    setPushError,
  } = usePushNotifications({ settings, setSettings, workerBaseUrl, vapidPublicKey, defaultRelays, nostrPublish });
  const [inlineTitles, setInlineTitles] = useState<Record<string, string>>({});
  const [addMenuKey, setAddMenuKey] = useState<string | null>(null);
  const [voiceDictationKey, setVoiceDictationKey] = useState<string | null>(null);
  const [pendingFocusColumnId, setPendingFocusColumnId] = useState<string | null>(null);
  const [renamingColumnId, setRenamingColumnId] = useState<string | null>(null);
  const [columnDrafts, setColumnDrafts] = useState<Record<string, string>>({});
  const [newColumnIds, setNewColumnIds] = useState<Record<string, boolean>>({});
  const columnNameInputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());
  const setColumnNameInputRef = useCallback((colId: string, el: HTMLInputElement | null) => {
    columnNameInputRefs.current.set(colId, el);
  }, []);
  useEffect(() => {
    setRenamingColumnId(null);
    setColumnDrafts({});
    setNewColumnIds({});
  }, [currentBoard?.id]);
  useEffect(() => {
    if (!renamingColumnId) return;
    const input = columnNameInputRefs.current.get(renamingColumnId);
    if (!input) return;
    const timeout = window.setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
    return () => window.clearTimeout(timeout);
  }, [renamingColumnId]);
  const [previewDocument, setPreviewDocument] = useState<TaskDocument | null>(null);
  const [previewDocumentBoardId, setPreviewDocumentBoardId] = useState<string | undefined>(undefined);
  const handleDownloadDocument = useCallback(async (doc: TaskDocument, boardId?: string) => {
    if (typeof window === "undefined") return;
    try {
      let sourceUrl = doc.dataUrl;
      if (!sourceUrl && doc.remoteUrl) {
        sourceUrl = doc.encrypted && boardId
          ? await decryptAttachment({ boardId, url: doc.remoteUrl, mimeType: doc.mimeType })
          : doc.remoteUrl;
      }
      if (!sourceUrl) throw new Error("Missing document source");
      const response = await fetch(sourceUrl);
      const blob = await response.blob();
      const fileName =
        doc.name ||
        `attachment.${doc.kind === "docx" ? "docx" : doc.kind === "xlsx" ? "xlsx" : doc.kind}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      showToast("Failed to download document. Try opening it in a new tab.");
    }
  }, [showToast]);

  const openDocumentPreview = useCallback((doc: TaskDocument, boardId?: string) => {
    setPreviewDocument(doc);
    setPreviewDocumentBoardId(boardId);
  }, []);
  const handleOpenDocument = useCallback((task: Task, doc: TaskDocument) => {
    openDocumentPreview(doc, task.boardId);
  }, [openDocumentPreview]);
  const handleOpenEventDocument = useCallback((doc: TaskDocument, boardId?: string) => {
    openDocumentPreview(doc, boardId);
  }, [openDocumentPreview]);

  function handleBoardChanged(boardId: string, options?: { board?: Board; republishTasks?: boolean }) {
    const board = options?.board ?? boards.find((x) => x.id === boardId);
    if (!board) return;
    publishBoardMetadataRef.current?.(board).catch(() => {});
    if (options?.republishTasks) {
      tasks
        .filter((t) => t.boardId === boardId)
        .forEach((t) => {
          maybePublishTaskRef.current?.(t, board, { skipBoardMetadata: true, republish: true }).catch(() => {});
        });
      calendarEvents
        .filter((ev) => ev.boardId === boardId)
        .forEach((ev) => {
          maybePublishCalendarEventRef.current?.(ev, board, { skipBoardMetadata: true, republish: true }).catch(() => {});
        });
    }
  }

  /** Stops sending a board's queued republish to public relays; it still goes to Taskify's relays. */
  async function clearQueuedRepublish(boardId: string): Promise<number> {
    const board = boards.find((x) => x.id === boardId);
    if (!board?.nostr) return 0;
    const session = await NostrSession.init(getBoardRelays(board));
    return session.publisher.limitQueuedRepublish(boardTag(board.nostr.boardId));
  }

  function addListColumn(boardId: string, name?: string): string | null {
    const board = boards.find((b) => b.id === boardId);
    if (!board || board.kind !== "lists") return null;
    const colName = name?.trim() ? name.trim() : `List ${board.columns.length + 1}`;
    const col: ListColumn = { id: crypto.randomUUID(), name: colName };
    const updated: Board = { ...board, columns: [...board.columns, col] };
    setBoards((prev) => prev.map((b) => (b.id === boardId ? updated : b)));
    if (updated.nostr) {
      setTimeout(() => handleBoardChanged(updated.id, { board: updated }), 0);
    }
    return col.id;
  }

  function renameListColumn(boardId: string, columnId: string, name: string): boolean {
    const board = boards.find((b) => b.id === boardId);
    if (!board || board.kind !== "lists") return false;
    const trimmed = name.trim() || undefined;
    let didChange = false;
    const updated: Board = {
      ...board,
      columns: board.columns.map((col) => {
        if (col.id !== columnId) return col;
        const nextName = trimmed ?? col.name;
        if (nextName === col.name) return col;
        didChange = true;
        return { ...col, name: nextName };
      }),
    };
    if (!didChange) return true;
    setBoards((prev) => prev.map((b) => (b.id === boardId ? updated : b)));
    if (updated.nostr) {
      setTimeout(() => handleBoardChanged(updated.id, { board: updated }), 0);
    }
    return true;
  }

  const clearColumnEditingState = useCallback((columnId: string) => {
    setRenamingColumnId((prev) => (prev === columnId ? null : prev));
    setColumnDrafts((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
  }, []);

  function removeListColumn(boardId: string, columnId: string) {
    const board = boards.find((b) => b.id === boardId);
    if (!board || board.kind !== "lists") return;
    const updatedColumns = board.columns.filter((col) => col.id !== columnId);
    if (updatedColumns.length === board.columns.length) return;
    const updatedBoard: Board = { ...board, columns: updatedColumns };
    setBoards((prev) => prev.map((b) => (b.id === boardId ? updatedBoard : b)));
    setTasks((prev) => prev.filter((task) => !(task.boardId === boardId && task.columnId === columnId)));
    setNewColumnIds((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
    clearColumnEditingState(columnId);
    if (updatedBoard.nostr) {
      setTimeout(() => handleBoardChanged(updatedBoard.id, { board: updatedBoard }), 0);
    }
  }

  function selectBoard(boardId: string) {
    if (shouldReloadForNavigation()) return;
    if (boardId === ADD_BOARD_OPTION_ID) {
      openAddBoard();
      return;
    }
    if (boardId === BIBLE_BOARD_ID) {
      if (view !== "completed") setView("bible");
    } else if (view === "bible") {
      setView("board");
    }
    changeBoard(boardId);
  }

  function handleBoardSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    selectBoard(e.target.value);
  }

  /** A board chosen in the desktop rail opens it, from any page. */
  function openBoardFromRail(boardId: string) {
    if (isOnboardingActiveRef.current) return;
    selectBoard(boardId);
    if (activePage !== "boards") startTransition(() => appRouter.navigate({ page: "boards", boardId }));
  }

  /** Tasks dropped on a board (in the rail or the header's drop menu) move there. */
  function dropTasksOnBoard(boardId: string, dataTransfer: DataTransfer) {
    if (!draggingTaskId) return;
    const allIds = getDraggedTaskIds(dataTransfer);
    if (allIds && allIds.length > 1) {
      allIds.forEach((taskId) => moveTaskToBoard(taskId, boardId));
      if (isSelectionMode) exitSelectionMode();
    } else {
      moveTaskToBoard(draggingTaskId, boardId);
    }
    handleDragEnd();
  }

  function handleQuickAddList() {
    if (!currentBoard || currentBoard.kind !== "lists") return;
    const createdId = addListColumn(currentBoard.id, undefined);
    if (createdId) {
      setPendingFocusColumnId(createdId);
      const nextName = `List ${currentBoard.columns.length + 1}`;
      setColumnDrafts((prev) => ({ ...prev, [createdId]: nextName }));
      setNewColumnIds((prev) => ({ ...prev, [createdId]: true }));
      setRenamingColumnId(createdId);
      showToast("List added");
    } else {
      showToast("Failed to add list. Try again.");
    }
  }

	  // undo snackbar
	  const [undoTask, setUndoTask] = useState<Task | null>(null);
	  const [recurringDeleteTask, setRecurringDeleteTask] = useState<Task | null>(null);
	  const [recurringDeleteEvent, setRecurringDeleteEvent] = useState<CalendarEvent | null>(null);

  const addTaskToBountyList = useCallback((taskId: string) => {
    const pinnedKey = PINNED_BOUNTY_LIST_KEY;
    setTasks((prev) => {
      let changed = false;
      const next = prev.map((task) => {
        if (task.id !== taskId) return task;
        const updated = withTaskAddedToBountyList(task, pinnedKey);
        if (updated !== task) changed = true;
        return updated;
      });
      return changed ? next : prev;
    });
    setEditing((prev) => {
      if (!prev || prev.type !== "task" || prev.task.id !== taskId) return prev;
      const updatedTask = withTaskAddedToBountyList(prev.task, pinnedKey);
      return updatedTask === prev.task ? prev : { ...prev, task: updatedTask };
    });
  }, [setTasks]);

  const removeTaskFromBountyList = useCallback((taskId: string) => {
    const pinnedKey = PINNED_BOUNTY_LIST_KEY;
    setTasks((prev) => {
      let changed = false;
      const next = prev.map((task) => {
        if (task.id !== taskId) return task;
        const updated = withTaskRemovedFromBountyList(task, pinnedKey);
        if (updated !== task) changed = true;
        return updated;
      });
      return changed ? next : prev;
    });
    setEditing((prev) => {
      if (!prev || prev.type !== "task" || prev.task.id !== taskId) return prev;
      const updatedTask = withTaskRemovedFromBountyList(prev.task, pinnedKey);
      return updatedTask === prev.task ? prev : { ...prev, task: updatedTask };
    });
  }, [setTasks]);

  // drag-and-drop UI state (see ui/dnd/useDragAndDrop.ts)
  const {
    draggingTaskId,
    draggingEventId,
    trashHover,
    upcomingHover,
    boardDropOpen,
    boardDropPos,
    boardDropTimer,
    setDraggingTaskId,
    setDraggingEventId,
    setTrashHover,
    setUpcomingHover,
    setBoardDropOpen,
    setBoardDropPos,
    handleDragEnd,
    scheduleBoardDropClose,
    cancelBoardDropClose,
  } = useDragAndDrop();
  const { boardSort, boardSortSheetOpen, selectBoardSort, setBoardSortSheetOpen } = useBoardSort();
  const upcomingPreferences = useUpcomingPreferences();
  // Where the lazily loaded Upcoming page puts its header actions and bottom controls.
  const [upcomingHeaderSlot, setUpcomingHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [upcomingFooterSlot, setUpcomingFooterSlot] = useState<HTMLDivElement | null>(null);

  /** Upcoming's "+": a new task due on the day shown, on the current board or the first one that takes tasks. */
  const openNewTaskForDate = useCallback((dateKey: string) => {
    if (shouldReloadForNavigation()) return;
    const fallbackBoard =
      (currentBoard && currentBoard.kind !== "bible" && currentBoard.kind !== "compound" ? currentBoard : null) ||
      visibleBoards.find((board) => board.kind !== "bible" && board.kind !== "compound") ||
      null;
    if (!fallbackBoard) {
      showToast("Create a board first.");
      return;
    }
    if (fallbackBoard.kind === "lists" && fallbackBoard.columns.length === 0) {
      showToast("Add a list to this board first.");
      return;
    }
    const dueISO = isoFromDateTime(dateKey);
    const dueDateEnabled = true;
    const nextOrder = nextOrderForBoard(fallbackBoard.id, tasks, settings.newTaskPosition);
    const draft: Task = {
      id: crypto.randomUUID(),
      boardId: fallbackBoard.id,
      createdBy: nostrPK || undefined,
      lastEditedBy: nostrPK || undefined,
      title: "",
      createdAt: Date.now(),
      dueISO,
      dueDateEnabled,
      completed: false,
      order: nextOrder,
      ...(fallbackBoard.kind === "lists"
        ? { columnId: fallbackBoard.columns[0]?.id }
        : fallbackBoard.kind === "week"
          ? { column: "day" }
          : {}),
    };
    setEditing({ type: "task", originalType: "task", originalId: draft.id, task: draft });
  }, [currentBoard, nostrPK, settings.newTaskPosition, shouldReloadForNavigation, showToast, tasks, visibleBoards]);

  // fly-to-completed overlay + target
  const flyLayerRef = useRef<HTMLDivElement>(null);
  const completedTabRef = useRef<HTMLButtonElement>(null);
  const appContentRef = useRef<HTMLDivElement>(null);
  // wallet button target for coin animation
  const boardSelectorRef = useRef<HTMLSelectElement>(null);
  const boardSelectorBottomRef = useRef<HTMLSelectElement>(null);
  const walletButtonRef = useRef<HTMLButtonElement>(null);
  const boardDropContainerRef = useRef<HTMLDivElement>(null);
  const boardDropListRef = useRef<HTMLDivElement>(null);
  const upcomingButtonRef = useRef<HTMLButtonElement>(null);
  const inlineInputRefs = useRef(new Map<string, HTMLInputElement>());


  const setInlineInputRef = useCallback((key: string, el: HTMLInputElement | null) => {
    if (el) inlineInputRefs.current.set(key, el);
    else inlineInputRefs.current.delete(key);
  }, []);

  // Custom list boards (including compound boards aggregating multiple lists)
  const { listColumns, listColumnSources, compoundIndexGroups } = useMemo(() => {
    const sourceMap = new Map<string, { boardId: string; columnId: string; boardName: string }>();
    if (!isListLikeBoard(currentBoard)) {
      return {
        listColumns: [] as ListColumn[],
        listColumnSources: sourceMap,
        compoundIndexGroups: [] as CompoundIndexGroup[],
      };
    }
    if (currentBoard.kind === "lists") {
      currentBoard.columns.forEach((col) => {
        sourceMap.set(col.id, { boardId: currentBoard.id, columnId: col.id, boardName: currentBoard.name });
      });
      return {
        listColumns: currentBoard.columns,
        listColumnSources: sourceMap,
        compoundIndexGroups: [] as CompoundIndexGroup[],
      };
    }
    const hideChildNames = currentBoard.kind === "compound" && currentBoard.hideChildBoardNames;
    const columns: ListColumn[] = [];
    const groups: CompoundIndexGroup[] = [];
    const groupMap = new Map<string, CompoundIndexGroup>();
    const processedChildren = new Set<string>();
    for (const childId of currentBoard.children) {
      const child = findBoardByCompoundChildId(boards, childId);
      if (!child || child.kind !== "lists") continue;
      if (processedChildren.has(child.id)) {
        continue;
      }
      processedChildren.add(child.id);
      let group = groupMap.get(child.id);
      if (!group) {
        group = {
          key: child.id,
          boardId: child.id,
          boardName: child.name,
          columns: [],
        };
        groupMap.set(child.id, group);
        groups.push(group);
      }
      for (const col of child.columns) {
        const title = hideChildNames ? col.name : `${child.name} • ${col.name}`;
        const canonicalKey = compoundColumnKey(child.id, col.id);
        if (!sourceMap.has(canonicalKey)) {
          columns.push({ id: canonicalKey, name: title });
        }
        sourceMap.set(canonicalKey, { boardId: child.id, columnId: col.id, boardName: child.name });
        if (!group.columns.some((entry) => entry.id === canonicalKey)) {
          group.columns.push({ id: canonicalKey, name: col.name });
        }
        const sharedId = child.nostr?.boardId;
        if (sharedId) {
          const aliasKey = compoundColumnKey(sharedId, col.id);
          if (!sourceMap.has(aliasKey)) {
            sourceMap.set(aliasKey, { boardId: child.id, columnId: col.id, boardName: child.name });
          }
        }
      }
    }
    return { listColumns: columns, listColumnSources: sourceMap, compoundIndexGroups: groups };
  }, [boards, currentBoard]);

  const {
    bibleScrollerRef,
    dayChoice,
    getColumnElement,
    scrollerRef,
    scrollColumnIntoView,
    setColumnRef,
    setDayChoice,
  } = useBoardViewScrollState({
    activePage,
    boards,
    currentBoard,
    currentBoardId,
    listColumns,
    listColumnSources,
    view,
  });

  const focusListColumn = useCallback(
    (columnId: string, options?: { behavior?: ScrollBehavior }) => {
      if (!currentBoard || !isListLikeBoard(currentBoard)) return;
      if (!listColumnSources.has(columnId)) return;
      setDayChoice(columnId);
      requestAnimationFrame(() => {
        scrollColumnIntoView(`list-${columnId}`, options?.behavior ?? "smooth");
      });
    },
    [currentBoard, listColumnSources, scrollColumnIntoView, setDayChoice],
  );

  function cancelRenameColumn(columnId: string) {
    if (currentBoard?.kind === "lists" && newColumnIds[columnId]) {
      removeListColumn(currentBoard.id, columnId);
      return;
    }
    clearColumnEditingState(columnId);
  }

  function commitRenameColumn(columnId: string) {
    if (!currentBoard || currentBoard.kind !== "lists") return;
    const nextName = columnDrafts[columnId] ?? "";
    renameListColumn(currentBoard.id, columnId, nextName);
    setNewColumnIds((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
    clearColumnEditingState(columnId);
  }

  useEffect(() => {
    if (!pendingFocusColumnId) return;
    if (view !== "board") {
      setPendingFocusColumnId(null);
      return;
    }
    if (!currentBoardId || !isListBoard) {
      setPendingFocusColumnId(null);
      return;
    }
    if (!listColumnSources.has(pendingFocusColumnId)) return;
    focusListColumn(pendingFocusColumnId, { behavior: "smooth" });
    setPendingFocusColumnId(null);
  }, [pendingFocusColumnId, view, currentBoardId, isListBoard, listColumnSources, focusListColumn]);
  function flyToCompleted(from: DOMRect) {
    const layer = flyLayerRef.current;
    const targetEl = completedTabRef.current;
    if (!layer || !targetEl) return;
    const target = targetEl.getBoundingClientRect();

    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;
    const endX = target.left + target.width / 2;
    const endY = target.top + target.height / 2;

    const rem = (() => {
      try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch { return 16; }
    })();
    const dotSize = 1.25 * rem; // 20px @ 16px base
    const dotFont = 0.875 * rem; // 14px @ 16px base

    const rootStyles = getComputedStyle(document.documentElement);
    const accent = rootStyles.getPropertyValue("--accent").trim() || "#34c759";
    const accentSoft = rootStyles.getPropertyValue("--accent-soft").trim() || "rgba(52, 199, 89, 0.28)";
    const accentOn = rootStyles.getPropertyValue("--accent-on").trim() || "#0a1f12";

    const dot = document.createElement('div');
    dot.style.position = 'fixed';
    dot.style.left = `${startX - dotSize / 2}px`;
    dot.style.top = `${startY - dotSize / 2}px`;
    dot.style.width = `${dotSize}px`;
    dot.style.height = `${dotSize}px`;
    dot.style.borderRadius = '9999px';
    dot.style.background = accent;
    dot.style.color = accentOn || '#ffffff';
    dot.style.display = 'grid';
    dot.style.placeItems = 'center';
    dot.style.fontSize = `${dotFont}px`;
    dot.style.lineHeight = `${dotSize}px`;
    dot.style.boxShadow = `0 0 0 2px ${accentSoft || 'rgba(16,185,129,0.3)'}, 0 6px 16px rgba(0,0,0,0.35)`;
    dot.style.zIndex = '1000';
    dot.style.transform = 'translate(0, 0) scale(1)';
    dot.style.transition = 'transform 600ms cubic-bezier(.2,.7,.3,1), opacity 300ms ease 420ms';
    dot.textContent = '✓';
    layer.appendChild(dot);

    requestAnimationFrame(() => {
      const dx = endX - startX;
      const dy = endY - startY;
      dot.style.transform = `translate(${dx}px, ${dy}px) scale(0.5)`;
      dot.style.opacity = '0.6';
      setTimeout(() => {
        try { layer.removeChild(dot); } catch {}
      }, 750);
    });
  }

  function flyCoinsToWallet(from: DOMRect) {
    const layer = flyLayerRef.current;
    const targetEl = walletButtonRef.current;
    if (!layer || !targetEl) return;
    const target = targetEl.getBoundingClientRect();

    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;
    const endX = target.left + target.width / 2;
    const endY = target.top + target.height / 2;

    const rem = (() => {
      try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch { return 16; }
    })();
    const coinSize = 1.25 * rem; // 20px @ 16px base
    const coinFont = 0.875 * rem; // 14px @ 16px base
    const coinCount = 5;

    const makeCoin = () => {
      const coin = document.createElement('div');
      coin.style.position = 'fixed';
      coin.style.left = `${startX - coinSize / 2}px`;
      coin.style.top = `${startY - coinSize / 2}px`;
      coin.style.width = `${coinSize}px`;
      coin.style.height = `${coinSize}px`;
      coin.style.display = 'grid';
      coin.style.placeItems = 'center';
      coin.style.fontSize = `${coinFont}px`;
      coin.style.lineHeight = `${coinSize}px`;
      coin.style.background = 'transparent';
      coin.style.boxShadow = 'none';
      coin.style.zIndex = '1000';
      coin.style.transform = 'translate(0, 0) scale(1)';
      coin.style.transition = 'transform 700ms cubic-bezier(.2,.7,.3,1), opacity 450ms ease 450ms';
      coin.textContent = '🥜';
      return coin;
    };

    for (let i = 0; i < coinCount; i++) {
      const coin = makeCoin();
      layer.appendChild(coin);
      const dx = endX - startX;
      const dy = endY - startY;
      // slight horizontal variance per coin
      const wobble = (i - (coinCount - 1) / 2) * (0.4 * rem);
      setTimeout(() => {
        coin.style.transform = `translate(${dx + wobble}px, ${dy}px) scale(0.6)`;
        coin.style.opacity = '0.35';
        setTimeout(() => {
          try { layer.removeChild(coin); } catch {}
        }, 800);
      }, i * 140);
    }
  }

  function flyNewTask(
    from: DOMRect | null,
    dest:
      | { type: "column"; key: string; label: string }
      | { type: "upcoming"; label: string }
  ) {
    const layer = flyLayerRef.current;
    if (!layer) return;
    if (typeof window === "undefined") return;
    try {
      if (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        return;
      }
    } catch {}

    requestAnimationFrame(() => {
      const targetEl =
        dest.type === "column"
          ? getColumnElement(dest.key)
          : upcomingButtonRef.current;
      if (!targetEl) return;

      const targetRect = targetEl.getBoundingClientRect();
      const startRect = from ?? targetRect;
      const startX = startRect.left + startRect.width / 2;
      const startY = startRect.top + startRect.height / 2;
      const endX = targetRect.left + targetRect.width / 2;
      const endY =
        dest.type === "column"
          ? targetRect.top + Math.min(targetRect.height / 2, 56)
          : targetRect.top + targetRect.height / 2;

      const card = document.createElement("div");
      const text = (dest.label || "Task").trim();
      const truncated = text.length > 60 ? `${text.slice(0, 57)}…` : text || "Task";
      const widthSource = from ? from.width : startRect.width;
      const cardWidth = Math.max(Math.min(widthSource * 0.55, 280), 150);
      card.className = `fly-task-card ${
        dest.type === "column" ? "fly-task-card--board" : "fly-task-card--upcoming"
      }`;
      card.style.position = "fixed";
      card.style.left = `${startX}px`;
      card.style.top = `${startY}px`;
      card.style.width = `${cardWidth}px`;
      card.style.transform = "translate(-50%, -50%) scale(0.92)";
      card.style.opacity = "0.98";
      card.style.pointerEvents = "none";
      card.style.zIndex = "1000";
      card.style.boxShadow =
        dest.type === "column"
          ? "0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(63,63,70,0.45), 0 12px 26px rgba(16,185,129,0.2)"
          : "0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(63,63,70,0.45), 0 12px 26px rgba(59,130,246,0.2)";
      card.style.willChange = "transform, left, top, opacity";

      const body = document.createElement("div");
      body.className = "fly-task-card__body";

      const titleEl = document.createElement("div");
      titleEl.className = "fly-task-card__title";
      titleEl.textContent = truncated;
      body.appendChild(titleEl);

      card.appendChild(body);
      layer.appendChild(card);

      const pulseClass =
        dest.type === "column" ? "fly-target-pulse-board" : "fly-target-pulse-upcoming";
      targetEl.classList.add(pulseClass);
      window.setTimeout(() => {
        try {
          targetEl.classList.remove(pulseClass);
        } catch {}
      }, 650);

      requestAnimationFrame(() => {
        card.style.left = `${endX}px`;
        card.style.top = `${endY}px`;
        card.style.transform = "translate(-50%, -50%) scale(0.75)";
        card.style.opacity = "0";
        window.setTimeout(() => {
          try {
            layer.removeChild(card);
          } catch {}
        }, 700);
      });
    });
  }

  function animateTaskArrival(from: DOMRect | null, task: Task, board: Board) {
    if (!board || task.completed) return;
    const labelSource = task.title || (task.images?.length ? "Image" : task.documents?.[0]?.name || "");
    const label = labelSource.trim() || "Task";
    if (!isVisibleNow(task)) {
      flyNewTask(from, { type: "upcoming", label });
      return;
    }

    if (board.kind === "week") {
      const dueWeekday = taskWeekday(task);
      if (dueWeekday == null) return;
      const key = `week-day-${dueWeekday}`;
      flyNewTask(from, { type: "column", key, label });
    } else if (isListLikeBoard(board) && task.columnId) {
      let columnKey: string | null = null;
      if (board.kind === "compound") {
        const source = listColumnSources.get(compoundColumnKey(task.boardId, task.columnId));
        if (source) {
          columnKey = compoundColumnKey(source.boardId, source.columnId);
        }
      } else {
        columnKey = task.columnId;
      }
      if (columnKey) {
        flyNewTask(from, { type: "column", key: `list-${columnKey}`, label });
      }
    }
  }

  const pendingSharedBoardIds = useMemo(() => {
    const ids = new Set<string>();
    boards.forEach((board) => {
      const nostrBoardId = board.nostr?.boardId;
      if (!nostrBoardId) return;
      if (pendingNostrInitialSyncByBoardTag[boardTag(nostrBoardId)]) {
        ids.add(board.id);
      }
    });
    return ids;
  }, [boards, pendingNostrInitialSyncByBoardTag]);

  // True while the current board's initial relay sync is in progress.
  // Used to show a loading indicator so users know tasks are on their way.
  const isCurrentBoardSyncing = useMemo(() => {
    if (!currentBoard) return false;
    const nostrBoardId = currentBoard.nostr?.boardId;
    if (!nostrBoardId) return false;
    return !!pendingNostrInitialSyncByBoardTag[boardTag(nostrBoardId)];
  }, [currentBoard, pendingNostrInitialSyncByBoardTag]);

  // Open instances of a recurring series show the series' running streak (see
  // buildRunningStreakLookup) rather than the copy stored when they were generated.
  const runningStreakFor = useMemo(() => buildRunningStreakLookup(tasks), [tasks]);

  /* ---------- Derived: board-scoped lists ---------- */
  const tasksForBoard = useMemo(() => {
    if (!currentBoard) return [] as Task[];
    const scope = new Set(boardScopeIds(currentBoard, boards));
    return tasks
      .filter((t) => scope.has(t.boardId))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [boards, tasks, currentBoard, pendingSharedBoardIds]);

  const calendarEventsForBoard = useMemo(() => {
    if (!currentBoard) return [] as CalendarEvent[];
    const scope = new Set(boardScopeIds(currentBoard, boards));
    return calendarEvents
      .filter((ev) => !isExternalCalendarEvent(ev) && scope.has(ev.boardId))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [boards, calendarEvents, currentBoard]);

  const walletBountySortTimestamp = useCallback(
    (task: Task) => {
      if (task.completed) {
        const completedAt = task.completedAt ? Date.parse(task.completedAt) : Number.NaN;
        if (Number.isFinite(completedAt)) return completedAt;
      }
      return taskCreatedAt(task);
    },
    [],
  );
  const compareWalletBountyTasks = useCallback(
    (a: Task, b: Task) => {
      const aTs = walletBountySortTimestamp(a);
      const bTs = walletBountySortTimestamp(b);
      if (aTs !== bTs) return bTs - aTs;
      if (!!a.completed !== !!b.completed) return a.completed ? -1 : 1;
      return compareDefault(a, b);
    },
    [walletBountySortTimestamp],
  );
  const sortBoardTasks = useCallback((arr: Task[]) => sortTasksForBoard(arr, boardSort), [boardSort]);

  // Week board
  const currentWeekStartMs = startOfDay(startOfWeek(new Date(), settings.weekStart)).getTime();
  const byDay = useMemo(() => {
    if (!currentBoard || currentBoard.kind !== "week") return new Map<Weekday, Task[]>();
    const visible = tasksForBoard.filter(t => {
      const pendingBounty = t.completed && t.bounty && t.bounty.state !== "claimed" && !isRecoverableBountyTask(t);
      return (!t.completed || pendingBounty || !settings.completedTab) && isVisibleNow(t);
    });
    const m = new Map<Weekday, Task[]>();
    for (const t of visible) {
      const wd = taskWeekday(t);
      if (wd == null) continue;
      if (!m.has(wd)) m.set(wd, []);
      m.get(wd)!.push(t);
    }
    for (const arr of m.values()) {
      sortBoardTasks(arr);
    }
    return m;
  }, [currentBoard, settings.completedTab, sortBoardTasks, tasksForBoard]);

  const calendarByDay = useMemo(() => {
    if (!currentBoard || currentBoard.kind !== "week") return new Map<Weekday, CalendarEvent[]>();
    const m = new Map<Weekday, CalendarEvent[]>();
    const weekStartDate = new Date(currentWeekStartMs);
    const weekStartKey = formatDateKeyLocal(weekStartDate);
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekEndDate.getDate() + 6);
    const weekEndKey = formatDateKeyLocal(weekEndDate);

    const weekdayFromDateKey = (dateKey: string): Weekday | null => {
      if (!ISO_DATE_PATTERN.test(dateKey)) return null;
      const parsed = parseDateKey(dateKey);
      if (!parsed) return null;
      const utc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
      if (!Number.isFinite(utc)) return null;
      return new Date(utc).getUTCDay() as Weekday;
    };

    const addDaysToKey = (dateKey: string, delta: number): string | null => {
      const parsed = parseDateKey(dateKey);
      if (!parsed) return null;
      const base = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
      if (Number.isNaN(base.getTime())) return null;
      base.setUTCDate(base.getUTCDate() + delta);
      return base.toISOString().slice(0, 10);
    };

    for (const ev of calendarEventsForBoard) {
      if (ev.kind === "date") {
        const start = ISO_DATE_PATTERN.test(ev.startDate) ? ev.startDate : null;
        if (!start) continue;
        const end = ev.endDate && ISO_DATE_PATTERN.test(ev.endDate) && ev.endDate >= start ? ev.endDate : start;
        if (end < weekStartKey || start > weekEndKey) continue;
        let cursor = start < weekStartKey ? weekStartKey : start;
        const clippedEnd = end > weekEndKey ? weekEndKey : end;
        let guard = 0;
        while (guard++ < 366) {
          const wd = weekdayFromDateKey(cursor);
          if (wd != null) {
            if (!m.has(wd)) m.set(wd, []);
            m.get(wd)!.push(ev);
          }
          if (cursor === clippedEnd) break;
          const next = addDaysToKey(cursor, 1);
          if (!next) break;
          cursor = next;
        }
        continue;
      }

      const startKey = isoDatePart(ev.startISO, ev.startTzid);
      if (!ISO_DATE_PATTERN.test(startKey)) continue;
      if (startKey < weekStartKey || startKey > weekEndKey) continue;
      const wd = weekdayFromISO(ev.startISO, ev.startTzid);
      if (wd == null) continue;
      if (!m.has(wd)) m.set(wd, []);
      m.get(wd)!.push(ev);
    }

    const timeValue = (ev: CalendarEvent): number => {
      if (ev.kind !== "time") return -1;
      const timePart = isoTimePart(ev.startISO, ev.startTzid);
      const parsed = parseTimeValue(timePart);
      if (!parsed) return 0;
      return parsed.hour * 60 + parsed.minute;
    };

    for (const arr of m.values()) {
      arr.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "date" ? -1 : 1;
        const ta = timeValue(a);
        const tb = timeValue(b);
        if (ta !== tb) return ta - tb;
        const orderDiff = (a.order ?? 0) - (b.order ?? 0);
        if (orderDiff !== 0) return orderDiff;
        return a.id.localeCompare(b.id);
      });
    }

    return m;
  }, [calendarEventsForBoard, currentBoard, currentWeekStartMs]);

  const allBountyTasks = useMemo(() => {
    const list = tasks.filter((task) => !!task.bounty && !isRecoverableBountyTask(task));
    list.sort(compareWalletBountyTasks);
    return list;
  }, [compareWalletBountyTasks, tasks]);

  const openBountyTasks = useMemo(
    () => allBountyTasks.filter((task) => task.bounty && task.bounty.state !== "claimed" && task.bounty.state !== "revoked"),
    [allBountyTasks],
  );

  const fundedBountyTasks = useMemo(() => {
    if (!nostrPK) return [] as Task[];
    return allBountyTasks.filter((task) => !!task.bounty?.sender && pubkeysEqual(task.bounty?.sender, nostrPK));
  }, [allBountyTasks, nostrPK]);

  const pinnedBountyTasks = useMemo(() => {
    const list = tasks.filter((task) => taskHasBountyList(task, PINNED_BOUNTY_LIST_KEY) && !isRecoverableBountyTask(task));
    list.sort(compareWalletBountyTasks);
    return list;
  }, [compareWalletBountyTasks, tasks]);

  const itemsByColumn = useMemo(() => {
    if (!currentBoard || !isListLikeBoard(currentBoard)) return new Map<string, Task[]>();
    const m = new Map<string, Task[]>();
    for (const col of listColumns) m.set(col.id, []);
    for (const t of tasksForBoard) {
      const pendingBounty = t.completed && t.bounty && t.bounty.state !== "claimed" && !isRecoverableBountyTask(t);
      if (t.completed && !pendingBounty && settings.completedTab) continue;
      if (!t.columnId) continue;
      if (!isVisibleNow(t)) continue;

      let key: string | null = null;
      if (currentBoard.kind === "compound") {
        const source = listColumnSources.get(compoundColumnKey(t.boardId, t.columnId));
        if (!source) continue;
        key = compoundColumnKey(source.boardId, source.columnId);
      } else {
        if (!listColumnSources.has(t.columnId)) continue;
        key = t.columnId;
      }

      if (!key) continue;
      const arr = m.get(key);
      if (arr) arr.push(t);
    }
    for (const arr of m.values()) {
      sortBoardTasks(arr);
    }
    return m;
  }, [currentBoard, listColumns, listColumnSources, settings.completedTab, sortBoardTasks, tasksForBoard]);

  const calendarItemsByColumn = useMemo(() => {
    if (!currentBoard || !isListLikeBoard(currentBoard)) return new Map<string, CalendarEvent[]>();
    const m = new Map<string, CalendarEvent[]>();
    for (const col of listColumns) m.set(col.id, []);
    const now = new Date();

    const dateKeyForEvent = (ev: CalendarEvent): string => {
      if (ev.kind === "date") return ISO_DATE_PATTERN.test(ev.startDate) ? ev.startDate : isoDatePart(new Date().toISOString());
      return isoDatePart(ev.startISO, ev.startTzid);
    };

    const timeValue = (ev: CalendarEvent): number => {
      if (ev.kind !== "time") return -1;
      const timePart = isoTimePart(ev.startISO, ev.startTzid);
      const parsed = parseTimeValue(timePart);
      if (!parsed) return 0;
      return parsed.hour * 60 + parsed.minute;
    };

    for (const ev of calendarEventsForBoard) {
      if (!ev.columnId) continue;
      if (!isCalendarEventVisibleOnListBoard(ev, settings.weekStart, now)) continue;

      let key: string | null = null;
      if (currentBoard.kind === "compound") {
        const source = listColumnSources.get(compoundColumnKey(ev.boardId, ev.columnId));
        if (!source) continue;
        key = compoundColumnKey(source.boardId, source.columnId);
      } else {
        if (!listColumnSources.has(ev.columnId)) continue;
        key = ev.columnId;
      }

      if (!key) continue;
      const arr = m.get(key);
      if (arr) arr.push(ev);
    }

    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const orderDiff = (a.order ?? 0) - (b.order ?? 0);
        if (orderDiff !== 0) return orderDiff;
        const da = dateKeyForEvent(a);
        const db = dateKeyForEvent(b);
        if (da !== db) return da.localeCompare(db);
        const ta = timeValue(a);
        const tb = timeValue(b);
        if (ta !== tb) return ta - tb;
        return a.id.localeCompare(b.id);
      });
    }

    return m;
  }, [calendarEventsForBoard, currentBoard, listColumns, listColumnSources, settings.weekStart]);

  const buildBoardPrintTasks = useCallback((options?: { onlyTaskIds?: ReadonlySet<string> }): BoardPrintTask[] => {
    if (!currentBoard) return [];
    const titleForTask = (task: Task) => {
      const labelSource = task.title || (task.images?.length ? "Image" : task.documents?.[0]?.name || "");
      return labelSource.trim() || "Task";
    };
    const titleForEvent = (ev: CalendarEvent) => (ev.title || "").trim() || "Event";
    const onlyIds = options?.onlyTaskIds;
    const includeId = (id: string) => !onlyIds || onlyIds.has(id);
    const visibleTasks = tasksForBoard.filter((task) => {
      if (task.completed) return false;
      if (!isVisibleNow(task)) return false;
      return includeId(task.id);
    });

    if (currentBoard.kind === "week") {
      const dayOrder = Array.from({ length: 7 }, (_, i) => ((settings.weekStart + i) % 7) as Weekday);
      const taskByDay = new Map<Weekday, Task[]>();
      visibleTasks.forEach((task) => {
        const day = taskWeekday(task) ?? (new Date().getDay() as Weekday);
        const list = taskByDay.get(day) ?? [];
        list.push(task);
        taskByDay.set(day, list);
      });

      const output: BoardPrintTask[] = [];
      dayOrder.forEach((day) => {
        const label = WD_SHORT[day];
        const dayTasks = (taskByDay.get(day) ?? [])
          .slice()
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        dayTasks.forEach((task) => {
          output.push({ id: task.id, title: titleForTask(task), label });
        });
        const dayEvents = (calendarByDay.get(day) ?? []).filter((ev) => includeId(ev.id));
        dayEvents.forEach((ev) => {
          output.push({ id: ev.id, title: titleForEvent(ev), label });
        });
      });
      return output;
    }

    if (isListLikeBoard(currentBoard)) {
      const columnTaskMap = new Map<string, Task[]>();
      listColumns.forEach((col) => columnTaskMap.set(col.id, []));
      for (const task of visibleTasks) {
        if (!task.columnId) continue;
        let columnKey = task.columnId;
        if (currentBoard.kind === "compound") {
          const source = listColumnSources.get(compoundColumnKey(task.boardId, task.columnId));
          if (!source) continue;
          columnKey = compoundColumnKey(source.boardId, source.columnId);
        } else if (!listColumnSources.has(task.columnId)) {
          continue;
        }
        const bucket = columnTaskMap.get(columnKey);
        if (bucket) bucket.push(task);
      }

      const output: BoardPrintTask[] = [];
      listColumns.forEach((col) => {
        const taskBucket = (columnTaskMap.get(col.id) ?? [])
          .slice()
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        taskBucket.forEach((task) => {
          output.push({ id: task.id, title: titleForTask(task), label: col.name });
        });
        const eventBucket = (calendarItemsByColumn.get(col.id) ?? []).filter((ev) => includeId(ev.id));
        eventBucket.forEach((ev) => {
          output.push({ id: ev.id, title: titleForEvent(ev), label: col.name });
        });
      });
      return output;
    }

    const tasksOutput = visibleTasks.map((task) => ({ id: task.id, title: titleForTask(task) }));
    const eventsOutput = calendarEventsForBoard
      .filter((ev) => includeId(ev.id))
      .map((ev) => ({ id: ev.id, title: titleForEvent(ev) }));
    return [...tasksOutput, ...eventsOutput];
  }, [calendarByDay, calendarEventsForBoard, calendarItemsByColumn, currentBoard, listColumns, listColumnSources, settings.weekStart, tasksForBoard]);

  const handleOpenBoardPrint = useCallback(() => {
    if (!currentBoard) return;
    const tasks = buildBoardPrintTasks();
    if (!tasks.length) {
      showToast("No tasks to print yet.", 2500);
      return;
    }
    closeShareBoard();
    const job: BoardPrintJob = {
      id: crypto.randomUUID(),
      boardId: currentBoard.id,
      boardName: currentBoard.name || "Board",
      printedAtISO: new Date().toISOString(),
      layoutVersion: BOARD_PRINT_LAYOUT_VERSION,
      paperSize: boardPrintJob?.paperSize ?? "letter",
      tasks,
    };
    setBoardPrintJob(job);
    persistBoardPrintJob(job);
    setBoardPrintOpen(true);
  }, [boardPrintJob?.paperSize, buildBoardPrintTasks, closeShareBoard, currentBoard, showToast]);

  const listColumnGroupIds = useCallback((columnId: string): string[] => {
    const taskIds = (itemsByColumn.get(columnId) ?? []).filter((t) => !t.completed).map((t) => t.id);
    const eventIds = (calendarItemsByColumn.get(columnId) ?? []).map((ev) => ev.id);
    return [...taskIds, ...eventIds];
  }, [calendarItemsByColumn, itemsByColumn]);

  const weekDayGroupIds = useCallback((day: Weekday): string[] => {
    const taskIds = (byDay.get(day) ?? []).filter((t) => !t.completed).map((t) => t.id);
    const eventIds = (calendarByDay.get(day) ?? []).map((ev) => ev.id);
    return [...taskIds, ...eventIds];
  }, [byDay, calendarByDay]);

  const groupSelectionState = useCallback((ids: string[]): "none" | "some" | "all" => {
    if (!ids.length) return "none";
    let selected = 0;
    for (const id of ids) {
      if (selectedItemIdSet.has(id)) selected += 1;
    }
    if (selected === 0) return "none";
    if (selected === ids.length) return "all";
    return "some";
  }, [selectedItemIdSet]);

  const toggleGroupSelection = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const allSelected = ids.every((id) => selectedItemIdSet.has(id));
    if (allSelected) {
      const idSet = new Set(ids);
      setSelectedItemIds((prev) => prev.filter((id) => !idSet.has(id)));
    } else {
      setSelectedItemIds((prev) => Array.from(new Set([...prev, ...ids])));
    }
  }, [selectedItemIdSet]);

  const handlePrintSelectedTasks = useCallback(() => {
    if (!currentBoard) return;
    if (!selectedItemIds.length) return;
    const filter = new Set(selectedItemIds);
    const tasks = buildBoardPrintTasks({ onlyTaskIds: filter });
    if (!tasks.length) {
      showToast("No printable tasks selected.", 2500);
      return;
    }
    closeShareBoard();
    const job: BoardPrintJob = {
      id: crypto.randomUUID(),
      boardId: currentBoard.id,
      boardName: `${currentBoard.name || "Board"} – Selected`,
      printedAtISO: new Date().toISOString(),
      layoutVersion: BOARD_PRINT_LAYOUT_VERSION,
      paperSize: boardPrintJob?.paperSize ?? "letter",
      tasks,
    };
    setBoardPrintJob(job);
    setBoardPrintOpen(true);
  }, [boardPrintJob?.paperSize, buildBoardPrintTasks, closeShareBoard, currentBoard, selectedItemIds, showToast]);

  const handleBoardPaperSizeChange = useCallback((paperSize: PrintPaperSize) => {
    setBoardPrintJob((prev) => {
      if (!prev || prev.paperSize === paperSize) return prev;
      const next = { ...prev, paperSize };
      persistBoardPrintJob(next);
      return next;
    });
  }, []);

  const handlePrintBoardWindow = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!boardPrintJob || !boardPrintPortal) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      showToast("Popup blocked. Allow popups to print.", 3000);
      return;
    }
    try {
      printWindow.opener = null;
    } catch {}
    const { buildBoardPrintLayout } = await import("./components/BoardPrintLayout");
    const layout = buildBoardPrintLayout(boardPrintJob.tasks, {
      layoutVersion: boardPrintJob.layoutVersion,
      paperSize: boardPrintJob.paperSize,
    });
    const pageWidthMm = layout.page.widthMm;
    const pageHeightMm = layout.page.heightMm;
    const printCss = `
      * { box-sizing: border-box; }
      @page { size: ${pageWidthMm}mm ${pageHeightMm}mm; margin: 0; }
      html, body { margin: 0; padding: 0; background: #ffffff; color: #101828; height: auto; overflow: visible; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .board-print-root { width: 100%; }
      .board-print-controls { display: none; }
      .board-print-pages { display: block; }
      .board-print-page {
        position: relative;
        width: ${pageWidthMm}mm;
        height: ${pageHeightMm}mm;
        margin: 0;
        background: #ffffff;
        color: #101828;
        page-break-after: always;
        break-after: page;
      }
      .board-print-marker {
        position: absolute;
        background: #101828;
        border-radius: 2px;
        overflow: hidden;
      }
      .board-print-marker[data-marker-style="finder"]::after {
        content: "";
        position: absolute;
        width: 45%;
        height: 45%;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: #ffffff;
        border-radius: 1px;
      }
      .board-print-page-id__bit {
        position: absolute;
        border-radius: 0.4mm;
        border: 0.2mm solid rgba(16, 24, 40, 0.2);
        background: #ffffff;
      }
      .board-print-page-id__bit[data-filled="true"] {
        background: #101828;
        border-color: #101828;
      }
      .board-print-header {
        position: absolute;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.75rem;
      }
      .board-print-header__left { display: flex; flex-direction: column; gap: 0.1rem; }
      .board-print-header__title { font-size: 9pt; font-weight: 600; }
      .board-print-header__meta { font-size: 7pt; color: rgba(16, 24, 40, 0.72); }
      .board-print-header__right { text-align: right; font-size: 7pt; color: rgba(16, 24, 40, 0.72); }
      .board-print-header__page { font-weight: 600; color: #101828; }
      .board-print-row {
        position: absolute;
        display: flex;
        align-items: center;
        gap: 2.4mm;
      }
      .board-print-circle {
        box-sizing: border-box;
        border: 0.3mm solid #1f2937;
        border-radius: 999px;
        background: #ffffff;
        flex-shrink: 0;
      }
      .board-print-title {
        font-size: 8pt;
        font-weight: 500;
        color: #101828;
        line-height: 1.1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .board-print-label {
        font-size: 7pt;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(16, 24, 40, 0.55);
        margin-right: 0.3rem;
      }
      .board-print-group {
        position: absolute;
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }
      .board-print-group__text {
        font-size: 7pt;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(16, 24, 40, 0.6);
        white-space: nowrap;
        max-width: 60%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .board-print-group__rule {
        flex: 1;
        height: 0.3mm;
        background: rgba(16, 24, 40, 0.18);
        border-radius: 999px;
      }
      @media print {
        .board-print-page:last-child { break-after: auto; page-break-after: auto; }
      }
    `;
    const markup = boardPrintPortal.innerHTML;
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Board print</title><style>${printCss}</style></head><body>${markup}</body></html>`);
    printWindow.document.close();
    const triggerPrint = () => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch {}
    };
    if (printWindow.document.readyState === "complete") {
      setTimeout(triggerPrint, 80);
    } else {
      printWindow.addEventListener("load", () => setTimeout(triggerPrint, 80), { once: true });
    }
    printWindow.addEventListener("afterprint", () => {
      printWindow.close();
    }, { once: true });
  }, [boardPrintJob, boardPrintPortal, showToast]);

  const handleExportBoardPdf = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!boardPrintJob) return;
    if (boardPrintPdfBusy) return;
    setBoardPrintPdfBusy(true);
    try {
      const { buildBoardPrintPdf } = await import("./lib/printPdf");
      const blob = await buildBoardPrintPdf({
        job: boardPrintJob,
        paperSize: boardPrintJob.paperSize,
      });
      const boardName = sanitizeFileNamePart(boardPrintJob.boardName || "board");
      const fileName = `taskify-board-${boardName}-${sanitizeFileNamePart(boardPrintJob.paperSize)}-${boardPrintJob.id.slice(0, 8)}.pdf`;
      await openOrSharePdf(blob, fileName, `${boardPrintJob.boardName || "Board"} print`);
    } catch (err) {
      console.warn("Failed to generate board PDF", err);
      showToast("Failed to generate PDF. Try again.", 3000);
    } finally {
      setBoardPrintPdfBusy(false);
    }
  }, [boardPrintJob, boardPrintPdfBusy, openOrSharePdf, sanitizeFileNamePart, showToast]);

  const handleOpenBoardScan = useCallback(() => {
    if (!currentBoard) return;
    const job = loadBoardPrintJob(currentBoard.id);
    if (!job || job.tasks.length === 0) {
      showToast("Print this board before scanning.", 2500);
      return;
    }
    setBoardPrintJob(job);
    setBoardScanOpen(true);
  }, [currentBoard, showToast]);

  function handleApplyBoardScan(taskIds: string[]) {
    if (!taskIds.length) {
      showToast("No tasks detected in the scan.", 2500);
      return;
    }
    const taskLookup = new Map(tasks.map((task) => [task.id, task] as const));
    let completedCount = 0;
    let ignoredCount = 0;
    const uniqueIds = Array.from(new Set(taskIds));
    uniqueIds.forEach((taskId) => {
      const task = taskLookup.get(taskId);
      if (!task || task.completed) {
        ignoredCount += 1;
        return;
      }
      completeTask(taskId);
      completedCount += 1;
    });

    if (completedCount > 0) {
      const ignoredLine = ignoredCount > 0 ? ` (${ignoredCount} ignored)` : "";
      showToast(`Marked ${completedCount} task${completedCount === 1 ? "" : "s"} complete${ignoredLine}.`, 2500);
      return;
    }
    if (ignoredCount > 0) {
      showToast(`No new tasks found. ${ignoredCount} already completed or deleted.`, 2500);
      return;
    }
    showToast("No new tasks detected.", 2500);
  }

  const resolveListPlacement = useCallback(
    (columnKey?: string | null) => {
      if (!currentBoard || !isListLikeBoard(currentBoard)) return null;
      if (currentBoard.kind === "lists") {
        const key = columnKey && listColumnSources.has(columnKey)
          ? columnKey
          : currentBoard.columns[0]?.id;
        if (!key) return null;
        return { boardId: currentBoard.id, columnId: key };
      }
      const key = columnKey && listColumnSources.has(columnKey)
        ? columnKey
        : listColumns[0]?.id;
      if (!key) return null;
      const source = listColumnSources.get(key);
      if (!source) return null;
      return { boardId: source.boardId, columnId: source.columnId };
    },
    [currentBoard, listColumnSources, listColumns],
  );

  const completed = useMemo(
    () =>
      tasksForBoard
        .filter((t) => t.completed && (isRecoverableBountyTask(t) || !t.bounty || t.bounty.state === "claimed"))
        .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || "")),
    [tasksForBoard]
  );

  const completedBibleBooks = useMemo(() => {
    const entries = Object.entries(bibleTracker.completedBooks || {});
    return entries
      .map(([bookId, info]) => ({
        id: bookId,
        name: getBibleBookTitle(bookId) ?? bookId,
        completedAtISO: typeof info?.completedAtISO === "string" ? info.completedAtISO : "",
      }))
      .sort((a, b) => {
        const orderA = getBibleBookOrder(a.id);
        const orderB = getBibleBookOrder(b.id);
        if (orderA != null && orderB != null) {
          return orderA - orderB;
        }
        if (orderA != null) return -1;
        if (orderB != null) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [bibleTracker.completedBooks]);

  // A board's own "upcoming" section: its items after today, sorted as Upcoming sorts them.
  const upcomingBoardOrderValue = useMemo(() => upcomingBoardOrder(visibleBoards), [visibleBoards]);
  // For the Upcoming tab's label: the user's own dated items (holidays are not counted).
  const upcomingItemCount = useMemo(() => {
    const context = { boardOrder: upcomingBoardOrderValue, messagesBoardId };
    return selectUpcomingTasks(tasks, context).length
      + selectUpcomingEvents(calendarEvents, { ...context, holidays: null }).length;
  }, [calendarEvents, messagesBoardId, tasks, upcomingBoardOrderValue]);
  const upcomingSortOptions = useMemo<UpcomingSortOptions>(
    () => ({ sort: upcomingPreferences.sort, grouping: upcomingPreferences.grouping, boardOrder: upcomingBoardOrderValue }),
    [upcomingBoardOrderValue, upcomingPreferences.grouping, upcomingPreferences.sort],
  );

  const boardUpcomingCutoffDateKey = formatDateKeyLocal(new Date());
  const boardUpcomingTasksValue = useMemo(
    () => boardUpcomingTasks(tasksForBoard, boardUpcomingCutoffDateKey),
    [boardUpcomingCutoffDateKey, tasksForBoard],
  );
  const boardUpcomingEventsValue = useMemo(
    () => boardUpcomingEvents(calendarEventsForBoard, boardUpcomingCutoffDateKey),
    [boardUpcomingCutoffDateKey, calendarEventsForBoard],
  );
  const boardUpcomingCount = boardUpcomingTasksValue.length + boardUpcomingEventsValue.length;
  const boardUpcomingGroups = useMemo(
    () => upcomingDayGroups(groupUpcomingByDay(boardUpcomingTasksValue, boardUpcomingEventsValue, {
      ...upcomingSortOptions,
      after: boardUpcomingCutoffDateKey,
    })),
    [boardUpcomingCutoffDateKey, boardUpcomingEventsValue, boardUpcomingTasksValue, upcomingSortOptions],
  );


  // ---- What task and event cards can do (see ui/task/taskActions) ----
  const taskActions: TaskActions = {
    completeTask,
    restoreTask,
    revealBounty,
    claimBounty,
    editTask: (task) => setEditing({ type: "task", originalType: "task", originalId: task.id, task }),
    editEvent: (event) => setEditing({ type: "event", originalType: "event", originalId: event.id, event }),
    toggleSubtask,
    moveTask,
    revealTaskNow: (id) => setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, hiddenUntilISO: undefined } : task))),
    revealEventNow: (id) =>
      setCalendarEvents((prev) => prev.map((event) => (event.id === id ? { ...event, hiddenUntilISO: undefined } : event))),
    openDocument: handleOpenDocument,
    openEventDocument: handleOpenEventDocument,
    openNote: setNoteViewerTaskId,
    startTaskDrag: setDraggingTaskId,
    startEventDrag: setDraggingEventId,
    endDrag: handleDragEnd,
    flyToCompleted,
    toggleItemSelection,
  };
  const taskView = useMemo<TaskView>(() => ({
    isSelectionMode,
    selectedItemIds,
    pendingTaskIds: pendingNostrTaskIds,
    pendingEventIds: pendingNostrCalendarEventIds,
    runningStreakFor,
    showStreaks: settings.streaksEnabled,
    hideCompletedSubtasks: settings.hideCompletedSubtasks,
    completedTab: settings.completedTab,
    boardsById: boardMap,
    weekStart: settings.weekStart,
  }), [
    boardMap,
    isSelectionMode,
    pendingNostrCalendarEventIds,
    pendingNostrTaskIds,
    runningStreakFor,
    selectedItemIds,
    settings.completedTab,
    settings.hideCompletedSubtasks,
    settings.streaksEnabled,
    settings.weekStart,
  ]);


  // Boards open at the top; Upcoming scrolls itself to the day in view.
  useEffect(() => {
    if (activePage !== "boards") return;
    const container = appContentRef.current;
    if (!container) return;
    requestAnimationFrame(() => {
      container.scrollTo({ top: 0, behavior: "auto" });
      if (typeof window !== "undefined") {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }
    });
  }, [activePage]);

  const editingBoard = useMemo(
    () => {
      if (!editing) return null;
      const boardId = editing.type === "task" ? editing.task.boardId : editing.event.boardId;
      return boards.find((b) => b.id === boardId) ?? null;
    },
    [boards, editing]
  );

  const {
    activeEventRsvpCoord,
    activeEventRsvpRelays,
    activeEventRsvps,
    recordActiveEventRsvp,
  } = useCalendarEventManagement({
    boards,
    calendarEvents,
    calendarEventsRef,
    defaultRelays,
    editing,
    inboxRelays,
    nostrPK,
    nostrSkHex,
    pool,
    setCalendarEvents,
    tagValue,
    deriveBoardNostrKeys,
  });

  const reminderSystemTimeZone = useMemo(() => resolveSystemTimeZone(), []);
  const reminderSyncItems = useMemo(() => {
    const taskItems = tasks.flatMap((task) => {
      if (!taskHasReminders(task)) return [];
      const dueISO = reminderScheduleISOForTask(task, reminderSystemTimeZone);
      if (!dueISO) return [];
      return [{
        taskId: task.id,
        boardId: task.boardId,
        title: task.title,
        dueISO,
        reminders: task.reminders ?? [],
      }];
    });
    const eventItems = calendarEvents.flatMap((ev) => {
      if (!calendarEventHasReminders(ev)) return [];
      const dueISO = reminderScheduleISOForCalendarEvent(ev, reminderSystemTimeZone);
      if (!dueISO) return [];
      return [{
        taskId: `event:${ev.id}`,
        boardId: ev.boardId,
        title: ev.title,
        dueISO,
        reminders: ev.reminders ?? [],
      }];
    });
    const merged = [...taskItems, ...eventItems];
    merged.sort((a, b) => a.taskId.localeCompare(b.taskId));
    return merged;
  }, [calendarEvents, reminderSystemTimeZone, tasks]);

  useReminderSync({
    reminderSyncItems,
    pushPrefs: settings.pushNotifications,
    workerBaseUrl,
    sentPayloadRef: reminderPayloadRef,
    setPushError,
    showToast,
  });

  // --------- Nostr helpers
  const isShared = (board: Board) => !!board.nostr?.boardId;
  const getBoardRelays = useCallback((board: Board): string[] => {
    const fallback = (defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS))
      .map((relay) => relay.trim())
      .filter(Boolean);
    const candidate = (board.nostr?.relays?.length ? board.nostr!.relays : fallback)
      .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
      .filter(Boolean);
    return boardSyncRelays(candidate.length ? candidate : fallback);
  }, [defaultRelays]);
  // Shared-board publishing lives in BoardPublisher; these names remain for App's callers.
  const publisherLatestRef = useRef({ getBoardRelays, nostrPK, nostrPublish, prepareAttachmentsForPublish });
  publisherLatestRef.current = { getBoardRelays, nostrPK, nostrPublish, prepareAttachmentsForPublish };
  const publisherRef = useRef<BoardPublisher | null>(null);
  publisherRef.current ??= new BoardPublisher({
    ledger,
    versions: taskPublishVersionsRef.current,
    boards: () => boardsRef.current,
    relaysFor: (board) => publisherLatestRef.current.getBoardRelays(board),
    actorPubkey: () => publisherLatestRef.current.nostrPK,
    boardTag,
    deriveBoardKeys: deriveBoardNostrKeys,
    encrypt: encryptToBoard,
    encryptCalendarForBoard: encryptCalendarPayloadForBoard,
    encryptCalendarForInvitees: encryptCalendarPayloadWithEventKey,
    publish: (relays, template, options) => publisherLatestRef.current.nostrPublish(relays, template, options),
    prepareAttachments: (params) => publisherLatestRef.current.prepareAttachmentsForPublish(params),
    storedTaskAt: (taskId, board) =>
      tasksRef.current.find((task) => (
        task.id === taskId &&
        (task.boardId === board.id || task.boardId === board.nostr?.boardId)
      ))?._nostrAt ?? 0,
    metadataFingerprints: boardMetadataFingerprintsRef.current,
    onTaskPending: markNostrTaskSyncPending,
    onTaskSettled: clearOptimisticNostrTaskSyncPending,
    onAttachmentsUploaded: (original, published, prepared) => {
      // Swap in the uploaded copies unless the attachments were edited meanwhile.
      setTasks((prev) =>
        prev.map((current) => {
          if (current.id !== original.id || current.boardId !== original.boardId) return current;
          let changed = false;
          const next: Task = { ...current };
          if (prepared.images !== null && sameStringList(current.images, original.images)) {
            next.images = published.images;
            changed = true;
          }
          if (prepared.documents !== null && sameDocumentList(current.documents, original.documents)) {
            next.documents = published.documents;
            changed = true;
          }
          return changed ? next : current;
        }),
      );
    },
    onEventPending: markNostrCalendarEventSyncPending,
    onEventSettled: clearOptimisticNostrCalendarEventSyncPending,
    onEventSecretsMerged: (updated) => {
      setCalendarEvents((prev) => prev.map((ev) => (ev.id === updated.id ? updated : ev)));
    },
    onEventAttachmentsUploaded: (original, published, prepared) => {
      // Swap in the uploaded copies unless the attachments were edited meanwhile.
      setCalendarEvents((prev) =>
        prev.map((current) => {
          if (current.id !== original.id) return current;
          let next: CalendarEvent = current;
          if (prepared.image !== null && current.image === original.image) {
            next = { ...next, image: published.image };
          }
          if (prepared.documents !== null && sameDocumentList(current.documents, original.documents)) {
            next = { ...next, documents: published.documents };
          }
          return next;
        }),
      );
    },
  });
  const publisher = publisherRef.current;
  function markTaskRelayPublishPending(taskId: string, board: Board | null | undefined): number | null {
    return publisher.reserveTaskPublish(taskId, board);
  }
  async function publishBoardMetadata(board: Board) {
    await publisher.publishBoardMetadata(board);
  }
  publishBoardMetadataRef.current = publishBoardMetadata;
  async function publishBoardMetadataSnapshot(board: Board, boardId: string, relays: string[]) {
    await publisher.publishBoardMetadataAs(board, boardId, relays);
  }
  publishBoardMetadataSnapshotRef.current = publishBoardMetadataSnapshot;
  async function publishBoardMetadataForItem(board: Board) {
    await publisher.publishBoardMetadataForItem(board);
  }
  async function publishTaskDeleted(t: Task) {
    await publisher.publishTaskDeleted(t);
  }
  // Ensure all images and documents for a shared board are stored remotely (encrypted).
  // Images still as data URLs are encrypted and uploaded to the file server.
  // Documents already carrying a remoteUrl have their local blobs stripped before publish.
  // Documents still carrying only a dataUrl are encrypted and uploaded.
  // Throws if any upload fails — save must not silently fall back to inline payloads.
  async function prepareAttachmentsForPublish(
    params: { images?: string[]; image?: string; documents?: TaskDocument[]; boardId: string }
  ): Promise<{ images: string[] | null; image: string | null; documents: any[] | null }> {
    const servers = parseFileServers(settings.encryptedFileServers || settings.fileServers);
    const serverEntry = findServerEntry(servers, settings.encryptedFileStorageServer)
      ?? findServerEntry(servers, settings.fileStorageServer)
      ?? servers[0]
      ?? { url: settings.encryptedFileStorageServer, type: "nip96" as const };

    const uploadInlineImage = async (img: string, filename: string): Promise<string> => {
      if (!img || !img.startsWith("data:")) return img; // already a remote URL
      try {
        const { mimeType, bytes } = parseDataUrl(img);
        return await encryptAndUploadAttachment({
          boardId: params.boardId,
          data: bytes,
          mimeType,
          filename,
          serverEntry,
          nostrSkHex,
        });
      } catch (err: any) {
        console.error("[attachments] Failed to encrypt/upload image", err);
        throw new Error(err?.message || "Failed to upload encrypted image attachment.");
      }
    };

    const nextImages = typeof params.images === "undefined"
      ? null
      : await Promise.all((params.images || []).map((img, index) => uploadInlineImage(img, `task-image-${index + 1}`)));
    const nextImage = typeof params.image === "undefined"
      ? null
      : (params.image ? await uploadInlineImage(params.image, "event-image") : "");

    const nextDocuments = typeof params.documents === "undefined" ? null : await Promise.all((params.documents || []).map(async (doc) => {
      // Remote-first doc already uploaded at attach-time: strip local blobs, keep metadata + remoteUrl
      if (doc.remoteUrl) {
        const { dataUrl: _d, preview: _p, full: _f, ...rest } = doc as any;
        return { ...rest };
      }
      // Legacy inline doc: encrypt+upload now
      if (!doc?.dataUrl || !doc.dataUrl.startsWith("data:")) {
        return doc; // nothing to upload (unexpected, pass through)
      }
      try {
        const { mimeType, bytes } = parseDataUrl(doc.dataUrl);
        const remoteUrl = await encryptAndUploadAttachment({
          boardId: params.boardId,
          data: bytes,
          mimeType: doc.mimeType || mimeType,
          filename: doc.name || doc.id || "document",
          serverEntry,
          nostrSkHex,
        });
        const { dataUrl: _d, preview: _p, full: _f, ...rest } = doc as any;
        return { ...rest, remoteUrl, encrypted: true, encryptionBoardId: params.boardId };
      } catch (err: any) {
        console.error("[attachments] Failed to encrypt/upload document", err);
        throw new Error(err?.message || `Failed to upload encrypted file attachment: ${doc?.name || "document"}`);
      }
    }));

    return { images: nextImages, image: nextImage, documents: nextDocuments };
  }

  async function maybePublishTask(
    t: Task,
    boardOverride?: Board,
    options?: { skipBoardMetadata?: boolean; republish?: boolean }
  ) {
    await publisher.publishTask(t, boardOverride, options);
  }

  maybePublishTaskRef.current = maybePublishTask;
  publishTaskDeletedRef.current = publishTaskDeleted;

  async function publishCalendarEventDeleted(event: CalendarEvent) {
    await publisher.publishCalendarEventDeleted(event);
  }
  publishCalendarEventDeletedRef.current = publishCalendarEventDeleted;

  async function maybePublishCalendarEvent(
    event: CalendarEvent,
    boardOverride?: Board,
    options?: { skipBoardMetadata?: boolean; republish?: boolean },
  ) {
    await publisher.publishCalendarEvent(event, boardOverride, options);
  }

  maybePublishCalendarEventRef.current = maybePublishCalendarEvent;

  const enableBoardSharing = useCallback(
    (boardId: string, relayCsv?: string) => {
      const r = (relayCsv || "").split(",").map((s) => s.trim()).filter(Boolean);
      const relays = r.length ? r : defaultRelays;
      setBoards((prev) =>
        prev.map((b) => {
          if (b.id !== boardId) return b;
          const nostrId =
            b.nostr?.boardId ||
            (/^[0-9a-f-]{8}-[0-9a-f-]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.id)
              ? b.id
              : crypto.randomUUID());
          const nb: Board = { ...b, nostr: { boardId: nostrId, relays } } as Board;
          setTimeout(() => {
            publishBoardMetadataRef.current?.(nb).catch(() => {});
            tasks
              .filter((t) => t.boardId === nb.id)
              .forEach((t) => {
                maybePublishTaskRef.current?.(t, nb, { skipBoardMetadata: true }).catch(() => {});
              });
            calendarEvents
              .filter((ev) => ev.boardId === nb.id && !isExternalCalendarEvent(ev))
              .forEach((ev) => {
                maybePublishCalendarEventRef.current?.(ev, nb, { skipBoardMetadata: true }).catch(() => {});
              });
          }, 0);
          return nb;
        }),
      );
    },
    [calendarEvents, defaultRelays, setBoards, tasks],
  );

  function regenerateBoardId(id: string) {
    let updated: Board | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== id || !b.nostr) return b;
      const nb: Board = { ...b, nostr: { ...b.nostr, boardId: crypto.randomUUID() } };
      updated = nb;
      return nb;
    }));
    if (updated) {
      setTimeout(() => {
        publishBoardMetadata(updated!).catch(() => {});
        tasks
          .filter(t => t.boardId === updated!.id)
          .forEach(t => { maybePublishTask(t, updated!, { skipBoardMetadata: true }).catch(() => {}); });
        calendarEvents
          .filter((ev) => ev.boardId === updated!.id && !isExternalCalendarEvent(ev))
          .forEach((ev) => { maybePublishCalendarEvent(ev, updated!, { skipBoardMetadata: true }).catch(() => {}); });
      }, 0);
    }
  }
  const createTemplateShare = useCallback(
    async (board: Board) => {
      if (shareTemplateBusy) return;
      const targetId = board.id;
      setShareTemplateBusy(true);
      setShareTemplateStatus(null);
      try {
        const relayList = normalizeRelayList(
          board.nostr?.relays?.length
            ? board.nostr.relays
            : defaultRelays.length
              ? defaultRelays
              : Array.from(DEFAULT_NOSTR_RELAYS),
        );
        if (!relayList.length) {
          throw new Error("Add at least one relay to share.");
        }
        const templateId = crypto.randomUUID();
        const templateBoard: Board = { ...board, nostr: { boardId: templateId, relays: relayList } } as Board;
        await publishBoardMetadataSnapshotRef.current?.(board, templateId, relayList);
        const boardTasks = tasks.filter((t) => t.boardId === board.id);
        const boardEvents = calendarEvents.filter((ev) => ev.boardId === board.id && !isExternalCalendarEvent(ev));
        let taskError = false;
        for (const task of boardTasks) {
          try {
            await maybePublishTaskRef.current?.(task, templateBoard, { skipBoardMetadata: true });
          } catch (err) {
            taskError = true;
            console.warn("Template task publish failed", err);
          }
        }
        for (const calendarEvent of boardEvents) {
          try {
            await maybePublishCalendarEventRef.current?.(calendarEvent, templateBoard, { skipBoardMetadata: true });
          } catch (err) {
            taskError = true;
            console.warn("Template calendar event publish failed", err);
          }
        }
        if (!shareBoardModalOpenRef.current || shareBoardTargetIdRef.current !== targetId) return;
        setShareTemplateShare({ id: templateId, relays: relayList, boardId: targetId });
        if (taskError) {
          setShareTemplateStatus("Template created, but some tasks failed to publish.");
        }
      } catch (err: any) {
        if (shareBoardModalOpenRef.current && shareBoardTargetIdRef.current === targetId) {
          setShareTemplateStatus(err?.message || "Unable to create template share.");
        }
      } finally {
        if (shareBoardModalOpenRef.current && shareBoardTargetIdRef.current === targetId) {
          setShareTemplateBusy(false);
        }
      }
    },
    [
      calendarEvents,
      defaultRelays,
      normalizeRelayList,
      shareTemplateBusy,
      tasks,
    ],
  );
  const handleShareBoardToContact = useCallback(
    async (contact: Contact) => {
      if (!shareBoardTarget) {
        setShareContactStatus("Select a board to share first.");
        return;
      }
      const shareId =
        shareBoardMode === "template"
          ? shareTemplateShare?.id
          : shareBoardTarget.nostr?.boardId;
      if (!shareId) {
        setShareContactStatus(
          shareBoardMode === "template" ? "Generate a template share first." : "Enable sharing first.",
        );
        return;
      }
      const recipient = normalizeNostrPubkey(contact.npub);
      if (!recipient) {
        setShareContactStatus("Contact is missing a valid npub.");
        return;
      }
      const relayList = normalizeRelayList(
        shareBoardMode === "template"
          ? shareTemplateShare?.relays
          : shareBoardTarget.nostr?.relays?.length
            ? shareBoardTarget.nostr.relays
            : defaultRelays.length
              ? defaultRelays
              : Array.from(DEFAULT_NOSTR_RELAYS),
      );
      if (!relayList.length) {
        setShareContactStatus("No relays configured for sharing.");
        return;
      }
      let senderNpub: string | null = null;
      try {
        if (nostrPK) {
          senderNpub = typeof (nip19 as any)?.npubEncode === "function" ? (nip19 as any).npubEncode(hexToBytes(nostrPK)) : null;
        }
      } catch {
        senderNpub = null;
      }
      setShareContactBusy(true);
      setShareContactStatus(null);
      try {
        const envelope = buildBoardShareEnvelope(
          shareId,
          shareBoardTarget.name,
          relayList,
          senderNpub ? { npub: senderNpub } : undefined,
        );
        await sendShareMessage(envelope, recipient, nostrSkHex, relayList);
        setShareContactPickerOpen(false);
        showToast(`Board sent to ${contactPrimaryName(contact)}`);
      } catch (err: any) {
        setShareContactStatus(err?.message || "Unable to share board.");
      } finally {
        setShareContactBusy(false);
      }
    },
    [
      defaultRelays,
      normalizeRelayList,
      nostrPK,
      nostrSkHex,
      shareBoardMode,
      shareBoardTarget,
      shareTemplateShare,
      showToast,
    ],
  );
  useEffect(() => {
    if (!shareBoardModalOpen) return;
    if (shareBoardMode !== "template") return;
    if (!shareBoardTarget?.nostr?.boardId) return;
    if (shareTemplateShare?.boardId === shareBoardTarget.id) return;
    if (shareTemplateBusy) return;
    void createTemplateShare(shareBoardTarget);
  }, [
    createTemplateShare,
    shareBoardModalOpen,
    shareBoardMode,
    shareBoardTarget,
    shareTemplateBusy,
    shareTemplateShare,
  ]);
  useEffect(() => {
    if (!shareBoardModalOpen || !shareBoardTargetId) return;
    if (shareTemplateShare && shareTemplateShare.boardId !== shareBoardTargetId) {
      setShareTemplateShare(null);
      setShareTemplateStatus(null);
    }
  }, [shareBoardModalOpen, shareBoardTargetId, shareTemplateShare]);
  const applyBoardEvent = useCallback(async (ev: NostrEvent) => {
    const d = tagValue(ev, "d");
    if (!d) return;
    const board = boardsRef.current.find((b) => b.nostr?.boardId && boardTag(b.nostr.boardId) === d);
    if (!board || !board.nostr) return;
    const boardId = board.nostr.boardId;
    let boardKeys;
    try {
      boardKeys = await deriveBoardNostrKeys(boardId);
    } catch {
      return;
    }
    if (ev.pubkey !== boardKeys.pk) return;
    let payload: any;
    try {
      const { plaintext } = await decryptFromBoard(boardId, ev.content);
      payload = plaintext ? JSON.parse(plaintext) : {};
    } catch {
      return;
    }
    if (!ledger.acceptBoardMeta(d, ev.created_at)) return;
    const kindTag = tagValue(ev, "k");
    const name = tagValue(ev, "name");
    setBoards((prev) => {
      const boardIndex = prev.findIndex((item) => item.id === board.id);
      if (boardIndex === -1) return prev;

      let working = prev.slice();
      const current = working[boardIndex];
      const nm = name || current.name;
      const clearCompletedDisabled =
        typeof payload?.clearCompletedDisabled === "boolean"
          ? payload.clearCompletedDisabled
          : !!current.clearCompletedDisabled;
      const listIndexEnabled =
        typeof payload?.listIndex === "boolean"
          ? payload.listIndex
          : (current.kind === "lists" || current.kind === "compound" ? !!current.indexCardEnabled : false);

      const parentRelays = (() => {
        const relays = current.nostr?.relays?.length
          ? current.nostr!.relays
          : board.nostr?.relays?.length
            ? board.nostr.relays
            : defaultRelays;
        return Array.from(new Set(relays.filter(Boolean)));
      })();

      const ensureChildStub = (state: Board[], child: string): { id: string; boards: Board[] } => {
        const trimmed = child.trim();
        if (!trimmed) return { id: "", boards: state };
        const existing = findBoardByCompoundChildId(state, trimmed);
        if (existing) {
          return { id: existing.id, boards: state };
        }
        const stub: Board = {
          id: trimmed,
          name: "Linked board",
          kind: "lists",
          columns: [{ id: crypto.randomUUID(), name: "Items" }],
          nostr: { boardId: trimmed, relays: parentRelays },
          archived: true,
          hidden: true,
          clearCompletedDisabled: false,
          indexCardEnabled: false,
          order: state.length,
        };
        return { id: stub.id, boards: withBoardOrder([...state, stub]) };
      };

      const buildNext = (): { board: Board; boards: Board[] } => {
        if (kindTag === "week") {
          const next: Board = {
            id: current.id,
            name: nm,
            nostr: current.nostr,
            kind: "week",
            archived: current.archived,
            hidden: current.hidden,
            clearCompletedDisabled,
            order: current.order,
          };
          return { board: next, boards: working };
        }
        if (kindTag === "lists") {
          const cols: ListColumn[] = Array.isArray(payload?.columns)
            ? payload.columns
            : current.kind === "lists"
              ? current.columns
              : [{ id: crypto.randomUUID(), name: "Items" }];
          const next: Board = {
            id: current.id,
            name: nm,
            nostr: current.nostr,
            kind: "lists",
            columns: cols,
            archived: current.archived,
            hidden: current.hidden,
            clearCompletedDisabled,
            indexCardEnabled: listIndexEnabled,
            order: current.order,
          };
          return { board: next, boards: working };
        }
        if (kindTag === "compound") {
          const rawChildren: string[] = Array.isArray(payload?.children)
            ? payload.children.filter((child: unknown): child is string => typeof child === "string")
            : current.kind === "compound"
              ? current.children
              : [];
          const hideBoardNames =
            typeof payload?.hideBoardNames === "boolean"
              ? payload.hideBoardNames
              : current.kind === "compound"
                ? !!current.hideChildBoardNames
                : false;
          const seen = new Set<string>();
          let boardsState = working;
          const children = rawChildren.reduce<string[]>((acc, child) => {
            const result = ensureChildStub(boardsState, child);
            boardsState = result.boards;
            const canonical = result.id;
            if (!canonical || seen.has(canonical)) return acc;
            seen.add(canonical);
            acc.push(canonical);
            return acc;
          }, []);
          const next: Board = {
            id: current.id,
            name: nm,
            nostr: current.nostr,
            kind: "compound",
            children,
            archived: current.archived,
            hidden: current.hidden,
            clearCompletedDisabled,
            indexCardEnabled: listIndexEnabled,
            hideChildBoardNames: hideBoardNames,
            order: current.order,
          };
          return { board: next, boards: boardsState };
        }
        const next: Board = {
          ...current,
          name: nm,
          clearCompletedDisabled,
          ...(current.kind === "lists" || current.kind === "compound"
            ? {
                indexCardEnabled: listIndexEnabled,
                ...(current.kind === "compound"
                  ? { hideChildBoardNames: current.hideChildBoardNames }
                  : {}),
              }
            : {}),
        } as Board;
        return { board: next, boards: working };
      };

      const { board: updatedBoard, boards: updatedBoards } = buildNext();
      if (updatedBoards !== working) {
        working = updatedBoards;
      }
      const targetIndex = working.findIndex((item) => item.id === current.id);
      if (targetIndex === -1) {
        return working;
      }
      working[targetIndex] = updatedBoard;
      return withBoardOrder(working);
    });
  }, [setBoards, tagValue, defaultRelays]);
  const applyTaskEvent = useCallback(async (ev: NostrEvent) => {
    const bTag = tagValue(ev, "b");
    const taskId = tagValue(ev, "d");
    if (!bTag || !taskId) return;
    const lb = boardsRef.current.find((b) => b.nostr?.boardId && boardTag(b.nostr.boardId) === bTag);
    if (!lb || !lb.nostr) return;
    const boardId = lb.nostr.boardId;
    let boardKeys;
    try {
      boardKeys = await deriveBoardNostrKeys(boardId);
    } catch {
      return;
    }
    if (ev.pubkey !== boardKeys.pk) return;
    let payload: any;
    try {
      const { plaintext } = await decryptFromBoard(boardId, ev.content);
      payload = plaintext ? JSON.parse(plaintext) : {};
    } catch {
      return;
    }
    // Newer wins; as new wins too (rapid consecutive updates), unless a local publish is pending.
    if (!ledger.acceptTaskEvent(bTag, taskId, ev.created_at)) return;
    // Advance the in-memory cursor for this board so we know the high-water mark.
    // Key by bTag (SHA256 of nostrBoardId) — must match the lookup in the
    // subscription setup where it.id = boardTag(b.nostr!.boardId) = bTag.
    // Also persist incrementally every 100 events: if the app crashes before EOSE
    // the cursor survives and the next open re-fetches only unprocessed events.
    if (typeof ev.created_at === "number" && Number.isFinite(ev.created_at)) {
      const prev = boardSyncCursorsRef.current[bTag] ?? 0;
      if (ev.created_at > prev) {
        boardSyncCursorsRef.current = { ...boardSyncCursorsRef.current, [bTag]: ev.created_at };
        if (ledger.taskCount(bTag) % 100 === 0) {
          try {
            idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS, JSON.stringify(boardSyncCursorsRef.current));
          } catch { /* non-fatal */ }
        }
      }
    }

    const status = tagValue(ev, "status");
    const incoming = parseTaskEvent(
      payload,
      { taskId, status, column: tagValue(ev, "col"), createdAt: ev.created_at },
      lb,
      new Date(),
    );
    const { base } = incoming;
    if (base.recurrence?.untilISO && !Number.isNaN(Date.parse(base.recurrence.untilISO))) {
      const seriesEndKey = isoDatePart(base.recurrence.untilISO, base.dueTimeZone);
      const occurrenceKey = isoDatePart(base.dueISO, base.dueTimeZone);
      if (seriesEndKey < occurrenceKey) {
        recordRecurringSeriesCutoff(base, base.recurrence.untilISO);
      }
    }
    // Key used for both the live setTasks path and the batch Map path.
    const taskKey = `${lb.id}::${taskId}`;
    // Remembered like a local deletion: the task leaves the list, so without this full-week
    // generation recreated an occurrence another device deleted and republished it, open, to
    // every device.
    if (status === "deleted") recordTaskTombstone(bTag, taskId, ev.created_at);

    // ── Per-relay batch path (relay hasn't fired EOSE yet) ───────────────────
    // Route event into the relay-specific batch Map. On EOSE, the relay's batch
    // is clock-protected-merged into state. IDB data is always visible immediately.
    // evRelay is captured from pool.subscribe's onEvent(ev, relay) argument.
    const evRelay = (ev as any).__relay as string | undefined;
    const isPendingRelay = evRelay && pendingRelaysByBoardRef.current.get(bTag)?.has(evRelay);
    if (isPendingRelay) {
      let boardBatch = relayBatchRef.current.get(bTag);
      if (!boardBatch) { boardBatch = new Map(); relayBatchRef.current.set(bTag, boardBatch); }
      let batchMap = boardBatch.get(evRelay!);
      if (!batchMap) { batchMap = new Map(); boardBatch.set(evRelay!, batchMap); }
      if (status === "deleted") {
        batchMap.set(taskKey, { _deleted: true, _nostrAt: ev.created_at });
      } else {
        // Merged over what this relay already batched for the task.
        const existing = batchMap.get(taskKey);
        const cur = existing && !("_deleted" in existing) ? (existing as Task) : undefined;
        batchMap.set(taskKey, mergeIncomingTask(cur, incoming, {
          nostrAt: ev.created_at,
          order: cur?.order ?? 0,
          now: Date.now(),
          eventPubkey: ev.pubkey,
          incomingIsNewerOnTie: ev.created_at > ledger.taskAt(bTag, taskId),
        }));
      }
      return; // ← do NOT call setTasks; flush happens at relay EOSE
    }

    // ── Live path (sync already complete, normal per-event update) ────────────
    // Enqueue the updater into the micro-batch coalescer instead of calling
    // setTasks directly. Multiple events arriving within LIVE_BATCH_MS are
    // applied sequentially inside a single setTasks call so React only renders
    // once. The clock check already rejected older events above, so each updater
    // here represents a genuinely newer state — applying them in arrival order
    // (newest clock wins) produces the correct final state without flicker.
    const liveUpdater = (prev: Task[]) => {
      if (!ledger.isTaskEventCurrent(bTag, taskId, ev.created_at)) return prev;
      const idx = prev.findIndex((x) => x.id === taskId && x.boardId === lb.id);
      if (status === "deleted") {
        if (idx < 0) return prev;
        return dedupeRecurringInstances(prev.filter((_, i) => i !== idx));
      }
      const current = idx >= 0 ? prev[idx] : undefined;
      const merged = mergeIncomingTask(current, incoming, {
        nostrAt: ev.created_at,
        order: typeof current?.order === "number"
          ? current.order
          : nextOrderForBoard(base.boardId, prev, settings.newTaskPosition),
        now: Date.now(),
        eventPubkey: ev.pubkey,
        incomingIsNewerOnTie: ev.created_at > ledger.taskAt(bTag, taskId),
      });
      if (idx < 0) return dedupeRecurringInstances([...prev, merged]);
      const copy = prev.slice();
      copy[idx] = merged;
      return dedupeRecurringInstances(copy);
    };

    // Enqueue liveUpdater into the micro-batch coalescer
    let batch = liveBatchRef.current.get(bTag);
    if (!batch) {
      batch = { updaters: [], timer: 0 };
      liveBatchRef.current.set(bTag, batch);
    }
    batch.updaters.push(liveUpdater);
    window.clearTimeout(batch.timer);
    batch.timer = window.setTimeout(() => {
      const b = liveBatchRef.current.get(bTag);
      if (!b) return;
      liveBatchRef.current.delete(bTag);
      setTasks(prev => {
        let result = prev;
        for (const updater of b.updaters) result = updater(result);
        return sanitizeRecurringTasks(result);
      });
    }, LIVE_BATCH_MS);
  }, [recordRecurringSeriesCutoff, sanitizeRecurringTasks, setTasks, settings.newTaskPosition, tagValue]);

  function sameSeries(a: Task, b: Task): boolean {
    return tasksInSameSeries(a, b);
  }

  /**
   * Full-week mode: adds this week's occurrences of frequent series to `arr` and publishes them.
   * Call it on the current list (`tasksStore().get()`), never inside a `setTasks` updater.
   */
  function ensureWeekRecurrences(arr: Task[], sources?: Task[]): Task[] {
    const boundedTasks = sanitizeRecurringTasks(arr);
    const boundedSources = sources ? sanitizeRecurringTasks(sources) : undefined;
    const { tasks: ensured, generated } = ensureWeekRecurrencesForCurrentWeek({
      tasks: boundedTasks,
      sources: boundedSources,
      weekStart: settings.weekStart,
      newTaskPosition: settings.newTaskPosition,
      dedupeRecurringInstances,
      isFrequentRecurrence,
      nextOccurrence,
      startOfWeek: startOfWeek as (date: Date, weekStart: number) => Date,
      recurringInstanceId,
      isoDatePart,
      taskDateKey,
      nextOrderForBoard,
      canGenerateForBoard: isBoardReadyForGeneratedTasks,
      isDeletedOccurrence: (boardId, taskId) => {
        const board = findBoardByCompoundChildId(boards, boardId);
        const nostrBoardId = board?.nostr?.boardId;
        return !!nostrBoardId && ledger.isTombstoned(boardTag(nostrBoardId), taskId);
      },
    });
    generated.forEach((task) => maybePublishTask(task).catch(() => {}));
    return sanitizeRecurringTasks(ensured);
  }
  const ensureWeekRecurrencesRef = useRef(ensureWeekRecurrences);
  ensureWeekRecurrencesRef.current = ensureWeekRecurrences;

  const ensureCalendarRecurrenceWindow = useCallback(() => {
    const next = planCalendarRecurrenceWindow(calendarEventsStore().get(), {
      boards,
      now: new Date(),
      settings: { weekStart: settings.weekStart, newTaskPosition: settings.newTaskPosition },
      deletedOccurrenceIds: deletedCalendarOccurrenceIdsRef.current,
      canGenerateForBoard: isBoardReadyForGeneratedTasks,
    });
    if (next) setCalendarEvents(next);
  }, [boards, isBoardReadyForGeneratedTasks, setCalendarEvents, settings.newTaskPosition, settings.weekStart]);

  useEffect(() => {
    ensureCalendarRecurrenceWindow();
    // Re-run as boards finish initial sync: generation waits for their tombstones.
  }, [calendarEvents, ensureCalendarRecurrenceWindow, pendingNostrInitialSyncByBoardTag]);

  useEffect(() => {
    let timer: number | null = null;
    const schedule = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
      const delay = Math.max(1000, next.getTime() - now.getTime());
      timer = window.setTimeout(() => {
        ensureCalendarRecurrenceWindow();
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ensureCalendarRecurrenceWindow]);
  type InlineImportType = "task" | "event";
  type InlineImportItem = {
    type: InlineImportType;
    payload: Record<string, unknown>;
  };

  function normalizeInlineJsonPunctuation(raw: string): string {
    return (raw || "")
      .replace(/\u00A0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[：]/g, ":")
      .replace(/[，]/g, ",")
      .replace(/[［]/g, "[")
      .replace(/[］]/g, "]")
      .replace(/[｛]/g, "{")
      .replace(/[｝]/g, "}");
  }

  function normalizeInlineJsonInput(raw: string): string {
    return normalizeInlineJsonPunctuation(raw)
      .replace(/[“”„‟]/g, "\"")
      .replace(/[‘’‚‛]/g, "'");
  }

  function normalizeInlineSmartQuotedJsonInput(raw: string): string {
    const source = normalizeInlineJsonPunctuation(raw);
    let out = "";
    let inSmartString = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "“" || ch === "”" || ch === "„" || ch === "‟") {
        inSmartString = !inSmartString;
        out += "\"";
        continue;
      }
      if (inSmartString) {
        if (ch === "\\") {
          out += "\\\\";
          continue;
        }
        if (ch === "\"") {
          out += "\\\"";
          continue;
        }
        if (ch === "\r") {
          if (source[i + 1] === "\n") continue;
          out += "\\n";
          continue;
        }
        if (ch === "\n") {
          out += "\\n";
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  function tryParseInlineJson(raw: string): { ok: true; value: unknown } | { ok: false } {
    const normalized = normalizeInlineJsonInput(raw);
    const smartQuoted = normalizeInlineSmartQuotedJsonInput(raw);
    const attempts = Array.from(new Set([raw, normalized, smartQuoted]));
    for (const attempt of attempts) {
      try {
        return { ok: true, value: JSON.parse(attempt) };
      } catch {
        // continue trying
      }
    }
    return { ok: false };
  }

  function extractInlineImportRoot(raw: string): unknown | undefined {
    const trimmed = (raw || "").trim();
    if (!trimmed) return undefined;

    const direct = tryParseInlineJson(trimmed);
    if (direct.ok) return direct.value;

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      const block = tryParseInlineJson(fenced[1].trim());
      if (block.ok) return block.value;
    }

    const lines = trimmed.split(/\n+/g).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1) {
      const parsedLines: unknown[] = [];
      for (const line of lines) {
        const parsed = tryParseInlineJson(line);
        if (!parsed.ok) return undefined;
        parsedLines.push(parsed.value);
      }
      return parsedLines;
    }

    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      const slicedObject = tryParseInlineJson(trimmed.slice(objectStart, objectEnd + 1));
      if (slicedObject.ok) return slicedObject.value;
    }

    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      const slicedArray = tryParseInlineJson(trimmed.slice(arrayStart, arrayEnd + 1));
      if (slicedArray.ok) return slicedArray.value;
    }

    return undefined;
  }

  function detectInlineImportType(
    payload: Record<string, unknown>,
    forcedType?: InlineImportType,
  ): InlineImportType | null {
    if (forcedType) return forcedType;

    const rawType = typeof payload.type === "string" ? payload.type.trim().toLowerCase() : "";
    if (rawType === "task") return "task";
    if (rawType === "event" || rawType === "calendar-event" || rawType === "calendar_event") return "event";
    if (rawType === "board" || rawType === "contact") return null;

    const rawKind = typeof payload.kind === "string" ? payload.kind.trim().toLowerCase() : "";
    if (rawKind === "date" || rawKind === "time") return "event";

    if (
      typeof payload.startISO === "string" ||
      typeof payload.endISO === "string" ||
      typeof payload.startDate === "string" ||
      typeof payload.endDate === "string" ||
      typeof payload.start === "string" ||
      typeof payload.end === "string"
    ) {
      return "event";
    }

    return "task";
  }

  function collectInlineImportItems(root: unknown, forcedType?: InlineImportType): InlineImportItem[] {
    if (Array.isArray(root)) {
      return root.flatMap((entry) => collectInlineImportItems(entry, forcedType));
    }
    if (!root || typeof root !== "object") return [];

    const record = root as Record<string, unknown>;

    if (record.v === 1 && record.kind === "taskify-share" && record.item) {
      return collectInlineImportItems(record.item, forcedType);
    }

    const groupedItems: InlineImportItem[] = [];
    const tasksValue = record.tasks;
    const eventsValue = record.events;
    const itemsValue = record.items;

    if (Array.isArray(tasksValue)) {
      groupedItems.push(...tasksValue.flatMap((entry) => collectInlineImportItems(entry, "task")));
    }
    if (Array.isArray(eventsValue)) {
      groupedItems.push(...eventsValue.flatMap((entry) => collectInlineImportItems(entry, "event")));
    }
    if (Array.isArray(itemsValue)) {
      groupedItems.push(...itemsValue.flatMap((entry) => collectInlineImportItems(entry, forcedType)));
    }
    if (groupedItems.length) return groupedItems;

    const detectedType = detectInlineImportType(record, forcedType);
    if (!detectedType) return [];
    return [{ type: detectedType, payload: record }];
  }

  function parseInlineImportItems(raw: string): InlineImportItem[] {
    const root = extractInlineImportRoot(raw);
    if (root === undefined) return [];
    return collectInlineImportItems(root);
  }

  function normalizeImportedSubtasks(value: unknown): Subtask[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const subtasks: Subtask[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        const title = entry.trim();
        if (!title) continue;
        subtasks.push({ id: crypto.randomUUID(), title, completed: false });
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const title = typeof (entry as any).title === "string" ? (entry as any).title.trim() : "";
      if (!title) continue;
      subtasks.push({
        id: crypto.randomUUID(),
        title,
        completed: !!(entry as any).completed,
      });
    }
    return subtasks.length ? subtasks : undefined;
  }

  function normalizeImportedStringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    return out.length ? Array.from(new Set(out)) : undefined;
  }

  function normalizeImportedParticipants(value: unknown): CalendarEventParticipant[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out: CalendarEventParticipant[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const pubkey = typeof (entry as any).pubkey === "string" ? (entry as any).pubkey.trim() : "";
      if (!pubkey) continue;
      const relay = typeof (entry as any).relay === "string" ? (entry as any).relay.trim() : "";
      const role = typeof (entry as any).role === "string" ? (entry as any).role.trim() : "";
      out.push({
        pubkey,
        ...(relay ? { relay } : {}),
        ...(role ? { role } : {}),
      });
    }
    return out.length ? out : undefined;
  }

  function normalizeImportedRecurrence(value: unknown): Recurrence | undefined {
    const normalized = normalizeTaskRecurrence(value) as Recurrence | undefined;
    return normalized?.type === "none" ? undefined : normalized;
  }

  function normalizeImportedDateKey(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!ISO_DATE_PATTERN.test(trimmed)) return undefined;
    return parseDateKey(trimmed) ? trimmed : undefined;
  }

  function buildImportedTaskFromPayload(
    payload: Record<string, unknown>,
    options: { overrides?: Partial<Task>; taskPool: Task[] },
  ): Task | null {
    if (!currentBoard) return null;

    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    if (!title) return null;

    const overrides = options.overrides ?? {};
    const { dueISO: overrideDueISORaw, ...overridesWithoutDueISO } = overrides;
    const baseBoardId = typeof overrides.boardId === "string" ? overrides.boardId : currentBoard.id;
    const nextOrder = nextOrderForBoard(baseBoardId, options.taskPool, settings.newTaskPosition);
    const id = crypto.randomUUID();

    const parsedDueISO =
      normalizeIsoTimestamp(payload.dueISO)
      ?? normalizeIsoTimestamp(payload.startISO)
      ?? (() => {
        const startDate = normalizeImportedDateKey(payload.startDate);
        return startDate ? isoFromDateTime(startDate) : undefined;
      })();
    const overrideDueISO = typeof overrideDueISORaw === "string" ? normalizeIsoTimestamp(overrideDueISORaw) : undefined;
    const dueDateEnabled = typeof payload.dueDateEnabled === "boolean" ? payload.dueDateEnabled : !!parsedDueISO;
    const dueTimeEnabled = typeof payload.dueTimeEnabled === "boolean" ? payload.dueTimeEnabled : undefined;
    const dueTimeZoneRaw =
      typeof payload.dueTimeZone === "string"
        ? payload.dueTimeZone
        : typeof payload.startTzid === "string"
          ? payload.startTzid
          : undefined;
    const dueTimeZone = normalizeTimeZone(dueTimeZoneRaw) ?? undefined;
    let dueISO = parsedDueISO || isoForToday();
    if (overrideDueISO) {
      if (parsedDueISO && dueTimeEnabled) {
        const targetDate = isoDatePart(overrideDueISO, dueTimeZone);
        const sourceTime = isoTimePart(parsedDueISO, dueTimeZone);
        const recomposed = isoFromDateTime(targetDate, sourceTime || undefined, dueTimeZone);
        dueISO = normalizeIsoTimestamp(recomposed) || overrideDueISO;
      } else {
        dueISO = overrideDueISO;
      }
    }
    const reminders = sanitizeReminderList(payload.reminders);
    const reminderTime = normalizeReminderTime(payload.reminderTime);
    const priority = normalizeTaskPriority(payload.priority);
    const createdAt = normalizeTaskCreatedAt(payload.createdAt) ?? Date.now();
    const createdBy =
      normalizeAgentPubkey(payload.createdBy)
      ?? normalizeAgentPubkey(overrides.createdBy)
      ?? undefined;
    const lastEditedBy =
      normalizeAgentPubkey(payload.lastEditedBy)
      ?? normalizeAgentPubkey(overrides.lastEditedBy)
      ?? createdBy;
    const documents = normalizeDocumentList(payload.documents);
    const images = Array.isArray(payload.images)
      ? payload.images
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter(Boolean)
      : undefined;
    const noteRaw =
      typeof payload.note === "string"
        ? payload.note.trim()
        : typeof payload.description === "string"
          ? payload.description.trim()
          : "";
    const recurrence = normalizeImportedRecurrence(payload.recurrence);
    const subtasks = normalizeImportedSubtasks(payload.subtasks);

    const imported: Task = {
      id,
      boardId: baseBoardId,
      order: nextOrder,
      title,
      dueISO,
      createdAt,
      ...(createdBy ? { createdBy } : {}),
      ...(lastEditedBy ? { lastEditedBy } : {}),
      completed: false,
      ...(priority ? { priority } : {}),
      ...(noteRaw ? { note: noteRaw } : {}),
      ...(images?.length ? { images } : {}),
      ...(documents ? { documents: documents.map(ensureDocumentPreview) } : {}),
      ...(subtasks?.length ? { subtasks } : {}),
      ...(typeof dueDateEnabled === "boolean" ? { dueDateEnabled } : {}),
      ...(typeof dueTimeEnabled === "boolean" ? { dueTimeEnabled } : {}),
      ...(dueTimeZone ? { dueTimeZone } : {}),
      ...(reminders !== undefined ? { reminders } : {}),
      ...(reminderTime ? { reminderTime } : {}),
      ...(recurrence ? { recurrence, seriesId: id } : {}),
      ...overridesWithoutDueISO,
    };

    imported.boardId = typeof imported.boardId === "string" ? imported.boardId : baseBoardId;
    if (imported.recurrence) imported.seriesId = imported.seriesId || id;
    else imported.seriesId = undefined;
    return imported;
  }

  function buildImportedCalendarEventFromPayload(
    payload: Record<string, unknown>,
    options: {
      boardId: string;
      boardKind: Board["kind"];
      columnId?: string;
      fallbackDateKey: string;
      eventPool: CalendarEvent[];
    },
  ): CalendarEvent | null {
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    if (!title) return null;

    const id = crypto.randomUUID();
    const order = nextOrderForCalendarBoard(options.boardId, options.eventPool, settings.newTaskPosition);
    const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
    const descriptionRaw =
      typeof payload.description === "string"
        ? payload.description.trim()
        : typeof payload.note === "string"
          ? payload.note.trim()
          : "";
    const documents = normalizeDocumentList(payload.documents);
    const image = typeof payload.image === "string" ? payload.image.trim() : "";
    const geohash = typeof payload.geohash === "string" ? payload.geohash.trim() : "";
    const location = typeof payload.location === "string" ? payload.location.trim() : "";
    const locations = normalizeImportedStringList(payload.locations) ?? (location ? [location] : undefined);
    const hashtags = normalizeImportedStringList(payload.hashtags);
    const references = normalizeImportedStringList(payload.references);
    const participants = normalizeImportedParticipants(payload.participants);
    const reminders = sanitizeReminderList(payload.reminders);
    const reminderTime = normalizeReminderTime(payload.reminderTime);
    const recurrence = normalizeImportedRecurrence(payload.recurrence);
    const createdBy =
      normalizeAgentPubkey(payload.createdBy)
      ?? normalizeAgentPubkey(nostrPK)
      ?? undefined;
    const lastEditedBy =
      normalizeAgentPubkey(payload.lastEditedBy)
      ?? createdBy;

    const base: CalendarEventBase = {
      id,
      boardId: options.boardId,
      ...(createdBy ? { createdBy } : {}),
      ...(lastEditedBy ? { lastEditedBy } : {}),
      ...(options.columnId ? { columnId: options.columnId } : {}),
      order,
      title,
      ...(summary ? { summary } : {}),
      ...(descriptionRaw ? { description: descriptionRaw } : {}),
      ...(documents ? { documents: documents.map(ensureDocumentPreview) } : {}),
      ...(image ? { image } : {}),
      ...(locations ? { locations } : {}),
      ...(geohash ? { geohash } : {}),
      ...(participants ? { participants } : {}),
      ...(hashtags ? { hashtags } : {}),
      ...(references ? { references } : {}),
      ...(reminders ? { reminders } : {}),
      ...(reminderTime ? { reminderTime } : {}),
      ...(recurrence ? { recurrence, seriesId: id } : {}),
    };

    const rawKind = typeof payload.kind === "string" ? payload.kind.trim().toLowerCase() : "";
    const inferredKind: "date" | "time" =
      rawKind === "time" || rawKind === "date"
        ? (rawKind as "date" | "time")
        : (
            typeof payload.startISO === "string"
            || typeof payload.endISO === "string"
            || typeof payload.startTime === "string"
            || typeof payload.endTime === "string"
            || typeof payload.time === "string"
            || payload.dueTimeEnabled === true
          )
          ? "time"
          : (
              typeof payload.startDate === "string"
              || typeof payload.endDate === "string"
              || typeof payload.start === "string"
              || typeof payload.end === "string"
            )
            ? "date"
            : "date";

    if (inferredKind === "time") {
      const startTzid = normalizeTimeZone(
        typeof payload.startTzid === "string"
          ? payload.startTzid
          : typeof payload.timeZone === "string"
            ? payload.timeZone
            : typeof payload.dueTimeZone === "string"
              ? payload.dueTimeZone
              : undefined,
      ) ?? undefined;
      const endTzid = normalizeTimeZone(
        typeof payload.endTzid === "string" ? payload.endTzid : startTzid,
      ) ?? startTzid;

      let startISO =
        normalizeIsoTimestamp(payload.startISO)
        ?? normalizeIsoTimestamp(payload.start)
        ?? normalizeIsoTimestamp(payload.dueISO);
      if (!startISO) {
        const startDate =
          normalizeImportedDateKey(payload.startDate)
          ?? normalizeImportedDateKey(payload.start)
          ?? normalizeImportedDateKey(payload.date)
          ?? options.fallbackDateKey;
        const startTime =
          normalizeReminderTime(payload.startTime)
          ?? normalizeReminderTime(payload.time)
          ?? "09:00";
        startISO = isoFromDateTime(startDate, startTime, startTzid);
      }
      const startMs = Date.parse(startISO);
      if (Number.isNaN(startMs)) return null;

      let endISO = normalizeIsoTimestamp(payload.endISO) ?? normalizeIsoTimestamp(payload.end);
      if (!endISO) {
        const endDate =
          normalizeImportedDateKey(payload.endDate)
          ?? normalizeImportedDateKey(payload.end);
        if (endDate) {
          const endTime =
            normalizeReminderTime(payload.endTime)
            ?? normalizeReminderTime(payload.time)
            ?? "10:00";
          endISO = isoFromDateTime(endDate, endTime, endTzid ?? startTzid);
        }
      }
      const endMs = endISO ? Date.parse(endISO) : Number.NaN;
      const normalizedEvent: CalendarEvent = applyHiddenForCalendarEvent(
        {
          ...base,
          kind: "time",
          startISO,
          ...(!Number.isNaN(endMs) && endMs > startMs ? { endISO } : {}),
          ...(startTzid ? { startTzid } : {}),
          ...(endTzid ? { endTzid } : {}),
        },
        settings.weekStart,
        options.boardKind,
      );
      return normalizedEvent;
    }

    const startDate =
      normalizeImportedDateKey(payload.startDate)
      ?? normalizeImportedDateKey(payload.start)
      ?? normalizeImportedDateKey(payload.date)
      ?? (() => {
        const startISO =
          normalizeIsoTimestamp(payload.startISO)
          ?? normalizeIsoTimestamp(payload.start)
          ?? normalizeIsoTimestamp(payload.dueISO);
        return startISO ? isoDatePart(startISO) : undefined;
      })()
      ?? options.fallbackDateKey;
    const endDateRaw =
      normalizeImportedDateKey(payload.endDate)
      ?? normalizeImportedDateKey(payload.end)
      ?? (() => {
        const endISO = normalizeIsoTimestamp(payload.endISO) ?? normalizeIsoTimestamp(payload.end);
        return endISO ? isoDatePart(endISO) : undefined;
      })();
    const normalizedEvent: CalendarEvent = applyHiddenForCalendarEvent(
      {
        ...base,
        kind: "date",
        startDate,
        ...(endDateRaw && endDateRaw >= startDate ? { endDate: endDateRaw } : {}),
      },
      settings.weekStart,
      options.boardKind,
    );
    return normalizedEvent;
  }

  function openInlineTaskEditor(key: string) {
    if (!currentBoard) return;
    setAddMenuKey(key);
  }

  function openInlineTaskEditorDirect(key: string) {
    if (!currentBoard) return;

    let targetBoardId = currentBoard.id;
    let dueISO = isoForToday();
    let column: Task["column"] | undefined;
    let columnId: string | undefined;

    if (currentBoard.kind === "week") {
      column = "day";
      dueISO = isoForWeekday(Number(key) as Weekday, {
        weekStart: settings.weekStart,
      });
    } else {
      const placement = resolveListPlacement(key);
      if (!placement) {
        showToast("Add a list to this board first.");
        return;
      }
      targetBoardId = placement.boardId;
      columnId = placement.columnId;
    }

    const nextOrder = nextOrderForBoard(targetBoardId, tasks, settings.newTaskPosition);
    const dueDateEnabled = currentBoard.kind === "week";
    const draft: Task = {
      id: crypto.randomUUID(),
      boardId: targetBoardId,
      createdBy: nostrPK || undefined,
      lastEditedBy: nostrPK || undefined,
      title: "",
      createdAt: Date.now(),
      dueISO,
      dueDateEnabled,
      completed: false,
      order: nextOrder,
    };

    if (column) {
      draft.column = column;
    }
    if (columnId) {
      draft.columnId = columnId;
    }

    setEditing({ type: "task", originalType: "task", originalId: draft.id, task: draft });
  }

  function handleVoiceSave(key: string, finalTasks: FinalTask[]) {
    if (!currentBoard || !finalTasks.length) return;

    let targetBoardId = currentBoard.id;
    let dueISOBase = isoForToday();
    let columnId: string | undefined;

    if (currentBoard.kind === "week") {
      dueISOBase = isoForWeekday(Number(key) as Weekday, { weekStart: settings.weekStart });
    } else {
      const placement = resolveListPlacement(key);
      if (placement) {
        targetBoardId = placement.boardId;
        columnId = placement.columnId;
      }
    }

    const newTasks: Task[] = [];
    for (const ft of finalTasks) {
      if (!ft.title?.trim()) continue;
      const nextOrder = nextOrderForBoard(targetBoardId, [...tasks, ...newTasks], settings.newTaskPosition);
      const rawVoiceDue = typeof ft.dueISO === "string" ? ft.dueISO.trim() : "";
      const hasExplicitVoiceDue = !!rawVoiceDue;
      // Worker emits "YYYY-MM-DD" when the user gave a date but no clock
      // time, and a full ISO datetime when they did. Detect via the date-only
      // shape so we can suppress the time portion in the saved task.
      const dateOnlyParts = parseDateKey(rawVoiceDue);
      const hasExplicitVoiceTime = hasExplicitVoiceDue && !dateOnlyParts;
      const normalizedVoiceDue = !hasExplicitVoiceDue
        ? undefined
        : dateOnlyParts
          ? new Date(dateOnlyParts.year, dateOnlyParts.month - 1, dateOnlyParts.day).toISOString()
          : new Date(rawVoiceDue).toISOString();
      const reminderMinutes = Array.isArray(ft.reminderMinutesBeforeDue)
        ? ft.reminderMinutesBeforeDue.filter((value) => typeof value === "number" && Number.isFinite(value))
        : [];
      const reminderValues = sanitizeReminderList(
        reminderMinutes.map((minutes) =>
          reminderPresetIdForMode(minutes, hasExplicitVoiceTime ? "timed" : "date")
        ),
      );
      const task: Task = {
        id: crypto.randomUUID(),
        boardId: ft.boardId ?? targetBoardId,
        createdBy: nostrPK || undefined,
        lastEditedBy: nostrPK || undefined,
        title: ft.title.trim(),
        createdAt: Date.now(),
        dueISO: normalizedVoiceDue ?? dueISOBase,
        dueDateEnabled: !!(normalizedVoiceDue || currentBoard.kind === "week"),
        dueTimeEnabled: hasExplicitVoiceTime,
        completed: false,
        order: nextOrder,
      };
      if (reminderValues?.length && task.dueDateEnabled !== false) {
        task.reminders = reminderValues;
        if (!hasExplicitVoiceTime) {
          task.reminderTime = normalizeReminderTime(ft.reminderTime) ?? DEFAULT_DATE_REMINDER_TIME;
        }
      }
      if (Array.isArray(ft.subtasks) && ft.subtasks.length) {
        task.subtasks = ft.subtasks
          .map((title) => (typeof title === "string" ? title.trim() : ""))
          .filter(Boolean)
          .map((title) => ({ id: crypto.randomUUID(), title, completed: false }));
      }
      const parsedPriority = normalizeTaskPriority((ft as any).priority);
      if (parsedPriority) task.priority = parsedPriority;
      if (typeof ft.notes === "string" && ft.notes.trim()) task.note = ft.notes.trim();
      if (isVoiceRecurrence(ft.recurrence) && ft.recurrence.type !== "none") task.recurrence = ft.recurrence;
      // Voice may route the task to a named board/list; resolve placement from
      // the actual target board, falling back to the add-menu placement.
      const targetBoard = boards.find((b) => b.id === task.boardId) ?? currentBoard;
      if (targetBoard?.kind === "week") {
        task.column = "day";
        task.columnId = undefined;
      } else if (targetBoard?.kind === "lists") {
        const requestedColumnId =
          typeof ft.columnId === "string" && targetBoard.columns.some((c) => c.id === ft.columnId)
            ? ft.columnId
            : undefined;
        task.columnId = requestedColumnId
          ?? (targetBoard.id === currentBoard.id ? columnId : undefined)
          ?? targetBoard.columns[0]?.id;
      }
      applyHiddenForFuture(task, settings.weekStart, targetBoard?.kind ?? currentBoard.kind);
      newTasks.push(task);
    }

    if (!newTasks.length) return;
    setTasks((prev) => [...prev, ...newTasks]);
    newTasks.forEach((t) => maybePublishTask(t).catch(() => {}));
    showToast(newTasks.length === 1 ? "Task added" : `${newTasks.length} tasks added`);
    setVoiceDictationKey(null);
    setAddMenuKey(null);
  }

  function addInlineTask(key: string) {
    if (!currentBoard) return;
    const raw = (inlineTitles[key] || "").trim();
    if (!raw) {
      openInlineTaskEditor(key);
      return;
    }

    const originRect = inlineInputRefs.current.get(key)?.getBoundingClientRect() || null;
    const inlineOverrides: Partial<Task> = {
      createdBy: nostrPK || undefined,
      lastEditedBy: nostrPK || undefined,
    };

    if (currentBoard?.kind === "week") {
      inlineOverrides.column = "day";
      inlineOverrides.columnId = undefined;
      inlineOverrides.dueISO = isoForWeekday(Number(key) as Weekday, {
        weekStart: settings.weekStart,
      });
    } else {
      const placement = resolveListPlacement(key);
      if (!placement) {
        showToast("Add a list to this board first.");
        return;
      }
      inlineOverrides.boardId = placement.boardId;
      inlineOverrides.columnId = placement.columnId;
      inlineOverrides.column = undefined;
    }

    const importedItems = parseInlineImportItems(raw);
    if (importedItems.length) {
      const targetBoardId = inlineOverrides.boardId || currentBoard.id;
      const targetBoard = boards.find((board) => board.id === targetBoardId) ?? currentBoard;
      const fallbackDateKey =
        currentBoard.kind === "week"
          ? isoDatePart(
              inlineOverrides.dueISO || isoForWeekday(Number(key) as Weekday, { weekStart: settings.weekStart }),
            )
          : isoDatePart(new Date().toISOString());
      const taskImports = importedItems.filter((entry) => entry.type === "task");
      const eventImports = importedItems.filter((entry) => entry.type === "event");
      const createdTasks: Task[] = [];
      const createdEvents: CalendarEvent[] = [];
      const recurringSeeds: Task[] = [];
      if (taskImports.length) {
        const taskPool = tasksRef.current.slice();
        for (const entry of taskImports) {
          const importedTask = buildImportedTaskFromPayload(entry.payload, {
            overrides: inlineOverrides,
            taskPool,
          });
          if (!importedTask) continue;
          if (currentBoard.kind === "week") {
            importedTask.dueDateEnabled = true;
          }
          applyHiddenForFuture(importedTask, settings.weekStart, currentBoard.kind);
          createdTasks.push(importedTask);
          taskPool.push(importedTask);
          if (importedTask.recurrence) recurringSeeds.push(importedTask);
        }
      }

      if (eventImports.length) {
        const eventPool = calendarEventsRef.current.slice();
        for (const entry of eventImports) {
          const importedEvent = buildImportedCalendarEventFromPayload(entry.payload, {
            boardId: targetBoardId,
            boardKind: targetBoard.kind,
            columnId:
              currentBoard.kind === "week"
                ? undefined
                : typeof inlineOverrides.columnId === "string"
                  ? inlineOverrides.columnId
                  : undefined,
            fallbackDateKey,
            eventPool,
          });
          if (!importedEvent) continue;
          createdEvents.push(importedEvent);
          eventPool.push(importedEvent);
        }
      }

      if (!createdTasks.length && !createdEvents.length) {
        showToast("No valid tasks or events found in JSON.");
        return;
      }

      if (createdTasks.length) {
        const withImported = [...tasksStore().get(), ...createdTasks];
        setTasks(
          settings.showFullWeekRecurring && recurringSeeds.length
            ? ensureWeekRecurrences(withImported, recurringSeeds)
            : withImported,
        );
      }

      if (createdEvents.length) {
        setCalendarEvents((prev) => [...prev, ...createdEvents]);
      }

      if (createdTasks.length) {
        animateTaskArrival(originRect, createdTasks[0], currentBoard);
        createdTasks.forEach((task) => {
          maybePublishTask(task).catch(() => {});
        });
      }
      if (createdEvents.length) {
        createdEvents.forEach((event) => {
          maybePublishCalendarEventRef.current?.(event).catch(() => {});
        });
      }

      const totalCreated = createdTasks.length + createdEvents.length;
      if (totalCreated > 1) {
        showToast(`Added ${totalCreated} items.`);
      }
      setInlineTitles(prev => ({ ...prev, [key]: "" }));
      return;
    }

    let dueISO = isoForToday();
    const targetBoardId = inlineOverrides.boardId || currentBoard.id;
    const nextOrder = nextOrderForBoard(targetBoardId, tasks, settings.newTaskPosition);
    const id = crypto.randomUUID();
    const t: Task = {
      id,
      boardId: targetBoardId,
      createdBy: nostrPK || undefined,
      lastEditedBy: nostrPK || undefined,
      title: raw,
      createdAt: Date.now(),
      dueISO,
      completed: false,
      order: nextOrder,
    };
    t.dueDateEnabled = currentBoard.kind === "week";
    if (currentBoard?.kind === "week") {
      t.column = "day";
      dueISO = isoForWeekday(Number(key) as Weekday, {
        weekStart: settings.weekStart,
      });
      t.dueISO = dueISO;
    } else {
      t.column = undefined;
      t.columnId = inlineOverrides.columnId;
    }
    applyHiddenForFuture(t, settings.weekStart, currentBoard.kind);
    animateTaskArrival(originRect, t, currentBoard);
    setTasks(prev => [...prev, t]);
    maybePublishTask(t).catch(() => {});
    setInlineTitles(prev => ({ ...prev, [key]: "" }));
  }

  const addSharedBoardFromInbox = useCallback(
    (payload: { boardId: string; boardName?: string; relays?: string[] | undefined }) => {
      const boardId = (payload.boardId || "").trim();
      if (!boardId) return;
      const relayList = Array.from(
        new Set((payload.relays && payload.relays.length ? payload.relays : inboxRelays).map((r) => r.trim()).filter(Boolean)),
      );
      const boardName = payload.boardName?.trim() || "Shared Board";
      setBoards((prev) => {
        const defaultCols: ListColumn[] = [{ id: crypto.randomUUID(), name: "Items" }];
        const existingIndex = prev.findIndex(
          (b) => b.id === boardId || b.nostr?.boardId === boardId,
        );
        if (existingIndex >= 0) {
          const existing = prev[existingIndex];
          const columns = existing.kind === "lists" ? existing.columns : defaultCols;
          const updated: Board = {
            ...existing,
            id: existing.id,
            name: existing.name || boardName,
            kind: "lists",
            columns,
            nostr: {
              boardId: existing.nostr?.boardId || boardId,
              relays: existing.nostr?.relays?.length ? existing.nostr.relays : relayList,
            },
            archived: false,
            hidden: false,
            clearCompletedDisabled: existing.clearCompletedDisabled ?? false,
            indexCardEnabled: existing.kind === "lists" ? existing.indexCardEnabled : false,
          };
          const copy = prev.slice();
          copy[existingIndex] = updated;
          return copy;
        }
        const nextBoard: Board = {
          id: boardId,
          name: boardName,
          kind: "lists",
          columns: defaultCols,
          nostr: { boardId, relays: relayList },
          archived: false,
          hidden: false,
          clearCompletedDisabled: false,
          indexCardEnabled: false,
          order: prev.length,
        };
        return withBoardOrder([...prev, nextBoard]);
      });
    },
    [inboxRelays, setBoards],
  );
  const processedInboxBoardsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!tasks.length) return;
    tasks.forEach((task) => {
      const item = task.inboxItem;
      if (!item || item.type !== "board" || item.status !== "accepted") return;
      const boardId = (item.boardId || "").trim();
      if (!boardId || processedInboxBoardsRef.current.has(boardId)) return;
      const exists = boards.some((b) => b.id === boardId || b.nostr?.boardId === boardId);
      if (exists) {
        processedInboxBoardsRef.current.add(boardId);
        return;
      }
      processedInboxBoardsRef.current.add(boardId);
      addSharedBoardFromInbox({
        boardId,
        boardName: item.boardName,
        relays: item.relays,
      });
    });
  }, [addSharedBoardFromInbox, boards, tasks]);

  const upsertSharedContact = useCallback((payload: SharedContactPayload) => {
    const contacts = loadContactsFromStorage();
    const normalized = normalizeContact({
      id: makeContactId(),
      kind: "nostr",
      npub: payload.npub,
      name: payload.name || payload.displayName || payload.username || "",
      displayName: payload.displayName,
      username: payload.username,
      address: payload.lud16 || "",
      nip05: payload.nip05,
      relays: payload.relays,
      picture: payload.picture,
      about: payload.about,
      source: "sync",
      updatedAt: Date.now(),
    });
    if (!normalized) return null;
    const normalizedNpub = formatContactNpub(normalized.npub);
    const normalizedHex = normalizeNostrPubkey(normalized.npub || "");
    let result: Contact = { ...normalized, npub: normalizedNpub };
    const next = [...contacts];
    const existingIndex = normalizedHex
      ? contacts.findIndex((contact) => normalizeNostrPubkey(contact.npub || "") === normalizedHex)
      : -1;
    if (existingIndex >= 0) {
      const merged: Contact = {
        ...contacts[existingIndex],
        ...result,
        id: contacts[existingIndex].id,
        name: result.name || contacts[existingIndex].name,
        displayName: result.displayName || contacts[existingIndex].displayName,
        address: result.address || contacts[existingIndex].address,
        paymentRequest: contacts[existingIndex].paymentRequest,
        relays: result.relays?.length ? result.relays : contacts[existingIndex].relays,
        updatedAt: Date.now(),
      };
      result = merged;
      next[existingIndex] = merged;
    } else {
      next.push(result);
    }
    saveContactsToStorage(next);
    return result;
  }, []);

  const addSharedTaskFromInbox = useCallback(
    (payload: SharedTaskPayload, destination: SharedTaskDestination, sender?: InboxSender): Task | null => {
      const title = payload?.title?.trim();
      if (!title) return null;
      const targetBoard = boards.find((board) => board.id === destination.boardId);
      if (!targetBoard || targetBoard.archived || targetBoard.hidden) return null;
      if (targetBoard.kind !== "week" && targetBoard.kind !== "lists") return null;
      if (targetBoard.kind === "lists" && !targetBoard.columns.some((column) => column.id === destination.columnId)) return null;
      const boardId = targetBoard.id;
      const column = targetBoard.kind === "week" ? "day" : undefined;
      const columnId = targetBoard.kind === "lists" ? destination.columnId : undefined;
      const parsedDueISO = normalizeIsoTimestamp(payload.dueISO);
      const dueISO = parsedDueISO || isoForToday();
      const payloadDueDateEnabled =
        typeof payload.dueDateEnabled === "boolean" ? payload.dueDateEnabled : !!parsedDueISO;
      const dueTimeZone =
        payload.dueTimeEnabled && typeof payload.dueTimeZone === "string"
          ? normalizeTimeZone(payload.dueTimeZone)
          : undefined;
      const reminders = payload.dueTimeEnabled ? sanitizeReminderList(payload.reminders) : undefined;
      const subtasks = Array.isArray(payload.subtasks)
        ? payload.subtasks
            .map((subtask) => {
              const subtaskTitle = subtask.title?.trim() || "";
              if (!subtaskTitle) return null;
              return {
                id: crypto.randomUUID(),
                title: subtaskTitle,
                completed: !!subtask.completed,
              };
            })
            .filter((subtask): subtask is NonNullable<typeof subtask> => !!subtask)
        : undefined;
      const recurrence = normalizeImportedRecurrence(payload.recurrence);
      const priority = normalizeTaskPriority(payload.priority);
      const incomingAssignees = normalizeTaskAssignees(payload.assignees);
      const isAssignment = isAssignedSharedTask(payload);
      const senderLabel = sender ? formatSenderLabel(sender) : null;
      const sharedNote = payload.note?.trim();
      const notePrefix = senderLabel ? `${isAssignment ? "Assigned by" : "Shared by"} ${senderLabel}` : null;
      const note = [notePrefix, sharedNote].filter(Boolean).join("\n");
      const order = nextOrderForBoard(boardId, tasks, settings.newTaskPosition);
      const senderPubkey = normalizeAgentPubkey(sender?.pubkey) ?? sender?.pubkey;
      const selfPubkey = normalizeAgentPubkey(nostrPK) ?? nostrPK;
      const nextTask: Task = {
        id: crypto.randomUUID(),
        boardId,
        title,
        note: note || undefined,
        createdAt: Date.now(),
        ...(priority ? { priority } : {}),
        dueISO,
        dueDateEnabled: targetBoard.kind === "week" ? true : payloadDueDateEnabled,
        completed: false,
        order,
        createdBy: senderPubkey || selfPubkey || undefined,
        lastEditedBy: senderPubkey || selfPubkey || undefined,
        ...(payload.dueTimeEnabled ? { dueTimeEnabled: true } : {}),
        ...(dueTimeZone ? { dueTimeZone } : {}),
        ...(reminders ? { reminders } : {}),
      };
      if (column) nextTask.column = column;
      if (columnId) nextTask.columnId = columnId;
      if (subtasks?.length) nextTask.subtasks = subtasks;
      let nextAssignees = incomingAssignees;
      if (isAssignment && selfPubkey) {
        if (nextAssignees?.length) {
          nextAssignees =
            mergeTaskAssigneeResponse(nextAssignees, selfPubkey, "accepted", Date.now()) ?? nextAssignees;
        } else {
          nextAssignees = [{ pubkey: selfPubkey, status: "accepted", respondedAt: Date.now() }];
        }
      }
      if (nextAssignees?.length) {
        nextTask.assignees = nextAssignees;
      }
      if (recurrence) {
        nextTask.recurrence = recurrence;
        nextTask.seriesId = nextTask.seriesId || nextTask.id;
      }
      applyHiddenForFuture(nextTask, settings.weekStart, targetBoard.kind);
      const withShared = [...tasksStore().get(), nextTask];
      setTasks(
        settings.showFullWeekRecurring && nextTask.recurrence
          ? ensureWeekRecurrencesRef.current(withShared, [nextTask])
          : withShared,
      );
      maybePublishTaskRef.current?.(nextTask).catch(() => {});
      return nextTask;
    },
    [
      boards,
      tasks,
      formatSenderLabel,
      nostrPK,
      setTasks,
      settings.newTaskPosition,
      settings.showFullWeekRecurring,
      settings.weekStart,
    ],
  );

  const sendTaskAssignmentResponse = useCallback(
    async (inboxItem: Extract<InboxItem, { type: "task" }>, status: TaskAssigneeStatus): Promise<void> => {
      if (!isAssignedSharedTask(inboxItem.task)) return;
      if (!nostrSkHex) return;
      const recipientPubkey = normalizeAgentPubkey(inboxItem.sender.pubkey) ?? normalizeNostrPubkeyHex(inboxItem.sender.npub || "");
      if (!recipientPubkey) return;
      const relayList = relaysOrDefaults(
        Array.isArray(inboxItem.task.relays) ? inboxItem.task.relays : [],
        defaultRelays,
        inboxRelays,
      );
      if (!relayList.length) return;
      let senderNpub: string | null = null;
      try {
        if (nostrPK) {
          senderNpub =
            typeof (nip19 as any)?.npubEncode === "function"
              ? (nip19 as any).npubEncode(hexToBytes(nostrPK))
              : null;
        }
      } catch {
        senderNpub = null;
      }
      const envelope = buildTaskAssignmentResponseEnvelope(
        {
          taskId: inboxItem.task.sourceTaskId!,
          status: status === "accepted" ? "accepted" : status === "tentative" ? "tentative" : "declined",
          respondedAt: new Date().toISOString(),
        },
        senderNpub ? { npub: senderNpub } : undefined,
      );
      await sendShareMessage(envelope, recipientPubkey, nostrSkHex, relayList);
    },
    [defaultRelays, inboxRelays, nostrPK, nostrSkHex],
  );

  const [sharedTaskCopy, setSharedTaskCopy] = useState<{ task: SharedTaskPayload; sender?: InboxSender } | null>(null);
  const [sharedTaskDestinationId, setSharedTaskDestinationId] = useState<string | null>(null);
  const sharedTaskDestinationItem = tasks.find((task) => task.id === sharedTaskDestinationId)?.inboxItem;

  function completeTask(
    id: string,
    options?: { skipScriptureMemoryUpdate?: boolean; inboxAction?: "accept" | "dismiss" | "decline" | "maybe"; inboxDestination?: SharedTaskDestination }
  ): CompleteTaskResult {
    const pending = tasks.find((task) => task.id === id)?.inboxItem;
    const canAcceptSharedTask = pending?.type === "task" &&
      (!pending.status || pending.status === "pending" || pending.status === "read");
    if (options?.inboxDestination && !canAcceptSharedTask) {
      setSharedTaskDestinationId(null);
      showToast("This invitation is no longer pending.");
      return null;
    }
    if (pending?.type === "task" && canAcceptSharedTask &&
        (!options?.inboxAction || options.inboxAction === "accept")) {
      if (!options?.inboxDestination) {
        setSharedTaskDestinationId(id);
        return null;
      }
      if (!addSharedTaskFromInbox(pending.task, options.inboxDestination, pending.sender)) {
        showToast("Choose an available board and list.");
        return null;
      }
      setSharedTaskDestinationId(null);
      showToast("Task added to your board");
    }
    const plan = planCompleteTask(tasksStore().get(), id, {
      now: new Date(),
      actorPubkey: currentPubkey() ?? undefined,
      settings,
      scripture: { state: scriptureMemory, baseDays: scriptureMemoryFrequencyOption?.days ?? 1 },
      inboxAction: options?.inboxAction,
      acceptedIntoBoard: !!options?.inboxDestination,
    });
    setTasks(plan.tasks);
    plan.publish.forEach((task) => {
      maybePublishTask(task).catch(() => {});
    });
    if (plan.inboxAction?.action === "accept") {
      const item = plan.inboxAction.item;
      if (item.type === "board") {
        addSharedBoardFromInbox({
          boardId: item.boardId,
          boardName: item.boardName,
          relays: item.relays,
        });
      } else if (item.type === "contact") {
        const added = upsertSharedContact(item.contact);
        if (added) {
          showToast("Contact added to your list");
        } else {
          showToast("Unable to add contact");
        }
      }
    }
    const reply = plan.assignmentReply;
    if (reply) {
      void sendTaskAssignmentResponse(reply.item, reply.status).catch((err) => {
        console.warn("Failed to send task assignment response", err);
      });
      if (reply.status === "tentative") {
        showToast("Responded: maybe");
      } else if (reply.status === "declined") {
        showToast("Responded: declined");
      }
    }
    const memoryUpdate = plan.scriptureReview;
    if (memoryUpdate && !options?.skipScriptureMemoryUpdate) {
      scriptureLastReviewRef.current = memoryUpdate.completedAt;
      setScriptureMemory((prev) => {
        let nextState = markScriptureEntryReviewed(
          prev,
          memoryUpdate.entryId,
          memoryUpdate.completedAt,
          memoryUpdate.stageBefore
        );
        if (memoryUpdate.nextScheduled) {
          nextState = scheduleScriptureEntry(
            nextState,
            memoryUpdate.nextScheduled.entryId,
            memoryUpdate.nextScheduled.scheduledAtISO
          );
        }
        return nextState;
      });
    }
    return memoryUpdate ? { scriptureMemory: memoryUpdate } : null;
  }

  function toggleSubtask(taskId: string, subId: string) {
    const plan = planToggleSubtask(tasksStore().get(), taskId, subId, {
      now: new Date(),
      actorPubkey: currentPubkey() ?? undefined,
    });
    if (!plan) return;
    setTasks(plan.tasks);
    maybePublishTask(plan.updated).catch(() => {});
  }


  /** Saves a note from the note viewer or its editor, appending subtasks converted from it. */
  function updateTaskNote(taskId: string, note: string, appendedSubtasks: Subtask[] = []) {
    const plan = planUpdateTaskNote(tasksStore().get(), taskId, note, appendedSubtasks, {
      now: new Date(),
      actorPubkey: currentPubkey() ?? undefined,
    });
    if (!plan) return;
    setTasks(plan.tasks);
    maybePublishTask(plan.updated).catch(() => {});
  }


  completeTaskRef.current = completeTask;

  const acceptInboxMessage = (id: string) => completeTask(id, { inboxAction: "accept" });
  const dismissInboxMessage = (id: string) => completeTask(id, { inboxAction: "dismiss" });
  const maybeInboxMessage = (id: string) => completeTask(id, { inboxAction: "maybe" });
  const declineInboxMessage = (id: string) => completeTask(id, { inboxAction: "decline" });
  const markInboxMessagesRead = (dmEventIds: string[]) => {
    const normalizedIds = new Set(dmEventIds.map((id) => id.trim()).filter(Boolean));
    if (!normalizedIds.size) return;
    setTasks((prev) =>
      prev.map((task) => {
        if (task.boardId !== messagesBoardId) return task;
        const dmId = task.inboxItem?.dmEventId?.trim();
        const syntheticId = `wallet-message-${task.id}`;
        if ((!dmId || !normalizedIds.has(dmId)) && !normalizedIds.has(syntheticId)) return task;
        const status = task.inboxItem?.status;
        if (status === "accepted" || status === "declined" || status === "tentative" || status === "deleted" || status === "read") return task;
        return {
          ...task,
          inboxItem: task.inboxItem ? { ...task.inboxItem, status: "read" } : task.inboxItem,
        };
      }),
    );
    setCalendarInvites((prev) =>
      prev.map((invite) => {
        const eventId = invite.eventId?.trim();
        const syntheticId = eventId || `calendar-invite-${invite.id}`;
        if ((!eventId || !normalizedIds.has(eventId)) && !normalizedIds.has(syntheticId)) return invite;
        if (invite.status !== "pending") return invite;
        return { ...invite, status: "read" };
      }),
    );
  };

  function deleteTask(
    id: string,
    options?: { skipPrompt?: boolean; scope?: "single" | "future" }
  ) {
    const plan = planDeleteTask(tasksStore().get(), recurringCutoffsStore().get(), id, {
      now: new Date(),
      actorPubkey: currentPubkey() ?? undefined,
      settings,
      scope: options?.scope,
      skipPrompt: options?.skipPrompt,
    });
    if (plan.kind === "none") return;
    if (plan.kind === "ask-scope") {
      setRecurringDeleteTask(plan.task);
      return;
    }
    recurringCutoffsStore().set(plan.cutoffs);
    setTasks(plan.tasks);
    plan.publish.forEach((task) => maybePublishTask(task).catch(() => {}));
    plan.publishDeleted.forEach((task) => publishTaskDeleted(task).catch(() => {}));
    if (plan.archivedBounties) {
      showToast(
        options?.scope === "future"
          ? "Bounty tasks were moved to Completed. Restore to recover."
          : "Bounty task moved to Completed. Restore to recover.",
        3000,
      );
    }
    const t = plan.removed;
    if (!t) return;
    setUndoTask(t);
    if (t.scriptureMemoryId) {
      setScriptureMemory((prev) =>
        updateScriptureMemoryState(
          prev,
          prev.entries.map((entry) =>
            entry.id === t.scriptureMemoryId
              ? { ...entry, scheduledAtISO: t.scriptureMemoryScheduledAt || entry.scheduledAtISO }
              : entry
          ),
          prev.lastReviewISO
        )
      );
    }
    setTimeout(() => setUndoTask(null), 5000); // undo duration
  }
  function undoDelete() {
    if (!undoTask) return;
    const restored = undoTask;
    setTasks(prev => [...prev, restored]);
    setUndoTask(null);
    const board = boards.find((candidate) => candidate.id === restored.boardId);
    void maybePublishTask(restored, board).then(() => {
      if (board?.nostr?.boardId) {
        clearTaskTombstone(boardTag(board.nostr.boardId), restored.id);
      }
    }).catch((error) => {
      console.warn("Failed to publish restored task", error);
      showToast("Task restored locally; sync is still pending.", 3000);
    });
  }

  function restoreTask(id: string) {
    const plan = planRestoreTask(tasksStore().get(), recurringCutoffsStore().get(), id, {
      now: new Date(),
      actorPubkey: currentPubkey() ?? undefined,
      settings,
    });
    if (!plan) return;
    setTasks(plan.tasks);
    const t = plan.restored;
    if (t.scriptureMemoryId) {
      setScriptureMemory((prev) =>
        updateScriptureMemoryState(
          prev,
          prev.entries.map((entry) => {
            if (entry.id !== t.scriptureMemoryId) return entry;
            const previousStage = typeof t.scriptureMemoryStage === "number" ? t.scriptureMemoryStage : entry.stage ?? 0;
            const totalReviews = Math.max(0, (entry.totalReviews ?? 0) - 1);
            return {
              ...entry,
              stage: Math.max(0, previousStage),
              totalReviews,
              lastReviewISO: t.scriptureMemoryPrevReviewISO || undefined,
              scheduledAtISO: t.scriptureMemoryScheduledAt || entry.scheduledAtISO,
            };
          })
        )
      );
    }
    plan.publish.forEach((task) => maybePublishTask(task).catch(() => {}));
  }
  function clearCompleted() {
    if (currentBoard?.kind === "bible" || currentBoard?.clearCompletedDisabled) {
      return;
    }
    if (!currentBoard) return;
    const plan = planClearCompleted(tasksStore().get(), new Set(boardScopeIds(currentBoard, boards)));
    setTasks(plan.tasks);
    plan.publishDeleted.forEach((task) => publishTaskDeleted(task).catch(() => {}));
  }

  function postponeTaskOneWeek(id: string) {
    const plan = planPostponeTask(tasksStore().get(), boards, id, {
      now: new Date(),
      actorPubkey: currentPubkey() ?? undefined,
      settings,
    });
    if (!plan) return;
    setTasks(plan.tasks);
    maybePublishTask(plan.updated).catch(() => {});
    showToast('Task moved to next week');
  }

  async function revealBounty(id: string) {
    const t = tasks.find(x => x.id === id);
    if (!t || !t.bounty || t.bounty.state !== 'locked' || !t.bounty.enc) return;
    try {
      let pt = "";
      const enc = t.bounty.enc as any;
      const me = currentPubkey() ?? undefined;
      if (enc.alg === 'aes-gcm-256') {
        if (!me || t.bounty.sender !== me) throw new Error('Only the funder can reveal this token.');
        pt = await decryptEcashTokenForFunder(enc);
      } else if (enc.alg === 'nip04') {
        const receiverRaw = ensureXOnlyHex(t.bounty.receiver);
        const meRaw = ensureXOnlyHex(me);
        if (!receiverRaw || !meRaw || receiverRaw !== meRaw) {
          throw new Error('Only the intended recipient can decrypt this token.');
        }
        const senderRaw = ensureXOnlyHex(t.bounty.sender);
        if (!senderRaw) throw new Error('Missing sender pubkey');
        pt = await decryptEcashTokenForRecipient(senderRaw, enc);
      } else {
        throw new Error('Unsupported cipher');
      }
      const nextBounty = normalizeBounty({ ...t.bounty, token: pt, enc: null, state: 'unlocked', updatedAt: new Date().toISOString() });
      if (!nextBounty) return;
      const updated = normalizeTaskBounty({
        ...t,
        bounty: nextBounty,
        lastEditedBy: normalizeAgentPubkey(currentPubkey()) ?? t.lastEditedBy ?? t.createdBy,
      });
      setTasks(prev => prev.map(x => x.id === id ? updated : x));
      setEditing((prev) => (prev && prev.type === "task" && prev.task.id === id ? { ...prev, task: updated } : prev));
      maybePublishTask(updated).catch(() => {});
    } catch (e) {
      alert('Decrypt failed: ' + (e as Error).message);
    }
  }

  async function transferBounty(id: string, recipientHex: string) {
    let recipientRaw = ensureXOnlyHex(recipientHex);
    if (!recipientRaw) {
      const normalized = normalizeNostrPubkey(recipientHex);
      recipientRaw = ensureXOnlyHex(normalized);
    }
    if (!recipientRaw) throw new Error('Invalid recipient pubkey.');
    const t = tasks.find(x => x.id === id);
    if (!t || !t.bounty) throw new Error('No bounty to transfer.');
    if (t.bounty.state === 'revoked' || t.bounty.state === 'claimed') {
      throw new Error('This bounty can no longer be reassigned.');
    }
    const me = currentPubkey() ?? undefined;
    if (!me) throw new Error('Missing local Nostr key.');
    const authorized = (
      (t.bounty.sender && pubkeysEqual(t.bounty.sender, me)) ||
      (t.bounty.owner && pubkeysEqual(t.bounty.owner, me)) ||
      pubkeysEqual(t.createdBy, me)
    );
    if (!authorized) {
      throw new Error('Only the funder or owner can sign this bounty.');
    }
    if (pubkeysEqual(t.bounty.receiver, recipientRaw)) {
      throw new Error('Bounty is already locked to that recipient.');
    }

    let plainToken = t.bounty.token;
    if (!plainToken) {
      if (!t.bounty.enc) throw new Error('No token available to sign over.');
      if (t.bounty.enc.alg === 'aes-gcm-256') {
        plainToken = await decryptEcashTokenForFunder(t.bounty.enc);
      } else if (t.bounty.enc.alg === 'nip04') {
        const senderRaw = ensureXOnlyHex(t.bounty.sender);
        if (!senderRaw) throw new Error('Missing sender pubkey.');
        if (!pubkeysEqual(t.bounty.receiver, me)) {
          throw new Error('Only the current recipient can reassign this bounty.');
        }
        plainToken = await decryptEcashTokenForRecipient(senderRaw, t.bounty.enc);
      } else {
        throw new Error('Unsupported bounty cipher.');
      }
    }

    if (!plainToken?.trim()) {
      throw new Error('Token was empty after decryption.');
    }

    const enc = await encryptEcashTokenForRecipient(recipientRaw, plainToken);
    const nextBounty = normalizeBounty({
      ...t.bounty,
      token: '',
      enc,
      receiver: recipientRaw,
      lock: 'p2pk',
      state: 'locked',
      updatedAt: new Date().toISOString(),
    });
    if (!nextBounty) return;
    const updated = normalizeTaskBounty({
      ...t,
      bounty: nextBounty,
      lastEditedBy: normalizeAgentPubkey(currentPubkey()) ?? t.lastEditedBy ?? t.createdBy,
    });
    setTasks(prev => prev.map(x => x.id === id ? updated : x));
    setEditing((prev) => (prev && prev.type === "task" && prev.task.id === id ? { ...prev, task: updated } : prev));
    maybePublishTask(updated).catch(() => {});
  }

  async function claimBounty(id: string, from?: DOMRect) {
    const t = tasks.find(x => x.id === id);
    if (!t || !t.bounty || t.bounty.state !== 'unlocked' || !t.bounty.token) return;
    try {
      const bountyToken = t.bounty.token;
      const res = await receiveToken(bountyToken);
      if (res.savedForLater) {
        alert('Token saved for later redemption. We\'ll redeem it when your connection returns.');
        return;
      }
      if (res.crossMint) {
        alert(`Redeemed to a different mint: ${res.usedMintUrl}. Switch to that mint to view the balance.`);
      }
      const redeemedAmount = res.proofs.reduce((sum, proof) => sum + (Number((proof as any)?.amount || 0) || 0), 0);
      appendWalletHistoryEntry({
        id: `redeem-bounty-${Date.now()}`,
        summary: `Redeemed bounty • ${redeemedAmount} sats${res.crossMint ? ` at ${res.usedMintUrl}` : ''}`,
        detail: bountyToken,
        detailKind: "token",
        type: "ecash",
        direction: "in",
        amountSat: redeemedAmount,
        mintUrl: res.usedMintUrl ?? t.bounty.mint ?? undefined,
      });
      try { if (from) flyCoinsToWallet(from); } catch {}
      const nextBounty = normalizeBounty({ ...t.bounty, token: '', state: 'claimed', updatedAt: new Date().toISOString() });
      if (!nextBounty) return;
      const updated = normalizeTaskBounty({
        ...t,
        bounty: nextBounty,
        lastEditedBy: normalizeAgentPubkey(currentPubkey()) ?? t.lastEditedBy ?? t.createdBy,
      });
      setTasks(prev => prev.map(x => x.id === id ? updated : x));
      setEditing((prev) => (prev && prev.type === "task" && prev.task.id === id ? { ...prev, task: updated } : prev));
      maybePublishTask(updated).catch(() => {});
    } catch (e) {
      alert('Redeem failed: ' + (e as Error).message);
    }
  }

  const reminderNotificationOffer = useReminderNotificationOffer({
    pushEnabled: !!settings.pushNotifications?.enabled,
    pushConfigured: !!workerBaseUrl && !!vapidPublicKey,
    pushPlatform: settings.pushNotifications?.platform === "android" ? "android" : "ios",
    enablePush: enablePushNotifications,
  });

  async function saveEdit(updated: Task) {
    const previous = tasksStore().get().find((task) => task.id === updated.id);
    const plan = planSaveTask(tasksStore().get(), updated, {
      now: new Date(),
      actorPubkey: nostrPK || undefined,
      settings,
    });
    setTasks(
      settings.showFullWeekRecurring && plan.saved.recurrence
        ? ensureWeekRecurrences(plan.tasks, [plan.saved])
        : plan.tasks,
    );
    reminderNotificationOffer.noteReminderSave(!!previous && taskHasReminders(previous), taskHasReminders(plan.saved));
    await maybePublishTask(plan.saved);
    void maybeSendTaskAssignments(plan.saved, { previousAssignees: plan.previousAssignees }).catch((err) => {
      console.warn("Failed to send task assignments", err);
    });
    setEditing(null);
  }

  function deleteTaskSilently(id: string) {
    const task = tasksRef.current.find((t) => t.id === id);
    if (!task) return;
    setTasks((prev) => prev.filter((t) => t.id !== id));
    publishTaskDeleted(task).catch(() => {});
  }

  function deleteCalendarEvent(
    id: string,
    options?: { skipPrompt?: boolean; scope?: "single" | "future" },
  ) {
    const plan = planDeleteCalendarEvent(calendarEventsStore().get(), id, options);
    if (plan.kind === "none") return;
    if (plan.kind === "ask-scope") {
      setRecurringDeleteEvent(plan.event);
      return;
    }
    if (plan.cutoff) {
      recordCalendarSeriesCutoff(plan.cutoff.boardId, plan.cutoff.seriesId, plan.cutoff.untilISO);
    }
    plan.deletedOccurrenceIds.forEach((eventId) => deletedCalendarOccurrenceIdsRef.current.add(eventId));
    setCalendarEvents(plan.events);
    plan.publish.forEach((event) => maybePublishCalendarEvent(event).catch(() => {}));
    plan.publishDeleted.forEach((event) => publishCalendarEventDeleted(event).catch(() => {}));
  }

  const parseCalendarAddressForKind = (coord: string, kind: number): { kind: number; pubkey: string; d: string } | null => {
    const parsed = parseCalendarAddress(coord);
    if (!parsed || parsed.kind !== kind) return null;
    return parsed;
  };

  function setCalendarInviteStatus(coord: string, status: CalendarInviteStatus) {
    const normalized = (coord || "").trim();
    if (!normalized) return;
    // A response is stamped so it syncs to the user's other devices; "read" is not a response.
    const respondedAt = status === "read" || status === "pending" ? undefined : new Date().toISOString();
    setCalendarInvites((prev) =>
      prev.map((invite) =>
        invite.canonical === normalized
          ? { ...invite, status, ...(respondedAt ? { respondedAt } : {}) }
          : invite,
      ),
    );
  }

  const addAcceptedInviteToCalendar = useCallback(
    async (invite: CalendarInvite, status: CalendarRsvpStatus): Promise<CalendarEvent | null> => {
      if (status !== "accepted" && status !== "tentative") return null;
      const viewCoord = parseCalendarAddressForKind(invite.view, TASKIFY_CALENDAR_VIEW_KIND);
      if (!viewCoord) return null;
      const currentEvents = calendarEventsStore().get();
      const reusable = findReusableAcceptedInvite(currentEvents, invite);
      if (reusable) return reusable;

      const defaultBoard = selectAcceptedInviteDestination(boards);
      if (!defaultBoard) return null;

      const relayList = relaysOrDefaults(invite.relays, defaultRelays, inboxRelays);
      if (!relayList.length) {
        showToast("No relays available to load this event.");
        return null;
      }

      let viewEvent: NostrEvent | null = null;
      try {
        if (typeof pool.list === "function") {
          const events = await pool.list(relayList, [
            { kinds: [TASKIFY_CALENDAR_VIEW_KIND], authors: [viewCoord.pubkey], "#d": [viewCoord.d] },
          ]);
          if (Array.isArray(events) && events.length) {
            viewEvent = events.reduce((latest, candidate) => {
              if (!latest) return candidate;
              const nextCreated = typeof candidate.created_at === "number" ? candidate.created_at : 0;
              const lastCreated = typeof latest.created_at === "number" ? latest.created_at : 0;
              return nextCreated >= lastCreated ? candidate : latest;
            }, null as NostrEvent | null);
          }
        }
        if (!viewEvent && typeof pool.get === "function") {
          viewEvent = await pool.get(relayList, {
            kinds: [TASKIFY_CALENDAR_VIEW_KIND],
            authors: [viewCoord.pubkey],
            "#d": [viewCoord.d],
          });
        }
      } catch (err) {
        console.warn("Failed to fetch invited calendar event", err);
      }

      const canonicalParsed = parseCalendarAddressForKind(invite.canonical, TASKIFY_CALENDAR_EVENT_KIND);
      const boardPubkey =
        canonicalParsed?.pubkey
          ? normalizeNostrPubkeyHex(canonicalParsed.pubkey) ?? canonicalParsed.pubkey
          : undefined;

      const resolveOriginBoardId = async (): Promise<string | null> => {
        if (!canonicalParsed) return null;
        const nostrBoards = boards.filter((board) => board.nostr?.boardId);
        for (const board of nostrBoards) {
          try {
            const keys = await deriveBoardNostrKeys(board.nostr!.boardId);
            if (keys.pk === canonicalParsed.pubkey) return board.id;
          } catch {}
        }
        return null;
      };

      const originBoardId = await resolveOriginBoardId();
      const isExternal = !originBoardId;
      if (isExternal && !boardPubkey) {
        showToast("Invite event data was incomplete.");
        return null;
      }

      let viewPayload: ResolvedCalendarInviteView | null = null;
      if (viewEvent) {
        try {
          const raw = await decryptCalendarPayloadWithEventKey(viewEvent.content, invite.eventKey);
          const parsed = parseCalendarViewPayload(raw);
          if (parsed) {
            const documents = normalizeDocumentList(parsed.documents);
            viewPayload = {
              ...parsed,
              documents: documents?.map(ensureDocumentPreview),
            };
          }
        } catch (err) {
          console.warn("Failed to decrypt invite view", err);
        }
      }
      const plan = planAddAcceptedInviteToCalendar(calendarEventsStore().get(), invite, {
        now: new Date(),
        boards,
        destinationBoardId: defaultBoard.id,
        settings,
        status,
        viewEventId: viewCoord.d,
        originBoardId,
        boardPubkey,
        viewPayload,
      });
      if (plan.kind === "invalid") {
        if (plan.reason === "deleted") showToast("This event was deleted.");
        if (plan.reason === "missing-board-pubkey" || plan.reason === "mismatched-view") {
          showToast("Invite event data was incomplete.");
        }
        if (plan.reason === "unparseable") showToast("Invite event could not be parsed.");
        return null;
      }
      if (plan.kind === "applied") setCalendarEvents(plan.events);
      return plan.event;
    },
    [boards, defaultRelays, inboxRelays, pool, setCalendarEvents, settings.newTaskPosition, settings.weekStart, showToast],
  );
  acceptedInviteMaterializerRef.current = addAcceptedInviteToCalendar;

  async function publishCalendarRsvp(
    canonical: string,
    eventId: string,
    inviteToken: string | null | undefined,
    relays: string[],
    status: CalendarRsvpStatus,
    options?: { fb?: CalendarRsvpFb; note?: string; boardId?: string },
  ): Promise<void> {
    const fallbackInviteToken = options?.boardId && nostrPK
      ? deriveBoardRsvpToken(options.boardId, nostrPK)
      : undefined;
    const publication = planCalendarRsvpPublication({
      canonical,
      eventId,
      inviteToken,
      fallbackInviteToken,
      relays,
      status,
      attendeePubkey: nostrPK || undefined,
      hasSigner: !!nostrSkHex,
      fb: options?.fb,
      note: options?.note,
    });
    if (publication.kind === "invalid") throw new Error(publication.error);

    const content = await encryptCalendarRsvpPayload(
      publication.payload,
      nostrSkHex,
      publication.recipientPubkey,
    );
    const template: EventTemplate = buildCalendarRsvpEventTemplate(
      publication,
      content,
      Math.floor(Date.now() / 1000),
    );
    const { createdAt } = await nostrPublish(publication.relayList, template, { returnEvent: true });
    const applied = planApplyPublishedCalendarRsvp(calendarEventsStore().get(), {
      canonicalAddress: publication.canonicalAddress,
      eventId,
      attendeePubkey: nostrPK,
      createdAt,
      status,
      fb: options?.fb,
      originalInviteToken: inviteToken,
    });
    setCalendarEvents(applied.events);
    recordActiveEventRsvp(publication.canonicalAddress, applied.record);
  }

  async function handleCalendarInviteRsvp(invite: CalendarInvite, status: CalendarRsvpStatus): Promise<void> {
    try {
      let boardNostrId: string | null = null;
      const canonicalParsed = parseCalendarAddressForKind(invite.canonical, TASKIFY_CALENDAR_EVENT_KIND);
      const viewParsed = parseCalendarAddressForKind(invite.view, TASKIFY_CALENDAR_VIEW_KIND);
      const resolvedEventId = canonicalParsed?.d || viewParsed?.d || invite.eventId;
      if (!resolvedEventId) {
        showToast("Invite is missing event details.");
        return;
      }
      if (canonicalParsed) {
        const nostrBoards = boards.filter((board) => board.nostr?.boardId);
        for (const board of nostrBoards) {
          try {
            const keys = await deriveBoardNostrKeys(board.nostr!.boardId);
            if (keys.pk === canonicalParsed.pubkey) {
              boardNostrId = board.nostr!.boardId;
              break;
            }
          } catch {}
        }
      }
      const resolvedInvite = resolvedEventId === invite.eventId ? invite : { ...invite, eventId: resolvedEventId };
      const materialized =
        status === "accepted" || status === "tentative"
          ? await addAcceptedInviteToCalendar(resolvedInvite, status)
          : null;
      const canonicalAddress = materialized?.canonicalAddress || invite.canonical;
      const eventId = materialized?.id || resolvedEventId;
      const inviteRelays = materialized?.inviteRelays ?? invite.relays;
      const fallbackRelays = relaysOrDefaults(inviteRelays, defaultRelays, inboxRelays);
      const inviteToken = boardNostrId ? "" : (materialized?.inviteToken || invite.inviteToken);
      const options = boardNostrId ? { boardId: boardNostrId } : undefined;
      await publishCalendarRsvp(canonicalAddress, eventId, inviteToken, fallbackRelays, status, options);
      setCalendarInviteStatus(invite.canonical, status);
      showToast(`RSVP sent: ${status}`);
    } catch (err) {
      console.warn("RSVP publish failed", err);
      showToast("Failed to send RSVP.");
    }
  }

  function dismissCalendarInvite(invite: CalendarInvite): void {
    setCalendarInviteStatus(invite.canonical, "dismissed");
  }

  async function maybeSendCalendarEventInvites(
    event: CalendarEvent,
    options?: { previousParticipants?: CalendarEventParticipant[]; forceAll?: boolean; board?: Board },
  ): Promise<void> {
    if (!nostrSkHex) return;
    if (event.readOnly) return;
    const targetBoardId = event.originBoardId ?? event.boardId;
    const board =
      options?.board && options.board.id === targetBoardId
        ? options.board
        : boards.find((b) => b.id === targetBoardId);
    if (!board?.nostr?.boardId) return;
    const boardRelays = getBoardRelays(board);
    if (!boardRelays.length) return;
    const fallbackRelays = Array.from(
      new Set(
        (defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS))
          .map((relay) => relay.trim())
          .filter(Boolean),
      ),
    );

    const normalizedParticipants = (event.participants ?? [])
      .map((participant) => normalizeNostrPubkeyHex(participant.pubkey))
      .filter((pubkey): pubkey is string => !!pubkey);
    if (!normalizedParticipants.length) return;

    const previousSet = new Set(
      (options?.previousParticipants ?? [])
        .map((participant) => normalizeNostrPubkeyHex(participant.pubkey))
        .filter((pubkey): pubkey is string => !!pubkey),
    );
    const nextSet = new Set(normalizedParticipants);
    const recipients = options?.forceAll
      ? Array.from(nextSet)
      : Array.from(nextSet).filter((pubkey) => !previousSet.has(pubkey));
    if (!recipients.length) return;

    const boardKeys = await deriveBoardNostrKeys(board.nostr.boardId);
    const canonicalAddr = calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, event.id);
    const viewAddr = calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, boardKeys.pk, event.id);
    const merged = mergeInviteTokens(event, recipients);
    const updatedEvent = merged.changed ? { ...event, eventKey: merged.eventKey, inviteTokens: merged.inviteTokens } : event;
    if (merged.changed) {
      setCalendarEvents((prev) => prev.map((ev) => (ev.id === event.id ? updatedEvent : ev)));
      try {
        await maybePublishCalendarEvent(updatedEvent, board, { skipBoardMetadata: true });
      } catch (err) {
        console.warn("Failed to publish updated calendar invite tokens", err);
      }
    }
    const eventKey = updatedEvent.eventKey || merged.eventKey;
    const inviteTokens = updatedEvent.inviteTokens ?? {};

    let senderNpub: string | null = null;
    try {
      if (nostrPK && typeof (nip19 as any)?.npubEncode === "function") {
        senderNpub = (nip19 as any).npubEncode(hexToBytes(nostrPK));
      }
    } catch {
      senderNpub = null;
    }
    const senderInfo = senderNpub ? { npub: senderNpub } : undefined;

    const sendRelays = Array.from(new Set([...boardRelays, ...fallbackRelays])).filter(Boolean);
    for (const recipient of recipients) {
      if (recipient === nostrPK) continue;
      const inviteToken = inviteTokens[recipient];
      if (!inviteToken || !eventKey) continue;
      try {
        const envelope = buildCalendarEventInviteEnvelope({
          eventId: updatedEvent.id,
          canonical: canonicalAddr,
          view: viewAddr,
          eventKey,
          inviteToken,
          title: updatedEvent.title,
          start: updatedEvent.kind === "date" ? updatedEvent.startDate : updatedEvent.startISO,
          end: updatedEvent.kind === "date" ? updatedEvent.endDate : updatedEvent.endISO,
          relays: boardRelays,
        }, senderInfo);
        await sendShareMessage(envelope, recipient, nostrSkHex, sendRelays);
      } catch (err) {
        console.warn("Failed to send calendar invite", err);
      }
    }
  }

  const maybeSendTaskAssignments = useCallback(
    async (task: Task, options?: { previousAssignees?: TaskAssignee[] | null; board?: Board | null }): Promise<void> => {
      if (!nostrSkHex || !task.assignees?.length) return;
      const previousByPubkey = new Map<string, TaskAssignee>();
      (options?.previousAssignees ?? []).forEach((assignee) => {
        const pubkey = normalizeNostrPubkeyHex(assignee.pubkey);
        if (!pubkey) return;
        previousByPubkey.set(pubkey, assignee);
      });
      const recipients = task.assignees
        .map((assignee) => {
          const pubkey = normalizeNostrPubkeyHex(assignee.pubkey);
          if (!pubkey) return null;
          if (nostrPK && pubkey === nostrPK) return null;
          const currentStatus = assignee.status ?? "pending";
          if (currentStatus !== "pending") return null;
          const previous = previousByPubkey.get(pubkey);
          const previousStatus = previous?.status ?? "pending";
          if (previous && previousStatus === "pending") return null;
          return pubkey;
        })
        .filter((pubkey): pubkey is string => !!pubkey);
      if (!recipients.length) return;

      const board = options?.board ?? boards.find((candidate) => candidate.id === task.boardId) ?? null;
      const boardRelays = Array.from(
        new Set(
          (board?.nostr?.relays?.length ? board.nostr.relays : [])
            .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
            .filter(Boolean),
        ),
      );
      const fallbackRelays = Array.from(
        new Set(
          (defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS))
            .map((relay) => relay.trim())
            .filter(Boolean),
        ),
      );
      const relayList = Array.from(new Set([...boardRelays, ...fallbackRelays])).filter(Boolean);
      if (!relayList.length) return;

      let senderNpub: string | null = null;
      try {
        if (nostrPK) {
          senderNpub =
            typeof (nip19 as any)?.npubEncode === "function"
              ? (nip19 as any).npubEncode(hexToBytes(nostrPK))
              : null;
        }
      } catch {
        senderNpub = null;
      }

      const taskPayload: SharedTaskPayload = {
        type: "task",
        title: task.title,
        note: task.note,
        priority: task.priority,
        dueISO: task.dueISO,
        dueDateEnabled: task.dueDateEnabled,
        dueTimeEnabled: task.dueTimeEnabled,
        dueTimeZone: task.dueTimeZone,
        reminders: task.dueTimeEnabled ? task.reminders : undefined,
        subtasks: task.subtasks?.map((subtask) => ({ title: subtask.title, completed: !!subtask.completed })),
        recurrence: task.recurrence,
        assignees: task.assignees,
        sourceTaskId: task.id,
        assignment: true,
        relays: boardRelays.length ? boardRelays : relayList,
      };
      const envelope = buildTaskShareEnvelope(taskPayload, senderNpub ? { npub: senderNpub } : undefined);
      let failed = 0;
      for (const recipient of recipients) {
        try {
          await sendShareMessage(envelope, recipient, nostrSkHex, relayList);
        } catch (err) {
          failed += 1;
          console.warn("Failed to send task assignment", err);
        }
      }
      if (failed > 0) {
        showToast("Some task assignments failed to send.");
      }
    },
    [boards, defaultRelays, nostrPK, nostrSkHex, showToast],
  );

		  const convertTaskToCalendarEvent = (task: Task): CalendarEvent => {
	    const board = boards.find((b) => b.id === task.boardId) ?? null;
	    const order =
	      typeof task.order === "number"
	        ? task.order
	        : nextOrderForCalendarBoard(task.boardId, calendarEventsRef.current, settings.newTaskPosition);
	    const systemTimeZone = resolveSystemTimeZone();
	    const taskTimeZone = normalizeTimeZone(task.dueTimeZone) ?? systemTimeZone;
      const reminderTime = normalizeReminderTime(task.reminderTime);
	    const base: CalendarEventBase = {
	      id: task.id,
	      boardId: task.boardId,
        ...(task.createdBy ? { createdBy: task.createdBy } : {}),
        ...(task.lastEditedBy || task.createdBy
          ? { lastEditedBy: task.lastEditedBy || task.createdBy }
          : {}),
	      columnId: board && isListLikeBoard(board) ? task.columnId : undefined,
	      order,
	      title: task.title,
	      description: task.note,
	      documents: task.documents?.length ? task.documents.map(ensureDocumentPreview) : undefined,
	      locations: undefined,
	      geohash: undefined,
	      participants: undefined,
	      hashtags: undefined,
	      references: undefined,
	      ...(Array.isArray(task.reminders) && task.reminders.length ? { reminders: [...task.reminders] } : {}),
	      ...(!task.dueTimeEnabled && reminderTime ? { reminderTime } : {}),
	      ...(task.recurrence ? { recurrence: task.recurrence, seriesId: task.seriesId || task.id } : {}),
	    };

    const todayKey = isoDatePart(new Date().toISOString());
	    if (task.dueDateEnabled === false) {
	      const startISO = new Date().toISOString();
	      const startMs = Date.parse(startISO);
	      const endISO = Number.isNaN(startMs) ? undefined : new Date(startMs + 60 * 60 * 1000).toISOString();
	      const nextEvent: CalendarEvent = {
	        ...base,
	        kind: "time",
	        startISO,
	        ...(endISO ? { endISO } : {}),
	        ...(taskTimeZone ? { startTzid: taskTimeZone, endTzid: taskTimeZone } : {}),
	      };
	      return applyHiddenForCalendarEvent(nextEvent, settings.weekStart, board?.kind ?? "week");
	    }

	    const dateKey = isoDatePart(task.dueISO, taskTimeZone) || todayKey;
	    if (task.dueTimeEnabled) {
	      const startISO = task.dueISO;
	      const startMs = Date.parse(startISO);
	      const endISO = Number.isNaN(startMs) ? undefined : new Date(startMs + 60 * 60 * 1000).toISOString();
	      const nextEvent: CalendarEvent = {
	        ...base,
	        kind: "time",
	        startISO,
	        ...(endISO ? { endISO } : {}),
	        ...(taskTimeZone ? { startTzid: taskTimeZone, endTzid: taskTimeZone } : {}),
	      };
	      return applyHiddenForCalendarEvent(nextEvent, settings.weekStart, board?.kind ?? "week");
	    }

	    const defaultStartTime = (() => {
	      try {
	        const now = new Date();
	        const todayInTz = isoDatePart(now.toISOString(), taskTimeZone);
	        if (todayInTz && todayInTz === dateKey) {
	          const time = isoTimePart(now.toISOString(), taskTimeZone);
	          const [hhRaw, mmRaw] = time.split(":");
	          const hh = Number(hhRaw);
	          const mm = Number(mmRaw);
	          if (Number.isFinite(hh) && Number.isFinite(mm)) {
	            const nextHour = (mm > 0 ? hh + 1 : hh) % 24;
	            return `${String(nextHour).padStart(2, "0")}:00`;
	          }
	        }
	      } catch {}
	      return "09:00";
	    })();
	    const startISO = isoFromDateTime(dateKey, defaultStartTime, taskTimeZone);
	    const startMs = Date.parse(startISO);
	    const endISO = Number.isNaN(startMs) ? undefined : new Date(startMs + 60 * 60 * 1000).toISOString();
	    const nextEvent: CalendarEvent = {
	      ...base,
	      kind: "time",
	      startISO,
	      ...(endISO ? { endISO } : {}),
	      ...(taskTimeZone ? { startTzid: taskTimeZone, endTzid: taskTimeZone } : {}),
	    };
	    return applyHiddenForCalendarEvent(nextEvent, settings.weekStart, board?.kind ?? "week");
	  };

	  const convertCalendarEventToTask = (event: CalendarEvent): Task => {
	    const board = boards.find((b) => b.id === event.boardId) ?? null;
	    const order =
	      typeof event.order === "number"
	        ? event.order
	        : nextOrderForBoard(event.boardId, tasksRef.current, settings.newTaskPosition);
      const reminderTime = normalizeReminderTime(event.reminderTime);
	    const base: Task = {
	      id: event.id,
	      boardId: event.boardId,
	      createdBy: event.createdBy || nostrPK || undefined,
        lastEditedBy: event.lastEditedBy || event.createdBy || nostrPK || undefined,
	      title: event.title,
	      note: event.description,
	      documents: event.documents?.length ? event.documents.map(ensureDocumentPreview) : undefined,
	      createdAt: Date.now(),
	      dueISO: isoForToday(),
      dueDateEnabled: true,
      completed: false,
      order,
    };

    if (board?.kind === "week") {
      base.column = "day";
      base.dueDateEnabled = true;
	    } else if (board && isListLikeBoard(board)) {
	      base.columnId = event.columnId || (board.kind === "lists" ? board.columns[0]?.id : undefined);
	    }
      if (Array.isArray(event.reminders) && event.reminders.length) {
        base.reminders = [...event.reminders];
      }

	    if (event.kind === "date") {
	      base.dueISO = isoFromDateTime(event.startDate);
	      base.dueTimeEnabled = false;
	      base.dueTimeZone = undefined;
        if (base.reminders?.length || reminderTime) {
          base.reminderTime = reminderTime ?? DEFAULT_DATE_REMINDER_TIME;
        }
	    } else {
	      base.dueISO = event.startISO;
	      base.dueTimeEnabled = true;
	      base.dueTimeZone = normalizeTimeZone(event.startTzid) ?? undefined;
        base.reminderTime = undefined;
	    }

    if (event.recurrence) {
      base.recurrence = event.recurrence;
      base.seriesId = event.seriesId || base.id;
    }

    return base;
  };

  function saveCalendarEdit(updated: CalendarEvent) {
    const original = editing;
    const previous = calendarEventsStore().get().find((event) => event.id === updated.id);
    const plan = planSaveCalendarEvent(calendarEventsStore().get(), updated, {
      now: new Date(),
      actorPubkey: nostrPK || undefined,
      boards,
      settings,
    });
    const boardForUpdate = boards.find((board) => board.id === plan.publishBoardId) ?? null;
    let inviteBoard = boardForUpdate;
    if (plan.shouldSendInvites && boardForUpdate && !boardForUpdate.nostr?.boardId) {
      const relayFallback = defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS);
      const relays = Array.from(new Set(relayFallback.map((relay) => relay.trim()).filter(Boolean)));
      if (relays.length) {
        const nostrId =
          boardForUpdate.nostr?.boardId ||
          (BOARD_ID_REGEX.test(boardForUpdate.id) ? boardForUpdate.id : crypto.randomUUID());
        inviteBoard = { ...boardForUpdate, nostr: { boardId: nostrId, relays } } as Board;
        setBoards((prev) => prev.map((b) => (b.id === boardForUpdate.id ? inviteBoard! : b)));
        showToast("Sharing enabled for this board to send invites.", 3000);
      }
    }
    setCalendarEvents(plan.events);
    reminderNotificationOffer.noteReminderSave(
      !!previous && calendarEventHasReminders(previous),
      calendarEventHasReminders(updated),
    );

    try {
      plan.publish.forEach((event) => {
        maybePublishCalendarEventRef.current?.(event, inviteBoard ?? undefined).catch(() => {});
      });
    } catch {}
    plan.publishDeleted.forEach((event) => publishCalendarEventDeleted(event).catch(() => {}));

    try {
      maybeSendCalendarEventInvites(updated, {
        previousParticipants: plan.previousParticipants,
        forceAll: plan.forceInviteAll,
        board: inviteBoard ?? undefined,
      }).catch(() => {});
    } catch {}

    if (original?.originalType === "task") {
      deleteTaskSilently(original.originalId);
    }

    setEditing(null);
  }

  const applyCalendarEvent = useCallback(async (ev: NostrEvent) => {
    if (!ev || ev.kind !== TASKIFY_CALENDAR_EVENT_KIND) return;
    const bTag = tagValue(ev, "b");
    const eventId = tagValue(ev, "d");
    if (!bTag || !eventId) return;
    const lb = boardsRef.current.find((b) => b.nostr?.boardId && boardTag(b.nostr.boardId) === bTag);
    if (!lb || !lb.nostr) return;
    const boardId = lb.nostr.boardId;
    let boardKeys: BoardNostrKeyPair;
    try {
      boardKeys = await deriveBoardNostrKeys(boardId);
    } catch {
      return;
    }
    if (ev.pubkey !== boardKeys.pk) return;
    let payload: ReturnType<typeof parseCalendarCanonicalPayload> | null = null;
    try {
      const raw = await decryptCalendarPayloadForBoard(ev.content, boardKeys.skHex, boardKeys.pk);
      payload = parseCalendarCanonicalPayload(raw);
    } catch (err) {
      console.warn("Failed to decrypt calendar event", err);
      return;
    }
    if (!payload || payload.eventId !== eventId) return;
    // Recorded only once the version is readable, so an unreadable copy cannot block a good one.
    const createdAt = typeof ev.created_at === "number" ? ev.created_at : 0;
    if (!ledger.acceptCalendarEvent(bTag, eventId, createdAt)) return;
    if (payload.deleted) {
      deletedCalendarOccurrenceIdsRef.current.add(eventId);
      if (payload.recurrence?.untilISO && payload.seriesId) {
        recordCalendarSeriesCutoff(lb.id, payload.seriesId, payload.recurrence.untilISO);
        setCalendarEvents((prev) => sanitizeCalendarEvents(prev));
      } else {
        setCalendarEvents((prev) => prev.filter((event) => event.id !== eventId));
      }
      return;
    }

    const nextEvent = parseCalendarEvent(
      payload,
      {
        eventId,
        column: tagValue(ev, "col"),
        order: tagValue(ev, "order"),
        canonicalAddress: calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, eventId),
        viewAddress: calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, boardKeys.pk, eventId),
      },
      lb,
    );
    if (!nextEvent) return;

    setCalendarEvents((prev) => {
      const boundedEvent = applyCalendarSeriesCutoff(
        nextEvent,
        calendarSeriesCutoffsRef.current,
      );
      if (!boundedEvent) {
        const filtered = prev.filter((existing) => existing.id !== nextEvent.id);
        return filtered.length === prev.length ? prev : filtered;
      }
      const idx = prev.findIndex((existing) => existing.id === boundedEvent.id);
      const merged = mergeIncomingCalendarEvent(idx >= 0 ? prev[idx] : null, boundedEvent, {
        weekStart: settings.weekStart,
        boardKind: lb.kind,
      });
      if (idx >= 0) {
        const copy = prev.slice();
        copy[idx] = merged;
        return copy;
      }
      return [...prev, merged];
    });
  }, [
    recordCalendarSeriesCutoff,
    sanitizeCalendarEvents,
    setCalendarEvents,
    settings.weekStart,
    tagValue,
  ]);

  /* ---------- Drag & Drop: move or reorder ---------- */
  function moveTask(
    id: string,
    target:
      | { type: "day"; day: Weekday }
      | { type: "list"; columnId: string },
    beforeId?: string
  ) {
    if (beforeId && beforeId === id) return;
    const pendingTask = tasksRef.current.find((task) => task.id === id);
    if (pendingTask) {
      const pendingSourceBoard = findBoardByCompoundChildId(boardsRef.current, pendingTask.boardId);
      const pendingBoard =
        target.type === "day"
          ? pendingSourceBoard
          : (() => {
              const source = listColumnSources.get(target.columnId);
              return source ? boardsRef.current.find((board) => board.id === source.boardId) : undefined;
            })();
      if (pendingSourceBoard && pendingSourceBoard.id !== pendingBoard?.id) {
        markTaskRelayPublishPending(id, pendingSourceBoard);
      }
      markTaskRelayPublishPending(id, pendingBoard);
    }
    const plan = planMoveTask(tasksStore().get(), id, target, beforeId, {
      now: new Date(),
      actorPubkey: currentPubkey() ?? undefined,
      settings,
      currentBoard,
      listColumnSources,
    });
    if (!plan) return;
    setTasks(plan.tasks);
    plan.publishDeleted.forEach((task) => publishTaskDeleted(task).catch(() => {}));
    plan.publish.forEach((task) => maybePublishTask(task).catch(() => {}));
  }

  const completeSelectedItems = useCallback(() => {
    if (!selectedTasks.length) return;
    selectedTasks.forEach((task) => {
      if (!task.completed) completeTask(task.id);
    });
    showToast(selectedTasks.length === 1 ? "Task completed" : `${selectedTasks.length} tasks completed`);
    exitSelectionMode();
  }, [completeTask, exitSelectionMode, selectedTasks, showToast]);

  const deleteSelectedItems = useCallback(() => {
    if (!selectedCount) return;
    selectedEvents.forEach((event) => deleteCalendarEvent(event.id, { skipPrompt: true }));
    selectedTasks.forEach((task) => deleteTask(task.id, { skipPrompt: true }));
    showToast(selectedCount === 1 ? "Item deleted" : `${selectedCount} items deleted`);
    exitSelectionMode();
  }, [deleteCalendarEvent, deleteTask, exitSelectionMode, selectedCount, selectedEvents, selectedTasks, showToast]);

  function moveTaskToBoard(id: string, boardId: string) {
    const plan = planMoveTaskToBoard(tasksStore().get(), boards, id, boardId, {
      now: new Date(),
      actorPubkey: currentPubkey() ?? undefined,
      settings,
    });
    if (!plan) return;
    setTasks(plan.tasks);
    plan.publishDeleted.forEach((task) => publishTaskDeleted(task).catch(() => {}));
    plan.publish.forEach((task) => maybePublishTask(task).catch(() => {}));
  }

  const moveSelectedTasksToBoard = useCallback((boardId: string) => {
    if (!selectedTasks.length && !selectedEvents.length) return;
    selectedTasks.forEach((task) => moveTaskToBoard(task.id, boardId));
    if (selectedEvents.length) {
      const plan = planMoveCalendarEvents(calendarEventsStore().get(), selectedItemIdSet, boardId);
      setCalendarEvents(plan.events);
      plan.publishDeleted.forEach((event) => publishCalendarEventDeleted(event).catch(() => {}));
      plan.publish.forEach((event) => maybePublishCalendarEvent(event).catch(() => {}));
    }
    const boardName = boards.find((board) => board.id === boardId)?.name || "board";
    const totalMoved = selectedTasks.length + selectedEvents.length;
    showToast(totalMoved === 1 ? `Item moved to ${boardName}` : `${totalMoved} items moved to ${boardName}`);
    exitSelectionMode();
    setSelectionMoveSheetOpen(false);
    setSelectionMoveStep("board");
    setSelectionMoveBoardId(null);
	  }, [boards, exitSelectionMode, maybePublishCalendarEvent, moveTaskToBoard, selectedEvents.length, selectedItemIdSet, selectedTasks, setCalendarEvents, showToast]);

  const moveSelectedTasksToColumn = useCallback((boardId: string, columnId: string) => {
    if (!selectedTasks.length && !selectedEvents.length) return;
    const board = boards.find((b) => b.id === boardId);
    const col = board && board.kind === "lists" ? board.columns.find((c) => c.id === columnId) : null;
    if (selectedTasks.length) {
      const plan = planMoveTasksToColumn(
        tasksStore().get(),
        selectedTasks.map((task) => task.id),
        boardId,
        columnId,
        { now: new Date(), actorPubkey: currentPubkey() ?? undefined, settings },
      );
      setTasks(plan.tasks);
      plan.publishDeleted.forEach((task) => publishTaskDeleted(task).catch(() => {}));
      plan.publish.forEach((task) => maybePublishTask(task).catch(() => {}));
    }
    if (selectedEvents.length) {
      const plan = planMoveCalendarEvents(calendarEventsStore().get(), selectedItemIdSet, boardId, columnId);
      setCalendarEvents(plan.events);
      plan.publishDeleted.forEach((event) => publishCalendarEventDeleted(event).catch(() => {}));
      plan.publish.forEach((event) => maybePublishCalendarEvent(event).catch(() => {}));
    }
    const boardName = board?.name || "board";
    const colName = col?.name || "list";
    const totalMoved = selectedTasks.length + selectedEvents.length;
    showToast(totalMoved === 1 ? `Item moved to ${colName} in ${boardName}` : `${totalMoved} items moved to ${colName} in ${boardName}`);
    exitSelectionMode();
    setSelectionMoveSheetOpen(false);
    setSelectionMoveStep("board");
    setSelectionMoveBoardId(null);
	  }, [boards, exitSelectionMode, maybePublishCalendarEvent, maybePublishTask, selectedEvents, selectedItemIdSet, selectedTasks, setCalendarEvents, setTasks, settings, showToast]);

  const selectionMoveTargets = useMemo(() => (
    boards.filter((board) => board.kind !== "bible" && !board.archived && !board.hidden).map((board) => ({
      id: board.id,
      name: board.name,
      kind: board.kind,
      columns: board.kind === "lists" ? board.columns : [],
      children: board.kind === "compound" ? board.children : [],
    }))
  ), [boards]);

  const handleResyncBoardHistory = useCallback(() => {
    const sharedBoardTags = boards
      .filter((board) => board.nostr?.boardId)
      .map((board) => boardTag(board.nostr!.boardId));
    if (!sharedBoardTags.length) {
      showToast("No shared boards to re-sync.", 2500);
      return;
    }

    boardSyncCursorsRef.current = {};
    relayBatchRef.current.clear();
    pendingRelaysByBoardRef.current.clear();
    seenBoardTasksRef.current.clear();
    completedNostrInitialSyncRef.current.clear();
    try {
      idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS, JSON.stringify({}));
    } catch {
      // non-fatal; the in-memory nonce still forces this session to re-sync
    }
    setPendingNostrInitialSyncByBoardTag((prev) => {
      const next = { ...prev };
      sharedBoardTags.forEach((tag) => {
        next[tag] = true;
      });
      return next;
    });
    setBoardHistoryResyncNonce((nonce) => nonce + 1);
    showToast(
      sharedBoardTags.length === 1
        ? "Re-syncing board history."
        : `Re-syncing ${sharedBoardTags.length} board histories.`,
      2500,
    );
  }, [boards, showToast]);

  useBoardSync({
    boards,
    boardsRef,
    tasksRef,
    setTasks,
    sanitizeTasks: sanitizeRecurringTasks,
    pool,
    getBoardRelays,
    ledger,
    boardSyncCursorsRef,
    relayBatchRef,
    pendingRelaysByBoardRef,
    seenBoardTasksRef,
    completedNostrInitialSyncRef,
    setPendingNostrInitialSyncByBoardTag,
    markNostrBoardInitialSyncComplete,
    tagValue,
    applyBoardEvent,
    applyTaskEvent,
    applyCalendarEvent,
    fullHistorySyncNonce: boardHistoryResyncNonce,
  });

  /* ---------- History: Back closes what is open; links open what they name ---------- */
  useNotificationTaps(appRouter);
  const sheetOverlay = (open: boolean, sheet: AppSheetRoute): AppOverlayRoute | null =>
    open ? { kind: "sheet", sheet } : null;
  const editorOverlay = useMemo<AppOverlayRoute | null>(() => {
    if (!editing) return null;
    return editing.type === "task"
      ? { kind: "task", id: editing.task.id, boardId: editing.task.boardId }
      : { kind: "event", id: editing.event.id, boardId: editing.event.boardId };
  }, [editing]);
  useOverlayHistory(appRouter, appRoute, editorOverlay, () => setEditing(null));
  useOverlayHistory(
    appRouter,
    appRoute,
    noteViewerTaskId ? { kind: "note", taskId: noteViewerTaskId } : null,
    () => setNoteViewerTaskId(null),
  );
  useOverlayHistory(appRouter, appRoute, sheetOverlay(addBoardOpen, "add-board"), closeAddBoard);
  useOverlayHistory(appRouter, appRoute, sheetOverlay(shareBoardModalOpen, "share-board"), closeShareBoard);
  useOverlayHistory(appRouter, appRoute, sheetOverlay(selectionMoveSheetOpen, "selection-move"), () => {
    setSelectionMoveSheetOpen(false);
    setSelectionMoveStep("board");
    setSelectionMoveBoardId(null);
  });
  useOverlayHistory(appRouter, appRoute, sheetOverlay(boardSortSheetOpen, "board-sort"), () => setBoardSortSheetOpen(false));
  useOverlayHistory(appRouter, appRoute, sheetOverlay(biblePrintOpen, "bible-print"), () => setBiblePrintOpen(false));
  useOverlayHistory(appRouter, appRoute, sheetOverlay(boardPrintOpen, "board-print"), () => setBoardPrintOpen(false));
  useOverlayHistory(appRouter, appRoute, sheetOverlay(bibleScanOpen, "bible-scan"), () => setBibleScanOpen(false));
  useOverlayHistory(appRouter, appRoute, sheetOverlay(boardScanOpen, "board-scan"), () => setBoardScanOpen(false));
  useOverlayHistory(appRouter, appRoute, sheetOverlay(!!previewDocument, "document-preview"), () => {
    setPreviewDocument(null);
    setPreviewDocumentBoardId(undefined);
  });
  useOverlayHistory(appRouter, appRoute, sheetOverlay(!!recurringDeleteTask, "recurring-task-delete"), () => setRecurringDeleteTask(null));
  useOverlayHistory(appRouter, appRoute, sheetOverlay(!!recurringDeleteEvent, "recurring-event-delete"), () => setRecurringDeleteEvent(null));
  useOverlayHistory(appRouter, appRoute, sheetOverlay(!!sharedTaskDestinationId, "shared-task-destination"), () => setSharedTaskDestinationId(null));
  useOverlayHistory(appRouter, appRoute, sheetOverlay(!!sharedTaskCopy, "shared-task-copy"), () => setSharedTaskCopy(null));
  const routeOverlayData = useMemo(() => ({ tasks, calendarEvents }), [tasks, calendarEvents]);
  useRouteOverlayOpener(appRouter, appRoute, (overlay) => {
    // Something is already open (Forward onto another entry): leave it rather than fight it.
    if (editing || noteViewerTaskId) return true;
    if (overlay.kind === "task") {
      const task = tasksStore().get().find((candidate) => candidate.id === overlay.id);
      if (!task) return false;
      setEditing({ type: "task", originalType: "task", originalId: task.id, task });
      return true;
    }
    if (overlay.kind === "event") {
      const event = calendarEventsStore().get().find((candidate) => candidate.id === overlay.id);
      if (!event) return false;
      setEditing({ type: "event", originalType: "event", originalId: event.id, event });
      return true;
    }
    if (overlay.kind === "note") {
      if (!tasksStore().get().some((candidate) => candidate.id === overlay.taskId)) return false;
      setNoteViewerTaskId(overlay.taskId);
      return true;
    }
    return true;
  }, routeOverlayData);

  const activeView =
    !settings.completedTab && (view === "completed" || view === "board-upcoming") ? "board" : view;
  const shareBoardId =
    shareBoardMode === "template"
      ? shareTemplateShare?.id ?? null
      : shareBoardTarget?.nostr?.boardId ?? null;
  const shareBoardQrPayload = useMemo(() => {
    if (!shareBoardId || !shareBoardTarget) return null;
    const relayList = normalizeRelayList(
      shareBoardMode === "template"
        ? shareTemplateShare?.relays
        : shareBoardTarget.nostr?.relays?.length
          ? shareBoardTarget.nostr.relays
          : defaultRelays.length
            ? defaultRelays
            : Array.from(DEFAULT_NOSTR_RELAYS),
    );
    try {
      return JSON.stringify(buildBoardShareEnvelope(shareBoardId, shareBoardTarget.name, relayList));
    } catch {
      return shareBoardId;
    }
  }, [
    defaultRelays,
    normalizeRelayList,
    shareBoardId,
    shareBoardMode,
    shareBoardTarget,
    shareTemplateShare,
  ]);
  const shareBoardDisplayName = shareBoardTarget?.name || "Board";
  const canShareBoard = !!currentBoard && currentBoard.kind !== "bible";
  const boardSelectOptions = visibleBoards.length === 0 ? (
    <>
      <option value="">No boards</option>
      <option value={ADD_BOARD_OPTION_ID}>+</option>
    </>
  ) : (
    <>
      {visibleBoards.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
      <option value={ADD_BOARD_OPTION_ID}>+</option>
    </>
  );
  const shouldRenderAppModalStack =
    addBoardOpen ||
    biblePrintOpen ||
    bibleScanOpen ||
    boardPrintOpen ||
    boardScanOpen ||
    showFirstRunOnboarding ||
    !!previewDocument ||
    !!recurringDeleteEvent ||
    !!recurringDeleteTask ||
    !!undoTask;

  return (
    <TaskActionsProvider actions={taskActions} view={taskView}>
    <div className="min-h-screen text-primary">
      {walletEnabled && (
        <Suspense fallback={null}>
          <WalletRuntime />
        </Suspense>
      )}
      <div className="app-shell mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {(activePage === "boards" || activePage === "upcoming" || activePage === "wallet-bounties" || activePage === "wallet-address" || activePage === "settings") && (
          <header className="app-header">
            {activePage === "boards" && (
              <>
                <div className="app-header__left">
                  {/* Desktop: the rail picks boards, so the header names the board instead. */}
                  <h1 className="app-header__board-title" title={currentBoard?.name}>{currentBoard?.name ?? "Boards"}</h1>
                  {canShareBoard && (
                    <button
                      type="button"
                      className="app-header__icon-btn app-header__board-share pressable"
                      onClick={openShareBoard}
                      title="Share board"
                      aria-label="Share board"
                    >
                      <ShareBoardIcon className="h-[17px] w-[17px]" />
                    </button>
                  )}
                  <div
                    ref={boardDropContainerRef}
                    className="board-select board-select--compact relative min-w-0 max-w-full sm:min-w-[12rem]"
                    style={{ maxWidth: "clamp(10rem, calc(100vw - 10rem), 28rem)" }}
                    onDragOver={(e) => {
                      if (!draggingTaskId) return;
                      e.preventDefault();
                      cancelBoardDropClose();
                      if (!boardDropOpen && !boardDropTimer.current) {
                        boardDropTimer.current = window.setTimeout(() => {
                          const rect = boardDropContainerRef.current?.getBoundingClientRect();
                          if (rect) {
                            setBoardDropPos({ top: rect.top, left: rect.right });
                          }
                          setBoardDropOpen(true);
                          boardDropTimer.current = undefined;
                        }, 500);
                      }
                    }}
                    onDragLeave={() => {
                      if (!draggingTaskId) return;
                      if (boardDropTimer.current) {
                        window.clearTimeout(boardDropTimer.current);
                        boardDropTimer.current = undefined;
                      }
                      scheduleBoardDropClose();
                    }}
                  >
                    <select
                      ref={boardSelectorRef}
                      value={currentBoardId}
                      onChange={handleBoardSelect}
                      className={`pill-select pill-select--compact pill-select--no-arrow w-full min-w-0 truncate sm:w-auto sm:min-w-[12rem]${
                        canShareBoard ? " pill-select--with-action" : ""
                      }`}
                      style={{ textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title="Boards"
                    >
                      {boardSelectOptions}
                    </select>
                    {canShareBoard && (
                      <button
                        type="button"
                        className="pill-select-action pressable"
                        onClick={openShareBoard}
                        title="Share board"
                        aria-label="Share board"
                      >
                        <ShareBoardIcon className="pill-select-action__icon" />
                      </button>
                    )}
                    {boardDropOpen &&
                      boardDropPos &&
                      createPortal(
                        <div
                          ref={boardDropListRef}
                          className="glass-panel fixed z-50 w-56 p-2"
                          style={{ top: boardDropPos.top, left: boardDropPos.left }}
                          onDragOver={(e) => {
                            if (!draggingTaskId) return;
                            e.preventDefault();
                            cancelBoardDropClose();
                          }}
                          onDragLeave={() => {
                            if (!draggingTaskId) return;
                            scheduleBoardDropClose();
                          }}
                        >
                          {visibleBoards.filter((b) => b.kind !== "bible").length === 0 ? (
                            <div className="rounded-xl px-3 py-2 text-sm text-secondary">No boards</div>
                          ) : (
                            visibleBoards
                              .filter((b) => b.kind !== "bible")
                              .map((b) => {
                                return (
                                  <div
                                    key={b.id}
                                    className="rounded-xl px-3 py-2 text-primary hover:bg-surface-muted"
                                    onDragOver={(e) => {
                                      if (draggingTaskId) e.preventDefault();
                                    }}
                                    onDrop={(e) => {
                                      if (!draggingTaskId) return;
                                      e.preventDefault();
                                      dropTasksOnBoard(b.id, e.dataTransfer);
                                    }}
                                  >
                                    {b.name}
                                  </div>
                                );
                              })
                          )}
                        </div>,
                        document.body
                      )}
                  </div>
                </div>
                <div className="app-header__right">
                  {isCurrentBoardSyncing && (
                    <span
                      className="flex items-center gap-1.5 text-xs text-secondary select-none px-1"
                      aria-label="Syncing tasks…"
                      title="Fetching latest tasks from relays…"
                    >
                      <svg
                        className="animate-spin h-3.5 w-3.5 shrink-0 opacity-60"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                      <span className="hidden sm:inline opacity-60">Syncing…</span>
                    </span>
                  )}
                  {settings.completedTab ? (
                    <button
                      ref={completedTabRef}
                      className="app-header__icon-btn pressable"
                      data-active={view === "completed"}
                      onClick={() => setView((prev) => (prev === "completed" ? "board" : "completed"))}
                      aria-pressed={view === "completed"}
                      aria-label={view === "completed" ? "Show board" : "Show completed tasks"}
                      title={view === "completed" ? "Show board" : "Show completed tasks"}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-[18px] w-[18px]"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M6 12.5l3.75 3.75L18 8.5" />
                      </svg>
                    </button>
	                  ) : currentBoard?.kind !== "bible" && !currentBoard?.clearCompletedDisabled ? (
	                    <button
	                      ref={completedTabRef}
	                      className="app-header__icon-btn pressable"
                      onClick={clearCompleted}
                      disabled={completed.length === 0}
                      aria-label="Clear completed tasks"
                      title="Clear completed tasks"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-[18px] w-[18px]"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M4 6h16" />
                        <path d="M6 6v12a1 1 0 001 1h10a1 1 0 001-1V6" />
                        <path d="M9 6V4h6v2" />
                        <path d="M10 11l4 4" />
	                        <path d="M14 11l-4 4" />
	                      </svg>
	                    </button>
	                  ) : null}
                  {settings.completedTab && currentBoard?.kind !== "bible" ? (
                    <button
                      type="button"
                      className="app-header__icon-btn pressable"
                      data-active={view === "board-upcoming"}
                      onClick={() => setView((prev) => (prev === "board-upcoming" ? "board" : "board-upcoming"))}
                      aria-pressed={view === "board-upcoming"}
                      aria-label={view === "board-upcoming" ? "Show board" : "Show board upcoming"}
                      title={view === "board-upcoming" ? "Show board" : "Show board upcoming"}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-[18px] w-[18px]"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.7}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="4" y="5" width="16" height="15" rx="2" />
                        <path d="M8 3v4" />
                        <path d="M16 3v4" />
                        <path d="M4 11h16" />
                        <path d="M12 14v3l2 1" />
                      </svg>
                    </button>
                  ) : null}
	                  <button
	                    type="button"
	                    className="app-header__icon-btn pressable"
	                    onClick={() => setBoardSortSheetOpen(true)}
	                    title="Filter and sort"
	                    aria-label="Filter and sort"
	                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-[18px] w-[18px]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="8" y1="17" x2="8" y2="7" />
                      <polyline points="5 10 8 7 11 10" />
                      <line x1="16" y1="7" x2="16" y2="17" />
                      <polyline points="13 14 16 17 19 14" />
	                    </svg>
	                  </button>
		                </div>
		              </>
		            )}
            {activePage === "upcoming" && (
              <>
                <div className="app-header__title">Upcoming</div>
                <div className="app-header__right" ref={setUpcomingHeaderSlot} />
              </>
            )}
            {activePage === "wallet-bounties" && (
              <>
                <div className="app-header__title">Bounties</div>
                <div className="app-header__right">
                  <button
                    type="button"
                    className="ghost-button button-sm pressable"
                    onClick={openWallet}
                  >
                    Wallet
                  </button>
                </div>
              </>
            )}
            {activePage === "wallet-address" && (
              <>
                <div className="app-header__title">Address</div>
                <div className="app-header__right">
                  <button
                    type="button"
                    className="ghost-button button-sm pressable"
                    onClick={openWallet}
                  >
                    Wallet
                  </button>
                </div>
              </>
            )}
            {activePage === "settings" && <div className="app-header__title">Settings</div>}
          </header>
        )}

        {!showFirstRunOnboarding && <KeyBackupBanner taskCount={tasks.length} />}
        <ReminderNotificationOffer offer={reminderNotificationOffer.offer} />

        {/* Animation overlay for fly effects (coins, etc.) */}
        <div ref={flyLayerRef} className="pointer-events-none fixed inset-0 z-[9999]" />

        <div
          className={`app-content${activePage === "upcoming" && upcomingPreferences.view === "list" ? " app-content--locked" : ""}`}
          ref={appContentRef}
        >
        {activePage === "boards" && (
          <BoardPage
            view={activeView}
            board={currentBoard}
            scrollerRef={scrollerRef}
            bibleScrollerRef={bibleScrollerRef}
            inlineAdd={{
              titles: inlineTitles,
              setTitle: (key, value) => setInlineTitles((prev) => ({ ...prev, [key]: value })),
              add: addInlineTask,
              setInputRef: setInlineInputRef,
            }}
            selection={{
              active: isSelectionMode,
              toggle: toggleGroupSelection,
              stateOf: groupSelectionState,
              exit: exitSelectionMode,
            }}
            setColumnRef={setColumnRef}
            week={{
              tasksByDay: byDay,
              eventsByDay: calendarByDay,
              onDayTitleClick: setDayChoice,
              dayGroupIds: weekDayGroupIds,
            }}
            lists={{
              listColumns,
              tasksByColumn: itemsByColumn,
              eventsByColumn: calendarItemsByColumn,
              compoundIndexGroups,
              listColumnSources,
              focusedColumnId: dayChoice,
              onFocusColumn: focusListColumn,
              rename: {
                renamingColumnId,
                drafts: columnDrafts,
                setDrafts: setColumnDrafts,
                commit: commitRenameColumn,
                cancel: cancelRenameColumn,
                setInputRef: setColumnNameInputRef,
              },
              columnGroupIds: listColumnGroupIds,
              onAddList: handleQuickAddList,
            }}
            bible={{
              tracker: {
                state: bibleTracker,
                onToggleBook: handleToggleBibleBook,
                onToggleChapter: handleToggleBibleChapter,
                onUpdateChapterVerses: handleUpdateBibleChapterVerses,
                onReset: handleResetBibleTracker,
                onOpenPrint: handleOpenBiblePrint,
                onOpenScan: handleOpenBibleScan,
                onDeleteArchive: handleDeleteBibleArchive,
                onRestoreArchive: handleRestoreBibleArchive,
                onCompleteBook: handleCompleteBibleBook,
              },
              scriptureMemory: settings.scriptureMemoryEnabled
                ? {
                    items: scriptureMemoryItems,
                    onAdd: handleAddScriptureMemory,
                    onRemove: handleRemoveScriptureMemory,
                    onReview: handleReviewScriptureMemory,
                    boardName: scriptureMemoryBoard?.name || undefined,
                    frequencyLabel: scriptureMemoryFrequencyOption?.label ?? "Daily",
                    sortLabel: scriptureMemorySortLabel,
                  }
                : null,
            }}
            bibleTrackerEnabled={!!settings.bibleTrackerEnabled}
            upcoming={{ boardUpcomingCount, boardUpcomingGroups }}
            completed={{
              clearCompleted,
              completed,
              completedBibleBooks,
              currentBoard,
              deleteTask,
              handleOpenDocument,
              handleRestoreBibleBook,
              restoreTask,
              streaksEnabled: settings.streaksEnabled,
            }}
          />
        )}
      {activePage === "upcoming" && (
        <Suspense fallback={null}>
          <UpcomingPage
            tasks={tasks}
            calendarEvents={calendarEvents}
            visibleBoards={visibleBoards}
            boardMap={boardMap}
            messagesBoardId={messagesBoardId}
            scrollElementRef={appContentRef}
            headerSlot={upcomingHeaderSlot}
            footerSlot={upcomingFooterSlot}
            onAddTask={openNewTaskForDate}
            router={appRouter}
            route={appRoute}
          />
        </Suspense>
      )}
      {activePage === "wallet-bounties" && (
        <Suspense fallback={null}>
          <WalletBountiesView
            fundedBountyTasks={fundedBountyTasks}
            pinnedBountyTasks={pinnedBountyTasks}
            openBountyTasks={openBountyTasks}
            boardMap={boardMap}
            toNpub={toNpub}
            setEditing={setEditing}
            addTaskToBountyList={addTaskToBountyList}
            removeTaskFromBountyList={removeTaskFromBountyList}
            walletDenominationDisplay={settings.walletDenominationDisplay}
          />
        </Suspense>
      )}
      {activePage === "wallet-address" && (
        <Suspense fallback={null}>
          <WalletAddressView
            settings={settings}
            setSettings={setSettings}
            defaultRelays={defaultRelays}
          />
        </Suspense>
      )}
      {activePage === "settings" && (
        <Suspense fallback={null}>
          <SettingsModal
            embedded
            settings={settings}
            boards={boards}
            currentBoardId={currentBoardId}
            setSettings={setSettings}
            setBoards={setBoards}
            setTasks={setTasks}
            changeBoard={changeBoard}
            shouldReloadForNavigation={shouldReloadForNavigation}
            defaultRelays={defaultRelays}
            setDefaultRelays={setDefaultRelays}
            pubkeyHex={nostrPK}
            onGenerateKey={rotateNostrKey}
            onSetKey={setCustomNostrKey}
            pushWorkState={pushWorkState}
            pushError={pushError}
            onEnablePush={enablePushNotifications}
            onDisablePush={disablePushNotifications}
            chatPushBusy={chatPushBusy}
            onEnableChatPush={enableChatPush}
            onDisableChatPush={disableChatPush}
            workerBaseUrl={workerBaseUrl}
            vapidPublicKey={vapidPublicKey}
            onResetWalletTokenTracking={handleResetWalletTokenTracking}
            onShareBoard={enableBoardSharing}
            onJoinBoard={joinSharedBoard}
            onRegenerateBoardId={regenerateBoardId}
            onBoardChanged={handleBoardChanged}
            onClearQueuedRepublish={clearQueuedRepublish}
            onResyncBoardHistory={handleResyncBoardHistory}
            onClose={closeSettings}
          />
        </Suspense>
      )}
      </div>

      {activePage === "upcoming" && <div ref={setUpcomingFooterSlot} style={{ display: "contents" }} />}

      <nav className="app-tab-switcher" aria-label="Primary">
        <div className="app-tab-switcher__pill">
          <div className="relative flex-1 min-w-0">
            <button
              type="button"
              className={`app-tab-switcher__btn pressable w-full${activePage === "boards" ? " app-tab-switcher__btn--active" : ""}`}
              onClick={openBoardsPage}
              aria-label="Boards"
            >
              <div className="app-tab-switcher__icon">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="app-tab-switcher__icon-svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="7" height="7" rx="2" />
                  <rect x="14" y="3" width="7" height="7" rx="2" />
                  <rect x="3" y="14" width="7" height="7" rx="2" />
                  <rect x="14" y="14" width="7" height="7" rx="2" />
                </svg>
              </div>
              <div className="app-tab-switcher__label">Boards</div>
            </button>
            <select
              ref={boardSelectorBottomRef}
              value={currentBoardId}
              onChange={handleBoardSelect}
              className={`absolute left-0 top-0 h-full w-full opacity-0${activePage === "boards" ? " pointer-events-auto" : " pointer-events-none"}`}
              style={{ fontSize: "max(16px, 0.88rem)", lineHeight: "1.35" }}
              aria-hidden="true"
              tabIndex={-1}
            >
              {boardSelectOptions}
            </select>
          </div>
          <button
            ref={upcomingButtonRef}
	            type="button"
	            className={`app-tab-switcher__btn pressable${activePage === "upcoming" ? " app-tab-switcher__btn--active" : ""}`}
	            onClick={openUpcoming}
	            title={`Upcoming${upcomingItemCount ? ` (${upcomingItemCount})` : ""}`}
	            aria-label={`Upcoming${upcomingItemCount ? ` (${upcomingItemCount})` : ""}`}
	            data-hovered={upcomingHover}
	            onDragOver={(e) => {
	              e.preventDefault();
	              setUpcomingHover(true);
            }}
            onDragLeave={() => setUpcomingHover(false)}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/task-id");
              if (id) postponeTaskOneWeek(id);
              setUpcomingHover(false);
              handleDragEnd();
            }}
          >
            <div className="app-tab-switcher__icon">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="app-tab-switcher__icon-svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="4" y="5" width="16" height="15" rx="2" />
                <path d="M8 3v4" />
                <path d="M16 3v4" />
                <path d="M4 11h16" />
                <path d="M12 14v3l2 1" />
              </svg>
            </div>
            <div className="app-tab-switcher__label">Upcoming</div>
          </button>
          {walletEnabled && (
          <button
            ref={walletButtonRef}
            type="button"
            className={`app-tab-switcher__btn pressable${activePage === "wallet" || activePage === "wallet-bounties" || activePage === "wallet-address" ? " app-tab-switcher__btn--active" : ""}`}
            onClick={openWallet}
            onPointerEnter={prefetchWalletModal}
            onFocus={prefetchWalletModal}
            aria-label="Wallet"
          >
            <div className="app-tab-switcher__icon">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="app-tab-switcher__icon-svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="4" x2="12" y2="20" />
                <line x1="8" y1="8" x2="16" y2="8" />
                <line x1="7" y1="12" x2="17" y2="12" />
                <line x1="8" y1="16" x2="16" y2="16" />
                <line x1="12" y1="2.75" x2="12" y2="5.25" />
                <line x1="12" y1="18.75" x2="12" y2="21.25" />
              </svg>
            </div>
            <div className="app-tab-switcher__label">Wallet</div>
          </button>
          )}
          <button
            type="button"
            className={`app-tab-switcher__btn pressable${activePage === "chat" ? " app-tab-switcher__btn--active" : ""}`}
            onClick={openChatPage}
            aria-label="Chat"
          >
            <div className="app-tab-switcher__icon app-tab-switcher__icon--badge">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="app-tab-switcher__icon-svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {chatUnreadCount > 0 && (
                <span className="app-tab-switcher__badge">{chatUnreadCount}</span>
              )}
            </div>
            <div className="app-tab-switcher__label">Chat</div>
          </button>
          <button
            type="button"
            className={`app-tab-switcher__btn pressable${activePage === "settings" ? " app-tab-switcher__btn--active" : ""}`}
            onClick={openSettings}
            aria-label="Settings"
          >
            <div className="app-tab-switcher__icon">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="app-tab-switcher__icon-svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2h-.34a2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2h.34a2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </div>
            <div className="app-tab-switcher__label">Settings</div>
          </button>

        </div>
        <RailBoardList
          boards={visibleBoards}
          currentBoardId={currentBoardId}
          boardsPageActive={activePage === "boards"}
          dragging={!!draggingTaskId}
          onSelect={openBoardFromRail}
          onAdd={openAddBoard}
          onDropTasks={dropTasksOnBoard}
        />
      </nav>

      {sharedTaskCopy && (
        <SharedTaskDestinationSheet
          boards={boards}
          initialBoardId={currentBoard?.id}
          title={sharedTaskCopy.task.title}
          onClose={() => setSharedTaskCopy(null)}
          onConfirm={(destination) => {
            if (addSharedTaskFromInbox(sharedTaskCopy.task, destination, sharedTaskCopy.sender)) {
              setSharedTaskCopy(null);
              showToast("Task added to your board");
            } else {
              showToast("Choose an available board and list.");
            }
          }}
        />
      )}
      {sharedTaskDestinationId && (
        <SharedTaskDestinationSheet
          boards={boards}
          initialBoardId={currentBoard?.id}
          title={sharedTaskDestinationItem?.type === "task" ? sharedTaskDestinationItem.task.title : "Shared task"}
          onClose={() => setSharedTaskDestinationId(null)}
          onConfirm={(destination) => completeTask(sharedTaskDestinationId, { inboxAction: "accept", inboxDestination: destination })}
        />
      )}
      <BoardSortSheet
        open={boardSortSheetOpen}
        sort={boardSort}
        onSelect={selectBoardSort}
        onClose={() => setBoardSortSheetOpen(false)}
      />

      <SelectionOverlays
        boards={boards}
        clearSelection={clearSelection}
        completeSelectedItems={completeSelectedItems}
        deleteCalendarEvent={deleteCalendarEvent}
        deleteSelectedItems={deleteSelectedItems}
        deleteTask={deleteTask}
        draggingEventId={draggingEventId}
        draggingTaskId={draggingTaskId}
        exitSelectionMode={exitSelectionMode}
        handleDragEnd={handleDragEnd}
        handlePrintSelectedTasks={handlePrintSelectedTasks}
        isSelectionMode={isSelectionMode}
        moveSelectedTasksToBoard={moveSelectedTasksToBoard}
        moveSelectedTasksToColumn={moveSelectedTasksToColumn}
        selectedCount={selectedCount}
        selectedEventsLength={selectedEvents.length}
        selectedIncompleteTaskCount={selectedTasks.filter((task) => !task.completed).length}
        selectionMoveBoardId={selectionMoveBoardId}
        selectionMoveSheetOpen={selectionMoveSheetOpen}
        selectionMoveStep={selectionMoveStep}
        selectionMoveTargets={selectionMoveTargets}
        setSelectionMoveBoardId={setSelectionMoveBoardId}
        setSelectionMoveSheetOpen={setSelectionMoveSheetOpen}
        setSelectionMoveStep={setSelectionMoveStep}
        setTrashHover={setTrashHover}
        trashHover={trashHover}
      />

      {/* Undo Snackbar */}
      {shouldRenderAppModalStack && (
        <Suspense fallback={null}>
          <AppModalStack
            addBoardOpen={addBoardOpen}
            biblePrintMeta={biblePrintMeta}
            biblePrintOpen={biblePrintOpen}
            biblePrintPaperSize={biblePrintPaperSize}
            biblePrintPdfBusy={biblePrintPdfBusy}
            biblePrintPortal={biblePrintPortal}
            bibleScanOpen={bibleScanOpen}
            bibleTracker={bibleTracker}
            boardPrintJob={boardPrintJob}
            boardPrintOpen={boardPrintOpen}
            boardPrintPdfBusy={boardPrintPdfBusy}
            boardPrintPortal={boardPrintPortal}
            boardScanOpen={boardScanOpen}
            closeAddBoard={closeAddBoard}
            createBoardFromName={createBoardFromName}
            deleteCalendarEvent={deleteCalendarEvent}
            deleteTask={deleteTask}
            handleApplyBibleScan={handleApplyBibleScan}
            handleApplyBoardScan={handleApplyBoardScan}
            handleBiblePaperSizeChange={handleBiblePaperSizeChange}
            handleBoardPaperSizeChange={handleBoardPaperSizeChange}
            handleDownloadDocument={(doc) => handleDownloadDocument(doc, previewDocumentBoardId)}
            handleExportBiblePdf={handleExportBiblePdf}
            handleExportBoardPdf={handleExportBoardPdf}
            handleOnboardingStart={handleOnboardingStart}
            handleOnboardingRestoreFromBackupFile={handleOnboardingRestoreFromBackupFile}
            handleOnboardingUseExistingKey={handleOnboardingUseExistingKey}
            handlePrintBibleWindow={handlePrintBibleWindow}
            handlePrintBoardWindow={handlePrintBoardWindow}
            joinSharedBoard={joinSharedBoard}
            previewDocument={previewDocument}
            previewDocumentBoardId={previewDocumentBoardId}
            recurringDeleteEvent={recurringDeleteEvent}
            recurringDeleteTask={recurringDeleteTask}
            setBiblePrintOpen={setBiblePrintOpen}
            setBibleScanOpen={setBibleScanOpen}
            setBoardPrintOpen={setBoardPrintOpen}
            setBoardScanOpen={setBoardScanOpen}
            setPreviewDocument={setPreviewDocument}
            setPreviewDocumentBoardId={setPreviewDocumentBoardId}
            setRecurringDeleteEvent={setRecurringDeleteEvent}
            setRecurringDeleteTask={setRecurringDeleteTask}
            showFirstRunOnboarding={showFirstRunOnboarding}
            undoDelete={undoDelete}
            undoTask={undoTask}
          />
        </Suspense>
      )}

      <UpdateToast
        handleReloadLater={handleReloadLater}
        handleReloadNow={handleReloadNow}
        updateToastVisible={updateToastVisible}
      />

      {/* Edit Modals */}      {/* Edit Modals */}
      {editing?.type === "task" && (
        <Suspense fallback={null}>
          <EditModal
            task={editing.task}
            onCancel={() => setEditing(null)}
            onDelete={() => {
              if (editing.originalType === "event") deleteCalendarEvent(editing.originalId);
              else deleteTask(editing.originalId);
              setEditing(null);
            }}
            onSave={(updated) => {
              if (editing.originalType === "event") deleteCalendarEvent(editing.originalId);
              saveEdit(updated);
            }}
            onSwitchToEvent={(draftTask) => {
              const nextEvent = convertTaskToCalendarEvent(draftTask);
              setEditing({
                type: "event",
                originalType: editing.originalType,
                originalId: editing.originalId,
                event: nextEvent,
              });
            }}
            weekStart={settings.weekStart}
            boardKind={editingBoard?.kind ?? currentBoard?.kind ?? "week"}
            boards={boards}
            onRedeemCoins={(rect) => flyCoinsToWallet(rect)}
            onRevealBounty={revealBounty}
            onTransferBounty={transferBounty}
            onPreviewDocument={handleOpenDocument}
            walletConversionEnabled={settings.walletConversionEnabled}
            walletPrimaryCurrency={settings.walletPrimaryCurrency}
            bountyListEnabled={bountyListEnabled}
            bountyListKey={activeBountyListKey}
            onAddToBountyList={addTaskToBountyList}
            onRemoveFromBountyList={removeTaskFromBountyList}
            defaultRelays={defaultRelays}
            nostrPK={nostrPK}
            nostrSkHex={nostrSkHex}
            fileServers={settings.encryptedFileServers || settings.fileServers}
            fileStorageServer={settings.encryptedFileStorageServer}
          />
        </Suspense>
      )}

      {noteViewerTaskId && (() => {
        const noteTask = tasks.find((t) => t.id === noteViewerTaskId);
        if (!noteTask) return null;
        return (
          <Suspense fallback={null}>
            <NoteViewerModal
              task={noteTask}
              onClose={() => setNoteViewerTaskId(null)}
              onSaveNote={(note, subtasks) => updateTaskNote(noteTask.id, note, subtasks)}
            />
          </Suspense>
        );
      })()}

      {editing?.type === "event" && (
        <Suspense fallback={null}>
	        <EventEditModal
	          event={editing.event}
            onCancel={() => setEditing(null)}
            onDelete={() => {
              if (editing.originalType === "task") deleteTask(editing.originalId);
              else deleteCalendarEvent(editing.originalId);
              setEditing(null);
            }}
            onSave={saveCalendarEdit}
            onSwitchToTask={(draftEvent) => {
              const nextTask = convertCalendarEventToTask(draftEvent);
              setEditing({
                type: "task",
                originalType: editing.originalType,
                originalId: editing.originalId,
                task: nextTask,
              });
            }}
            boards={boards}
            contacts={shareableContacts}
            rsvps={activeEventRsvps}
            nostrPK={nostrPK}
            nostrSkHex={nostrSkHex}
	          defaultRelays={defaultRelays}
	          onPreviewDocument={(event, doc) => handleOpenEventDocument(doc, event.boardId)}
		          onRsvp={
	            activeEventRsvpCoord
	              ? async (status, options) => {
	                  try {
                      const relays = activeEventRsvpRelays.length
                        ? relaysOrDefaults(activeEventRsvpRelays)
                        : relaysOrDefaults(defaultRelays, inboxRelays);
                      const isExternal = editing?.type === "event" ? !!editing.event.external : false;
                      const publishBoardId = editing?.type === "event" && !isExternal
                        ? (editing.event.originBoardId ?? editing.event.boardId)
                        : null;
                      const boardNostrId = publishBoardId
                        ? boards.find((b) => b.id === publishBoardId)?.nostr?.boardId
                        : undefined;
                      const inviteToken =
                        editing?.type === "event"
                          ? editing.event.inviteToken
                            || (nostrPK ? editing.event.inviteTokens?.[nostrPK] : undefined)
                          : undefined;
                      if ((!inviteToken && !boardNostrId) || !editing || editing.type !== "event") {
                        showToast("Missing invite token for RSVP.");
                        return;
                      }
                      const nextOptions =
                        boardNostrId
                          ? { ...(options ?? {}), boardId: boardNostrId }
                          : options;
                      await publishCalendarRsvp(activeEventRsvpCoord, editing.event.id, inviteToken, relays, status, nextOptions);
                      showToast(`RSVP sent: ${status}`);
                    } catch (err) {
	                    console.warn("RSVP publish failed", err);
	                    showToast("Failed to send RSVP.");
                    }
                  }
                : undefined
            }
          />
        </Suspense>
      )}

      {shareBoardModalOpen && (
        <Suspense fallback={null}>
          <ShareBoardDialogs
            closeShareBoard={closeShareBoard}
            enableBoardSharing={enableBoardSharing}
            handleOpenBoardPrint={handleOpenBoardPrint}
            handleOpenBoardScan={handleOpenBoardScan}
            handleShareBoardToContact={handleShareBoardToContact}
            setShareBoardMode={setShareBoardMode}
            setShareContactPickerOpen={setShareContactPickerOpen}
            setShareContactStatus={setShareContactStatus}
            setShareModeInfoOpen={setShareModeInfoOpen}
            setShareTemplateStatus={setShareTemplateStatus}
            shareBoardDisplayName={shareBoardDisplayName}
            shareBoardId={shareBoardId}
            shareBoardModalOpen={shareBoardModalOpen}
            shareBoardMode={shareBoardMode}
            shareBoardQrPayload={shareBoardQrPayload}
            shareBoardTarget={shareBoardTarget}
            shareContactBusy={shareContactBusy}
            shareContactPickerOpen={shareContactPickerOpen}
            shareContactStatus={shareContactStatus}
            shareModeInfoButtonRef={shareModeInfoButtonRef}
            shareModeInfoOpen={shareModeInfoOpen}
            shareModeInfoRef={shareModeInfoRef}
            shareTemplateBusy={shareTemplateBusy}
            shareTemplateStatus={shareTemplateStatus}
            shareableContacts={shareableContacts}
          />
        </Suspense>
      )}

      <WalletPhaseOutNotice
        hasBalance={walletEnabled && walletTotalBalance > 0}
        suppressed={showFirstRunOnboarding}
        onOpenWallet={openWallet}
      />

      <Suspense fallback={null}>
        <ChatShell
          active={showChat}
          contactsSyncEnabled={settings.walletContactsSyncEnabled}
          fileStorageServer={settings.fileStorageServer}
          fileServers={settings.fileServers}
          encryptedFileStorageServer={settings.encryptedFileStorageServer}
          encryptedFileServers={settings.encryptedFileServers}
          messageItems={walletMessageItems}
          inboxPendingItems={inboxPendingItems}
          pendingCalendarInvites={pendingCalendarInvites}
          onAcceptMessage={acceptInboxMessage}
          onAddTaskAgain={(task, sender) => setSharedTaskCopy({ task, sender })}
          onMaybeMessage={maybeInboxMessage}
          onDeclineMessage={declineInboxMessage}
          onDismissMessage={dismissInboxMessage}
          onMarkMessagesRead={markInboxMessagesRead}
          onCalendarInviteRsvp={handleCalendarInviteRsvp as unknown as (invite: any, status: string) => void}
          onDismissCalendarInvite={dismissCalendarInvite}
          formatCalendarInviteWhen={formatCalendarInviteWhen}
          onDmUnreadCountChange={setDmUnreadCount}
          chatMessageRetention={settings.chatMessageRetention}
        >
          {showWalletShell && (
            <CashuWalletShell
              closeWallet={closeWallet}
              defaultRelays={defaultRelays}
              openWalletBounties={openWalletBounties}
              onResetWalletTokenTracking={handleResetWalletTokenTracking}
              openWalletAddress={openWalletAddress}
              setSettings={setSettings}
              settings={settings}
              showWalletShell={showWalletShell}
              walletTokenStateResetNonce={walletTokenStateResetNonce}
            />
          )}
        </ChatShell>
      </Suspense>

      <InlineTaskOverlays
        addMenuKey={addMenuKey}
        boards={boards}
        currentBoardId={currentBoard?.id}
        handleVoiceSave={handleVoiceSave}
        nostrPK={nostrPK}
        nostrSkHex={nostrSkHex}
        openInlineTaskEditorDirect={openInlineTaskEditorDirect}
        setAddMenuKey={setAddMenuKey}
        setVoiceDictationKey={setVoiceDictationKey}
        voiceDictationKey={voiceDictationKey}
        workerBaseUrl={workerBaseUrl}
      />

      </div>
    </div>
    </TaskActionsProvider>
  );
}

function isVoiceRecurrence(value: unknown): value is NonNullable<Task["recurrence"]> {
  if (!value || typeof value !== "object") return false;
  const r = value as any;
  switch (r.type) {
    case "daily":
    case "none":
      return true;
    case "weekly":
      return Array.isArray(r.days) && r.days.length > 0 && r.days.every((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
    case "every":
      return Number.isInteger(r.n) && r.n >= 1 && ["hour", "day", "week"].includes(r.unit);
    case "monthlyDay":
      return Number.isInteger(r.day) && r.day >= 1 && r.day <= 31;
    default:
      return false;
  }
}
