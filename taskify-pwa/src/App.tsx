import React, { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  flattenUpcomingGroups,
  buildUpcomingDateKeyIndex,
  type UpcomingFlatRow,
} from "./lib/upcomingRows";
import { finalizeEvent, type EventTemplate, nip04, nip19, nip44 } from "nostr-tools";
import {
  DEFAULT_DATE_REMINDER_TIME,
  MS_PER_DAY,
  normalizeCalendarDeleteMutationPayload,
  normalizeCalendarMutationPayload,
  normalizeTaskRecurrence,
  calendarRecurrenceSyncFields,
  compressedToRawHex,
  isExternalCalendarEvent,
  isListLikeBoard,
  normalizeReminderTime,
  reminderPresetIdForMode,
  reminderPresetToMinutes,
  sanitizeReminderList,
  type Board,
  type BoardSortDirection,
  type CalendarEvent,
  type CalendarEventBase,
  type CalendarEventParticipant,
  type EditingState,
  type InboxItem,
  type InboxItemStatus,
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
  BibleTracker,
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
import { isPrintPaperSize, type PrintPaperSize } from "./components/printPaper";
import { ScriptureMemoryCard, type AddScripturePayload, type ScriptureMemoryListItem } from "./components/ScriptureMemoryCard";
import { getBibleChapterVerseCount } from "./data/bibleVerseCounts";
import { toBufferSource } from "./lib/binary";
import { useCashu } from "./context/CashuContext";
import { kvStorage } from "./storage/kvStorage";
import {
  getSkSync as nostrSkSync,
} from "./lib/nostrSkStore";
import { idbKeyValue } from "./storage/idbKeyValue";
import { TASKIFY_STORE_TASKS, TASKIFY_STORE_NOSTR } from "./storage/taskifyDb";


import { encryptToBoard, decryptFromBoard, boardTag } from "./boardCrypto";
import { useToast } from "./context/ToastContext";
import type { AccentPalette } from "./theme/palette";
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
  scriptureFrequencyToRecurrence,
  recurrencesEqual,
  chooseNextScriptureEntry,
} from "./domains/scripture/scriptureUtils";
import {
  useBibleTracker,
  useScriptureMemory,
} from "./domains/scripture/scriptureHook";
import {
  buildUsHolidayCalendarEvents,
  isUsHolidayCalendarEvent,
  fastingReminderDueTimesForMonth,
} from "./domains/calendar/holidayUtils";
import { useCalendarPicker } from "./domains/dateTime/calendarPickerHook";
import {
  DEFAULT_BOARD_SORT_DIRECTION,
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
  mergeLongestStreak,
  recurringInstanceId,
  dedupeRecurringInstances,
} from "./domains/tasks/taskUtils";
import {
  mergeTaskAssigneeResponse,
  normalizeAgentPubkey,
  normalizeNostrPubkeyHex,
  normalizeTaskAssignees,
} from "./domains/tasks/assignmentUtils";
import { useBoards, useTasks } from "./domains/tasks/taskHooks";
import {
  reserveTaskMutationTimestamp,
  TaskPublishVersionTracker,
  taskMovePersistencePlan,
} from "./domains/tasks/taskMovePersistence";
import {
  RECURRING_SERIES_CUTOFFS_KEY,
  applyRecurringSeriesCutoff,
  applyRecurringSeriesCutoffs,
  capRecurringTaskAt,
  detachCancelledRecurringTask,
  parseRecurringSeriesCutoffs,
  recurringSeriesCutoffBefore,
  serializeRecurringSeriesCutoffs,
  updateRecurringSeriesCutoff,
} from "./domains/tasks/recurrenceCutoffs";
import { useCalendarEvents } from "./domains/calendar/calendarHook";
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
  ScriptureMemoryUpdate,
} from "./domains/tasks/taskTypes";
import { type PushPlatform } from "./domains/push/pushUtils";
import { type ReminderPreset } from "./domains/dateTime/reminderUtils";
import {
  daysInCalendarMonth,
  formatDateKeyFromParts,
  formatDateKeyLocal,
  formatTimeLabel,
  formatUpcomingDayLabel,
  isoDatePart,
  isoFromDateTime,
  isoTimePart,
  monthKeyFromYearMonth,
  normalizeTimeZone,
  parseDateKey,
  parseTimeValue,
  resolveSystemTimeZone,
  startOfDay,
  taskDateKey,
  taskDisplayDateKey,
  taskTimeValue,
  taskWeekday,
  weekdayFromISO,
} from "./domains/dateTime/dateUtils";
import {
  decryptEcashTokenForRecipient,
  encryptEcashTokenForRecipient,
} from "./domains/nostr/nostrCrypto";
import {
  appendWalletHistoryEntry,
} from "./domains/backup/backupUtils";
import {
  type PushPreferences,
  type Settings,
} from "./domains/tasks/settingsTypes";
import { DEFAULT_PUSH_PREFERENCES, useSettingsSync } from "./domains/tasks/settingsHook";
import { withBoardOrder } from "./domains/tasks/boardUtils";
import {
  ensureWeekRecurrencesForCurrentWeek,
  recurringSeriesId,
  tasksInSameSeries,
} from "./lib/app/weekRecurrenceDomain";
import { isoForWeekdayLocal, startOfWeekLocal } from "./lib/app/weekBoardDate";
import {
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
  TASKIFY_CALENDAR_RSVP_KIND,
  calendarAddress,
  parseCalendarAddress,
  generateEventKey,
  generateInviteToken,
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
import { DEFAULT_NOSTR_RELAYS } from "./lib/relays";
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
import { BoardKeyManager } from "./nostr/BoardKeyManager";
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
import { BoardUpcomingView, CompletedBoardView } from "./ui/board/BoardSecondaryViews";
import { ShareBoardDialogs } from "./ui/board/ShareBoardDialogs";
import { useShareBoardState } from "./ui/board/useShareBoardState";
import { WalletBountiesView } from "./ui/wallet/WalletBountiesView";
import { WalletAddressView } from "./ui/wallet/WalletAddressView";
import { CashuWalletShell, loadCashuWalletModal } from "./ui/wallet/CashuWalletShell";
import { useMessagesBoardId, useWalletMessages } from "./ui/wallet/useWalletMessages";
import { useWalletShellState } from "./ui/wallet/useWalletShellState";
import { UpcomingControls } from "./ui/upcoming/UpcomingControls";
import { UpcomingSearch } from "./ui/upcoming/UpcomingSearch";
import { useUpcomingControlsState } from "./ui/upcoming/useUpcomingControlsState";
import { AppSortSheets } from "./ui/app/AppSortSheets";
import { UpdateToast } from "./ui/app/UpdateToast";
import { SelectionOverlays } from "./ui/selection/SelectionOverlays";
import { InlineTaskOverlays } from "./ui/task/InlineTaskOverlays";
import { useTaskPersistence } from "./nostr/useTaskPersistence";
import { useNostrIdentity } from "./nostr/useNostrIdentity";
import {
  normalizeNostrRelayList as normalizeRelayList,
  useNostrAppBackupSync,
} from "./nostr/useNostrAppBackupSync";
import { useFirstRunOnboarding } from "./onboarding/useFirstRunOnboarding";
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
  type ShareEnvelope,
  type SharedCalendarEventInvitePayload,
  type SharedTaskAssignmentResponsePayload,
  type SharedContactPayload,
  type SharedTaskPayload,
} from "./lib/shareInbox";

// ---- UI component imports (extracted subcomponents) ----
import { Card, getDraggedTaskId, getDraggedTaskIds } from "./ui/task/Card";
import { EventCard } from "./ui/calendar/EventCard";

const AppModalStack = lazy(() =>
  import("./ui/app/AppModalStack").then((module) => ({ default: module.AppModalStack })),
);
const EditModal = lazy(() =>
  import("./ui/task/EditModal").then((module) => ({ default: module.EditModal })),
);
const EventEditModal = lazy(() => import("./ui/calendar/EventEditModal"));
const SettingsModal = lazy(() =>
  import("./ui/board/SettingsModal").then((module) => ({ default: module.SettingsModal })),
);

const ADD_BOARD_OPTION_ID = "__add-board__";
const BOARD_PRINT_LAYOUT_VERSION = "v2";
const BOARD_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SPECIAL_CALENDAR_US_HOLIDAYS_LABEL = "US Holidays";
const SPECIAL_CALENDAR_US_HOLIDAY_RANGE_PAST_YEARS = 1;
const SPECIAL_CALENDAR_US_HOLIDAY_RANGE_FUTURE_YEARS = 8;


const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
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



function isAssignedSharedTask(payload: SharedTaskPayload | null | undefined): boolean {
  return !!(payload && payload.assignment === true && typeof payload.sourceTaskId === "string" && payload.sourceTaskId.trim());
}




function ShareBoardIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M12 3v12" />
      <path d="m8 7 4-4 4 4" />
      <path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    </svg>
  );
}


const LS_INBOX_PROCESSED = "taskify_inbox_processed_v1";
const MESSAGES_COLUMN_ID = "messages-shared";
const SHARE_DM_LOOKBACK_SECONDS = 3 * 24 * 60 * 60;

const BIBLE_BOARD_ID = "bible-reading";
const SCRIPTURE_MEMORY_SERIES_ID = "scripture-memory";
const FASTING_REMINDER_SERIES_ID = "fasting-reminder";

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

const RAW_WORKER_BASE = (import.meta as any)?.env?.VITE_WORKER_BASE_URL || "";
const FALLBACK_WORKER_BASE_URL = RAW_WORKER_BASE ? String(RAW_WORKER_BASE).replace(/\/$/, "") : "";
const FALLBACK_VAPID_PUBLIC_KEY = (import.meta as any)?.env?.VITE_VAPID_PUBLIC_KEY || "";
const PUSH_OPERATION_TIMEOUT_MS = 15000;

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

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  if (!base64String || typeof base64String !== 'string') {
    throw new Error('VAPID public key is missing.');
  }
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const decode = typeof atob === 'function'
    ? atob
    : (() => { throw new Error('No base64 decoder available in this environment'); });
  try {
    const rawData = decode(base64);
    if (!rawData) throw new Error('Decoded key was empty');
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    if (outputArray.length < 32) {
      throw new Error('Decoded key is too short');
    }
    return outputArray;
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Invalid VAPID public key: ${err.message}`);
    }
    throw new Error('Invalid VAPID public key.');
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

function boardScopeIds(board: Board, boards: Board[]): string[] {
  const ids = new Set<string>();
  const addId = (value?: string | null) => {
    if (typeof value === "string" && value) ids.add(value);
  };
  const addBoard = (target: Board | undefined) => {
    if (!target) return;
    addId(target.id);
    addId(target.nostr?.boardId);
  };

  addBoard(board);

  if (board.kind === "compound") {
    board.children.forEach((childId) => {
      addId(childId);
      addBoard(findBoardByCompoundChildId(boards, childId));
    });
  }

  return Array.from(ids);
}

function findBoardByCompoundChildId(boards: Board[], childId: string): Board | undefined {
  return boards.find((board) => {
    if (board.id === childId) return true;
    return !!board.nostr?.boardId && board.nostr.boardId === childId;
  });
}



const CUSTOM_ACCENT_VARIABLES: ReadonlyArray<[string, keyof AccentPalette]> = [
  ["--accent", "fill"],
  ["--accent-hover", "hover"],
  ["--accent-active", "active"],
  ["--accent-soft", "soft"],
  ["--accent-border", "border"],
  ["--accent-on", "on"],
  ["--accent-glow", "glow"],
];

function gradientFromPalette(palette: AccentPalette, hasImage: boolean): string {
  const primary = hexToRgba(palette.fill, 0.24);
  const secondary = hexToRgba(palette.fill, 0.14);
  const baseAlpha = hasImage ? 0.65 : 0.95;
  return `radial-gradient(circle at 18% -10%, ${primary}, transparent 60%),` +
    `radial-gradient(circle at 82% -12%, ${secondary}, transparent 65%),` +
    `rgba(6, 9, 18, ${baseAlpha})`;
}

function hexToRgba(hex: string, alpha: number): string {
  let value = hex.replace(/^#/, "");
  if (value.length === 3) {
    value = value.split("").map(ch => ch + ch).join("");
  }
  const int = parseInt(value.slice(0, 6), 16);
  if (Number.isNaN(int)) {
    return `rgba(52, 199, 89, ${Math.min(1, Math.max(0, alpha))})`;
  }
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const clampedAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
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
const LS_BOARD_PRINT_JOBS = "taskify_board_print_jobs_v1";



function normalizeBoardPrintJob(value: any): BoardPrintJob | null {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "string" ? value.id : "";
  const boardId = typeof value.boardId === "string" ? value.boardId : "";
  if (!id || !boardId) return null;
  const tasks = Array.isArray(value.tasks)
    ? value.tasks
      .map((task: any) => {
        if (!task || typeof task !== "object") return null;
        const taskId = typeof task.id === "string" ? task.id : "";
        const title = typeof task.title === "string" ? task.title : "";
        if (!taskId || !title) return null;
        const label = typeof task.label === "string" ? task.label : undefined;
        return { id: taskId, title, ...(label ? { label } : {}) };
      })
      .filter(Boolean) as BoardPrintTask[]
    : [];
  const paperSize = isPrintPaperSize(value.paperSize) ? value.paperSize : "letter";
  return {
    id,
    boardId,
    boardName: typeof value.boardName === "string" ? value.boardName : "Board",
    printedAtISO: typeof value.printedAtISO === "string" ? value.printedAtISO : new Date().toISOString(),
    layoutVersion: typeof value.layoutVersion === "string" ? value.layoutVersion : "v1",
    paperSize,
    tasks,
  };
}

function loadBoardPrintJob(boardId: string): BoardPrintJob | null {
  if (!boardId) return null;
  try {
    const raw = kvStorage.getItem(LS_BOARD_PRINT_JOBS);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return normalizeBoardPrintJob((parsed as Record<string, BoardPrintJob>)[boardId]);
  } catch {
    return null;
  }
}

function persistBoardPrintJob(job: BoardPrintJob): void {
  try {
    const raw = kvStorage.getItem(LS_BOARD_PRINT_JOBS);
    const parsed = raw ? JSON.parse(raw) : {};
    const next = parsed && typeof parsed === "object" ? parsed : {};
    (next as Record<string, BoardPrintJob>)[job.boardId] = job;
    kvStorage.setItem(LS_BOARD_PRINT_JOBS, JSON.stringify(next));
  } catch {}
}

/* ================== Crypto helpers (AES-GCM via local Nostr key) ================== */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", toBufferSource(data));
  return new Uint8Array(h);
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function concatBytes(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveAesKeyFromLocalSk(): Promise<CryptoKey> {
  // Derive a stable AES key from local Nostr SK: AES-GCM 256 with SHA-256(sk || label)
  const skHex = nostrSkSync();
  if (!skHex || !/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  const label = new TextEncoder().encode("taskify-ecash-v1");
  const raw = concatBytes(hexToBytes(skHex), label);
  const digest = await sha256(raw);
  return await crypto.subtle.importKey("raw", toBufferSource(digest), "AES-GCM", false, ["encrypt","decrypt"]);
}
export async function encryptEcashTokenForFunder(plain: string): Promise<{alg:"aes-gcm-256";iv:string;ct:string}> {
  const key = await deriveAesKeyFromLocalSk();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    toBufferSource(new TextEncoder().encode(plain)),
  );
  return { alg: "aes-gcm-256", iv: b64encode(iv), ct: b64encode(ctBuf) };
}
export async function decryptEcashTokenForFunder(enc: {alg:"aes-gcm-256";iv:string;ct:string}): Promise<string> {
  if (enc.alg !== "aes-gcm-256") throw new Error("Unsupported cipher");
  const key = await deriveAesKeyFromLocalSk();
  const iv = b64decode(enc.iv);
  const ct = b64decode(enc.ct);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toBufferSource(iv) }, key, toBufferSource(ct));
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

type BoardNostrKeyPair = {
  sk: Uint8Array;
  skHex: string;
  pk: string;
  npub: string;
  nsec: string;
};
const boardKeyManager = new BoardKeyManager();
async function deriveBoardNostrKeys(boardId: string): Promise<BoardNostrKeyPair> {
  return boardKeyManager.getBoardKeys(boardId);
}

/* ================= Date helpers ================= */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;



function isoForWeekday(
  target: Weekday,
  options: { base?: Date; weekStart?: Weekday } = {}
): string {
  return isoForWeekdayLocal(target, options);
}

function isoForToday(base = new Date()): string {
  return startOfDay(base).toISOString();
}
function nextOccurrence(
  currentISO: string,
  rule: Recurrence,
  keepTime = false,
  timeZone?: string,
): string | null {
  const safeZone = normalizeTimeZone(timeZone);
  if (safeZone) {
    const dateKey = isoDatePart(currentISO, safeZone);
    const dateParts = parseDateKey(dateKey);
    if (dateParts) {
      const baseTime = keepTime ? isoTimePart(currentISO, safeZone) : "";
      const applyDate = (parts: { year: number; month: number; day: number }): string => {
        const nextDateKey = formatDateKeyFromParts(parts.year, parts.month, parts.day);
        return isoFromDateTime(nextDateKey, baseTime || undefined, safeZone);
      };
      const addDays = (d: number) => {
        const base = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day));
        base.setUTCDate(base.getUTCDate() + d);
        return {
          year: base.getUTCFullYear(),
          month: base.getUTCMonth() + 1,
          day: base.getUTCDate(),
        };
      };
      const weekdayForParts = (parts: { year: number; month: number; day: number }) =>
        new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() as Weekday;
      let next: string | null = null;
      switch (rule.type) {
        case "none":
          next = null; break;
        case "daily":
          next = applyDate(addDays(1)); break;
        case "weekly": {
          if (!rule.days.length) return null;
          for (let i = 1; i <= 28; i++) {
            const cand = addDays(i);
            const wd = weekdayForParts(cand);
            if (rule.days.includes(wd)) { next = applyDate(cand); break; }
          }
          break;
        }
        case "every": {
          if (rule.unit === "hour") {
            const current = new Date(currentISO);
            const n = new Date(current.getTime() + rule.n * 3600000);
            next = n.toISOString();
          } else {
            const daysToAdd = rule.unit === "day" ? rule.n : rule.n * 7;
            next = applyDate(addDays(daysToAdd));
          }
          break;
        }
        case "monthlyDay": {
          const interval = Math.max(1, rule.interval ?? 1);
          const base = new Date(Date.UTC(dateParts.year, dateParts.month - 1 + interval, 1));
          const n = {
            year: base.getUTCFullYear(),
            month: base.getUTCMonth() + 1,
            day: Math.min(rule.day, 28),
          };
          next = applyDate(n);
          break;
        }
      }
      if (next && rule.untilISO) {
        const limitKey = isoDatePart(rule.untilISO, safeZone);
        const nextKey = isoDatePart(next, safeZone);
        if (nextKey > limitKey) return null;
      }
      return next;
    }
  }
  const currentDate = new Date(currentISO);
  const curDay = startOfDay(currentDate);
  const timeOffset = currentDate.getTime() - curDay.getTime();
  const baseTime = keepTime ? isoTimePart(currentISO) : "";
  const applyTime = (day: Date): string => {
    if (keepTime && baseTime) {
      const datePart = isoDatePart(day.toISOString());
      return isoFromDateTime(datePart, baseTime);
    }
    return new Date(day.getTime() + timeOffset).toISOString();
  };
  const addDays = (d: number) => {
    const nextDay = startOfDay(new Date(curDay.getTime() + d * 86400000));
    return applyTime(nextDay);
  };
  let next: string | null = null;
  switch (rule.type) {
    case "none":
      next = null; break;
    case "daily":
      next = addDays(1); break;
    case "weekly": {
      if (!rule.days.length) return null;
      for (let i = 1; i <= 28; i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) { next = cand; break; }
      }
      break;
    }
    case "every": {
      if (rule.unit === "hour") {
        const current = new Date(currentISO);
        const n = new Date(current.getTime() + rule.n * 3600000);
        next = n.toISOString();
      } else {
        const daysToAdd = rule.unit === "day" ? rule.n : rule.n * 7;
        next = addDays(daysToAdd);
      }
      break;
    }
    case "monthlyDay": {
      const y = curDay.getFullYear(), m = curDay.getMonth();
      const interval = Math.max(1, rule.interval ?? 1);
      const n = startOfDay(new Date(y, m + interval, Math.min(rule.day, 28)));
      next = applyTime(n);
      break;
    }
  }
  if (next && rule.untilISO) {
    const limit = startOfDay(new Date(rule.untilISO)).getTime();
    const n = startOfDay(new Date(next)).getTime();
    if (n > limit) return null;
  }
  return next;
}

function calendarEventDateKey(event: CalendarEvent): string | null {
  if (event.kind === "date") {
    return ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
  }
  const key = isoDatePart(event.startISO, event.startTzid);
  return ISO_DATE_PATTERN.test(key) ? key : null;
}

function calendarEventStartISOForRecurrence(event: CalendarEvent): string | null {
  if (event.kind === "time") return event.startISO;
  const dateKey = ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
  if (!dateKey) return null;
  return isoFromDateTime(dateKey, "00:00", "UTC");
}

function calendarEventEndMs(event: CalendarEvent): number | null {
  if (event.kind === "time") {
    const start = Date.parse(event.startISO);
    if (Number.isNaN(start)) return null;
    if (event.endISO) {
      const end = Date.parse(event.endISO);
      if (!Number.isNaN(end) && end >= start) return end;
    }
    return start;
  }
  const startKey = ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
  if (!startKey) return null;
  const endKey =
    event.endDate && ISO_DATE_PATTERN.test(event.endDate) && event.endDate >= startKey
      ? event.endDate
      : startKey;
  const parsed = parseDateKey(endKey);
  if (!parsed) return null;
  const endUtc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  if (!Number.isFinite(endUtc)) return null;
  return endUtc + MS_PER_DAY;
}

function calendarWeekRangeKeys(weekStart: Weekday, base = new Date()): { startKey: string; endKey: string } {
  const start = startOfWeek(base, weekStart);
  const startKey = formatDateKeyLocal(start);
  const end = new Date(start.getTime() + 6 * MS_PER_DAY);
  const endKey = formatDateKeyLocal(end);
  return { startKey, endKey };
}

function hiddenUntilForCalendarEvent(
  event: CalendarEvent,
  boardKind: Board["kind"],
  weekStart: Weekday,
): string | undefined {
  if (boardKind !== "lists" && boardKind !== "compound") return undefined;
  const dateKey = calendarEventDateKey(event);
  if (!dateKey) return undefined;
  const parsed = parseDateKey(dateKey);
  if (!parsed) return undefined;
  const eventDate = new Date(parsed.year, parsed.month - 1, parsed.day);
  if (Number.isNaN(eventDate.getTime())) return undefined;
  const eventWeekStart = startOfWeek(eventDate, weekStart);
  const currentWeekStart = startOfWeek(new Date(), weekStart);
  if (eventWeekStart.getTime() > currentWeekStart.getTime()) {
    return eventWeekStart.toISOString();
  }
  return undefined;
}

function isCalendarEventVisibleOnListBoard(event: CalendarEvent, weekStart: Weekday, now = new Date()): boolean {
  const dateKey = calendarEventDateKey(event);
  if (!dateKey) return false;
  const { startKey, endKey } = calendarWeekRangeKeys(weekStart, now);

  if (event.kind === "date") {
    const startKeyForEvent = ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : dateKey;
    const endKeyForEvent =
      event.endDate && ISO_DATE_PATTERN.test(event.endDate) && event.endDate >= startKeyForEvent
        ? event.endDate
        : startKeyForEvent;
    if (endKeyForEvent < startKey) return false;
    if (startKeyForEvent <= endKey && endKeyForEvent >= startKey) return true;
    return !event.hiddenUntilISO;
  }

  if (dateKey < startKey) return false;
  if (dateKey > endKey) return !event.hiddenUntilISO;
  return true;
}

/* ============= Visibility helpers (hide until X) ============= */
function revealsOnDueDate(rule: Recurrence): boolean {
  if (isFrequentRecurrence(rule)) return true;
  return false;
}

function isFrequentRecurrence(rule?: Recurrence | null): boolean {
  if (!rule) return false;
  if (rule.type === "daily" || rule.type === "weekly") return true;
  if (rule.type === "every") {
    return rule.unit === "day" || rule.unit === "week";
  }
  return false;
}

function isVisibleNow(t: Task, now = new Date()): boolean {
  if (!t.hiddenUntilISO) return true;
  const today = startOfDay(now).getTime();
  if (t.recurrence && revealsOnDueDate(t.recurrence)) {
    const dueReveal = startOfDay(new Date(t.dueISO)).getTime();
    if (!Number.isNaN(dueReveal)) return today >= dueReveal;
  }
  const reveal = startOfDay(new Date(t.hiddenUntilISO)).getTime();
  return today >= reveal;
}

function startOfWeek(d: Date, weekStart: Weekday): Date {
  return startOfWeekLocal(d, weekStart);
}

/** Decide when the next instance should re-appear (hiddenUntilISO). */
function hiddenUntilForNext(
  nextISO: string,
  rule: Recurrence,
  weekStart: Weekday
): string | undefined {
  const nextMidnight = startOfDay(new Date(nextISO));
  if (revealsOnDueDate(rule)) {
    return nextMidnight.toISOString();
  }
  const sow = startOfWeek(nextMidnight, weekStart);
  return sow.toISOString();
}
/* ================= DroppableColumn ================= */
const DroppableColumn = React.memo(React.forwardRef<HTMLDivElement, {
  title: string;
  header?: React.ReactNode;
  onDropCard: (payload: { id: string; beforeId?: string; allIds?: string[] }) => void;
  onDropEnd?: () => void;
  onTitleClick?: () => void;
  onSelectAll?: () => void;
  selectionState?: "none" | "some" | "all";
  children: React.ReactNode;
  footer?: React.ReactNode;
  scrollable?: boolean;
} & React.HTMLAttributes<HTMLDivElement>>((
  {
    title,
    header,
    onDropCard,
    onDropEnd,
    onTitleClick,
    onSelectAll,
    selectionState,
    children,
    footer,
    scrollable,
    className,
    ...props
  },
  forwardedRef
) => {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  const setRef = useCallback((el: HTMLDivElement | null) => {
    innerRef.current = el;
    if (!forwardedRef) return;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  }, [forwardedRef]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const isTaskDrag = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      return Array.from(types).some((type) => type === "text/task-id" || type === "text/plain");
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const id = getDraggedTaskId(e.dataTransfer);
      if (id) {
        let beforeId: string | undefined;
        const columnEl = innerRef.current;
        if (columnEl) {
          const cards = Array.from(
            columnEl.querySelectorAll<HTMLElement>("[data-task-id]")
          );
          const pointerY = e.clientY;
          for (const card of cards) {
            const rect = card.getBoundingClientRect();
            if (pointerY < rect.top + rect.height / 2) {
              beforeId = card.dataset.taskId || undefined;
              break;
            }
          }
        }
        const allIds = getDraggedTaskIds(e.dataTransfer) ?? undefined;
        onDropCard({ id, beforeId, allIds });
      }
      if (onDropEnd) onDropEnd();
      dragDepthRef.current = 0;
      setIsDragOver(false);
    };
    const onDragEnter = (e: DragEvent) => {
      if (!isTaskDrag(e)) return;
      dragDepthRef.current += 1;
      setIsDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isTaskDrag(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDragOver(false);
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragleave", onDragLeave);
    const resetDragState = () => {
      dragDepthRef.current = 0;
      setIsDragOver(false);
    };
    document.addEventListener("dragend", resetDragState);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragend", resetDragState);
    };
  }, [onDropCard, onDropEnd]);

  return (
    <div
      ref={setRef}
      data-column-title={title}
      data-drop-over={isDragOver || undefined}
      className={`board-column surface-panel w-[325px] shrink-0 ${scrollable ? 'flex h-full min-h-0 flex-col overflow-hidden pt-2 px-2 pb-1' : 'min-h-[320px] p-2'} ${isDragOver ? 'board-column--active' : ''} ${className ?? ''}`}
      {...props}
    >
      {header ?? (
        <div className="flex items-center justify-between mb-3 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {selectionState && onSelectAll && (
              <button
                type="button"
                role="checkbox"
                aria-checked={selectionState === "all"}
                aria-label={selectionState === "all" ? `Deselect all in ${title}` : `Select all in ${title}`}
                onClick={(e) => { e.stopPropagation(); onSelectAll(); }}
                className="flex items-center justify-center shrink-0"
                title={selectionState === "all" ? "Deselect all in list" : "Select all in list"}
              >
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${selectionState === "all" ? "bg-[var(--accent)] border-[var(--accent)]" : "border-[var(--secondary)]"}`}>
                  {selectionState === "all" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  ) : selectionState === "some" ? (
                    <div className="w-2 h-2 rounded-full bg-[var(--secondary)]" />
                  ) : null}
                </div>
              </button>
            )}
            <div
              className={`text-sm font-semibold tracking-wide text-secondary truncate ${onTitleClick ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
              onClick={onTitleClick}
              role={onTitleClick ? 'button' : undefined}
              tabIndex={onTitleClick ? 0 : undefined}
              aria-label={onTitleClick ? `Set ${title} as add target` : undefined}
              onKeyDown={(e) => {
                if (!onTitleClick) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onTitleClick();
                }
              }}
              title={onTitleClick ? 'Set as add target' : undefined}
            >
              {title}
            </div>
          </div>
          <button
            type="button"
            className="p-1 text-secondary hover:text-primary rounded shrink-0"
            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('toggleSelectionMode')); }}
            title="Select tasks">
            <svg width="16" height="16" viewBox="0 0 24 24"><path d="M6 12a2 2 0 11-4 0 2 2 0 014 0zm8 0a2 2 0 11-4 0 2 2 0 014 0zm8 0a2 2 0 11-4 0 2 2 0 014 0z" fill="currentColor"/></svg>
          </button>
        </div>
      )}
      <div className={scrollable ? 'flex-1 min-h-0 overflow-y-auto pr-1' : ''} data-column-scroll={scrollable ? "" : undefined}>
        <div className="space-y-.25">{children}</div>
      </div>
      {scrollable && footer ? <div className="mt-auto flex-shrink-0 pt-2">{footer}</div> : null}
      {!scrollable && footer}
    </div>
  );
}));

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

  const [tasks, setTasks] = useTasks();
  const recurringSeriesCutoffsRef = useRef(
    parseRecurringSeriesCutoffs(
      idbKeyValue.getItem(TASKIFY_STORE_TASKS, RECURRING_SERIES_CUTOFFS_KEY),
    ),
  );
  const recordRecurringSeriesCutoff = useCallback((task: Task, cutoffISO: string) => {
    const current = recurringSeriesCutoffsRef.current;
    const next = updateRecurringSeriesCutoff(current, task, cutoffISO);
    if (next === current) return;
    recurringSeriesCutoffsRef.current = next;
    idbKeyValue.setItem(
      TASKIFY_STORE_TASKS,
      RECURRING_SERIES_CUTOFFS_KEY,
      serializeRecurringSeriesCutoffs(next),
    );
  }, []);
  const sanitizeRecurringTasks = useCallback(<TTask extends Task,>(items: TTask[]): TTask[] => (
    applyRecurringSeriesCutoffs(items, recurringSeriesCutoffsRef.current)
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
    formatCalendarInviteWhen,
    pendingCalendarInvites,
    setCalendarInvites,
    unreadCalendarInviteCount,
  } = useCalendarInvites();
  const [editing, setEditing] = useState<EditingState | null>(null);
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
  const maybePublishTaskRef = useRef<PublishTaskFn | null>(null);
  const maybePublishCalendarEventRef = useRef<PublishCalendarEventFn | null>(null);
  const publishBoardMetadataRef = useRef<((board: Board) => Promise<void>) | null>(null);
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
    if (targetBoard.kind === "lists" && (!targetBoard.columns || targetBoard.columns.length === 0)) return;
    const baseDays = scriptureMemoryFrequencyOption?.days ?? 1;
    const recurrence = scriptureFrequencyToRecurrence(baseDays);
    const selection = chooseNextScriptureEntry(scriptureMemory.entries, baseDays, new Date());
    if (!selection) return;
    const now = new Date();
    const nowISO = now.toISOString();
    const dueDays = Number.isFinite(selection.stats.dueInDays) && selection.stats.dueInDays > 0
      ? Math.ceil(selection.stats.dueInDays)
      : 0;
    const dueDate = startOfDay(new Date(now.getTime() + dueDays * MS_PER_DAY));
    const dueISO = dueDate.toISOString();
    let hiddenUntilISO: string | undefined;
    if (startOfDay(dueDate).getTime() > startOfDay(now).getTime()) {
      const candidate = hiddenUntilForNext(dueISO, recurrence, settings.weekStart);
      if (candidate) {
        const candidateMidnight = startOfDay(new Date(candidate)).getTime();
        const todayMidnight = startOfDay(now).getTime();
        if (candidateMidnight > todayMidnight) hiddenUntilISO = candidate;
      }
    }
    let createdTask: Task | null = null;
    setTasks((prev) => {
      let changed = false;
      const nextTasks = prev.map((task) => {
        const isScriptureTask = task.seriesId === SCRIPTURE_MEMORY_SERIES_ID || task.scriptureMemoryId;
        if (!isScriptureTask) return task;
        let updated = task;
        if (updated.seriesId !== SCRIPTURE_MEMORY_SERIES_ID) {
          updated = { ...updated, seriesId: SCRIPTURE_MEMORY_SERIES_ID };
          changed = true;
        }
        if (!recurrencesEqual(updated.recurrence, recurrence)) {
          updated = { ...updated, recurrence };
          changed = true;
        }
        if (updated.boardId !== targetBoard.id) {
          updated = { ...updated, boardId: targetBoard.id };
          if (targetBoard.kind === "week") {
            updated = { ...updated, column: "day" as const };
          } else if (targetBoard.kind === "lists") {
            const firstColumn = targetBoard.columns?.[0];
            if (firstColumn) {
              updated = { ...updated, columnId: firstColumn.id };
            }
          }
          changed = true;
        } else if (targetBoard.kind === "lists") {
          const firstColumn = targetBoard.columns?.[0];
          if (firstColumn && updated.columnId !== firstColumn.id && !targetBoard.columns?.some((col) => col.id === updated.columnId)) {
            updated = { ...updated, columnId: firstColumn.id };
            changed = true;
          }
        }
        return updated;
      });
      const boundedTasks = sanitizeRecurringTasks(nextTasks);
      if (boundedTasks !== nextTasks) changed = true;
      const hasActive = boundedTasks.some((task) => !task.completed && task.seriesId === SCRIPTURE_MEMORY_SERIES_ID);
      if (hasActive) {
        return changed ? boundedTasks : prev;
      }
      const order = nextOrderForBoard(targetBoard.id, boundedTasks, settings.newTaskPosition);
      if (targetBoard.kind === "lists" && (!targetBoard.columns || targetBoard.columns.length === 0)) {
        return changed ? boundedTasks : prev;
      }
      const newTask: Task = {
        id: crypto.randomUUID(),
        boardId: targetBoard.id,
        title: `Review ${formatScriptureReference(selection.entry)}`,
        createdAt: Date.now(),
        dueISO,
        completed: false,
        order,
        recurrence,
        seriesId: SCRIPTURE_MEMORY_SERIES_ID,
        scriptureMemoryId: selection.entry.id,
        scriptureMemoryStage: selection.entry.stage ?? 0,
        scriptureMemoryPrevReviewISO: selection.entry.lastReviewISO ?? null,
        scriptureMemoryScheduledAt: nowISO,
        ...(hiddenUntilISO ? { hiddenUntilISO } : {}),
      };
      if (targetBoard.kind === "week") {
        newTask.column = "day";
      } else if (targetBoard.kind === "lists") {
        const firstColumn = targetBoard.columns?.[0];
        if (!firstColumn) return changed ? boundedTasks : prev;
        newTask.columnId = firstColumn.id;
      }
      const boundedNewTask = applyRecurringSeriesCutoff(newTask, recurringSeriesCutoffsRef.current);
      if (!boundedNewTask) return changed ? boundedTasks : prev;
      createdTask = boundedNewTask;
      return [...boundedTasks, boundedNewTask];
    });
    if (createdTask) {
      const publishPromise = maybePublishTaskRef.current?.(createdTask);
      publishPromise?.catch(() => {});
      setScriptureMemory((prev) => scheduleScriptureEntry(prev, selection.entry.id, nowISO));
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
  ]);

  useEffect(() => {
    const targetBoard =
      boards.find((b) => b.id === "week-default" && b.kind === "week")
      || boards.find((b) => b.kind === "week" && !b.archived && !b.hidden)
      || boards.find((b) => b.kind === "week")
      || null;

    if (!settings.fastingRemindersEnabled) {
      setTasks((prev) => {
        const next = prev.filter((task) => !(task.seriesId === FASTING_REMINDER_SERIES_ID && !task.completed));
        return next.length === prev.length ? prev : next;
      });
      return;
    }
    if (!targetBoard) return;

    const now = new Date();
    const months = Array.from({ length: 2 }, (_, i) => {
      const anchor = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const year = anchor.getFullYear();
      const monthIndex = anchor.getMonth();
      return { year, monthIndex, key: monthKeyFromYearMonth(year, monthIndex) };
    });
    const windowMonthKeys = new Set(months.map((m) => m.key));
    const desiredDueTimes = new Set<number>();
    months.forEach((m) => {
      const times = fastingReminderDueTimesForMonth(m.year, m.monthIndex, {
        mode: settings.fastingRemindersMode,
        weekday: settings.fastingRemindersWeekday,
        perMonth: settings.fastingRemindersPerMonth,
        seed: settings.fastingRemindersRandomSeed,
      });
      times.forEach((time) => desiredDueTimes.add(time));
    });

    const createdTasks: Task[] = [];
    setTasks((prev) => {
      const todayMidnight = startOfDay(new Date()).getTime();
      let changed = false;
      const nextTasks: Task[] = [];
      const existingDueTimes = new Set<number>();

      for (const task of prev) {
        if (task.seriesId !== FASTING_REMINDER_SERIES_ID) {
          nextTasks.push(task);
          continue;
        }
        if (task.completed) {
          nextTasks.push(task);
          continue;
        }

        const dueDate = new Date(task.dueISO);
        const dueMidnight = startOfDay(dueDate);
        const dueTime = dueMidnight.getTime();
        if (!Number.isFinite(dueTime) || Number.isNaN(dueTime)) {
          nextTasks.push(task);
          continue;
        }

        const dueMonthKey = monthKeyFromYearMonth(dueDate.getFullYear(), dueDate.getMonth());
        const managedMonth = windowMonthKeys.has(dueMonthKey);
        const isInFuture = dueTime >= todayMidnight;
        const isDesired = desiredDueTimes.has(dueTime);

        if (managedMonth && isInFuture && !isDesired) {
          changed = true;
          continue;
        }

        if (isInFuture && isDesired) {
          existingDueTimes.add(dueTime);
        }

        let updated = task;
        if (updated.boardId !== targetBoard.id) {
          updated = { ...updated, boardId: targetBoard.id };
          changed = true;
        }
        if (targetBoard.kind === "week") {
          if (updated.column !== "day") {
            updated = { ...updated, column: "day" };
            changed = true;
          }
        } else if (targetBoard.kind === "lists") {
          const firstColumn = targetBoard.columns?.[0];
          if (firstColumn && updated.columnId !== firstColumn.id) {
            updated = { ...updated, columnId: firstColumn.id };
            changed = true;
          }
        }

        nextTasks.push(updated);
      }

      const toCreate = Array.from(desiredDueTimes)
        .filter((time) => time >= todayMidnight && !existingDueTimes.has(time))
        .sort((a, b) => a - b);
      for (const dueTime of toCreate) {
        const dueISO = new Date(dueTime).toISOString();
        const order = nextOrderForBoard(targetBoard.id, nextTasks, settings.newTaskPosition);
        const newTask: Task = {
          id: crypto.randomUUID(),
          boardId: targetBoard.id,
          title: "Fasting",
          note: "Fasting reminder",
          createdAt: Date.now(),
          dueISO,
          completed: false,
          order,
          seriesId: FASTING_REMINDER_SERIES_ID,
        };
        if (targetBoard.kind === "week") {
          newTask.column = "day";
        } else if (targetBoard.kind === "lists") {
          const firstColumn = targetBoard.columns?.[0];
          if (!firstColumn) continue;
          newTask.columnId = firstColumn.id;
        }
        applyHiddenForFuture(newTask, settings.weekStart, targetBoard.kind);
        createdTasks.push(newTask);
        nextTasks.push(newTask);
        changed = true;
      }

      return changed ? nextTasks : prev;
    });

    if (createdTasks.length) {
      createdTasks.forEach((task) => {
        const publishPromise = maybePublishTaskRef.current?.(task, targetBoard);
        publishPromise?.catch(() => {});
      });
    }
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
  ]);

  useEffect(() => {
    if (!settings.showFullWeekRecurring) return;
    setTasks(prev => ensureWeekRecurrences(prev));
  }, [settings.showFullWeekRecurring, settings.weekStart]);

  // Apply font size setting to root; fall back to default size
  useEffect(() => {
    try {
      const base = settings.baseFontSize;
      if (typeof base === "number" && base >= 12) {
        const px = Math.min(22, base);
        document.documentElement.style.fontSize = `${px}px`;
      } else {
        document.documentElement.style.fontSize = "";
      }
    } catch {}
  }, [settings.baseFontSize]);

  // Ensure the app always renders with the dark theme
  useEffect(() => {
    try {
      const root = document.documentElement;
      root.classList.remove("light");
      if (!root.classList.contains("dark")) root.classList.add("dark");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const root = document.documentElement;
      const rootStyle = getComputedStyle(root);
      let color = rootStyle.getPropertyValue("--surface-base").trim() || "#050508";
      if (settings.backgroundImage && settings.backgroundAccent) {
        color = settings.backgroundAccent.fill || settings.backgroundAccent.active || color;
      } else if (settings.accent === "background" && settings.backgroundAccent) {
        color = settings.backgroundAccent.fill || settings.backgroundAccent.active || color;
      }
      root.style.setProperty("--status-bar-color", color);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", color);
    } catch {}
  }, [settings.accent, settings.backgroundAccent, settings.backgroundImage]);

  useEffect(() => {
    try {
      const root = document.documentElement;
      const style = root.style;
      if (settings.accent === "green") root.setAttribute("data-accent", "green");
      else root.removeAttribute("data-accent");

      const palette = settings.accent === "background" ? settings.backgroundAccent ?? null : null;
      const hasBackgroundImage = Boolean(settings.backgroundImage);
      for (const [cssVar, key] of CUSTOM_ACCENT_VARIABLES) {
        if (palette) style.setProperty(cssVar, palette[key]);
        else style.removeProperty(cssVar);
      }
      if (palette) {
        style.setProperty("--background-gradient", gradientFromPalette(palette, hasBackgroundImage));
      } else {
        style.removeProperty("--background-gradient");
      }
    } catch (err) {
      console.error('Failed to apply accent palette', err);
    }
  }, [settings.accent, settings.backgroundAccent, settings.backgroundImage]);

  useEffect(() => {
    let blobUrl: string | null = null;
    try {
      const root = document.documentElement;
      const style = root.style;
      if (settings.backgroundImage) {
        root.setAttribute("data-background-image", "true");

        // Convert base64 data URL → blob URL so the browser can memory-map the
        // image once and all CSS pseudo-elements share the same decoded bitmap
        // instead of each independently decoding the base64.
        try {
          const dataUrl = settings.backgroundImage;
          const commaIdx = dataUrl.indexOf(",");
          if (commaIdx === -1) throw new Error("Invalid data URL");
          const header = dataUrl.slice(0, commaIdx);
          const b64 = dataUrl.slice(commaIdx + 1);
          const mimeMatch = header.match(/data:([^;]+)/);
          const mime = mimeMatch?.[1] ?? "image/jpeg";
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: mime });
          blobUrl = URL.createObjectURL(blob);
          style.setProperty("--background-image", `url("${blobUrl}")`);
        } catch {
          // Fallback to raw base64 if blob conversion fails
          style.setProperty("--background-image", `url("${settings.backgroundImage}")`);
        }

        style.setProperty("--background-image-opacity", "1");
        const blurMode = settings.backgroundBlur;
        const overlay = blurMode === "sharp" ? "0.1" : "0.18";
        style.setProperty("--background-overlay-opacity", overlay);
        style.setProperty("--background-image-filter", blurMode === "sharp" ? "none" : "blur(36px)");
        style.setProperty("--background-image-scale", blurMode === "sharp" ? "1.02" : "1.08");
      } else {
        root.removeAttribute("data-background-image");
        style.removeProperty("--background-image");
        style.removeProperty("--background-image-opacity");
        style.removeProperty("--background-overlay-opacity");
        style.removeProperty("--background-image-filter");
        style.removeProperty("--background-image-scale");
      }
    } catch (err) {
      console.error('Failed to apply background image', err);
    }
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [settings.backgroundImage, settings.backgroundBlur]);

  const {
    applyCustomNostrKey,
    copyNsecAndDismiss,
    dismissSkBackupNotice,
    nostrPK,
    nostrPublish,
    nostrPublishRef,
    nostrSK,
    nostrSkHex,
    pool,
    rotateNostrKey,
    setCustomNostrKey,
    showSkBackupNotice,
  } = useNostrIdentity({ defaultRelays });
  const {
    clearOptimisticNostrCalendarEventSyncPending,
    clearOptimisticNostrTaskSyncPending,
    markNostrCalendarEventSyncPending,
    markNostrTaskSyncPending,
    pendingNostrCalendarEventIds,
    pendingNostrTaskIds,
  } = useTaskPersistence({
    boards,
    calendarEvents,
    tasks,
  });
  type NostrIndex = {
    boardMeta: Map<string, number>; // nostrBoardId -> created_at
    taskClock: Map<string, Map<string, number>>; // nostrBoardId -> (taskId -> created_at)
    calendarClock: Map<string, Map<string, number>>; // nostrBoardId -> (calendarEventId -> created_at)
  };
  const nostrIdxRef = useRef<NostrIndex>(((): NostrIndex => {
    const idx: NostrIndex = { boardMeta: new Map(), taskClock: new Map(), calendarClock: new Map() };
    // Seed taskClock from persisted deletion tombstones. This ensures a stale
    // CREATE event from a slow relay cannot resurrect a task we previously
    // deleted, even after a page reload (in-session protection sits in
    // tombstonesRef / publishTaskDeleted; this is the post-reload fallback).
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_TASK_TOMBSTONES);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, Record<string, number>>;
        if (parsed && typeof parsed === "object") {
          for (const [bTag, entries] of Object.entries(parsed)) {
            if (!entries || typeof entries !== "object") continue;
            const m = new Map<string, number>();
            for (const [taskId, at] of Object.entries(entries)) {
              if (typeof at === "number" && at > 0) m.set(taskId, at);
            }
            if (m.size) idx.taskClock.set(bTag, m);
          }
        }
      }
    } catch {
      // ignore — tombstone loss only weakens reload protection, not correctness in-session
    }
    return idx;
  })());
  // In-memory mirror of persisted tombstones. Kept separately from taskClock
  // because taskClock also accumulates entries for live tasks during sync,
  // which we don't want to persist (would grow unbounded).
  const tombstonesRef = useRef<Map<string, Map<string, number>>>(((): Map<string, Map<string, number>> => {
    const out = new Map<string, Map<string, number>>();
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_TASK_TOMBSTONES);
      if (!raw) return out;
      const parsed = JSON.parse(raw) as Record<string, Record<string, number>>;
      if (!parsed || typeof parsed !== "object") return out;
      for (const [bTag, entries] of Object.entries(parsed)) {
        if (!entries || typeof entries !== "object") continue;
        const m = new Map<string, number>();
        for (const [taskId, at] of Object.entries(entries)) {
          if (typeof at === "number" && at > 0) m.set(taskId, at);
        }
        if (m.size) out.set(bTag, m);
      }
    } catch {
      // ignore
    }
    return out;
  })());
  const tombstonesPersistScheduledRef = useRef(false);
  const flushTombstonesPersist = useCallback(() => {
    try {
      const obj: Record<string, Record<string, number>> = {};
      for (const [tag, entries] of tombstonesRef.current) {
        if (!entries.size) continue;
        const sub: Record<string, number> = {};
        for (const [tid, ts] of entries) sub[tid] = ts;
        obj[tag] = sub;
      }
      idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_TASK_TOMBSTONES, JSON.stringify(obj));
    } catch (err) {
      console.warn("[tombstones] failed to persist", err);
    }
  }, []);
  const recordTaskTombstone = useCallback((bTag: string, taskId: string, at: number) => {
    if (!bTag || !taskId || !Number.isFinite(at) || at <= 0) return;
    let m = tombstonesRef.current.get(bTag);
    if (!m) { m = new Map(); tombstonesRef.current.set(bTag, m); }
    const existing = m.get(taskId);
    if (existing !== undefined && existing >= at) return; // already have a newer or equal tombstone
    m.set(taskId, at);
    // Cap per-board entries by keeping the most recent N by timestamp.
    if (m.size > TASK_TOMBSTONES_PER_BOARD_MAX) {
      const trimmed = new Map(
        Array.from(m.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, TASK_TOMBSTONES_PER_BOARD_MAX),
      );
      tombstonesRef.current.set(bTag, trimmed);
    }
    // Coalesce same-tick writes (e.g., bulk "clear completed") into one IDB
    // write via a microtask. The in-memory map is updated synchronously, so
    // any code path that reads tombstonesRef in this tick still sees the new
    // entry. The IDB write happens at the end of the current microtask queue.
    if (!tombstonesPersistScheduledRef.current) {
      tombstonesPersistScheduledRef.current = true;
      Promise.resolve().then(() => {
        tombstonesPersistScheduledRef.current = false;
        flushTombstonesPersist();
      });
    }
  }, [flushTombstonesPersist]);
  const clearTaskTombstone = useCallback((bTag: string, taskId: string) => {
    const entries = tombstonesRef.current.get(bTag);
    if (!entries?.delete(taskId)) return;
    if (entries.size === 0) tombstonesRef.current.delete(bTag);
    flushTombstonesPersist();
  }, [flushTombstonesPersist]);
  const pendingNostrTasksRef = useRef<Set<string>>(new Set());
  const taskPublishVersionsRef = useRef(new TaskPublishVersionTracker());
  const pendingNostrCalendarRef = useRef<Set<string>>(new Set());
  const seenBoardTasksRef = useRef<Map<string, Set<string>>>(new Map());
  // Set of bTags where all relays have fired EOSE — used to determine live vs batch mode.
  const completedNostrInitialSyncRef = useRef<Set<string>>(new Set());
  const [pendingNostrInitialSyncByBoardTag, setPendingNostrInitialSyncByBoardTag] = useState<Record<string, true>>({});
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
        if (event.kind === 1059 && nip44?.v2) {
          const wrapKey = nip44.v2.utils.getConversationKey(hexToBytes(nostrSkHex), event.pubkey);
          const sealJson = await nip44.v2.decrypt(event.content, wrapKey);
          const sealEvent = JSON.parse(sealJson) as NostrEvent;
          if (!sealEvent || sealEvent.kind !== 13 || typeof sealEvent.content !== "string") {
            return null;
          }
          if (typeof sealEvent.pubkey !== "string") return null;
          const dmKey = nip44.v2.utils.getConversationKey(hexToBytes(nostrSkHex), sealEvent.pubkey);
          const dmJson = await nip44.v2.decrypt(sealEvent.content, dmKey);
          const rumor = JSON.parse(dmJson) as NostrEvent;
          if (!rumor || rumor.kind !== 14 || typeof rumor.content !== "string") {
            return null;
          }
          return {
            content: rumor.content,
            senderPubkey: rumor.pubkey,
            recipientPubkeys: extractPTagPubkeys(rumor.tags),
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
        const signed = finalizeEvent(deletion, hexToBytes(nostrSkHex));
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

  const addInboxCalendarInvite = useCallback((item: SharedCalendarEventInvitePayload, sender: InboxSender) => {
    const nowISO = new Date().toISOString();
    upsertCalendarInvite({
      id: item.canonical,
      source: "dm",
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
      const toPublish: Task[] = [];
      setTasks((prev) =>
        prev.map((task) => {
          if (task.id !== taskId) return task;
          const nextAssignees = mergeTaskAssigneeResponse(task.assignees, responderPubkey, status, respondedAtMs);
          if (nextAssignees === task.assignees) return task;
          const updated: Task = {
            ...task,
            assignees: nextAssignees,
            lastEditedBy: responderPubkey,
          };
          toPublish.push(updated);
          return updated;
        }),
      );
      if (toPublish.length > 0) {
        toPublish.forEach((task) => {
          maybePublishTaskRef.current?.(task).catch(() => {});
        });
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
        addInboxCalendarInvite(envelope.item as SharedCalendarEventInvitePayload, sender);
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
          if (!payload.startDate || !isDateKey(payload.startDate)) return prev;
          const endDate =
            payload.endDate && isDateKey(payload.endDate) && payload.endDate >= payload.startDate
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
  const [activePage, setActivePage] = useState<
    "boards" | "upcoming" | "wallet" | "wallet-bounties" | "wallet-address" | "chat" | "settings"
  >("boards");
  const {
    completeFirstRunOnboarding,
    handleOnboardingEnableNotifications,
    handleOnboardingGenerateNewKey,
    handleOnboardingRestoreFromBackupFile,
    handleOnboardingUseExistingKey,
    isOnboardingActiveRef,
    onboardingPushConfigured,
    onboardingPushSupported,
    showFirstRunOnboarding,
  } = useFirstRunOnboarding({
    activePage,
    applyCustomNostrKey,
    enablePushNotifications,
    pushPlatform: settings.pushNotifications?.platform,
    rotateNostrKey,
    setActivePage,
    vapidPublicKey,
    workerBaseUrl,
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
    },
    [shouldReloadForNavigation],
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
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    prefetchWalletModal();
    startTransition(() => setActivePage("wallet"));
  }, [prefetchWalletModal, shouldReloadForNavigation]);
  const openWalletBounties = useCallback(() => {
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    startTransition(() => setActivePage("wallet-bounties"));
  }, [shouldReloadForNavigation]);
  const openWalletAddress = useCallback(() => {
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    startTransition(() => setActivePage("wallet-address"));
  }, [shouldReloadForNavigation]);
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
    prefetchWalletModal();
    startTransition(() => setActivePage("chat"));
  }, [prefetchWalletModal, shouldReloadForNavigation]);

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
    const startupView = settings.startupView;
    if (startupView === "wallet" || startupView === "upcoming" || startupView === "chat") {
      if (startupView === "wallet" || startupView === "chat") {
        prefetchWalletModal();
      }
      startTransition(() => setActivePage(startupView));
    }
  }, [prefetchWalletModal, settings.startupView]);
  const { receiveToken } = useCashu();

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

  const [pushWorkState, setPushWorkState] = useState<"idle" | "enabling" | "disabling">("idle");
  const [pushError, setPushError] = useState<string | null>(null);
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
          maybePublishTaskRef.current?.(t, board, { skipBoardMetadata: true }).catch(() => {});
        });
      calendarEvents
        .filter((ev) => ev.boardId === boardId)
        .forEach((ev) => {
          maybePublishCalendarEventRef.current?.(ev, board, { skipBoardMetadata: true }).catch(() => {});
        });
    }
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

  function handleBoardSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    if (shouldReloadForNavigation()) return;
    const val = e.target.value;
    if (val === ADD_BOARD_OPTION_ID) {
      openAddBoard();
      return;
    }
    if (val === BIBLE_BOARD_ID) {
      if (view !== "completed") setView("bible");
    } else if (view === "bible") {
      setView("board");
    }
    changeBoard(val);
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
  const {
    applyUpcomingFilterPreset,
    boardSort,
    boardSortOptions,
    boardSortSheetOpen,
    cancelUpcomingPresetHold,
    handleBoardSortSelect,
    handleUpcomingSortSelect,
    maybeCancelUpcomingPresetHold,
    saveUpcomingFilterPreset,
    setBoardSortSheetOpen,
    setUpcomingBoardGrouping,
    setUpcomingFilter,
    setUpcomingFilterOpen,
    setUpcomingSearch,
    setUpcomingSearchOpen,
    setUpcomingSortSheetOpen,
    setUpcomingUsHolidaysEnabled,
    setUpcomingView,
    setUpcomingViewSheetOpen,
    setUpcomingListDate,
    showUpcomingSearch,
    startUpcomingPresetHold,
    toggleUpcomingFilter,
    upcomingBoardGrouping,
    upcomingBoardGroupingOptions,
    upcomingFilter,
    upcomingFilterGroups,
    upcomingFilterLabel,
    upcomingFilterMap,
    upcomingFilterOpen,
    upcomingFilterOptions,
    upcomingFilterPresets,
    upcomingFilterSelection,
    upcomingListDate,
    upcomingPresetHoldTriggeredRef,
    upcomingSearch,
    upcomingSearchOpen,
    upcomingSearchTerm,
    upcomingSort,
    upcomingSortSheetOpen,
    upcomingUsHolidaysEnabled,
    upcomingView,
    upcomingViewSheetOpen,
  } = useUpcomingControlsState({
    usHolidaysLabel: SPECIAL_CALENDAR_US_HOLIDAYS_LABEL,
    visibleBoards,
  });

  const openUpcomingTaskEditor = useCallback(() => {
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
    const dueISO = isoFromDateTime(upcomingListDate);
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
  }, [currentBoard, nostrPK, settings.newTaskPosition, shouldReloadForNavigation, showToast, tasks, upcomingListDate, visibleBoards]);

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
  const upcomingListRef = useRef<HTMLDivElement | null>(null);
  const upcomingSearchInputRef = useRef<HTMLInputElement | null>(null);
  const upcomingAutoScrollRef = useRef(false);
  const upcomingPendingDetailDateRef = useRef<string | null>(null);
  const upcomingCalendarSwipeRef = useRef<{ startX: number; startY: number } | null>(null);
  const inlineInputRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    if (activePage !== "upcoming") return;
    if (!upcomingSearchOpen) return;
    upcomingSearchInputRef.current?.focus();
  }, [activePage, upcomingSearchOpen]);

  const openUpcomingSearch = useCallback(() => {
    setUpcomingSearchOpen(true);
    const container = appContentRef.current;
    if (container) {
      container.scrollTo({ top: 0, behavior: "smooth" });
    }
    requestAnimationFrame(() => {
      upcomingSearchInputRef.current?.focus();
    });
  }, []);

  const closeUpcomingSearch = useCallback(() => {
    setUpcomingSearch("");
    setUpcomingSearchOpen(false);
  }, []);

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

  const titleCollator = useMemo(
    () => new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
    [],
  );
  const taskPriorityValue = useCallback(
    (task: Task) => normalizeTaskPriority(task.priority) ?? 0,
    [],
  );
  const taskCreatedAtValue = useCallback(
    (task: Task) => (typeof task.createdAt === "number" ? task.createdAt : 0),
    [],
  );
  const taskTitleValue = useCallback(
    (task: Task) => task.title?.trim() || "",
    [],
  );
  const taskDueDateKey = useCallback((task: Task) => {
    if (task.dueDateEnabled === false) return null;
    return isoDatePart(task.dueISO, task.dueTimeZone);
  }, []);
  const taskDueTimestamp = useCallback((task: Task) => {
    if (task.dueDateEnabled === false) return null;
    const ts = Date.parse(task.dueISO);
    return Number.isNaN(ts) ? null : ts;
  }, []);
  const compareNumber = useCallback((a: number, b: number, direction: BoardSortDirection) => {
    const diff = a - b;
    return direction === "asc" ? diff : -diff;
  }, []);
  const compareDue = useCallback(
    (a: Task, b: Task, direction: BoardSortDirection) => {
      const aDate = taskDueDateKey(a);
      const bDate = taskDueDateKey(b);
      if (aDate == null && bDate == null) return 0;
      if (aDate == null) return 1;
      if (bDate == null) return -1;
      if (aDate !== bDate) {
        const result = aDate.localeCompare(bDate);
        return direction === "asc" ? result : -result;
      }
      const aHasTime = !!a.dueTimeEnabled;
      const bHasTime = !!b.dueTimeEnabled;
      if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
      if (aHasTime && bHasTime) {
        const aDue = taskDueTimestamp(a);
        const bDue = taskDueTimestamp(b);
        if (aDue == null && bDue == null) return 0;
        if (aDue == null) return 1;
        if (bDue == null) return -1;
        return compareNumber(aDue, bDue, direction);
      }
      return 0;
    },
    [compareNumber, taskDueDateKey, taskDueTimestamp],
  );
  const comparePriority = useCallback(
    (a: Task, b: Task, direction: BoardSortDirection) =>
      compareNumber(taskPriorityValue(a), taskPriorityValue(b), direction),
    [compareNumber, taskPriorityValue],
  );
  const compareCreatedAt = useCallback(
    (a: Task, b: Task, direction: BoardSortDirection) =>
      compareNumber(taskCreatedAtValue(a), taskCreatedAtValue(b), direction),
    [compareNumber, taskCreatedAtValue],
  );
  const compareAlpha = useCallback(
    (a: Task, b: Task, direction: BoardSortDirection) => {
      const result = titleCollator.compare(taskTitleValue(a), taskTitleValue(b));
      return direction === "asc" ? result : -result;
    },
    [taskTitleValue, titleCollator],
  );
  const compareDefault = useCallback(
    (a: Task, b: Task) => {
      let result = compareDue(a, b, DEFAULT_BOARD_SORT_DIRECTION.due);
      if (result !== 0) return result;
      result = comparePriority(a, b, DEFAULT_BOARD_SORT_DIRECTION.priority);
      if (result !== 0) return result;
      result = compareCreatedAt(a, b, DEFAULT_BOARD_SORT_DIRECTION.created);
      if (result !== 0) return result;
      result = compareAlpha(a, b, DEFAULT_BOARD_SORT_DIRECTION.alpha);
      if (result !== 0) return result;
      const orderDiff = (a.order ?? 0) - (b.order ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return a.id.localeCompare(b.id);
    },
    [compareAlpha, compareCreatedAt, compareDue, comparePriority],
  );
  const walletBountySortTimestamp = useCallback(
    (task: Task) => {
      if (task.completed) {
        const completedAt = task.completedAt ? Date.parse(task.completedAt) : Number.NaN;
        if (Number.isFinite(completedAt)) return completedAt;
      }
      return taskCreatedAtValue(task);
    },
    [taskCreatedAtValue],
  );
  const compareWalletBountyTasks = useCallback(
    (a: Task, b: Task) => {
      const aTs = walletBountySortTimestamp(a);
      const bTs = walletBountySortTimestamp(b);
      if (aTs !== bTs) return bTs - aTs;
      if (!!a.completed !== !!b.completed) return a.completed ? -1 : 1;
      return compareDefault(a, b);
    },
    [compareDefault, walletBountySortTimestamp],
  );
  const sortBoardTasks = useCallback(
    (arr: Task[]) => {
      arr.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        if (boardSort.mode === "manual") {
          const orderDiff = (a.order ?? 0) - (b.order ?? 0);
          if (orderDiff !== 0) return orderDiff;
          return compareDefault(a, b);
        }
        let primary = 0;
        switch (boardSort.mode) {
          case "due":
            primary = compareDue(a, b, boardSort.direction);
            break;
          case "priority":
            primary = comparePriority(a, b, boardSort.direction);
            break;
          case "created":
            primary = compareCreatedAt(a, b, boardSort.direction);
            break;
          case "alpha":
            primary = compareAlpha(a, b, boardSort.direction);
            break;
        }
        if (primary !== 0) return primary;
        return compareDefault(a, b);
      });
    },
    [boardSort.direction, boardSort.mode, compareAlpha, compareCreatedAt, compareDefault, compareDue, comparePriority],
  );

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

  const upcomingBoardOrder = useMemo(() => {
    const visibleBoardOrder = visibleBoards.filter((b) => b.kind !== "bible");
    const boardOrder = new Map<string, number>();
    visibleBoardOrder.forEach((board, index) => {
      boardOrder.set(board.id, index);
    });
    return {
      visibleIds: new Set(visibleBoardOrder.map((b) => b.id)),
      boardOrder,
      fallbackBoardOrder: visibleBoardOrder.length + 1,
    };
  }, [visibleBoards]);
  const getUpcomingBoardOrder = useCallback(
    (task: Task) => upcomingBoardOrder.boardOrder.get(task.boardId) ?? upcomingBoardOrder.fallbackBoardOrder,
    [upcomingBoardOrder],
  );
  const getUpcomingEventBoardOrder = useCallback(
    (ev: CalendarEvent) => upcomingBoardOrder.boardOrder.get(ev.boardId) ?? upcomingBoardOrder.fallbackBoardOrder,
    [upcomingBoardOrder],
  );
  const compareUpcomingTime = useCallback((a: Task, b: Task, direction: BoardSortDirection) => {
    const timeA = taskTimeValue(a);
    const timeB = taskTimeValue(b);
    if (timeA != null && timeB != null && timeA !== timeB) {
      return direction === "asc" ? timeA - timeB : timeB - timeA;
    }
    if (timeA != null && timeB == null) return -1;
    if (timeA == null && timeB != null) return 1;
    return 0;
  }, []);
  const compareUpcomingFallback = useCallback(
    (a: Task, b: Task) => {
      let result = compareUpcomingTime(a, b, DEFAULT_BOARD_SORT_DIRECTION.due);
      if (result !== 0) return result;
      const boardDiff = getUpcomingBoardOrder(a) - getUpcomingBoardOrder(b);
      if (boardDiff !== 0) return boardDiff;
      const orderDiff = (a.order ?? 0) - (b.order ?? 0);
      if (orderDiff !== 0) return orderDiff;
      result = compareAlpha(a, b, DEFAULT_BOARD_SORT_DIRECTION.alpha);
      if (result !== 0) return result;
      return a.id.localeCompare(b.id);
    },
    [compareAlpha, compareUpcomingTime, getUpcomingBoardOrder],
  );
  const compareUpcomingMode = useCallback(
    (a: Task, b: Task) => {
      if (upcomingSort.mode === "manual") {
        const boardDiff = getUpcomingBoardOrder(a) - getUpcomingBoardOrder(b);
        if (boardDiff !== 0) return boardDiff;
        const orderDiff = (a.order ?? 0) - (b.order ?? 0);
        if (orderDiff !== 0) return orderDiff;
        return compareDefault(a, b);
      }
      let primary = 0;
      switch (upcomingSort.mode) {
        case "due":
          primary = compareUpcomingTime(a, b, upcomingSort.direction);
          break;
        case "priority":
          primary = comparePriority(a, b, upcomingSort.direction);
          break;
        case "created":
          primary = compareCreatedAt(a, b, upcomingSort.direction);
          break;
        case "alpha":
          primary = compareAlpha(a, b, upcomingSort.direction);
          break;
      }
      if (primary !== 0) return primary;
      return compareUpcomingFallback(a, b);
    },
    [
      compareAlpha,
      compareCreatedAt,
      compareDefault,
      comparePriority,
      compareUpcomingFallback,
      compareUpcomingTime,
      getUpcomingBoardOrder,
      upcomingSort.direction,
      upcomingSort.mode,
    ],
  );
  const sortUpcomingTasks = useCallback(
    (arr: Task[]) => {
      arr.sort((a, b) => {
        if (upcomingBoardGrouping === "grouped") {
          const boardDiff = getUpcomingBoardOrder(a) - getUpcomingBoardOrder(b);
          if (boardDiff !== 0) return boardDiff;
        }
        return compareUpcomingMode(a, b);
      });
    },
    [compareUpcomingMode, getUpcomingBoardOrder, upcomingBoardGrouping],
  );

  const compareUpcomingEventTime = useCallback((a: CalendarEvent, b: CalendarEvent, direction: BoardSortDirection) => {
    const timeValue = (ev: CalendarEvent): number => {
      if (ev.kind === "date") return -1;
      const timePart = isoTimePart(ev.startISO, ev.startTzid);
      const parsed = parseTimeValue(timePart);
      if (!parsed) return 0;
      return parsed.hour * 60 + parsed.minute;
    };

    const aTime = timeValue(a);
    const bTime = timeValue(b);
    if (aTime !== bTime) return direction === "asc" ? aTime - bTime : bTime - aTime;
    return 0;
  }, []);

  const compareUpcomingEventFallback = useCallback(
    (a: CalendarEvent, b: CalendarEvent) => {
      let result = compareUpcomingEventTime(a, b, DEFAULT_BOARD_SORT_DIRECTION.due);
      if (result !== 0) return result;
      const boardDiff = getUpcomingEventBoardOrder(a) - getUpcomingEventBoardOrder(b);
      if (boardDiff !== 0) return boardDiff;
      const orderDiff = (a.order ?? 0) - (b.order ?? 0);
      if (orderDiff !== 0) return orderDiff;
      result = titleCollator.compare(a.title?.trim() || "", b.title?.trim() || "");
      if (result !== 0) return result;
      return a.id.localeCompare(b.id);
    },
    [compareUpcomingEventTime, getUpcomingEventBoardOrder, titleCollator],
  );

  const compareUpcomingEventMode = useCallback(
    (a: CalendarEvent, b: CalendarEvent) => {
      if (upcomingSort.mode === "manual") {
        const orderDiff = (a.order ?? 0) - (b.order ?? 0);
        if (orderDiff !== 0) return orderDiff;
        return compareUpcomingEventFallback(a, b);
      }

      let primary = 0;
      switch (upcomingSort.mode) {
        case "due":
          primary = compareUpcomingEventTime(a, b, upcomingSort.direction);
          break;
        case "alpha": {
          const result = titleCollator.compare(a.title?.trim() || "", b.title?.trim() || "");
          primary = upcomingSort.direction === "asc" ? result : -result;
          break;
        }
      }
      if (primary !== 0) return primary;
      return compareUpcomingEventFallback(a, b);
    },
    [
      compareUpcomingEventFallback,
      compareUpcomingEventTime,
      titleCollator,
      upcomingSort.direction,
      upcomingSort.mode,
    ],
  );

  const sortUpcomingEvents = useCallback(
    (arr: CalendarEvent[]) => {
      arr.sort((a, b) => {
        if (upcomingBoardGrouping === "grouped") {
          const boardDiff = getUpcomingEventBoardOrder(a) - getUpcomingEventBoardOrder(b);
          if (boardDiff !== 0) return boardDiff;
        }
        return compareUpcomingEventMode(a, b);
      });
    },
    [compareUpcomingEventMode, getUpcomingEventBoardOrder, upcomingBoardGrouping],
  );
  const upcomingUsHolidayEvents = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return buildUsHolidayCalendarEvents(
      currentYear - SPECIAL_CALENDAR_US_HOLIDAY_RANGE_PAST_YEARS,
      currentYear + SPECIAL_CALENDAR_US_HOLIDAY_RANGE_FUTURE_YEARS,
    );
  }, []);
  const upcoming = useMemo(() => {
    const visibleIds = upcomingBoardOrder.visibleIds;
    return tasks.filter((t) => {
      if (!visibleIds.has(t.boardId)) return false;
      if (t.boardId === messagesBoardId) return false;
      if (t.completed) return false;
      if (t.dueDateEnabled === false) return false;
      const ts = Date.parse(t.dueISO);
      return !Number.isNaN(ts);
    });
  }, [messagesBoardId, tasks, upcomingBoardOrder]);

  const upcomingEvents = useMemo(() => {
    const visibleIds = upcomingBoardOrder.visibleIds;
    const boardEvents = calendarEvents.filter((ev) => {
      if (!isExternalCalendarEvent(ev)) {
        if (!visibleIds.has(ev.boardId)) return false;
        if (ev.boardId === messagesBoardId) return false;
      }
      if (ev.kind === "date") {
        return ISO_DATE_PATTERN.test(ev.startDate);
      }
      const ts = Date.parse(ev.startISO);
      return !Number.isNaN(ts);
    });
    return upcomingUsHolidaysEnabled ? [...boardEvents, ...upcomingUsHolidayEvents] : boardEvents;
  }, [
    calendarEvents,
    messagesBoardId,
    upcomingBoardOrder,
    upcomingUsHolidayEvents,
    upcomingUsHolidaysEnabled,
  ]);

  const upcomingItemCount = upcoming.length + upcomingEvents.length;

  const filteredUpcoming = useMemo(() => {
    let filtered = upcoming;
    if (upcomingFilterOptions.length) {
      if (upcomingFilter !== null && upcomingFilter.length === 0) {
        filtered = [];
      } else if (upcomingFilter !== null) {
        const { selectedBoards, selectedLists } = upcomingFilterMap;
        filtered = upcoming.filter((task) => {
          const board = boardMap.get(task.boardId);
          const listSet = selectedLists.get(task.boardId);
          if (selectedBoards.has(task.boardId)) {
            if (board?.kind === "lists") {
              if (!task.columnId) return false;
              if (!listSet) return true;
              if (listSet.size === 0) return false;
              return listSet.has(task.columnId);
            }
            return true;
          }
          if (listSet && task.columnId && listSet.has(task.columnId)) return true;
          return false;
        });
      }
    }

    if (!upcomingSearchTerm) return filtered;

    return filtered.filter((task) => {
      const note = task.note?.toLowerCase() ?? "";
      return task.title.toLowerCase().includes(upcomingSearchTerm) || note.includes(upcomingSearchTerm);
    });
  }, [boardMap, upcoming, upcomingFilter, upcomingFilterMap, upcomingFilterOptions.length, upcomingSearchTerm]);

  const filteredUpcomingEvents = useMemo(() => {
    let filtered = upcomingEvents;
    if (upcomingFilterOptions.length) {
      if (upcomingFilter !== null && upcomingFilter.length === 0) {
        filtered = [];
      } else if (upcomingFilter !== null) {
        const { selectedBoards, selectedLists } = upcomingFilterMap;
        filtered = upcomingEvents.filter((ev) => {
          if (isUsHolidayCalendarEvent(ev)) return upcomingUsHolidaysEnabled;
          if (ev.external) return true;
          const board = boardMap.get(ev.boardId);
          const listSet = selectedLists.get(ev.boardId);
          if (selectedBoards.has(ev.boardId)) {
            if (board?.kind === "lists") {
              if (!ev.columnId) return false;
              if (!listSet) return true;
              if (listSet.size === 0) return false;
              return listSet.has(ev.columnId);
            }
            return true;
          }
          if (listSet && ev.columnId && listSet.has(ev.columnId)) return true;
          return false;
        });
      }
    }

    if (!upcomingSearchTerm) return filtered;

    return filtered.filter((ev) => {
      const summary = (ev.summary || "").toLowerCase();
      const description = (ev.description || "").toLowerCase();
      const locations = (ev.locations || []).join(" ").toLowerCase();
      const refs = (ev.references || []).join(" ").toLowerCase();
      return (
        ev.title.toLowerCase().includes(upcomingSearchTerm) ||
        summary.includes(upcomingSearchTerm) ||
        description.includes(upcomingSearchTerm) ||
        locations.includes(upcomingSearchTerm) ||
        refs.includes(upcomingSearchTerm)
      );
    });
  }, [
    boardMap,
    upcomingEvents,
    upcomingFilter,
    upcomingFilterMap,
    upcomingFilterOptions.length,
    upcomingSearchTerm,
    upcomingUsHolidaysEnabled,
  ]);

  const filteredUpcomingCount = filteredUpcoming.length + filteredUpcomingEvents.length;
  const boardUpcomingCutoffDateKey = formatDateKeyLocal(new Date());

  const boardUpcomingTasks = useMemo(() => {
    return tasksForBoard.filter((task) => {
      if (task.completed) return false;
      if (task.dueDateEnabled === false) return false;
      const ts = Date.parse(task.dueISO);
      if (Number.isNaN(ts)) return false;
      const dateKey = taskDisplayDateKey(task);
      if (!ISO_DATE_PATTERN.test(dateKey)) return false;
      return dateKey > boardUpcomingCutoffDateKey;
    });
  }, [boardUpcomingCutoffDateKey, tasksForBoard]);

  const boardUpcomingEvents = useMemo(() => {
    return calendarEventsForBoard.filter((ev) => {
      if (ev.kind === "date") {
        const start = ISO_DATE_PATTERN.test(ev.startDate) ? ev.startDate : null;
        if (!start) return false;
        const end =
          ev.endDate && ISO_DATE_PATTERN.test(ev.endDate) && ev.endDate >= start
            ? ev.endDate
            : start;
        return end > boardUpcomingCutoffDateKey;
      }
      const ts = Date.parse(ev.startISO);
      if (Number.isNaN(ts)) return false;
      const dateKey = isoDatePart(ev.startISO, ev.startTzid);
      if (!ISO_DATE_PATTERN.test(dateKey)) return false;
      return dateKey > boardUpcomingCutoffDateKey;
    });
  }, [boardUpcomingCutoffDateKey, calendarEventsForBoard]);

  const boardUpcomingCount = boardUpcomingTasks.length + boardUpcomingEvents.length;

  const boardUpcomingDayMap = useMemo(() => {
    const map = new Map<string, { tasks: Task[]; events: CalendarEvent[] }>();
    const ensureEntry = (dateKey: string) => {
      let entry = map.get(dateKey);
      if (entry) return entry;
      entry = { tasks: [], events: [] };
      map.set(dateKey, entry);
      return entry;
    };

    boardUpcomingTasks.forEach((task) => {
      const dateKey = taskDisplayDateKey(task);
      if (dateKey <= boardUpcomingCutoffDateKey) return;
      ensureEntry(dateKey).tasks.push(task);
    });

    const addDaysToKey = (dateKey: string, delta: number): string | null => {
      const parsed = parseDateKey(dateKey);
      if (!parsed) return null;
      const base = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
      if (Number.isNaN(base.getTime())) return null;
      base.setUTCDate(base.getUTCDate() + delta);
      return base.toISOString().slice(0, 10);
    };

    boardUpcomingEvents.forEach((ev) => {
      if (ev.kind === "date") {
        const start = ISO_DATE_PATTERN.test(ev.startDate) ? ev.startDate : null;
        if (!start) return;
        const end =
          ev.endDate && ISO_DATE_PATTERN.test(ev.endDate) && ev.endDate >= start
            ? ev.endDate
            : start;
        let cursor = start;
        let guard = 0;
        while (guard++ < 366) {
          if (cursor > boardUpcomingCutoffDateKey) ensureEntry(cursor).events.push(ev);
          if (cursor === end) break;
          const next = addDaysToKey(cursor, 1);
          if (!next) break;
          cursor = next;
        }
        return;
      }

      const dateKey = isoDatePart(ev.startISO, ev.startTzid);
      if (dateKey <= boardUpcomingCutoffDateKey) return;
      ensureEntry(dateKey).events.push(ev);
    });

    for (const entry of map.values()) {
      sortUpcomingEvents(entry.events);
      sortUpcomingTasks(entry.tasks);
    }

    return map;
  }, [boardUpcomingCutoffDateKey, boardUpcomingEvents, boardUpcomingTasks, sortUpcomingEvents, sortUpcomingTasks]);

  const boardUpcomingGroups = useMemo(() => {
    const groups: { dateKey: string; label: string; tasks: Task[]; events: CalendarEvent[] }[] = [];
    const dateKeys = Array.from(boardUpcomingDayMap.keys()).sort((a, b) => a.localeCompare(b));
    dateKeys.forEach((dateKey) => {
      const entry = boardUpcomingDayMap.get(dateKey);
      if (!entry) return;
      groups.push({
        dateKey,
        label: formatUpcomingDayLabel(dateKey),
        tasks: entry.tasks,
        events: entry.events,
      });
    });
    return groups;
  }, [boardUpcomingDayMap]);

  const upcomingDayMap = useMemo(() => {
    const map = new Map<string, { tasks: Task[]; events: CalendarEvent[] }>();
    const ensureEntry = (dateKey: string) => {
      let entry = map.get(dateKey);
      if (entry) return entry;
      entry = { tasks: [], events: [] };
      map.set(dateKey, entry);
      return entry;
    };

    filteredUpcoming.forEach((task) => {
      const dateKey = taskDisplayDateKey(task);
      ensureEntry(dateKey).tasks.push(task);
    });

    const addDaysToKey = (dateKey: string, delta: number): string | null => {
      const parsed = parseDateKey(dateKey);
      if (!parsed) return null;
      const base = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
      if (Number.isNaN(base.getTime())) return null;
      base.setUTCDate(base.getUTCDate() + delta);
      return base.toISOString().slice(0, 10);
    };

    filteredUpcomingEvents.forEach((ev) => {
      if (ev.kind === "date") {
        const start = ISO_DATE_PATTERN.test(ev.startDate) ? ev.startDate : null;
        if (!start) return;
        const end =
          ev.endDate && ISO_DATE_PATTERN.test(ev.endDate) && ev.endDate >= start
            ? ev.endDate
            : start;
        let cursor = start;
        let guard = 0;
        while (guard++ < 366) {
          ensureEntry(cursor).events.push(ev);
          if (cursor === end) break;
          const next = addDaysToKey(cursor, 1);
          if (!next) break;
          cursor = next;
        }
        return;
      }

      const dateKey = isoDatePart(ev.startISO, ev.startTzid);
      ensureEntry(dateKey).events.push(ev);
    });

    for (const entry of map.values()) {
      sortUpcomingEvents(entry.events);
      sortUpcomingTasks(entry.tasks);
    }

    return map;
  }, [filteredUpcoming, filteredUpcomingEvents, sortUpcomingEvents, sortUpcomingTasks]);
  const upcomingGroups = useMemo(() => {
    const groups: { dateKey: string; label: string; tasks: Task[]; events: CalendarEvent[] }[] = [];
    const dateKeys = Array.from(upcomingDayMap.keys()).sort((a, b) => a.localeCompare(b));
    dateKeys.forEach((dateKey) => {
      const entry = upcomingDayMap.get(dateKey);
      if (!entry) return;
      groups.push({
        dateKey,
        label: formatUpcomingDayLabel(dateKey),
        tasks: entry.tasks,
        events: entry.events,
      });
    });
    return groups;
  }, [upcomingDayMap]);

  // ── Virtualized upcoming list (Item #11) ──────────────────────────────────
  // The grouped upcoming view is the only surface that grows linearly with
  // total task/event count across days, so it's the highest-leverage place to
  // virtualize. We flatten {group → [header, ...events, ...tasks]} into a
  // single row array (in `lib/upcomingRows.ts`, so the logic is unit-testable
  // independent of React/jsdom plumbing), then drive a `react-virtual` list
  // over it. Day headers are small (~32px), cards are variable (~120px
  // estimate, refined by ResizeObserver via `measureElement`). Scroll parent
  // is the existing `.app-content` container (`appContentRef`).
  const upcomingFlatRows = useMemo<UpcomingFlatRow[]>(
    () => flattenUpcomingGroups(upcomingGroups),
    [upcomingGroups],
  );

  // Map dateKey → flat-row index of that day's header. Used by
  // `scrollUpcomingToDate` to call `virtualizer.scrollToIndex(...)` when the
  // target day is offscreen (and therefore not in the rendered DOM subtree).
  const upcomingDateKeyToIndex = useMemo(
    () => buildUpcomingDateKeyIndex(upcomingFlatRows),
    [upcomingFlatRows],
  );

  const upcomingVirtualizer = useVirtualizer({
    count: upcomingFlatRows.length,
    getScrollElement: () => appContentRef.current,
    estimateSize: (index) => {
      const row = upcomingFlatRows[index];
      return row?.kind === "day-header" ? 32 : 120;
    },
    overscan: 8,
  });
  const {
    calendarAnchor: upcomingListAnchor,
    calendarMonthLabel: upcomingListMonthLabel,
    calendarCells: upcomingListCalendar,
    showMonthPicker: upcomingListMonthPickerOpen,
    moveCalendarMonth: moveUpcomingListMonth,
    handleMonthLabelClick: handleUpcomingListMonthLabelClick,
    monthPickerYears: upcomingListMonthPickerYears,
    monthPickerMonth: upcomingListMonthPickerMonth,
    monthPickerYear: upcomingListMonthPickerYear,
    monthPickerMonthColumnRef: upcomingListMonthPickerMonthColumnRef,
    monthPickerYearColumnRef: upcomingListMonthPickerYearColumnRef,
    handleMonthPickerMonthScroll: handleUpcomingListMonthPickerMonthScroll,
    handleMonthPickerYearScroll: handleUpcomingListMonthPickerYearScroll,
  } = useCalendarPicker(upcomingListDate);
  const upcomingListSelectedDate = useMemo(() => {
    const parsed = new Date(`${upcomingListDate}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [upcomingListDate]);
	  const upcomingListToday = useMemo(() => startOfDay(new Date()), []);
	  const upcomingListDayMap = upcomingDayMap;
	  const upcomingListEntry = useMemo(
	    () => upcomingListDayMap.get(upcomingListDate) ?? { tasks: [], events: [] },
	    [upcomingListDayMap, upcomingListDate],
	  );
	  const upcomingListEvents = upcomingListEntry.events;
	  const upcomingListTasks = upcomingListEntry.tasks;
	  const upcomingListDateRef = useRef(upcomingListDate);
  useEffect(() => {
    const prevDate = upcomingListDateRef.current;
    const dateChanged = prevDate !== upcomingListDate;
    upcomingListDateRef.current = upcomingListDate;
    if (upcomingView !== "list") return;
    if (dateChanged) return;
    const selected = new Date(`${upcomingListDate}T00:00:00`);
    if (Number.isNaN(selected.getTime())) return;
    if (
      selected.getFullYear() === upcomingListAnchor.getFullYear() &&
      selected.getMonth() === upcomingListAnchor.getMonth()
    ) {
      return;
    }
    const maxDay = daysInCalendarMonth(upcomingListAnchor.getFullYear(), upcomingListAnchor.getMonth());
    const next = new Date(
      upcomingListAnchor.getFullYear(),
      upcomingListAnchor.getMonth(),
      Math.min(selected.getDate(), maxDay),
    );
    setUpcomingListDate(formatDateKeyLocal(next));
  }, [upcomingListAnchor, upcomingListDate, upcomingView]);

  const resolveUpcomingTargetDateKey = useCallback((preferredDateKey: string) => {
    if (!upcomingGroups.length) return null;
    if (upcomingGroups.some((group) => group.dateKey === preferredDateKey)) {
      return preferredDateKey;
    }
    const nextGroup = upcomingGroups.find((group) => group.dateKey > preferredDateKey);
    if (nextGroup) return nextGroup.dateKey;
    return upcomingGroups[upcomingGroups.length - 1].dateKey;
  }, [upcomingGroups]);
  const scrollUpcomingToDate = useCallback((dateKey: string, behavior: ScrollBehavior = "smooth") => {
    const list = upcomingListRef.current;
    const scrollContainer = appContentRef.current;
    if (!list || !scrollContainer) return false;
    const targetKey = resolveUpcomingTargetDateKey(dateKey);
    if (!targetKey) return false;

    // Grouped view is virtualized: target day's header may be outside the
    // rendered DOM range, so `querySelector` would miss it. Use the
    // virtualizer's scrollToIndex with the precomputed dateKey→index map.
    const virtualIndex = upcomingDateKeyToIndex.get(targetKey);
    if (typeof virtualIndex === "number") {
      upcomingVirtualizer.scrollToIndex(virtualIndex, { align: "start", behavior });
      return true;
    }

    const selector = `[data-upcoming-date="${targetKey}"]`;
    const target = list.querySelector(selector) as HTMLElement | null;
    const fallback = list.firstElementChild as HTMLElement | null;
    const scrollTarget = target ?? fallback;
    if (!scrollTarget) return false;
    requestAnimationFrame(() => {
      const containerRect = scrollContainer.getBoundingClientRect();
      const targetRect = scrollTarget.getBoundingClientRect();
      const offset = targetRect.top - containerRect.top + scrollContainer.scrollTop;
      scrollContainer.scrollTo({ top: offset, behavior });
    });
    return true;
  }, [resolveUpcomingTargetDateKey, upcomingDateKeyToIndex, upcomingVirtualizer]);
  const scrollUpcomingToToday = useCallback((behavior: ScrollBehavior = "smooth") => {
    const todayKey = isoDatePart(new Date().toISOString());
    return scrollUpcomingToDate(todayKey, behavior);
  }, [scrollUpcomingToDate]);
  const getFocusedUpcomingDateFromScroll = useCallback(() => {
    const list = upcomingListRef.current;
    const scrollContainer = appContentRef.current;
    if (!list || !scrollContainer) return null;
    const groups = Array.from(list.querySelectorAll<HTMLElement>("[data-upcoming-date]"));
    if (!groups.length) return null;
    const containerTop = scrollContainer.getBoundingClientRect().top;
    const firstVisible = groups.find((group) => group.getBoundingClientRect().bottom >= containerTop + 1);
    const focused = firstVisible ?? groups[groups.length - 1];
    const key = focused.getAttribute("data-upcoming-date");
    return key && key.trim() ? key : null;
  }, []);
  const handleUpcomingViewChange = useCallback((nextView: "details" | "list") => {
    if (nextView === upcomingView) {
      setUpcomingViewSheetOpen(false);
      return;
    }
    if (nextView === "details") {
      upcomingPendingDetailDateRef.current = upcomingListDate;
      upcomingAutoScrollRef.current = false;
    } else {
      const focusedDate = getFocusedUpcomingDateFromScroll();
      if (focusedDate) {
        setUpcomingListDate(focusedDate);
      }
    }
    setUpcomingView(nextView);
    setUpcomingViewSheetOpen(false);
  }, [getFocusedUpcomingDateFromScroll, upcomingListDate, upcomingView]);
  const handleUpcomingCalendarTouchStart = useCallback((event: React.TouchEvent) => {
    if (upcomingListMonthPickerOpen) return;
    if (!event.touches.length) return;
    const touch = event.touches[0];
    upcomingCalendarSwipeRef.current = { startX: touch.clientX, startY: touch.clientY };
  }, [upcomingListMonthPickerOpen]);
  const handleUpcomingCalendarTouchEnd = useCallback((event: React.TouchEvent) => {
    if (upcomingListMonthPickerOpen) return;
    const swipe = upcomingCalendarSwipeRef.current;
    upcomingCalendarSwipeRef.current = null;
    if (!swipe) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - swipe.startX;
    const deltaY = touch.clientY - swipe.startY;
    if (Math.abs(deltaY) < 40 || Math.abs(deltaY) < Math.abs(deltaX)) return;
    moveUpcomingListMonth(deltaY < 0 ? 1 : -1);
  }, [moveUpcomingListMonth, upcomingListMonthPickerOpen]);
  const handleUpcomingListDaySelect = useCallback((day: number) => {
    const next = new Date(upcomingListCalendar.year, upcomingListCalendar.month, day);
    if (Number.isNaN(next.getTime())) return;
    setUpcomingListDate(formatDateKeyLocal(next));
  }, [upcomingListCalendar.month, upcomingListCalendar.year]);
  const handleUpcomingToday = useCallback(() => {
    if (upcomingView === "list") {
      const today = isoDatePart(new Date().toISOString());
      setUpcomingListDate(today);
      return;
    }
    scrollUpcomingToToday("smooth");
  }, [scrollUpcomingToToday, upcomingView]);
	  function renderUpcomingTaskCard(t: Task) {
    const board = boardMap.get(t.boardId);
    const boardLabel = board?.name || "Board";
    const listLabel =
      board?.kind === "lists"
        ? board.columns.find((column) => column.id === t.columnId)?.name || ""
        : "";
    const locationLabel = listLabel ? `${boardLabel} • ${listLabel}` : boardLabel;
    const canReveal = t.hiddenUntilISO && !isVisibleNow(t);
    const revealAction = canReveal ? (
      <button
        type="button"
        className="icon-button icon-button--accent pressable"
        aria-label="Reveal now"
        title="Reveal now"
        onClick={() =>
          setTasks((prev) =>
            prev.map((x) => (x.id === t.id ? { ...x, hiddenUntilISO: undefined } : x))
          )
        }
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    ) : null;
    return (
      <div key={t.id} className="space-y-2">
        <Card
                            isSelectionMode={isSelectionMode}
                            isSelected={selectedItemIds.includes(t.id)}
                            onToggleSelect={toggleItemSelection}
                            selectedTaskIds={isSelectionMode ? selectedItemIds : undefined}
          syncPending={pendingNostrTaskIds.has(t.id)}
          task={t}
          meta={locationLabel}
          trailing={revealAction}
          onFlyToCompleted={(rect) => { if (settings.completedTab) flyToCompleted(rect); }}
          onComplete={(from) => {
            if (!t.completed) completeTask(t.id);
            else if (t.bounty && t.bounty.state === "locked") revealBounty(t.id);
            else if (t.bounty && t.bounty.state === "unlocked" && t.bounty.token) claimBounty(t.id, from);
            else restoreTask(t.id);
          }}
          onEdit={() => setEditing({ type: "task", originalType: "task", originalId: t.id, task: t })}
          onDropBefore={() => {}}
          showStreaks={settings.streaksEnabled}
          onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
          onDragStart={(id) => setDraggingTaskId(id)}
          onDragEnd={handleDragEnd}
          hideCompletedSubtasks={settings.hideCompletedSubtasks}
          onOpenDocument={handleOpenDocument}
          onDismissInbox={
            t.inboxItem ? () => completeTask(t.id, { inboxAction: "dismiss" }) : undefined
          }
        />
      </div>
    );
	  }

	  const renderUpcomingEventCard = useCallback((ev: CalendarEvent) => {
	    const isUsHoliday = isUsHolidayCalendarEvent(ev);
	    const board = boardMap.get(ev.boardId);
	    const boardLabel = isUsHoliday
	      ? SPECIAL_CALENDAR_US_HOLIDAYS_LABEL
	      : (board?.name || "Board");
	    const listLabel =
	      board?.kind === "lists"
	        ? board.columns.find((column) => column.id === ev.columnId)?.name || ""
	        : "";
	    const placementLabel = listLabel ? `${boardLabel} • ${listLabel}` : boardLabel;
	    const location = (ev.locations || []).find((value) => typeof value === "string" && value.trim())?.trim() || "";
	    const meta = location ? `${placementLabel} • ${location}` : placementLabel;
	    const now = new Date();
	    const canReveal =
	      !!ev.hiddenUntilISO &&
	      !!board &&
	      isListLikeBoard(board) &&
	      !isCalendarEventVisibleOnListBoard(ev, settings.weekStart, now);
	    const revealAction = canReveal ? (
	      <button
	        type="button"
	        className="icon-button icon-button--accent pressable"
	        aria-label="Reveal now"
	        title="Reveal now"
	        onClick={() =>
	          setCalendarEvents((prev) =>
	            prev.map((x) => (x.id === ev.id ? { ...x, hiddenUntilISO: undefined } : x))
	          )
	        }
	      >
	        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
	          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
	          <circle cx="12" cy="12" r="3" />
	        </svg>
	      </button>
	    ) : null;

	    return (
	      <div key={ev.id} className="space-y-2">
	        <EventCard
	          event={ev}
	          syncPending={pendingNostrCalendarEventIds.has(ev.id)}
	          showDate={false}
	          meta={meta}
	          trailing={revealAction}
	          onOpenDocument={(event, doc) => handleOpenEventDocument(doc, event.boardId)}
	          onEdit={isUsHoliday ? undefined : () => setEditing({ type: "event", originalType: "event", originalId: ev.id, event: ev })}
	          onDragStart={isUsHoliday ? undefined : (id) => setDraggingEventId(id)}
	          onDragEnd={handleDragEnd}
          isSelectionMode={isSelectionMode}
          isSelected={selectedItemIds.includes(ev.id)}
          onToggleSelect={toggleItemSelection}
	        />
	      </div>
	    );
	  }, [boardMap, handleDragEnd, handleOpenEventDocument, isSelectionMode, pendingNostrCalendarEventIds, selectedItemIds, setCalendarEvents, setEditing, settings.weekStart, toggleItemSelection]);

	  useEffect(() => {
	    if (activePage !== "upcoming") {
	      upcomingAutoScrollRef.current = false;
      upcomingPendingDetailDateRef.current = null;
	      return;
	    }
	    if (upcomingView !== "details") return;
	    if (upcomingAutoScrollRef.current) return;
    const targetDate = upcomingPendingDetailDateRef.current ?? upcomingListDate;
    upcomingPendingDetailDateRef.current = null;
    if (targetDate && scrollUpcomingToDate(targetDate, "auto")) {
      upcomingAutoScrollRef.current = true;
      return;
    }
    if (scrollUpcomingToToday("auto")) {
	      upcomingAutoScrollRef.current = true;
	    }
	  }, [activePage, scrollUpcomingToDate, scrollUpcomingToToday, upcomingListDate, upcomingView]);

  useEffect(() => {
    if (activePage !== "boards" && activePage !== "upcoming") return;
    if (activePage === "upcoming" && upcomingAutoScrollRef.current) return;
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
  const reminderPayloadRef = useRef<string | null>(null);

  useEffect(() => {
    const pushPrefs = settings.pushNotifications;
    if (!pushPrefs?.enabled || !pushPrefs.deviceId || !pushPrefs.subscriptionId) {
      reminderPayloadRef.current = null;
      return;
    }
    if (!workerBaseUrl) {
      return;
    }

    const remindersPayload = reminderSyncItems
      .map((item) => ({
        taskId: item.taskId,
        boardId: item.boardId,
        dueISO: item.dueISO,
        title: item.title,
        minutesBefore: (item.reminders ?? []).map(reminderPresetToMinutes).sort((a, b) => a - b),
      }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId));
    const payloadString = JSON.stringify(remindersPayload);
    if (reminderPayloadRef.current === payloadString) return;
    reminderPayloadRef.current = payloadString;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      syncRemindersToWorker(workerBaseUrl, pushPrefs, reminderSyncItems, { signal: controller.signal }).catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Reminder sync failed', err);
        setPushError(err instanceof Error ? err.message : 'Failed to sync reminders');
      });
    }, 400);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [reminderSyncItems, settings.pushNotifications, workerBaseUrl]);

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

  // --------- Nostr helpers
  const isShared = (board: Board) => !!board.nostr?.boardId;
  const getBoardRelays = useCallback((board: Board): string[] => {
    const fallback = (defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS))
      .map((relay) => relay.trim())
      .filter(Boolean);
    const candidate = (board.nostr?.relays?.length ? board.nostr!.relays : fallback)
      .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
      .filter(Boolean);
    return candidate.length ? candidate : fallback;
  }, [defaultRelays]);
  function markTaskRelayPublishPending(taskId: string, board: Board | null | undefined): number | null {
    if (!taskId || !board?.nostr?.boardId) return null;
    const bTag = boardTag(board.nostr.boardId);
    if (!nostrIdxRef.current.taskClock.has(bTag)) {
      nostrIdxRef.current.taskClock.set(bTag, new Map());
    }
    const taskClock = nostrIdxRef.current.taskClock.get(bTag)!;
    const persistedTaskAt = tasksRef.current.find((task) => (
      task.id === taskId &&
      (task.boardId === board.id || task.boardId === board.nostr?.boardId)
    ))?._nostrAt ?? 0;
    const current = Math.max(taskClock.get(taskId) ?? 0, persistedTaskAt);
    const optimisticAt = reserveTaskMutationTimestamp(Math.floor(Date.now() / 1000), current);
    taskClock.set(taskId, optimisticAt);
    pendingNostrTasksRef.current.add(`${bTag}::${taskId}`);
    markNostrTaskSyncPending(taskId);
    return optimisticAt;
  }
  async function publishBoardMetadata(board: Board) {
    if (!board.nostr?.boardId) return;
    const relays = getBoardRelays(board);
    const boardKeys = await deriveBoardNostrKeys(board.nostr.boardId);
    const idTag = boardTag(board.nostr.boardId);
    const tags: string[][] = [["d", idTag],["b", idTag],["k", board.kind],["name", board.name]];
    const payload: any = { clearCompletedDisabled: !!board.clearCompletedDisabled };
    if (board.kind === "lists") {
      payload.columns = board.columns;
      payload.listIndex = !!board.indexCardEnabled;
    } else if (board.kind === "compound") {
      const childBoardIds = board.children
        .map((childId) => {
          const child = findBoardByCompoundChildId(boardsRef.current, childId);
          const canonicalId = child?.nostr?.boardId || child?.id || childId;
          return typeof canonicalId === "string" ? canonicalId : "";
        })
        .filter((childId) => !!childId);
      payload.children = childBoardIds;
      payload.listIndex = !!board.indexCardEnabled;
      payload.hideBoardNames = !!board.hideChildBoardNames;
    }
    const raw = JSON.stringify(payload);
    const content = await encryptToBoard(board.nostr.boardId, raw);
    const createdAt = await nostrPublish(relays, {
      kind: 30300,
      tags,
      content,
      created_at: Math.floor(Date.now() / 1000),
    }, { sk: boardKeys.sk });
    nostrIdxRef.current.boardMeta.set(idTag, createdAt);
  }
  publishBoardMetadataRef.current = publishBoardMetadata;
  async function publishBoardMetadataSnapshot(board: Board, boardId: string, relays: string[]) {
    if (!boardId || !relays.length) return;
    const boardKeys = await deriveBoardNostrKeys(boardId);
    const idTag = boardTag(boardId);
    const tags: string[][] = [["d", idTag], ["b", idTag], ["k", board.kind], ["name", board.name]];
    const payload: any = { clearCompletedDisabled: !!board.clearCompletedDisabled };
    if (board.kind === "lists") {
      payload.columns = board.columns;
      payload.listIndex = !!board.indexCardEnabled;
    } else if (board.kind === "compound") {
      const childBoardIds = board.children
        .map((childId) => {
          const child = findBoardByCompoundChildId(boardsRef.current, childId);
          const canonicalId = child?.nostr?.boardId || child?.id || childId;
          return typeof canonicalId === "string" ? canonicalId : "";
        })
        .filter((childId) => !!childId);
      payload.children = childBoardIds;
      payload.listIndex = !!board.indexCardEnabled;
      payload.hideBoardNames = !!board.hideChildBoardNames;
    }
    const raw = JSON.stringify(payload);
    const content = await encryptToBoard(boardId, raw);
    await nostrPublish(relays, {
      kind: 30300,
      tags,
      content,
      created_at: Math.floor(Date.now() / 1000),
    }, { sk: boardKeys.sk });
  }
  publishBoardMetadataSnapshotRef.current = publishBoardMetadataSnapshot;
  async function publishTaskDeletionRequest(boardKeys: BoardNostrKeyPair, relays: string[], taskId: string) {
    const aTag = `30301:${boardKeys.pk}:${taskId}`;
    try {
      await nostrPublish(relays, {
        kind: 5,
        tags: [["a", aTag], ["k", "30301"]],
        content: "Task deleted",
        created_at: Math.floor(Date.now() / 1000),
      }, { sk: boardKeys.sk });
    } catch (err) {
      console.warn("Failed to publish nostr deletion", err);
    }
  }
  async function publishTaskDeleted(t: Task) {
    const b = findBoardByCompoundChildId(boards, t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const bTag = boardTag(boardId);
    const pendingKey = `${bTag}::${t.id}`;
    const publishVersion = taskPublishVersionsRef.current.reserve(pendingKey);
    // Protect against stale relay events re-creating the task while the
    // deletion publish is in-flight.
    const optimisticAt = markTaskRelayPublishPending(t.id, b) ?? Math.floor(Date.now() / 1000);
    // Persist a tombstone NOW — before any await — so a reload between this
    // point and a successful relay publish still keeps the deletion sticky.
    // Without this, a failed/in-flight publish followed by reload would let
    // the original CREATE event from the relay re-add the task on next sync.
    recordTaskTombstone(bTag, t.id, optimisticAt);
    try {
      const boardKeys = await deriveBoardNostrKeys(boardId);
      if (!taskPublishVersionsRef.current.isCurrent(pendingKey, publishVersion)) return;
      await publishBoardMetadata(b);
      const colTag = (b.kind === "week") ? "day" : (t.columnId || "");
      const tags: string[][] = [["d", t.id],["b", bTag],["col", String(colTag)],["status","deleted"]];
      const raw = JSON.stringify({
        title: t.title,
        priority: t.priority ?? null,
        note: t.note || "",
        dueISO: t.dueISO,
        dueDateEnabled: t.dueDateEnabled,
        dueTimeEnabled: t.dueTimeEnabled,
        dueTimeZone: t.dueTimeZone,
        completedAt: t.completedAt,
        recurrence: t.recurrence,
        hiddenUntilISO: t.hiddenUntilISO,
        streak: t.streak,
        longestStreak: t.longestStreak,
        subtasks: t.subtasks,
        assignees: t.assignees,
        seriesId: t.seriesId,
        documents: t.documents,
        inboxItem: t.inboxItem ?? null,
      });
      const content = await encryptToBoard(boardId, raw);
      if (!taskPublishVersionsRef.current.isCurrent(pendingKey, publishVersion)) return;
      const createdAt = await nostrPublish(relays, {
        kind: 30301,
        tags,
        content,
        created_at: optimisticAt,
      }, { sk: boardKeys.sk });
      await publishTaskDeletionRequest(boardKeys, relays, t.id);
      if (!nostrIdxRef.current.taskClock.has(bTag)) {
        nostrIdxRef.current.taskClock.set(bTag, new Map());
      }
      const taskClock = nostrIdxRef.current.taskClock.get(bTag)!;
      taskClock.set(t.id, Math.max(taskClock.get(t.id) ?? 0, createdAt));
      // Bump the tombstone to the actual relay-confirmed timestamp so any
      // post-reload comparisons use the same clock value the relay will
      // report when it round-trips this deletion.
      recordTaskTombstone(bTag, t.id, createdAt);
    } finally {
      if (taskPublishVersionsRef.current.finish(pendingKey, publishVersion)) {
        pendingNostrTasksRef.current.delete(pendingKey);
        clearOptimisticNostrTaskSyncPending(t.id);
      }
    }
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

  const sameStringList = (a?: string[], b?: string[]) => {
    const aa = a ?? [];
    const bb = b ?? [];
    if (aa.length !== bb.length) return false;
    return aa.every((value, index) => value === bb[index]);
  };

  const sameDocumentList = (a?: TaskDocument[], b?: TaskDocument[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

  const taskWithPreparedAttachments = (
    task: Task,
    prepared: { images: string[] | null; documents: any[] | null },
  ): Task => ({
    ...task,
    ...(prepared.images === null ? {} : { images: prepared.images.length ? prepared.images : undefined }),
    ...(prepared.documents === null ? {} : { documents: prepared.documents.length ? prepared.documents as TaskDocument[] : undefined }),
  });

  const calendarEventWithPreparedAttachments = (
    event: CalendarEvent,
    prepared: { image: string | null; documents: any[] | null },
  ): CalendarEvent => ({
    ...event,
    ...(prepared.image === null ? {} : { image: prepared.image || undefined }),
    ...(prepared.documents === null ? {} : { documents: prepared.documents.length ? prepared.documents as TaskDocument[] : undefined }),
  });

  async function maybePublishTask(
    t: Task,
    boardOverride?: Board,
    options?: { skipBoardMetadata?: boolean }
  ) {
    const b = boardOverride || findBoardByCompoundChildId(boards, t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const bTag = boardTag(boardId);
    const pendingKey = `${bTag}::${t.id}`;
    const publishVersion = taskPublishVersionsRef.current.reserve(pendingKey);
    // Protect optimistic state: advance the task clock and mark pending BEFORE
    // any async work so relay events arriving while the publish is in-flight
    // are rejected by the clock check in applyTaskEvent / flushRelayBatch.
    const optimisticAt = markTaskRelayPublishPending(t.id, b) ?? Math.floor(Date.now() / 1000);
    t._nostrAt = optimisticAt;
    const boardKeys = await deriveBoardNostrKeys(boardId);
    const status = t.completed ? "done" : "open";
    const colTag = (b.kind === "week") ? "day" : (t.columnId || "");
    const tags: string[][] = [["d", t.id],["b", bTag],["col", String(colTag)],["status", status]];
    const normalizedBounty = normalizeBounty(t.bounty);
    const createdBy = normalizeAgentPubkey(t.createdBy) ?? undefined;
    const lastEditedBy = normalizeAgentPubkey(t.lastEditedBy || nostrPK || t.createdBy) ?? createdBy;
    const body: any = {
      title: t.title,
      priority: t.priority ?? null,
      note: t.note || "",
      dueISO: t.dueISO,
      completedAt: t.completedAt,
      completedBy: t.completedBy,
      recurrence: t.recurrence,
      hiddenUntilISO: t.hiddenUntilISO,
      createdBy,
      lastEditedBy,
      createdAt: t.createdAt ?? null,
      streak: t.streak,
      longestStreak: t.longestStreak,
      seriesId: t.seriesId,
    };
    body.dueDateEnabled = typeof t.dueDateEnabled === "boolean" ? t.dueDateEnabled : null;
    body.dueTimeEnabled = typeof t.dueTimeEnabled === 'boolean' ? t.dueTimeEnabled : null;
    body.dueTimeZone = typeof t.dueTimeZone === "string" ? t.dueTimeZone : null;
    // Reminders are device-specific and should not be published to shared boards.
    // Include explicit nulls to signal removals when undefined.
    // Attachments are encrypted+uploaded to the file server before publishing.
    const preparedAttachments = await prepareAttachmentsForPublish({
      images: t.images,
      documents: t.documents,
      boardId,
    });
    const taskForPublish = taskWithPreparedAttachments(t, preparedAttachments);
    body.images = preparedAttachments.images;
    body.documents = preparedAttachments.documents;
    body.bounty = (typeof t.bounty === 'undefined') ? null : (normalizedBounty ?? null);
    body.subtasks = (typeof t.subtasks === 'undefined') ? null : t.subtasks;
    body.assignees = (typeof t.assignees === "undefined") ? null : t.assignees;
    body.inboxItem = typeof t.inboxItem === "undefined" ? null : t.inboxItem ?? null;
    try {
      if (!taskPublishVersionsRef.current.isCurrent(pendingKey, publishVersion)) return;
      if (!options?.skipBoardMetadata) {
        await publishBoardMetadata(b);
      }
      const raw = JSON.stringify(body);
      const content = await encryptToBoard(boardId, raw);
      if (!taskPublishVersionsRef.current.isCurrent(pendingKey, publishVersion)) return;
      const createdAt = await nostrPublish(relays, {
        kind: 30301,
        tags,
        content,
        created_at: optimisticAt,
      }, { sk: boardKeys.sk });
      // Update local task clock so immediate refreshes don't revert state
      if (!nostrIdxRef.current.taskClock.has(bTag)) {
        nostrIdxRef.current.taskClock.set(bTag, new Map());
      }
      const taskClock = nostrIdxRef.current.taskClock.get(bTag)!;
      const confirmedAt = Math.max(taskClock.get(t.id) ?? 0, createdAt);
      taskClock.set(t.id, confirmedAt);
      t._nostrAt = Math.max(t._nostrAt ?? 0, confirmedAt);
      if (!sameStringList(taskForPublish.images, t.images) || !sameDocumentList(taskForPublish.documents, t.documents)) {
        setTasks((prev) =>
          prev.map((current) => {
            if (current.id !== t.id || current.boardId !== t.boardId) return current;
            let changed = false;
            const next: Task = { ...current };
            if (preparedAttachments.images !== null && sameStringList(current.images, t.images)) {
              next.images = taskForPublish.images;
              changed = true;
            }
            if (preparedAttachments.documents !== null && sameDocumentList(current.documents, t.documents)) {
              next.documents = taskForPublish.documents;
              changed = true;
            }
            return changed ? next : current;
          }),
        );
      }
    } finally {
      if (taskPublishVersionsRef.current.finish(pendingKey, publishVersion)) {
        pendingNostrTasksRef.current.delete(pendingKey);
        clearOptimisticNostrTaskSyncPending(t.id);
      }
    }
  }

  maybePublishTaskRef.current = maybePublishTask;

  const isDateKey = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const addDaysToDateKey = (dateKey: string, delta: number): string | null => {
    const parsed = parseDateKey(dateKey);
    if (!parsed) return null;
    const base = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
    if (Number.isNaN(base.getTime())) return null;
    base.setUTCDate(base.getUTCDate() + delta);
    return formatDateKeyFromParts(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
  };
  const resolveCalendarEventPublishBoard = (event: CalendarEvent, boardOverride?: Board): Board | null => {
    const targetId = event.originBoardId ?? event.boardId;
    if (boardOverride && boardOverride.id === targetId) return boardOverride;
    return boards.find((x) => x.id === targetId) ?? null;
  };

  const normalizeInvitePubkeys = (event: CalendarEvent, extraPubkeys?: string[]) => {
    const normalized: string[] = [];
    const seen = new Set<string>();
    (event.participants ?? []).forEach((participant) => {
      const pubkey = normalizeNostrPubkeyHex(participant.pubkey);
      if (!pubkey || seen.has(pubkey)) return;
      seen.add(pubkey);
      normalized.push(pubkey);
    });
    (extraPubkeys ?? []).forEach((candidate) => {
      const pubkey = normalizeNostrPubkeyHex(candidate);
      if (!pubkey || seen.has(pubkey)) return;
      seen.add(pubkey);
      normalized.push(pubkey);
    });
    return normalized;
  };

  const mergeInviteTokens = (event: CalendarEvent, extraPubkeys?: string[]) => {
    const eventKey = event.eventKey || generateEventKey();
    const existing = event.inviteTokens ?? {};
    const recipients = normalizeInvitePubkeys(event, extraPubkeys);
    const nextTokens: Record<string, string> = {};
    recipients.forEach((pubkey) => {
      nextTokens[pubkey] = existing[pubkey] || generateInviteToken();
    });
    const existingKeys = Object.keys(existing);
    const nextKeys = Object.keys(nextTokens);
    let changed = eventKey !== event.eventKey || existingKeys.length !== nextKeys.length;
    if (!changed) {
      for (const key of nextKeys) {
        if (existing[key] !== nextTokens[key]) {
          changed = true;
          break;
        }
      }
    }
    return {
      eventKey,
      inviteTokens: nextKeys.length ? nextTokens : undefined,
      changed,
    };
  };

  const buildCanonicalCalendarPayload = async (
    event: CalendarEvent,
    options?: {
      deleted?: boolean;
      boardId?: string;
      preparedAttachments?: { image: string | null; documents: any[] | null };
    },
  ) => {
    const eventKey = event.eventKey || generateEventKey();
    const deleted = !!options?.deleted;
    const createdBy = normalizeAgentPubkey(event.createdBy || nostrPK) ?? undefined;
    const lastEditedBy = normalizeAgentPubkey(event.lastEditedBy || nostrPK || createdBy) ?? createdBy;
    const base: any = {
      v: 1,
      eventId: event.id,
      eventKey,
      ...(deleted ? { deleted: true } : {}),
    };
    if (createdBy) base.createdBy = createdBy;
    if (lastEditedBy) base.lastEditedBy = lastEditedBy;
    Object.assign(base, calendarRecurrenceSyncFields(event));
    const normalized = deleted
      ? normalizeCalendarDeleteMutationPayload(
          {
            title: event.title || "Untitled",
            kind: event.kind,
            startDate: event.kind === "date" ? event.startDate : undefined,
            endDate: event.kind === "date" ? event.endDate : undefined,
            startISO: event.kind === "time" ? event.startISO : undefined,
            endISO: event.kind === "time" ? event.endISO : undefined,
            startTzid: event.kind === "time" ? event.startTzid : undefined,
            endTzid: event.kind === "time" ? event.endTzid : undefined,
            description: event.description,
          },
          Date.now(),
        )
      : normalizeCalendarMutationPayload(
          {
            title: event.title || "Untitled",
            kind: event.kind,
            startDate: event.kind === "date" ? event.startDate : undefined,
            endDate: event.kind === "date" ? event.endDate : undefined,
            startISO: event.kind === "time" ? event.startISO : undefined,
            endISO: event.kind === "time" ? event.endISO : undefined,
            startTzid: event.kind === "time" ? event.startTzid : undefined,
            endTzid: event.kind === "time" ? event.endTzid : undefined,
            description: event.description,
          },
          Date.now(),
        );
    if (!normalized) return null;
    if (deleted) return base;

    base.kind = normalized.kind;
    base.title = normalized.title || "Untitled";
    if (event.summary) base.summary = event.summary;
    if (event.description) base.description = event.description;
    if (event.documents?.length) {
      const documents = options?.preparedAttachments?.documents ?? event.documents;
      if (documents?.length) base.documents = documents;
    }
    const preparedImage = options?.preparedAttachments?.image;
    const publishImage = preparedImage === null || typeof preparedImage === "undefined" ? event.image : preparedImage;
    if (publishImage) base.image = publishImage;
    if (event.locations?.length) base.locations = event.locations;
    if (event.geohash) base.geohash = event.geohash;
    if (event.participants?.length) base.participants = event.participants;
    if (event.hashtags?.length) base.hashtags = event.hashtags;
    if (event.references?.length) base.references = event.references;
    if (event.inviteTokens && Object.keys(event.inviteTokens).length) base.inviteTokens = event.inviteTokens;

    if (normalized.kind === "date") {
      if (!normalized.startDate) return null;
      base.startDate = normalized.startDate;
      if (normalized.endDate) base.endDate = normalized.endDate;
      return base;
    }

    if (!normalized.startISO) return null;
    base.startISO = normalized.startISO;
    if (normalized.endISO) base.endISO = normalized.endISO;
    if (normalized.startTzid) base.startTzid = normalized.startTzid;
    if (normalized.endTzid) base.endTzid = normalized.endTzid;
    return base;
  };

  const buildViewCalendarPayload = async (
    event: CalendarEvent,
    options?: {
      deleted?: boolean;
      boardId?: string;
      preparedAttachments?: { image: string | null; documents: any[] | null };
    },
  ) => {
    const deleted = !!options?.deleted;
    const createdBy = normalizeAgentPubkey(event.createdBy || nostrPK) ?? undefined;
    const lastEditedBy = normalizeAgentPubkey(event.lastEditedBy || nostrPK || createdBy) ?? createdBy;
    const base: any = {
      v: 1,
      eventId: event.id,
      ...(deleted ? { deleted: true } : {}),
    };
    if (createdBy) base.createdBy = createdBy;
    if (lastEditedBy) base.lastEditedBy = lastEditedBy;
    Object.assign(base, calendarRecurrenceSyncFields(event));
    const normalized = deleted
      ? normalizeCalendarDeleteMutationPayload(
          {
            title: event.title || "Untitled",
            kind: event.kind,
            startDate: event.kind === "date" ? event.startDate : undefined,
            endDate: event.kind === "date" ? event.endDate : undefined,
            startISO: event.kind === "time" ? event.startISO : undefined,
            endISO: event.kind === "time" ? event.endISO : undefined,
            startTzid: event.kind === "time" ? event.startTzid : undefined,
            endTzid: event.kind === "time" ? event.endTzid : undefined,
            description: event.description,
          },
          Date.now(),
        )
      : normalizeCalendarMutationPayload(
          {
            title: event.title || "Untitled",
            kind: event.kind,
            startDate: event.kind === "date" ? event.startDate : undefined,
            endDate: event.kind === "date" ? event.endDate : undefined,
            startISO: event.kind === "time" ? event.startISO : undefined,
            endISO: event.kind === "time" ? event.endISO : undefined,
            startTzid: event.kind === "time" ? event.startTzid : undefined,
            endTzid: event.kind === "time" ? event.endTzid : undefined,
            description: event.description,
          },
          Date.now(),
        );
    if (!normalized) return null;
    if (deleted) return base;

    base.kind = normalized.kind;
    base.title = normalized.title || "Untitled";
    if (event.summary) base.summary = event.summary;
    if (event.description) base.description = event.description;
    if (event.documents?.length) {
      const documents = options?.preparedAttachments?.documents ?? event.documents;
      if (documents?.length) base.documents = documents;
    }
    const preparedImage = options?.preparedAttachments?.image;
    const publishImage = preparedImage === null || typeof preparedImage === "undefined" ? event.image : preparedImage;
    if (publishImage) base.image = publishImage;
    if (event.locations?.length) base.locations = event.locations;
    if (event.geohash) base.geohash = event.geohash;
    if (event.hashtags?.length) base.hashtags = event.hashtags;
    if (event.references?.length) base.references = event.references;

    if (normalized.kind === "date") {
      if (!normalized.startDate) return null;
      base.startDate = normalized.startDate;
      if (normalized.endDate) base.endDate = normalized.endDate;
      return base;
    }

    if (!normalized.startISO) return null;
    base.startISO = normalized.startISO;
    if (normalized.endISO) base.endISO = normalized.endISO;
    if (normalized.startTzid) base.startTzid = normalized.startTzid;
    if (normalized.endTzid) base.endTzid = normalized.endTzid;
    return base;
  };

  async function publishCalendarEventDeleted(event: CalendarEvent) {
    if (event.readOnly) return;
    const creator = normalizeAgentPubkey(event.createdBy || nostrPK) ?? undefined;
    const editor = normalizeAgentPubkey(event.lastEditedBy || nostrPK || creator) ?? creator;
    const eventForPublish: CalendarEvent = {
      ...event,
      ...(creator ? { createdBy: creator } : {}),
      ...(editor ? { lastEditedBy: editor } : {}),
    };
    const b = resolveCalendarEventPublishBoard(event);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const boardKeys = await deriveBoardNostrKeys(boardId);
    const bTag = boardTag(boardId);
    const pendingKey = `${bTag}::${event.id}`;
    markNostrCalendarEventSyncPending(event.id);
    pendingNostrCalendarRef.current.add(pendingKey);
    try {
      await publishBoardMetadata(b);
      const { eventKey, inviteTokens, changed } = mergeInviteTokens(eventForPublish);
      const updatedEvent = changed ? { ...eventForPublish, eventKey, inviteTokens } : eventForPublish;
      if (changed) {
        setCalendarEvents((prev) => prev.map((ev) => (ev.id === event.id ? updatedEvent : ev)));
      }
      const canonicalPayload = await buildCanonicalCalendarPayload(updatedEvent, { deleted: true, boardId });
      const viewPayload = await buildViewCalendarPayload(updatedEvent, { deleted: true, boardId });
      if (!canonicalPayload || !viewPayload) return;
      const canonicalContent = await encryptCalendarPayloadForBoard(
        canonicalPayload,
        boardKeys.skHex,
        boardKeys.pk,
      );
      const canonicalTags: string[][] = [["d", event.id], ["b", bTag]];
      if (updatedEvent.columnId) canonicalTags.push(["col", updatedEvent.columnId]);
      if (typeof updatedEvent.order === "number" && Number.isFinite(updatedEvent.order)) {
        canonicalTags.push(["order", String(updatedEvent.order)]);
      }
      const createdAt = await nostrPublish(relays, {
        kind: TASKIFY_CALENDAR_EVENT_KIND,
        tags: canonicalTags,
        content: canonicalContent,
        created_at: Math.floor(Date.now() / 1000),
      }, { sk: boardKeys.sk });
      const canonicalAddr = calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, eventForPublish.id);
      const viewContent = await encryptCalendarPayloadWithEventKey(viewPayload, eventKey);
      await nostrPublish(relays, {
        kind: TASKIFY_CALENDAR_VIEW_KIND,
        tags: [["d", event.id], ["a", canonicalAddr]],
        content: viewContent,
        created_at: Math.floor(Date.now() / 1000),
      }, { sk: boardKeys.sk });
      if (!nostrIdxRef.current.calendarClock.has(bTag)) {
        nostrIdxRef.current.calendarClock.set(bTag, new Map());
      }
      nostrIdxRef.current.calendarClock.get(bTag)!.set(eventForPublish.id, createdAt);
    } finally {
      pendingNostrCalendarRef.current.delete(pendingKey);
      clearOptimisticNostrCalendarEventSyncPending(event.id);
    }
  }
  publishCalendarEventDeletedRef.current = publishCalendarEventDeleted;

  async function maybePublishCalendarEvent(
    event: CalendarEvent,
    boardOverride?: Board,
    options?: { skipBoardMetadata?: boolean },
  ) {
    if (event.readOnly) return;
    const creator = normalizeAgentPubkey(event.createdBy || nostrPK) ?? undefined;
    const editor = normalizeAgentPubkey(event.lastEditedBy || nostrPK || creator) ?? creator;
    const eventForPublish: CalendarEvent = {
      ...event,
      ...(creator ? { createdBy: creator } : {}),
      ...(editor ? { lastEditedBy: editor } : {}),
    };
    const b = resolveCalendarEventPublishBoard(event, boardOverride);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const boardKeys = await deriveBoardNostrKeys(boardId);
    const bTag = boardTag(boardId);
    const pendingKey = `${bTag}::${event.id}`;
    markNostrCalendarEventSyncPending(event.id);
    pendingNostrCalendarRef.current.add(pendingKey);
    try {
      if (!options?.skipBoardMetadata) {
        await publishBoardMetadata(b);
      }

      const mergedSecrets = mergeInviteTokens(eventForPublish);
      const updatedEvent = mergedSecrets.changed
        ? { ...eventForPublish, eventKey: mergedSecrets.eventKey, inviteTokens: mergedSecrets.inviteTokens }
        : eventForPublish;
      if (mergedSecrets.changed) {
        setCalendarEvents((prev) => prev.map((ev) => (ev.id === event.id ? updatedEvent : ev)));
      }

      const preparedAttachments = await prepareAttachmentsForPublish({
        boardId,
        documents: updatedEvent.documents,
        image: updatedEvent.image,
      });
      const eventWithPreparedAttachments = calendarEventWithPreparedAttachments(updatedEvent, preparedAttachments);

      const canonicalPayload = await buildCanonicalCalendarPayload(eventWithPreparedAttachments, { boardId, preparedAttachments });
      if (!canonicalPayload) return;
      const viewPayload = await buildViewCalendarPayload(eventWithPreparedAttachments, { boardId, preparedAttachments });
      if (!viewPayload) return;
      const canonicalContent = await encryptCalendarPayloadForBoard(
        canonicalPayload,
        boardKeys.skHex,
        boardKeys.pk,
      );
      const colTag = b.kind === "week" ? "day" : (updatedEvent.columnId || "");
      const canonicalTags: string[][] = [["d", updatedEvent.id], ["b", bTag]];
      if (colTag) canonicalTags.push(["col", colTag]);
      if (typeof updatedEvent.order === "number" && Number.isFinite(updatedEvent.order)) {
        canonicalTags.push(["order", String(updatedEvent.order)]);
      }
      const createdAt = await nostrPublish(relays, {
        kind: TASKIFY_CALENDAR_EVENT_KIND,
        tags: canonicalTags,
        content: canonicalContent,
        created_at: Math.floor(Date.now() / 1000),
      }, { sk: boardKeys.sk });
      const canonicalAddr = calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, updatedEvent.id);
      const viewContent = await encryptCalendarPayloadWithEventKey(viewPayload, mergedSecrets.eventKey);
      await nostrPublish(relays, {
        kind: TASKIFY_CALENDAR_VIEW_KIND,
        tags: [["d", updatedEvent.id], ["a", canonicalAddr]],
        content: viewContent,
        created_at: Math.floor(Date.now() / 1000),
      }, { sk: boardKeys.sk });
      if (!nostrIdxRef.current.calendarClock.has(bTag)) {
        nostrIdxRef.current.calendarClock.set(bTag, new Map());
      }
      nostrIdxRef.current.calendarClock.get(bTag)!.set(updatedEvent.id, createdAt);
      if (
        eventWithPreparedAttachments.image !== updatedEvent.image ||
        !sameDocumentList(eventWithPreparedAttachments.documents, updatedEvent.documents)
      ) {
        setCalendarEvents((prev) =>
          prev.map((current) => {
            if (current.id !== updatedEvent.id) return current;
            let changed = false;
            let next: CalendarEvent = current;
            if (preparedAttachments.image !== null && current.image === updatedEvent.image) {
              next = { ...next, image: eventWithPreparedAttachments.image };
              changed = true;
            }
            if (preparedAttachments.documents !== null && sameDocumentList(current.documents, updatedEvent.documents)) {
              next = { ...next, documents: eventWithPreparedAttachments.documents };
              changed = true;
            }
            return changed ? next : current;
          }),
        );
      }
    } finally {
      pendingNostrCalendarRef.current.delete(pendingKey);
      clearOptimisticNostrCalendarEventSyncPending(event.id);
    }
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
    const last = nostrIdxRef.current.boardMeta.get(d) || 0;
    if (ev.created_at < last) return;
    // Accept events with the same timestamp to avoid missing updates
    nostrIdxRef.current.boardMeta.set(d, ev.created_at);
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
    if (!nostrIdxRef.current.taskClock.has(bTag)) nostrIdxRef.current.taskClock.set(bTag, new Map());
    const m = nostrIdxRef.current.taskClock.get(bTag)!;
    const last = m.get(taskId) || 0;
    const pendingKey = `${bTag}::${taskId}`;
    const isPending = pendingNostrTasksRef.current.has(pendingKey);
    if (ev.created_at < last) return;
    if (ev.created_at === last && isPending) return;
    // Accept equal timestamps so rapid consecutive updates still apply
    m.set(taskId, ev.created_at);
    // Advance the in-memory cursor for this board so we know the high-water mark.
    // Key by bTag (SHA256 of nostrBoardId) — must match the lookup in the
    // subscription setup where it.id = boardTag(b.nostr!.boardId) = bTag.
    // Also persist incrementally every 100 events: if the app crashes before EOSE
    // the cursor survives and the next open re-fetches only unprocessed events.
    if (typeof ev.created_at === "number" && Number.isFinite(ev.created_at)) {
      const prev = boardSyncCursorsRef.current[bTag] ?? 0;
      if (ev.created_at > prev) {
        boardSyncCursorsRef.current = { ...boardSyncCursorsRef.current, [bTag]: ev.created_at };
        const clock = nostrIdxRef.current.taskClock.get(bTag);
        if (clock && clock.size % 100 === 0) {
          try {
            idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS, JSON.stringify(boardSyncCursorsRef.current));
          } catch { /* non-fatal */ }
        }
      }
    }

    const status = tagValue(ev, "status");
    const col = tagValue(ev, "col");
    const eventCreatedAt = typeof ev.created_at === "number" ? ev.created_at * 1000 : undefined;
    const hasDueTimeField = Object.prototype.hasOwnProperty.call(payload, 'dueTimeEnabled');
    const incomingDueTime = hasDueTimeField
      ? (payload.dueTimeEnabled === null ? undefined : typeof payload.dueTimeEnabled === 'boolean' ? payload.dueTimeEnabled : undefined)
      : undefined;
    const hasDueTimeZoneField = Object.prototype.hasOwnProperty.call(payload, 'dueTimeZone');
    const incomingDueTimeZone = hasDueTimeZoneField
      ? (typeof payload.dueTimeZone === "string" ? normalizeTimeZone(payload.dueTimeZone) ?? undefined : undefined)
      : undefined;
    const hasDueDateField = Object.prototype.hasOwnProperty.call(payload, 'dueDateEnabled');
    const incomingDueDateEnabled = hasDueDateField
      ? (payload.dueDateEnabled === null ? undefined : typeof payload.dueDateEnabled === 'boolean' ? payload.dueDateEnabled : undefined)
      : undefined;
    const hasPriorityField = Object.prototype.hasOwnProperty.call(payload, 'priority');
    const incomingPriority = hasPriorityField
      ? (payload.priority === null ? undefined : normalizeTaskPriority(payload.priority))
      : undefined;
    const hasAssigneesField = Object.prototype.hasOwnProperty.call(payload, "assignees");
    const incomingAssignees: TaskAssignee[] | null | undefined = hasAssigneesField
      ? (payload.assignees === null ? null : normalizeTaskAssignees(payload.assignees))
      : undefined;
    const incomingCreatedAt = normalizeTaskCreatedAt(payload.createdAt) ?? eventCreatedAt;
    const incomingCreatedBy = normalizeAgentPubkey(payload.createdBy);
    const incomingLastEditedBy = normalizeAgentPubkey(payload.lastEditedBy) ?? incomingCreatedBy;
    // Reminders remain device-local, so ignore any reminder payloads from shared updates.
      const base: Task = {
        id: taskId,
        boardId: lb.id,
        ...(incomingCreatedBy ? { createdBy: incomingCreatedBy } : {}),
        ...(incomingLastEditedBy ? { lastEditedBy: incomingLastEditedBy } : {}),
        createdAt: incomingCreatedAt,
        title: payload.title || "Untitled",
        note: payload.note || "",
      dueISO: payload.dueISO || isoForToday(),
      completed: status === "done",
      completedAt: payload.completedAt,
      completedBy: payload.completedBy,
      recurrence: normalizeTaskRecurrence(payload.recurrence) as Recurrence | undefined,
      hiddenUntilISO: payload.hiddenUntilISO,
      streak: typeof payload.streak === 'number' ? payload.streak : undefined,
      longestStreak: typeof payload.longestStreak === 'number' ? payload.longestStreak : undefined,
      seriesId: payload.seriesId,
      subtasks: Array.isArray(payload.subtasks) ? payload.subtasks : undefined,
    };
    if (hasPriorityField) base.priority = incomingPriority;
    if (hasDueDateField) base.dueDateEnabled = incomingDueDateEnabled;
    if (hasDueTimeField) base.dueTimeEnabled = incomingDueTime;
    if (hasDueTimeZoneField) base.dueTimeZone = incomingDueTimeZone;
    if (lb.kind === "week") {
      base.column = "day";
      if (col === "bounties") {
        base.bountyLists = [PINNED_BOUNTY_LIST_KEY];
      }
    }
    else if (lb.kind === "lists") base.columnId = col || (lb.columns[0]?.id || "");
    if (base.recurrence?.untilISO && !Number.isNaN(Date.parse(base.recurrence.untilISO))) {
      const seriesEndKey = isoDatePart(base.recurrence.untilISO, base.dueTimeZone);
      const occurrenceKey = isoDatePart(base.dueISO, base.dueTimeZone);
      if (seriesEndKey < occurrenceKey) {
        recordRecurringSeriesCutoff(base, base.recurrence.untilISO);
      }
    }
    // Key used for both the live setTasks path and the batch Map path.
    const taskKey = `${lb.id}::${taskId}`;

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
        // For merge fields that need prev (bounty, order, images, etc.),
        // use what's already in this relay's batch, falling back to base.
        const existing = batchMap.get(taskKey);
        const cur = existing && !('_deleted' in existing) ? existing as Task : undefined;
        const incomingB: Task["bounty"] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'bounty') ? payload.bounty : undefined;
        const incomingImgs: string[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'images') ? payload.images : undefined;
        const imgs = incomingImgs === undefined ? cur?.images : incomingImgs === null ? undefined : incomingImgs;
        let docs: TaskDocument[] | undefined = cur?.documents;
        if (Object.prototype.hasOwnProperty.call(payload, 'documents')) {
          const rawDocs = (payload as any).documents;
          docs = rawDocs === null ? undefined : (normalizeDocumentList(rawDocs)?.map(ensureDocumentPreview) ?? undefined);
        }
        const incomingStreak: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'streak') ? payload.streak : undefined;
        const st = incomingStreak === undefined ? cur?.streak : incomingStreak === null ? undefined : incomingStreak;
        const incomingLongest: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'longestStreak') ? payload.longestStreak : undefined;
        const longest = incomingLongest === undefined ? cur?.longestStreak : incomingLongest === null ? undefined : incomingLongest;
        const incomingSubs: Subtask[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'subtasks') ? payload.subtasks : undefined;
        const subs = incomingSubs === undefined ? cur?.subtasks : incomingSubs === null ? undefined : incomingSubs;
        const mergedAssignees = incomingAssignees === undefined ? cur?.assignees : incomingAssignees === null ? undefined : incomingAssignees;
        const normalizedIncoming = incomingB === null ? undefined : normalizeBounty(incomingB);
        batchMap.set(taskKey, {
          ...(cur ?? {}),
          ...base,
          order: cur?.order ?? 0,
          createdAt: cur?.createdAt ?? base.createdAt ?? Date.now(),
          images: imgs,
          documents: docs,
          bounty: normalizedIncoming ?? cur?.bounty,
          streak: st,
          longestStreak: longest,
          subtasks: subs,
          assignees: mergedAssignees,
          _nostrAt: ev.created_at,
        } as Task);
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
      const currentClock = nostrIdxRef.current.taskClock.get(bTag)?.get(taskId) || 0;
      const stillPending = pendingNostrTasksRef.current.has(pendingKey);
      if (ev.created_at < currentClock) return prev;
      if (ev.created_at === currentClock && stillPending) return prev;
      return ((prev: Task[]) => {
      const idx = prev.findIndex(x => x.id === taskId && x.boardId === lb.id);
      if (status === "deleted") {
        if (idx < 0) return prev;
        return dedupeRecurringInstances(prev.filter((_, i) => i !== idx));
      }
      // Improved bounty merge with clocks and auth; incoming may be null (explicit removal)
      const mergeBounty = (oldB?: Task["bounty"], incoming?: Task["bounty"] | null) => {
        if (incoming === null) return undefined; // explicit removal
        const normalizedIncoming = normalizeBounty(incoming);
        const normalizedOld = oldB ? normalizeBounty(oldB) : undefined;
        if (!normalizedIncoming) return normalizedOld;
        if (!normalizedOld) return normalizedIncoming;
        // Prefer the bounty with the latest updatedAt; fallback to event created_at
        const oldT = Date.parse(normalizedOld.updatedAt || '') || 0;
        const incT = Date.parse(normalizedIncoming.updatedAt || '') || 0;
        const incNewer = incT > oldT || (incT === oldT && ev.created_at > (nostrIdxRef.current.taskClock.get(bTag)?.get(taskId) || 0));

        // Different ids: pick the newer one
        if (normalizedOld.id !== normalizedIncoming.id) return incNewer ? normalizedIncoming : normalizedOld;

        const next = { ...normalizedOld } as NonNullable<Task["bounty"]>;
        // accept token/content updates if incoming is newer
        if (incNewer) {
          if (typeof normalizedIncoming.amount === 'number') next.amount = normalizedIncoming.amount;
          next.mint = normalizedIncoming.mint ?? next.mint;
          next.lock = normalizedIncoming.lock ?? next.lock;
          // Only overwrite token if sender/owner published or token becomes visible
          if (normalizedIncoming.token) next.token = normalizedIncoming.token;
          const hasEncField = Object.prototype.hasOwnProperty.call(incoming, 'enc');
          if (hasEncField) {
            next.enc = (incoming as any).enc ?? undefined;
          } else if (normalizedIncoming.token && !normalizedIncoming.enc) {
            next.enc = undefined;
          }
          if (normalizedIncoming.receiver) next.receiver = normalizedIncoming.receiver;
          next.updatedAt = normalizedIncoming.updatedAt || next.updatedAt;
        }
        // Auth for state transitions (allow owner or sender to unlock; owner or sender to revoke; anyone to mark claimed)
        if (normalizedIncoming.state && normalizedIncoming.state !== normalizedOld.state) {
          const isOwner = !!(normalizedOld.owner && ev.pubkey === normalizedOld.owner);
          const isSender = !!(normalizedOld.sender && ev.pubkey === normalizedOld.sender);
          const isReceiver = !!(normalizedOld.receiver && ev.pubkey === normalizedOld.receiver);
          if (normalizedIncoming.state === 'unlocked' && (isOwner || isSender || isReceiver)) next.state = 'unlocked';
          if (normalizedIncoming.state === 'revoked' && (isOwner || isSender)) next.state = 'revoked';
          if (normalizedIncoming.state === 'claimed') next.state = 'claimed';
        }
        return normalizeBounty(next);
      };

      if (idx >= 0) {
        const copy = prev.slice();
        const current = prev[idx];
        // Determine incoming bounty raw (preserve explicit null removal)
        const incomingB: Task["bounty"] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'bounty') ? payload.bounty : undefined;
        // Determine incoming images raw (allow explicit null removal)
        const incomingImgs: string[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'images') ? payload.images : undefined;
        const mergedImages = incomingImgs === undefined ? current.images : incomingImgs === null ? undefined : incomingImgs;
        let mergedDocuments: TaskDocument[] | undefined = current.documents;
        if (Object.prototype.hasOwnProperty.call(payload, 'documents')) {
          const rawDocs = (payload as any).documents;
          if (rawDocs === null) {
            mergedDocuments = undefined;
          } else {
            const normalizedDocs = normalizeDocumentList(rawDocs);
            mergedDocuments = normalizedDocs ? normalizedDocs.map(ensureDocumentPreview) : undefined;
          }
        }
        const newOrder =
          typeof current.order === "number"
            ? current.order
            : nextOrderForBoard(base.boardId, prev, settings.newTaskPosition);
        const newCreatedAt =
          typeof current.createdAt === "number"
            ? current.createdAt
            : base.createdAt ?? Date.now();
        const incomingStreak: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'streak') ? payload.streak : undefined;
        const newStreak = incomingStreak === undefined ? current.streak : incomingStreak === null ? undefined : incomingStreak;
        const incomingLongest: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'longestStreak') ? payload.longestStreak : undefined;
        const newLongest = incomingLongest === undefined
          ? current.longestStreak
          : incomingLongest === null
            ? undefined
            : incomingLongest;
        const incomingSubs: Subtask[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'subtasks') ? payload.subtasks : undefined;
        const mergedSubs = incomingSubs === undefined ? current.subtasks : incomingSubs === null ? undefined : incomingSubs;
        const mergedAssignees =
          incomingAssignees === undefined
            ? current.assignees
            : incomingAssignees === null
              ? undefined
              : incomingAssignees;
        copy[idx] = {
          ...current,
          ...base,
          order: newOrder,
          createdAt: newCreatedAt,
          images: mergedImages,
          documents: mergedDocuments,
          bounty: mergeBounty(current.bounty, incomingB as any),
          streak: newStreak,
          longestStreak: newLongest,
          subtasks: mergedSubs,
          assignees: mergedAssignees,
          _nostrAt: ev.created_at,
        };
        return dedupeRecurringInstances(copy);
      } else {
        const incomingB: Task["bounty"] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'bounty') ? payload.bounty : undefined;
        const incomingImgs: string[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'images') ? payload.images : undefined;
        const imgs = incomingImgs === null ? undefined : Array.isArray(incomingImgs) ? incomingImgs : undefined;
        let docs: TaskDocument[] | undefined;
        if (Object.prototype.hasOwnProperty.call(payload, 'documents')) {
          const rawDocs = (payload as any).documents;
          if (rawDocs === null) {
            docs = undefined;
          } else {
            const normalizedDocs = normalizeDocumentList(rawDocs);
            docs = normalizedDocs ? normalizedDocs.map(ensureDocumentPreview) : undefined;
          }
        }
        const incomingStreak: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'streak') ? payload.streak : undefined;
        const st = incomingStreak === null ? undefined : typeof incomingStreak === 'number' ? incomingStreak : undefined;
        const incomingLongest: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'longestStreak') ? payload.longestStreak : undefined;
        const longest = incomingLongest === null ? undefined : typeof incomingLongest === 'number' ? incomingLongest : undefined;
        const incomingSubs: Subtask[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'subtasks') ? payload.subtasks : undefined;
        const subs = incomingSubs === null ? undefined : Array.isArray(incomingSubs) ? incomingSubs : undefined;
        const assignees = incomingAssignees === null ? undefined : incomingAssignees;
        const newOrder = nextOrderForBoard(base.boardId, prev, settings.newTaskPosition);
        const newCreatedAt = base.createdAt ?? Date.now();
        const normalizedIncoming = incomingB === null ? undefined : normalizeBounty(incomingB);
        return dedupeRecurringInstances([
          ...prev,
          {
            ...base,
            order: newOrder,
            createdAt: newCreatedAt,
            images: imgs,
            documents: docs,
            bounty: normalizedIncoming,
            streak: st,
            longestStreak: longest,
            subtasks: subs,
            assignees,
            _nostrAt: ev.created_at,
          },
        ]);
      }
    })(prev);
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

  function sameSeries(a: Task, b: Task): boolean {
    return tasksInSameSeries(a, b);
  }

  function ensureWeekRecurrences(arr: Task[], sources?: Task[]): Task[] {
    const boundedTasks = sanitizeRecurringTasks(arr);
    const boundedSources = sources ? sanitizeRecurringTasks(sources) : undefined;
    const ensured = ensureWeekRecurrencesForCurrentWeek({
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
      maybePublishTask,
    });
    return sanitizeRecurringTasks(ensured);
  }
  const ensureWeekRecurrencesRef = useRef(ensureWeekRecurrences);
  ensureWeekRecurrencesRef.current = ensureWeekRecurrences;

  const ensureCalendarRecurrenceWindow = useCallback(() => {
    const toPublish: CalendarEvent[] = [];
    const toDelete: CalendarEvent[] = [];

    setCalendarEvents((prev) => {
      let changed = false;
      const next = prev.slice();
      const existingIds = new Set(next.map((event) => event.id));
      const seriesMap = new Map<string, { seed: CalendarEvent; events: CalendarEvent[] }>();

      for (let i = 0; i < next.length; i++) {
        let ev = next[i];
        if (!ev.recurrence || ev.recurrence.type === "none") continue;
        const seriesId = ev.seriesId || ev.id;
        if (!ev.seriesId) {
          ev = { ...ev, seriesId };
          next[i] = ev;
          changed = true;
        }
        const group = seriesMap.get(seriesId) ?? { seed: ev, events: [] };
        group.events.push(ev);
        if (ev.id === seriesId) {
          group.seed = ev;
        }
        seriesMap.set(seriesId, group);
      }

      const nowMs = Date.now();

      for (const [seriesId, group] of seriesMap) {
        const seed = group.seed;
        const rule = seed.recurrence;
        if (!rule || rule.type === "none") continue;
        if (seed.readOnly) continue;
        const limit = calendarRecurrenceLimit(rule);
        if (limit <= 0) continue;

        const boardKind = boards.find((b) => b.id === seed.boardId)?.kind ?? "week";
        const timeZone = seed.kind === "time" ? normalizeTimeZone(seed.startTzid) ?? undefined : "UTC";
        const baseStartISO = calendarEventStartISOForRecurrence(seed);
        if (!baseStartISO) continue;

        const durationMs = (() => {
          if (seed.kind !== "time") return 0;
          if (!seed.endISO) return 0;
          const start = Date.parse(seed.startISO);
          const end = Date.parse(seed.endISO);
          if (Number.isNaN(start) || Number.isNaN(end)) return 0;
          return Math.max(0, end - start);
        })();

        const durationDays = (() => {
          if (seed.kind !== "date") return 1;
          const endDate = seed.endDate && isDateKey(seed.endDate) ? seed.endDate : seed.startDate;
          const startParts = parseDateKey(seed.startDate);
          const endParts = parseDateKey(endDate);
          if (!startParts || !endParts) return 1;
          const startUtc = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
          const endUtc = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
          if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc) || endUtc < startUtc) return 1;
          return Math.round((endUtc - startUtc) / MS_PER_DAY) + 1;
        })();

        let seriesEvents = group.events
          .filter((event) => existingIds.has(event.id))
          .map((event) => {
            const startISO = calendarEventStartISOForRecurrence(event);
            const startMs = startISO ? Date.parse(startISO) : NaN;
            const endMs = calendarEventEndMs(event);
            return { event, startISO, startMs, endMs };
          })
          .filter((item) => item.startISO && Number.isFinite(item.startMs) && item.endMs !== null);

        if (!seriesEvents.length) continue;

        const sortedFuture = seriesEvents
          .filter((item) => (item.endMs ?? 0) >= nowMs)
          .sort((a, b) => a.startMs - b.startMs);

        let futureCount = sortedFuture.length;

        if (futureCount > limit) {
          const extras = sortedFuture.slice(limit);
          for (const extra of extras) {
            const idx = next.findIndex((event) => event.id === extra.event.id);
            if (idx < 0) continue;
            toDelete.push(next[idx]);
            next.splice(idx, 1);
            existingIds.delete(extra.event.id);
            changed = true;
          }
          futureCount = Math.min(futureCount, limit);
          seriesEvents = seriesEvents.filter((item) => existingIds.has(item.event.id));
        }

        if (futureCount >= limit) continue;

        const latest = seriesEvents.reduce((acc, item) => (item.startMs > acc.startMs ? item : acc), seriesEvents[0]);
        let cursorISO = latest.startISO || baseStartISO;
        let guard = 0;
        const maxGuard = Math.max(32, limit * 24);

        while (futureCount < limit && guard++ < maxGuard) {
          const nextISO = nextOccurrence(cursorISO, rule, seed.kind === "time", timeZone);
          if (!nextISO) break;
          cursorISO = nextISO;
          const id = calendarRecurrenceInstanceId(seriesId, nextISO, rule, timeZone);
          if (existingIds.has(id)) {
            const existing = next.find((event) => event.id === id);
            if (existing) {
              const endMs = calendarEventEndMs(existing);
              if (endMs != null && endMs >= nowMs) futureCount += 1;
            }
            continue;
          }

          const nextOrder = nextOrderForCalendarBoard(seed.boardId, next, settings.newTaskPosition);
          const instanceBase: CalendarEventBase = {
            ...(seed as any),
            id,
            order: nextOrder,
            seriesId,
            recurrence: rule,
          };

          const instance: CalendarEvent = seed.kind === "time"
            ? {
                ...instanceBase,
                kind: "time",
                startISO: nextISO,
                ...(durationMs ? { endISO: new Date(Date.parse(nextISO) + durationMs).toISOString() } : {}),
                ...(normalizeTimeZone(seed.startTzid) ? { startTzid: seed.startTzid } : {}),
                ...(normalizeTimeZone(seed.endTzid) ? { endTzid: seed.endTzid } : {}),
              }
            : (() => {
                const startDate = isoDatePart(nextISO, "UTC");
                const endDate = durationDays > 1 ? addDaysToDateKey(startDate, durationDays - 1) : null;
                return {
                  ...instanceBase,
                  kind: "date",
                  startDate,
                  ...(endDate ? { endDate } : {}),
                } as CalendarEvent;
              })();

          const instanceEndMs = calendarEventEndMs(instance);
          if (instanceEndMs != null && instanceEndMs < nowMs) {
            continue;
          }

          const normalized = applyHiddenForCalendarEvent(instance, settings.weekStart, boardKind);
          next.push(normalized);
          existingIds.add(id);
          toPublish.push(normalized);
          changed = true;

          if (instanceEndMs != null && instanceEndMs >= nowMs) {
            futureCount += 1;
          }
        }
      }

      return changed ? next : prev;
    });

    if (toPublish.length) {
      toPublish.forEach((event) => {
        maybePublishCalendarEventRef.current?.(event).catch(() => {});
      });
    }
    if (toDelete.length) {
      toDelete.forEach((event) => {
        publishCalendarEventDeletedRef.current?.(event).catch(() => {});
      });
    }
  }, [boards, setCalendarEvents, settings.newTaskPosition, settings.weekStart]);

  useEffect(() => {
    ensureCalendarRecurrenceWindow();
  }, [calendarEvents, ensureCalendarRecurrenceWindow]);

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
    let column: Task["column"] | undefined;
    let columnId: string | undefined;

    if (currentBoard.kind === "week") {
      column = "day";
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
      if (column) task.column = column;
      if (columnId) task.columnId = columnId;
      applyHiddenForFuture(task, settings.weekStart, currentBoard.kind);
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
        setTasks((prev) => {
          let next = [...prev, ...createdTasks];
          if (settings.showFullWeekRecurring && recurringSeeds.length) {
            next = ensureWeekRecurrences(next, recurringSeeds);
          }
          return next;
        });
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
    (payload: SharedTaskPayload, sender?: InboxSender): Task | null => {
      const title = payload?.title?.trim();
      if (!title) return null;
      const baseBoard = currentBoard ?? visibleBoards[0] ?? boards[0] ?? null;
      if (!baseBoard) return null;
      let boardId = baseBoard.id;
      let column: Task["column"] | undefined;
      let columnId: string | undefined;
      let targetBoard = baseBoard;
      if (baseBoard.kind === "week") {
        column = "day";
      } else if (isListLikeBoard(baseBoard)) {
        const placement = resolveListPlacement();
        if (!placement) {
          showToast("Add a list to this board first.");
          return null;
        }
        boardId = placement.boardId;
        columnId = placement.columnId;
        targetBoard = boards.find((b) => b.id === boardId) ?? baseBoard;
      }
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
      let created: Task | null = null;
      setTasks((prev) => {
        const order = nextOrderForBoard(boardId, prev, settings.newTaskPosition);
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
        created = nextTask;
        const updated = [...prev, nextTask];
        return settings.showFullWeekRecurring && nextTask.recurrence
          ? ensureWeekRecurrencesRef.current(updated, [nextTask])
          : updated;
      });
      if (created) {
        maybePublishTaskRef.current?.(created).catch(() => {});
      }
      return created;
    },
    [
      boards,
      currentBoard,
      formatSenderLabel,
      nostrPK,
      resolveListPlacement,
      setTasks,
      settings.newTaskPosition,
      settings.showFullWeekRecurring,
      settings.weekStart,
      showToast,
      visibleBoards,
    ],
  );

  const sendTaskAssignmentResponse = useCallback(
    async (inboxItem: Extract<InboxItem, { type: "task" }>, status: TaskAssigneeStatus): Promise<void> => {
      if (!isAssignedSharedTask(inboxItem.task)) return;
      if (!nostrSkHex) return;
      const recipientPubkey = normalizeAgentPubkey(inboxItem.sender.pubkey) ?? normalizeNostrPubkeyHex(inboxItem.sender.npub || "");
      if (!recipientPubkey) return;
      const relayList = Array.from(
        new Set(
          [
            ...(Array.isArray(inboxItem.task.relays) ? inboxItem.task.relays : []),
            ...defaultRelays,
            ...inboxRelays,
            ...Array.from(DEFAULT_NOSTR_RELAYS),
          ]
            .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
            .filter(Boolean),
        ),
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

  function completeTask(
    id: string,
    options?: { skipScriptureMemoryUpdate?: boolean; inboxAction?: "accept" | "dismiss" | "decline" | "maybe" }
  ): CompleteTaskResult {
    let memoryUpdate: ScriptureMemoryUpdate | null = null;
    let scheduledUpdate: { entryId: string; scheduledAtISO: string } | null = null;
    const scriptureStateSnapshot = scriptureMemory;
    const scriptureBaseDays = scriptureMemoryFrequencyOption?.days ?? 1;
    let inboxAction: { item: InboxItem; action: "accept" | "dismiss" | "decline" | "maybe" } | null = null;
    let assignmentResponse:
      | { item: Extract<InboxItem, { type: "task" }>; status: TaskAssigneeStatus }
      | null = null;
    setTasks(prev => {
      const cur = prev.find(t => t.id === id);
      if (!cur) return prev;
      let working = cur;
      if (
        cur.inboxItem &&
        cur.inboxItem.status !== "accepted" &&
        cur.inboxItem.status !== "declined" &&
        cur.inboxItem.status !== "tentative" &&
        cur.inboxItem.status !== "deleted"
      ) {
        const requestedAction = options?.inboxAction;
        const isTaskAssignment = cur.inboxItem.type === "task" && isAssignedSharedTask(cur.inboxItem.task);
        const action: "accept" | "dismiss" | "decline" | "maybe" =
          requestedAction === "accept" || requestedAction === "dismiss" || requestedAction === "decline" || requestedAction === "maybe"
            ? (isTaskAssignment && requestedAction === "dismiss" ? "decline" : requestedAction)
            : "accept";
        const status: InboxItemStatus =
          action === "accept"
            ? "accepted"
            : action === "maybe"
              ? "tentative"
              : action === "decline"
                ? "declined"
                : "deleted";
        const inboxItem = { ...cur.inboxItem, status };
        const statusLine =
          status === "accepted"
            ? "Action: Added"
            : status === "tentative"
              ? "Action: Maybe"
              : status === "declined"
                ? "Action: Declined"
                : "Action: Dismissed";
        const noteHasStatus = typeof cur.note === "string" && cur.note.includes("Action:");
        working = {
          ...cur,
          inboxItem,
          note: noteHasStatus ? cur.note : [cur.note, statusLine].filter(Boolean).join("\n"),
        };
        inboxAction = { item: inboxItem, action };
        if (
          inboxItem.type === "task" &&
          isAssignedSharedTask(inboxItem.task) &&
          (status === "accepted" || status === "declined" || status === "tentative")
        ) {
          assignmentResponse = {
            item: inboxItem,
            status: status === "accepted" ? "accepted" : status === "tentative" ? "tentative" : "declined",
          };
        }
      }
      const now = new Date().toISOString();
      let newStreak = typeof working.streak === "number" ? working.streak : 0;
      if (
        settings.streaksEnabled &&
        working.recurrence &&
        isFrequentRecurrence(working.recurrence)
      ) {
        // Previously the streak only incremented when completing a task on the
        // same day it was due. This prevented users from keeping their streak
        // if they forgot to check the app and completed the task a day later.
        // Now the streak simply increments whenever the task is completed,
        // regardless of the current timestamp.
        newStreak = newStreak + 1;
      }
      const nextLongest = mergeLongestStreak(working, newStreak);
      const toPublish: Task[] = [];
      let nextId: string | null = null;
      if (
        settings.showFullWeekRecurring &&
        settings.streaksEnabled &&
        working.recurrence &&
        isFrequentRecurrence(working.recurrence)
      ) {
        nextId =
          prev
            .filter(
              t =>
                t.id !== id &&
                !t.completed &&
                t.recurrence &&
                sameSeries(t, working) &&
                new Date(t.dueISO) > new Date(working.dueISO)
            )
            .sort(
              (a, b) =>
                new Date(a.dueISO).getTime() - new Date(b.dueISO).getTime()
            )[0]?.id || null;
      }
      const updated = prev.map(t => {
        if (t.id === id) {
          const editorPubkey = normalizeAgentPubkey((window as any).nostrPK) ?? undefined;
          const done = {
            ...working,
            seriesId: working.seriesId || working.id,
            completed: true,
            completedAt: now,
            completedBy: (window as any).nostrPK || undefined,
            lastEditedBy: editorPubkey || working.lastEditedBy || working.createdBy,
            updatedAt: now,
            bountyDeletedAt: undefined,
            streak: newStreak,
            longestStreak: nextLongest,
          };
          if (working.scriptureMemoryId) {
            memoryUpdate = {
              entryId: working.scriptureMemoryId,
              completedAt: now,
              stageBefore: typeof working.scriptureMemoryStage === "number" ? working.scriptureMemoryStage : 0,
            };
          }
          toPublish.push(done);
          return done;
        }
        if (t.id === nextId) {
          const editorPubkey = normalizeAgentPubkey((window as any).nostrPK) ?? undefined;
          const upd = {
            ...t,
            seriesId: t.seriesId || t.id,
            streak: newStreak,
            longestStreak: mergeLongestStreak(t, newStreak),
            lastEditedBy: editorPubkey || t.lastEditedBy || t.createdBy,
            updatedAt: now,
          };
          toPublish.push(upd);
          return upd;
        }
        return t;
      });
      toPublish.forEach(t => {
        maybePublishTask(t).catch(() => {});
      });
      const scriptureRecurrence =
        (working.seriesId === SCRIPTURE_MEMORY_SERIES_ID || working.scriptureMemoryId)
          ? working.recurrence ?? scriptureFrequencyToRecurrence(scriptureBaseDays)
          : working.recurrence;
      const nextISO = scriptureRecurrence
        ? nextOccurrence(working.dueISO, scriptureRecurrence, !!working.dueTimeEnabled, working.dueTimeZone)
        : null;
      if (nextISO && scriptureRecurrence) {
        let shouldClone = true;
        const seriesId = working.seriesId || working.id;
        const seriesSeed = working.seriesId ? working : { ...working, seriesId };
        const nextDateKey = isoDatePart(nextISO, working.dueTimeZone);
        const exists = updated.some(x =>
          sameSeries(x, seriesSeed) && taskDateKey(x) === nextDateKey
        );
        if (exists) shouldClone = false;
        if (shouldClone) {
          const nextOrder = nextOrderForBoard(working.boardId, updated, settings.newTaskPosition);
          const cloneId = recurringInstanceId(seriesId, nextISO, scriptureRecurrence, working.dueTimeZone);
          let clone: Task = {
            ...working,
            id: cloneId,
            seriesId,
            createdAt: Date.now(),
            completed: false,
            completedAt: undefined,
            completedBy: undefined,
            lastEditedBy: working.lastEditedBy || working.createdBy,
            bountyDeletedAt: undefined,
            dueISO: nextISO,
            hiddenUntilISO: hiddenUntilForNext(nextISO, scriptureRecurrence, settings.weekStart),
            order: nextOrder,
            streak: newStreak,
            longestStreak: nextLongest,
            subtasks: working.subtasks?.map(s => ({ ...s, completed: false })),
            dueTimeEnabled: typeof working.dueTimeEnabled === 'boolean' ? working.dueTimeEnabled : undefined,
            reminders: Array.isArray(working.reminders) ? [...working.reminders] : undefined,
          };
          if (!clone.recurrence || !recurrencesEqual(clone.recurrence, scriptureRecurrence)) {
            clone = { ...clone, recurrence: scriptureRecurrence };
          }
          if (working.seriesId === SCRIPTURE_MEMORY_SERIES_ID) {
            const previewState = memoryUpdate
              ? markScriptureEntryReviewed(
                  scriptureStateSnapshot,
                  memoryUpdate.entryId,
                  memoryUpdate.completedAt,
                  memoryUpdate.stageBefore
                )
              : scriptureStateSnapshot;
            const selection = chooseNextScriptureEntry(
              previewState.entries,
              scriptureBaseDays,
              new Date(nextISO)
            );
            if (!selection) {
              shouldClone = false;
            } else {
              clone = {
                ...clone,
                title: `Review ${formatScriptureReference(selection.entry)}`,
                scriptureMemoryId: selection.entry.id,
                scriptureMemoryStage: selection.entry.stage ?? 0,
                scriptureMemoryPrevReviewISO: selection.entry.lastReviewISO ?? null,
                scriptureMemoryScheduledAt: now,
              };
              scheduledUpdate = { entryId: selection.entry.id, scheduledAtISO: now };
            }
          }
          if (shouldClone) {
            maybePublishTask(clone).catch(() => {});
            return [...updated, clone];
          }
        }
      }
      return updated;
    });
    // Snapshot inboxAction into a local const so TS retains the discriminated-
    // union narrowing through the subsequent .item.type checks. The cast is
    // safe at runtime: the let was annotated with this exact shape at
    // declaration, but TS narrows it to `never` here because the assignment
    // happens inside a setTasks callback and TS's CFA doesn't trust the
    // mutation across the closure.
    const acceptedInbox = inboxAction as { item: InboxItem; action: "accept" | "dismiss" | "decline" | "maybe" } | null;
    if (acceptedInbox && acceptedInbox.action === "accept") {
      const item = acceptedInbox.item;
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
      } else if (item.type === "task") {
        const added = addSharedTaskFromInbox(item.task, item.sender);
        if (added) {
          showToast("Task added to your board");
        } else {
          showToast("Unable to add task");
        }
      }
    }
    // Snapshot the let (assigned inside setTasks callback) so TS retains the
    // union narrowing after the truthiness check.
    const finalAssignmentResponse = assignmentResponse as { item: Extract<InboxItem, { type: "task" }>; status: TaskAssigneeStatus } | null;
    if (finalAssignmentResponse) {
      void sendTaskAssignmentResponse(finalAssignmentResponse.item, finalAssignmentResponse.status).catch((err) => {
        console.warn("Failed to send task assignment response", err);
      });
      if (finalAssignmentResponse.status === "tentative") {
        showToast("Responded: maybe");
      } else if (finalAssignmentResponse.status === "declined") {
        showToast("Responded: declined");
      }
    }
    const finalScheduledUpdate = scheduledUpdate;
    // Cast: see the same setState-callback narrowing footgun as inboxAction
    // above. The let was annotated `ScriptureMemoryUpdate | null` at decl.
    const memoryUpdateSnapshot = memoryUpdate as ScriptureMemoryUpdate | null;
    if (finalScheduledUpdate && memoryUpdateSnapshot) {
      memoryUpdate = { ...memoryUpdateSnapshot, nextScheduled: finalScheduledUpdate };
    }
    if (memoryUpdate && !options?.skipScriptureMemoryUpdate) {
      scriptureLastReviewRef.current = memoryUpdate.completedAt;
      setScriptureMemory((prev) => {
        let nextState = markScriptureEntryReviewed(
          prev,
          memoryUpdate!.entryId,
          memoryUpdate!.completedAt,
          memoryUpdate!.stageBefore
        );
        if (memoryUpdate!.nextScheduled) {
          nextState = scheduleScriptureEntry(
            nextState,
            memoryUpdate!.nextScheduled.entryId,
            memoryUpdate!.nextScheduled.scheduledAtISO
          );
        }
        return nextState;
      });
    }
    return memoryUpdate ? { scriptureMemory: memoryUpdate } : null;
  }

  function toggleSubtask(taskId: string, subId: string) {
    setTasks(prev =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        const subs = (t.subtasks || []).map((s) =>
          s.id === subId ? { ...s, completed: !s.completed } : s
        );
        const updated: Task = {
          ...t,
          subtasks: subs,
          lastEditedBy: normalizeAgentPubkey((window as any).nostrPK) ?? t.lastEditedBy ?? t.createdBy,
        };
        maybePublishTask(updated).catch(() => {});
        return updated;
      })
    );
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
    const currentTasks = tasksRef.current;
    const t = currentTasks.find(x => x.id === id);
    if (!t) return;
    const markRecoverableBountyDelete = (task: Task, deletedAtISO: string): Task => ({
      ...task,
      completed: true,
      completedAt: task.completedAt || deletedAtISO,
      completedBy: task.completedBy ?? ((window as any).nostrPK || undefined),
      lastEditedBy: normalizeAgentPubkey((window as any).nostrPK) ?? task.lastEditedBy ?? task.createdBy,
      hiddenUntilISO: undefined,
      bountyDeletedAt: deletedAtISO,
    });
    if (!options?.skipPrompt && t.recurrence) {
      setRecurringDeleteTask(t);
      return;
    }
    if (options?.scope === "future") {
      const seriesId = recurringSeriesId(t);
      const seriesSeed = t.seriesId === seriesId ? t : { ...t, seriesId };
      if (Number.isNaN(Date.parse(t.dueISO))) return;
      const cutoffKey = isoDatePart(t.dueISO, t.dueTimeZone);
      const deletedAtISO = new Date().toISOString();
      const nextUntil = recurringSeriesCutoffBefore(t);
      if (!nextUntil) return;
      recordRecurringSeriesCutoff(seriesSeed, nextUntil);
      const toPublish: Task[] = [];
      const toDelete: Task[] = [];
      let changed = false;
      const nextTasks: Task[] = [];
      for (const task of currentTasks) {
        if (!task.recurrence || !sameSeries(task, seriesSeed)) {
          nextTasks.push(task);
          continue;
        }
        recordRecurringSeriesCutoff(task, nextUntil);
        if (Number.isNaN(Date.parse(task.dueISO))) {
          nextTasks.push(task);
          continue;
        }
        const dueKey = isoDatePart(task.dueISO, t.dueTimeZone);
        if (dueKey >= cutoffKey) {
          const terminated = capRecurringTaskAt(task, nextUntil);
          if (task.bounty) {
            const archived = markRecoverableBountyDelete(terminated, deletedAtISO);
            nextTasks.push(archived);
            toPublish.push(archived);
          } else {
            toDelete.push(terminated);
          }
          changed = true;
          continue;
        }
        const updated = capRecurringTaskAt(task, nextUntil);
        if (updated !== task) {
          nextTasks.push(updated);
          toPublish.push(updated);
          changed = true;
          continue;
        }
        nextTasks.push(task);
      }
      if (changed) setTasks(sanitizeRecurringTasks(nextTasks));
      toPublish.forEach(task => maybePublishTask(task).catch(() => {}));
      toDelete.forEach(task => publishTaskDeleted(task).catch(() => {}));
      if (toPublish.some((task) => isRecoverableBountyTask(task))) {
        showToast("Bounty tasks were moved to Completed. Restore to recover.", 3000);
      }
      return;
    }
    if (t.bounty) {
      const deletedAtISO = new Date().toISOString();
      let updated: Task | null = null;
      setTasks((prev) =>
        prev.map((task) => {
          if (task.id !== id) return task;
          const recoverable = markRecoverableBountyDelete(task, deletedAtISO);
          updated = recoverable;
          return recoverable;
        }),
      );
      if (updated) {
        maybePublishTask(updated).catch(() => {});
        showToast("Bounty task moved to Completed. Restore to recover.", 3000);
      }
      return;
    }
    setUndoTask(t);
    setTasks(prev => {
      const arr = prev.filter(x => x.id !== id);
      const toPublish: Task[] = [];
      if (
        settings.showFullWeekRecurring &&
        settings.streaksEnabled &&
        t.recurrence &&
        isFrequentRecurrence(t.recurrence)
      ) {
        const next = arr
          .filter(x => !x.completed && x.recurrence && sameSeries(x, t) && new Date(x.dueISO) > new Date(t.dueISO))
          .sort((a, b) => new Date(a.dueISO).getTime() - new Date(b.dueISO).getTime())[0];
        if (next) {
          const idx = arr.findIndex(x => x.id === next.id);
          arr[idx] = {
            ...next,
            seriesId: next.seriesId || next.id,
            streak: 0,
            longestStreak: mergeLongestStreak(next, 0),
          };
          toPublish.push(arr[idx]);
        }
      }
      toPublish.forEach(x => maybePublishTask(x).catch(() => {}));
      return arr;
    });
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
    publishTaskDeleted(t).catch(() => {});
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
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const toPublish: Task[] = [];
    const recurringStreak =
      !isRecoverableBountyTask(t) &&
      settings.streaksEnabled &&
      t.recurrence &&
      isFrequentRecurrence(t.recurrence) &&
      typeof t.streak === "number";
    const newStreak = recurringStreak ? Math.max(0, t.streak! - 1) : t.streak;
    setTasks(prev => {
      const bottomOrder =
        prev.reduce((max, task) => {
          if (task.id === id) return max;
          if (task.boardId !== t.boardId) return max;
          const order = typeof task.order === "number" ? task.order : -1;
          return Math.max(max, order);
        }, -1) + 1;
      const arr = prev.map(x => {
        if (x.id !== id) return x;
        const restored: Task = {
          ...x,
          completed: false,
          completedAt: undefined,
          completedBy: undefined,
          lastEditedBy: normalizeAgentPubkey((window as any).nostrPK) ?? x.lastEditedBy ?? x.createdBy,
          updatedAt: new Date().toISOString(),
          bountyDeletedAt: undefined,
          hiddenUntilISO: undefined,
          streak: newStreak,
          longestStreak: mergeLongestStreak(x, newStreak),
          order: bottomOrder,
        };
        const upd = detachCancelledRecurringTask(restored, recurringSeriesCutoffsRef.current);
        toPublish.push(upd);
        return upd;
      });
      if (recurringStreak) {
        const future = arr.filter(
          x =>
            x.id !== id &&
            !x.completed &&
            x.recurrence &&
            sameSeries(x, t) &&
            new Date(x.dueISO) > new Date(t.dueISO)
        );
        future.forEach(f => {
          const idx = arr.findIndex(x => x.id === f.id);
          const upd = {
            ...f,
            seriesId: f.seriesId || f.id,
            streak: newStreak,
            longestStreak: mergeLongestStreak(f, newStreak),
            lastEditedBy: normalizeAgentPubkey((window as any).nostrPK) ?? f.lastEditedBy ?? f.createdBy,
            updatedAt: new Date().toISOString(),
          };
          arr[idx] = upd;
          toPublish.push(upd);
        });
      }
      return arr;
    });
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
    toPublish.forEach(x => maybePublishTask(x).catch(() => {}));
  }
  function clearCompleted() {
    if (currentBoard?.kind === "bible" || currentBoard?.clearCompletedDisabled) {
      return;
    }
    const scope = currentBoard ? new Set(boardScopeIds(currentBoard, boards)) : null;
    for (const t of tasksForBoard)
      if (t.completed && !isRecoverableBountyTask(t) && (!t.bounty || t.bounty.state === 'claimed'))
        publishTaskDeleted(t).catch(() => {});
    setTasks(prev =>
      prev.filter(t =>
        !(
          scope?.has(t.boardId) &&
          t.completed &&
          !isRecoverableBountyTask(t) &&
          (!t.bounty || t.bounty.state === 'claimed')
        )
      )
    );
  }

  function postponeTaskOneWeek(id: string) {
    let updated: Task | undefined;
    setTasks(prev => prev.map(t => {
      if (t.id !== id) return t;
      const nextDue = startOfDay(new Date(t.dueISO));
      nextDue.setDate(nextDue.getDate() + 7);
      const boardKind = boards.find((board) => board.id === t.boardId)?.kind ?? "week";
      const hiddenUntilISO = hiddenUntilForBoard(nextDue.toISOString(), boardKind, settings.weekStart);
      updated = {
        ...t,
        dueISO: nextDue.toISOString(),
        dueDateEnabled: true,
        lastEditedBy: normalizeAgentPubkey((window as any).nostrPK) ?? t.lastEditedBy ?? t.createdBy,
        hiddenUntilISO,
      };
      return updated!;
    }));
    if (updated) {
      maybePublishTask(updated).catch(() => {});
      showToast('Task moved to next week');
    }
  }

  async function revealBounty(id: string) {
    const t = tasks.find(x => x.id === id);
    if (!t || !t.bounty || t.bounty.state !== 'locked' || !t.bounty.enc) return;
    try {
      let pt = "";
      const enc = t.bounty.enc as any;
      const me = (window as any).nostrPK as string | undefined;
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
        lastEditedBy: normalizeAgentPubkey((window as any).nostrPK) ?? t.lastEditedBy ?? t.createdBy,
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
    const me = (window as any).nostrPK as string | undefined;
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
      lastEditedBy: normalizeAgentPubkey((window as any).nostrPK) ?? t.lastEditedBy ?? t.createdBy,
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
        lastEditedBy: normalizeAgentPubkey((window as any).nostrPK) ?? t.lastEditedBy ?? t.createdBy,
      });
      setTasks(prev => prev.map(x => x.id === id ? updated : x));
      setEditing((prev) => (prev && prev.type === "task" && prev.task.id === id ? { ...prev, task: updated } : prev));
      maybePublishTask(updated).catch(() => {});
    } catch (e) {
      alert('Redeem failed: ' + (e as Error).message);
    }
  }

  async function saveEdit(updated: Task) {
    let editedTask: Task | null = null;
    let previousAssignees: TaskAssignee[] | null = null;
    setTasks(prev => {
      let found = false;
      const arr = prev.map(t => {
        if (t.id !== updated.id) return t;
        found = true;
        previousAssignees = Array.isArray(t.assignees) ? t.assignees : null;
        let next = updated;
        if (t.boardId !== updated.boardId) {
          next = {
            ...next,
            order: nextOrderForBoard(updated.boardId, prev, settings.newTaskPosition),
          };
        }
        if (
          settings.streaksEnabled &&
          t.recurrence &&
          isFrequentRecurrence(t.recurrence) &&
          !t.completed
        ) {
          const prevDue = startOfDay(new Date(t.dueISO));
          const newDue = startOfDay(new Date(updated.dueISO));
          if (newDue.getTime() > prevDue.getTime()) {
            next = { ...updated, streak: 0 };
          }
        }
        if (next.recurrence) next = { ...next, seriesId: next.seriesId || next.id };
        else next = { ...next, seriesId: undefined };
        const normalizedCreatedBy = normalizeAgentPubkey(next.createdBy || t.createdBy || nostrPK) ?? undefined;
        const normalizedLastEditedBy =
          normalizeAgentPubkey(next.lastEditedBy || nostrPK || normalizedCreatedBy)
          ?? normalizedCreatedBy;
        next = {
          ...next,
          ...(normalizedCreatedBy ? { createdBy: normalizedCreatedBy } : {}),
          ...(normalizedLastEditedBy ? { lastEditedBy: normalizedLastEditedBy } : {}),
          updatedAt: new Date().toISOString(),
        };
        const normalizedNext = normalizeTaskBounty(next);
        editedTask = normalizedNext;
        return normalizedNext;
      });
      if (!found) {
        let next = updated;
        if (next.recurrence) next = { ...next, seriesId: next.seriesId || next.id };
        else next = { ...next, seriesId: undefined };
        const normalizedCreatedBy = normalizeAgentPubkey(next.createdBy || nostrPK) ?? undefined;
        const normalizedLastEditedBy =
          normalizeAgentPubkey(next.lastEditedBy || nostrPK || normalizedCreatedBy)
          ?? normalizedCreatedBy;
        next = {
          ...next,
          ...(normalizedCreatedBy ? { createdBy: normalizedCreatedBy } : {}),
          ...(normalizedLastEditedBy ? { lastEditedBy: normalizedLastEditedBy } : {}),
          updatedAt: new Date().toISOString(),
        };
        if (typeof next.order !== "number") {
          next = {
            ...next,
            order: nextOrderForBoard(next.boardId, arr, settings.newTaskPosition),
          };
        }
        const normalizedNext = normalizeTaskBounty(next);
        editedTask = normalizedNext;
        const withNew = [...arr, normalizedNext];
        return settings.showFullWeekRecurring && editedTask?.recurrence
          ? ensureWeekRecurrences(withNew, [editedTask])
          : withNew;
      }
      return settings.showFullWeekRecurring && editedTask?.recurrence
        ? ensureWeekRecurrences(arr, [editedTask])
        : arr;
    });
    if (editedTask) {
      await maybePublishTask(editedTask);
      void maybeSendTaskAssignments(editedTask, { previousAssignees }).catch((err) => {
        console.warn("Failed to send task assignments", err);
      });
    }
    setEditing(null);
  }

  const calendarRecurrenceInstanceId = (seriesId: string, startISO: string, rule: Recurrence, timeZone?: string): string =>
    recurringInstanceId(seriesId, startISO, rule, timeZone).replace(/:/g, "_");

  const calendarRecurrenceLimit = (rule: Recurrence): number => {
    switch (rule.type) {
      case "weekly":
        return 52;
      case "monthlyDay": {
        const interval = Math.max(1, rule.interval ?? 1);
        return interval >= 12 ? 5 : 18;
      }
      case "every": {
        if (rule.unit === "week") return 52;
        if (rule.unit === "day") return 24;
        return 24;
      }
      case "daily":
        return 24;
      default:
        return 0;
    }
  };

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
    const existing = calendarEventsRef.current.find((event) => event.id === id);
    if (!existing) return;
    if (!options?.skipPrompt && existing.recurrence) {
      setRecurringDeleteEvent(existing);
      return;
    }

    if (options?.scope === "future") {
      const seriesId = existing.seriesId || existing.id;
      const startKeyForEvent = (event: CalendarEvent): string | null => {
        if (event.kind === "date") {
          return ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
        }
        const key = isoDatePart(event.startISO, event.startTzid);
        return ISO_DATE_PATTERN.test(key) ? key : null;
      };
      const cutoffKey = startKeyForEvent(existing);
      if (!cutoffKey) return;
      const cutoffDate = startOfDay(new Date(`${cutoffKey}T00:00:00`));
      if (Number.isNaN(cutoffDate.getTime())) return;
      const cutoffTime = cutoffDate.getTime();
      const nextUntil = new Date(cutoffTime - MS_PER_DAY).toISOString();
      recordCalendarSeriesCutoff(existing.boardId, seriesId, nextUntil);
      const toPublish: CalendarEvent[] = [];
      const toDelete: CalendarEvent[] = [];

      setCalendarEvents((prev) => {
        let changed = false;
        const next: CalendarEvent[] = [];
        for (const event of prev) {
          const eventSeriesId = event.seriesId || event.id;
          if (!event.recurrence || eventSeriesId !== seriesId) {
            next.push(event);
            continue;
          }
          const startKey = startKeyForEvent(event);
          if (!startKey) {
            next.push(event);
            continue;
          }
          if (startKey >= cutoffKey) {
            toDelete.push({
              ...event,
              seriesId,
              recurrence: { ...event.recurrence, untilISO: nextUntil },
            });
            changed = true;
            continue;
          }
          const untilTime = event.recurrence.untilISO
            ? startOfDay(new Date(event.recurrence.untilISO)).getTime()
            : null;
          if (!untilTime || untilTime > cutoffTime - MS_PER_DAY) {
            const updated: CalendarEvent = {
              ...event,
              seriesId: event.seriesId || seriesId,
              recurrence: { ...event.recurrence, untilISO: nextUntil },
            };
            next.push(updated);
            toPublish.push(updated);
            changed = true;
            continue;
          }
          next.push(event);
        }
        return changed ? next : prev;
      });

      toPublish.forEach((event) => maybePublishCalendarEvent(event).catch(() => {}));
      toDelete.forEach((event) => publishCalendarEventDeleted(event).catch(() => {}));
      return;
    }

    setCalendarEvents((prev) => prev.filter((event) => event.id !== id));
    publishCalendarEventDeleted(existing).catch(() => {});
  }

  const parseCalendarAddressForKind = (coord: string, kind: number): { kind: number; pubkey: string; d: string } | null => {
    const parsed = parseCalendarAddress(coord);
    if (!parsed || parsed.kind !== kind) return null;
    return parsed;
  };

  function setCalendarInviteStatus(coord: string, status: CalendarInviteStatus) {
    const normalized = (coord || "").trim();
    if (!normalized) return;
    setCalendarInvites((prev) =>
      prev.map((invite) => (invite.canonical === normalized ? { ...invite, status } : invite)),
    );
  }

  const addAcceptedInviteToCalendar = useCallback(
    async (invite: CalendarInvite, status: CalendarRsvpStatus): Promise<CalendarEvent | null> => {
      if (status !== "accepted" && status !== "tentative") return null;
      const viewCoord = parseCalendarAddressForKind(invite.view, TASKIFY_CALENDAR_VIEW_KIND);
      if (!viewCoord) return null;
      const existingMatch = calendarEventsRef.current.find(
        (event) => event.id === invite.eventId && event.viewAddress === invite.view,
      );
      const hasInviteRelays = !!invite.relays?.length;
      const existingHasRelays = !!existingMatch?.inviteRelays?.length;
      if (
        existingMatch
        && existingMatch.eventKey === invite.eventKey
        && existingMatch.inviteToken === invite.inviteToken
        && (!hasInviteRelays || existingHasRelays)
      ) {
        return existingMatch ?? null;
      }

      const eligibleBoards = boards.filter(
        (board) => !board.archived && !board.hidden && board.kind !== "bible" && board.kind !== "compound",
      );
      const defaultBoard =
        eligibleBoards.find((board) => board.id === "week-default" && board.kind === "week")
        ?? eligibleBoards.find((board) => board.kind === "week")
        ?? eligibleBoards.find((board) => board.kind === "lists")
        ?? eligibleBoards[0]
        ?? boards.find((board) => !board.archived && !board.hidden)
        ?? boards[0]
        ?? null;
      if (!defaultBoard) return null;

      const relayCandidates = [
        ...(invite.relays?.length ? invite.relays : []),
        ...(defaultRelays.length ? defaultRelays : []),
        ...(inboxRelays.length ? inboxRelays : []),
        ...Array.from(DEFAULT_NOSTR_RELAYS),
      ];
      const relayList = Array.from(new Set(relayCandidates.map((relay) => relay.trim()).filter(Boolean)));
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
      const readOnly = isExternal;
      if (isExternal && !boardPubkey) {
        showToast("Invite event data was incomplete.");
        return null;
      }
      const order = nextOrderForCalendarBoard(defaultBoard.id, calendarEventsRef.current, settings.newTaskPosition);
      const columnId =
        defaultBoard.kind === "lists" && defaultBoard.columns.length ? defaultBoard.columns[0].id : undefined;

      let viewPayload: ReturnType<typeof parseCalendarViewPayload> | null = null;
      if (viewEvent) {
        try {
          const raw = await decryptCalendarPayloadWithEventKey(viewEvent.content, invite.eventKey);
          viewPayload = parseCalendarViewPayload(raw);
        } catch (err) {
          console.warn("Failed to decrypt invite view", err);
        }
      }
      if (viewPayload?.deleted) {
        showToast("This event was deleted.");
        return null;
      }

      const resolvedEventId = viewPayload?.eventId || viewCoord.d || invite.eventId;
      if (viewPayload && viewPayload.eventId !== viewCoord.d) {
        showToast("Invite event data was incomplete.");
        return null;
      }

      const inviteRelays = invite.relays?.length ? invite.relays : existingMatch?.inviteRelays;
      const tokenPatch = {
        ...(originBoardId ? { originBoardId } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...(isExternal ? { external: true, boardPubkey, rsvpStatus: status } : {}),
        eventKey: invite.eventKey,
        viewAddress: invite.view,
        canonicalAddress: invite.canonical,
        inviteToken: invite.inviteToken,
        inviteRelays,
      };
      const inviteCreatedBy =
        normalizeAgentPubkey(viewPayload?.createdBy)
        ?? normalizeAgentPubkey(invite.sender?.pubkey)
        ?? normalizeAgentPubkey(boardPubkey)
        ?? undefined;
      const inviteLastEditedBy =
        normalizeAgentPubkey(viewPayload?.lastEditedBy)
        ?? inviteCreatedBy;

      const updateExistingTokens = () => {
        if (!existingMatch) return;
        setCalendarEvents((prev) => {
          const idx = prev.findIndex((event) => event.id === existingMatch.id && event.viewAddress === invite.view);
          if (idx < 0) return prev;
          const existing = prev[idx];
          const updated: CalendarEvent = {
            ...existing,
            ...tokenPatch,
            ...(readOnly ? { readOnly: true } : { readOnly: existing.readOnly }),
          } as CalendarEvent;
          const copy = prev.slice();
          copy[idx] = updated;
          return copy;
        });
      };

      const toCommon = (details: {
        title?: string;
        summary?: string;
        description?: string;
        documents?: unknown[];
        image?: string;
        locations?: string[];
        geohash?: string;
        hashtags?: string[];
        references?: string[];
      }): Omit<CalendarEventBase, "kind" | "startDate" | "endDate" | "startISO" | "endISO"> => {
        const parsedDocuments = normalizeDocumentList(details.documents);
        return {
          id: resolvedEventId,
          boardId: defaultBoard.id,
          ...(inviteCreatedBy ? { createdBy: inviteCreatedBy } : {}),
          ...(inviteLastEditedBy ? { lastEditedBy: inviteLastEditedBy } : {}),
          columnId,
          order,
          title: details.title || invite.title || "Untitled",
          summary: details.summary,
          description: details.description || "",
          documents: parsedDocuments ? parsedDocuments.map(ensureDocumentPreview) : undefined,
          image: details.image,
          locations: details.locations?.length ? details.locations : undefined,
          geohash: details.geohash,
          hashtags: details.hashtags?.length ? details.hashtags : undefined,
          references: details.references?.length ? details.references : undefined,
          ...tokenPatch,
        };
      };

      const nextEvent: CalendarEvent | null = (() => {
        if (viewPayload) {
          if (viewPayload.kind === "date") {
            const startDate = viewPayload.startDate || "";
            if (!isDateKey(startDate)) return null;
            const endDate = (() => {
              const rawEnd = viewPayload.endDate || "";
              if (!rawEnd || !isDateKey(rawEnd)) return undefined;
              return rawEnd >= startDate ? rawEnd : undefined;
            })();
            return {
              ...toCommon({
                title: viewPayload.title,
                summary: viewPayload.summary,
                description: viewPayload.description,
                documents: viewPayload.documents,
                image: viewPayload.image,
                locations: viewPayload.locations,
                geohash: viewPayload.geohash,
                hashtags: viewPayload.hashtags,
                references: viewPayload.references,
              }),
              kind: "date",
              startDate,
              ...(endDate ? { endDate } : {}),
            };
          }
          const startISO = typeof viewPayload.startISO === "string" ? viewPayload.startISO.trim() : "";
          if (!startISO) return null;
          const startMs = Date.parse(startISO);
          if (Number.isNaN(startMs)) return null;
          const endISO = typeof viewPayload.endISO === "string" ? viewPayload.endISO.trim() : "";
          const normalizedEnd = endISO && Date.parse(endISO) > startMs ? endISO : undefined;
          const startTzid = normalizeTimeZone(viewPayload.startTzid) ?? undefined;
          const endTzid = normalizeTimeZone(viewPayload.endTzid) ?? undefined;
          return {
            ...toCommon({
                title: viewPayload.title,
                summary: viewPayload.summary,
                description: viewPayload.description,
                documents: viewPayload.documents,
                image: viewPayload.image,
                locations: viewPayload.locations,
                geohash: viewPayload.geohash,
                hashtags: viewPayload.hashtags,
                references: viewPayload.references,
            }),
            kind: "time",
            startISO,
            ...(normalizedEnd ? { endISO: normalizedEnd } : {}),
            ...(startTzid ? { startTzid } : {}),
            ...(endTzid ? { endTzid } : {}),
          };
        }
        if (existingMatch) {
          updateExistingTokens();
          return existingMatch ?? null;
        }
        const startRaw = invite.start?.trim() || "";
        if (isDateKey(startRaw)) {
          const endRaw = invite.end?.trim() || "";
          const endDate = endRaw && isDateKey(endRaw) && endRaw >= startRaw ? endRaw : undefined;
          return {
            ...toCommon({ title: invite.title }),
            kind: "date",
            startDate: startRaw,
            ...(endDate ? { endDate } : {}),
          };
        }
        const startMs = startRaw ? Date.parse(startRaw) : NaN;
        if (!startRaw || Number.isNaN(startMs)) {
          updateExistingTokens();
          return existingMatch ?? null;
        }
        const endRaw = invite.end?.trim() || "";
        const endMs = endRaw ? Date.parse(endRaw) : NaN;
        const endISO = !Number.isNaN(endMs) && endMs > startMs ? new Date(endMs).toISOString() : undefined;
        return {
          ...toCommon({ title: invite.title }),
          kind: "time",
          startISO: new Date(startMs).toISOString(),
          ...(endISO ? { endISO } : {}),
        };
      })();

      if (!nextEvent) {
        if (!existingMatch) {
          showToast("Invite event could not be parsed.");
        }
        return existingMatch ?? null;
      }

      const normalizedEvent = applyHiddenForCalendarEvent(nextEvent, settings.weekStart, defaultBoard.kind);
      setCalendarEvents((prev) => {
        const idx = prev.findIndex((event) => event.id === normalizedEvent.id && event.viewAddress === invite.view);
        if (idx < 0) return [...prev, normalizedEvent];
        const existing = prev[idx];
        const merged: CalendarEvent = {
          ...normalizedEvent,
          ...(Array.isArray(existing.reminders) && existing.reminders.length ? { reminders: existing.reminders } : {}),
          ...(existing.reminderTime ? { reminderTime: existing.reminderTime } : {}),
          ...(existing.recurrence ? { recurrence: existing.recurrence } : {}),
          ...(existing.seriesId ? { seriesId: existing.seriesId } : {}),
          ...(existing.hiddenUntilISO ? { hiddenUntilISO: existing.hiddenUntilISO } : {}),
          ...(typeof existing.order === "number" && typeof normalizedEvent.order !== "number" ? { order: existing.order } : {}),
        } as CalendarEvent;
        const copy = prev.slice();
        copy[idx] = merged;
        return copy;
      });
      return normalizedEvent;
    },
    [boards, defaultRelays, inboxRelays, pool, setCalendarEvents, settings.newTaskPosition, settings.weekStart, showToast],
  );

  async function publishCalendarRsvp(
    canonical: string,
    eventId: string,
    inviteToken: string | null | undefined,
    relays: string[],
    status: CalendarRsvpStatus,
    options?: { fb?: CalendarRsvpFb; note?: string; boardId?: string },
  ): Promise<void> {
    const relayList = Array.from(new Set((relays || []).map((relay) => relay.trim()).filter(Boolean)));
    if (!relayList.length) throw new Error("No relays configured for RSVP.");
    if (!nostrSkHex || !nostrPK) throw new Error("Connect a Nostr key to RSVP.");
    const parsedCoord = parseCalendarAddressForKind(canonical, TASKIFY_CALENDAR_EVENT_KIND);
    if (!parsedCoord) throw new Error("Invalid calendar event address.");
    const canonicalAddr = calendarAddress(parsedCoord.kind, parsedCoord.pubkey, parsedCoord.d);
    let resolvedToken = typeof inviteToken === "string" ? inviteToken.trim() : "";
    if (!resolvedToken && options?.boardId) {
      resolvedToken = deriveBoardRsvpToken(options.boardId, nostrPK);
    }
    if (!resolvedToken) throw new Error("Missing invite token for RSVP.");
    const rsvpId = `${eventId}:${nostrPK}`;
    const payload = {
      v: 1,
      eventId,
      status,
      inviteToken: resolvedToken,
      ...(options?.fb ? { fb: options.fb } : {}),
      ...(options?.note ? { note: options.note } : {}),
    };
    const content = await encryptCalendarRsvpPayload(payload, nostrSkHex, parsedCoord.pubkey);
    const template: EventTemplate = {
      kind: TASKIFY_CALENDAR_RSVP_KIND,
      tags: [["d", rsvpId], ["a", canonicalAddr]],
      content,
      created_at: Math.floor(Date.now() / 1000),
    };
    const { createdAt } = await nostrPublish(relayList, template, { returnEvent: true });
    setCalendarEvents((prev) => {
      let changed = false;
      const next = prev.map((event) => {
        if (!event.external) return event;
        if (event.id !== eventId || event.canonicalAddress !== canonicalAddr) return event;
        if (event.rsvpCreatedAt && event.rsvpCreatedAt > createdAt) return event;
        changed = true;
        return {
          ...event,
          rsvpStatus: status,
          rsvpCreatedAt: createdAt,
          ...(options?.fb ? { rsvpFb: options.fb } : { rsvpFb: undefined }),
        };
      });
      return changed ? next : prev;
    });
    recordActiveEventRsvp(canonicalAddr, {
      eventId,
      authorPubkey: nostrPK,
      createdAt,
      status,
      ...(options?.fb ? { fb: options.fb } : {}),
      ...(typeof inviteToken === "string" ? { inviteToken } : {}),
    });
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
      const relayCandidates = [
        ...(inviteRelays?.length ? inviteRelays : []),
        ...defaultRelays,
        ...inboxRelays,
        ...Array.from(DEFAULT_NOSTR_RELAYS),
      ];
      const fallbackRelays = Array.from(new Set(relayCandidates.map((relay) => relay.trim()).filter(Boolean)));
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
    const prior = calendarEventsRef.current.find((event) => event.id === updated.id) ?? null;
    const priorParticipants = prior?.participants ?? [];
    const priorPublishBoardId = prior?.originBoardId ?? prior?.boardId;
    const publishBoardId = updated.originBoardId ?? updated.boardId;
    const forceInviteAll = !!prior && (priorPublishBoardId !== publishBoardId || prior.kind !== updated.kind);
    const boardForUpdate = boards.find((b) => b.id === publishBoardId) ?? null;
    const shouldSendInvites = (updated.participants?.length ?? 0) > 0;
    let inviteBoard = boardForUpdate;
    if (shouldSendInvites && boardForUpdate && !boardForUpdate.nostr?.boardId) {
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
    let publishBatch: CalendarEvent[] = [];
    const prunedDeletes: CalendarEvent[] = [];
    setCalendarEvents((prev) => {
      const existing = prev.find((event) => event.id === updated.id) ?? null;
      let next: CalendarEvent = updated;

      if (existing && existing.boardId !== updated.boardId) {
        next = {
          ...next,
          order: nextOrderForCalendarBoard(updated.boardId, prev, settings.newTaskPosition),
        };
      } else if (typeof next.order !== "number") {
        next = {
          ...next,
          order: nextOrderForCalendarBoard(updated.boardId, prev, settings.newTaskPosition),
        };
      }

      if (next.recurrence && next.recurrence.type !== "none") {
        next = { ...next, seriesId: next.seriesId || next.id };
      } else {
        next = { ...next, recurrence: undefined, seriesId: undefined };
      }
      const nextCreatedBy = normalizeAgentPubkey(next.createdBy || existing?.createdBy || nostrPK) ?? undefined;
      const nextLastEditedBy = normalizeAgentPubkey(next.lastEditedBy || nostrPK || nextCreatedBy) ?? nextCreatedBy;
      next = {
        ...next,
        ...(nextCreatedBy ? { createdBy: nextCreatedBy } : {}),
        ...(nextLastEditedBy ? { lastEditedBy: nextLastEditedBy } : {}),
      };
      const visibilityBoard = boards.find((b) => b.id === next.boardId) ?? boardForUpdate ?? null;
      next = applyHiddenForCalendarEvent(next, settings.weekStart, visibilityBoard?.kind ?? "week");

      const idx = prev.findIndex((event) => event.id === next.id);
      let nextState = idx >= 0
        ? prev.map((event) => (event.id === next.id ? next : event))
        : [...prev, next];

      publishBatch = [next];

      const shouldGenerate =
        next.recurrence &&
        next.recurrence.type !== "none" &&
        (next.seriesId || next.id) === next.id;

      if (!shouldGenerate) {
        return nextState;
      }

      const seriesId = next.seriesId || next.id;
      const rule = next.recurrence!;
      const timeZone = next.kind === "time" ? normalizeTimeZone(next.startTzid) ?? undefined : "UTC";
      const baseStartISO = next.kind === "time"
        ? next.startISO
        : isoFromDateTime(next.startDate, "00:00", "UTC");

      const limitKey = rule.untilISO ? isoDatePart(rule.untilISO, timeZone) : null;
      if (limitKey && ISO_DATE_PATTERN.test(limitKey)) {
        const startKeyForSeriesEvent = (event: CalendarEvent): string | null => {
          if (!event.recurrence) return null;
          const eventSeriesId = event.seriesId || event.id;
          if (eventSeriesId !== seriesId) return null;
          if (event.kind === "date") {
            return ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : null;
          }
          const dateKey = isoDatePart(event.startISO, timeZone);
          return ISO_DATE_PATTERN.test(dateKey) ? dateKey : null;
        };

        const pruned: CalendarEvent[] = [];
        for (const event of nextState) {
          if (event.id === next.id) {
            pruned.push(event);
            continue;
          }
          const startKey = startKeyForSeriesEvent(event);
          if (!startKey) {
            pruned.push(event);
            continue;
          }
          if (startKey > limitKey) {
            prunedDeletes.push(event);
            continue;
          }
          pruned.push(event);
        }
        nextState = pruned;
      }

      const existingIds = new Set(nextState.map((event) => event.id));
      const durationMs = (() => {
        if (next.kind !== "time") return 0;
        if (!next.endISO) return 0;
        const start = Date.parse(next.startISO);
        const end = Date.parse(next.endISO);
        if (Number.isNaN(start) || Number.isNaN(end)) return 0;
        return Math.max(0, end - start);
      })();

      const durationDays = (() => {
        if (next.kind !== "date") return 1;
        const endDate = next.endDate && isDateKey(next.endDate) ? next.endDate : next.startDate;
        const startParts = parseDateKey(next.startDate);
        const endParts = parseDateKey(endDate);
        if (!startParts || !endParts) return 1;
        const startUtc = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
        const endUtc = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
        if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc) || endUtc < startUtc) return 1;
        return Math.round((endUtc - startUtc) / 86400000) + 1;
      })();

      let cursorISO = baseStartISO;
      const maxInstances = Math.max(1, calendarRecurrenceLimit(rule));
      const generated: CalendarEvent[] = [];

      for (let i = 1; i < maxInstances; i++) {
        const nextISO = nextOccurrence(cursorISO, rule, next.kind === "time", timeZone);
        if (!nextISO) break;
        cursorISO = nextISO;
        const id = calendarRecurrenceInstanceId(seriesId, nextISO, rule, timeZone);
        if (existingIds.has(id)) continue;

        const nextOrder = nextOrderForCalendarBoard(next.boardId, nextState, settings.newTaskPosition);
        const instanceBase: CalendarEventBase = {
          ...(next as any),
          id,
          order: nextOrder,
          seriesId,
          recurrence: rule,
          eventKey: undefined,
          inviteTokens: undefined,
          canonicalAddress: undefined,
          viewAddress: undefined,
          inviteToken: undefined,
          inviteRelays: undefined,
        };

        const instance: CalendarEvent = next.kind === "time"
          ? {
              ...instanceBase,
              kind: "time",
              startISO: nextISO,
              ...(durationMs ? { endISO: new Date(Date.parse(nextISO) + durationMs).toISOString() } : {}),
              ...(normalizeTimeZone(next.startTzid) ? { startTzid: next.startTzid } : {}),
              ...(normalizeTimeZone(next.endTzid) ? { endTzid: next.endTzid } : {}),
            }
          : (() => {
              const startDate = isoDatePart(nextISO, "UTC");
              const endDate = durationDays > 1 ? addDaysToDateKey(startDate, durationDays - 1) : null;
              return {
                ...instanceBase,
                kind: "date",
                startDate,
                ...(endDate ? { endDate } : {}),
              } as CalendarEvent;
            })();

        const normalizedInstance = applyHiddenForCalendarEvent(
          instance,
          settings.weekStart,
          visibilityBoard?.kind ?? "week",
        );
        existingIds.add(id);
        generated.push(normalizedInstance);
        nextState = [...nextState, normalizedInstance];
      }

      if (generated.length) {
        publishBatch = [next, ...generated];
      }

      return nextState;
    });

    try {
      publishBatch.forEach((event) => {
        maybePublishCalendarEventRef.current?.(event, inviteBoard ?? undefined).catch(() => {});
      });
    } catch {}
    prunedDeletes.forEach((event) => publishCalendarEventDeleted(event).catch(() => {}));

    try {
      maybeSendCalendarEventInvites(updated, {
        previousParticipants: priorParticipants,
        forceAll: forceInviteAll,
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
    if (!nostrIdxRef.current.calendarClock.has(bTag)) nostrIdxRef.current.calendarClock.set(bTag, new Map());
    const m = nostrIdxRef.current.calendarClock.get(bTag)!;
    const last = m.get(eventId) || 0;
    const pendingKey = `${bTag}::${eventId}`;
    const isPending = pendingNostrCalendarRef.current.has(pendingKey);
    const createdAt = typeof ev.created_at === "number" ? ev.created_at : 0;
    if (createdAt < last) return;
    if (createdAt === last && isPending) return;
    m.set(eventId, createdAt);

    let payload: ReturnType<typeof parseCalendarCanonicalPayload> | null = null;
    try {
      const raw = await decryptCalendarPayloadForBoard(ev.content, boardKeys.skHex, boardKeys.pk);
      payload = parseCalendarCanonicalPayload(raw);
    } catch (err) {
      console.warn("Failed to decrypt calendar event", err);
      return;
    }
    if (!payload || payload.eventId !== eventId) return;
    if (payload.deleted) {
      if (payload.recurrence?.untilISO && payload.seriesId) {
        recordCalendarSeriesCutoff(lb.id, payload.seriesId, payload.recurrence.untilISO);
        setCalendarEvents((prev) => sanitizeCalendarEvents(prev));
      } else {
        setCalendarEvents((prev) => prev.filter((event) => event.id !== eventId));
      }
      return;
    }

    const colTag = tagValue(ev, "col");
    const orderRaw = tagValue(ev, "order");
    const order = orderRaw && Number.isFinite(Number(orderRaw)) ? Number(orderRaw) : undefined;
    const canonicalAddr = calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, eventId);
    const viewAddr = calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, boardKeys.pk, eventId);

    const parsedDocuments = normalizeDocumentList(payload.documents);
    const payloadCreatedBy = normalizeAgentPubkey(payload.createdBy);
    const payloadLastEditedBy = normalizeAgentPubkey(payload.lastEditedBy) ?? payloadCreatedBy;
    const toCommon = (): Omit<CalendarEventBase, "kind" | "startDate" | "endDate" | "startISO" | "endISO"> => ({
      id: eventId,
      boardId: lb.id,
      ...(payloadCreatedBy ? { createdBy: payloadCreatedBy } : {}),
      ...(payloadLastEditedBy ? { lastEditedBy: payloadLastEditedBy } : {}),
      columnId: (() => {
        if (!isListLikeBoard(lb)) return undefined;
        const col = colTag || "";
        return col ? col : (lb.kind === "lists" ? lb.columns[0]?.id : undefined);
      })(),
      order,
      title: payload.title || "Untitled",
      summary: payload.summary,
      description: payload.description || "",
      documents: parsedDocuments ? parsedDocuments.map(ensureDocumentPreview) : undefined,
      image: payload.image,
      locations: payload.locations?.length ? payload.locations : undefined,
      geohash: payload.geohash,
      participants: payload.participants?.length
        ? payload.participants.map((p) => ({
            pubkey: p.pubkey,
            relay: p.relay,
            role: p.role,
          }))
        : undefined,
      hashtags: payload.hashtags?.length ? payload.hashtags : undefined,
      references: payload.references?.length ? payload.references : undefined,
      eventKey: payload.eventKey,
      inviteTokens: payload.inviteTokens,
      recurrence: payload.recurrence,
      seriesId: payload.seriesId,
      canonicalAddress: canonicalAddr,
      viewAddress: viewAddr,
    });

    const nextEvent: CalendarEvent | null = (() => {
      if (payload.kind === "date") {
        if (!payload.startDate || !isDateKey(payload.startDate)) return null;
        const startDate = payload.startDate;
        const endDate = payload.endDate && isDateKey(payload.endDate) && payload.endDate >= startDate
          ? payload.endDate
          : undefined;
        return {
          ...toCommon(),
          kind: "date",
          startDate,
          ...(endDate ? { endDate } : {}),
        };
      }
      if (payload.kind !== "time") return null;
      const startISO = payload.startISO || "";
      const startMs = Date.parse(startISO);
      if (!startISO || Number.isNaN(startMs)) return null;
      const endISO = payload.endISO && Date.parse(payload.endISO) > startMs ? payload.endISO : undefined;
      const startTzid = normalizeTimeZone(payload.startTzid) ?? undefined;
      const endTzid = normalizeTimeZone(payload.endTzid) ?? undefined;
      return {
        ...toCommon(),
        kind: "time",
        startISO,
        ...(endISO ? { endISO } : {}),
        ...(startTzid ? { startTzid } : {}),
        ...(endTzid ? { endTzid } : {}),
      };
    })();

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
      const existing = idx >= 0 ? prev[idx] : null;
      let merged: CalendarEvent = {
        ...boundedEvent,
        ...(existing?.createdBy && !boundedEvent.createdBy ? { createdBy: existing.createdBy } : {}),
        ...(existing?.lastEditedBy && !boundedEvent.lastEditedBy ? { lastEditedBy: existing.lastEditedBy } : {}),
        ...(Array.isArray(existing?.reminders) && existing.reminders.length ? { reminders: existing.reminders } : {}),
        ...(existing?.reminderTime ? { reminderTime: existing.reminderTime } : {}),
        ...(!boundedEvent.recurrence && existing?.recurrence ? { recurrence: existing.recurrence } : {}),
        ...(!boundedEvent.seriesId && existing?.seriesId ? { seriesId: existing.seriesId } : {}),
        ...(existing?.hiddenUntilISO ? { hiddenUntilISO: existing.hiddenUntilISO } : {}),
        ...(typeof existing?.order === "number" && typeof boundedEvent.order !== "number" ? { order: existing.order } : {}),
      } as CalendarEvent;
      if (!existing) {
        merged = applyHiddenForCalendarEvent(merged, settings.weekStart, lb.kind);
      }
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
    setTasks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(t => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];
      const editorPubkey = normalizeAgentPubkey((window as any).nostrPK) ?? undefined;

      const updated: Task = {
        ...task,
        lastEditedBy: editorPubkey || task.lastEditedBy || task.createdBy,
      };
      const prevDue = startOfDay(new Date(task.dueISO));
      const taskTimeZone = normalizeTimeZone(task.dueTimeZone) ?? undefined;
      const originalTime = task.dueTimeEnabled ? isoTimePart(task.dueISO, taskTimeZone) : "";
      const baseWeekday = Number.isNaN(prevDue.getTime()) ? undefined : prevDue;
      const sourceBoardId = task.boardId;
      let targetBoardId = sourceBoardId;
      if (target.type === "day") {
        updated.column = "day";
        updated.columnId = undefined;
        updated.dueISO = isoForWeekday(target.day, {
          base: baseWeekday,
          weekStart: settings.weekStart,
        });
        updated.dueDateEnabled = true;
      } else {
        if (!isListLikeBoard(currentBoard)) return prev;
        const source = listColumnSources.get(target.columnId);
        if (!source) return prev;
        updated.column = undefined;
        updated.columnId = source.columnId;
        updated.boardId = source.boardId;
        targetBoardId = source.boardId;
      }
      if (originalTime) {
        const nextDatePart = isoDatePart(updated.dueISO);
        const withTime = isoFromDateTime(nextDatePart, originalTime, taskTimeZone);
        if (withTime) updated.dueISO = withTime;
      }
      const newDue = startOfDay(new Date(updated.dueISO));
      if (
        settings.streaksEnabled &&
        task.recurrence &&
        isFrequentRecurrence(task.recurrence) &&
        !task.completed &&
        newDue.getTime() > prevDue.getTime()
      ) {
        updated.streak = 0;
      }
      // reveal if user manually places it
      updated.hiddenUntilISO = undefined;

      // un-complete only if it doesn't have a pending bounty
      if (updated.completed && (!updated.bounty || updated.bounty.state === "claimed")) {
        updated.completed = false;
        updated.completedAt = undefined;
        updated.completedBy = undefined;
      }

      // remove original
      arr.splice(fromIdx, 1);

      const sortByOrder = (list: Task[]) =>
        [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      const publishSet = new Set<Task>();

      // rebalance source board (if moving across boards) using visible order
      if (sourceBoardId !== targetBoardId) {
        const sourceOrdered = sortByOrder(arr.filter((t) => t.boardId === sourceBoardId));
        sourceOrdered.forEach((t, index) => {
          if ((t.order ?? 0) !== index) {
            const idx = arr.findIndex((x) => x.id === t.id);
            if (idx >= 0) {
              arr[idx] = {
                ...t,
                order: index,
                lastEditedBy: editorPubkey || t.lastEditedBy || t.createdBy,
              };
              publishSet.add(arr[idx]);
            }
          }
        });
      }

      // compute insertion relative to the board's sorted order
      const targetOrdered = sortByOrder(
        arr.filter((t) => t.boardId === targetBoardId && t.id !== updated.id)
      );
      const beforeIdx = typeof beforeId === "string"
        ? targetOrdered.findIndex((t) => t.id === beforeId)
        : -1;
      const insertIdx = beforeIdx >= 0 ? beforeIdx : targetOrdered.length;
      targetOrdered.splice(insertIdx, 0, updated);

      // recompute order for the target board in the sorted sequence
      targetOrdered.forEach((t, index) => {
        const nextOrder = index;
        if (t.id === updated.id) {
          updated.order = nextOrder;
          return;
        }
        if ((t.order ?? 0) !== nextOrder) {
          const idx = arr.findIndex((x) => x.id === t.id);
          if (idx >= 0) {
            arr[idx] = {
              ...t,
              order: nextOrder,
              lastEditedBy: editorPubkey || t.lastEditedBy || t.createdBy,
            };
            publishSet.add(arr[idx]);
          }
        }
      });

      // ensure the moved task is present in the array
      const existingIdx = arr.findIndex((t) => t.id === updated.id);
      if (existingIdx >= 0) {
        arr[existingIdx] = updated;
      } else {
        arr.push(updated);
      }
      const persistencePlan = taskMovePersistencePlan(task, updated);
      publishSet.add(persistencePlan.targetToPublish);

      try {
        if (persistencePlan.sourceToDelete) {
          publishTaskDeleted(persistencePlan.sourceToDelete).catch(() => {});
        }
        publishSet.forEach((t) => { maybePublishTask(t).catch(() => {}); });
      } catch {}

      return arr;
    });
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
    setTasks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(t => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];
      const targetBoard = boards.find(b => b.id === boardId);
      if (!targetBoard || targetBoard.kind === "bible") return prev;
      const editorPubkey = normalizeAgentPubkey((window as any).nostrPK) ?? undefined;

      // remove from source
      arr.splice(fromIdx, 1);

      const sortByOrder = (list: Task[]) =>
        [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const publishSet = new Set<Task>();

      // recompute order for source board using the visible ordering
      const sourceOrdered = sortByOrder(arr.filter((t) => t.boardId === task.boardId));
      sourceOrdered.forEach((t, index) => {
        if ((t.order ?? 0) !== index) {
          const idx = arr.findIndex((x) => x.id === t.id);
          if (idx >= 0) {
            arr[idx] = {
              ...t,
              order: index,
              lastEditedBy: editorPubkey || t.lastEditedBy || t.createdBy,
            };
            publishSet.add(arr[idx]);
          }
        }
      });

      let destinationBoardId = boardId;
      const updated: Task = {
        ...task,
        boardId,
        lastEditedBy: editorPubkey || task.lastEditedBy || task.createdBy,
      };
      if (targetBoard.kind === "week") {
        updated.column = "day";
        updated.columnId = undefined;
      } else if (targetBoard.kind === "compound") {
        const childBoard = targetBoard.children
          .map((childId) => boards.find((b) => b.id === childId))
          .find((b): b is Extract<Board, { kind: "lists" }> => !!b && b.kind === "lists");
        if (!childBoard || !childBoard.columns.length) return prev;
        destinationBoardId = childBoard.id;
        updated.boardId = childBoard.id;
        updated.column = undefined;
        updated.columnId = childBoard.columns[0]?.id;
        updated.dueISO = isoForWeekday(0);
      } else {
        updated.column = undefined;
        updated.columnId = targetBoard.columns[0]?.id;
        updated.dueISO = isoForWeekday(0);
      }

      arr.push(updated);

      const targetBoardId = targetBoard.kind === "compound" ? destinationBoardId : boardId;
      const targetOrdered = sortByOrder(arr.filter((t) => t.boardId === targetBoardId));
      targetOrdered.forEach((t, index) => {
        const nextOrder = index;
        if (t.id === updated.id) {
          updated.order = nextOrder;
          return;
        }
        if ((t.order ?? 0) !== nextOrder) {
          const idx = arr.findIndex((x) => x.id === t.id);
          if (idx >= 0) {
            arr[idx] = {
              ...t,
              order: nextOrder,
              lastEditedBy: editorPubkey || t.lastEditedBy || t.createdBy,
            };
            publishSet.add(arr[idx]);
          }
        }
      });

      const updatedIdx = arr.findIndex((t) => t.id === updated.id);
      if (updatedIdx >= 0) arr[updatedIdx] = updated;
      const persistencePlan = taskMovePersistencePlan(task, updated);
      publishSet.add(persistencePlan.targetToPublish);

      try {
        if (persistencePlan.sourceToDelete) {
          publishTaskDeleted(persistencePlan.sourceToDelete).catch(() => {});
        }
        publishSet.forEach((t) => { maybePublishTask(t).catch(() => {}); });
      } catch {}

      return arr;
    });
  }

  const moveSelectedTasksToBoard = useCallback((boardId: string) => {
    if (!selectedTasks.length && !selectedEvents.length) return;
    selectedTasks.forEach((task) => moveTaskToBoard(task.id, boardId));
    if (selectedEvents.length) {
      setCalendarEvents((prev) => prev.map((ev) => {
        if (!selectedItemIdSet.has(ev.id)) return ev;
        if (ev.boardId !== boardId) publishCalendarEventDeleted(ev).catch(() => {});
        const updated: CalendarEvent = { ...ev, boardId, originBoardId: undefined, columnId: undefined };
        maybePublishCalendarEvent(updated).catch(() => {});
        return updated;
      }));
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
    const editorPubkey = normalizeAgentPubkey((window as any).nostrPK) ?? undefined;
    if (selectedTasks.length) {
      selectedTasks.forEach((task) => {
        setTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === task.id);
          if (idx < 0) return prev;
          const copy = [...prev];
          const source = copy[idx];
          const updated: Task = {
            ...source,
            boardId,
            column: undefined,
            columnId,
            lastEditedBy: editorPubkey || source.lastEditedBy || source.createdBy,
          };
          copy[idx] = updated;
          const persistencePlan = taskMovePersistencePlan(source, updated);
          if (persistencePlan.sourceToDelete) {
            publishTaskDeleted(persistencePlan.sourceToDelete).catch(() => {});
          }
          maybePublishTask(persistencePlan.targetToPublish).catch(() => {});
          return copy;
        });
      });
    }
    if (selectedEvents.length) {
      setCalendarEvents((prev) => prev.map((ev) => {
        if (!selectedItemIdSet.has(ev.id)) return ev;
        if (ev.boardId !== boardId) publishCalendarEventDeleted(ev).catch(() => {});
        const updated: CalendarEvent = { ...ev, boardId, originBoardId: undefined, columnId };
        maybePublishCalendarEvent(updated).catch(() => {});
        return updated;
      }));
    }
    const boardName = board?.name || "board";
    const colName = col?.name || "list";
    const totalMoved = selectedTasks.length + selectedEvents.length;
    showToast(totalMoved === 1 ? `Item moved to ${colName} in ${boardName}` : `${totalMoved} items moved to ${colName} in ${boardName}`);
    exitSelectionMode();
    setSelectionMoveSheetOpen(false);
    setSelectionMoveStep("board");
    setSelectionMoveBoardId(null);
	  }, [boards, exitSelectionMode, maybePublishCalendarEvent, maybePublishTask, selectedEvents, selectedItemIdSet, selectedTasks, setCalendarEvents, setTasks, showToast]);

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
    nostrIdxRef,
    boardSyncCursorsRef,
    relayBatchRef,
    pendingRelaysByBoardRef,
    seenBoardTasksRef,
    pendingNostrTasksRef,
    completedNostrInitialSyncRef,
    setPendingNostrInitialSyncByBoardTag,
    markNostrBoardInitialSyncComplete,
    tagValue,
    applyBoardEvent,
    applyTaskEvent,
    applyCalendarEvent,
    fullHistorySyncNonce: boardHistoryResyncNonce,
  });

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
    <div className="min-h-screen text-primary">
      <div className="app-shell mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {(activePage === "boards" || activePage === "upcoming" || activePage === "wallet-bounties" || activePage === "wallet-address" || activePage === "settings") && (
          <header className="app-header">
            {activePage === "boards" && (
              <>
                <div className="app-header__left">
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
                                      const allIds = getDraggedTaskIds(e.dataTransfer);
                                      if (allIds && allIds.length > 1) {
                                        allIds.forEach((taskId) => moveTaskToBoard(taskId, b.id));
                                        if (isSelectionMode) exitSelectionMode();
                                      } else {
                                        moveTaskToBoard(draggingTaskId, b.id);
                                      }
                                      handleDragEnd();
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
                <div className="app-header__right">
	                  <button
	                    type="button"
	                    className="app-header__icon-btn pressable"
	                    onClick={() => handleUpcomingViewChange(upcomingView === "list" ? "details" : "list")}
	                    title="Change upcoming view"
	                    aria-label="Change upcoming view"
	                    data-active={upcomingView === "list"}
	                  >
                    {upcomingView === "list" ? (
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
                        <rect x="4" y="5" width="16" height="15" rx="2" />
                        <path d="M8 3v4" />
                        <path d="M16 3v4" />
                        <path d="M4 11h16" />
                        <path d="M12 14v3l2 1" />
                      </svg>
                    ) : (
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
                        <line x1="5" y1="6" x2="21" y2="6" />
                        <line x1="5" y1="12" x2="21" y2="12" />
                        <line x1="5" y1="18" x2="21" y2="18" />
                        <circle cx="3" cy="6" r="1" />
                        <circle cx="3" cy="12" r="1" />
                        <circle cx="3" cy="18" r="1" />
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    className="app-header__icon-btn pressable"
                    onClick={() => setUpcomingSortSheetOpen(true)}
                    title="Sort upcoming tasks"
                    aria-label="Sort upcoming tasks"
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
                  <button
                    type="button"
                    className="app-header__icon-btn pressable"
                    onClick={openUpcomingSearch}
                    title="Search upcoming tasks"
                    aria-label="Search upcoming tasks"
                    data-active={showUpcomingSearch}
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
                      <circle cx="11" cy="11" r="7" />
                      <line x1="16.65" y1="16.65" x2="21" y2="21" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="app-header__icon-btn app-header__icon-btn--accent pressable"
                    onClick={openUpcomingTaskEditor}
                    title="Add task"
                    aria-label="Add task"
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                </div>
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

        {showSkBackupNotice && (
          <div className="sk-backup-banner" role="alert">
            <div className="sk-backup-banner__body">
              <span className="sk-backup-banner__dot" aria-hidden="true" />
              <span>
                Your Nostr key is now encrypted on this device. Save your <strong>nsec</strong> somewhere safe so you can recover your account if this device is lost.
              </span>
            </div>
            <div className="sk-backup-banner__actions">
              <button type="button" className="sk-backup-banner__primary pressable" onClick={copyNsecAndDismiss}>
                Copy nsec
              </button>
              <button type="button" className="sk-backup-banner__secondary pressable" onClick={dismissSkBackupNotice}>
                Got it
              </button>
            </div>
          </div>
        )}

        {/* Animation overlay for fly effects (coins, etc.) */}
        <div ref={flyLayerRef} className="pointer-events-none fixed inset-0 z-[9999]" />

        <div
          className={`app-content${activePage === "upcoming" && upcomingView === "list" ? " app-content--locked" : ""}`}
          ref={appContentRef}
        >
        {activePage === "boards" && (
        <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Board/Completed */}
          {activeView === "bible" ? (
            settings.bibleTrackerEnabled ? (
              <div
                ref={bibleScrollerRef}
                className="overflow-x-auto pb-4 w-full"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                <div className="flex min-w-max items-start gap-4">
                  <div className="surface-panel board-column w-[360px] shrink-0 overflow-hidden">
                    <div className="p-4">
                      <BibleTracker
                        state={bibleTracker}
                        onToggleBook={handleToggleBibleBook}
                        onToggleChapter={handleToggleBibleChapter}
                        onUpdateChapterVerses={handleUpdateBibleChapterVerses}
                        onReset={handleResetBibleTracker}
                        onOpenPrint={handleOpenBiblePrint}
                        onOpenScan={handleOpenBibleScan}
                        onDeleteArchive={handleDeleteBibleArchive}
                        onRestoreArchive={handleRestoreBibleArchive}
                        onCompleteBook={handleCompleteBibleBook}
                      />
                    </div>
                  </div>
                  {settings.scriptureMemoryEnabled ? (
                    <ScriptureMemoryCard
                      items={scriptureMemoryItems}
                      onAdd={handleAddScriptureMemory}
                      onRemove={handleRemoveScriptureMemory}
                      onReview={handleReviewScriptureMemory}
                      boardName={scriptureMemoryBoard?.name || undefined}
                      frequencyLabel={scriptureMemoryFrequencyOption?.label ?? "Daily"}
                      sortLabel={scriptureMemorySortLabel}
                    />
                  ) : (
                    <div className="surface-panel board-column w-[360px] shrink-0 p-4 text-sm text-secondary">
                      Enable scripture memory from Settings to start adding passages you want to review.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="surface-panel p-6 text-center text-sm text-secondary">
                Enable the Bible tracker from Settings to start tracking your reading.
              </div>
            )
          ) : activeView === "board" ? (
            !currentBoard ? (
              <div className="surface-panel p-6 text-center text-sm text-secondary">No boards. Open Settings to create one.</div>
            ) : currentBoard?.kind === "week" ? (
              <>
              {/* HORIZONTAL board: single row, side-scroll */}
              <div
                ref={scrollerRef}
                className={`flex-1 min-h-0 overflow-x-auto pb-0 w-full${isSelectionMode ? ' board-selection-pad' : ''}`}
                style={{ WebkitOverflowScrolling: "touch" }} // fluid momentum scroll on iOS
              >
                <div className="flex gap-4 min-w-max h-full items-stretch">
                  {Array.from({ length: 7 }, (_, i) => i as Weekday).map((day) => (
                    <DroppableColumn
                      ref={el => setColumnRef(`week-day-${day}`, el)}
                      key={day}
                      title={WD_SHORT[day]}
                    onTitleClick={() => setDayChoice(day)}
                    onDropCard={(payload) => {
                      const ids = payload.allIds ?? [payload.id];
                      ids.forEach((taskId) => moveTask(taskId, { type: "day", day }, taskId === payload.id ? payload.beforeId : undefined));
                      if (isSelectionMode && payload.allIds) exitSelectionMode();
                    }}
                    onDropEnd={handleDragEnd}
                    onSelectAll={isSelectionMode ? () => toggleGroupSelection(weekDayGroupIds(day)) : undefined}
                    selectionState={isSelectionMode ? groupSelectionState(weekDayGroupIds(day)) : undefined}
                    data-day={day}
                    scrollable
                    footer={(
                      <form
                        className="mt-2 flex gap-1"
                        onSubmit={(e) => { e.preventDefault(); addInlineTask(String(day)); }}
                      >
                        <input
                          ref={el => setInlineInputRef(String(day), el)}
                          value={inlineTitles[String(day)] || ""}
                          onChange={(e) => setInlineTitles(prev => ({ ...prev, [String(day)]: e.target.value }))}
                          className="pill-input pill-input--compact flex-1 min-w-0"
                          placeholder="New Task"
                        />
                        <button
                          type="submit"
                          className="accent-button accent-button--circle pressable shrink-0"
                          aria-label="Add task"
                        >
                          <span aria-hidden="true">+</span>
                          <span className="sr-only">Add task</span>
                        </button>
                      </form>
                    )}
	                  >
	                        {(calendarByDay.get(day) || []).map((ev) => (
		                          <EventCard
		                            key={`${ev.id}-${day}`}
		                            event={ev}
		                            syncPending={pendingNostrCalendarEventIds.has(ev.id)}
		                            showDate={false}
		                            onOpenDocument={(event, doc) => handleOpenEventDocument(doc, event.boardId)}
		                            onEdit={() => setEditing({ type: "event", originalType: "event", originalId: ev.id, event: ev })}
		                            onDragStart={(id) => setDraggingEventId(id)}
		                            onDragEnd={handleDragEnd}
                            isSelectionMode={isSelectionMode}
                            isSelected={selectedItemIds.includes(ev.id)}
                            onToggleSelect={toggleItemSelection}
		                          />
	                        ))}
	                        {(byDay.get(day) || []).map((t) => (
	                        <Card
                            isSelectionMode={isSelectionMode}
                            isSelected={selectedItemIds.includes(t.id)}
                            onToggleSelect={toggleItemSelection}
                            selectedTaskIds={isSelectionMode ? selectedItemIds : undefined}
                            key={t.id}
                            syncPending={pendingNostrTaskIds.has(t.id)}
                            task={t}
	                          onFlyToCompleted={(rect) => { if (settings.completedTab) flyToCompleted(rect); }}
                          onComplete={(from) => {
                            if (!t.completed) completeTask(t.id);
                            else if (t.bounty && t.bounty.state === 'locked') revealBounty(t.id);
                            else if (t.bounty && t.bounty.state === 'unlocked' && t.bounty.token) claimBounty(t.id, from);
                            else restoreTask(t.id);
                          }}
                          onEdit={() => setEditing({ type: "task", originalType: "task", originalId: t.id, task: t })}
                          onDropBefore={(dragId) => moveTask(dragId, { type: "day", day }, t.id)}
                          showStreaks={settings.streaksEnabled}
                          onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
                          onDragStart={(id) => setDraggingTaskId(id)}
                          onDragEnd={handleDragEnd}
                          hideCompletedSubtasks={settings.hideCompletedSubtasks}
                          onOpenDocument={handleOpenDocument}
                          onDismissInbox={
                            t.inboxItem ? () => completeTask(t.id, { inboxAction: "dismiss" }) : undefined
                          }
                        />
                      ))}
                    </DroppableColumn>
                  ))}
                </div>
              </div>
            </>
            ) : currentBoard?.kind === "bible" ? (
            <div
              ref={bibleScrollerRef}
              className="overflow-x-auto pb-4 w-full"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="flex min-w-max items-start gap-4">
                <div className="surface-panel board-column w-[360px] shrink-0 overflow-hidden">
                  <div className="p-4">
                    <BibleTracker
                      state={bibleTracker}
                      onToggleBook={handleToggleBibleBook}
                      onToggleChapter={handleToggleBibleChapter}
                      onUpdateChapterVerses={handleUpdateBibleChapterVerses}
                      onReset={handleResetBibleTracker}
                      onOpenPrint={handleOpenBiblePrint}
                      onOpenScan={handleOpenBibleScan}
                      onDeleteArchive={handleDeleteBibleArchive}
                      onRestoreArchive={handleRestoreBibleArchive}
                      onCompleteBook={handleCompleteBibleBook}
                    />
                  </div>
                </div>
                {settings.scriptureMemoryEnabled ? (
                  <ScriptureMemoryCard
                    items={scriptureMemoryItems}
                    onAdd={handleAddScriptureMemory}
                    onRemove={handleRemoveScriptureMemory}
                    onReview={handleReviewScriptureMemory}
                    boardName={scriptureMemoryBoard?.name || undefined}
                    frequencyLabel={scriptureMemoryFrequencyOption?.label ?? "Daily"}
                    sortLabel={scriptureMemorySortLabel}
                  />
                ) : (
                  <div className="surface-panel board-column w-[360px] shrink-0 p-4 text-sm text-secondary">
                    Enable scripture memory from Settings to start adding passages you want to review.
                  </div>
                )}
              </div>
            </div>
            ) : (
              // LISTS board (multiple custom columns) — still a horizontal row
              <div
                ref={scrollerRef}
                className={`flex-1 min-h-0 overflow-x-auto pb-0 w-full${isSelectionMode ? ' board-selection-pad' : ''}`}
                style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="flex gap-4 min-w-max h-full items-stretch">
                {currentBoard.indexCardEnabled && (
                  <div
                    ref={el => setColumnRef("list-index", el)}
                    className="board-column surface-panel w-[325px] shrink-0 p-3 flex h-full flex-col"
                  >
                    <div className="mb-3 text-sm font-semibold tracking-wide text-secondary">Index</div>
                    <div className="flex flex-1 min-h-0 flex-col gap-1.5 overflow-y-auto pr-1">
                      {listColumns.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-surface bg-surface-muted px-3 py-6 text-center text-sm text-secondary">
                          No lists yet.
                        </div>
                      ) : currentBoard.kind === "compound" ? (
                        (() => {
                          let indexCounter = 0;
                          const hideNames = currentBoard.hideChildBoardNames;
                          return compoundIndexGroups.map((group, groupIndex) => (
                            <div key={group.key} className="space-y-1.5" data-group-index={groupIndex}>
                              {!hideNames && (
                                <div className={`px-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-secondary/70 ${groupIndex > 0 ? "mt-2" : ""}`}>
                                  {group.boardName}
                                </div>
                              )}
                              {group.columns.map((col) => {
                                const order = ++indexCounter;
                                const active = dayChoice === col.id;
                                const baseClass =
                                  "pressable flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition";
                                const stateClass = active
                                  ? "border-accent/60 bg-accent/15 text-primary"
                                  : "border-surface bg-surface-muted text-secondary hover:bg-surface hover:text-primary";
                                const source = listColumnSources.get(col.id);
                                const title = source ? `${source.boardName} • ${col.name}` : col.name;
                                return (
                                  <button
                                    key={col.id}
                                    type="button"
                                    className={`${baseClass} ${stateClass}`}
                                    onClick={() => focusListColumn(col.id)}
                                    aria-current={active ? "true" : undefined}
                                    title={title}
                                  >
                                    <span className="truncate">{col.name}</span>
                                    <span className={active ? "text-xs text-primary/80" : "text-xs text-secondary"}>{order}</span>
                                  </button>
                                );
                              })}
                            </div>
                          ));
                        })()
                      ) : (
                        listColumns.map((col, idx) => {
                          const active = dayChoice === col.id;
                          const baseClass =
                            "pressable flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition";
                          const stateClass = active
                            ? "border-accent/60 bg-accent/15 text-primary"
                            : "border-surface bg-surface-muted text-secondary hover:bg-surface hover:text-primary";
                          return (
                            <button
                              key={col.id}
                              type="button"
                              className={`${baseClass} ${stateClass}`}
                              onClick={() => focusListColumn(col.id)}
                              aria-current={active ? "true" : undefined}
                              title={col.name}
                            >
                              <span className="truncate">{col.name}</span>
                              <span className={active ? "text-xs text-primary/80" : "text-xs text-secondary"}>{idx + 1}</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
                {listColumns.map(col => {
                  const isRenaming = renamingColumnId === col.id;
                  const draftName = columnDrafts[col.id] ?? col.name;
                  const header = isRenaming ? (
                    <form
                      className="mb-3 flex items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        commitRenameColumn(col.id);
                      }}
                    >
                      <input
                        ref={(el) => setColumnNameInputRef(col.id, el)}
                        value={draftName}
                        onChange={(e) =>
                          setColumnDrafts((prev) => ({ ...prev, [col.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelRenameColumn(col.id);
                          }
                        }}
                        className="w-[190px] max-w-full bg-transparent text-sm font-semibold tracking-wide text-primary focus:outline-none border-b border-white/10 focus:border-white/30 pb-1"
                        placeholder="List name"
                      />
                      <button
                        type="submit"
                        className="h-9 w-9 rounded-full border border-white/20 bg-white/15 text-lg font-semibold text-primary flex items-center justify-center hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent"
                        aria-label="Save list name"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="ml-auto text-[11px] font-medium text-secondary hover:text-primary"
                        onClick={() => cancelRenameColumn(col.id)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : undefined;
                  return (
                    <DroppableColumn
                      ref={el => setColumnRef(`list-${col.id}`, el)}
                      key={col.id}
                      title={draftName}
                      header={header}
                      onTitleClick={() => focusListColumn(col.id)}
                      onDropCard={(payload) => {
                        const ids = payload.allIds ?? [payload.id];
                        ids.forEach((taskId) => moveTask(taskId, { type: "list", columnId: col.id }, taskId === payload.id ? payload.beforeId : undefined));
                        if (isSelectionMode && payload.allIds) exitSelectionMode();
                      }}
                      onDropEnd={handleDragEnd}
                      onSelectAll={isSelectionMode ? () => toggleGroupSelection(listColumnGroupIds(col.id)) : undefined}
                      selectionState={isSelectionMode ? groupSelectionState(listColumnGroupIds(col.id)) : undefined}
                      scrollable
                      footer={(
                        <form
                          className="mt-2 flex gap-1"
                          onSubmit={(e) => { e.preventDefault(); addInlineTask(col.id); }}
                        >
                          <input
                            ref={el => setInlineInputRef(col.id, el)}
                            value={inlineTitles[col.id] || ""}
                            onChange={(e) => setInlineTitles(prev => ({ ...prev, [col.id]: e.target.value }))}
                            className="pill-input pill-input--compact flex-1 min-w-0"
                            placeholder="New Task"
                          />
                          <button
                            type="submit"
                            className="accent-button accent-button--circle pressable shrink-0"
                            aria-label="Add task"
                          >
                            <span aria-hidden="true">+</span>
                            <span className="sr-only">Add task</span>
                          </button>
                        </form>
                      )}
	                    >
	                      {(calendarItemsByColumn.get(col.id) || []).map((ev) => (
		                        <EventCard
		                          key={ev.id}
		                          event={ev}
		                          syncPending={pendingNostrCalendarEventIds.has(ev.id)}
		                          showDate
		                          onOpenDocument={(event, doc) => handleOpenEventDocument(doc, event.boardId)}
		                          onEdit={() => setEditing({ type: "event", originalType: "event", originalId: ev.id, event: ev })}
		                          onDragStart={(id) => setDraggingEventId(id)}
		                          onDragEnd={handleDragEnd}
                          isSelectionMode={isSelectionMode}
                          isSelected={selectedItemIds.includes(ev.id)}
                          onToggleSelect={toggleItemSelection}
		                        />
	                      ))}
	                      {(itemsByColumn.get(col.id) || []).map((t) => (
	                        <Card
                            isSelectionMode={isSelectionMode}
                            isSelected={selectedItemIds.includes(t.id)}
                            onToggleSelect={toggleItemSelection}
                            selectedTaskIds={isSelectionMode ? selectedItemIds : undefined}
                            key={t.id}
                            syncPending={pendingNostrTaskIds.has(t.id)}
                            task={t}
                          onFlyToCompleted={(rect) => { if (settings.completedTab) flyToCompleted(rect); }}
                          onComplete={(from) => {
                            if (!t.completed) completeTask(t.id);
                            else if (t.bounty && t.bounty.state === 'locked') revealBounty(t.id);
                            else if (t.bounty && t.bounty.state === 'unlocked' && t.bounty.token) claimBounty(t.id, from);
                            else restoreTask(t.id);
                          }}
                          onEdit={() => setEditing({ type: "task", originalType: "task", originalId: t.id, task: t })}
                          onDropBefore={(dragId) => moveTask(dragId, { type: "list", columnId: col.id }, t.id)}
                          showStreaks={settings.streaksEnabled}
                          onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
                          onDragStart={(id) => setDraggingTaskId(id)}
                          onDragEnd={handleDragEnd}
                          hideCompletedSubtasks={settings.hideCompletedSubtasks}
                          onOpenDocument={handleOpenDocument}
                          onDismissInbox={
                            t.inboxItem ? () => completeTask(t.id, { inboxAction: "dismiss" }) : undefined
                          }
                        />
                      ))}
                    </DroppableColumn>
                  );
                })}
                {currentBoard.kind === "lists" && (
                  <div className="board-column surface-panel w-[325px] shrink-0 p-4 flex h-full flex-col gap-4">
                    <div className="flex-1 rounded-3xl border border-white/5 bg-white/5 backdrop-blur-sm shadow-inner flex flex-col items-center justify-center gap-3 text-center p-6">
                      <div className="text-base font-semibold">Add list</div>
                      <button
                        type="button"
                        className="w-16 h-16 rounded-full border border-white/20 bg-white/15 backdrop-blur-lg shadow-lg flex items-center justify-center text-2xl text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent"
                        onClick={handleQuickAddList}
                        aria-label="Add list"
                      >
                        +
                      </button>
                      <div className="text-sm text-secondary max-w-[240px]">
                        Build an empty board and drop your first tasks here.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        ) : activeView === "board-upcoming" ? (
          <BoardUpcomingView
            boardUpcomingCount={boardUpcomingCount}
            boardUpcomingGroups={boardUpcomingGroups}
            renderUpcomingEventCard={renderUpcomingEventCard}
            renderUpcomingTaskCard={renderUpcomingTaskCard}
          />
        ) : (
          <CompletedBoardView
            clearCompleted={clearCompleted}
            completed={completed}
            completedBibleBooks={completedBibleBooks}
            currentBoard={currentBoard}
            deleteTask={deleteTask}
            handleOpenDocument={handleOpenDocument}
            handleRestoreBibleBook={handleRestoreBibleBook}
            restoreTask={restoreTask}
            streaksEnabled={settings.streaksEnabled}
          />
        )}
        </div>
      )}
      {activePage === "upcoming" && (
        <>
          {showUpcomingSearch && (
            <UpcomingSearch
              inputRef={upcomingSearchInputRef}
              value={upcomingSearch}
              onChange={setUpcomingSearch}
              onClose={closeUpcomingSearch}
            />
          )}
          {upcomingView === "list" ? (
            <div className="upcoming-list-view">
              <div className="surface-panel upcoming-list-view__calendar">
                <div className="upcoming-calendar">
                  <div className="upcoming-calendar__header">
                    <button
                      type="button"
                      className="ghost-button button-sm pressable"
                      onClick={() => moveUpcomingListMonth(-1)}
                      aria-label="Previous month"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      className="upcoming-calendar__title upcoming-calendar__title-button"
                      onClick={handleUpcomingListMonthLabelClick}
                      onTouchStart={(event) => {
                        event.preventDefault();
                        handleUpcomingListMonthLabelClick();
                      }}
                      aria-label="Select month and year"
                      aria-expanded={upcomingListMonthPickerOpen}
                    >
                      {upcomingListMonthLabel}
                    </button>
                    <button
                      type="button"
                      className="ghost-button button-sm pressable"
                      onClick={() => moveUpcomingListMonth(1)}
                      aria-label="Next month"
                    >
                      ›
                    </button>
                  </div>
                  {upcomingListMonthPickerOpen && (
                    <div className="edit-month-picker">
                      <div
                        className="edit-month-picker__column"
                        ref={upcomingListMonthPickerMonthColumnRef}
                        onScroll={handleUpcomingListMonthPickerMonthScroll}
                        role="listbox"
                        aria-label="Select month"
                      >
                        {MONTH_NAMES.map((name, idx) => (
                          <div
                            key={name}
                            className={`edit-month-picker__option ${upcomingListMonthPickerMonth === idx ? "is-active" : ""}`}
                            data-picker-index={idx}
                            role="option"
                            aria-selected={upcomingListMonthPickerMonth === idx}
                          >
                            {name.slice(0, 3)}
                          </div>
                        ))}
                      </div>
                      <div
                        className="edit-month-picker__column"
                        ref={upcomingListMonthPickerYearColumnRef}
                        onScroll={handleUpcomingListMonthPickerYearScroll}
                        role="listbox"
                        aria-label="Select year"
                      >
                        {upcomingListMonthPickerYears.map((year, idx) => (
                          <div
                            key={year}
                            className={`edit-month-picker__option ${upcomingListMonthPickerYear === year ? "is-active" : ""}`}
                            data-picker-index={idx}
                            role="option"
                            aria-selected={upcomingListMonthPickerYear === year}
                          >
                            {year}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="upcoming-calendar__weekdays">
                    {WD_SHORT.map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                  <div
                    className="upcoming-calendar__grid"
                    onTouchStart={handleUpcomingCalendarTouchStart}
                    onTouchEnd={handleUpcomingCalendarTouchEnd}
                  >
                    {upcomingListCalendar.cells.map((cell, idx) => {
                      if (!cell) {
                        return (
                          <span
                            key={`empty-${idx}`}
                            className="upcoming-calendar__day upcoming-calendar__day--muted"
                          />
	                      );
	                    }
	                    const currentViewDate = new Date(
	                      upcomingListCalendar.year,
	                      upcomingListCalendar.month,
	                      cell,
	                    );
	                    const dateKey = isoDatePart(currentViewDate.toISOString());
	                    const hasItems = upcomingListDayMap.has(dateKey);
	                    const isSelected =
	                      !!upcomingListSelectedDate &&
	                      upcomingListSelectedDate.getFullYear() === upcomingListCalendar.year &&
	                      upcomingListSelectedDate.getMonth() === upcomingListCalendar.month &&
                        upcomingListSelectedDate.getDate() === cell;
                      const isToday =
                        !isSelected &&
                        upcomingListToday.getFullYear() === currentViewDate.getFullYear() &&
                        upcomingListToday.getMonth() === currentViewDate.getMonth() &&
                        upcomingListToday.getDate() === currentViewDate.getDate();
	                    const dayCls = [
	                      "upcoming-calendar__day",
	                      hasItems ? "upcoming-calendar__day--has-dot" : "",
	                      isSelected ? "upcoming-calendar__day--selected" : "",
	                      isToday ? "upcoming-calendar__day--today" : "",
	                    ]
	                      .filter(Boolean)
                        .join(" ");
                      return (
                        <button
                          key={`day-${idx}-${cell}`}
                          type="button"
                          className={dayCls}
                          onClick={() => handleUpcomingListDaySelect(cell)}
                        >
                          <span className="upcoming-calendar__day-number">{cell}</span>
                          <span className="upcoming-calendar__dot" aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </div>
	            </div>
	            <div className="upcoming-list-view__tasks">
	              {upcomingListTasks.length + upcomingListEvents.length === 0 ? (
	                <div className="text-sm text-secondary">
	                  {filteredUpcomingCount === 0 ? "No upcoming items." : "No items scheduled for this day."}
	                </div>
	              ) : (
	                <div className="space-y-2">
	                  {upcomingListEvents.map((ev) => renderUpcomingEventCard(ev))}
	                  {upcomingListTasks.map((task) => renderUpcomingTaskCard(task))}
	                </div>
	              )}
	            </div>
	          </div>
	        ) : filteredUpcomingCount === 0 ? (
	          <div className="surface-panel p-6 text-center text-sm text-secondary">No upcoming items.</div>
	        ) : (
	          // Virtualized grouped upcoming list (Item #11). Total height set
	          // by virtualizer; rows are absolutely positioned via translateY
	          // so only ~visible items live in the DOM. `data-upcoming-date`
	          // attributes on rendered headers preserve the existing
	          // `getFocusedUpcomingDateFromScroll` lookup for the visible
	          // viewport; offscreen days are reachable via
	          // `scrollUpcomingToDate` which routes through
	          // `virtualizer.scrollToIndex`.
	          <div
	            className="upcoming-list"
	            ref={upcomingListRef}
	            style={{ height: upcomingVirtualizer.getTotalSize(), position: "relative", width: "100%" }}
	          >
	            {upcomingVirtualizer.getVirtualItems().map((virtualRow) => {
	              const row = upcomingFlatRows[virtualRow.index];
	              if (!row) return null;
	              const key =
	                row.kind === "day-header"
	                  ? `header-${row.dateKey}`
	                  : row.kind === "event"
	                  ? `event-${row.event.id}`
	                  : `task-${row.task.id}`;
	              return (
	                <div
	                  key={key}
	                  ref={upcomingVirtualizer.measureElement}
	                  data-index={virtualRow.index}
	                  data-upcoming-date={row.kind === "day-header" ? row.dateKey : undefined}
	                  style={{
	                    position: "absolute",
	                    top: 0,
	                    left: 0,
	                    width: "100%",
	                    transform: `translateY(${virtualRow.start}px)`,
	                  }}
	                >
	                  {row.kind === "day-header" ? (
	                    <div className="upcoming-day__label">{row.label}</div>
	                  ) : row.kind === "event" ? (
	                    renderUpcomingEventCard(row.event)
	                  ) : (
	                    renderUpcomingTaskCard(row.task)
	                  )}
	                </div>
	              );
	            })}
	          </div>
	        )}
        </>
      )}
      {activePage === "wallet-bounties" && (
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
      )}
      {activePage === "wallet-address" && (
        <WalletAddressView
          settings={settings}
          setSettings={setSettings}
          defaultRelays={defaultRelays}
        />
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
            workerBaseUrl={workerBaseUrl}
            vapidPublicKey={vapidPublicKey}
            onResetWalletTokenTracking={handleResetWalletTokenTracking}
            onShareBoard={enableBoardSharing}
            onJoinBoard={joinSharedBoard}
            onRegenerateBoardId={regenerateBoardId}
            onBoardChanged={handleBoardChanged}
            onResyncBoardHistory={handleResyncBoardHistory}
            onClose={closeSettings}
          />
        </Suspense>
      )}
      </div>

      {activePage === "upcoming" && (
        <UpcomingControls
          todayDisabled={upcomingView === "details" && upcomingGroups.length === 0}
          onTodayClick={handleUpcomingToday}
          filterActive={upcomingFilter !== null || upcomingFilterOpen}
          filterLabel={upcomingFilterLabel}
          onOpenFilter={() => setUpcomingFilterOpen(true)}
        />
      )}

      <div className="app-tab-switcher">
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
      </div>

      <AppSortSheets
        applyUpcomingFilterPreset={applyUpcomingFilterPreset}
        boardSort={boardSort}
        boardSortOptions={boardSortOptions}
        boardSortSheetOpen={boardSortSheetOpen}
        cancelUpcomingPresetHold={cancelUpcomingPresetHold}
        handleBoardSortSelect={handleBoardSortSelect}
        handleUpcomingSortSelect={handleUpcomingSortSelect}
        handleUpcomingViewChange={handleUpcomingViewChange}
        maybeCancelUpcomingPresetHold={maybeCancelUpcomingPresetHold}
        saveUpcomingFilterPreset={saveUpcomingFilterPreset}
        setBoardSortSheetOpen={setBoardSortSheetOpen}
        setUpcomingBoardGrouping={setUpcomingBoardGrouping}
        setUpcomingFilter={setUpcomingFilter}
        setUpcomingFilterOpen={setUpcomingFilterOpen}
        setUpcomingSortSheetOpen={setUpcomingSortSheetOpen}
        setUpcomingUsHolidaysEnabled={setUpcomingUsHolidaysEnabled}
        setUpcomingViewSheetOpen={setUpcomingViewSheetOpen}
        startUpcomingPresetHold={startUpcomingPresetHold}
        toggleUpcomingFilter={toggleUpcomingFilter}
        upcomingBoardGrouping={upcomingBoardGrouping}
        upcomingBoardGroupingOptions={upcomingBoardGroupingOptions}
        upcomingFilterGroups={upcomingFilterGroups}
        upcomingFilterOpen={upcomingFilterOpen}
        upcomingFilterPresets={upcomingFilterPresets}
        upcomingFilterSelection={upcomingFilterSelection}
        upcomingPresetHoldTriggeredRef={upcomingPresetHoldTriggeredRef}
        upcomingSort={upcomingSort}
        upcomingSortSheetOpen={upcomingSortSheetOpen}
        upcomingUsHolidaysEnabled={upcomingUsHolidaysEnabled}
        upcomingView={upcomingView}
        upcomingViewSheetOpen={upcomingViewSheetOpen}
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
            completeFirstRunOnboarding={completeFirstRunOnboarding}
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
            handleOnboardingEnableNotifications={handleOnboardingEnableNotifications}
            handleOnboardingGenerateNewKey={handleOnboardingGenerateNewKey}
            handleOnboardingRestoreFromBackupFile={handleOnboardingRestoreFromBackupFile}
            handleOnboardingUseExistingKey={handleOnboardingUseExistingKey}
            handlePrintBibleWindow={handlePrintBibleWindow}
            handlePrintBoardWindow={handlePrintBoardWindow}
            joinSharedBoard={joinSharedBoard}
            onboardingPushConfigured={onboardingPushConfigured}
            onboardingPushSupported={onboardingPushSupported}
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
                      const relayCandidates = activeEventRsvpRelays.length
                        ? activeEventRsvpRelays
                        : [
                            ...defaultRelays,
                            ...inboxRelays,
                            ...Array.from(DEFAULT_NOSTR_RELAYS),
                          ];
                      const relays = Array.from(new Set(relayCandidates.map((relay) => relay.trim()).filter(Boolean)));
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

      <CashuWalletShell
        acceptInboxMessage={acceptInboxMessage}
        closeWallet={closeWallet}
        declineInboxMessage={declineInboxMessage}
        dismissCalendarInvite={dismissCalendarInvite}
        dismissInboxMessage={dismissInboxMessage}
        formatCalendarInviteWhen={formatCalendarInviteWhen}
        handleCalendarInviteRsvp={handleCalendarInviteRsvp as unknown as (invite: any, status: string) => void}
        inboxPendingItems={inboxPendingItems}
        markInboxMessagesRead={markInboxMessagesRead}
        maybeInboxMessage={maybeInboxMessage}
        messagesUnreadCount={messagesUnreadCount}
        openWalletBounties={openWalletBounties}
        openWalletAddress={openWalletAddress}
        pendingCalendarInvites={pendingCalendarInvites}
        setDmUnreadCount={setDmUnreadCount}
        setSettings={setSettings}
        settings={settings}
        showChat={showChat}
        showWalletShell={showWalletShell}
        walletMessageItems={walletMessageItems}
        walletTokenStateResetNonce={walletTokenStateResetNonce}
      />

      <InlineTaskOverlays
        addMenuKey={addMenuKey}
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
  );
}

function hiddenUntilForBoard(dueISO: string, boardKind: Board["kind"], weekStart: Weekday): string | undefined {
  const dueDate = startOfDay(new Date(dueISO));
  if (Number.isNaN(dueDate.getTime())) return undefined;
  const today = startOfDay(new Date());
  if (boardKind === "lists" || boardKind === "compound") {
    return dueDate.getTime() > today.getTime() ? dueDate.toISOString() : undefined;
  }
  const nowSow = startOfWeek(new Date(), weekStart);
  const dueSow = startOfWeek(dueDate, weekStart);
  return dueSow.getTime() > nowSow.getTime() ? dueSow.toISOString() : undefined;
}

function applyHiddenForFuture(task: Task, weekStart: Weekday, boardKind: Board["kind"]): void {
  if (task.dueDateEnabled === false) {
    task.hiddenUntilISO = undefined;
    return;
  }
  task.hiddenUntilISO = hiddenUntilForBoard(task.dueISO, boardKind, weekStart);
}

function applyHiddenForCalendarEvent(event: CalendarEvent, weekStart: Weekday, boardKind: Board["kind"]): CalendarEvent {
  const hiddenUntilISO = hiddenUntilForCalendarEvent(event, boardKind, weekStart);
  if (hiddenUntilISO) {
    if (event.hiddenUntilISO === hiddenUntilISO) return event;
    return { ...event, hiddenUntilISO };
  }
  if (!event.hiddenUntilISO) return event;
  return { ...event, hiddenUntilISO: undefined };
}

function nextOrderForBoard(
  boardId: string,
  tasks: Task[],
  newTaskPosition: Settings["newTaskPosition"]
): number {
  const boardTasks = tasks.filter(task => task.boardId === boardId);
  if (newTaskPosition === "top") {
    const minOrder = boardTasks.reduce((min, task) => Math.min(min, task.order ?? 0), 0);
    return minOrder - 1;
  }
  return boardTasks.reduce((max, task) => Math.max(max, task.order ?? -1), -1) + 1;
}

function nextOrderForCalendarBoard(
  boardId: string,
  events: CalendarEvent[],
  newItemPosition: Settings["newTaskPosition"],
): number {
  const boardEvents = events.filter((event) => event.boardId === boardId && !event.external);
  if (newItemPosition === "top") {
    const minOrder = boardEvents.reduce((min, event) => Math.min(min, event.order ?? 0), 0);
    return minOrder - 1;
  }
  return boardEvents.reduce((max, event) => Math.max(max, event.order ?? -1), -1) + 1;
}

async function syncRemindersToWorker(
  workerBaseUrl: string,
  push: PushPreferences,
  reminderItems: Array<{
    taskId: string;
    boardId?: string;
    title: string;
    dueISO: string;
    reminders: ReminderPreset[];
  }>,
  options?: { signal?: AbortSignal }
): Promise<void> {
  if (!workerBaseUrl) throw new Error("Worker base URL is not configured");
  if (!push.deviceId || !push.subscriptionId) return;
  const remindersPayload = reminderItems
    .map((item) => ({
      taskId: item.taskId,
      boardId: item.boardId,
      dueISO: item.dueISO,
      title: item.title,
      minutesBefore: (item.reminders ?? []).map(reminderPresetToMinutes).sort((a, b) => a - b),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  let res: Response;
  try {
    res = await withTimeout(
      fetch(`${workerBaseUrl}/api/reminders`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: push.deviceId,
          subscriptionId: push.subscriptionId,
          reminders: remindersPayload,
        }),
        signal: options?.signal,
      }),
      PUSH_OPERATION_TIMEOUT_MS,
      "Timed out while syncing reminders to the notification worker.",
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Failed to sync reminders (${res.status})`);
  }
}
