/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import React, { Suspense, lazy, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Proof } from "@cashu/cashu-ts";
import { createPortal } from "react-dom";
import { QRCodeCanvas } from "qrcode.react";
import QrScannerLib from "qr-scanner";
import { finalizeEvent, getPublicKey, generateSecretKey, type EventTemplate, nip04, nip19, nip44 } from "nostr-tools";
import {
  normalizeCalendarDeleteMutationPayload,
  normalizeCalendarMutationPayload,
  normalizeRelayListSorted,
  parseBoardSharePayload,
  normalizeNip05,
  compressedToRawHex,
  contactInitials,
  contactVerifiedNip05 as contactVerifiedNip05Core,
  normalizeTaskAssignmentStatus,
} from "taskify-core";
const loadCashuWalletModal = () => import("./components/CashuWalletModal");
const CashuWalletModal = lazy(loadCashuWalletModal);
import {
  BibleTracker,
  type BibleTrackerProgress,
  type BibleTrackerState,
  sanitizeBibleTrackerState,
  cloneBibleProgress,
  cloneBibleVerses,
  cloneBibleVerseCounts,
  cloneBibleCompletedBooks,
  getBibleBookChapterCount,
  getBibleBookTitle,
  getBibleBookOrder,
  MAX_VERSE_COUNT,
} from "./components/BibleTracker";
import { BibleTrackerPrintPreview, type BiblePrintMeta } from "./components/BibleTrackerPrintSheet";
import { BibleTrackerScanPanel } from "./components/BibleTrackerScanSheet";
import { buildBiblePrintLayout } from "./components/BibleTrackerPrintLayout";
import { BoardPrintPreview } from "./components/BoardPrintSheet";
import { BoardScanPanel } from "./components/BoardScanSheet";
import { BOARD_PRINT_LAYOUT_VERSION, buildBoardPrintLayout, type BoardPrintJob, type BoardPrintTask } from "./components/BoardPrintLayout";
import { isPrintPaperSize, type PrintPaperSize } from "./components/printPaper";
import { ScriptureMemoryCard, type AddScripturePayload, type ScriptureMemoryListItem } from "./components/ScriptureMemoryCard";
import { getBibleChapterVerseCount } from "./data/bibleVerseCounts";
import { buildBibleTrackerPrintPdf, buildBoardPrintPdf } from "./lib/printPdf";
import { useCashu } from "./context/CashuContext";
import {
  LS_LIGHTNING_CONTACTS,
  LS_BTC_USD_PRICE_CACHE,
  LS_MINT_BACKUP_ENABLED,
  LS_CONTACTS_SYNC_META,
  LS_CONTACT_NIP05_CACHE,
} from "./localStorageKeys";
import { kvStorage } from "./storage/kvStorage";
import { idbKeyValue } from "./storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR, TASKIFY_STORE_TASKS, TASKIFY_STORE_WALLET } from "./storage/taskifyDb";
import {
  LS_NOSTR_BACKUP_STATE,
  LS_NOSTR_BIBLE_TRACKER_SYNC_STATE,
  LS_NOSTR_RELAYS,
  LS_NOSTR_SCRIPTURE_MEMORY_SYNC_STATE,
  LS_NOSTR_SK,
} from "./nostrKeys";
import {
  loadStore as loadProofStore,
  saveStore as saveProofStore,
  getActiveMint,
  setActiveMint,
  getMintList,
  addMintToList,
  replaceMintList,
  listPendingTokens,
  replacePendingTokens,
  type PendingTokenEntry,
} from "./wallet/storage";
import {
  getWalletSeedMnemonic,
  getWalletSeedBackupJson,
  getWalletSeedBackup,
  getWalletCountersByMint,
  incrementWalletCounter,
  regenerateWalletSeed,
  type WalletSeedBackupPayload,
  restoreWalletSeedBackup,
} from "./wallet/seed";
import {
  createMintBackupTemplate,
  decryptMintBackupPayload,
  deriveMintBackupKeys,
  loadMintBackupCache,
  MINT_BACKUP_CLIENT_TAG,
  MINT_BACKUP_D_TAG,
  MINT_BACKUP_KIND,
  persistMintBackupCache,
  type MintBackupPayload,
} from "./wallet/mintBackup";
import {
  decryptNostrBackupPayload,
  encryptNostrBackupPayload,
  NOSTR_APP_BACKUP_CLIENT_TAG,
  NOSTR_APP_BACKUP_D_TAG,
  NOSTR_APP_BACKUP_KIND,
  type NostrAppBackupBoard,
  type NostrAppBackupPayload,
} from "./nostrBackup";
import {
  decryptNostrSyncPayload,
  encryptNostrSyncPayload,
  NOSTR_APP_STATE_CLIENT_TAG,
  NOSTR_APP_STATE_KIND,
  NOSTR_BIBLE_TRACKER_D_TAG,
  NOSTR_SCRIPTURE_MEMORY_D_TAG,
} from "./nostrAppState";
import { encryptToBoard, decryptFromBoard, boardTag } from "./boardCrypto";
import { useToast } from "./context/ToastContext";
import { useP2PK, type P2PKKey } from "./context/P2PKContext";
import { AccentPalette, BackgroundImageError, normalizeAccentPalette, normalizeAccentPaletteList, prepareBackgroundImage } from "./theme/palette";
import { extractFirstUrl, isUrlLike, useUrlPreview, type UrlPreviewData } from "./lib/urlPreview";
import {
  createDocumentAttachment,
  ensureDocumentPreview,
  loadDocumentPreview,
  isSupportedDocumentFile,
  normalizeDocumentList,
  type TaskDocumentPreview,
  type TaskDocument,
} from "./lib/documents";
import { normalizeNostrPubkey } from "./lib/nostr";
import {
  buildNostrBackupSnapshot as buildNostrBackupSnapshotDomain,
  mergeBackupBoards,
  sanitizeSettingsForNostrBackup,
} from "./lib/app/nostrBackupDomain";
import {
  ensureWeekRecurrencesForCurrentWeek,
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
  decryptCalendarRsvpPayload,
  decryptCalendarRsvpPayloadForAttendee,
  deriveBoardRsvpToken,
  parseCalendarCanonicalPayload,
  parseCalendarViewPayload,
  parseCalendarRsvpPayload,
  type CalendarRsvpFb,
  type CalendarRsvpStatus,
} from "./lib/privateCalendar";
import { DEFAULT_NOSTR_RELAYS } from "./lib/relays";
import { ActionSheet } from "./components/ActionSheet";
import { VoiceDictationModal } from "./components/VoiceDictationModal";
import type { FinalTask } from "./nostr/useVoiceSession";
import type { Contact } from "./lib/contacts";
import {
  contactPrimaryName,
  formatContactNpub,
  loadContactsFromStorage,
  makeContactId,
  normalizeContact,
  contactHasNpub,
  saveContactsToStorage,
} from "./lib/contacts";
import { COINBASE_SPOT_PRICE_URL } from "./lib/pricing";
import {
  markHistoryEntrySpentRaw,
  MARK_HISTORY_ENTRIES_OLDER_SPENT_EVENT,
  type HistoryEntryRaw,
} from "./lib/walletHistory";
import { DEFAULT_FILE_STORAGE_SERVER, normalizeFileServerUrl } from "./lib/fileStorage";
import { NostrSession } from "./nostr/NostrSession";
import { SessionPool } from "./nostr/SessionPool";
import { BoardKeyManager } from "./nostr/BoardKeyManager";
import { publishFileServerPreference } from "./nostr/ProfilePublisher";
import { EcashGlyph } from "./components/EcashGlyph";
import { FirstRunOnboarding } from "./onboarding/FirstRunOnboarding";

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
import type { WalletMessageItem } from "./types/walletMessages";

// ---- UI component imports (extracted subcomponents) ----
import { Card, getDraggedTaskId } from "./ui/task/Card";
import { autolink, TaskTitle, stripUrlsFromText, useTaskPreview } from "./ui/task/TaskTitle";
import { TaskMedia, UrlPreviewCard, EventTitle, EventMedia, useEventPreview } from "./ui/task/TaskMedia";
import { DocumentThumbnail, DocumentPreviewModal } from "./ui/task/DocumentPreviewModal";
import { EventCard, getDraggedEventId } from "./ui/calendar/EventCard";
import { EditModal } from "./ui/task/EditModal";
import EventEditModal from "./ui/calendar/EventEditModal";
import { AddBoardModal } from "./ui/board/AddBoardModal";
import { SettingsModal } from "./ui/board/SettingsModal";

import { Modal } from "./ui/Modal";
import { CustomReminderSheet } from "./ui/reminders/CustomReminderSheet";
import { RecurrencePicker, RecurrenceModal, RepeatPickerSheet, RepeatCustomSheet, EndRepeatSheet } from "./ui/recurrence/RecurrencePicker";
import { BoardQrScanner } from "./ui/board/BoardQrScanner";
import { BountyAttachSheet, normalizeMintUrlLite, formatMintLabel, sumMintProofs } from "./ui/bounty/BountyAttachSheet";
import { LockToNpubSheet } from "./ui/bounty/LockToNpubSheet";
import { TimeZoneSheet } from "./ui/reminders/TimeZoneSheet";

import { useGoogleCalendar, isGcalBoardId } from "./hooks/useGoogleCalendar";


const DEBUG_CONSOLE_STORAGE_KEY = "taskify.debugConsole.enabled";
const ADD_BOARD_OPTION_ID = "__add-board__";
const BOARD_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SPECIAL_CALENDAR_US_HOLIDAYS_ID = "special:us-holidays";
const SPECIAL_CALENDAR_US_HOLIDAYS_LABEL = "US Holidays";
const SPECIAL_CALENDAR_US_HOLIDAY_RANGE_PAST_YEARS = 1;
const SPECIAL_CALENDAR_US_HOLIDAY_RANGE_FUTURE_YEARS = 8;

type ScanResult = QrScannerLib.ScanResult;

/* ================= Types ================= */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun
type DayChoice = Weekday | string; // string = custom list columnId
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];
const WD_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
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
const MONTH_PICKER_YEAR_WINDOW = 1000;
const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const MERIDIEMS = ["AM", "PM"] as const;
type Meridiem = (typeof MERIDIEMS)[number];

type Recurrence =
  | { type: "none"; untilISO?: string }
  | { type: "daily"; untilISO?: string }
  | { type: "weekly"; days: Weekday[]; untilISO?: string }
  | { type: "every"; n: number; unit: "hour" | "day" | "week"; untilISO?: string }
  | { type: "monthlyDay"; day: number; interval?: number; untilISO?: string };

type Subtask = {
  id: string;
  title: string;
  completed?: boolean;
};

type LockRecipientSelection = {
  value: string;
  label: string;
  contactId?: string;
};

type QuickLockOption = {
  id: string;
  title: string;
  value: string;
  label: string;
  contactId?: string;
};

type Nip05CheckState = {
  status: "pending" | "valid" | "invalid";
  nip05: string;
  npub: string;
  checkedAt: number;
  contactUpdatedAt?: number | null;
};

type InboxSender = {
  pubkey: string;
  name?: string;
  npub?: string;
};

type InboxItemStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "tentative"
  | "deleted"
  | "read";

type InboxItem =
  | {
      type: "board";
      boardId: string;
      boardName?: string;
      relays?: string[];
      sender: InboxSender;
      receivedAt: string;
      status?: InboxItemStatus;
      dmEventId?: string;
    }
  | {
      type: "contact";
      contact: SharedContactPayload;
      sender: InboxSender;
      receivedAt: string;
      status?: InboxItemStatus;
      dmEventId?: string;
    }
  | {
      type: "task";
      task: SharedTaskPayload;
      sender: InboxSender;
      receivedAt: string;
      status?: InboxItemStatus;
      dmEventId?: string;
    };

type TaskAssigneeStatus = "pending" | "accepted" | "declined" | "tentative";

type TaskAssignee = {
  pubkey: string;
  relay?: string;
  status?: TaskAssigneeStatus;
  respondedAt?: number;
};

type CalendarInviteStatus = "pending" | CalendarRsvpStatus | "dismissed";

type CalendarInvite = {
  id: string;
  source: "dm" | "nostr";
  eventId: string;
  canonical: string;
  view: string;
  eventKey: string;
  inviteToken: string;
  title?: string;
  start?: string;
  end?: string;
  relays?: string[];
  sender?: InboxSender;
  receivedAt: string;
  status: CalendarInviteStatus;
};

type CalendarRsvpEnvelope = {
  eventId: string;
  authorPubkey: string;
  createdAt: number;
  status: CalendarRsvpStatus;
  fb?: CalendarRsvpFb;
  inviteToken?: string;
};

function normalizeNostrPubkeyHex(value: string | null | undefined): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  const normalized = normalizeNostrPubkey(trimmed);
  const raw = compressedToRawHex(normalized ?? trimmed).toLowerCase();
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

function normalizeAgentPubkey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeNostrPubkeyHex(value) ?? undefined;
}

function normalizeTaskAssignees(value: unknown): TaskAssignee[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: TaskAssignee[] = [];
  const seen = new Set<string>();
  value.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const pubkey = normalizeNostrPubkeyHex((entry as any).pubkey);
    if (!pubkey || seen.has(pubkey)) return;
    seen.add(pubkey);
    const relay = typeof (entry as any).relay === "string" ? (entry as any).relay.trim() : "";
    const status = normalizeTaskAssignmentStatus((entry as any).status) as TaskAssigneeStatus | undefined;
    const respondedAtRaw = Number((entry as any).respondedAt);
    const respondedAt =
      Number.isFinite(respondedAtRaw) && respondedAtRaw > 0 ? Math.round(respondedAtRaw) : undefined;
    normalized.push({
      pubkey,
      ...(relay ? { relay } : {}),
      ...(status ? { status } : {}),
      ...(respondedAt ? { respondedAt } : {}),
    });
  });
  return normalized.length ? normalized : undefined;
}

function mergeTaskAssigneeResponse(
  assignees: TaskAssignee[] | undefined,
  responderPubkey: string,
  status: TaskAssigneeStatus,
  respondedAtMs: number,
): TaskAssignee[] | undefined {
  const normalizedResponder = normalizeNostrPubkeyHex(responderPubkey);
  if (!normalizedResponder || !Array.isArray(assignees) || !assignees.length) return assignees;
  let changed = false;
  const next = assignees.map((assignee) => {
    const assigneePubkey = normalizeNostrPubkeyHex(assignee.pubkey);
    if (!assigneePubkey || assigneePubkey !== normalizedResponder) return assignee;
    const nextStatus = status;
    const nextRespondedAt = respondedAtMs > 0 ? respondedAtMs : Date.now();
    const prevStatus = assignee.status ?? "pending";
    const prevRespondedAt = typeof assignee.respondedAt === "number" ? assignee.respondedAt : 0;
    if (prevStatus === nextStatus && prevRespondedAt === nextRespondedAt) return assignee;
    changed = true;
    return {
      ...assignee,
      status: nextStatus,
      respondedAt: nextRespondedAt,
    };
  });
  return changed ? next : assignees;
}

function isAssignedSharedTask(payload: SharedTaskPayload | null | undefined): boolean {
  return !!(payload && payload.assignment === true && typeof payload.sourceTaskId === "string" && payload.sourceTaskId.trim());
}

function loadNip05Cache(): Record<string, Nip05CheckState> {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_CONTACT_NIP05_CACHE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const entries: Record<string, Nip05CheckState> = {};
    Object.entries(parsed as Record<string, any>).forEach(([key, value]) => {
      if (!value || typeof value !== "object") return;
      const status = (value as any).status;
      const nip05 = typeof (value as any).nip05 === "string" ? (value as any).nip05 : "";
      const npub = typeof (value as any).npub === "string" ? (value as any).npub : "";
      const checkedAt = Number((value as any).checkedAt) || 0;
      const contactUpdatedAtRaw = Number((value as any).contactUpdatedAt);
      if (!nip05 || !npub) return;
      if (status !== "pending" && status !== "valid" && status !== "invalid") return;
      entries[key] = {
        status,
        nip05,
        npub,
        checkedAt: checkedAt || Date.now(),
        contactUpdatedAt: Number.isFinite(contactUpdatedAtRaw) ? contactUpdatedAtRaw : null,
      };
    });
    return entries;
  } catch {
    return {};
  }
}

function contactVerifiedNip05(contact: Contact, cache: Record<string, Nip05CheckState>): string | null {
  const normalizedNpub = normalizeNostrPubkey(contact.npub || "");
  return contactVerifiedNip05Core(
    {
      id: contact.id,
      nip05: contact.nip05,
      npub: normalizedNpub || contact.npub,
    },
    cache,
  );
}

function VerifiedBadgeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l.967 2.329a1.125 1.125 0 0 0 1.304.674l2.457-.624c1.119-.285 2.114.71 1.829 1.829l-.624 2.457a1.125 1.125 0 0 0 .674 1.304l2.329.967c1.077.448 1.077 1.976 0 2.424l-2.329.967a1.125 1.125 0 0 0-.674 1.304l.624 2.457c.285 1.119-.71 2.114-1.829 1.829l-2.457-.624a1.125 1.125 0 0 0-1.304.674l-.967 2.329c-.448 1.077-1.976 1.077-2.424 0l-.967-2.329a1.125 1.125 0 0 0-1.304-.674l-2.457.624c-1.119.285-2.114-.71-1.829-1.829l.624-2.457a1.125 1.125 0 0 0-.674-1.304l-2.329-.967c-1.077-.448-1.077-1.976 0-2.424l2.329-.967a1.125 1.125 0 0 0 .674-1.304l-.624-2.457c-.285-1.119.71-2.114 1.829-1.829l2.457.624a1.125 1.125 0 0 0 1.304-.674l.967-2.329Z"
      />
      <path
        d="m9.4 12.75 1.9 1.9 3.85-3.85"
        fill="none"
        stroke="var(--surface-base)"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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

type TaskPriority = 1 | 2 | 3;

type Task = {
  id: string;
  boardId: string;
  createdBy?: string;             // nostr pubkey of task creator
  lastEditedBy?: string;          // nostr pubkey of latest task editor
  createdAt?: number;             // unix ms timestamp (local)
  updatedAt?: string;             // iso timestamp of latest local edit when known
  _nostrAt?: number;              // unix seconds of the Nostr event that last wrote this task (not persisted to IDB in old data)
  title: string;
  priority?: TaskPriority;        // 1-3 exclamation marks
  note?: string;
  images?: string[];              // base64 data URLs for pasted images
  documents?: TaskDocument[];     // supported document attachments
  dueISO: string;                 // for week board day grouping
  dueDateEnabled?: boolean;       // whether the due date is active
  completed?: boolean;
  completedAt?: string;
  completedBy?: string;           // nostr pubkey of user who marked complete
  recurrence?: Recurrence;
  // Week board columns:
  column?: "day";
  // Custom boards (multi-list):
  columnId?: string;
  hiddenUntilISO?: string;        // controls visibility (appear at/after this date)
  order?: number;                 // order within the board for manual reordering
  streak?: number;                // consecutive completion count
  longestStreak?: number;         // highest recorded streak for the series
  seriesId?: string;              // identifier for a recurring series
  subtasks?: Subtask[];           // optional list of subtasks
  assignees?: TaskAssignee[];     // optional assignment list with response states
  bounty?: {
    id: string;                   // bounty id (uuid)
    token: string;                // cashu token string (locked or unlocked)
    amount?: number;              // optional, sats
    mint?: string;                // optional hint
    lock?: "p2pk" | "htlc" | "none" | "unknown";
    owner?: string;               // hex pubkey of task creator (who can unlock)
    sender?: string;              // hex pubkey of funder (who can revoke)
    receiver?: string;            // hex pubkey of intended recipient (who can decrypt nip04)
    state: "locked" | "unlocked" | "revoked" | "claimed";
    updatedAt: string;            // iso
    enc?:
      | {                         // optional encrypted form (hidden until funder reveals)
          alg: "aes-gcm-256";
          iv: string;            // base64
          ct: string;            // base64
        }
      | {
          alg: "nip04";         // encrypted to receiver's nostr pubkey (nip04 format)
          data: string;          // ciphertext returned by nip04.encrypt
      }
      | null;
  };
  dueTimeEnabled?: boolean;       // whether a specific due time is set
  dueTimeZone?: string;           // IANA time zone for due time (defaults to device zone)
  reminders?: ReminderPreset[];   // preset reminder offsets before due time
  reminderTime?: string;          // HH:mm reminder clock used when due time is not set
  scriptureMemoryId?: string;     // reference to scripture memory entry when auto-created
  scriptureMemoryStage?: number;  // stage at time of scheduling (for undo)
  scriptureMemoryPrevReviewISO?: string | null; // previous review timestamp snapshot
  scriptureMemoryScheduledAt?: string; // when this memory task was generated
  bountyLists?: string[];         // local-only set of bounty list keys the task belongs to
  bountyDeletedAt?: string;       // local-only marker for recoverable bounty-task deletes
  inboxItem?: InboxItem;          // shared inbox metadata (boards/contacts/tasks)
};

type CalendarEventParticipant = {
  pubkey: string;
  relay?: string;
  role?: string;
};

type CalendarEventBase = {
  id: string;                     // stable event identifier
  boardId: string;
  createdBy?: string;             // nostr pubkey of event creator
  lastEditedBy?: string;          // nostr pubkey of latest event editor
  columnId?: string;              // list boards only
  order?: number;                 // manual ordering within board/column
  title: string;
  summary?: string;
  description?: string;
  documents?: TaskDocument[];     // supported document attachments
  image?: string;
  locations?: string[];
  geohash?: string;
  participants?: CalendarEventParticipant[];
  hashtags?: string[];
  references?: string[];
  reminders?: ReminderPreset[];   // per-device push reminders (not published)
  reminderTime?: string;          // HH:mm reminder clock used for all-day events
  hiddenUntilISO?: string;        // local visibility gating for board lists
  recurrence?: Recurrence;        // client-managed recurrence
  seriesId?: string;              // client-managed recurrence grouping
  readOnly?: boolean;             // view-only event (cannot publish edits)
  external?: boolean;             // boardless invitee event
  originBoardId?: string;         // board id to publish edits/deletions when different from boardId
  eventKey?: string;              // per-event share key (base64)
  inviteTokens?: Record<string, string>; // board-only invite tokens keyed by pubkey
  canonicalAddress?: string;      // canonical event address for invitees
  viewAddress?: string;           // shareable view address for invitees
  inviteToken?: string;           // invitee token for RSVP
  inviteRelays?: string[];        // relays to fetch view + RSVP
  boardPubkey?: string;           // canonical board pubkey for external RSVP
  rsvpStatus?: CalendarRsvpStatus; // local RSVP state (external)
  rsvpCreatedAt?: number;         // created_at for local RSVP (external)
  rsvpFb?: CalendarRsvpFb;         // free/busy for local RSVP (external)
};

type DateCalendarEvent = CalendarEventBase & {
  kind: "date";
  startDate: string;              // YYYY-MM-DD
  endDate?: string;               // inclusive YYYY-MM-DD (UI-facing)
};

type TimeCalendarEvent = CalendarEventBase & {
  kind: "time";
  startISO: string;               // ISO timestamp (UTC)
  endISO?: string;                // ISO timestamp (UTC)
  startTzid?: string;             // IANA TZID tag
  endTzid?: string;
};

type CalendarEvent = DateCalendarEvent | TimeCalendarEvent;
type ExternalCalendarEvent = CalendarEvent & {
  external: true;
  boardPubkey: string;
};

function isExternalCalendarEvent(event: CalendarEvent): event is ExternalCalendarEvent {
  return event.external === true;
}

type EditItemType = "task" | "event";

type EditingState =
  | { type: "task"; originalType: EditItemType; originalId: string; task: Task }
  | { type: "event"; originalType: EditItemType; originalId: string; event: CalendarEvent };

const TASK_PRIORITY_MARKS: Record<TaskPriority, string> = {
  1: "!",
  2: "!!",
  3: "!!!",
};

function normalizeTaskPriority(value: unknown): TaskPriority | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    if (rounded === 1 || rounded === 2 || rounded === 3) return rounded as TaskPriority;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "!" || trimmed === "!!" || trimmed === "!!!") {
      return trimmed.length as TaskPriority;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed === 1 || parsed === 2 || parsed === 3) return parsed as TaskPriority;
  }
  return undefined;
}

function normalizeTaskCreatedAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function taskPriorityMarks(priority: TaskPriority | undefined): string {
  return priority ? TASK_PRIORITY_MARKS[priority] : "";
}

type BoardSortMode = "manual" | "due" | "priority" | "created" | "alpha";
type BoardSortDirection = "asc" | "desc";
type UpcomingBoardGrouping = "mixed" | "grouped";

const DEFAULT_BOARD_SORT_DIRECTION: Record<BoardSortMode, BoardSortDirection> = {
  manual: "asc",
  due: "asc",
  priority: "desc",
  created: "desc",
  alpha: "asc",
};

const BOARD_SORT_MODE_IDS = new Set<BoardSortMode>(["manual", "due", "priority", "created", "alpha"]);

function normalizeBoardSortState(value: unknown): { mode: BoardSortMode; direction: BoardSortDirection } | null {
  const modeRaw = typeof (value as any)?.mode === "string" ? (value as any).mode : "";
  if (!BOARD_SORT_MODE_IDS.has(modeRaw as BoardSortMode)) return null;
  const mode = modeRaw as BoardSortMode;
  const directionRaw = typeof (value as any)?.direction === "string" ? (value as any).direction : "";
  const direction: BoardSortDirection =
    directionRaw === "asc" || directionRaw === "desc" ? (directionRaw as BoardSortDirection) : DEFAULT_BOARD_SORT_DIRECTION[mode];
  return { mode, direction };
}

const PINNED_BOUNTY_LIST_KEY = "taskify::pinned";
const LS_MESSAGES_BOARD_ID = "taskify_messages_board_id_v1";
const LS_INBOX_PROCESSED = "taskify_inbox_processed_v1";
const MESSAGES_COLUMN_ID = "messages-shared";
const SHARE_DM_LOOKBACK_SECONDS = 3 * 24 * 60 * 60;

function taskHasBountyList(task: Task, key: string | null | undefined): boolean {
  if (!key) return false;
  if (!Array.isArray(task.bountyLists)) return false;
  return task.bountyLists.includes(key);
}

function withTaskAddedToBountyList(task: Task, key: string | null): Task {
  if (!key) return task;
  if (taskHasBountyList(task, key)) return task;
  const nextLists = Array.isArray(task.bountyLists) ? [...task.bountyLists, key] : [key];
  return { ...task, bountyLists: nextLists };
}

function withTaskRemovedFromBountyList(task: Task, key: string | null): Task {
  if (!key || !Array.isArray(task.bountyLists)) return task;
  if (!task.bountyLists.includes(key)) return task;
  const filtered = task.bountyLists.filter((value) => value !== key);
  if (filtered.length === 0) {
    const clone = { ...task };
    delete clone.bountyLists;
    return clone;
  }
  return { ...task, bountyLists: filtered };
}

function isRecoverableBountyTask(task: Task): boolean {
  return !!task.bounty && typeof task.bountyDeletedAt === "string" && task.bountyDeletedAt.trim().length > 0;
}

function normalizeBounty(bounty?: Task["bounty"] | null): Task["bounty"] | undefined {
  if (!bounty) return undefined;
  const normalized: Task["bounty"] = { ...bounty };
  const owner = ensureXOnlyHex(normalized.owner);
  if (owner) normalized.owner = owner; else delete normalized.owner;
  const sender = ensureXOnlyHex(normalized.sender);
  if (sender) normalized.sender = sender; else delete normalized.sender;
  const receiver = ensureXOnlyHex(normalized.receiver);
  if (receiver) normalized.receiver = receiver; else delete normalized.receiver;
  const token = typeof normalized.token === "string" ? normalized.token : "";
  const hasToken = token.trim().length > 0;
  const hasCipher = normalized.enc !== undefined && normalized.enc !== null;

  if (normalized.state === "claimed" || normalized.state === "revoked") {
    return normalized;
  }

  if (hasToken && !hasCipher) {
    normalized.state = "unlocked";
    if (!normalized.lock || normalized.lock === "unknown") {
      normalized.lock = "none";
    }
  } else if (hasCipher && !hasToken) {
    normalized.state = "locked";
  } else if (hasToken && hasCipher) {
    normalized.state = "unlocked";
  } else {
    normalized.state = "locked";
  }

  return normalized;
}

function normalizeTaskBounty(task: Task): Task {
  if (!Object.prototype.hasOwnProperty.call(task, "bounty")) {
    return task;
  }
  const clone: Task = { ...task };
  const bounty = (clone as any).bounty as Task["bounty"] | undefined;
  if (!bounty) {
    delete (clone as any).bounty;
    return clone;
  }
  const normalized = normalizeBounty(bounty);
  if (!normalized) {
    delete (clone as any).bounty;
    return clone;
  }
  clone.bounty = normalized;
  return clone;
}

function toXOnlyHex(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (/^(02|03)[0-9a-f]{64}$/.test(hex)) {
    return hex.slice(-64);
  }
  if (/^[0-9a-f]{64}$/.test(hex)) {
    return hex;
  }
  return null;
}

function ensureXOnlyHex(value?: string | null): string | undefined {
  const normalized = toXOnlyHex(value);
  return normalized ?? undefined;
}

function pubkeysEqual(a?: string | null, b?: string | null): boolean {
  const ax = toXOnlyHex(a);
  const bx = toXOnlyHex(b);
  return !!(ax && bx && ax === bx);
}

function bountyStateLabel(bounty: Task["bounty"]): string {
  if (
    bounty.state === "locked" &&
    bounty.lock === "p2pk" &&
    bounty.receiver &&
    typeof window !== "undefined" &&
    pubkeysEqual(bounty.receiver, (window as any).nostrPK)
  ) {
    return "ready to redeem";
  }
  return bounty.state;
}

function mergeLongestStreak(task: Task, streak: number | undefined): number | undefined {
  const previous =
    typeof task.longestStreak === "number"
      ? task.longestStreak
      : typeof task.streak === "number"
        ? task.streak
        : undefined;
  if (typeof streak === "number") {
    return previous === undefined ? streak : Math.max(previous, streak);
  }
  return previous;
}

type BuiltinReminderPreset = "0h" | "5m" | "15m" | "30m" | "1h" | "1d" | "1w" | "0d";
type CustomReminderPreset = `custom-${number}`;
type ReminderPreset = BuiltinReminderPreset | CustomReminderPreset;
type ReminderPresetMode = "timed" | "date";

type PushPlatform = "ios" | "android";

type PushPreferences = {
  enabled: boolean;
  platform: PushPlatform;
  deviceId?: string;
  subscriptionId?: string;
  permission?: NotificationPermission;
};
type PublishTaskFn = (
  task: Task,
  boardOverride?: Board,
  options?: { skipBoardMetadata?: boolean }
) => Promise<void>;
type PublishCalendarEventFn = (
  event: CalendarEvent,
  boardOverride?: Board,
  options?: { skipBoardMetadata?: boolean }
) => Promise<void>;
type ScriptureMemoryUpdate = {
  entryId: string;
  completedAt: string;
  stageBefore?: number;
  nextScheduled?: { entryId: string; scheduledAtISO: string };
};
type CompleteTaskResult = {
  scriptureMemory?: ScriptureMemoryUpdate;
} | null;
type CompleteTaskFn = (
  id: string,
  options?: { skipScriptureMemoryUpdate?: boolean; inboxAction?: "accept" | "dismiss" | "decline" | "maybe" }
) => CompleteTaskResult;

function detectPushPlatformFromNavigator(): PushPlatform {
  if (typeof navigator === 'undefined') return 'ios';
  const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent.toLowerCase() : '';
  const vendor = typeof navigator.vendor === 'string' ? navigator.vendor.toLowerCase() : '';
  const platform = typeof navigator.platform === 'string' ? navigator.platform.toLowerCase() : '';
  const isIosDevice = /\b(iphone|ipad|ipod)\b/.test(ua);
  const isStandalonePwa = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches;
  const isSafariBrowser = /safari/.test(ua)
    && !/chrome|crios|fxios|edge|edg\//.test(ua)
    && !/android/.test(ua);
  const isAppleWebkit = vendor.includes('apple');
  if (isIosDevice || (isSafariBrowser && (platform.startsWith('mac') || isAppleWebkit)) || (isAppleWebkit && isStandalonePwa)) {
    return 'ios';
  }
  return 'android';
}

const INFERRED_PUSH_PLATFORM: PushPlatform = detectPushPlatformFromNavigator();

const DEFAULT_DATE_REMINDER_TIME = "09:00";

const TIMED_REMINDER_PRESETS: ReadonlyArray<{ id: BuiltinReminderPreset; label: string; badge: string; minutes: number }> = [
  { id: "0h", label: "At due/start time", badge: "0h", minutes: 0 },
  { id: "5m", label: "5 minutes before", badge: "5m", minutes: 5 },
  { id: "15m", label: "15 minutes before", badge: "15m", minutes: 15 },
  { id: "30m", label: "30 minutes before", badge: "30m", minutes: 30 },
  { id: "1h", label: "1 hour before", badge: "1h", minutes: 60 },
  { id: "1d", label: "1 day before", badge: "1d", minutes: 1440 },
];

const DATE_REMINDER_PRESETS: ReadonlyArray<{ id: BuiltinReminderPreset; label: string; badge: string; minutes: number }> = [
  { id: "1w", label: "1 week before", badge: "1w", minutes: 10080 },
  { id: "1d", label: "1 day before", badge: "1d", minutes: 1440 },
  { id: "0d", label: "On the day", badge: "day of", minutes: 0 },
];

const BUILTIN_REMINDER_PRESETS: ReadonlyArray<{ id: BuiltinReminderPreset; label: string; badge: string; minutes: number }> = [
  ...DATE_REMINDER_PRESETS,
  ...TIMED_REMINDER_PRESETS,
];

const BUILTIN_REMINDER_IDS = new Set<BuiltinReminderPreset>(BUILTIN_REMINDER_PRESETS.map((opt) => opt.id));
const BUILTIN_REMINDER_MINUTES = new Map<BuiltinReminderPreset, number>(BUILTIN_REMINDER_PRESETS.map((opt) => [opt.id, opt.minutes] as const));

const BIBLE_BOARD_ID = "bible-reading";
const LS_SCRIPTURE_MEMORY = "taskify_scripture_memory_v1";
const SCRIPTURE_MEMORY_SERIES_ID = "scripture-memory";
const FASTING_REMINDER_SERIES_ID = "fasting-reminder";

type ScriptureMemoryFrequency = "daily" | "every2d" | "twiceWeek" | "weekly";
type ScriptureMemorySort = "canonical" | "oldest" | "newest" | "needsReview";
type FastingRemindersMode = "weekday" | "random";

type ScriptureMemoryEntry = {
  id: string;
  bookId: string;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
  addedAtISO: string;
  lastReviewISO?: string;
  scheduledAtISO?: string;
  stage: number;
  totalReviews: number;
};

type ScriptureMemoryState = {
  entries: ScriptureMemoryEntry[];
  lastReviewISO?: string;
};

const MS_PER_DAY = 86400000;

const MAX_SCRIPTURE_STAGE = 8;
const SCRIPTURE_STAGE_GROWTH = 1.8;
const SCRIPTURE_INTERVAL_CAP_DAYS = 180;

const SCRIPTURE_MEMORY_FREQUENCIES: Array<{
  id: ScriptureMemoryFrequency;
  label: string;
  days: number;
  description: string;
}> = [
  { id: "daily", label: "Daily", days: 1, description: "Creates a review task every day." },
  { id: "every2d", label: "Every 2 days", days: 2, description: "Review roughly three to four times per week." },
  { id: "twiceWeek", label: "Twice per week", days: 3, description: "Focus on scripture memory a couple times per week." },
  { id: "weekly", label: "Weekly", days: 7, description: "Schedule one scripture memory task each week." },
];

const SCRIPTURE_MEMORY_SORTS: Array<{ id: ScriptureMemorySort; label: string }> = [
  { id: "canonical", label: "Canonical order" },
  { id: "oldest", label: "Oldest added" },
  { id: "newest", label: "Newest added" },
  { id: "needsReview", label: "Needs review" },
];

const CUSTOM_REMINDER_PATTERN = /^custom-(-?\d{1,8})$/;
const MIN_CUSTOM_REMINDER_MINUTES = -99_999_999;
const MAX_CUSTOM_REMINDER_MINUTES = 99_999_999;

function clampCustomReminderMinutes(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_CUSTOM_REMINDER_MINUTES, Math.min(MAX_CUSTOM_REMINDER_MINUTES, Math.round(value)));
}

function normalizeReminderTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = parseTimeValue(value);
  if (!parsed) return undefined;
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

function minutesToReminderId(minutes: number): ReminderPreset {
  if (!Number.isFinite(minutes)) return "0d";
  const normalized = clampCustomReminderMinutes(minutes);
  if (normalized === 0) return "0d";
  for (const [id, builtinMinutes] of BUILTIN_REMINDER_MINUTES) {
    if (builtinMinutes === normalized) return id;
  }
  return `custom-${normalized}`;
}

function reminderPresetIdForMode(minutes: number, mode: ReminderPresetMode): ReminderPreset {
  if (!Number.isFinite(minutes)) {
    return mode === "timed" ? "0h" : "0d";
  }
  const normalized = clampCustomReminderMinutes(minutes);
  if (normalized === 0) {
    return mode === "timed" ? "0h" : "0d";
  }
  return minutesToReminderId(normalized);
}

function reminderPresetToMinutes(id: ReminderPreset): number {
  if (BUILTIN_REMINDER_IDS.has(id as BuiltinReminderPreset)) {
    return BUILTIN_REMINDER_MINUTES.get(id as BuiltinReminderPreset) ?? 0;
  }
  const match = typeof id === 'string' ? id.match(CUSTOM_REMINDER_PATTERN) : null;
  if (!match) return 0;
  return clampCustomReminderMinutes(parseInt(match[1] ?? '0', 10));
}

function formatReminderLabel(minutes: number): { label: string; badge: string } {
  if (!Number.isFinite(minutes)) {
    return {
      label: "On the day",
      badge: "day of",
    };
  }
  if (minutes === 0) {
    return {
      label: "On the day",
      badge: "day of",
    };
  }
  const mins = clampCustomReminderMinutes(minutes);
  const direction = mins < 0 ? "after" : "before";
  const signPrefix = mins < 0 ? "+" : "";
  const absMins = Math.abs(mins);
  if (absMins % 1440 === 0) {
    const days = absMins / 1440;
    return {
      label: `${days} day${days === 1 ? '' : 's'} ${direction}`,
      badge: `${signPrefix}${days}d`,
    };
  }
  if (absMins % 60 === 0) {
    const hours = absMins / 60;
    return {
      label: `${hours} hour${hours === 1 ? '' : 's'} ${direction}`,
      badge: `${signPrefix}${hours}h`,
    };
  }
  return {
    label: `${absMins} minute${absMins === 1 ? '' : 's'} ${direction}`,
    badge: `${signPrefix}${absMins}m`,
  };
}

type ReminderOption = { id: ReminderPreset; label: string; badge: string; minutes: number; builtin: boolean };

function buildReminderOptions(extraPresetIds: ReminderPreset[] = [], mode: ReminderPresetMode = "timed"): ReminderOption[] {
  const modePresets = mode === "date" ? DATE_REMINDER_PRESETS : TIMED_REMINDER_PRESETS;
  const options = new Map<ReminderPreset, ReminderOption>(
    modePresets.map((preset) => [preset.id, { ...preset, builtin: true }] as const),
  );
  const extras: ReminderOption[] = [];
  for (const id of extraPresetIds) {
    if (options.has(id)) continue;
    const minutes = reminderPresetToMinutes(id);
    if (!Number.isFinite(minutes)) continue;
    const { label, badge } = formatReminderLabel(minutes);
    extras.push({ id, label, badge, minutes, builtin: !String(id).startsWith("custom-") });
  }
  extras.sort((a, b) => a.minutes - b.minutes);
  return [...options.values(), ...extras];
}

function sanitizeReminderList(value: unknown): ReminderPreset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dedupByMinutes = new Map<number, ReminderPreset>();
  const addByMinutes = (id: ReminderPreset) => {
    const minutes = reminderPresetToMinutes(id);
    if (!Number.isFinite(minutes)) return;
    if (!dedupByMinutes.has(minutes)) {
      dedupByMinutes.set(minutes, id);
    }
  };
  for (const item of value) {
    if (typeof item === 'string') {
      if (BUILTIN_REMINDER_IDS.has(item as BuiltinReminderPreset)) {
        addByMinutes(item as ReminderPreset);
        continue;
      }
      if (CUSTOM_REMINDER_PATTERN.test(item)) {
        const minutes = reminderPresetToMinutes(item as ReminderPreset);
        if (Number.isFinite(minutes)) addByMinutes(minutesToReminderId(minutes));
      }
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      const remId = minutesToReminderId(item);
      addByMinutes(remId);
    }
  }
  const sorted = [...dedupByMinutes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, id]) => id);
  return sorted;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function latestScriptureReviewISO(entries: ScriptureMemoryEntry[]): string | undefined {
  let latestTime = Number.NEGATIVE_INFINITY;
  let latestISO: string | undefined;
  for (const entry of entries) {
    if (!entry.lastReviewISO) continue;
    const time = new Date(entry.lastReviewISO).getTime();
    if (!Number.isFinite(time)) continue;
    if (time > latestTime) {
      latestTime = time;
      latestISO = new Date(time).toISOString();
    }
  }
  return Number.isFinite(latestTime) && latestTime > Number.NEGATIVE_INFINITY ? latestISO : undefined;
}

function updateScriptureMemoryState(
  prev: ScriptureMemoryState,
  entries: ScriptureMemoryEntry[],
  overrideLastReview?: string
): ScriptureMemoryState {
  const next: ScriptureMemoryState = { ...prev, entries };
  const normalizedOverride = normalizeIsoTimestamp(overrideLastReview);
  if (normalizedOverride) {
    next.lastReviewISO = normalizedOverride;
  } else {
    next.lastReviewISO = latestScriptureReviewISO(entries);
  }
  if (!next.lastReviewISO) {
    delete (next as { lastReviewISO?: string }).lastReviewISO;
  }
  return next;
}

function markScriptureEntryReviewed(
  prev: ScriptureMemoryState,
  entryId: string,
  completedAtISO: string,
  stageBefore?: number | null,
): ScriptureMemoryState {
  let changed = false;
  const entries = prev.entries.map((entry) => {
    if (entry.id !== entryId) return entry;
    changed = true;
    const baseStage = typeof stageBefore === "number" ? stageBefore : entry.stage ?? 0;
    const nextStage = Math.min(MAX_SCRIPTURE_STAGE, Math.max(0, baseStage + 1));
    return {
      ...entry,
      stage: nextStage,
      totalReviews: (entry.totalReviews ?? 0) + 1,
      lastReviewISO: completedAtISO,
      scheduledAtISO: undefined,
    };
  });
  if (!changed) return prev;
  return updateScriptureMemoryState(prev, entries, completedAtISO);
}

function scheduleScriptureEntry(
  prev: ScriptureMemoryState,
  entryId: string,
  scheduledAtISO: string
): ScriptureMemoryState {
  let changed = false;
  const entries = prev.entries.map((entry) => {
    if (entry.id !== entryId) return entry;
    changed = true;
    return { ...entry, scheduledAtISO };
  });
  if (!changed) return prev;
  return updateScriptureMemoryState(prev, entries, prev.lastReviewISO);
}

function sanitizeScriptureMemoryState(raw: any): ScriptureMemoryState {
  const now = new Date().toISOString();
  if (!raw || typeof raw !== "object") {
    return { entries: [] };
  }
  const entries: ScriptureMemoryEntry[] = Array.isArray((raw as any).entries)
    ? (raw as any).entries
        .map((entry: any) => {
          const bookId = typeof entry?.bookId === "string" ? entry.bookId : "";
          const chapter = Number(entry?.chapter);
          if (!bookId || Number.isNaN(chapter) || chapter <= 0) return null;
          const chapterCount = getBibleBookChapterCount(bookId);
          if (!chapterCount || chapter > chapterCount) return null;
          const verseCount = getBibleChapterVerseCount(bookId, chapter);
          if (!verseCount) return null;
          let startVerse = Number(entry?.startVerse);
          if (!Number.isFinite(startVerse) || startVerse <= 0) startVerse = 1;
          let endVerse = Number(entry?.endVerse);
          if (!Number.isFinite(endVerse) || endVerse <= 0) endVerse = startVerse;
          startVerse = Math.max(1, Math.min(verseCount, Math.floor(startVerse)));
          endVerse = Math.max(startVerse, Math.min(verseCount, Math.floor(endVerse)));
          const addedAtISO = typeof entry?.addedAtISO === "string" && entry.addedAtISO ? entry.addedAtISO : now;
          const lastReviewISO = typeof entry?.lastReviewISO === "string" && entry.lastReviewISO ? entry.lastReviewISO : undefined;
          const scheduledAtISO = typeof entry?.scheduledAtISO === "string" && entry.scheduledAtISO
            ? entry.scheduledAtISO
            : undefined;
          const stageRaw = Number(entry?.stage);
          const stage = Number.isFinite(stageRaw) && stageRaw >= 0 ? Math.min(Math.floor(stageRaw), MAX_SCRIPTURE_STAGE) : 0;
          const totalReviewsRaw = Number(entry?.totalReviews);
          const totalReviews = Number.isFinite(totalReviewsRaw) && totalReviewsRaw > 0 ? Math.floor(totalReviewsRaw) : 0;
          const id = typeof entry?.id === "string" && entry.id ? entry.id : crypto.randomUUID();
          return {
            id,
            bookId,
            chapter,
            startVerse,
            endVerse,
            addedAtISO,
            lastReviewISO,
            scheduledAtISO,
            stage,
            totalReviews,
          } as ScriptureMemoryEntry;
        })
        .filter((entry): entry is ScriptureMemoryEntry => !!entry)
    : [];
  const state = updateScriptureMemoryState({ entries }, entries);
  const persistedLastReview = normalizeIsoTimestamp((raw as any)?.lastReviewISO);
  if (persistedLastReview) {
    state.lastReviewISO = persistedLastReview;
  }
  return state;
}

function formatScriptureReference(entry: ScriptureMemoryEntry): string {
  const book = getBibleBookTitle(entry.bookId) ?? entry.bookId;
  const verseStart = entry.startVerse ?? null;
  const verseEnd = entry.endVerse ?? null;
  if (verseStart && verseEnd && verseStart !== verseEnd) {
    return `${book} ${entry.chapter}:${verseStart}-${verseEnd}`;
  }
  if (verseStart) {
    return `${book} ${entry.chapter}:${verseStart}`;
  }
  return `${book} ${entry.chapter}`;
}

function formatDueInLabel(dueInDays: number): string {
  if (!Number.isFinite(dueInDays)) return "Due now";
  if (Math.abs(dueInDays) < 0.5) return "Due now";
  const rounded = Math.round(dueInDays);
  if (rounded === 0) return "Due now";
  const abs = Math.abs(rounded);
  const unit = abs === 1 ? "day" : "days";
  if (rounded > 0) return `Due in ${abs} ${unit}`;
  return `Overdue by ${abs} ${unit}`;
}

function computeScriptureIntervalDays(entry: ScriptureMemoryEntry, baseDays: number, totalEntries: number): number {
  const entryCountFactor = Math.max(1, Math.log2(totalEntries + 1));
  const normalizedBase = Math.max(0.5, baseDays / entryCountFactor);
  const stageFactor = Math.pow(SCRIPTURE_STAGE_GROWTH, Math.max(0, entry.stage || 0));
  const interval = normalizedBase * stageFactor;
  return Math.min(interval, SCRIPTURE_INTERVAL_CAP_DAYS);
}

function computeScriptureStats(
  entry: ScriptureMemoryEntry,
  baseDays: number,
  totalEntries: number,
  now: Date
): {
  intervalDays: number;
  daysSinceReview: number;
  score: number;
  dueInDays: number;
  dueNow: boolean;
} {
  const intervalDays = computeScriptureIntervalDays(entry, baseDays, totalEntries);
  const lastReview = entry.lastReviewISO ? new Date(entry.lastReviewISO) : null;
  let daysSinceReview = lastReview ? (now.getTime() - lastReview.getTime()) / 86400000 : Infinity;
  if (!Number.isFinite(daysSinceReview)) daysSinceReview = Infinity;
  const score = !lastReview ? Number.POSITIVE_INFINITY : daysSinceReview / Math.max(intervalDays, 0.5);
  const dueInDays = !lastReview ? 0 : intervalDays - daysSinceReview;
  const dueNow = !lastReview || daysSinceReview >= intervalDays * 0.95;
  return { intervalDays, daysSinceReview, score, dueInDays, dueNow };
}

function scriptureFrequencyToRecurrence(baseDays: number): Recurrence {
  const normalized = Math.max(1, Math.round(baseDays));
  if (normalized <= 1) return { type: "daily" };
  return { type: "every", n: normalized, unit: "day" };
}

function recurrencesEqual(a: Recurrence | undefined, b: Recurrence | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function chooseNextScriptureEntry(
  entries: ScriptureMemoryEntry[],
  baseDays: number,
  now: Date
): { entry: ScriptureMemoryEntry; stats: ReturnType<typeof computeScriptureStats> } | null {
  if (!entries.length) return null;
  const total = entries.length;
  let best: { entry: ScriptureMemoryEntry; stats: ReturnType<typeof computeScriptureStats> } | null = null;
  for (const entry of entries) {
    const stats = computeScriptureStats(entry, baseDays, total, now);
    if (!entry.lastReviewISO) {
      return { entry, stats };
    }
    if (!best || stats.score > best.stats.score) {
      best = { entry, stats };
    }
  }
  if (!best) return null;
  return best;
}

const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  enabled: false,
  platform: INFERRED_PUSH_PLATFORM,
  permission: (typeof Notification !== 'undefined' ? Notification.permission : 'default') as NotificationPermission,
};

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

type ListColumn = { id: string; name: string };
type CompoundIndexGroup = {
  key: string;
  boardId: string;
  boardName: string;
  columns: { id: string; name: string }[];
};

type BoardBase = {
  id: string;
  name: string;
  // Optional Nostr sharing metadata
  nostr?: { boardId: string; relays: string[] };
  archived?: boolean;
  hidden?: boolean;
  clearCompletedDisabled?: boolean;
};

type CompoundChildId = string;

function parseCompoundChildInput(raw: string): { boardId: string; relays: string[] } {
  const trimmed = raw.trim();
  if (!trimmed) return { boardId: "", relays: [] };
  let boardId = trimmed;
  let relaySegment = "";
  const atIndex = trimmed.indexOf("@");
  if (atIndex >= 0) {
    boardId = trimmed.slice(0, atIndex).trim();
    relaySegment = trimmed.slice(atIndex + 1).trim();
  } else {
    const spaceIndex = trimmed.search(/\s/);
    if (spaceIndex >= 0) {
      boardId = trimmed.slice(0, spaceIndex).trim();
      relaySegment = trimmed.slice(spaceIndex + 1).trim();
    }
  }
  const relays = relaySegment
    ? relaySegment.split(/[\s,]+/).map((relay) => relay.trim()).filter(Boolean)
    : [];
  return { boardId, relays };
}

type Board =
  | (BoardBase & { kind: "week" }) // fixed Sun–Sat
  | (BoardBase & { kind: "lists"; columns: ListColumn[]; indexCardEnabled?: boolean }) // multiple customizable columns
  | (BoardBase & {
      kind: "compound";
      children: CompoundChildId[];
      indexCardEnabled?: boolean;
      hideChildBoardNames?: boolean;
    })
  | (BoardBase & { kind: "bible" });

type ListLikeBoard = Extract<Board, { kind: "lists" | "compound" }>;

function isListLikeBoard(board: Board | null | undefined): board is ListLikeBoard {
  return !!board && (board.kind === "lists" || board.kind === "compound");
}

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

function compoundChildMatchesBoard(childId: string, board: Board): boolean {
  return childId === board.id || (!!board.nostr?.boardId && childId === board.nostr.boardId);
}

function normalizeCompoundChildId(boards: Board[], childId: string): string {
  const match = findBoardByCompoundChildId(boards, childId);
  return match ? match.id : childId;
}

type Settings = {
  weekStart: Weekday; // 0=Sun, 1=Mon, 6=Sat
  newTaskPosition: "top" | "bottom";
  streaksEnabled: boolean;
  completedTab: boolean;
  bibleTrackerEnabled: boolean;
  scriptureMemoryEnabled: boolean;
  scriptureMemoryBoardId?: string | null;
  scriptureMemoryFrequency: ScriptureMemoryFrequency;
  scriptureMemorySort: ScriptureMemorySort;
  fastingRemindersEnabled: boolean;
  fastingRemindersMode: FastingRemindersMode;
  fastingRemindersPerMonth: number;
  fastingRemindersWeekday: Weekday;
  fastingRemindersRandomSeed: string;
  showFullWeekRecurring: boolean;
  // Base UI font size in pixels; null uses the OS preferred size
  baseFontSize: number | null;
  startBoardByDay: Partial<Record<Weekday, string>>;
  accent: "green" | "blue" | "background";
  backgroundImage?: string | null;
  backgroundAccent?: AccentPalette | null;
  backgroundAccents?: AccentPalette[] | null;
  backgroundAccentIndex?: number | null;
  backgroundBlur: "blurred" | "sharp";
  hideCompletedSubtasks: boolean;
  startupView: "main" | "wallet";
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  walletSentStateChecksEnabled: boolean;
  walletPaymentRequestsEnabled: boolean;
  walletPaymentRequestsBackgroundChecksEnabled: boolean;
  walletMintBackupEnabled: boolean;
  walletContactsSyncEnabled: boolean;
  fileStorageServer: string;
  npubCashLightningAddressEnabled: boolean;
  npubCashAutoClaim: boolean;
  cloudBackupsEnabled: boolean;
  nostrBackupEnabled: boolean;
  // Metadata sync is controlled by nostrBackupEnabled; kept for backwards compat
  nostrBackupMetadataEnabled: boolean;
  pushNotifications: PushPreferences;
};

type AccentChoice = {
  id: "blue" | "green";
  label: string;
  fill: string;
  ring: string;
  border: string;
  borderActive: string;
  shadow: string;
  shadowActive: string;
};

const ACCENT_CHOICES: AccentChoice[] = [
  {
    id: "blue",
    label: "iMessage blue",
    fill: "#0a84ff",
    ring: "rgba(64, 156, 255, 0.32)",
    border: "rgba(64, 156, 255, 0.38)",
    borderActive: "rgba(64, 156, 255, 0.88)",
    shadow: "0 12px 26px rgba(10, 132, 255, 0.32)",
    shadowActive: "0 18px 34px rgba(10, 132, 255, 0.42)",
  },
  {
    id: "green",
    label: "Mint green",
    fill: "#34c759",
    ring: "rgba(52, 199, 89, 0.28)",
    border: "rgba(52, 199, 89, 0.36)",
    borderActive: "rgba(52, 199, 89, 0.86)",
    shadow: "0 12px 24px rgba(52, 199, 89, 0.28)",
    shadowActive: "0 18px 32px rgba(52, 199, 89, 0.38)",
  },
];

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

function isSameLocalDate(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

const R_NONE: Recurrence = { type: "none" };
const LS_TASKS = "taskify_tasks_v5";
const LS_BOARD_SYNC_CURSORS = "taskify_board_sync_cursors_v1";
const LS_CALENDAR_EVENTS = "taskify_calendar_events_v1";
const LS_EXTERNAL_CALENDAR_EVENTS = "taskify_calendar_external_events_v1";
const LS_CALENDAR_INVITES = "taskify_calendar_invites_v2";
const LS_SETTINGS = "taskify_settings_v2";
const LS_BOARDS = "taskify_boards_v2";
const LS_BOARD_SORT = "taskify_board_sort_v1";
const LS_UPCOMING_FILTER = "taskify_upcoming_filter_v1";
const LS_UPCOMING_US_HOLIDAYS_ENABLED = "taskify_upcoming_us_holidays_enabled_v1";
const LS_UPCOMING_VIEW = "taskify_upcoming_view_v1";
const LS_UPCOMING_SORT = "taskify_upcoming_sort_v1";
const LS_UPCOMING_BOARD_GROUPING = "taskify_upcoming_board_grouping_v1";
const LS_UPCOMING_FILTER_PRESETS = "taskify_upcoming_filter_presets_v1";
const LS_FIRST_RUN_ONBOARDING_DONE = "taskify_onboarding_done_v1";

const LS_BIBLE_TRACKER = "taskify_bible_tracker_v1";
const LS_BIBLE_PRINT_PAPER = "taskify_bible_print_paper_v1";
const LS_BOARD_PRINT_JOBS = "taskify_board_print_jobs_v1";
const LS_LAST_CLOUD_BACKUP = "taskify_cloud_backup_last_v1";
const LS_LAST_MANUAL_CLOUD_BACKUP = "taskify_cloud_backup_manual_last_v1";
const CLOUD_BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000;
const MANUAL_CLOUD_BACKUP_INTERVAL_MS = 60 * 1000;
const SATS_PER_BTC = 100_000_000;
const HISTORY_MARK_SPENT_CUTOFF_MS = 5 * 24 * 60 * 60 * 1000;

type WalletHistoryEntryKind = "bounty-attachment";

type TaskifyBackupPayload = {
  tasks: unknown;
  calendarEvents: unknown;
  externalCalendarEvents?: unknown;
  boards: unknown;
  settings: unknown;
  scriptureMemory: unknown;
  bibleTracker: unknown;
  defaultRelays: unknown;
  contacts: unknown;
  contactsSyncMeta?: unknown;
  nostrSk: string;
  cashu: {
    proofs: unknown;
    activeMint: string | null;
    history: unknown;
    trackedMints: string[];
    pendingTokens: PendingTokenEntry[];
    walletSeed: WalletSeedBackupPayload;
  };
};

function parseBackupJsonPayload(raw: string): Partial<TaskifyBackupPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid backup file.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid backup data");
  }
  return parsed as Partial<TaskifyBackupPayload>;
}

function applyBackupDataToStorage(data: Partial<TaskifyBackupPayload>): void {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid backup data");
  }
  // Derive per-board sync cursors from the max task timestamp in the backup instead
  // of clearing them to {}. Clearing to {} caused limit:500 on the next open which
  // fetched all recent events including old CREATE events whose DELETE events were
  // beyond the 500 limit — those old tasks would reappear temporarily.
  //
  // By seeding the cursor from the backup's task timestamps, the post-restore sync
  // uses since:(max_task_time - lookback) and only fetches events newer than the
  // backup, which are exactly the changes the user missed while offline.
  const RESTORE_LOOKBACK_SECS = 3600; // 1 hour buffer for clock skew / in-flight events
  // Build a map from local boardId → max task timestamp (to avoid iterating boards twice)
  const boardLocalMaxSecs = new Map<string, number>();
  if (Array.isArray(data.tasks)) {
    for (const task of data.tasks as Array<{ boardId?: string; createdAt?: number; updatedAt?: string }>) {
      if (!task.boardId) continue;
      let secs = 0;
      if (typeof task.createdAt === "number" && task.createdAt > 0) {
        secs = Math.max(secs, Math.floor(task.createdAt / 1000));
      }
      if (typeof task.updatedAt === "string") {
        const ms = Date.parse(task.updatedAt);
        if (!isNaN(ms) && ms > 0) secs = Math.max(secs, Math.floor(ms / 1000));
      }
      boardLocalMaxSecs.set(task.boardId, Math.max(boardLocalMaxSecs.get(task.boardId) ?? 0, secs));
    }
  }
  // Cursors must be keyed by bTag = boardTag(b.nostr!.boardId) — this is how the
  // subscription loop reads them (it.id = boardTag(b.nostr!.boardId)).
  const cursors: Record<string, number> = {};
  if (Array.isArray(data.boards)) {
    for (const board of data.boards as Array<{ id?: string; nostr?: { boardId?: string } }>) {
      const localId = board.id;
      const nostrBoardId = board.nostr?.boardId;
      if (!localId || !nostrBoardId) continue;
      const maxSecs = boardLocalMaxSecs.get(localId) ?? 0;
      if (maxSecs > 0) {
        const bTag = boardTag(nostrBoardId);
        cursors[bTag] = Math.max(0, maxSecs - RESTORE_LOOKBACK_SECS);
      }
    }
  }
  idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS, JSON.stringify(cursors));
  if ("tasks" in data && data.tasks !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_TASKS, JSON.stringify(data.tasks));
  }
  if ("calendarEvents" in data && data.calendarEvents !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_CALENDAR_EVENTS, JSON.stringify(data.calendarEvents));
  }
  if ("externalCalendarEvents" in data && data.externalCalendarEvents !== undefined) {
    idbKeyValue.setItem(
      TASKIFY_STORE_TASKS,
      LS_EXTERNAL_CALENDAR_EVENTS,
      JSON.stringify(data.externalCalendarEvents),
    );
  }
  if ("boards" in data && data.boards !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARDS, JSON.stringify(data.boards));
  }
  if ("settings" in data && data.settings !== undefined) {
    kvStorage.setItem(LS_SETTINGS, JSON.stringify(data.settings));
  }
  if ("scriptureMemory" in data && data.scriptureMemory !== undefined) {
    kvStorage.setItem(LS_SCRIPTURE_MEMORY, JSON.stringify(data.scriptureMemory));
  }
  if ("bibleTracker" in data && data.bibleTracker !== undefined) {
    kvStorage.setItem(LS_BIBLE_TRACKER, JSON.stringify(data.bibleTracker));
  }
  if ("defaultRelays" in data && data.defaultRelays !== undefined) {
    kvStorage.setItem(LS_NOSTR_RELAYS, JSON.stringify(data.defaultRelays));
  }
  if ("contacts" in data && data.contacts !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_LIGHTNING_CONTACTS, JSON.stringify(data.contacts));
  }
  if ("contactsSyncMeta" in data && data.contactsSyncMeta !== undefined) {
    idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_CONTACTS_SYNC_META, JSON.stringify(data.contactsSyncMeta));
  }
  if (typeof data.nostrSk === "string" && data.nostrSk) {
    kvStorage.setItem(LS_NOSTR_SK, data.nostrSk);
  }
  const cashuData = data.cashu as Partial<TaskifyBackupPayload["cashu"]> | undefined;
  if (cashuData && typeof cashuData === "object") {
    if ("proofs" in cashuData && cashuData.proofs !== undefined) {
      saveProofStore(cashuData.proofs);
    }
    if ("activeMint" in cashuData) {
      setActiveMint(cashuData.activeMint || null);
    }
    if ("history" in cashuData) {
      try {
        const history = Array.isArray(cashuData.history) ? cashuData.history : [];
        idbKeyValue.setItem(TASKIFY_STORE_WALLET, "cashuHistory", JSON.stringify(history));
      } catch {
        idbKeyValue.removeItem(TASKIFY_STORE_WALLET, "cashuHistory");
      }
    }
    if ("trackedMints" in cashuData && cashuData.trackedMints !== undefined) {
      replaceMintList(Array.isArray(cashuData.trackedMints) ? cashuData.trackedMints : []);
    }
    if ("pendingTokens" in cashuData && cashuData.pendingTokens !== undefined) {
      const entries = Array.isArray(cashuData.pendingTokens)
        ? (cashuData.pendingTokens as PendingTokenEntry[])
        : [];
      replacePendingTokens(entries);
    }
    if ("walletSeed" in cashuData && cashuData.walletSeed) {
      restoreWalletSeedBackup(cashuData.walletSeed as WalletSeedBackupPayload);
    }
  }
}

type UpcomingFilterOption = {
  id: string;
  label: string;
  boardId: string;
  columnId?: string;
};

type UpcomingFilterGroup = {
  id: string;
  label: string;
  boardId: string;
  boardOption: UpcomingFilterOption;
  listOptions: UpcomingFilterOption[];
};

type UpcomingFilterPreset = {
  id: string;
  name: string;
  selection: string[];
};

type NostrBackupState = {
  lastEventId: string | null;
  lastTimestamp: number;
  pubkey: string | null;
};

type NostrBackupSnapshot = {
  boards: NostrAppBackupBoard[];
  settings: Partial<Settings>;
  walletSeed: WalletSeedBackupPayload;
  defaultRelays: string[];
};
const NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS = 1500;

type WalletHistoryLogEntry = {
  id?: string;
  summary: string;
  type: "lightning" | "ecash";
  direction: "in" | "out";
  amountSat?: number;
  detail?: string;
  detailKind?: "token" | "invoice" | "note";
  mintUrl?: string;
  feeSat?: number;
  entryKind?: WalletHistoryEntryKind;
  relatedTaskTitle?: string;
};

function readWalletConversionsEnabled(fallback?: boolean): boolean {
  if (typeof fallback === "boolean") return fallback;
  try {
    const raw = kvStorage.getItem(LS_SETTINGS);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    return parsed?.walletConversionEnabled !== false;
  } catch {
    return true;
  }
}

function readCachedUsdPrice(): number | null {
  try {
    const raw = kvStorage.getItem(LS_BTC_USD_PRICE_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const price = Number(parsed?.price);
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

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

function loadBiblePrintPaperSize(): PrintPaperSize {
  try {
    const raw = kvStorage.getItem(LS_BIBLE_PRINT_PAPER);
    return isPrintPaperSize(raw) ? raw : "letter";
  } catch {
    return "letter";
  }
}

function persistBiblePrintPaperSize(paperSize: PrintPaperSize): void {
  try {
    kvStorage.setItem(LS_BIBLE_PRINT_PAPER, paperSize);
  } catch {}
}

function captureHistoryFiatValue(amountSat?: number | null, conversionsEnabled?: boolean): number | undefined {
  if (!conversionsEnabled || amountSat == null || !Number.isFinite(amountSat) || amountSat <= 0) {
    return undefined;
  }
  const cachedPrice = readCachedUsdPrice();
  if (cachedPrice == null || cachedPrice <= 0) return undefined;
  const usdValue = (amountSat / SATS_PER_BTC) * cachedPrice;
  return Number.isFinite(usdValue) ? Number(usdValue.toFixed(2)) : undefined;
}

function appendWalletHistoryEntry(entry: WalletHistoryLogEntry, options?: { conversionsEnabled?: boolean }) {
  try {
    const conversionsEnabled = readWalletConversionsEnabled(options?.conversionsEnabled);
    const raw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashuHistory");
    const existing = raw ? JSON.parse(raw) : [];
    const createdAt = Date.now();
    const fiatValueUsd = captureHistoryFiatValue(entry.amountSat, conversionsEnabled);
    const normalized = {
      id: entry.id ?? `${entry.type}-${createdAt}`,
      summary: entry.summary,
      type: entry.type,
      direction: entry.direction,
      amountSat: entry.amountSat,
      detail: entry.detail,
      detailKind: entry.detailKind,
      mintUrl: entry.mintUrl,
      feeSat: entry.feeSat,
      entryKind: entry.entryKind,
      relatedTaskTitle: entry.relatedTaskTitle,
      createdAt,
      fiatValueUsd,
    };
    const next = Array.isArray(existing) ? [normalized, ...existing] : [normalized];
    idbKeyValue.setItem(TASKIFY_STORE_WALLET, "cashuHistory", JSON.stringify(next));
    try {
      window.dispatchEvent(new Event("taskify:wallet-history-updated"));
    } catch {
      // ignore
    }
  } catch (error) {
    console.warn("Failed to append wallet history entry", error);
  }
}

/* ================= Nostr minimal client ================= */
type NostrEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

type NostrUnsignedEvent = Omit<NostrEvent, "id" | "sig" | "pubkey"> & {
  pubkey?: string;
};

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (e: NostrUnsignedEvent) => Promise<NostrEvent>;
    };
  }
}

const NOSTR_MIN_EVENT_INTERVAL_MS = 200;
const NOSTR_MIGRATION_BUFFER_MS = 15000;
const NOSTR_INITIAL_SYNC_TIMEOUT_MS = 25000; // absolute fallback — must exceed typical sync time
const NOSTR_EOSE_GRACE_MS = 200; // inactivity window after first relay EOSE before flushing
// How many seconds to look back before the stored cursor to guard against
// clock skew and events that arrived slightly out of order across relays.
const NOSTR_CURSOR_LOOKBACK_SECS = 300;

function loadDefaultRelays(): string[] {
  try {
    const raw = kvStorage.getItem(LS_NOSTR_RELAYS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
    }
  } catch {}
  return DEFAULT_NOSTR_RELAYS.slice();
}

function saveDefaultRelays(relays: string[]) {
  kvStorage.setItem(LS_NOSTR_RELAYS, JSON.stringify(relays));
}

function loadNostrBackupState(): NostrBackupState {
  try {
    const raw = kvStorage.getItem(LS_NOSTR_BACKUP_STATE);
    if (!raw) return { lastEventId: null, lastTimestamp: 0, pubkey: null };
    const parsed = JSON.parse(raw);
    const lastEventId = typeof parsed?.lastEventId === "string" ? parsed.lastEventId : null;
    const lastTimestamp = Number(parsed?.lastTimestamp) || 0;
    const pubkey = typeof parsed?.pubkey === "string" ? parsed.pubkey : null;
    return { lastEventId, lastTimestamp, pubkey };
  } catch {
    return { lastEventId: null, lastTimestamp: 0, pubkey: null };
  }
}

function loadNostrSyncState(storageKey: string): NostrBackupState {
  try {
    const raw = kvStorage.getItem(storageKey);
    if (!raw) return { lastEventId: null, lastTimestamp: 0, pubkey: null };
    const parsed = JSON.parse(raw);
    const lastEventId = typeof parsed?.lastEventId === "string" ? parsed.lastEventId : null;
    const lastTimestamp = Number(parsed?.lastTimestamp) || 0;
    const pubkey = typeof parsed?.pubkey === "string" ? parsed.pubkey : null;
    return { lastEventId, lastTimestamp, pubkey };
  } catch {
    return { lastEventId: null, lastTimestamp: 0, pubkey: null };
  }
}

type NostrPool = {
  ensureRelay: (url: string) => void;
  setRelays: (urls: string[]) => void;
  subscribe: (
    relays: string[],
    filters: any[],
    onEvent: (ev: NostrEvent, from: string) => void,
    onEose?: (from: string) => void
  ) => () => void;
  subscribeMany: (
    relays: string[],
    filter: any,
    opts?: { onevent?: (ev: NostrEvent) => void; oneose?: (relay?: string) => void; closeOnEose?: boolean },
  ) => { close: (...args: any[]) => void };
  publish: (relays: string[], event: NostrUnsignedEvent) => Promise<void>;
  publishEvent: (relays: string[], event: NostrEvent) => void;
  list?: (relays: string[], filters: any[]) => Promise<NostrEvent[]>;
  get?: (relays: string[], filter: any) => Promise<NostrEvent | null>;
};

function createNostrPool(): NostrPool {
  const pool = new SessionPool();
  return {
    ensureRelay(url: string) {
      if (url) void NostrSession.init([url]);
    },
    setRelays(urls: string[]) {
      if (Array.isArray(urls) && urls.length) void NostrSession.init(urls);
    },
    subscribe(relayUrls, filters, onEvent, onEose) {
      return pool.subscribe(relayUrls, filters, onEvent, onEose);
    },
    subscribeMany(relayUrls, filter, opts) {
      return pool.subscribeMany(relayUrls, filter, opts);
    },
    async publish(relayUrls, event) {
      await pool.publish(relayUrls, event as unknown as NostrEvent);
    },
    publishEvent(relayUrls, event) {
      void pool.publishEvent(relayUrls, event as unknown as NostrEvent);
    },
    list: pool.list.bind(pool),
    get: pool.get.bind(pool),
  };
}

/* ================== Crypto helpers (AES-GCM via local Nostr key) ================== */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(h);
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
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
  const skHex = kvStorage.getItem(LS_NOSTR_SK) || "";
  if (!skHex || !/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  const label = new TextEncoder().encode("taskify-ecash-v1");
  const raw = concatBytes(hexToBytes(skHex), label);
  const digest = await sha256(raw);
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt","decrypt"]);
}
export async function encryptEcashTokenForFunder(plain: string): Promise<{alg:"aes-gcm-256";iv:string;ct:string}> {
  const key = await deriveAesKeyFromLocalSk();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { alg: "aes-gcm-256", iv: b64encode(iv), ct: b64encode(ctBuf) };
}
export async function decryptEcashTokenForFunder(enc: {alg:"aes-gcm-256";iv:string;ct:string}): Promise<string> {
  if (enc.alg !== "aes-gcm-256") throw new Error("Unsupported cipher");
  const key = await deriveAesKeyFromLocalSk();
  const iv = b64decode(enc.iv);
  const ct = b64decode(enc.ct);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

// NIP-04 encryption for recipient
async function encryptEcashTokenForRecipient(recipientHex: string, plain: string): Promise<{ alg: "nip04"; data: string }> {
  const skHex = kvStorage.getItem(LS_NOSTR_SK) || "";
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  if (!/^[0-9a-fA-F]{64}$/.test(recipientHex)) throw new Error("Invalid recipient pubkey");
  const data = await nip04.encrypt(skHex, recipientHex, plain);
  return { alg: "nip04", data };
}

async function decryptEcashTokenForRecipient(senderHex: string, enc: { alg: "nip04"; data: string }): Promise<string> {
  const skHex = kvStorage.getItem(LS_NOSTR_SK) || "";
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  if (!/^[0-9a-fA-F]{64}$/.test(senderHex)) throw new Error("Invalid sender pubkey");
  return await nip04.decrypt(skHex, senderHex, enc.data);
}

const CLOUD_BACKUP_KEY_LABEL = new TextEncoder().encode("taskify-cloud-backup-v1");

async function deriveBackupAesKey(skHex: string): Promise<CryptoKey> {
  const raw = concatBytes(hexToBytes(skHex), CLOUD_BACKUP_KEY_LABEL);
  const digest = await sha256(raw);
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptBackupWithSecretKey(skHex: string, plain: string): Promise<{ iv: string; ciphertext: string }> {
  const key = await deriveBackupAesKey(skHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { iv: b64encode(iv), ciphertext: b64encode(ctBuf) };
}

async function decryptBackupWithSecretKey(
  skHex: string,
  payload: { iv: string; ciphertext: string },
): Promise<string> {
  const key = await deriveBackupAesKey(skHex);
  const iv = b64decode(payload.iv);
  const ct = b64decode(payload.ciphertext);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

function deriveNpubFromSecretKeyHex(skHex: string): string | null {
  try {
    const pkHex = getPublicKey(hexToBytes(skHex));
    if (typeof (nip19 as any)?.npubEncode === "function") {
      return (nip19 as any).npubEncode(pkHex);
    }
    return pkHex;
  } catch {
    return null;
  }
}

function normalizeSecretKeyInput(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("nsec")) {
    try {
      const dec = nip19.decode(value);
      if (dec.type !== "nsec") return null;
      value = typeof dec.data === "string" ? dec.data : bytesToHex(dec.data);
    } catch {
      return null;
    }
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

async function loadCloudBackupPayload(
  workerBaseUrl: string,
  secretKeyInput: string,
): Promise<Partial<TaskifyBackupPayload>> {
  if (!workerBaseUrl) {
    throw new Error("Cloud backup service is unavailable.");
  }
  const normalized = normalizeSecretKeyInput(secretKeyInput);
  if (!normalized) {
    throw new Error("Enter a valid nsec or 64-hex private key.");
  }
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Browser crypto APIs are unavailable.");
  }
  const npub = deriveNpubFromSecretKeyHex(normalized);
  if (!npub) {
    throw new Error("Unable to derive npub from the provided key.");
  }
  const res = await fetch(`${workerBaseUrl}/api/backups?npub=${encodeURIComponent(npub)}`);
  if (res.status === 404) {
    throw new Error("No cloud backup found for that key.");
  }
  if (!res.ok) {
    throw new Error(`Backup request failed (${res.status})`);
  }
  const body = await res.json();
  const backup = body?.backup;
  if (!backup || typeof backup !== "object" || typeof backup.ciphertext !== "string" || typeof backup.iv !== "string") {
    throw new Error("Invalid backup payload received.");
  }
  const decrypted = await decryptBackupWithSecretKey(normalized, {
    ciphertext: backup.ciphertext,
    iv: backup.iv,
  });
  try {
    return parseBackupJsonPayload(decrypted);
  } catch {
    throw new Error("Cloud backup could not be decoded.");
  }
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

function toNsec(secret: string): string {
  const trimmed = (secret || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("nsec")) return trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  try {
    const skBytes = hexToBytes(trimmed);
    return typeof (nip19 as any)?.nsecEncode === "function" ? (nip19 as any).nsecEncode(skBytes) : trimmed;
  } catch {
    return trimmed;
  }
}

async function fileToDataURL(file: File): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(fr.result as string);
    fr.readAsDataURL(file);
  });

  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1280;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function readDocumentsFromFiles(list: FileList | File[]): Promise<TaskDocument[]> {
  const files = Array.from(list);
  const attachments: TaskDocument[] = [];
  for (const file of files) {
    if (!isSupportedDocumentFile(file)) {
      throw new Error("Unsupported file type");
    }
    const doc = await createDocumentAttachment(file);
    attachments.push(ensureDocumentPreview(doc));
  }
  return attachments;
}

/* ================= Date helpers ================= */
function startOfDay(d: Date) {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ZONE_VALIDATION_CACHE = new Map<string, string | null>();
const DATE_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const TIME_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const OFFSET_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function resolveSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function normalizeTimeZone(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (TIME_ZONE_VALIDATION_CACHE.has(trimmed)) return TIME_ZONE_VALIDATION_CACHE.get(trimmed) ?? null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    TIME_ZONE_VALIDATION_CACHE.set(trimmed, trimmed);
    return trimmed;
  } catch {
    TIME_ZONE_VALIDATION_CACHE.set(trimmed, null);
    return null;
  }
}

function formatDateKeyFromParts(year: number, month: number, day: number): string {
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateKeyLocal(date: Date): string {
  return formatDateKeyFromParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function parseDateKey(value: string): { year: number; month: number; day: number } | null {
  if (!ISO_DATE_PATTERN.test(value)) return null;
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

function parseTimeValue(value: string): { hour: number; minute: number } | null {
  if (typeof value !== "string" || !value.includes(":")) return null;
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number.parseInt(hourRaw ?? "", 10);
  const minute = Number.parseInt(minuteRaw ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return {
    hour: Math.min(23, Math.max(0, hour)),
    minute: Math.min(59, Math.max(0, minute)),
  };
}

function getDateKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = DATE_KEY_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  DATE_KEY_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

function getTimeKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = TIME_KEY_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  TIME_KEY_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

function getOffsetFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = OFFSET_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  OFFSET_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

function formatDateKeyInTimeZone(date: Date, timeZone: string): string {
  const formatter = getDateKeyFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return formatDateKeyLocal(date);
  return `${year}-${month}-${day}`;
}

function formatTimeKeyInTimeZone(date: Date, timeZone: string): string {
  const formatter = getTimeKeyFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (!hour || !minute) return "";
  return `${hour}:${minute}`;
}

function getTimeZoneOffset(date: Date, timeZone: string): number {
  const formatter = getOffsetFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const second = Number(parts.find((part) => part.type === "second")?.value);
  if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value))) return 0;
  const asUTC = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUTC - date.getTime();
}

function formatOffsetLabel(offsetMinutes: number): string {
  if (!Number.isFinite(offsetMinutes)) return "UTC";
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date | null {
  const parsedDate = parseDateKey(dateStr);
  const parsedTime = parseTimeValue(timeStr);
  if (!parsedDate || !parsedTime) return null;
  const { year, month, day } = parsedDate;
  const { hour, minute } = parsedTime;
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimeZoneOffset(utcGuess, timeZone);
  let adjusted = new Date(utcGuess.getTime() - offset);
  const offsetCheck = getTimeZoneOffset(adjusted, timeZone);
  if (offsetCheck !== offset) {
    adjusted = new Date(utcGuess.getTime() - offsetCheck);
  }
  return adjusted;
}

function isoDatePart(iso: string, timeZone?: string): string {
  if (typeof iso === "string" && ISO_DATE_PATTERN.test(iso)) return iso;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return formatDateKeyLocal(new Date());
  const safeZone = normalizeTimeZone(timeZone);
  if (safeZone) return formatDateKeyInTimeZone(date, safeZone);
  return formatDateKeyLocal(date);
}

function formatUpcomingDayLabel(dateKey: string): string {
  const parsed = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateKey;
  const weekday = parsed.toLocaleDateString([], { weekday: "long" });
  const monthDay = parsed.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${weekday} — ${monthDay}`;
}

function isoTimePart(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const safeZone = normalizeTimeZone(timeZone);
  if (safeZone) return formatTimeKeyInTimeZone(date, safeZone);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function isoTimePartUtc(iso: string): string {
  if (typeof iso === 'string' && iso.length >= 16) return iso.slice(11, 16);
  try { return new Date(iso).toISOString().slice(11, 16); } catch { return ""; }
}

function weekdayFromISO(iso: string, timeZone?: string): Weekday | null {
  const dateKey = isoDatePart(iso, timeZone);
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const utc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  if (!Number.isFinite(utc)) return null;
  return new Date(utc).getUTCDay() as Weekday;
}

function taskDateKey(task: Task): string {
  return isoDatePart(task.dueISO, task.dueTimeZone);
}

function taskDisplayDateKey(task: Task): string {
  return isoDatePart(task.dueISO);
}

function taskTimeValue(task: Task): number | null {
  if (!task.dueTimeEnabled) return null;
  const timePart = isoTimePart(task.dueISO);
  const parsed = parseTimeValue(timePart);
  if (!parsed) return null;
  return parsed.hour * 60 + parsed.minute;
}

function taskWeekday(task: Task): Weekday | null {
  return weekdayFromISO(task.dueISO, task.dueTimeZone);
}

function calendarAnchorFrom(dateStr?: string | null) {
  const base = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  }
  return new Date(base.getFullYear(), base.getMonth(), 1);
}

function getWheelMetrics(column: HTMLDivElement | null) {
  if (!column) return null;
  const first = column.querySelector<HTMLElement>("[data-picker-index]");
  if (!first) return null;
  const optionHeight = first.getBoundingClientRect().height;
  const optionOffset = first.offsetTop;
  return { optionHeight, optionOffset };
}

function scrollWheelColumnToIndex(column: HTMLDivElement | null, index: number) {
  if (!column) return;
  const metrics = getWheelMetrics(column);
  if (!metrics) return;
  const { optionHeight, optionOffset } = metrics;
  const optionCenter = optionOffset + index * optionHeight + optionHeight / 2;
  const targetTop = optionCenter - column.clientHeight / 2;
  const maxScroll = Math.max(0, column.scrollHeight - column.clientHeight);
  const clampedTop = Math.max(0, Math.min(targetTop, maxScroll));
  if (Math.abs(column.scrollTop - clampedTop) < 0.5) return;
  column.scrollTo({ top: clampedTop });
}

function getWheelNearestIndex(column: HTMLDivElement | null, totalOptions: number) {
  if (!column || totalOptions <= 0) return null;
  const metrics = getWheelMetrics(column);
  if (!metrics) return null;
  const { optionHeight, optionOffset } = metrics;
  if (!optionHeight) return null;
  const viewCenter = column.scrollTop + column.clientHeight / 2;
  const relative = (viewCenter - optionOffset - optionHeight / 2) / optionHeight;
  const rawIndex = Math.round(relative);
  return Math.min(totalOptions - 1, Math.max(0, rawIndex));
}

function scheduleWheelSnap(
  columnRef: React.RefObject<HTMLDivElement>,
  snapRef: React.MutableRefObject<number | null>,
  targetIndex: number,
) {
  if (snapRef.current != null) {
    window.clearTimeout(snapRef.current);
    snapRef.current = null;
  }
  snapRef.current = window.setTimeout(() => {
    snapRef.current = null;
    scrollWheelColumnToIndex(columnRef.current, targetIndex);
  }, 120);
}

function nudgeHorizontalScroller(scroller: HTMLDivElement | null) {
  if (!scroller) return;
  const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (maxScroll < 1) return;
  const start = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
  const bump = start < maxScroll ? start + 1 : start - 1;
  if (Math.abs(bump - start) < 0.5) return;
  scroller.scrollLeft = bump;
  scroller.scrollLeft = start;
}

function isoFromDateTime(dateStr: string, timeStr?: string, timeZone?: string): string {
  const safeZone = normalizeTimeZone(timeZone);
  if (dateStr) {
    if (safeZone && ISO_DATE_PATTERN.test(dateStr)) {
      const timeValue = timeStr || "00:00";
      const zoned = zonedTimeToUtc(dateStr, timeValue, safeZone);
      if (zoned && !Number.isNaN(zoned.getTime())) return zoned.toISOString();
    }
    if (timeStr) {
      const withTime = new Date(`${dateStr}T${timeStr}`);
      if (!Number.isNaN(withTime.getTime())) return withTime.toISOString();
    }
    const midnight = new Date(`${dateStr}T00:00`);
    if (!Number.isNaN(midnight.getTime())) return midnight.toISOString();
  }
  const parsed = new Date(dateStr);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

function monthKeyFromYearMonth(year: number, monthIndex: number): string {
  const mm = String(monthIndex + 1).padStart(2, "0");
  return `${year}-${mm}`;
}

function daysInCalendarMonth(year: number, monthIndex: number): number {
  const value = new Date(year, monthIndex + 1, 0).getDate();
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function nthWeekdayOfMonthDateKey(
  year: number,
  monthIndex: number,
  weekday: Weekday,
  occurrence: number,
): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(occurrence)) return null;
  if (occurrence < 1) return null;
  const firstOfMonth = new Date(Date.UTC(year, monthIndex, 1));
  if (Number.isNaN(firstOfMonth.getTime())) return null;
  const firstWeekday = firstOfMonth.getUTCDay() as Weekday;
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (occurrence - 1) * 7;
  const maxDay = daysInCalendarMonth(year, monthIndex);
  if (day < 1 || day > maxDay) return null;
  return formatDateKeyFromParts(year, monthIndex + 1, day);
}

function lastWeekdayOfMonthDateKey(year: number, monthIndex: number, weekday: Weekday): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) return null;
  const maxDay = daysInCalendarMonth(year, monthIndex);
  const lastOfMonth = new Date(Date.UTC(year, monthIndex, maxDay));
  if (Number.isNaN(lastOfMonth.getTime())) return null;
  const lastWeekday = lastOfMonth.getUTCDay() as Weekday;
  const offset = (lastWeekday - weekday + 7) % 7;
  const day = maxDay - offset;
  if (day < 1 || day > maxDay) return null;
  return formatDateKeyFromParts(year, monthIndex + 1, day);
}

function observedUsHolidayDateKey(dateKey: string): string | null {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  if (Number.isNaN(date.getTime())) return null;
  const weekday = date.getUTCDay() as Weekday;
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  else if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  else return null;
  return date.toISOString().slice(0, 10);
}

function easterDateKey(year: number): string | null {
  if (!Number.isFinite(year)) return null;
  const y = Math.trunc(year);
  if (y < 1583) return null;
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return formatDateKeyFromParts(y, month, day);
}

type UsHolidayDefinition = {
  id: string;
  title: string;
  dateForYear: (year: number) => string | null;
  includeObserved?: boolean;
  summary?: string;
};

function buildUsHolidayCalendarEvents(startYear: number, endYear: number): CalendarEvent[] {
  const fromYear = Math.min(startYear, endYear);
  const toYear = Math.max(startYear, endYear);
  const definitions: UsHolidayDefinition[] = [
    {
      id: "new-years-day",
      title: "New Year's Day",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 1, 1),
    },
    {
      id: "mlk-day",
      title: "Martin Luther King Jr. Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 0, 1, 3),
    },
    {
      id: "presidents-day",
      title: "Presidents Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 1, 1, 3),
    },
    {
      id: "valentines-day",
      title: "Valentine's Day",
      dateForYear: (year) => formatDateKeyFromParts(year, 2, 14),
      summary: "US holiday",
    },
    {
      id: "easter",
      title: "Easter",
      dateForYear: (year) => easterDateKey(year),
      summary: "US holiday",
    },
    {
      id: "memorial-day",
      title: "Memorial Day",
      dateForYear: (year) => lastWeekdayOfMonthDateKey(year, 4, 1),
    },
    {
      id: "juneteenth",
      title: "Juneteenth",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 6, 19),
    },
    {
      id: "independence-day",
      title: "Independence Day",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 7, 4),
    },
    {
      id: "labor-day",
      title: "Labor Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 8, 1, 1),
    },
    {
      id: "columbus-day",
      title: "Columbus Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 9, 1, 2),
    },
    {
      id: "veterans-day",
      title: "Veterans Day",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 11, 11),
    },
    {
      id: "thanksgiving-day",
      title: "Thanksgiving Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 10, 4, 4),
    },
    {
      id: "christmas-eve",
      title: "Christmas Eve",
      dateForYear: (year) => formatDateKeyFromParts(year, 12, 24),
      summary: "US holiday",
    },
    {
      id: "christmas-day",
      title: "Christmas Day",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 12, 25),
    },
  ];

  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  const addEvent = (id: string, title: string, dateKey: string, summary: string) => {
    if (!ISO_DATE_PATTERN.test(dateKey)) return;
    const dedupeKey = `${id}|${dateKey}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    events.push({
      id,
      kind: "date",
      boardId: SPECIAL_CALENDAR_US_HOLIDAYS_ID,
      title,
      summary,
      startDate: dateKey,
      readOnly: true,
    });
  };

  for (let year = fromYear; year <= toYear; year += 1) {
    definitions.forEach((definition) => {
      const dateKey = definition.dateForYear(year);
      if (!dateKey) return;
      addEvent(
        `us-holiday:${definition.id}:${year}`,
        definition.title,
        dateKey,
        definition.summary ?? "US federal holiday",
      );

      if (!definition.includeObserved) return;
      const observedDateKey = observedUsHolidayDateKey(dateKey);
      if (!observedDateKey) return;
      addEvent(
        `us-holiday:${definition.id}:${year}:observed`,
        `${definition.title} (Observed)`,
        observedDateKey,
        `${definition.summary ?? "US federal holiday"} (observed date)`,
      );
    });

    const dstStart = nthWeekdayOfMonthDateKey(year, 2, 0, 2);
    if (dstStart) {
      addEvent(
        `us-holiday:dst-start:${year}`,
        "Daylight Saving Time Begins",
        dstStart,
        "Clocks move forward one hour in most US time zones",
      );
    }

    const dstEnd = nthWeekdayOfMonthDateKey(year, 10, 0, 1);
    if (dstEnd) {
      addEvent(
        `us-holiday:dst-end:${year}`,
        "Daylight Saving Time Ends",
        dstEnd,
        "Clocks move back one hour in most US time zones",
      );
    }
  }

  events.sort((a, b) => {
    if (a.kind !== "date" || b.kind !== "date") return a.id.localeCompare(b.id);
    const dateDiff = a.startDate.localeCompare(b.startDate);
    if (dateDiff !== 0) return dateDiff;
    const titleDiff = a.title.localeCompare(b.title);
    if (titleDiff !== 0) return titleDiff;
    return a.id.localeCompare(b.id);
  });

  return events;
}

function isUsHolidayCalendarEvent(event: CalendarEvent): boolean {
  return event.boardId === SPECIAL_CALENDAR_US_HOLIDAYS_ID;
}

function hashStringToUint32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    if (j === i) continue;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function fastingReminderDueTimesForMonth(
  year: number,
  monthIndex: number,
  options: { mode: FastingRemindersMode; weekday: Weekday; perMonth: number; seed: string },
): number[] {
  const totalDays = daysInCalendarMonth(year, monthIndex);
  const perMonth = Number.isFinite(options.perMonth) ? Math.max(1, Math.round(options.perMonth)) : 1;
  if (options.mode === "weekday") {
    const out: number[] = [];
    for (let day = 1; day <= totalDays; day++) {
      const date = new Date(year, monthIndex, day);
      if ((date.getDay() as Weekday) !== options.weekday) continue;
      const midnight = startOfDay(date);
      if (!Number.isNaN(midnight.getTime())) out.push(midnight.getTime());
    }
    return out.slice(0, perMonth);
  }

  const candidates = Array.from({ length: totalDays }, (_, i) => i + 1);
  const rng = mulberry32(hashStringToUint32(`${options.seed}|${monthKeyFromYearMonth(year, monthIndex)}`));
  shuffleInPlace(candidates, rng);
  return candidates
    .slice(0, Math.min(perMonth, totalDays))
    .sort((a, b) => a - b)
    .map((day) => startOfDay(new Date(year, monthIndex, day)).getTime())
    .filter((time) => Number.isFinite(time) && !Number.isNaN(time));
}

function formatTimeLabel(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const safeZone = normalizeTimeZone(timeZone);
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(safeZone ? { timeZone: safeZone } : {}),
  });
}

type TimeZoneOption = {
  id: string;
  label: string;
  city: string;
  region: string;
  shortNames: string[];
  longNames: string[];
  offsetMinutes: number;
  offsetLabel: string;
  search: string;
};

const FALLBACK_TIME_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

let cachedTimeZoneOptions: TimeZoneOption[] | null = null;
let cachedTimeZoneOptionMap: Map<string, TimeZoneOption> | null = null;

function getSupportedTimeZones(): string[] {
  try {
    const supported = typeof (Intl as any).supportedValuesOf === "function"
      ? (Intl as any).supportedValuesOf("timeZone")
      : null;
    if (Array.isArray(supported) && supported.length > 0) {
      return supported.includes("UTC") ? supported : ["UTC", ...supported];
    }
  } catch {}
  return FALLBACK_TIME_ZONES;
}

function extractTimeZoneName(timeZone: string, date: Date, style: "short" | "long"): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: style });
    const part = formatter.formatToParts(date).find((entry) => entry.type === "timeZoneName");
    return part?.value?.trim() || "";
  } catch {
    return "";
  }
}

function getTimeZoneLabelParts(timeZone: string): { label: string; city: string; region: string } {
  const parts = timeZone.split("/");
  const rawCity = parts[parts.length - 1] || timeZone;
  const city = rawCity.replace(/_/g, " ");
  const region = parts.slice(0, -1).join("/").replace(/_/g, " ");
  return { label: city || timeZone, city, region };
}

function buildTimeZoneOption(timeZone: string, referenceDates: Date[]): TimeZoneOption | null {
  const normalized = normalizeTimeZone(timeZone) ?? (timeZone === "UTC" ? "UTC" : null);
  if (!normalized) return null;
  const { label, city, region } = getTimeZoneLabelParts(normalized);
  const shortNames = new Set<string>();
  const longNames = new Set<string>();
  referenceDates.forEach((date) => {
    const shortName = extractTimeZoneName(normalized, date, "short");
    const longName = extractTimeZoneName(normalized, date, "long");
    if (shortName) shortNames.add(shortName);
    if (longName) longNames.add(longName);
  });
  const offsetMinutes = Math.round(getTimeZoneOffset(new Date(), normalized) / 60000);
  const offsetLabel = formatOffsetLabel(offsetMinutes);
  const offsetAlias = offsetLabel.replace("UTC", "GMT");
  const search = [
    normalized,
    label,
    city,
    region,
    ...shortNames,
    ...longNames,
    offsetLabel,
    offsetAlias,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return {
    id: normalized,
    label,
    city,
    region,
    shortNames: Array.from(shortNames),
    longNames: Array.from(longNames),
    offsetMinutes,
    offsetLabel,
    search,
  };
}

function getTimeZoneOptions(): { options: TimeZoneOption[]; map: Map<string, TimeZoneOption> } {
  if (cachedTimeZoneOptions && cachedTimeZoneOptionMap) {
    return { options: cachedTimeZoneOptions, map: cachedTimeZoneOptionMap };
  }
  const now = new Date();
  const year = now.getUTCFullYear();
  const referenceDates = [
    now,
    new Date(Date.UTC(year, 0, 1, 12, 0, 0)),
    new Date(Date.UTC(year, 6, 1, 12, 0, 0)),
  ];
  const options: TimeZoneOption[] = [];
  const map = new Map<string, TimeZoneOption>();
  const seen = new Set<string>();
  for (const zone of getSupportedTimeZones()) {
    if (!zone || seen.has(zone)) continue;
    seen.add(zone);
    const option = buildTimeZoneOption(zone, referenceDates);
    if (!option) continue;
    options.push(option);
    map.set(option.id, option);
  }
  options.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.label.localeCompare(b.label);
  });
  cachedTimeZoneOptions = options;
  cachedTimeZoneOptionMap = map;
  return { options, map };
}

function formatTimeZoneDisplay(timeZone: string, optionMap: Map<string, TimeZoneOption>): string {
  const option = optionMap.get(timeZone);
  if (!option) return timeZone;
  const short = option.shortNames.find((name) => !!name) || "";
  if (short && short !== option.label) return `${option.label} (${short})`;
  return option.label;
}

function scoreTimeZoneOption(option: TimeZoneOption, query: string): number {
  const normalized = query.toLowerCase();
  const isAbbrev = /^[a-z]{2,6}$/.test(normalized);
  const id = option.id.toLowerCase();
  const label = option.label.toLowerCase();
  const city = option.city.toLowerCase();
  const region = option.region.toLowerCase();
  const shortNames = option.shortNames.map((name) => name.toLowerCase());
  const longNames = option.longNames.map((name) => name.toLowerCase());

  if (
    id === normalized ||
    label === normalized ||
    city === normalized ||
    region === normalized ||
    shortNames.includes(normalized) ||
    longNames.includes(normalized)
  ) {
    return 0;
  }

  if (isAbbrev && shortNames.some((name) => name.startsWith(normalized))) return 1;

  if (
    id.startsWith(normalized) ||
    label.startsWith(normalized) ||
    city.startsWith(normalized) ||
    region.startsWith(normalized) ||
    shortNames.some((name) => name.startsWith(normalized)) ||
    longNames.some((name) => name.startsWith(normalized))
  ) {
    return 2;
  }

  return 3;
}

function parseTimePickerValue(value?: string | null, fallback = "09:00") {
  const source = typeof value === "string" && value.includes(":") ? value : fallback;
  const [hourRaw, minuteRaw] = (source || "09:00").split(":");
  const hour24 = Number.parseInt(hourRaw ?? "0", 10);
  const minute = Number.parseInt(minuteRaw ?? "0", 10);
  const safeHour24 = Number.isFinite(hour24) ? Math.min(23, Math.max(0, hour24)) : 9;
  const safeMinute = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  const meridiem: Meridiem = safeHour24 >= 12 ? "PM" : "AM";
  const hour12 = safeHour24 % 12 === 0 ? 12 : safeHour24 % 12;
  return {
    hour: hour12,
    minute: safeMinute,
    meridiem,
  };
}

function useCalendarPicker(baseDate?: string) {
  const [calendarAnchor, setCalendarAnchor] = useState(() => calendarAnchorFrom(baseDate));
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [monthPickerMonth, setMonthPickerMonth] = useState(calendarAnchor.getMonth());
  const [monthPickerYear, setMonthPickerYear] = useState(() => calendarAnchor.getFullYear());
  const monthPickerMonthColumnRef = useRef<HTMLDivElement | null>(null);
  const monthPickerYearColumnRef = useRef<HTMLDivElement | null>(null);
  const monthPickerMonthScrollFrame = useRef<number | null>(null);
  const monthPickerYearScrollFrame = useRef<number | null>(null);
  const monthPickerMonthSnapTimeout = useRef<number | null>(null);
  const monthPickerYearSnapTimeout = useRef<number | null>(null);
  const monthPickerMonthValueRef = useRef(monthPickerMonth);
  const monthPickerYearValueRef = useRef(monthPickerYear);

  const monthPickerYears = useMemo(() => {
    const anchorYear = calendarAnchor.getFullYear();
    const start = anchorYear - MONTH_PICKER_YEAR_WINDOW;
    const end = anchorYear + MONTH_PICKER_YEAR_WINDOW;
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }, [calendarAnchor]);

  const calendarMonthLabel = useMemo(
    () => calendarAnchor.toLocaleDateString([], { month: "long", year: "numeric" }),
    [calendarAnchor],
  );

  const calendarCells = useMemo(() => {
    const year = calendarAnchor.getFullYear();
    const month = calendarAnchor.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((firstWeekday + totalDays) / 7) * 7;
    const cells: (number | null)[] = [];
    for (let i = 0; i < totalCells; i += 1) {
      const day = i - firstWeekday + 1;
      cells.push(day > 0 && day <= totalDays ? day : null);
    }
    return { cells, year, month };
  }, [calendarAnchor]);

  const todayDate = useMemo(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), today.getDate());
  }, []);

  useEffect(() => {
    setCalendarAnchor(calendarAnchorFrom(baseDate));
  }, [baseDate]);

  useEffect(() => {
    setMonthPickerMonth(calendarAnchor.getMonth());
    setMonthPickerYear(calendarAnchor.getFullYear());
  }, [calendarAnchor]);

  useEffect(() => {
    monthPickerMonthValueRef.current = monthPickerMonth;
  }, [monthPickerMonth]);

  useEffect(() => {
    monthPickerYearValueRef.current = monthPickerYear;
  }, [monthPickerYear]);

  useEffect(() => {
    if (!showMonthPicker) return;
    scrollWheelColumnToIndex(monthPickerMonthColumnRef.current, monthPickerMonth);
    const yearIndex = monthPickerYears.indexOf(monthPickerYear);
    if (yearIndex >= 0) {
      scrollWheelColumnToIndex(monthPickerYearColumnRef.current, yearIndex);
    }
  }, [monthPickerMonth, monthPickerYear, monthPickerYears, showMonthPicker]);

  const moveCalendarMonth = useCallback((delta: number) => {
    setCalendarAnchor((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  }, []);

  const applyMonthPickerSelection = useCallback(() => {
    const safeYear = Number.isFinite(monthPickerYear) ? monthPickerYear : calendarAnchor.getFullYear();
    const safeMonth = Math.min(11, Math.max(0, monthPickerMonth));
    setCalendarAnchor(new Date(safeYear, safeMonth, 1));
    setShowMonthPicker(false);
  }, [calendarAnchor, monthPickerMonth, monthPickerYear]);

  const handleMonthLabelClick = useCallback(() => {
    if (!showMonthPicker) {
      setMonthPickerMonth(calendarAnchor.getMonth());
      setMonthPickerYear(calendarAnchor.getFullYear());
      setShowMonthPicker(true);
    } else {
      applyMonthPickerSelection();
    }
  }, [applyMonthPickerSelection, calendarAnchor, showMonthPicker]);

  const handleMonthPickerMonthScroll = useCallback(() => {
    const column = monthPickerMonthColumnRef.current;
    if (!column) return;
    if (monthPickerMonthScrollFrame.current != null) {
      cancelAnimationFrame(monthPickerMonthScrollFrame.current);
    }
    monthPickerMonthScrollFrame.current = requestAnimationFrame(() => {
      const clampedIndex = getWheelNearestIndex(column, MONTH_NAMES.length);
      if (clampedIndex == null) return;
      if (monthPickerMonthValueRef.current !== clampedIndex) {
        setMonthPickerMonth(clampedIndex);
      }
      scheduleWheelSnap(monthPickerMonthColumnRef, monthPickerMonthSnapTimeout, clampedIndex);
    });
  }, []);

  const handleMonthPickerYearScroll = useCallback(() => {
    const column = monthPickerYearColumnRef.current;
    if (!column) return;
    if (monthPickerYearScrollFrame.current != null) {
      cancelAnimationFrame(monthPickerYearScrollFrame.current);
    }
    monthPickerYearScrollFrame.current = requestAnimationFrame(() => {
      const clampedIndex = getWheelNearestIndex(column, monthPickerYears.length);
      if (clampedIndex == null) return;
      const nextYear = monthPickerYears[clampedIndex];
      if (nextYear != null && monthPickerYearValueRef.current !== nextYear) {
        setMonthPickerYear(nextYear);
      }
      if (nextYear != null) {
        scheduleWheelSnap(monthPickerYearColumnRef, monthPickerYearSnapTimeout, clampedIndex);
      }
    });
  }, [monthPickerYears]);

  return {
    calendarAnchor,
    calendarMonthLabel,
    calendarCells,
    todayDate,
    showMonthPicker,
    moveCalendarMonth,
    handleMonthLabelClick,
    monthPickerYears,
    monthPickerMonth,
    monthPickerYear,
    monthPickerMonthColumnRef,
    monthPickerYearColumnRef,
    handleMonthPickerMonthScroll,
    handleMonthPickerYearScroll,
  };
}

function DatePickerCalendar({
  baseDate,
  selectedDate,
  onSelectDate,
}: {
  baseDate?: string;
  selectedDate?: string;
  onSelectDate: (iso: string) => void;
}) {
  const {
    calendarMonthLabel,
    calendarCells,
    todayDate,
    showMonthPicker,
    moveCalendarMonth,
    handleMonthLabelClick,
    monthPickerYears,
    monthPickerMonth,
    monthPickerYear,
    monthPickerMonthColumnRef,
    monthPickerYearColumnRef,
    handleMonthPickerMonthScroll,
    handleMonthPickerYearScroll,
  } = useCalendarPicker(baseDate);

  const selectedDateObj = useMemo(() => {
    if (!selectedDate) return null;
    const parsed = new Date(`${selectedDate}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [selectedDate]);

  function handleSelectCalendarDay(day: number | null) {
    if (!day) return;
    const next = new Date(calendarCells.year, calendarCells.month, day);
    if (Number.isNaN(next.getTime())) return;
    onSelectDate(formatDateKeyLocal(next));
  }

  return (
    <div className="edit-calendar">
      <div className="edit-calendar__header">
        <button
          type="button"
          className="ghost-button button-sm pressable"
          onClick={() => moveCalendarMonth(-1)}
          aria-label="Previous month"
        >
          ‹
        </button>
        <button type="button" className="edit-calendar__month" onClick={handleMonthLabelClick}>
          {calendarMonthLabel}
        </button>
        <button
          type="button"
          className="ghost-button button-sm pressable"
          onClick={() => moveCalendarMonth(1)}
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      {showMonthPicker && (
        <div className="edit-month-picker">
          <div
            className="edit-month-picker__column"
            ref={monthPickerMonthColumnRef}
            onScroll={handleMonthPickerMonthScroll}
            role="listbox"
            aria-label="Select month"
          >
            {MONTH_NAMES.map((name, idx) => (
              <div
                key={name}
                className={`edit-month-picker__option ${monthPickerMonth === idx ? "is-active" : ""}`}
                data-picker-index={idx}
                role="option"
                aria-selected={monthPickerMonth === idx}
              >
                {name.slice(0, 3)}
              </div>
            ))}
          </div>
          <div
            className="edit-month-picker__column"
            ref={monthPickerYearColumnRef}
            onScroll={handleMonthPickerYearScroll}
            role="listbox"
            aria-label="Select year"
          >
            {monthPickerYears.map((year, idx) => (
              <div
                key={year}
                className={`edit-month-picker__option ${monthPickerYear === year ? "is-active" : ""}`}
                data-picker-index={idx}
                role="option"
                aria-selected={monthPickerYear === year}
              >
                {year}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="edit-calendar__weekdays">
        {WD_SHORT.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="edit-calendar__grid">
        {calendarCells.cells.map((cell, idx) => {
          if (!cell) {
            return <span key={`empty-${idx}`} className="edit-calendar__day edit-calendar__day--muted" />;
          }
          const isSelected =
            !!selectedDateObj &&
            selectedDateObj.getFullYear() === calendarCells.year &&
            selectedDateObj.getMonth() === calendarCells.month &&
            selectedDateObj.getDate() === cell;
          const currentViewDate = new Date(calendarCells.year, calendarCells.month, cell);
          const isToday =
            todayDate.getFullYear() === currentViewDate.getFullYear() &&
            todayDate.getMonth() === currentViewDate.getMonth() &&
            todayDate.getDate() === currentViewDate.getDate();
          const dayCls = [
            "edit-calendar__day",
            isSelected ? "edit-calendar__day--selected" : "",
            !isSelected && isToday ? "edit-calendar__day--today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={`day-${idx}-${cell}`}
              type="button"
              className={dayCls}
              onClick={() => handleSelectCalendarDay(cell)}
            >
              {cell}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatTimePickerValue(hour12: number, minute: number, meridiem: Meridiem) {
  const normalizedHour = Math.min(12, Math.max(1, hour12 || 12));
  const normalizedMinute = Math.min(59, Math.max(0, minute));
  let hour24 = normalizedHour % 12;
  if (meridiem === "PM") {
    hour24 += 12;
  } else if (normalizedHour === 12) {
    hour24 = 0;
  }
  const hh = String(hour24).padStart(2, "0");
  const mm = String(normalizedMinute).padStart(2, "0");
  return `${hh}:${mm}`;
}

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

function normalizeHiddenForRecurring(task: Task): Task {
  if (!task.hiddenUntilISO || !task.recurrence || !revealsOnDueDate(task.recurrence)) {
    return task;
  }
  const dueMidnight = startOfDay(new Date(task.dueISO));
  const hiddenMidnight = startOfDay(new Date(task.hiddenUntilISO));
  if (Number.isNaN(dueMidnight.getTime()) || Number.isNaN(hiddenMidnight.getTime())) return task;
  const today = startOfDay(new Date());
  if (dueMidnight.getTime() > today.getTime() && hiddenMidnight.getTime() < dueMidnight.getTime()) {
    return { ...task, hiddenUntilISO: dueMidnight.toISOString() };
  }
  return task;
}

function recurrenceSeriesKey(task: Task): string | null {
  if (!task.recurrence) return null;
  if (task.seriesId) return `series:${task.boardId}:${task.seriesId}`;
  const recurrence = JSON.stringify(task.recurrence);
  return `sig:${task.boardId}::${task.title}::${task.note || ""}::${recurrence}`;
}

function recurringInstanceId(seriesId: string, dueISO: string, rule?: Recurrence, timeZone?: string): string {
  const datePart = isoDatePart(dueISO, timeZone);
  const timePart =
    rule && rule.type === "every" && rule.unit === "hour"
      ? isoTimePartUtc(dueISO)
      : "";
  const suffix = timePart ? `${datePart}T${timePart}` : datePart;
  return `recurrence:${seriesId}:${suffix}`;
}

function recurringOccurrenceKey(task: Task): string | null {
  if (!task.recurrence || !isFrequentRecurrence(task.recurrence)) return null;
  const seriesKey = recurrenceSeriesKey(task);
  if (!seriesKey) return null;
  const datePart = isoDatePart(task.dueISO, task.dueTimeZone);
  return `${seriesKey}::${datePart}`;
}

function pickRecurringDuplicate(a: Task, b: Task): Task {
  const aCompleted = !!a.completed;
  const bCompleted = !!b.completed;
  if (aCompleted !== bCompleted) return aCompleted ? a : b;
  const aCompletedAt = a.completedAt ? Date.parse(a.completedAt) : 0;
  const bCompletedAt = b.completedAt ? Date.parse(b.completedAt) : 0;
  if (aCompletedAt !== bCompletedAt) return aCompletedAt >= bCompletedAt ? a : b;
  const aIsBase = !!(a.seriesId && a.id === a.seriesId);
  const bIsBase = !!(b.seriesId && b.id === b.seriesId);
  if (aIsBase !== bIsBase) return aIsBase ? a : b;
  const aOrder = typeof a.order === "number" ? a.order : Number.POSITIVE_INFINITY;
  const bOrder = typeof b.order === "number" ? b.order : Number.POSITIVE_INFINITY;
  if (aOrder !== bOrder) return aOrder < bOrder ? a : b;
  return a.id.localeCompare(b.id) <= 0 ? a : b;
}

function dedupeRecurringInstances(tasks: Task[]): Task[] {
  const out: Task[] = [];
  const indexByKey = new Map<string, number>();
  let changed = false;
  for (const task of tasks) {
    const key = recurringOccurrenceKey(task);
    if (!key) {
      out.push(task);
      continue;
    }
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, out.length);
      out.push(task);
      continue;
    }
    const existing = out[existingIndex];
    const winner = pickRecurringDuplicate(existing, task);
    if (winner !== existing) {
      out[existingIndex] = winner;
    }
    changed = true;
  }
  return changed ? out : tasks;
}

/* ================= Storage hooks ================= */
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
  const settingsFirstRun = useRef(true);
  useEffect(() => {
    if (settingsFirstRun.current) { settingsFirstRun.current = false; return; }
    kvStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }, [settings]);
  return [settings, setSettings] as const;
}

function pickStartupBoard(boards: Board[], overrides?: Partial<Record<Weekday, string>>): string {
  const visible = boards.filter(b => !b.archived && !b.hidden);
  const today = (new Date().getDay() as Weekday);
  const overrideId = overrides?.[today];
  if (overrideId) {
    const match = visible.find(b => b.id === overrideId) || boards.find(b => !b.archived && b.id === overrideId);
    if (match) return match.id;
  }
  if (visible.length) return visible[0].id;
  const firstUnarchived = boards.find(b => !b.archived);
  if (firstUnarchived) return firstUnarchived.id;
  return boards[0]?.id || "";
}

function migrateBoards(stored: any): Board[] | null {
  try {
    const arr = stored as any[];
    if (!Array.isArray(arr)) return null;
    return arr.map((b) => {
      const archived =
        typeof b?.archived === "boolean"
          ? b.archived
          : typeof b?.hidden === "boolean"
            ? b.hidden
            : false;
      const hidden =
        typeof b?.hidden === "boolean" && typeof b?.archived === "boolean"
          ? b.hidden
          : false;
      const clearCompletedDisabled =
        typeof b?.clearCompletedDisabled === "boolean" ? b.clearCompletedDisabled : false;
      const indexCardEnabled =
        typeof (b as any)?.indexCardEnabled === "boolean" ? Boolean((b as any).indexCardEnabled) : false;
      const hideChildBoardNames =
        typeof (b as any)?.hideChildBoardNames === "boolean"
          ? Boolean((b as any).hideChildBoardNames)
          : false;
      if (b?.kind === "week") {
        return {
          id: b.id,
          name: b.name,
          kind: "week",
          nostr: b.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
        } as Board;
      }
      if (b?.kind === "lists" && Array.isArray(b.columns)) {
        return {
          id: b.id,
          name: b.name,
          kind: "lists",
          columns: b.columns,
          nostr: b.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          indexCardEnabled,
        } as Board;
      }
      if (b?.kind === "compound") {
        const rawChildren = Array.isArray((b as any)?.children) ? (b as any).children : [];
        const children = rawChildren
          .filter((child: unknown) => typeof child === "string" && child && child !== b.id) as string[];
        return {
          id: b.id,
          name: b.name,
          kind: "compound",
          children,
          nostr: b.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          indexCardEnabled,
          hideChildBoardNames,
        } as Board;
      }
      if (b?.kind === "bible") {
        const name = typeof b?.name === "string" && b.name.trim() ? b.name : "Bible";
        return {
          id: b.id,
          name,
          kind: "bible",
          archived,
          hidden,
          clearCompletedDisabled,
        } as Board;
      }
      if (b?.kind === "list") {
        // old single-column boards -> migrate to lists with one column
        const colId = crypto.randomUUID();
        return {
          id: b.id,
          name: b.name,
          kind: "lists",
          columns: [{ id: colId, name: "Items" }],
          nostr: b?.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          indexCardEnabled,
        } as Board;
      }
      // unknown -> keep as lists with one column
      const colId = crypto.randomUUID();
      return {
        id: b?.id || crypto.randomUUID(),
        name: b?.name || "Board",
        kind: "lists",
        columns: [{ id: colId, name: "Items" }],
        nostr: b?.nostr,
        archived,
        hidden,
        clearCompletedDisabled,
        indexCardEnabled,
      } as Board;
    });
  } catch { return null; }
}

function useBoards() {
  const [boards, setBoards] = useState<Board[]>(() => {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_BOARDS);
    if (raw) {
      const migrated = migrateBoards(JSON.parse(raw));
      if (migrated && migrated.length) return migrated;
    }
    // default: one Week board
    return [{ id: "week-default", name: "Week", kind: "week", archived: false, hidden: false, clearCompletedDisabled: false }];
  });
  const boardsFirstRun = useRef(true);
  useEffect(() => {
    if (boardsFirstRun.current) { boardsFirstRun.current = false; return; }
    idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARDS, JSON.stringify(boards));
  }, [boards]);
  return [boards, setBoards] as const;
}

function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    const loadStored = (): any[] => {
      try {
        const current = idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_TASKS);
        if (current) {
          const parsed = JSON.parse(current);
          if (Array.isArray(parsed)) return parsed;
        }
      } catch {}
      return [];
    };

    const rawTasks = loadStored();
    const orderMap = new Map<string, number>();
    const createdAtFallback = Date.now();
    const normalized = rawTasks
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object') return null;
        const fallbackBoard = typeof (entry as any).boardId === 'string' ? (entry as any).boardId : 'week-default';
        const boardId = fallbackBoard;
        const next = orderMap.get(boardId) ?? 0;
        const explicitOrder = typeof (entry as any).order === 'number' ? (entry as any).order : next;
        orderMap.set(boardId, explicitOrder + 1);
        const dueISO = typeof (entry as any).dueISO === 'string' ? (entry as any).dueISO : new Date().toISOString();
        const dueDateEnabled = typeof (entry as any).dueDateEnabled === 'boolean'
          ? (entry as any).dueDateEnabled
          : undefined;
        const dueTimeEnabled = typeof (entry as any).dueTimeEnabled === 'boolean' ? (entry as any).dueTimeEnabled : undefined;
        const dueTimeZoneRaw = typeof (entry as any).dueTimeZone === "string" ? (entry as any).dueTimeZone : undefined;
        const dueTimeZone = normalizeTimeZone(dueTimeZoneRaw) ?? undefined;
        const priority = normalizeTaskPriority((entry as any).priority);
        const createdAt = normalizeTaskCreatedAt((entry as any).createdAt) ?? (createdAtFallback + index);
        const updatedAt =
          typeof (entry as any).updatedAt === "string" && !Number.isNaN(Date.parse((entry as any).updatedAt))
            ? new Date((entry as any).updatedAt).toISOString()
            : undefined;
        const createdBy = normalizeAgentPubkey((entry as any).createdBy);
        const lastEditedBy = normalizeAgentPubkey((entry as any).lastEditedBy) ?? createdBy;
        const reminders = sanitizeReminderList((entry as any).reminders);
        const reminderTime = normalizeReminderTime((entry as any).reminderTime);
        const id = typeof (entry as any).id === 'string' ? (entry as any).id : crypto.randomUUID();
        const scriptureMemoryId = typeof (entry as any).scriptureMemoryId === 'string'
          ? (entry as any).scriptureMemoryId
          : undefined;
        const scriptureMemoryStageRaw = Number((entry as any).scriptureMemoryStage);
        const scriptureMemoryStage = Number.isFinite(scriptureMemoryStageRaw) && scriptureMemoryStageRaw >= 0
          ? Math.floor(scriptureMemoryStageRaw)
          : undefined;
        const prevReviewRaw = (entry as any).scriptureMemoryPrevReviewISO;
        const scriptureMemoryPrevReviewISO =
          typeof prevReviewRaw === 'string'
            ? prevReviewRaw
            : prevReviewRaw === null
              ? null
              : undefined;
        const scriptureMemoryScheduledAt = typeof (entry as any).scriptureMemoryScheduledAt === 'string'
          ? (entry as any).scriptureMemoryScheduledAt
          : undefined;
        const documents = normalizeDocumentList((entry as any).documents);
        const assignees = normalizeTaskAssignees((entry as any).assignees);
        const task: Task = {
          ...(entry as Task),
          id,
          boardId,
          order: explicitOrder,
          dueISO,
          priority,
          ...(createdBy ? { createdBy } : {}),
          ...(lastEditedBy ? { lastEditedBy } : {}),
          createdAt,
          ...(updatedAt ? { updatedAt } : {}),
          ...(typeof dueDateEnabled === 'boolean' ? { dueDateEnabled } : {}),
          ...(typeof dueTimeEnabled === 'boolean' ? { dueTimeEnabled } : {}),
          ...(dueTimeZone ? { dueTimeZone } : {}),
          ...(reminders !== undefined ? { reminders } : {}),
          ...(reminderTime ? { reminderTime } : {}),
          ...(scriptureMemoryId ? { scriptureMemoryId } : {}),
          ...(scriptureMemoryStage !== undefined ? { scriptureMemoryStage } : {}),
          ...(scriptureMemoryPrevReviewISO !== undefined ? { scriptureMemoryPrevReviewISO } : {}),
          ...(scriptureMemoryScheduledAt ? { scriptureMemoryScheduledAt } : {}),
          ...(assignees ? { assignees } : {}),
        } as Task;
        if (documents) {
          task.documents = documents.map(ensureDocumentPreview);
        } else if (Object.prototype.hasOwnProperty.call(entry as any, "documents")) {
          task.documents = undefined;
        }

        const rawBountyLists = (entry as any).bountyLists;
        const bountyListSet = new Set<string>();
        if (Array.isArray(rawBountyLists)) {
          const normalizedLists = rawBountyLists
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter((value): value is string => value.length > 0);
          const unique = Array.from(new Set(normalizedLists));
          if (unique.length > 0) {
            unique.forEach((value) => bountyListSet.add(value));
            // Legacy bounties list choices map to the unified pinned list.
            bountyListSet.add(PINNED_BOUNTY_LIST_KEY);
          }
        }
        if ((entry as any).column === "bounties") {
          task.column = "day";
          bountyListSet.add(PINNED_BOUNTY_LIST_KEY);
        }
        if (bountyListSet.size > 0) {
          task.bountyLists = Array.from(bountyListSet);
        }

        return normalizeTaskBounty(normalizeHiddenForRecurring(task));
      })
      .filter((t): t is Task => !!t);
    return dedupeRecurringInstances(normalized);
  });
  const tasksFirstRun = useRef(true);
  // Keep a ref so the debounce callback always serializes the latest tasks value.
  const tasksForSaveRef = useRef(tasks);
  tasksForSaveRef.current = tasks;
  const tasksSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (tasksFirstRun.current) { tasksFirstRun.current = false; return; }
    // Debounce the heavy JSON.stringify so it runs AFTER the browser has painted
    // and GC has had a chance to run. Without this, a large batch flush triggers
    // a render + JSON.stringify(1000 tasks) back-to-back, spiking memory on mobile.
    if (tasksSaveTimerRef.current) clearTimeout(tasksSaveTimerRef.current);
    tasksSaveTimerRef.current = setTimeout(() => {
      try {
        idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_TASKS, JSON.stringify(tasksForSaveRef.current));
      } catch (err) {
        console.error('Failed to save tasks', err);
      }
    }, 500);
  }, [tasks]);
  return [tasks, setTasks] as const;
}

function useCalendarEvents() {
  const [events, setEvents] = useState<CalendarEvent[]>(() => {
    const normalizeStringArray = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const out = value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean);
      return out.length ? out : undefined;
    };

    const normalizeParticipants = (value: unknown): CalendarEventParticipant[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const out: CalendarEventParticipant[] = [];
      for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const pubkey = typeof (entry as any).pubkey === "string" ? (entry as any).pubkey.trim() : "";
        if (!pubkey) continue;
        const relay = typeof (entry as any).relay === "string" ? (entry as any).relay.trim() : "";
        const role = typeof (entry as any).role === "string" ? (entry as any).role.trim() : "";
        out.push({ pubkey, relay: relay || undefined, role: role || undefined });
      }
      return out.length ? out : undefined;
    };

    const normalizeInviteTokens = (value: unknown): Record<string, string> | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const out: Record<string, string> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        out[key] = trimmed;
      }
      return Object.keys(out).length ? out : undefined;
    };

    const normalizeRsvpStatus = (value: unknown): CalendarRsvpStatus | undefined => {
      if (value === "accepted" || value === "declined" || value === "tentative") return value;
      return undefined;
    };

    const normalizeRsvpFb = (value: unknown): CalendarRsvpFb | undefined => {
      if (value === "free" || value === "busy") return value;
      return undefined;
    };

    const isDateKey = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

    const loadStored = (key: string): any[] => {
      try {
        const raw = idbKeyValue.getItem(TASKIFY_STORE_TASKS, key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const rawEvents = loadStored(LS_CALENDAR_EVENTS);
    const rawExternalEvents = loadStored(LS_EXTERNAL_CALENDAR_EVENTS);
    const orderMap = new Map<string, number>();
    const todayKey = (() => {
      const now = new Date();
      const yyyy = String(now.getFullYear()).padStart(4, "0");
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    })();

    const normalizeEntry = (
      entry: any,
      options?: { external?: boolean },
    ): CalendarEvent | null => {
      if (!entry || typeof entry !== "object") return null;

      const external = options?.external === true;
      const fallbackBoard = typeof (entry as any).boardId === "string" ? (entry as any).boardId : "week-default";
      const boardId = fallbackBoard;
      const nextOrder = orderMap.get(boardId) ?? 0;
      const explicitOrder = typeof (entry as any).order === "number" ? (entry as any).order : nextOrder;
      orderMap.set(boardId, explicitOrder + 1);

      const idRaw = typeof (entry as any).id === "string" ? (entry as any).id.trim() : "";
      const legacyId = typeof (entry as any).eventId === "string" ? (entry as any).eventId.trim() : "";
      const id = idRaw || legacyId || crypto.randomUUID();
      const title = typeof (entry as any).title === "string" ? (entry as any).title : "";
      const summary = typeof (entry as any).summary === "string" ? (entry as any).summary : undefined;
      const description = typeof (entry as any).description === "string" ? (entry as any).description : undefined;
      const documents = normalizeDocumentList((entry as any).documents);
      const image = typeof (entry as any).image === "string" ? (entry as any).image : undefined;
      const geohash = typeof (entry as any).geohash === "string" ? (entry as any).geohash : undefined;
      const columnId = typeof (entry as any).columnId === "string" ? (entry as any).columnId : undefined;
      const reminders = sanitizeReminderList((entry as any).reminders);
      const reminderTime = normalizeReminderTime((entry as any).reminderTime);
      const readOnlyRaw = typeof (entry as any).readOnly === "boolean" ? (entry as any).readOnly : undefined;
      const readOnly = external ? true : readOnlyRaw;
      const originBoardId = typeof (entry as any).originBoardId === "string" ? (entry as any).originBoardId : undefined;
      const hiddenUntilISO = normalizeIsoTimestamp((entry as any).hiddenUntilISO);

      const locations = normalizeStringArray((entry as any).locations);
      const hashtags = normalizeStringArray((entry as any).hashtags);
      const references = normalizeStringArray((entry as any).references);
      const participants = normalizeParticipants((entry as any).participants);

      const recurrence =
        (entry as any).recurrence && typeof (entry as any).recurrence === "object" && typeof (entry as any).recurrence.type === "string"
          ? ((entry as any).recurrence as Recurrence)
          : undefined;
      const seriesId = typeof (entry as any).seriesId === "string" ? (entry as any).seriesId : undefined;

      const eventKey = typeof (entry as any).eventKey === "string" ? (entry as any).eventKey.trim() : "";
      const inviteTokens = normalizeInviteTokens((entry as any).inviteTokens);
      const canonicalAddress =
        typeof (entry as any).canonicalAddress === "string" ? (entry as any).canonicalAddress.trim() : "";
      const viewAddress =
        typeof (entry as any).viewAddress === "string" ? (entry as any).viewAddress.trim() : "";
      const inviteToken = typeof (entry as any).inviteToken === "string" ? (entry as any).inviteToken.trim() : "";
      const inviteRelays = normalizeStringArray((entry as any).inviteRelays);

      const parsedCanonical = canonicalAddress ? parseCalendarAddress(canonicalAddress) : null;
      const boardPubkeyRaw = typeof (entry as any).boardPubkey === "string" ? (entry as any).boardPubkey.trim() : "";
      const boardPubkey =
        normalizeNostrPubkeyHex(boardPubkeyRaw)
        ?? normalizeNostrPubkeyHex(parsedCanonical?.pubkey || "")
        ?? undefined;

      const rsvpStatus = normalizeRsvpStatus((entry as any).rsvpStatus);
      const rsvpCreatedAtRaw = (entry as any).rsvpCreatedAt;
      const rsvpCreatedAt = typeof rsvpCreatedAtRaw === "number" && Number.isFinite(rsvpCreatedAtRaw)
        ? rsvpCreatedAtRaw
        : undefined;
      const rsvpFb = normalizeRsvpFb((entry as any).rsvpFb);
      const createdBy = normalizeAgentPubkey((entry as any).createdBy);
      const lastEditedBy = normalizeAgentPubkey((entry as any).lastEditedBy) ?? createdBy;

      if (external) {
        if (!canonicalAddress || !viewAddress || !eventKey || !boardPubkey) return null;
      }

      const base: CalendarEventBase = {
        id,
        boardId,
        ...(createdBy ? { createdBy } : {}),
        ...(lastEditedBy ? { lastEditedBy } : {}),
        columnId,
        order: explicitOrder,
        title,
        summary,
        description,
        documents: documents ? documents.map(ensureDocumentPreview) : undefined,
        image,
        locations,
        geohash,
        participants,
        hashtags,
        references,
        reminders,
        ...(reminderTime ? { reminderTime } : {}),
        recurrence,
        seriesId,
        ...(hiddenUntilISO ? { hiddenUntilISO } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...(external ? { external: true } : {}),
        ...(originBoardId ? { originBoardId } : {}),
        ...(eventKey ? { eventKey } : {}),
        ...(inviteTokens ? { inviteTokens } : {}),
        ...(canonicalAddress ? { canonicalAddress } : {}),
        ...(viewAddress ? { viewAddress } : {}),
        ...(inviteToken ? { inviteToken } : {}),
        ...(inviteRelays ? { inviteRelays } : {}),
        ...(boardPubkey ? { boardPubkey } : {}),
        ...(rsvpStatus ? { rsvpStatus } : {}),
        ...(rsvpCreatedAt ? { rsvpCreatedAt } : {}),
        ...(rsvpFb ? { rsvpFb } : {}),
      };

      const inferredKind =
        (entry as any).kind === "time" || (entry as any).kind === "date"
          ? (entry as any).kind
          : typeof (entry as any).startISO === "string"
            ? "time"
            : "date";

      if (inferredKind === "time") {
        const startISO = typeof (entry as any).startISO === "string" ? (entry as any).startISO : new Date().toISOString();
        if (Number.isNaN(Date.parse(startISO))) return null;
        const endISO = typeof (entry as any).endISO === "string" ? (entry as any).endISO : undefined;
        const normalizedEndISO = endISO && !Number.isNaN(Date.parse(endISO)) ? endISO : undefined;
        const startTzid = typeof (entry as any).startTzid === "string" ? (entry as any).startTzid : undefined;
        const endTzid = typeof (entry as any).endTzid === "string" ? (entry as any).endTzid : undefined;
        const event: TimeCalendarEvent = {
          ...base,
          kind: "time",
          startISO,
          endISO: normalizedEndISO,
          startTzid,
          endTzid,
        };
        return event;
      }

      const startDate =
        typeof (entry as any).startDate === "string" && isDateKey((entry as any).startDate)
          ? (entry as any).startDate
          : todayKey;
      const endDate =
        typeof (entry as any).endDate === "string" && isDateKey((entry as any).endDate)
          ? (entry as any).endDate
          : undefined;
      const event: DateCalendarEvent = {
        ...base,
        kind: "date",
        startDate,
        endDate,
      };
      return event;
    };

    const boardEvents: CalendarEvent[] = [];
    const migratedExternal: CalendarEvent[] = [];
    rawEvents.forEach((entry) => {
      const event = normalizeEntry(entry, { external: false });
      if (!event) return;
      const shouldMigrateExternal =
        (entry as any)?.external === true
        || (!!event.readOnly && !event.originBoardId && !!event.eventKey && !!event.viewAddress && !!event.canonicalAddress);
      if (shouldMigrateExternal) {
        const externalEvent = normalizeEntry(entry, { external: true });
        if (externalEvent) {
          migratedExternal.push(externalEvent);
          return;
        }
      }
      boardEvents.push(event);
    });

    const externalEvents: CalendarEvent[] = [];
    rawExternalEvents.forEach((entry) => {
      const event = normalizeEntry(entry, { external: true });
      if (event) externalEvents.push(event);
    });

    const mergedExternalMap = new Map<string, CalendarEvent>();
    [...migratedExternal, ...externalEvents].forEach((event) => {
      if (!event.external) return;
      const key = `${event.id}::${event.viewAddress || ""}`;
      const existing = mergedExternalMap.get(key);
      if (!existing) {
        mergedExternalMap.set(key, event);
        return;
      }
      const nextCreated = event.rsvpCreatedAt ?? 0;
      const prevCreated = existing.rsvpCreatedAt ?? 0;
      if (nextCreated >= prevCreated) {
        mergedExternalMap.set(key, event);
      }
    });

    return [...boardEvents, ...Array.from(mergedExternalMap.values())];
  });

  const eventsFirstRun = useRef(true);
  useEffect(() => {
    if (eventsFirstRun.current) { eventsFirstRun.current = false; return; }
    try {
      const boardEvents = events.filter((event) => !event.external);
      const externalEvents = events.filter((event) => event.external);
      idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_CALENDAR_EVENTS, JSON.stringify(boardEvents));
      idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_EXTERNAL_CALENDAR_EVENTS, JSON.stringify(externalEvents));
    } catch (err) {
      console.error("Failed to save calendar events", err);
    }
  }, [events]);

  return [events, setEvents] as const;
}

function useBibleTracker(): [BibleTrackerState, React.Dispatch<React.SetStateAction<BibleTrackerState>>] {
  const [state, setState] = useState<BibleTrackerState>(() => {
    try {
      const raw = kvStorage.getItem(LS_BIBLE_TRACKER);
      if (raw) {
        return sanitizeBibleTrackerState(JSON.parse(raw));
      }
    } catch {}
    return sanitizeBibleTrackerState(null);
  });
  useEffect(() => {
    try {
      kvStorage.setItem(LS_BIBLE_TRACKER, JSON.stringify(state));
    } catch {}
  }, [state]);
  return [state, setState];
}

function useScriptureMemory(): [ScriptureMemoryState, React.Dispatch<React.SetStateAction<ScriptureMemoryState>>] {
  const [state, setState] = useState<ScriptureMemoryState>(() => {
    try {
      const raw = kvStorage.getItem(LS_SCRIPTURE_MEMORY);
      if (raw) {
        return sanitizeScriptureMemoryState(JSON.parse(raw));
      }
    } catch {}
    return sanitizeScriptureMemoryState(null);
  });
  useEffect(() => {
    try {
      kvStorage.setItem(LS_SCRIPTURE_MEMORY, JSON.stringify(state));
    } catch {}
  }, [state]);
  return [state, setState];
}

/* ================= DroppableColumn ================= */
const DroppableColumn = React.memo(React.forwardRef<HTMLDivElement, {
  title: string;
  header?: React.ReactNode;
  onDropCard: (payload: { id: string; beforeId?: string }) => void;
  onDropEnd?: () => void;
  onTitleClick?: () => void;
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
        onDropCard({ id, beforeId });
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
        <div
          className={`mb-3 text-sm font-semibold tracking-wide text-secondary ${onTitleClick ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
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
      )}
      <div className={scrollable ? 'flex-1 min-h-0 overflow-y-auto pr-1' : ''}>
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
  const [workerBaseUrl, setWorkerBaseUrl] = useState<string>(FALLBACK_WORKER_BASE_URL);
  const [vapidPublicKey, setVapidPublicKey] = useState<string>(FALLBACK_VAPID_PUBLIC_KEY);
  const runtimeConfigPromiseRef = useRef<Promise<void> | null>(null);
  if (typeof window !== "undefined") {
    (window as any).__TASKIFY_WORKER_BASE_URL__ = workerBaseUrl;
  }
  useEffect(() => {
    let cancelled = false;
    if (!runtimeConfigPromiseRef.current) {
      runtimeConfigPromiseRef.current = (async () => {
        try {
          const response = await fetch("/api/config", { method: "GET" });
          if (!response.ok) return null;
          const contentType = response.headers.get("content-type") || "";

          let data: any = null;
          try {
            if (/json/i.test(contentType)) {
              data = await response.json();
            } else {
              // Some dev setups may serve plain text; attempt to parse but ignore errors.
              const text = await response.text();
              try {
                data = JSON.parse(text);
              } catch {
                return null;
              }
            }
          } catch {
            return null;
          }

          if (!data || typeof data !== "object") return null;
          return {
            workerBaseUrl:
              typeof data.workerBaseUrl === "string" && data.workerBaseUrl.trim()
                ? data.workerBaseUrl.trim().replace(/\/$/, "")
                : null,
            vapidPublicKey:
              typeof data.vapidPublicKey === "string" && data.vapidPublicKey.trim()
                ? data.vapidPublicKey.trim()
                : null,
          };
        } catch (err) {
          console.warn("Failed to load runtime config", err);
          return null;
        }
      })();
    }

    runtimeConfigPromiseRef.current
      ?.then((data) => {
        if (cancelled) return;
        if (data?.workerBaseUrl) {
          setWorkerBaseUrl(data.workerBaseUrl);
        } else if (!FALLBACK_WORKER_BASE_URL && typeof window !== "undefined") {
          setWorkerBaseUrl(window.location.origin);
        }
        if (data?.vapidPublicKey) {
          setVapidPublicKey(data.vapidPublicKey);
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (!FALLBACK_WORKER_BASE_URL && typeof window !== "undefined") {
          setWorkerBaseUrl(window.location.origin);
        }
      })
      .finally(() => {
        runtimeConfigPromiseRef.current = null;
      });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (!workerBaseUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        if (cancelled) return;
        registration.active?.postMessage({ type: "TASKIFY_CONFIG", workerBaseUrl });
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: "TASKIFY_CONFIG", workerBaseUrl });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [workerBaseUrl]);
  // Show toast on any successful clipboard write across the app
  useEffect(() => {
    const clip: any = (navigator as any).clipboard;
    if (!clip || typeof clip.writeText !== 'function') return;
    const original = clip.writeText.bind(clip);
    const patched = (text: string) => {
      try {
        const p = original(text);
        if (p && typeof p.then === 'function') {
          p.then(() => showToast()).catch(() => {});
        } else {
          showToast();
        }
        return p;
      } catch {
        // swallow, behave like original
        try { return original(text); } catch {}
      }
    };
    try { clip.writeText = patched; } catch {}
    return () => { try { clip.writeText = original; } catch {} };
  }, [showToast]);
  const [messagesBoardId] = useState<string>(() => {
    if (typeof window === "undefined") return crypto.randomUUID();
    try {
      const existing = kvStorage.getItem(LS_MESSAGES_BOARD_ID);
      if (existing && existing.trim()) return existing.trim();
    } catch {}
    const id = crypto.randomUUID();
    try {
      kvStorage.setItem(LS_MESSAGES_BOARD_ID, id);
    } catch {}
    return id;
  });
  const [boards, setBoards] = useBoards();
  const [settings, setSettings] = useSettings();

  useEffect(() => {
    try {
      kvStorage.setItem(LS_MINT_BACKUP_ENABLED, settings.walletMintBackupEnabled ? "1" : "0");
    } catch {
      // ignore persistence issues
    }
  }, [settings.walletMintBackupEnabled]);
  useEffect(() => {
    setBoards(prev => {
      const hasBible = prev.some(b => b.id === BIBLE_BOARD_ID);
      if (settings.bibleTrackerEnabled) {
        if (hasBible) {
          return prev.map(b => {
            if (b.id !== BIBLE_BOARD_ID) return b;
            return {
              id: BIBLE_BOARD_ID,
              name: "Bible",
              kind: "bible",
              archived: false,
              hidden: false,
            } as Board;
          });
        }
        const insertionIndex = prev.findIndex(b => b.archived);
        const bibleBoard: Board = {
          id: BIBLE_BOARD_ID,
          name: "Bible",
          kind: "bible",
          archived: false,
          hidden: false,
        };
        if (insertionIndex === -1) {
          return [...prev, bibleBoard];
        }
        const next = [...prev];
        next.splice(insertionIndex, 0, bibleBoard);
        return next;
      }
      if (!hasBible) return prev;
      return prev.filter(b => b.id !== BIBLE_BOARD_ID);
    });
  }, [settings.bibleTrackerEnabled, setBoards]);
  useEffect(() => {
    const detected = detectPushPlatformFromNavigator();
    if (settings.pushNotifications.platform !== detected) {
      setSettings({ pushNotifications: { ...settings.pushNotifications, platform: detected } });
    }
  }, [settings.pushNotifications, setSettings]);
  const [currentBoardId, setCurrentBoardIdState] = useState(() => pickStartupBoard(boards, settings.startBoardByDay));
  const currentBoard = boards.find(b => b.id === currentBoardId);
  const isListBoard = currentBoard?.kind === "lists";
  const visibleBoards = useMemo(() => boards.filter(b => !b.archived && !b.hidden), [boards]);
  const scriptureMemoryFrequencyOption = useMemo(
    () => SCRIPTURE_MEMORY_FREQUENCIES.find((opt) => opt.id === settings.scriptureMemoryFrequency) || SCRIPTURE_MEMORY_FREQUENCIES[0],
    [settings.scriptureMemoryFrequency]
  );
  const scriptureMemorySortLabel = useMemo(
    () => SCRIPTURE_MEMORY_SORTS.find((opt) => opt.id === settings.scriptureMemorySort)?.label || SCRIPTURE_MEMORY_SORTS[0].label,
    [settings.scriptureMemorySort]
  );
  const scriptureMemoryBoard = useMemo(
    () => (settings.scriptureMemoryBoardId ? boards.find((b) => b.id === settings.scriptureMemoryBoardId) || null : null),
    [boards, settings.scriptureMemoryBoardId]
  );
  const availableMemoryBoards = useMemo(
    () => boards.filter((b) => !b.archived && b.kind !== "bible"),
    [boards]
  );

  useEffect(() => {
    if (!settings.bibleTrackerEnabled && currentBoardId === BIBLE_BOARD_ID) {
      const fallbackBoards = boards.filter(b => b.id !== BIBLE_BOARD_ID);
      const next = pickStartupBoard(fallbackBoards, settings.startBoardByDay);
      if (next !== currentBoardId) setCurrentBoardIdState(next);
    }
  }, [settings.bibleTrackerEnabled, currentBoardId, boards, settings.startBoardByDay]);

  useEffect(() => {
    if (!settings.scriptureMemoryEnabled) return;
    if (scriptureMemoryBoard) return;
    const fallbackId = availableMemoryBoards[0]?.id;
    if (fallbackId && fallbackId !== settings.scriptureMemoryBoardId) {
      setSettings({ scriptureMemoryBoardId: fallbackId });
    }
  }, [
    settings.scriptureMemoryEnabled,
    scriptureMemoryBoard,
    availableMemoryBoards,
    setSettings,
    settings.scriptureMemoryBoardId,
  ]);



  useEffect(() => {
    const current = boards.find(b => b.id === currentBoardId);
    if (current && !current.archived && !current.hidden) return;
    const next = pickStartupBoard(boards, settings.startBoardByDay);
    if (next !== currentBoardId) setCurrentBoardIdState(next);
  }, [boards, currentBoardId, settings.startBoardByDay]);

  const [tasks, setTasks] = useTasks();
  const [calendarEvents, setCalendarEvents] = useCalendarEvents();
  const [calendarInvites, setCalendarInvites] = useState<CalendarInvite[]>(() => {
    try {
      const raw = kvStorage.getItem(LS_CALENDAR_INVITES);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const eventId = typeof (entry as any).eventId === "string" ? (entry as any).eventId.trim() : "";
          const canonical = typeof (entry as any).canonical === "string" ? (entry as any).canonical.trim() : "";
          const view = typeof (entry as any).view === "string" ? (entry as any).view.trim() : "";
          const eventKey = typeof (entry as any).eventKey === "string" ? (entry as any).eventKey.trim() : "";
          const inviteToken =
            typeof (entry as any).inviteToken === "string" ? (entry as any).inviteToken.trim() : "";
          if (!eventId || !canonical || !view || !eventKey || !inviteToken) return null;
          const canonicalParsed = parseCalendarAddress(canonical);
          const viewParsed = parseCalendarAddress(view);
          if (!canonicalParsed || !viewParsed) return null;
          if (canonicalParsed.kind !== TASKIFY_CALENDAR_EVENT_KIND || viewParsed.kind !== TASKIFY_CALENDAR_VIEW_KIND) return null;
          if (canonicalParsed.d !== eventId || viewParsed.d !== eventId) return null;
          if (canonicalParsed.pubkey !== viewParsed.pubkey) return null;
          const id = typeof (entry as any).id === "string" ? (entry as any).id.trim() : canonical;
          if (!id) return null;
          const source = (entry as any).source === "nostr" ? "nostr" : "dm";
          const statusRaw = typeof (entry as any).status === "string" ? (entry as any).status : "pending";
          const status: CalendarInviteStatus =
            statusRaw === "accepted" || statusRaw === "declined" || statusRaw === "tentative"
              ? statusRaw
              : statusRaw === "dismissed"
                ? "dismissed"
                : "pending";
          const receivedAt = typeof (entry as any).receivedAt === "string" ? (entry as any).receivedAt : "";
          const receivedISO = receivedAt.trim() ? receivedAt : new Date().toISOString();
          const senderObj = (entry as any).sender;
          const sender: InboxSender | undefined =
            senderObj && typeof senderObj === "object" && typeof senderObj.pubkey === "string" && senderObj.pubkey.trim()
              ? {
                  pubkey: senderObj.pubkey.trim(),
                  name: typeof senderObj.name === "string" && senderObj.name.trim() ? senderObj.name.trim() : undefined,
                  npub: typeof senderObj.npub === "string" && senderObj.npub.trim() ? senderObj.npub.trim() : undefined,
                }
              : undefined;
          const relays = Array.isArray((entry as any).relays)
            ? (entry as any).relays
                .map((relay: unknown) => (typeof relay === "string" ? relay.trim() : ""))
                .filter(Boolean)
            : undefined;
          return {
            id,
            source,
            eventId,
            canonical,
            view,
            eventKey,
            inviteToken,
            title:
              typeof (entry as any).title === "string" && (entry as any).title.trim()
                ? (entry as any).title.trim()
                : undefined,
            start:
              typeof (entry as any).start === "string" && (entry as any).start.trim()
                ? (entry as any).start.trim()
                : undefined,
            end:
              typeof (entry as any).end === "string" && (entry as any).end.trim()
                ? (entry as any).end.trim()
                : undefined,
            relays: relays?.length ? relays : undefined,
            sender,
            receivedAt: receivedISO,
            status,
          } satisfies CalendarInvite;
        })
        .filter((entry): entry is CalendarInvite => !!entry);
    } catch {
      return [];
    }
  });
  const calendarInvitesRef = useRef<CalendarInvite[]>(calendarInvites);
  const calendarInvitesFirstRun = useRef(true);
  useEffect(() => {
    calendarInvitesRef.current = calendarInvites;
    if (calendarInvitesFirstRun.current) { calendarInvitesFirstRun.current = false; return; }
    try {
      kvStorage.setItem(LS_CALENDAR_INVITES, JSON.stringify(calendarInvites));
    } catch {}
  }, [calendarInvites]);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [activeEventRsvpCoord, setActiveEventRsvpCoord] = useState<string | null>(null);
  const [activeEventRsvpRelays, setActiveEventRsvpRelays] = useState<string[]>([]);
  const [activeEventRsvps, setActiveEventRsvps] = useState<CalendarRsvpEnvelope[]>([]);
  const activeEventRsvpMapRef = useRef<Map<string, CalendarRsvpEnvelope>>(new Map());
  const activeEventInviteTokensRef = useRef<Record<string, string> | null>(null);
  const activeEventInviteTokensVersionRef = useRef<string>("");
  const activeEventRsvpContextRef = useRef<{ eventId: string; boardNostrId: string; boardSkHex: string } | null>(null);
  const activeEventRsvpSubCloserRef = useRef<null | (() => void)>(null);
  const externalEventRsvpSubCloserRef = useRef<null | (() => void)>(null);
  const calendarViewSubCloserRef = useRef<null | (() => void)>(null);
  const calendarViewClockRef = useRef<Map<string, number>>(new Map());
  const [shareBoardModalOpen, setShareBoardModalOpen] = useState(false);
  const [shareBoardTargetId, setShareBoardTargetId] = useState<string | null>(null);
  const shareBoardTarget = useMemo(
    () => (shareBoardTargetId ? boards.find((board) => board.id === shareBoardTargetId) || null : null),
    [boards, shareBoardTargetId],
  );
  const [shareBoardMode, setShareBoardMode] = useState<"board" | "template">("board");
  const [shareModeInfoOpen, setShareModeInfoOpen] = useState(false);
  const shareModeInfoRef = useRef<HTMLDivElement | null>(null);
  const shareModeInfoButtonRef = useRef<HTMLButtonElement | null>(null);
  const [shareTemplateShare, setShareTemplateShare] = useState<{
    id: string;
    relays: string[];
    boardId: string;
  } | null>(null);
  const [shareTemplateStatus, setShareTemplateStatus] = useState<string | null>(null);
  const [shareTemplateBusy, setShareTemplateBusy] = useState(false);
  const [shareContactPickerOpen, setShareContactPickerOpen] = useState(false);
  const [shareContactStatus, setShareContactStatus] = useState<string | null>(null);
  const [shareContactBusy, setShareContactBusy] = useState(false);
  const [shareContacts, setShareContacts] = useState<Contact[]>(() => loadContactsFromStorage());
  const shareableContacts = useMemo(
    () => shareContacts.filter((contact) => contactHasNpub(contact)),
    [shareContacts],
  );
  const shareBoardTargetIdRef = useRef<string | null>(null);
  const shareBoardModalOpenRef = useRef(false);
  useEffect(() => {
    shareBoardTargetIdRef.current = shareBoardTargetId;
  }, [shareBoardTargetId]);
  useEffect(() => {
    shareBoardModalOpenRef.current = shareBoardModalOpen;
  }, [shareBoardModalOpen]);
  useEffect(() => {
    if (!shareModeInfoOpen || typeof document === "undefined") return;
    const handlePointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (shareModeInfoRef.current?.contains(target)) return;
      if (shareModeInfoButtonRef.current?.contains(target)) return;
      setShareModeInfoOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShareModeInfoOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [shareModeInfoOpen]);
  useEffect(() => {
    const refreshContacts = () => setShareContacts(loadContactsFromStorage());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LS_LIGHTNING_CONTACTS) {
        refreshContacts();
      }
    };
    window.addEventListener("taskify:contacts-updated", refreshContacts);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("taskify:contacts-updated", refreshContacts);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);
  const boardMap = useMemo(() => {
    const map = new Map<string, Board>();
    boards.forEach((board) => map.set(board.id, board));
    return map;
  }, [boards]);
  const messagesUnreadCount = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.boardId === messagesBoardId &&
          !t.completed &&
          t.inboxItem &&
          t.inboxItem.status !== "accepted" &&
          t.inboxItem.status !== "declined" &&
          t.inboxItem.status !== "tentative" &&
          t.inboxItem.status !== "deleted" &&
          t.inboxItem.status !== "read",
      ).length,
    [messagesBoardId, tasks],
  );
  const walletMessageItems = useMemo<WalletMessageItem[]>(
    () =>
      tasks
        .filter((t) => t.boardId === messagesBoardId)
        .map((t) => ({
          id: t.id,
          title: t.title,
          note: t.note,
          completed: !!t.completed,
          type: t.inboxItem?.type,
          status: t.inboxItem?.status,
          dmEventId: t.inboxItem?.dmEventId,
          boardId: t.inboxItem?.type === "board" ? t.inboxItem.boardId : undefined,
          boardName: t.inboxItem?.type === "board" ? t.inboxItem.boardName : undefined,
          contact: t.inboxItem?.type === "contact" ? t.inboxItem.contact : undefined,
          task: t.inboxItem?.type === "task" ? t.inboxItem.task : undefined,
          sender: t.inboxItem?.sender,
          receivedAt: t.inboxItem?.receivedAt ?? t.dueISO,
        })),
    [messagesBoardId, tasks],
  );
  const inboxPendingItems = useMemo(
    () =>
      walletMessageItems.filter(
        (item) =>
          !item.completed &&
          item.status !== "accepted" &&
          item.status !== "declined" &&
          item.status !== "tentative" &&
          item.status !== "deleted",
      ),
    [walletMessageItems],
  );
  const pendingCalendarInvites = useMemo(
    () => calendarInvites.filter((invite) => invite.status === "pending"),
    [calendarInvites],
  );
  const formatCalendarInviteWhen = useCallback((invite: CalendarInvite): string => {
    const startRaw = invite.start?.trim() || "";
    const endRaw = invite.end?.trim() || "";
    if (!startRaw) return "";

    const formatDateLabel = (dateKey: string): string => {
      const parsed = new Date(`${dateKey}T00:00:00`);
      if (Number.isNaN(parsed.getTime())) return dateKey;
      return parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    };

    const formatTimeLabel = (date: Date): string => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    if (ISO_DATE_PATTERN.test(startRaw)) {
      const startLabel = formatDateLabel(startRaw);
      if (!endRaw || !ISO_DATE_PATTERN.test(endRaw)) return startLabel;
      const endLabel = formatDateLabel(endRaw);
      return `${startLabel} – ${endLabel}`;
    }

    const startDate = new Date(startRaw);
    if (Number.isNaN(startDate.getTime())) return startRaw;
    const dateLabel = startDate.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const startTimeLabel = formatTimeLabel(startDate);

    if (!endRaw) return `${dateLabel} • ${startTimeLabel}`;
    const endDate = new Date(endRaw);
    if (Number.isNaN(endDate.getTime())) return `${dateLabel} • ${startTimeLabel}`;

    const endDateLabel = endDate.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const endTimeLabel = formatTimeLabel(endDate);
    if (endDateLabel === dateLabel) return `${dateLabel} • ${startTimeLabel} – ${endTimeLabel}`;
    return `${dateLabel} • ${startTimeLabel} – ${endDateLabel} ${endTimeLabel}`;
  }, []);
  const inboxPendingCount = inboxPendingItems.length + pendingCalendarInvites.length;
  const activeBountyListKey = PINNED_BOUNTY_LIST_KEY;
  const bountyListEnabled = true;
  const [bibleTracker, setBibleTracker] = useBibleTracker();
  const bibleTrackerRef = useRef<BibleTrackerState>(bibleTracker);
  useEffect(() => { bibleTrackerRef.current = bibleTracker; }, [bibleTracker]);
  const [biblePrintPaperSize, setBiblePrintPaperSize] = useState<PrintPaperSize>(() => loadBiblePrintPaperSize());
  const [biblePrintOpen, setBiblePrintOpen] = useState(false);
  const [biblePrintMeta, setBiblePrintMeta] = useState<BiblePrintMeta | null>(null);
  const [biblePrintPdfBusy, setBiblePrintPdfBusy] = useState(false);
  const [bibleScanOpen, setBibleScanOpen] = useState(false);
  const [biblePrintPortal, setBiblePrintPortal] = useState<HTMLDivElement | null>(null);
  const [boardPrintOpen, setBoardPrintOpen] = useState(false);
  const [boardScanOpen, setBoardScanOpen] = useState(false);
  const [boardPrintJob, setBoardPrintJob] = useState<BoardPrintJob | null>(null);
  const [boardPrintPdfBusy, setBoardPrintPdfBusy] = useState(false);
  const [boardPrintPortal, setBoardPrintPortal] = useState<HTMLDivElement | null>(null);
  const [scriptureMemory, setScriptureMemory] = useScriptureMemory();
  const [defaultRelays, setDefaultRelays] = useState<string[]>(() => loadDefaultRelays());
  useEffect(() => { saveDefaultRelays(defaultRelays); }, [defaultRelays]);
  useEffect(() => {
    persistBiblePrintPaperSize(biblePrintPaperSize);
  }, [biblePrintPaperSize]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const node = document.createElement("div");
    node.className = "bible-print-portal";
    document.body.appendChild(node);
    setBiblePrintPortal(node);
    return () => {
      node.remove();
      setBiblePrintPortal(null);
    };
  }, []);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const node = document.createElement("div");
    node.className = "board-print-portal";
    document.body.appendChild(node);
    setBoardPrintPortal(node);
    return () => {
      node.remove();
      setBoardPrintPortal(null);
    };
  }, []);
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
      const candidateMidnight = startOfDay(new Date(candidate)).getTime();
      const todayMidnight = startOfDay(now).getTime();
      if (candidateMidnight > todayMidnight) hiddenUntilISO = candidate;
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
      const hasActive = nextTasks.some((task) => !task.completed && task.seriesId === SCRIPTURE_MEMORY_SERIES_ID);
      if (hasActive) {
        return changed ? nextTasks : prev;
      }
      const order = nextOrderForBoard(targetBoard.id, nextTasks, settings.newTaskPosition);
      if (targetBoard.kind === "lists" && (!targetBoard.columns || targetBoard.columns.length === 0)) {
        return changed ? nextTasks : prev;
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
        if (!firstColumn) return changed ? nextTasks : prev;
        newTask.columnId = firstColumn.id;
      }
      createdTask = newTask;
      return [...nextTasks, newTask];
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.showFullWeekRecurring, settings.weekStart]);

  useEffect(() => {
    const overrides = settings.startBoardByDay;
    if (!overrides || Object.keys(overrides).length === 0) return;
    const visibleIds = new Set(boards.filter(b => !b.archived && !b.hidden).map(b => b.id));
    let changed = false;
    const next: Partial<Record<Weekday, string>> = {};
    for (const key of Object.keys(overrides)) {
      const dayNum = Number(key);
      const boardId = overrides[key as keyof typeof overrides];
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
  }, [boards, settings.startBoardByDay, setSettings]);

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

  // Nostr pool + merge indexes
  const pool = useMemo(() => createNostrPool(), []);
  const initialStoredNostrSecretHex = useMemo(() => {
    try {
      const existing = kvStorage.getItem(LS_NOSTR_SK);
      if (existing && /^[0-9a-fA-F]{64}$/.test(existing)) {
        return existing.toLowerCase();
      }
    } catch {}
    return null;
  }, []);
  // In-app Nostr key (secp256k1/Schnorr) for signing
  const [nostrSK, setNostrSK] = useState<Uint8Array>(() => {
    if (initialStoredNostrSecretHex) {
      return hexToBytes(initialStoredNostrSecretHex);
    }
    return generateSecretKey();
  });
  const [nostrPK, setNostrPK] = useState<string>(() => {
    if (!initialStoredNostrSecretHex) return "";
    try {
      return getPublicKey(hexToBytes(initialStoredNostrSecretHex));
    } catch {
      return "";
    }
  });
  useEffect(() => { (window as any).nostrPK = nostrPK; }, [nostrPK]);
  useEffect(() => {
    const relays = defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS);
    NostrSession.init(relays).catch((err) => {
      console.warn("Failed to initialize Nostr session", err);
    });
  }, [defaultRelays]);
  const [nostrBackupState, setNostrBackupState] = useState<NostrBackupState>(() => loadNostrBackupState());
  const nostrBackupStateRef = useRef<NostrBackupState>(nostrBackupState);
  useEffect(() => { nostrBackupStateRef.current = nostrBackupState; }, [nostrBackupState]);
  useEffect(() => {
    try { kvStorage.setItem(LS_NOSTR_BACKUP_STATE, JSON.stringify(nostrBackupState)); } catch {}
  }, [nostrBackupState]);
  useEffect(() => {
    setNostrBackupState((prev) => {
      if (prev.pubkey === nostrPK) return prev;
      nostrBackupInitialPublishRef.current = false;
      nostrBackupPullFinishedRef.current = false;
      return { lastEventId: null, lastTimestamp: 0, pubkey: nostrPK || null };
    });
  }, [nostrPK]);
  const nostrBackupBaselineRef = useRef<string | null>(null);
  const nostrBackupSettingsDirtyRef = useRef(false);
  const nostrBackupPullFinishedRef = useRef(false);
  const nostrBackupInitialPublishRef = useRef(false);
  const nostrBackupPublishRef = useRef<Promise<void> | null>(null);
  const [nostrBackupHold, setNostrBackupHold] = useState(false);
  const nostrBackupHoldRef = useRef(nostrBackupHold);
  useEffect(() => { nostrBackupHoldRef.current = nostrBackupHold; }, [nostrBackupHold]);

  const [nostrBibleTrackerState, setNostrBibleTrackerState] = useState<NostrBackupState>(() =>
    loadNostrSyncState(LS_NOSTR_BIBLE_TRACKER_SYNC_STATE),
  );
  const nostrBibleTrackerStateRef = useRef<NostrBackupState>(nostrBibleTrackerState);
  useEffect(() => { nostrBibleTrackerStateRef.current = nostrBibleTrackerState; }, [nostrBibleTrackerState]);
  useEffect(() => {
    try { kvStorage.setItem(LS_NOSTR_BIBLE_TRACKER_SYNC_STATE, JSON.stringify(nostrBibleTrackerState)); } catch {}
  }, [nostrBibleTrackerState]);
  const nostrBibleTrackerPublishedSnapshotRef = useRef<string | null>(null);
  const nostrBibleTrackerPullFinishedRef = useRef(false);
  const nostrBibleTrackerInitialPublishRef = useRef(false);
  const nostrBibleTrackerPublishRef = useRef<Promise<void> | null>(null);
  const nostrBibleTrackerQueuedPublishRef = useRef(false);
  const nostrBibleTrackerDebounceTimerRef = useRef<number | null>(null);
  const nostrBibleTrackerErrorToastAtRef = useRef(0);
  useEffect(() => {
    setNostrBibleTrackerState((prev) => {
      if (prev.pubkey === nostrPK) return prev;
      nostrBibleTrackerInitialPublishRef.current = false;
      nostrBibleTrackerPullFinishedRef.current = false;
      nostrBibleTrackerPublishedSnapshotRef.current = null;
      nostrBibleTrackerQueuedPublishRef.current = false;
      return { lastEventId: null, lastTimestamp: 0, pubkey: nostrPK || null };
    });
  }, [nostrPK]);

  const [nostrScriptureMemoryState, setNostrScriptureMemoryState] = useState<NostrBackupState>(() =>
    loadNostrSyncState(LS_NOSTR_SCRIPTURE_MEMORY_SYNC_STATE),
  );
  const nostrScriptureMemoryStateRef = useRef<NostrBackupState>(nostrScriptureMemoryState);
  useEffect(() => { nostrScriptureMemoryStateRef.current = nostrScriptureMemoryState; }, [nostrScriptureMemoryState]);
  useEffect(() => {
    try { kvStorage.setItem(LS_NOSTR_SCRIPTURE_MEMORY_SYNC_STATE, JSON.stringify(nostrScriptureMemoryState)); } catch {}
  }, [nostrScriptureMemoryState]);
  const nostrScriptureMemoryPublishedSnapshotRef = useRef<string | null>(null);
  const nostrScriptureMemoryPullFinishedRef = useRef(false);
  const nostrScriptureMemoryInitialPublishRef = useRef(false);
  const nostrScriptureMemoryPublishRef = useRef<Promise<void> | null>(null);
  const nostrScriptureMemoryDebounceTimerRef = useRef<number | null>(null);
  const nostrScriptureMemoryErrorToastAtRef = useRef(0);
  useEffect(() => {
    setNostrScriptureMemoryState((prev) => {
      if (prev.pubkey === nostrPK) return prev;
      nostrScriptureMemoryInitialPublishRef.current = false;
      nostrScriptureMemoryPullFinishedRef.current = false;
      nostrScriptureMemoryPublishedSnapshotRef.current = null;
      return { lastEventId: null, lastTimestamp: 0, pubkey: nostrPK || null };
    });
  }, [nostrPK]);
  // allow manual key rotation later if needed
  const rotateNostrKey = useCallback(() => {
    const sk = generateSecretKey();
    const skHex = bytesToHex(sk);
    setNostrSK(sk);
    const pk = getPublicKey(sk);
    setNostrPK(pk);
    try { kvStorage.setItem(LS_NOSTR_SK, skHex); } catch {}
    return toNsec(skHex);
  }, []);

  const applyCustomNostrKey = useCallback((key: string, options?: { silent?: boolean }): boolean => {
    try {
      const normalized = normalizeSecretKeyInput(key);
      if (!normalized) throw new Error("invalid");
      const sk = hexToBytes(normalized);
      setNostrSK(sk);
      const pk = getPublicKey(sk);
      setNostrPK(pk);
      try { kvStorage.setItem(LS_NOSTR_SK, normalized); } catch {}
      return true;
    } catch {
      if (!options?.silent) {
        alert("Invalid private key");
      }
      return false;
    }
  }, []);

  const setCustomNostrKey = useCallback((key: string) => {
    applyCustomNostrKey(key);
  }, [applyCustomNostrKey]);

  const lastNostrCreated = useRef<Map<string, number>>(new Map());
  const nostrPublishQueue = useRef<Promise<unknown>>(Promise.resolve());
  const lastNostrSentMs = useRef(0);
  async function nostrPublish(relays: string[], template: EventTemplate, options?: { sk?: Uint8Array | string }): Promise<number>;
  async function nostrPublish(
    relays: string[],
    template: EventTemplate,
    options: { sk?: Uint8Array | string; returnEvent: true },
  ): Promise<{ createdAt: number; event: NostrEvent }>;
  async function nostrPublish(
    relays: string[],
    template: EventTemplate,
    options?: { sk?: Uint8Array | string; returnEvent?: boolean },
  ) {
    const run = async () => {
      const nowMs = Date.now();
      const elapsed = nowMs - lastNostrSentMs.current;
      if (elapsed < NOSTR_MIN_EVENT_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, NOSTR_MIN_EVENT_INTERVAL_MS - elapsed));
      }
      const now = Math.floor(Date.now() / 1000);
      let createdAt = typeof template.created_at === "number" ? template.created_at : now;
      const signer = options?.sk || nostrSK;
      const signerBytes =
        typeof signer === "string"
          ? (() => {
              const trimmed = signer.trim();
              if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
                return hexToBytes(trimmed.toLowerCase());
              }
              if (trimmed.startsWith("nsec")) {
                const decoded = nip19.decode(trimmed);
                if (decoded.type === "nsec" && decoded.data) {
                  if (typeof decoded.data === "string") return hexToBytes(decoded.data);
                  if (decoded.data instanceof Uint8Array) return decoded.data;
                  if (Array.isArray(decoded.data)) return Uint8Array.from(decoded.data as number[]);
                }
              }
              throw new Error("Invalid Nostr signer key");
            })()
          : signer;
      const signerKey = bytesToHex(signerBytes);
      const lastForSigner = lastNostrCreated.current.get(signerKey) || 0;
      if (createdAt <= lastForSigner) {
        createdAt = lastForSigner + 1;
      }
      lastNostrCreated.current.set(signerKey, createdAt);
      const ev = finalizeEvent({ ...template, created_at: createdAt }, signerBytes);
      pool.publishEvent(relays, ev as unknown as NostrEvent);
      lastNostrSentMs.current = Date.now();
      return options?.returnEvent ? { createdAt, event: ev as unknown as NostrEvent } : createdAt;
    };
    const next = nostrPublishQueue.current.catch(() => {}).then(run);
    nostrPublishQueue.current = next.then(() => {}, () => {});
    return next;
  }
  const nostrPublishRef = useRef(nostrPublish);
  nostrPublishRef.current = nostrPublish;
  type NostrIndex = {
    boardMeta: Map<string, number>; // nostrBoardId -> created_at
    taskClock: Map<string, Map<string, number>>; // nostrBoardId -> (taskId -> created_at)
    calendarClock: Map<string, Map<string, number>>; // nostrBoardId -> (calendarEventId -> created_at)
  };
  type BoardMigrationState = {
    dedicatedSeen: boolean;
    legacySeen: boolean;
    migrationAttempted: boolean;
  };
  const nostrIdxRef = useRef<NostrIndex>({ boardMeta: new Map(), taskClock: new Map(), calendarClock: new Map() });
  const boardMigrationRef = useRef<Map<string, BoardMigrationState>>(new Map());
  const pendingNostrTasksRef = useRef<Set<string>>(new Set());
  const pendingNostrCalendarRef = useRef<Set<string>>(new Set());
  // Set of bTags where all relays have fired EOSE — used to determine live vs batch mode.
  const completedNostrInitialSyncRef = useRef<Set<string>>(new Set());
  const [pendingNostrInitialSyncByBoardTag, setPendingNostrInitialSyncByBoardTag] = useState<Record<string, true>>({});
  // In-memory cursor: tracks the highest created_at seen per board tag this session.
  // Persisted to IDB after EOSE so subsequent opens only fetch new events.
  const boardSyncCursorsRef = useRef<Record<string, number>>(() => {
    try {
      const raw = idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  // Per-relay batch accumulator. Events from each relay are collected here until
  // that relay fires EOSE. On EOSE the relay's batch is clock-protected-merged into
  // the task state and IDB data is shown immediately (no blocking spinner).
  // Map<bTag, Map<relayUrl, Map<"boardId::taskId", Task | { _deleted:true; _nostrAt:number }>>>
  type RelayBatchEntry = Task | { _deleted: true; _nostrAt: number };
  const relayBatchRef = useRef<Map<string, Map<string, Map<string, RelayBatchEntry>>>>(new Map());

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

  // AES key migration: track items encrypted with the legacy key (SHA-256(boardId) == public tag).
  // When detected, we re-encrypt and re-publish with the secure labeled key.
  const aesMigrationPendingTasksRef = useRef<Set<string>>(new Set());
  const aesMigrationPendingBoardIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pendingBoardIds = aesMigrationPendingBoardIdsRef.current;
    if (pendingBoardIds.size === 0) return;
    aesMigrationPendingBoardIdsRef.current = new Set();
    for (const boardId of pendingBoardIds) {
      const board = boardsRef.current.find((b) => b.nostr?.boardId === boardId);
      if (!board) continue;
      publishBoardMetadataRef.current?.(board)?.catch(() => {});
    }
  }, [boards]);

  useEffect(() => {
    const pendingTaskIds = aesMigrationPendingTasksRef.current;
    if (pendingTaskIds.size === 0) return;
    aesMigrationPendingTasksRef.current = new Set();
    for (const taskId of pendingTaskIds) {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task) continue;
      const board = boardsRef.current.find((b) => b.id === task.boardId);
      if (!board) continue;
      maybePublishTaskRef.current?.(task, board, { skipBoardMetadata: true })?.catch(() => {});
    }
  }, [tasks]);

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
  const inboxSubCloserRef = useRef<(() => void) | null>(null);
  const nostrSkHex = useMemo(() => bytesToHex(nostrSK), [nostrSK]);

  // ── Google Calendar integration ──────────────────────────────────────────
  const {
    connectionStatus: gcalStatus,
    calendars: gcalCalendars,
    gcalEvents: gcalCalendarEvents,
    loading: gcalLoading,
    connect: gcalConnect,
    disconnect: gcalDisconnect,
    toggleCalendar: gcalToggleCalendar,
    sync: gcalSync,
  } = useGoogleCalendar(workerBaseUrl, nostrSkHex || null);

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
        const contactNpub = contactPayload?.npub;
        if (!contactNpub) return;
        lines.push(`npub: ${shortenNpub(toNpub(contactNpub))}`);
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
              ? contactPayload.name?.trim() ||
                contactPayload.displayName?.trim() ||
                shortenNpub(toNpub(contactPayload.npub)) ||
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
  useEffect(() => {
    if (!nostrPK || !nostrSkHex) return;
    if (!inboxRelays.length) return;
    const pool = ensureInboxPool();
    const since = Math.max(0, Math.floor(Date.now() / 1000) - SHARE_DM_LOOKBACK_SECONDS);
    let cancelled = false;
    const subscription = pool.subscribeMany(
      inboxRelays,
      { kinds: [4, 1059], "#p": [nostrPK], since },
      {
        onevent: (ev) => {
          if (cancelled) return;
          void handleIncomingShareEvent(ev as NostrEvent);
        },
      },
    );
    inboxSubCloserRef.current = () => {
      try {
        subscription.close("taskify-shares");
      } catch {}
    };
    (async () => {
      try {
        if (typeof (pool as any).list === "function") {
          const events = await (pool as any).list(inboxRelays, [
            { kinds: [4, 1059], "#p": [nostrPK], since },
          ]);
          if (!cancelled && Array.isArray(events)) {
            events.forEach((ev: any) => {
              void handleIncomingShareEvent(ev as NostrEvent);
            });
          }
        }
      } catch (err) {
        console.warn("Shared inbox fetch failed", err);
      }
    })();
    return () => {
      cancelled = true;
      if (inboxSubCloserRef.current) {
        try {
          inboxSubCloserRef.current();
        } catch {}
        inboxSubCloserRef.current = null;
      }
    };
  }, [ensureInboxPool, handleIncomingShareEvent, inboxRelays, nostrPK, nostrSkHex]);

  const tagValue = useCallback((ev: NostrEvent, name: string): string | undefined => {
    const t = ev.tags.find((x) => x[0] === name);
    return t ? t[1] : undefined;
  }, []);

  useEffect(() => {
    if (calendarViewSubCloserRef.current) {
      try {
        calendarViewSubCloserRef.current();
      } catch {}
      calendarViewSubCloserRef.current = null;
    }
    const targets = calendarEvents.filter(
      (event) => !!event.readOnly && !!event.viewAddress && !!event.eventKey,
    );
    if (!targets.length) return;

    const viewLookup = new Map<string, { eventId: string; eventKey: string }>();
    const authors = new Set<string>();
    const dTags = new Set<string>();
    const relaySet = new Set<string>();
    targets.forEach((event) => {
      const addr = parseCalendarAddress(event.viewAddress || "");
      if (!addr || addr.kind !== TASKIFY_CALENDAR_VIEW_KIND) return;
      const viewAddress = calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, addr.pubkey, addr.d);
      viewLookup.set(viewAddress, { eventId: event.id, eventKey: event.eventKey! });
      authors.add(addr.pubkey);
      dTags.add(addr.d);
      (event.inviteRelays ?? []).forEach((relay) => relaySet.add(relay));
    });
    if (!viewLookup.size || !authors.size || !dTags.size) return;

    const relayCandidates = [
      ...Array.from(relaySet),
      ...defaultRelays,
      ...inboxRelays,
      ...Array.from(DEFAULT_NOSTR_RELAYS),
    ];
    const relays = Array.from(new Set(relayCandidates.map((relay) => relay.trim()).filter(Boolean)));
    if (!relays.length) return;

    let cancelled = false;
    const applyViewEvent = async (ev: NostrEvent) => {
      if (cancelled || ev.kind !== TASKIFY_CALENDAR_VIEW_KIND) return;
      const dTag = tagValue(ev, "d");
      if (!dTag) return;
      const viewAddress = calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, ev.pubkey, dTag);
      const target = viewLookup.get(viewAddress);
      if (!target) return;
      const createdAt = typeof ev.created_at === "number" ? ev.created_at : 0;
      const last = calendarViewClockRef.current.get(viewAddress) || 0;
      if (createdAt < last) return;
      calendarViewClockRef.current.set(viewAddress, createdAt);
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
    };

    const subscription = pool.subscribeMany(
      relays,
      { kinds: [TASKIFY_CALENDAR_VIEW_KIND], authors: Array.from(authors), "#d": Array.from(dTags) },
      {
        onevent: (ev) => {
          if (cancelled) return;
          void applyViewEvent(ev as NostrEvent);
        },
      },
    );
    calendarViewSubCloserRef.current = () => {
      try {
        subscription.close("taskify-calendar-views");
      } catch {}
    };
    (async () => {
      try {
        if (typeof (pool as any).list === "function") {
          const events = await (pool as any).list(relays, [
            { kinds: [TASKIFY_CALENDAR_VIEW_KIND], authors: Array.from(authors), "#d": Array.from(dTags) },
          ]);
          if (!cancelled && Array.isArray(events)) {
            events.forEach((evt: any) => void applyViewEvent(evt as NostrEvent));
          }
        }
      } catch (err) {
        console.warn("Event view fetch failed", err);
      }
    })();

    return () => {
      cancelled = true;
      if (calendarViewSubCloserRef.current) {
        try {
          calendarViewSubCloserRef.current();
        } catch {}
        calendarViewSubCloserRef.current = null;
      }
    };
  }, [calendarEvents, defaultRelays, inboxRelays, pool, setCalendarEvents, tagValue]);

  const nostrApplyQueue = useRef<Promise<void>>(Promise.resolve());
  const enqueueNostrApply = useCallback((fn: () => Promise<void>) => {
    const next = nostrApplyQueue.current.catch(() => {}).then(() => fn());
    nostrApplyQueue.current = next.then(() => {}, () => {});
    return next;
  }, []);

  // Per-board event queues. Each board processes its events independently in
  // parallel with other boards but serially within the board (preserving task
  // clock ordering). A GC yield is inserted every N events so iOS can reclaim
  // memory between chunks instead of accumulating until the process is killed.
  const NOSTR_BOARD_YIELD_INTERVAL = 50;
  const boardEventQueuesRef = useRef<Map<string, { promise: Promise<void>; count: number }>>(new Map());
  const enqueueForBoard = useCallback((boardId: string, fn: () => Promise<void>): Promise<void> => {
    const entry = boardEventQueuesRef.current.get(boardId) ?? { promise: Promise.resolve(), count: 0 };
    entry.count++;
    const shouldYield = entry.count % NOSTR_BOARD_YIELD_INTERVAL === 0;
    const next = entry.promise.catch(() => {}).then(async () => {
      // Yield to the browser's task scheduler every N events so GC can run and
      // iOS memory pressure warnings are less likely to kill the process.
      if (shouldYield) await new Promise<void>(r => setTimeout(r, 0));
      return fn();
    });
    entry.promise = next.then(() => {}, () => {});
    boardEventQueuesRef.current.set(boardId, entry);
    return next;
  }, []);
  const [nostrRefresh, setNostrRefresh] = useState(0);
  const normalizeRelayList = useCallback(
    (relays: string[] | null | undefined) => normalizeRelayListSorted(relays) ?? [],
    [],
  );

  const sanitizeSettingsForBackup = useCallback(
    (raw: Settings | Record<string, unknown>): Partial<Settings> =>
      sanitizeSettingsForNostrBackup(raw, DEFAULT_PUSH_PREFERENCES),
    [],
  );

  const buildNostrBackupSnapshot = useCallback(
    (): NostrBackupSnapshot =>
      buildNostrBackupSnapshotDomain({
        boards,
        settings,
        includeMetadata: settings.nostrBackupEnabled,
        defaultRelays,
        fallbackRelays: Array.from(DEFAULT_NOSTR_RELAYS),
        normalizeRelayList,
        sanitizeSettingsForBackup,
        walletSeed: getWalletSeedBackup(),
      }),
    [boards, defaultRelays, normalizeRelayList, sanitizeSettingsForBackup, settings],
  );

  const serializeNostrBackupSnapshot = useCallback(
    () => JSON.stringify(buildNostrBackupSnapshot()),
    [buildNostrBackupSnapshot],
  );
  const serializeNostrBackupSnapshotRef = useRef(serializeNostrBackupSnapshot);
  serializeNostrBackupSnapshotRef.current = serializeNostrBackupSnapshot;

  const applyNostrBibleTrackerSyncEvent = useCallback(async (ev: NostrEvent) => {
    if (!settings.nostrBackupEnabled) return;
    if (!ev || ev.kind !== NOSTR_APP_STATE_KIND) return;
    const dTag = tagValue(ev, "d");
    if (dTag !== NOSTR_BIBLE_TRACKER_D_TAG) return;
    if (!nostrPK) return;
    const skHex = bytesToHex(nostrSK);
    let parsed: any;
    try {
      parsed = await decryptNostrSyncPayload(ev.content, skHex, nostrPK);
    } catch (error) {
      console.warn("Failed to decrypt Bible tracker sync payload", error);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.version !== 1) return;
    const payloadTs = Math.max(Number(parsed.timestamp) || 0, ev.created_at || 0);
    const lastTs = nostrBibleTrackerStateRef.current.lastTimestamp || 0;
    if (payloadTs <= lastTs) {
      if (!nostrBibleTrackerStateRef.current.lastEventId && ev.id) {
        setNostrBibleTrackerState((prev) => ({ ...prev, lastEventId: ev.id }));
      }
      return;
    }
    const incoming = sanitizeBibleTrackerState(parsed.bibleTracker);
    setBibleTracker(incoming);
    nostrBibleTrackerPublishedSnapshotRef.current = JSON.stringify(incoming);
    nostrBibleTrackerQueuedPublishRef.current = false;
    const nextState = { lastEventId: ev.id || null, lastTimestamp: payloadTs, pubkey: nostrPK || null };
    nostrBibleTrackerStateRef.current = nextState;
    setNostrBibleTrackerState(nextState);
  }, [nostrPK, nostrSK, setBibleTracker, setNostrBibleTrackerState, settings.nostrBackupEnabled, tagValue]);

  const applyNostrScriptureMemorySyncEvent = useCallback(async (ev: NostrEvent) => {
    if (!settings.nostrBackupEnabled) return;
    if (!ev || ev.kind !== NOSTR_APP_STATE_KIND) return;
    const dTag = tagValue(ev, "d");
    if (dTag !== NOSTR_SCRIPTURE_MEMORY_D_TAG) return;
    if (!nostrPK) return;
    const skHex = bytesToHex(nostrSK);
    let parsed: any;
    try {
      parsed = await decryptNostrSyncPayload(ev.content, skHex, nostrPK);
    } catch (error) {
      console.warn("Failed to decrypt scripture memory sync payload", error);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.version !== 1) return;
    const payloadTs = Math.max(Number(parsed.timestamp) || 0, ev.created_at || 0);
    const lastTs = nostrScriptureMemoryStateRef.current.lastTimestamp || 0;
    if (payloadTs <= lastTs) {
      if (!nostrScriptureMemoryStateRef.current.lastEventId && ev.id) {
        setNostrScriptureMemoryState((prev) => ({ ...prev, lastEventId: ev.id }));
      }
      return;
    }
    const incoming = sanitizeScriptureMemoryState(parsed.scriptureMemory);
    setScriptureMemory(incoming);
    nostrScriptureMemoryPublishedSnapshotRef.current = JSON.stringify(incoming);
    const nextState = { lastEventId: ev.id || null, lastTimestamp: payloadTs, pubkey: nostrPK || null };
    nostrScriptureMemoryStateRef.current = nextState;
    setNostrScriptureMemoryState(nextState);
  }, [nostrPK, nostrSK, setNostrScriptureMemoryState, setScriptureMemory, settings.nostrBackupEnabled, tagValue]);

  const nostrList = useCallback(
    async (relays: string[], filters: any[]): Promise<NostrEvent[]> => {
      const relayList = normalizeRelayList(relays);
      const session = await NostrSession.init(relayList);
      return session.fetchEvents(filters as any, relayList);
    },
    [normalizeRelayList],
  );

  const applyNostrBackupPayload = useCallback(
    async (payload: NostrAppBackupPayload, source: "remote" | "local" = "remote") => {
      if (!payload || typeof payload !== "object") return;
      const includeMetadata = settings.nostrBackupEnabled;
      const baseRelays = normalizeRelayList(
        payload.defaultRelays && payload.defaultRelays.length
          ? payload.defaultRelays
          : defaultRelays.length
            ? defaultRelays
            : Array.from(DEFAULT_NOSTR_RELAYS),
      );
      if (includeMetadata && payload.settings && typeof payload.settings === "object") {
        const incoming = sanitizeSettingsForBackup(payload.settings as Record<string, unknown>);
        setSettings(incoming);
      }
      if (includeMetadata && Array.isArray(payload.defaultRelays) && payload.defaultRelays.some((r) => typeof r === "string" && r.trim())) {
        setDefaultRelays(normalizeRelayList(payload.defaultRelays));
      }
      if (payload.walletSeed) {
        try {
          restoreWalletSeedBackup(payload.walletSeed);
        } catch (error) {
          console.warn("Failed to restore wallet seed from Nostr backup", error);
        }
      }
      if (includeMetadata && Array.isArray(payload.boards)) {
        setBoards((prev) =>
          mergeBackupBoards({
            currentBoards: prev,
            incomingBoards: payload.boards,
            baseRelays,
            normalizeRelayList,
            createId: () => crypto.randomUUID(),
          }),
        );
      }
      if (source === "remote") {
        const message = includeMetadata ? "Synced boards and settings from Nostr" : "Synced wallet backup from Nostr";
        showToast(message, 2600);
      }
    },
    [defaultRelays, normalizeRelayList, sanitizeSettingsForBackup, setBoards, setDefaultRelays, setSettings, settings.nostrBackupEnabled, showToast],
  );

  const handleIncomingNostrBackupEvent = useCallback(
    async (ev: NostrEvent) => {
      if (!settings.nostrBackupEnabled) return;
      if (nostrBackupHoldRef.current) return;
      if (!ev || ev.kind !== NOSTR_APP_BACKUP_KIND) return;
      const dTag = tagValue(ev, "d");
      if (dTag !== NOSTR_APP_BACKUP_D_TAG) return;
      if (!nostrPK) return;
      const skHex = bytesToHex(nostrSK);
      let payload: NostrAppBackupPayload;
      try {
        payload = await decryptNostrBackupPayload(ev.content, skHex, nostrPK);
      } catch (error) {
        console.warn("Failed to decrypt Nostr backup payload", error);
        return;
      }
      if (!payload || payload.version !== 1) return;
      const payloadTs = Math.max(Number(payload.timestamp) || 0, ev.created_at || 0);
      const lastTs = nostrBackupStateRef.current.lastTimestamp || 0;
      if (payloadTs <= lastTs) {
        if (!nostrBackupStateRef.current.lastEventId && ev.id) {
          setNostrBackupState((prev) => ({ ...prev, lastEventId: ev.id }));
        }
        return;
      }
      await applyNostrBackupPayload(payload, "remote");
      nostrBackupPublishedSnapshotRef.current = serializeNostrBackupSnapshotRef.current();
      setNostrBackupState({
        lastEventId: ev.id || null,
        lastTimestamp: payloadTs,
        pubkey: nostrPK || null,
      });
    },
    [applyNostrBackupPayload, nostrPK, nostrSK, setNostrBackupState, settings.nostrBackupEnabled, tagValue],
  );

  const pullNostrBackupOnce = useCallback(async (): Promise<boolean> => {
    if (!settings.nostrBackupEnabled) return false;
    if (!nostrPK) return false;
    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return false;
    try {
      const events = await nostrList(relays, [
        { kinds: [NOSTR_APP_BACKUP_KIND], authors: [nostrPK], "#d": [NOSTR_APP_BACKUP_D_TAG], limit: 5 },
      ]);
      const latest = events.reduce<null | (typeof events)[number]>((current, event) => {
        if (!event) return current;
        if (!current || (event.created_at || 0) > (current.created_at || 0)) return event;
        return current;
      }, null);
      if (latest) {
        await handleIncomingNostrBackupEvent(latest as unknown as NostrEvent);
        return true;
      }
      return false;
    } catch (error) {
      console.warn("Failed to fetch Nostr backup", error);
      return false;
    }
  }, [defaultRelays, handleIncomingNostrBackupEvent, normalizeRelayList, nostrList, nostrPK, settings.nostrBackupEnabled]);

  const pullNostrBibleTrackerOnce = useCallback(async (): Promise<boolean> => {
    if (!settings.nostrBackupEnabled) return false;
    if (!nostrPK) return false;
    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return false;
    try {
      const events = await nostrList(relays, [
        { kinds: [NOSTR_APP_STATE_KIND], authors: [nostrPK], "#d": [NOSTR_BIBLE_TRACKER_D_TAG], limit: 5 },
      ]);
      const latest = events.reduce<null | (typeof events)[number]>((current, event) => {
        if (!event) return current;
        if (!current || (event.created_at || 0) > (current.created_at || 0)) return event;
        return current;
      }, null);
      if (latest) {
        await enqueueNostrApply(() => applyNostrBibleTrackerSyncEvent(latest as unknown as NostrEvent));
        return true;
      }
      return false;
    } catch (error) {
      console.warn("Failed to fetch Bible tracker sync from Nostr", error);
      return false;
    }
  }, [
    applyNostrBibleTrackerSyncEvent,
    defaultRelays,
    enqueueNostrApply,
    normalizeRelayList,
    nostrList,
    nostrPK,
    settings.nostrBackupEnabled,
  ]);

  const pullNostrScriptureMemoryOnce = useCallback(async (): Promise<boolean> => {
    if (!settings.nostrBackupEnabled) return false;
    if (!nostrPK) return false;
    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return false;
    try {
      const events = await nostrList(relays, [
        { kinds: [NOSTR_APP_STATE_KIND], authors: [nostrPK], "#d": [NOSTR_SCRIPTURE_MEMORY_D_TAG], limit: 5 },
      ]);
      const latest = events.reduce<null | (typeof events)[number]>((current, event) => {
        if (!event) return current;
        if (!current || (event.created_at || 0) > (current.created_at || 0)) return event;
        return current;
      }, null);
      if (latest) {
        await enqueueNostrApply(() => applyNostrScriptureMemorySyncEvent(latest as unknown as NostrEvent));
        return true;
      }
      return false;
    } catch (error) {
      console.warn("Failed to fetch scripture memory sync from Nostr", error);
      return false;
    }
  }, [
    applyNostrScriptureMemorySyncEvent,
    defaultRelays,
    enqueueNostrApply,
    normalizeRelayList,
    nostrList,
    nostrPK,
    settings.nostrBackupEnabled,
  ]);

  const publishNostrBibleTracker = useCallback(async () => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK) return;
    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    const tracker = bibleTrackerRef.current;
    const snapshotString = JSON.stringify(tracker);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = Math.max(nowSeconds, (nostrBibleTrackerStateRef.current.lastTimestamp || 0) + 1);
    const payload = { version: 1, timestamp, bibleTracker: tracker } as const;
    const skHex = bytesToHex(nostrSK);
    const content = await encryptNostrSyncPayload(payload, skHex, nostrPK);
    const result = await nostrPublishRef.current(
      relays,
      {
        kind: NOSTR_APP_STATE_KIND,
        content,
        tags: [
          ["d", NOSTR_BIBLE_TRACKER_D_TAG],
          ["client", NOSTR_APP_STATE_CLIENT_TAG],
        ],
        created_at: timestamp,
      },
      { sk: nostrSK, returnEvent: true },
    );
    const eventId = (result as any)?.event?.id || null;
    const publishedTs = (result as any)?.createdAt ?? timestamp;
    const nextState = {
      lastEventId: eventId || null,
      lastTimestamp: publishedTs,
      pubkey: nostrPK || null,
    };
    nostrBibleTrackerStateRef.current = nextState;
    setNostrBibleTrackerState(nextState);
    nostrBibleTrackerPublishedSnapshotRef.current = snapshotString;
  }, [
    defaultRelays,
    normalizeRelayList,
    nostrPK,
    nostrSK,
    setNostrBibleTrackerState,
    settings.nostrBackupEnabled,
  ]);

  const publishNostrScriptureMemory = useCallback(async () => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK) return;
    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    const snapshotString = JSON.stringify(scriptureMemory);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = Math.max(nowSeconds, (nostrScriptureMemoryStateRef.current.lastTimestamp || 0) + 1);
    const payload = { version: 1, timestamp, scriptureMemory } as const;
    const skHex = bytesToHex(nostrSK);
    const content = await encryptNostrSyncPayload(payload, skHex, nostrPK);
    const result = await nostrPublishRef.current(
      relays,
      {
        kind: NOSTR_APP_STATE_KIND,
        content,
        tags: [
          ["d", NOSTR_SCRIPTURE_MEMORY_D_TAG],
          ["client", NOSTR_APP_STATE_CLIENT_TAG],
        ],
        created_at: timestamp,
      },
      { sk: nostrSK, returnEvent: true },
    );
    const eventId = (result as any)?.event?.id || null;
    const publishedTs = (result as any)?.createdAt ?? timestamp;
    const nextState = {
      lastEventId: eventId || null,
      lastTimestamp: publishedTs,
      pubkey: nostrPK || null,
    };
    nostrScriptureMemoryStateRef.current = nextState;
    setNostrScriptureMemoryState(nextState);
    nostrScriptureMemoryPublishedSnapshotRef.current = snapshotString;
  }, [
    defaultRelays,
    normalizeRelayList,
    nostrPK,
    nostrSK,
    scriptureMemory,
    setNostrScriptureMemoryState,
    settings.nostrBackupEnabled,
  ]);

  const enqueueNostrBibleTrackerPublish = useCallback(() => {
    if (nostrBibleTrackerPublishRef.current) {
      nostrBibleTrackerQueuedPublishRef.current = true;
      return nostrBibleTrackerPublishRef.current;
    }
    const task = publishNostrBibleTracker()
      .catch((error) => {
        console.warn("Failed to publish Bible tracker sync", error);
        const now = Date.now();
        if (now - nostrBibleTrackerErrorToastAtRef.current > 60_000) {
          nostrBibleTrackerErrorToastAtRef.current = now;
          showToast("Unable to sync Bible progress", 2600);
        }
      })
      .finally(() => {
        nostrBibleTrackerPublishRef.current = null;
        if (!nostrBibleTrackerQueuedPublishRef.current) return;
        nostrBibleTrackerQueuedPublishRef.current = false;
        const currentSnapshot = JSON.stringify(bibleTrackerRef.current);
        if (nostrBibleTrackerPublishedSnapshotRef.current === currentSnapshot) return;
        enqueueNostrBibleTrackerPublish().catch(() => {});
      });
    nostrBibleTrackerPublishRef.current = task;
    return task;
  }, [publishNostrBibleTracker, showToast]);

  const enqueueNostrScriptureMemoryPublish = useCallback(() => {
    if (nostrScriptureMemoryPublishRef.current) return nostrScriptureMemoryPublishRef.current;
    const task = publishNostrScriptureMemory()
      .catch((error) => {
        console.warn("Failed to publish scripture memory sync", error);
        const now = Date.now();
        if (now - nostrScriptureMemoryErrorToastAtRef.current > 60_000) {
          nostrScriptureMemoryErrorToastAtRef.current = now;
          showToast("Unable to sync scripture memory list", 2600);
        }
      })
      .finally(() => {
        nostrScriptureMemoryPublishRef.current = null;
      });
    nostrScriptureMemoryPublishRef.current = task;
    return task;
  }, [publishNostrScriptureMemory, showToast]);

  const publishNostrBackup = useCallback(async () => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK) return;
    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    const snapshot = buildNostrBackupSnapshot();
    const snapshotString = serializeNostrBackupSnapshotRef.current();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = Math.max(nowSeconds, (nostrBackupStateRef.current.lastTimestamp || 0) + 1);
    const payload: NostrAppBackupPayload = { ...snapshot, version: 1, timestamp };
    const skHex = bytesToHex(nostrSK);
    const content = await encryptNostrBackupPayload(payload, skHex, nostrPK);
    const result = await nostrPublishRef.current(
      relays,
      {
        kind: NOSTR_APP_BACKUP_KIND,
        content,
        tags: [
          ["d", NOSTR_APP_BACKUP_D_TAG],
          ["client", NOSTR_APP_BACKUP_CLIENT_TAG],
        ],
        created_at: timestamp,
      },
      { sk: nostrSK, returnEvent: true },
    );
    const eventId = (result as any)?.event?.id || null;
    const prev = nostrBackupStateRef.current;
    const prevEventId = prev.pubkey === nostrPK ? prev.lastEventId : null;
    const publishedTs = (result as any)?.createdAt ?? timestamp;
    if (prevEventId && eventId && prevEventId !== eventId) {
      try {
        await nostrPublishRef.current(
          relays,
          {
            kind: 5,
            tags: [
              ["e", prevEventId],
              ["a", `${NOSTR_APP_BACKUP_KIND}:${nostrPK}:${NOSTR_APP_BACKUP_D_TAG}`],
            ],
            content: "Delete previous Taskify backup",
            created_at: publishedTs + 1,
          },
          { sk: nostrSK },
        );
      } catch (error) {
        console.warn("Failed to publish Nostr backup deletion", error);
      }
    }
    const nextState = {
      lastEventId: eventId || prevEventId,
      lastTimestamp: publishedTs,
      pubkey: nostrPK || null,
    };
    nostrBackupStateRef.current = nextState;
    setNostrBackupState(nextState);
    nostrBackupPublishedSnapshotRef.current = snapshotString;
  }, [buildNostrBackupSnapshot, defaultRelays, normalizeRelayList, nostrPK, nostrSK, setNostrBackupState, settings.nostrBackupEnabled]);

  const enqueueNostrBackupPublish = useCallback(() => {
    if (nostrBackupPublishRef.current) return nostrBackupPublishRef.current;
    const task = publishNostrBackup()
      .catch((error) => {
        console.warn("Failed to publish Nostr backup", error);
        showToast("Unable to sync backup to Nostr", 2600);
      })
      .finally(() => {
        nostrBackupPublishRef.current = null;
      });
    nostrBackupPublishRef.current = task;
    return task;
  }, [publishNostrBackup, showToast]);

  const publishLatestNostrBackup = useCallback(async () => {
    if (!settings.nostrBackupEnabled || !nostrPK) return;
    const initialSnapshot = serializeNostrBackupSnapshot();
    if (initialSnapshot === nostrBackupPublishedSnapshotRef.current) return;
    if (nostrBackupPublishRef.current) {
      try {
        await nostrBackupPublishRef.current;
      } catch {}
    }
    const latestSnapshot = serializeNostrBackupSnapshot();
    if (latestSnapshot === nostrBackupPublishedSnapshotRef.current) return;
    try {
      await enqueueNostrBackupPublish();
    } catch {}
  }, [enqueueNostrBackupPublish, nostrPK, serializeNostrBackupSnapshot, settings.nostrBackupEnabled]);


  // header view
  const [view, setView] = useState<"board" | "completed" | "board-upcoming" | "bible">("board");
  const [activePage, setActivePage] = useState<
    "boards" | "upcoming" | "wallet" | "wallet-bounties" | "contacts" | "settings"
  >("boards");
  // Ref updated every render so navigation callbacks can read the gate without
  // stale-closure issues (isOnboardingActive is derived further down).
  const isOnboardingActiveRef = useRef(false);
  const [walletBountiesTab, setWalletBountiesTab] = useState<"open" | "funded" | "pinned">("pinned");
  useEffect(() => {
    if (currentBoard?.kind === "bible") {
      if (view !== "completed") setView("bible");
    } else if (view === "bible") {
      setView("board");
    }
  }, [currentBoard?.kind, view]);
  const showSettings = activePage === "settings";
  const [addBoardOpen, setAddBoardOpen] = useState(false);


  const nostrBackupPublishedSnapshotRef = useRef<string | null>(null);
  const nostrBackupDebounceTimerRef = useRef<number | null>(null);
  useEffect(() => {
    nostrBackupPullFinishedRef.current = false;
    let cancelled = false;
    if (!settings.nostrBackupEnabled || !nostrPK || showSettings || nostrBackupHold) {
      if (!nostrBackupHold) nostrBackupPullFinishedRef.current = true;
      return () => {};
    }
    (async () => {
      try {
        await pullNostrBackupOnce();
      } finally {
        if (!cancelled) nostrBackupPullFinishedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [nostrBackupHold, nostrPK, pullNostrBackupOnce, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    nostrBibleTrackerPullFinishedRef.current = false;
    let cancelled = false;
    if (!settings.nostrBackupEnabled || !nostrPK || showSettings) {
      nostrBibleTrackerPullFinishedRef.current = true;
      return () => {};
    }
    (async () => {
      try {
        await pullNostrBibleTrackerOnce();
      } finally {
        if (!cancelled) nostrBibleTrackerPullFinishedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [nostrPK, pullNostrBibleTrackerOnce, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    nostrScriptureMemoryPullFinishedRef.current = false;
    let cancelled = false;
    if (!settings.nostrBackupEnabled || !nostrPK || showSettings) {
      nostrScriptureMemoryPullFinishedRef.current = true;
      return () => {};
    }
    (async () => {
      try {
        await pullNostrScriptureMemoryOnce();
      } finally {
        if (!cancelled) nostrScriptureMemoryPullFinishedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [nostrPK, pullNostrScriptureMemoryOnce, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || nostrBackupHold || !nostrBackupPullFinishedRef.current) return;
    if (nostrBackupInitialPublishRef.current) return;
    if ((nostrBackupStateRef.current.lastTimestamp || 0) > 0) return;
    if (!nostrPK) return;
    nostrBackupInitialPublishRef.current = true;
    enqueueNostrBackupPublish();
  }, [enqueueNostrBackupPublish, nostrBackupHold, nostrPK, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || !nostrBibleTrackerPullFinishedRef.current) return;
    if (nostrBibleTrackerInitialPublishRef.current) return;
    if ((nostrBibleTrackerStateRef.current.lastTimestamp || 0) > 0) return;
    if (!nostrPK) return;
    nostrBibleTrackerInitialPublishRef.current = true;
    enqueueNostrBibleTrackerPublish().catch(() => {});
  }, [enqueueNostrBibleTrackerPublish, nostrPK, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || !nostrScriptureMemoryPullFinishedRef.current) return;
    if (nostrScriptureMemoryInitialPublishRef.current) return;
    if ((nostrScriptureMemoryStateRef.current.lastTimestamp || 0) > 0) return;
    if (!nostrPK) return;
    nostrScriptureMemoryInitialPublishRef.current = true;
    enqueueNostrScriptureMemoryPublish().catch(() => {});
  }, [enqueueNostrScriptureMemoryPublish, nostrPK, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK || showSettings || nostrBackupHold) return;
    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    pool.setRelays(relays);
    const since = nostrBackupStateRef.current.lastTimestamp || undefined;
    const filters = [
      {
        kinds: [NOSTR_APP_BACKUP_KIND],
        authors: [nostrPK],
        "#d": [NOSTR_APP_BACKUP_D_TAG],
        ...(since ? { since } : {}),
        limit: 5,
      },
    ];
    const unsub = pool.subscribe(relays, filters, (ev) => {
      handleIncomingNostrBackupEvent(ev).catch((err) => {
        if ((import.meta as any)?.env?.DEV) console.warn("[nostr] backup event handling failed", err);
      });
    });
    return () => {
      try { unsub(); } catch {}
    };
  }, [defaultRelays, handleIncomingNostrBackupEvent, normalizeRelayList, nostrBackupHold, nostrPK, pool, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK || showSettings) return;
    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    pool.setRelays(relays);
    const since = nostrBibleTrackerStateRef.current.lastTimestamp || undefined;
    const filters = [
      {
        kinds: [NOSTR_APP_STATE_KIND],
        authors: [nostrPK],
        "#d": [NOSTR_BIBLE_TRACKER_D_TAG],
        ...(since ? { since } : {}),
        limit: 5,
      },
    ];
    const unsub = pool.subscribe(relays, filters, (ev) => {
      enqueueNostrApply(() => applyNostrBibleTrackerSyncEvent(ev)).catch(() => {});
    });
    return () => {
      try { unsub(); } catch {}
    };
  }, [
    applyNostrBibleTrackerSyncEvent,
    defaultRelays,
    enqueueNostrApply,
    normalizeRelayList,
    nostrPK,
    pool,
    settings.nostrBackupEnabled,
    showSettings,
  ]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK || showSettings) return;
    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    pool.setRelays(relays);
    const since = nostrScriptureMemoryStateRef.current.lastTimestamp || undefined;
    const filters = [
      {
        kinds: [NOSTR_APP_STATE_KIND],
        authors: [nostrPK],
        "#d": [NOSTR_SCRIPTURE_MEMORY_D_TAG],
        ...(since ? { since } : {}),
        limit: 5,
      },
    ];
    const unsub = pool.subscribe(relays, filters, (ev) => {
      enqueueNostrApply(() => applyNostrScriptureMemorySyncEvent(ev)).catch(() => {});
    });
    return () => {
      try { unsub(); } catch {}
    };
  }, [
    applyNostrScriptureMemorySyncEvent,
    defaultRelays,
    enqueueNostrApply,
    normalizeRelayList,
    nostrPK,
    pool,
    settings.nostrBackupEnabled,
    showSettings,
  ]);

  useEffect(() => {
    if (showSettings) {
      if (nostrBackupBaselineRef.current == null) {
        nostrBackupBaselineRef.current = serializeNostrBackupSnapshot();
        nostrBackupSettingsDirtyRef.current = false;
      } else {
        const currentSnapshot = serializeNostrBackupSnapshot();
        nostrBackupSettingsDirtyRef.current = currentSnapshot !== nostrBackupBaselineRef.current;
      }
      return;
    }
    if (nostrBackupBaselineRef.current == null) return;
    const baseline = nostrBackupBaselineRef.current;
    nostrBackupBaselineRef.current = null;
    const currentSnapshot = serializeNostrBackupSnapshot();
    const changedDuringSettings =
      nostrBackupSettingsDirtyRef.current || baseline !== currentSnapshot;
    nostrBackupSettingsDirtyRef.current = false;
    if (!settings.nostrBackupEnabled || !changedDuringSettings) return;
    let cancelled = false;
    setNostrBackupHold(true);
    (async () => {
      try {
        await publishLatestNostrBackup();
      } finally {
        if (!cancelled) setNostrBackupHold(false);
      }
    })();
    return () => { cancelled = true; };
  }, [publishLatestNostrBackup, serializeNostrBackupSnapshot, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || nostrBackupHold) return; // settings flow handled separately on close
    const currentSnapshot = serializeNostrBackupSnapshot();
    if (nostrBackupPublishedSnapshotRef.current === null) {
      nostrBackupPublishedSnapshotRef.current = currentSnapshot;
      return;
    }
    if (currentSnapshot === nostrBackupPublishedSnapshotRef.current) return;
    if (nostrBackupDebounceTimerRef.current) {
      window.clearTimeout(nostrBackupDebounceTimerRef.current);
    }
    nostrBackupDebounceTimerRef.current = window.setTimeout(() => {
      nostrBackupDebounceTimerRef.current = null;
      enqueueNostrBackupPublish().catch(() => {});
    }, NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS);
    return () => {
      if (nostrBackupDebounceTimerRef.current) {
        window.clearTimeout(nostrBackupDebounceTimerRef.current);
        nostrBackupDebounceTimerRef.current = null;
      }
    };
  }, [enqueueNostrBackupPublish, nostrBackupHold, serializeNostrBackupSnapshot, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || !nostrPK || !nostrBibleTrackerPullFinishedRef.current) return;
    const currentSnapshot = JSON.stringify(bibleTracker);
    if (nostrBibleTrackerPublishedSnapshotRef.current === null) {
      nostrBibleTrackerPublishedSnapshotRef.current = currentSnapshot;
      return;
    }
    if (currentSnapshot === nostrBibleTrackerPublishedSnapshotRef.current) return;
    if (nostrBibleTrackerDebounceTimerRef.current) {
      window.clearTimeout(nostrBibleTrackerDebounceTimerRef.current);
    }
    nostrBibleTrackerDebounceTimerRef.current = window.setTimeout(() => {
      nostrBibleTrackerDebounceTimerRef.current = null;
      enqueueNostrBibleTrackerPublish().catch(() => {});
    }, NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS);
    return () => {
      if (nostrBibleTrackerDebounceTimerRef.current) {
        window.clearTimeout(nostrBibleTrackerDebounceTimerRef.current);
        nostrBibleTrackerDebounceTimerRef.current = null;
      }
    };
  }, [
    bibleTracker,
    enqueueNostrBibleTrackerPublish,
    nostrPK,
    settings.nostrBackupEnabled,
    showSettings,
  ]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || !nostrPK || !nostrScriptureMemoryPullFinishedRef.current) return;
    const currentSnapshot = JSON.stringify(scriptureMemory);
    if (nostrScriptureMemoryPublishedSnapshotRef.current === null) {
      nostrScriptureMemoryPublishedSnapshotRef.current = currentSnapshot;
      return;
    }
    if (currentSnapshot === nostrScriptureMemoryPublishedSnapshotRef.current) return;
    if (nostrScriptureMemoryDebounceTimerRef.current) {
      window.clearTimeout(nostrScriptureMemoryDebounceTimerRef.current);
    }
    nostrScriptureMemoryDebounceTimerRef.current = window.setTimeout(() => {
      nostrScriptureMemoryDebounceTimerRef.current = null;
      enqueueNostrScriptureMemoryPublish().catch(() => {});
    }, NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS);
    return () => {
      if (nostrScriptureMemoryDebounceTimerRef.current) {
        window.clearTimeout(nostrScriptureMemoryDebounceTimerRef.current);
        nostrScriptureMemoryDebounceTimerRef.current = null;
      }
    };
  }, [
    enqueueNostrScriptureMemoryPublish,
    nostrPK,
    scriptureMemory,
    settings.nostrBackupEnabled,
    showSettings,
  ]);
  const showWallet = activePage === "wallet";
  const showContacts = activePage === "contacts";
  const showWalletShell = showWallet || showContacts;
  const walletModalPrefetchedRef = useRef(false);
  const prefetchWalletModal = useCallback(() => {
    if (walletModalPrefetchedRef.current) return;
    walletModalPrefetchedRef.current = true;
    loadCashuWalletModal().catch((err) => {
      if ((import.meta as any)?.env?.DEV) console.warn("[wallet] prefetch failed", err);
      walletModalPrefetchedRef.current = false; // Allow retry
    });
  }, []);
  const [walletTokenStateResetNonce, setWalletTokenStateResetNonce] = useState(0);
  const [updateToastVisible, setUpdateToastVisible] = useState(false);
  const shouldReloadForNavigation = useCallback(() => false, []);

  useEffect(() => {
    function handleUpdateAvailable() {
      setUpdateToastVisible(true);
    }

    window.addEventListener("taskify:update-available", handleUpdateAvailable);
    return () => {
      window.removeEventListener("taskify:update-available", handleUpdateAvailable);
    };
  }, []);

  const handleReloadNow = useCallback(() => {
    setUpdateToastVisible(false);
    window.location.reload();
  }, []);

  const handleReloadLater = useCallback(() => {
    setUpdateToastVisible(false);
  }, []);

  useEffect(() => {
    if (showWalletShell || walletModalPrefetchedRef.current) return;
    const requestIdle = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number)
      | undefined;
    const cancelIdle = (window as any).cancelIdleCallback as ((id: number) => void) | undefined;
    let idleId: number | null = null;
    let timer: number | undefined;
    if (requestIdle) {
      idleId = requestIdle(() => prefetchWalletModal(), { timeout: 1200 });
    } else {
      timer = window.setTimeout(() => {
        prefetchWalletModal();
      }, 300);
    }
    return () => {
      if (idleId != null && cancelIdle) {
        cancelIdle(idleId);
      }
      if (typeof timer === "number") {
        window.clearTimeout(timer);
      }
    };
  }, [prefetchWalletModal, showWalletShell]);
  const handleResetWalletTokenTracking = useCallback(() => {
    setWalletTokenStateResetNonce((value) => value + 1);
    showToast("Background token tracking reset", 3000);
  }, [showToast]);

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
  const openContactsPage = useCallback(() => {
    if (isOnboardingActiveRef.current) return;
    if (shouldReloadForNavigation()) return;
    prefetchWalletModal();
    startTransition(() => setActivePage("contacts"));
  }, [prefetchWalletModal, shouldReloadForNavigation]);

  const openShareBoard = useCallback(() => {
    if (shouldReloadForNavigation()) return;
    if (!currentBoard) return;
    setShareBoardTargetId(currentBoard.id);
    setShareBoardMode("board");
    setShareModeInfoOpen(false);
    setShareTemplateShare(null);
    setShareTemplateStatus(null);
    setShareTemplateBusy(false);
    setShareContactStatus(null);
    setShareContactBusy(false);
    setShareContactPickerOpen(false);
    setShareBoardModalOpen(true);
    shareBoardTargetIdRef.current = currentBoard.id;
    shareBoardModalOpenRef.current = true;
  }, [currentBoard, shouldReloadForNavigation]);
  const closeShareBoard = useCallback(() => {
    setShareBoardModalOpen(false);
    setShareBoardTargetId(null);
    setShareBoardMode("board");
    setShareModeInfoOpen(false);
    setShareTemplateShare(null);
    setShareTemplateStatus(null);
    setShareTemplateBusy(false);
    setShareContactStatus(null);
    setShareContactBusy(false);
    setShareContactPickerOpen(false);
    shareBoardTargetIdRef.current = null;
    shareBoardModalOpenRef.current = false;
  }, []);

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
      setBoards((prev) => [...prev, board]);
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
          };
          const copy = prev.slice();
          copy[existingIndex] = merged;
          return copy;
        }
        return [...prev, newBoard];
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
    if (settings.startupView === "wallet") {
      startTransition(() => setActivePage("wallet"));
    }
  }, [settings.startupView]);
  const { receiveToken } = useCashu();

  const onboardingNeedsKeySelection = useMemo(() => {
    try {
      const raw = (kvStorage.getItem(LS_NOSTR_SK) || "").trim();
      return !/^[0-9a-fA-F]{64}$/.test(raw);
    } catch {
      return true;
    }
  }, []);
  const [showFirstRunOnboarding, setShowFirstRunOnboarding] = useState(() => {
    if (!onboardingNeedsKeySelection) return false;
    try {
      return kvStorage.getItem(LS_FIRST_RUN_ONBOARDING_DONE) !== "done";
    } catch {
      return true;
    }
  });
  const completeFirstRunOnboarding = useCallback(() => {
    try {
      kvStorage.setItem(LS_FIRST_RUN_ONBOARDING_DONE, "done");
    } catch {}
    setShowFirstRunOnboarding(false);
  }, []);
  const handleOnboardingUseExistingKey = useCallback((value: string) => {
    return applyCustomNostrKey(value, { silent: true });
  }, [applyCustomNostrKey]);
  const handleOnboardingGenerateNewKey = useCallback(() => {
    try {
      const nsec = rotateNostrKey();
      // Ensure wallet seed exists for this account, even though onboarding now only displays nsec.
      getWalletSeedMnemonic();
      return { nsec };
    } catch {
      return null;
    }
  }, [rotateNostrKey]);
  const completeOnboardingWithReload = useCallback(() => {
    completeFirstRunOnboarding();
    if (typeof window !== "undefined") {
      window.setTimeout(() => window.location.reload(), 120);
    }
  }, [completeFirstRunOnboarding]);
  const handleOnboardingRestoreFromBackupFile = useCallback(async (file: File) => {
    const parsed = parseBackupJsonPayload(await file.text());
    applyBackupDataToStorage(parsed);
    completeOnboardingWithReload();
  }, [completeOnboardingWithReload]);
  const handleOnboardingRestoreFromCloud = useCallback(async (value: string) => {
    const parsed = await loadCloudBackupPayload(workerBaseUrl, value);
    applyBackupDataToStorage(parsed);
    completeOnboardingWithReload();
  }, [completeOnboardingWithReload, workerBaseUrl]);
  const handleOnboardingEnableNotifications = async () => {
    const platform = settings.pushNotifications?.platform === "android"
      ? "android"
      : detectPushPlatformFromNavigator();
    await enablePushNotifications(platform);
  };
  const onboardingPushSupported = typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && window.isSecureContext;
  const onboardingPushConfigured = !!workerBaseUrl && !!vapidPublicKey;
  // True while any onboarding/welcome overlay is blocking the app. Used to gate
  // background interaction via the HTML `inert` attribute.
  const isOnboardingActive = showFirstRunOnboarding;
  // Keep the ref in sync every render so nav callbacks can read it safely.
  isOnboardingActiveRef.current = isOnboardingActive;
  // Hard state-level gate: if onboarding is active, force activePage to the
  // neutral "boards" base view so no background section is ever visible/active.
  useEffect(() => {
    if (isOnboardingActive && activePage !== "boards") {
      startTransition(() => setActivePage("boards"));
    }
  }, [isOnboardingActive, activePage]);

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

  const handlePrintBibleWindow = useCallback(() => {
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

  const [dayChoice, setDayChoiceRaw] = useState<DayChoice>(() => {
    const firstBoard = boards.find(b => !b.archived) ?? boards[0];
    if (firstBoard?.kind === "lists") {
      return (firstBoard as Extract<Board, {kind:"lists"}>).columns[0]?.id || "items";
    }
    return new Date().getDay() as Weekday;
  });
  const dayChoiceRef = useRef<DayChoice>(dayChoice);
  const setDayChoice = useCallback((next: DayChoice) => {
    dayChoiceRef.current = next;
    setDayChoiceRaw(next);
  }, []);
  const lastListViewRef = useRef<Map<string, string>>(new Map());
  const lastBoardScrollRef = useRef<Map<string, number>>(new Map());
  const autoCenteredIndexRef = useRef<Set<string>>(new Set());
  const autoCenteredWeekRef = useRef<Set<string>>(new Set());
  const activeWeekBoardRef = useRef<string | null>(null);
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
  const handleDownloadDocument = useCallback(async (doc: TaskDocument) => {
    if (typeof window === "undefined") return;
    try {
      const response = await fetch(doc.dataUrl);
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

  const openDocumentExternally = useCallback((doc: TaskDocument) => {
    if (typeof window === "undefined") return;
    window.location.assign(doc.dataUrl);
  }, []);

  const openDocumentPreview = useCallback((doc: TaskDocument) => {
    if (doc.kind === "pdf") {
      handleDownloadDocument(doc);
      return;
    }
    setPreviewDocument(doc);
  }, [handleDownloadDocument]);
  const handleOpenDocument = useCallback((_task: Task, doc: TaskDocument) => {
    openDocumentPreview(doc);
  }, [openDocumentPreview]);
  const handleOpenEventDocument = useCallback((doc: TaskDocument) => {
    openDocumentPreview(doc);
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
    const board = boards.find((b) => b.id === boardId && b.kind === "lists");
    if (!board) return null;
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
    const board = boards.find((b) => b.id === boardId && b.kind === "lists");
    if (!board) return false;
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
    const board = boards.find((b) => b.id === boardId && b.kind === "lists");
    if (!board) return;
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

  // drag-to-delete
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [draggingEventId, setDraggingEventId] = useState<string | null>(null);
  const [trashHover, setTrashHover] = useState(false);
  const [upcomingHover, setUpcomingHover] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [upcomingFilterOpen, setUpcomingFilterOpen] = useState(false);
  const [upcomingUsHolidaysEnabled, setUpcomingUsHolidaysEnabled] = useState<boolean>(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_US_HOLIDAYS_ENABLED);
    if (!raw) return true;
    return raw === "1" || raw.toLowerCase() === "true";
  });
  const [upcomingFilter, setUpcomingFilter] = useState<string[] | null>(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_FILTER);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null) return null;
      if (Array.isArray(parsed)) {
        return parsed.filter((id) => typeof id === "string");
      }
    } catch {}
    return null;
  });
  const [upcomingFilterPresets, setUpcomingFilterPresets] = useState<UpcomingFilterPreset[]>(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_FILTER_PRESETS);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((entry) => {
        const name = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (!name) return [];
        const id = typeof entry?.id === "string" && entry.id ? entry.id : crypto.randomUUID();
        const selection = Array.isArray(entry?.selection)
          ? entry.selection.filter((id: unknown) => typeof id === "string")
          : [];
        return [{ id, name, selection }];
      });
    } catch {
      return [];
    }
  });
  const [upcomingViewSheetOpen, setUpcomingViewSheetOpen] = useState(false);
  const [upcomingView, setUpcomingView] = useState<"details" | "list">(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_VIEW);
    return raw === "list" ? "list" : "details";
  });
  const [upcomingSearchOpen, setUpcomingSearchOpen] = useState(false);
  const [upcomingSearch, setUpcomingSearch] = useState("");
  const [upcomingListDate, setUpcomingListDate] = useState(() => isoDatePart(new Date().toISOString()));
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
  const [upcomingSortSheetOpen, setUpcomingSortSheetOpen] = useState(false);
  const [upcomingSort, setUpcomingSort] = useState<{ mode: BoardSortMode; direction: BoardSortDirection }>(() => {
    const fallback = { mode: "due" as const, direction: DEFAULT_BOARD_SORT_DIRECTION.due };
    const raw = kvStorage.getItem(LS_UPCOMING_SORT);
    if (!raw) return fallback;
    try {
      return normalizeBoardSortState(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const [upcomingBoardGrouping, setUpcomingBoardGrouping] = useState<UpcomingBoardGrouping>(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_BOARD_GROUPING);
    return raw === "grouped" ? "grouped" : "mixed";
  });
  const [boardSortSheetOpen, setBoardSortSheetOpen] = useState(false);
  const [boardSort, setBoardSort] = useState<{ mode: BoardSortMode; direction: BoardSortDirection }>(() => {
    const fallback = { mode: "due" as const, direction: DEFAULT_BOARD_SORT_DIRECTION.due };
    const raw = kvStorage.getItem(LS_BOARD_SORT);
    if (!raw) return fallback;
    try {
      return normalizeBoardSortState(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_SORT, JSON.stringify(upcomingSort));
    } catch {}
  }, [upcomingSort]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_BOARD_GROUPING, upcomingBoardGrouping);
    } catch {}
  }, [upcomingBoardGrouping]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_BOARD_SORT, JSON.stringify(boardSort));
    } catch {}
  }, [boardSort]);
  const boardSortOptions = useMemo(
    () => [
      { id: "manual", label: "Manual", supportsDirection: false },
      { id: "due", label: "Due Date", supportsDirection: true },
      { id: "priority", label: "Priority", supportsDirection: true },
      { id: "created", label: "Creation Date", supportsDirection: true },
      { id: "alpha", label: "A-Z", supportsDirection: true },
    ] as const,
    [],
  );
  const handleBoardSortSelect = useCallback((mode: BoardSortMode) => {
    setBoardSort((prev) => {
      if (prev.mode === mode) {
        if (mode === "manual") return prev;
        const nextDirection = prev.direction === "asc" ? "desc" : "asc";
        return { mode, direction: nextDirection };
      }
      return { mode, direction: DEFAULT_BOARD_SORT_DIRECTION[mode] };
    });
  }, []);
  const upcomingBoardGroupingOptions = useMemo(
    () => [
      { id: "mixed", label: "Across boards" },
      { id: "grouped", label: "Group by board" },
    ] as const,
    [],
  );
  const handleUpcomingSortSelect = useCallback((mode: BoardSortMode) => {
    setUpcomingSort((prev) => {
      if (prev.mode === mode) {
        if (mode === "manual") return prev;
        const nextDirection = prev.direction === "asc" ? "desc" : "asc";
        return { mode, direction: nextDirection };
      }
      return { mode, direction: DEFAULT_BOARD_SORT_DIRECTION[mode] };
    });
  }, []);
  const [boardDropOpen, setBoardDropOpen] = useState(false);
  const [boardDropPos, setBoardDropPos] = useState<{ top: number; left: number } | null>(null);
  const boardDropTimer = useRef<number>();
  const boardDropCloseTimer = useRef<number>();

  function scheduleBoardDropClose() {
    if (boardDropCloseTimer.current) window.clearTimeout(boardDropCloseTimer.current);
    boardDropCloseTimer.current = window.setTimeout(() => {
      setBoardDropOpen(false);
      setBoardDropPos(null);
      boardDropCloseTimer.current = undefined;
    }, 100);
  }

  function cancelBoardDropClose() {
    if (boardDropCloseTimer.current) {
      window.clearTimeout(boardDropCloseTimer.current);
      boardDropCloseTimer.current = undefined;
    }
  }

  const handleDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    setDraggingEventId(null);
    setTrashHover(false);
    setUpcomingHover(false);
    setBoardDropOpen(false);
    setBoardDropPos(null);
    if (boardDropTimer.current) window.clearTimeout(boardDropTimer.current);
    if (boardDropCloseTimer.current) window.clearTimeout(boardDropCloseTimer.current);
  }, []);

  const upcomingFilterGroups = useMemo<UpcomingFilterGroup[]>(() => {
    const groups: UpcomingFilterGroup[] = [];
    visibleBoards
      .filter((board) => board.kind !== "bible" && board.kind !== "compound")
      .forEach((board) => {
        const label = board.name || "Board";
        const boardOption: UpcomingFilterOption = {
          id: `board:${board.id}`,
          label,
          boardId: board.id,
        };
        const listOptions =
          board.kind === "lists"
            ? board.columns.map((column) => ({
                id: `board:${board.id}:col:${column.id}`,
                label: column.name,
                boardId: board.id,
                columnId: column.id,
              }))
            : [];
        groups.push({
          id: board.id,
          label,
          boardId: board.id,
          boardOption,
          listOptions,
        });
      });
    return groups;
  }, [visibleBoards]);

  const upcomingFilterOptions = useMemo(() => {
    const boardOptions = upcomingFilterGroups.flatMap((group) => [group.boardOption, ...group.listOptions]);
    const gcalOptions: UpcomingFilterOption[] = gcalStatus.connected
      ? gcalCalendars.map((cal) => ({
          id: `gcal:${cal.id}`,
          label: cal.name,
          boardId: `gcal:${cal.id}`,
        }))
      : [];
    return [...boardOptions, ...gcalOptions];
  }, [upcomingFilterGroups, gcalCalendars, gcalStatus.connected]);
  const upcomingFilterOptionMap = useMemo(() => {
    const map = new Map<string, UpcomingFilterOption>();
    upcomingFilterOptions.forEach((option) => {
      map.set(option.id, option);
    });
    return map;
  }, [upcomingFilterOptions]);
  const upcomingFilterGroupMap = useMemo(() => {
    const map = new Map<string, UpcomingFilterGroup>();
    upcomingFilterGroups.forEach((group) => {
      map.set(group.boardId, group);
    });
    return map;
  }, [upcomingFilterGroups]);

  const upcomingFilterOptionIds = useMemo(
    () => upcomingFilterOptions.map((option) => option.id),
    [upcomingFilterOptions],
  );

  useEffect(() => {
    if (upcomingFilter === null || !upcomingFilterOptionIds.length) return;
    const allowed = new Set(upcomingFilterOptionIds);
    const next = new Set(upcomingFilter.filter((id) => allowed.has(id)));
    upcomingFilterOptions.forEach((option) => {
      if (!option.columnId) return;
      if (next.has(option.id)) {
        next.add(`board:${option.boardId}`);
      }
    });
    upcomingFilterGroups.forEach((group) => {
      if (!next.has(group.boardOption.id)) return;
      if (group.listOptions.length === 0) return;
      const hasAnyList = group.listOptions.some((option) => next.has(option.id));
      if (!hasAnyList) {
        group.listOptions.forEach((option) => next.add(option.id));
      }
    });
    if (next.size !== upcomingFilter.length || upcomingFilter.some((id) => !next.has(id))) {
      setUpcomingFilter(Array.from(next));
    }
  }, [upcomingFilter, upcomingFilterGroups, upcomingFilterOptionIds, upcomingFilterOptions]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_FILTER, JSON.stringify(upcomingFilter));
    } catch {}
  }, [upcomingFilter]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_US_HOLIDAYS_ENABLED, upcomingUsHolidaysEnabled ? "1" : "0");
    } catch {}
  }, [upcomingUsHolidaysEnabled]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_FILTER_PRESETS, JSON.stringify(upcomingFilterPresets));
    } catch {}
  }, [upcomingFilterPresets]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_VIEW, upcomingView);
    } catch {}
  }, [upcomingView]);

  const upcomingFilterLabel = useMemo(() => {
    if (!upcomingFilterOptions.length) {
      return upcomingUsHolidaysEnabled ? SPECIAL_CALENDAR_US_HOLIDAYS_LABEL : "No boards";
    }
    if (upcomingFilter === null) {
      return upcomingUsHolidaysEnabled ? "All boards + US holidays" : "All boards";
    }
    if (upcomingFilter.length === 0) {
      return upcomingUsHolidaysEnabled ? SPECIAL_CALENDAR_US_HOLIDAYS_LABEL : "None";
    }
    if (upcomingFilter.length === 1) {
      const baseLabel = upcomingFilterOptions.find((option) => option.id === upcomingFilter[0])?.label || "1 selected";
      return upcomingUsHolidaysEnabled ? `${baseLabel} + US holidays` : baseLabel;
    }
    const baseLabel = `${upcomingFilter.length} selected`;
    return upcomingUsHolidaysEnabled ? `${baseLabel} + US holidays` : baseLabel;
  }, [upcomingFilter, upcomingFilterOptions, upcomingUsHolidaysEnabled]);

  const upcomingFilterSelection = useMemo(() => {
    if (upcomingFilter === null) return new Set(upcomingFilterOptionIds);
    return new Set(upcomingFilter);
  }, [upcomingFilter, upcomingFilterOptionIds]);

  const upcomingFilterMap = useMemo(() => {
    const selectedBoards = new Set<string>();
    const selectedLists = new Map<string, Set<string>>();
    upcomingFilterOptions.forEach((option) => {
      if (!upcomingFilterSelection.has(option.id)) return;
      if (option.columnId) {
        const existing = selectedLists.get(option.boardId) ?? new Set<string>();
        existing.add(option.columnId);
        selectedLists.set(option.boardId, existing);
      } else {
        selectedBoards.add(option.boardId);
      }
    });
    return { selectedBoards, selectedLists };
  }, [upcomingFilterOptions, upcomingFilterSelection]);

  const upcomingSearchTerm = useMemo(() => upcomingSearch.trim().toLowerCase(), [upcomingSearch]);
  const showUpcomingSearch = upcomingSearchOpen || upcomingSearchTerm.length > 0;

  useEffect(() => {
    if (activePage !== "upcoming") return;
    if (!upcomingSearchOpen) return;
    upcomingSearchInputRef.current?.focus();
  }, [activePage, upcomingSearchOpen]);

  const toggleUpcomingFilter = useCallback((optionId: string) => {
    if (!upcomingFilterOptionIds.length) return;
    setUpcomingFilter((prev) => {
      const option = upcomingFilterOptionMap.get(optionId);
      if (!option) return prev;
      const next = new Set(prev ?? upcomingFilterOptionIds);
      const group = upcomingFilterGroupMap.get(option.boardId);
      const listIds = group?.listOptions.map((opt) => opt.id) ?? [];
      const boardId = `board:${option.boardId}`;

      if (!option.columnId) {
        if (next.has(optionId)) {
          next.delete(optionId);
          listIds.forEach((id) => next.delete(id));
        } else {
          next.add(optionId);
          listIds.forEach((id) => next.add(id));
        }
      } else {
        if (next.has(optionId)) {
          next.delete(optionId);
        } else {
          next.add(optionId);
          next.add(boardId);
        }
        const hasAnyList = listIds.some((id) => next.has(id));
        if (!hasAnyList) {
          next.delete(boardId);
        }
      }

      const output = Array.from(next);
      if (output.length === upcomingFilterOptionIds.length) return null;
      return output;
    });
  }, [upcomingFilterGroupMap, upcomingFilterOptionIds, upcomingFilterOptionMap]);

  const applyUpcomingFilterPreset = useCallback(
    (preset: UpcomingFilterPreset) => {
      if (!upcomingFilterOptions.length) return;
      const presetSet = new Set(preset.selection);
      const next = upcomingFilterOptions
        .filter((option) => presetSet.has(option.id))
        .map((option) => option.id);
      setUpcomingFilter(next.length ? next : []);
    },
    [upcomingFilterOptions],
  );

  const saveUpcomingFilterPreset = useCallback(() => {
    if (!upcomingFilterOptions.length) return;
    const name = window.prompt("Name this preset");
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const selection = upcomingFilterOptions
      .filter((option) => upcomingFilterSelection.has(option.id))
      .map((option) => option.id);
    const uniqueSelection = Array.from(new Set(selection));
    setUpcomingFilterPresets((prev) => {
      const existingIndex = prev.findIndex((preset) => preset.name.toLowerCase() === trimmed.toLowerCase());
      const updatedPreset = {
        id: existingIndex === -1 ? crypto.randomUUID() : prev[existingIndex].id,
        name: trimmed,
        selection: uniqueSelection,
      };
      if (existingIndex === -1) {
        return [updatedPreset, ...prev];
      }
      return [updatedPreset, ...prev.filter((_, idx) => idx !== existingIndex)];
    });
  }, [upcomingFilterOptions, upcomingFilterSelection]);

  const deleteUpcomingFilterPreset = useCallback((preset: UpcomingFilterPreset) => {
    let confirmed = true;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      confirmed = window.confirm(`Delete preset "${preset.name}"?`);
    }
    if (!confirmed) return;
    setUpcomingFilterPresets((prev) => prev.filter((p) => p.id !== preset.id));
  }, []);

  const upcomingPresetHoldTimerRef = useRef<number | null>(null);
  const upcomingPresetHoldTriggeredRef = useRef(false);
  const upcomingPresetHoldStartRef = useRef<{ x: number; y: number } | null>(null);
  const cancelUpcomingPresetHold = useCallback(() => {
    if (upcomingPresetHoldTimerRef.current != null) {
      window.clearTimeout(upcomingPresetHoldTimerRef.current);
      upcomingPresetHoldTimerRef.current = null;
    }
    upcomingPresetHoldStartRef.current = null;
  }, []);
  useEffect(() => cancelUpcomingPresetHold, [cancelUpcomingPresetHold]);

  const startUpcomingPresetHold = useCallback(
    (preset: UpcomingFilterPreset, event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      cancelUpcomingPresetHold();
      upcomingPresetHoldTriggeredRef.current = false;
      upcomingPresetHoldStartRef.current = { x: event.clientX, y: event.clientY };
      upcomingPresetHoldTimerRef.current = window.setTimeout(() => {
        upcomingPresetHoldTimerRef.current = null;
        upcomingPresetHoldTriggeredRef.current = true;
        upcomingPresetHoldStartRef.current = null;
        deleteUpcomingFilterPreset(preset);
      }, 650);
    },
    [cancelUpcomingPresetHold, deleteUpcomingFilterPreset],
  );
  const maybeCancelUpcomingPresetHold = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const start = upcomingPresetHoldStartRef.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
        cancelUpcomingPresetHold();
      }
    },
    [cancelUpcomingPresetHold],
  );

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
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const inlineInputRefs = useRef(new Map<string, HTMLInputElement>());

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

  const setColumnRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) columnRefs.current.set(key, el);
    else columnRefs.current.delete(key);
  }, []);

  const setInlineInputRef = useCallback((key: string, el: HTMLInputElement | null) => {
    if (el) inlineInputRefs.current.set(key, el);
    else inlineInputRefs.current.delete(key);
  }, []);

  const scrollColumnIntoView = useCallback((key: string, behavior: ScrollBehavior = "smooth") => {
    const scroller = scrollerRef.current;
    const column = columnRefs.current.get(key);
    if (!scroller || !column) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const columnRect = column.getBoundingClientRect();
    const offset =
      scroller.scrollLeft +
      (columnRect.left - scrollerRect.left) -
      scroller.clientWidth / 2 +
      column.clientWidth / 2;
    const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const target = Math.min(Math.max(offset, 0), maxScroll);
    scroller.scrollTo({ left: target, behavior });
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
          ? columnRefs.current.get(dest.key) || null
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

  const walletBountiesVisibleTasks = useMemo(() => {
    if (walletBountiesTab === "funded") return fundedBountyTasks;
    if (walletBountiesTab === "pinned") return pinnedBountyTasks;
    return openBountyTasks;
  }, [fundedBountyTasks, openBountyTasks, pinnedBountyTasks, walletBountiesTab]);

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

  const buildBoardPrintTasks = useCallback((): BoardPrintTask[] => {
    if (!currentBoard) return [];
    const titleForTask = (task: Task) => {
      const labelSource = task.title || (task.images?.length ? "Image" : task.documents?.[0]?.name || "");
      return labelSource.trim() || "Task";
    };
    const visible = tasksForBoard.filter((task) => !task.completed && isVisibleNow(task));
    if (visible.length === 0) return [];

    if (currentBoard.kind === "week") {
      const dayOrder = Array.from({ length: 7 }, (_, i) => ((settings.weekStart + i) % 7) as Weekday);
      const dayMap = new Map<Weekday, Task[]>();
      visible.forEach((task) => {
        const day = taskWeekday(task) ?? (new Date().getDay() as Weekday);
        const list = dayMap.get(day) ?? [];
        list.push(task);
        dayMap.set(day, list);
      });

      const output: BoardPrintTask[] = [];
      const pushGroup = (label: string, groupTasks: Task[]) => {
        groupTasks
          .slice()
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .forEach((task) => {
            output.push({ id: task.id, title: titleForTask(task), label });
          });
      };

      dayOrder.forEach((day) => {
        const groupTasks = dayMap.get(day);
        if (groupTasks && groupTasks.length) {
          pushGroup(WD_SHORT[day], groupTasks);
        }
      });
      return output;
    }

    if (isListLikeBoard(currentBoard)) {
      const columnTaskMap = new Map<string, Task[]>();
      listColumns.forEach((col) => columnTaskMap.set(col.id, []));
      for (const task of visible) {
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
        const bucket = columnTaskMap.get(col.id);
        if (!bucket || bucket.length === 0) return;
        bucket
          .slice()
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .forEach((task) => {
            output.push({ id: task.id, title: titleForTask(task), label: col.name });
          });
      });
      return output;
    }

    return visible.map((task) => ({ id: task.id, title: titleForTask(task) }));
  }, [currentBoard, listColumns, listColumnSources, settings.weekStart, tasksForBoard]);

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

  const handleBoardPaperSizeChange = useCallback((paperSize: PrintPaperSize) => {
    setBoardPrintJob((prev) => {
      if (!prev || prev.paperSize === paperSize) return prev;
      const next = { ...prev, paperSize };
      persistBoardPrintJob(next);
      return next;
    });
  }, []);

  const handlePrintBoardWindow = useCallback(() => {
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
    let result = upcomingUsHolidaysEnabled ? [...boardEvents, ...upcomingUsHolidayEvents] : boardEvents;
    if (gcalCalendarEvents.length > 0) {
      result = [...result, ...(gcalCalendarEvents as unknown as typeof result)];
    }
    return result;
  }, [
    calendarEvents,
    messagesBoardId,
    upcomingBoardOrder,
    upcomingUsHolidayEvents,
    upcomingUsHolidaysEnabled,
    gcalCalendarEvents,
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
          if (isGcalBoardId(ev.boardId)) return upcomingFilter === null || upcomingFilter.includes(ev.boardId);
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
  }, [resolveUpcomingTargetDateKey]);
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
	    const isGcal = (ev as any).gcalSource === true;
	    const gcalCalendarName = isGcal && typeof (ev as any).gcalCalendarName === "string"
	      ? (ev as any).gcalCalendarName
	      : "";
	    const board = boardMap.get(ev.boardId);
	    const boardLabel = isUsHoliday
	      ? SPECIAL_CALENDAR_US_HOLIDAYS_LABEL
	      : isGcal
	        ? (gcalCalendarName || "Google Calendar")
	        : (board?.name || "Board");
	    const listLabel =
	      !isGcal && board?.kind === "lists"
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
	          showDate={false}
	          meta={meta}
	          trailing={revealAction}
	          onOpenDocument={(_event, doc) => handleOpenEventDocument(doc)}
	          onEdit={isUsHoliday ? undefined : () => setEditing({ type: "event", originalType: "event", originalId: ev.id, event: ev })}
	          onDragStart={isUsHoliday ? undefined : (id) => setDraggingEventId(id)}
	          onDragEnd={handleDragEnd}
	        />
	      </div>
	    );
	  }, [boardMap, handleDragEnd, handleOpenEventDocument, setCalendarEvents, setEditing, settings.weekStart]);

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

  const applyCalendarRsvpEvent = useCallback(async (ev: NostrEvent) => {
    if (!ev?.content || ev.kind !== TASKIFY_CALENDAR_RSVP_KIND) return;
    const ctx = activeEventRsvpContextRef.current;
    if (!ctx) return;
    const tokenMap = activeEventInviteTokensRef.current ?? {};
    const attendeePubkey = (ev.pubkey || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(attendeePubkey)) return;
    try {
      const raw = await decryptCalendarRsvpPayload(ev.content, ctx.boardSkHex, ev.pubkey);
      const payload = parseCalendarRsvpPayload(raw);
      if (!payload || payload.eventId !== ctx.eventId) return;
      const expectedToken = tokenMap[attendeePubkey];
      const boardToken = deriveBoardRsvpToken(ctx.boardNostrId, attendeePubkey);
      const tokenValues = Object.values(tokenMap);
      const tokenMatches =
        payload.inviteToken === boardToken
        || (!!expectedToken && payload.inviteToken === expectedToken)
        || (tokenValues.length > 0 && tokenValues.includes(payload.inviteToken));
      if (!tokenMatches) return;
      const createdAt = typeof ev.created_at === "number" ? ev.created_at : 0;
      const next: CalendarRsvpEnvelope = {
        eventId: payload.eventId,
        authorPubkey: attendeePubkey,
        createdAt,
        status: payload.status,
        ...(payload.fb ? { fb: payload.fb } : {}),
        inviteToken: payload.inviteToken,
      };
      const existing = activeEventRsvpMapRef.current.get(next.authorPubkey);
      if (existing && existing.createdAt > next.createdAt) return;
      activeEventRsvpMapRef.current.set(next.authorPubkey, next);
      setActiveEventRsvps(
        Array.from(activeEventRsvpMapRef.current.values()).sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (err) {
      console.warn("Failed to decrypt RSVP", err);
    }
  }, [setActiveEventRsvps]);

  const applyExternalCalendarRsvpEvent = useCallback(async (ev: NostrEvent) => {
    if (!ev?.content || ev.kind !== TASKIFY_CALENDAR_RSVP_KIND) return;
    if (!nostrSkHex || !nostrPK) return;
    const attendeePubkey = (ev.pubkey || "").toLowerCase();
    if (attendeePubkey !== nostrPK) return;
    const canonicalAddr = tagValue(ev, "a");
    if (!canonicalAddr) return;
    const target = calendarEventsRef.current.find(
      (event) => event.external && event.canonicalAddress === canonicalAddr,
    );
    if (!target || !target.boardPubkey) return;
    try {
      const raw = await decryptCalendarRsvpPayloadForAttendee(ev.content, nostrSkHex, target.boardPubkey);
      const payload = parseCalendarRsvpPayload(raw);
      if (!payload || payload.eventId !== target.id) return;
      const createdAt = typeof ev.created_at === "number" ? ev.created_at : 0;
      setCalendarEvents((prev) => {
        const idx = prev.findIndex((event) => event.external && event.canonicalAddress === canonicalAddr);
        if (idx < 0) return prev;
        const existing = prev[idx];
        if (existing.rsvpCreatedAt && existing.rsvpCreatedAt > createdAt) return prev;
        const updated: CalendarEvent = {
          ...existing,
          rsvpStatus: payload.status,
          rsvpCreatedAt: createdAt,
          ...(payload.fb ? { rsvpFb: payload.fb } : { rsvpFb: undefined }),
          ...(payload.inviteToken && !existing.inviteToken ? { inviteToken: payload.inviteToken } : {}),
        };
        const copy = prev.slice();
        copy[idx] = updated;
        return copy;
      });
    } catch (err) {
      console.warn("Failed to decrypt external RSVP", err);
    }
  }, [nostrPK, nostrSkHex, setCalendarEvents, tagValue]);

  useEffect(() => {
    if (activeEventRsvpSubCloserRef.current) {
      try {
        activeEventRsvpSubCloserRef.current();
      } catch {}
      activeEventRsvpSubCloserRef.current = null;
    }
    activeEventRsvpMapRef.current = new Map();
    activeEventInviteTokensRef.current = null;
    activeEventInviteTokensVersionRef.current = "";
    activeEventRsvpContextRef.current = null;
    setActiveEventRsvps([]);
    setActiveEventRsvpCoord(null);
    setActiveEventRsvpRelays([]);

    if (!editing || editing.type !== "event") return;
    const event = editing.event;
    const board = boards.find((b) => b.id === event.boardId);
    const relayCandidates = [
      ...(board?.nostr?.relays?.length ? board.nostr.relays : []),
      ...defaultRelays,
      ...inboxRelays,
      ...Array.from(DEFAULT_NOSTR_RELAYS),
    ];
    const relays = Array.from(new Set(relayCandidates.map((relay) => relay.trim()).filter(Boolean)));

    if (board?.nostr?.boardId && relays.length) {
      let cancelled = false;
      const boardNostrId = board.nostr.boardId;

      (async () => {
        try {
          const boardKeys = await deriveBoardNostrKeys(board.nostr!.boardId);
          const coord = calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, event.id);
          if (cancelled) return;
          activeEventRsvpContextRef.current = { eventId: event.id, boardNostrId, boardSkHex: boardKeys.skHex };
          setActiveEventRsvpCoord(coord);
          setActiveEventRsvpRelays(relays);
          activeEventInviteTokensRef.current = event.inviteTokens ?? null;
          activeEventInviteTokensVersionRef.current = event.inviteTokens
            ? JSON.stringify(Object.keys(event.inviteTokens).sort().map((key) => [key, event.inviteTokens![key]]))
            : "";

          const subscription = pool.subscribeMany(
            relays,
            { kinds: [TASKIFY_CALENDAR_RSVP_KIND], "#a": [coord] },
            {
              onevent: (ev) => {
                if (cancelled) return;
                void applyCalendarRsvpEvent(ev as NostrEvent);
              },
            },
          );
          activeEventRsvpSubCloserRef.current = () => {
            try {
              subscription.close("taskify-rsvps");
            } catch {}
          };

          try {
            if (typeof (pool as any).list === "function") {
              const events = await (pool as any).list(relays, [
                { kinds: [TASKIFY_CALENDAR_RSVP_KIND], "#a": [coord] },
              ]);
              if (!cancelled && Array.isArray(events)) {
                events.forEach((evt: any) => void applyCalendarRsvpEvent(evt as NostrEvent));
              }
            }
          } catch (err) {
            console.warn("RSVP fetch failed", err);
          }
        } catch (err) {
          console.warn("RSVP subscription failed", err);
        }
      })();

      return () => {
        cancelled = true;
        if (activeEventRsvpSubCloserRef.current) {
          try {
            activeEventRsvpSubCloserRef.current();
          } catch {}
          activeEventRsvpSubCloserRef.current = null;
        }
      };
    }

    if (event.canonicalAddress && event.inviteToken) {
      setActiveEventRsvpCoord(event.canonicalAddress);
      setActiveEventRsvpRelays(event.inviteRelays ?? []);
      if (event.external && nostrPK && event.rsvpStatus) {
        const createdAt = event.rsvpCreatedAt ?? 0;
        const next: CalendarRsvpEnvelope = {
          eventId: event.id,
          authorPubkey: nostrPK,
          createdAt,
          status: event.rsvpStatus,
          ...(event.rsvpFb ? { fb: event.rsvpFb } : {}),
          ...(event.inviteToken ? { inviteToken: event.inviteToken } : {}),
        };
        activeEventRsvpMapRef.current = new Map([[nostrPK, next]]);
        setActiveEventRsvps([next]);
      }
    }
  }, [boards, defaultRelays, editing, inboxRelays, nostrPK, pool, applyCalendarRsvpEvent]);

  useEffect(() => {
    if (externalEventRsvpSubCloserRef.current) {
      try {
        externalEventRsvpSubCloserRef.current();
      } catch {}
      externalEventRsvpSubCloserRef.current = null;
    }
    if (!nostrSkHex || !nostrPK) return;

    const targets = calendarEvents.filter(
      (event) => event.external && !!event.canonicalAddress && !!event.boardPubkey,
    );
    if (!targets.length) return;

    const canonicalAddrs = new Set<string>();
    const relaySet = new Set<string>();
    targets.forEach((event) => {
      if (event.canonicalAddress) canonicalAddrs.add(event.canonicalAddress);
      (event.inviteRelays ?? []).forEach((relay) => relaySet.add(relay));
    });
    if (!canonicalAddrs.size) return;

    const relayCandidates = [
      ...Array.from(relaySet),
      ...defaultRelays,
      ...inboxRelays,
      ...Array.from(DEFAULT_NOSTR_RELAYS),
    ];
    const relays = Array.from(new Set(relayCandidates.map((relay) => relay.trim()).filter(Boolean)));
    if (!relays.length) return;

    let cancelled = false;
    const filter: any = { kinds: [TASKIFY_CALENDAR_RSVP_KIND], "#a": Array.from(canonicalAddrs) };
    if (nostrPK) filter.authors = [nostrPK];

    const subscription = pool.subscribeMany(
      relays,
      filter,
      {
        onevent: (ev) => {
          if (cancelled) return;
          void applyExternalCalendarRsvpEvent(ev as NostrEvent);
        },
      },
    );
    externalEventRsvpSubCloserRef.current = () => {
      try {
        subscription.close("taskify-external-rsvps");
      } catch {}
    };

    (async () => {
      try {
        if (typeof (pool as any).list === "function") {
          const events = await (pool as any).list(relays, [filter]);
          if (!cancelled && Array.isArray(events)) {
            events.forEach((evt: any) => void applyExternalCalendarRsvpEvent(evt as NostrEvent));
          }
        }
      } catch (err) {
        console.warn("External RSVP fetch failed", err);
      }
    })();

    return () => {
      cancelled = true;
      if (externalEventRsvpSubCloserRef.current) {
        try {
          externalEventRsvpSubCloserRef.current();
        } catch {}
        externalEventRsvpSubCloserRef.current = null;
      }
    };
  }, [
    applyExternalCalendarRsvpEvent,
    calendarEvents,
    defaultRelays,
    inboxRelays,
    nostrPK,
    nostrSkHex,
    pool,
  ]);

  useEffect(() => {
    if (!editing || editing.type !== "event") return;
    if (!editing.event.external) return;
    if (!nostrPK) return;
    const latest = calendarEventsRef.current.find(
      (event) =>
        event.external &&
        event.id === editing.event.id &&
        event.canonicalAddress === editing.event.canonicalAddress,
    );
    if (!latest?.rsvpStatus) {
      activeEventRsvpMapRef.current = new Map();
      setActiveEventRsvps([]);
      return;
    }
    const createdAt = latest.rsvpCreatedAt ?? 0;
    const next: CalendarRsvpEnvelope = {
      eventId: latest.id,
      authorPubkey: nostrPK,
      createdAt,
      status: latest.rsvpStatus,
      ...(latest.rsvpFb ? { fb: latest.rsvpFb } : {}),
      ...(latest.inviteToken ? { inviteToken: latest.inviteToken } : {}),
    };
    activeEventRsvpMapRef.current = new Map([[nostrPK, next]]);
    setActiveEventRsvps([next]);
  }, [calendarEvents, editing, nostrPK]);

  useEffect(() => {
    if (!editing || editing.type !== "event") return;
    const eventId = editing.event.id;
    const latest = calendarEventsRef.current.find((ev) => ev.id === eventId) ?? null;
    const inviteTokens = latest?.inviteTokens ?? editing.event.inviteTokens ?? null;
    const tokenVersion = inviteTokens
      ? JSON.stringify(Object.keys(inviteTokens).sort().map((key) => [key, inviteTokens[key]]))
      : "";
    if (tokenVersion === activeEventInviteTokensVersionRef.current) return;
    activeEventInviteTokensVersionRef.current = tokenVersion;
    activeEventInviteTokensRef.current = inviteTokens;
    if (!activeEventRsvpCoord || !activeEventRsvpRelays.length) return;
    (async () => {
      try {
        if (typeof (pool as any).list === "function") {
          const events = await (pool as any).list(activeEventRsvpRelays, [
            { kinds: [TASKIFY_CALENDAR_RSVP_KIND], "#a": [activeEventRsvpCoord] },
          ]);
          if (Array.isArray(events)) {
            events.forEach((evt: any) => void applyCalendarRsvpEvent(evt as NostrEvent));
          }
        }
      } catch (err) {
        console.warn("RSVP refresh failed", err);
      }
    })();
  }, [activeEventRsvpCoord, activeEventRsvpRelays, applyCalendarRsvpEvent, calendarEvents, editing, pool]);

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
  const ensureMigrationState = useCallback((bTag: string): BoardMigrationState => {
    let state = boardMigrationRef.current.get(bTag);
    if (!state) {
      state = { dedicatedSeen: false, legacySeen: false, migrationAttempted: false };
      boardMigrationRef.current.set(bTag, state);
    }
    return state;
  }, []);
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
        tags: [["a", aTag]],
        content: "Task deleted",
        created_at: Math.floor(Date.now() / 1000),
      }, { sk: boardKeys.sk });
    } catch (err) {
      console.warn("Failed to publish nostr deletion", err);
    }
  }
  async function publishTaskDeleted(t: Task) {
    const b = boards.find((x) => x.id === t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const boardKeys = await deriveBoardNostrKeys(boardId);
    const bTag = boardTag(boardId);
    const pendingKey = `${bTag}::${t.id}`;
    pendingNostrTasksRef.current.add(pendingKey);
    try {
      await publishBoardMetadata(b);
      const colTag = (b.kind === "week") ? "day" : (t.columnId || "");
      const tags: string[][] = [["d", t.id],["b", bTag],["col", String(colTag)],["status","deleted"]];
      const raw = JSON.stringify({
        title: t.title,
        priority: t.priority ?? null,
        note: t.note || "",
        dueISO: t.dueISO,
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
      const createdAt = await nostrPublish(relays, {
        kind: 30301,
        tags,
        content,
        created_at: Math.floor(Date.now() / 1000),
      }, { sk: boardKeys.sk });
      await publishTaskDeletionRequest(boardKeys, relays, t.id);
      if (!nostrIdxRef.current.taskClock.has(bTag)) {
        nostrIdxRef.current.taskClock.set(bTag, new Map());
      }
      nostrIdxRef.current.taskClock.get(bTag)!.set(t.id, createdAt);
    } finally {
      pendingNostrTasksRef.current.delete(pendingKey);
    }
  }
  async function maybePublishTask(
    t: Task,
    boardOverride?: Board,
    options?: { skipBoardMetadata?: boolean }
  ) {
    const b = boardOverride || boards.find((x) => x.id === t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const boardKeys = await deriveBoardNostrKeys(boardId);
    const bTag = boardTag(boardId);
    const pendingKey = `${bTag}::${t.id}`;
    pendingNostrTasksRef.current.add(pendingKey);
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
    // Include explicit nulls to signal removals when undefined
    body.images = (typeof t.images === 'undefined') ? null : t.images;
    body.documents = (typeof t.documents === 'undefined') ? null : t.documents;
    body.bounty = (typeof t.bounty === 'undefined') ? null : (normalizedBounty ?? null);
    body.subtasks = (typeof t.subtasks === 'undefined') ? null : t.subtasks;
    body.assignees = (typeof t.assignees === "undefined") ? null : t.assignees;
    body.inboxItem = typeof t.inboxItem === "undefined" ? null : t.inboxItem ?? null;
    try {
      if (!options?.skipBoardMetadata) {
        await publishBoardMetadata(b);
      }
      const raw = JSON.stringify(body);
      const content = await encryptToBoard(boardId, raw);
      const createdAt = await nostrPublish(relays, {
        kind: 30301,
        tags,
        content,
        created_at: Math.floor(Date.now() / 1000),
      }, { sk: boardKeys.sk });
      // Update local task clock so immediate refreshes don't revert state
      if (!nostrIdxRef.current.taskClock.has(bTag)) {
        nostrIdxRef.current.taskClock.set(bTag, new Map());
      }
      nostrIdxRef.current.taskClock.get(bTag)!.set(t.id, createdAt);
    } finally {
      pendingNostrTasksRef.current.delete(pendingKey);
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

  const buildCanonicalCalendarPayload = (event: CalendarEvent, options?: { deleted?: boolean }) => {
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
    if (event.documents?.length) base.documents = event.documents;
    if (event.image) base.image = event.image;
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

  const buildViewCalendarPayload = (event: CalendarEvent, options?: { deleted?: boolean }) => {
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
    if (event.documents?.length) base.documents = event.documents;
    if (event.image) base.image = event.image;
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
    pendingNostrCalendarRef.current.add(pendingKey);
    try {
      await publishBoardMetadata(b);
      const { eventKey, inviteTokens, changed } = mergeInviteTokens(eventForPublish);
      const updatedEvent = changed ? { ...eventForPublish, eventKey, inviteTokens } : eventForPublish;
      if (changed) {
        setCalendarEvents((prev) => prev.map((ev) => (ev.id === event.id ? updatedEvent : ev)));
      }
      const canonicalPayload = buildCanonicalCalendarPayload(updatedEvent, { deleted: true });
      const viewPayload = buildViewCalendarPayload(updatedEvent, { deleted: true });
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

      const canonicalPayload = buildCanonicalCalendarPayload(updatedEvent);
      if (!canonicalPayload) return;
      const viewPayload = buildViewCalendarPayload(updatedEvent);
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
    } finally {
      pendingNostrCalendarRef.current.delete(pendingKey);
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
    const migrationState = ensureMigrationState(d);
    let isDedicated = true;
    try {
      const boardKeys = await deriveBoardNostrKeys(boardId);
      isDedicated = ev.pubkey === boardKeys.pk;
    } catch {
      isDedicated = true; // fall back to accepting events if derivation fails
    }
    if (isDedicated) migrationState.dedicatedSeen = true;
    else {
      migrationState.legacySeen = true;
      if (migrationState.dedicatedSeen) return;
    }
    const last = nostrIdxRef.current.boardMeta.get(d) || 0;
    if (ev.created_at < last) return;
    // Accept events with the same timestamp to avoid missing updates
    nostrIdxRef.current.boardMeta.set(d, ev.created_at);
    const kindTag = tagValue(ev, "k");
    const name = tagValue(ev, "name");
    let payload: any = {};
    let boardDecryptedWithLegacyKey = false;
    try {
      const { plaintext, usedLegacyKey } = await decryptFromBoard(boardId, ev.content);
      boardDecryptedWithLegacyKey = usedLegacyKey;
      payload = plaintext ? JSON.parse(plaintext) : {};
    } catch {
      try { payload = ev.content ? JSON.parse(ev.content) : {}; } catch {}
    }
    if (boardDecryptedWithLegacyKey) {
      aesMigrationPendingBoardIdsRef.current.add(boardId);
    }
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
        };
        return { id: stub.id, boards: [...state, stub] };
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
      return working;
    });
  }, [setBoards, tagValue, defaultRelays, ensureMigrationState]);
  const applyTaskEvent = useCallback(async (ev: NostrEvent) => {
    const bTag = tagValue(ev, "b");
    const taskId = tagValue(ev, "d");
    if (!bTag || !taskId) return;
    const lb = boardsRef.current.find((b) => b.nostr?.boardId && boardTag(b.nostr.boardId) === bTag);
    if (!lb || !lb.nostr) return;
    const boardId = lb.nostr.boardId;
    const migrationState = ensureMigrationState(bTag);
    let isDedicated = true;
    try {
      const boardKeys = await deriveBoardNostrKeys(boardId);
      isDedicated = ev.pubkey === boardKeys.pk;
    } catch {
      isDedicated = true;
    }
    if (isDedicated) migrationState.dedicatedSeen = true;
    else {
      migrationState.legacySeen = true;
      if (migrationState.dedicatedSeen) return;
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

    let payload: any = {};
    let taskDecryptedWithLegacyKey = false;
    try {
      const { plaintext, usedLegacyKey } = await decryptFromBoard(boardId, ev.content);
      taskDecryptedWithLegacyKey = usedLegacyKey;
      payload = plaintext ? JSON.parse(plaintext) : {};
    } catch {
      try { payload = ev.content ? JSON.parse(ev.content) : {}; } catch {}
    }
    if (taskDecryptedWithLegacyKey) {
      aesMigrationPendingTasksRef.current.add(taskId);
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
      recurrence: payload.recurrence,
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

        const next = { ...normalizedOld } as Task["bounty"];
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
        return result;
      });
    }, LIVE_BATCH_MS);
  }, [setTasks, settings.newTaskPosition, tagValue, ensureMigrationState]);

  const maybeMigrateBoardToDedicatedKey = useCallback(async (bTag: string) => {
    const state = ensureMigrationState(bTag);
    if (state.dedicatedSeen || state.migrationAttempted || !state.legacySeen) return;
    const board = boardsRef.current.find((b) => b.nostr?.boardId && boardTag(b.nostr.boardId) === bTag);
    if (!board || !board.nostr) return;
    state.migrationAttempted = true;
    try {
      await publishBoardMetadataRef.current?.(board);
      const boardTasks = tasksRef.current.filter((t) => t.boardId === board.id);
      for (const task of boardTasks) {
        await maybePublishTaskRef.current?.(task, board, { skipBoardMetadata: true });
      }
      state.dedicatedSeen = true;
    } catch (err) {
      state.migrationAttempted = false;
      console.warn("Failed to migrate board to dedicated nostr key", err);
    }
  }, [ensureMigrationState]);
  const migrateBoardRef = useRef(maybeMigrateBoardToDedicatedKey);
  useEffect(() => { migrateBoardRef.current = maybeMigrateBoardToDedicatedKey; }, [maybeMigrateBoardToDedicatedKey]);

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
          applicationServerKey,
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
    return ensureWeekRecurrencesForCurrentWeek({
      tasks: arr,
      sources,
      weekStart: settings.weekStart,
      newTaskPosition: settings.newTaskPosition,
      dedupeRecurringInstances,
      isFrequentRecurrence,
      nextOccurrence,
      startOfWeek,
      recurringInstanceId,
      isoDatePart,
      taskDateKey,
      nextOrderForBoard,
      maybePublishTask,
    });
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
    if (!value || typeof value !== "object") return undefined;
    const type = typeof (value as any).type === "string" ? (value as any).type.trim() : "";
    if (type !== "none" && type !== "daily" && type !== "weekly") return undefined;
    if (type === "none") return undefined;
    if (type === "weekly") {
      const rawDays = Array.isArray((value as any).days) ? (value as any).days : [];
      const days = rawDays
        .map((entry) => (typeof entry === "number" && Number.isInteger(entry) ? entry : Number.NaN))
        .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 6) as Weekday[];
      if (!days.length) return undefined;
      const untilISO = normalizeIsoTimestamp((value as any).untilISO);
      return { type: "weekly", days: Array.from(new Set(days)), ...(untilISO ? { untilISO } : {}) };
    }
    const untilISO = normalizeIsoTimestamp((value as any).untilISO);
    return { type: "daily", ...(untilISO ? { untilISO } : {}) };
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
      const hasExplicitVoiceDue = typeof ft.dueISO === "string" && !!ft.dueISO.trim();
      const task: Task = {
        id: crypto.randomUUID(),
        boardId: ft.boardId ?? targetBoardId,
        createdBy: nostrPK || undefined,
        lastEditedBy: nostrPK || undefined,
        title: ft.title.trim(),
        createdAt: Date.now(),
        dueISO: ft.dueISO ?? dueISOBase,
        dueDateEnabled: !!(ft.dueISO || currentBoard.kind === "week"),
        dueTimeEnabled: hasExplicitVoiceDue,
        completed: false,
        order: nextOrder,
      };
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
        };
        return [...prev, nextBoard];
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
            .filter((subtask): subtask is Subtask => !!subtask)
        : undefined;
      const recurrence =
        payload.recurrence && typeof payload.recurrence === "object" && typeof payload.recurrence.type === "string"
          ? (payload.recurrence as Recurrence)
          : undefined;
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
              stageBefore: typeof working.scriptureMemoryStage === "number" ? working.scriptureMemoryStage : working.stage ?? 0,
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
    if (inboxAction && inboxAction.action === "accept") {
      if (inboxAction.item.type === "board") {
        addSharedBoardFromInbox({
          boardId: inboxAction.item.boardId,
          boardName: inboxAction.item.boardName,
          relays: inboxAction.item.relays,
        });
      } else if (inboxAction.item.type === "contact") {
        const added = upsertSharedContact(inboxAction.item.contact);
        if (added) {
          showToast("Contact added to your list");
        } else {
          showToast("Unable to add contact");
        }
      } else if (inboxAction.item.type === "task") {
        const added = addSharedTaskFromInbox(inboxAction.item.task, inboxAction.item.sender);
        if (added) {
          showToast("Task added to your board");
        } else {
          showToast("Unable to add task");
        }
      }
    }
    if (assignmentResponse) {
      void sendTaskAssignmentResponse(assignmentResponse.item, assignmentResponse.status).catch((err) => {
        console.warn("Failed to send task assignment response", err);
      });
      if (assignmentResponse.status === "tentative") {
        showToast("Responded: maybe");
      } else if (assignmentResponse.status === "declined") {
        showToast("Responded: declined");
      }
    }
    if (scheduledUpdate && memoryUpdate) {
      memoryUpdate = { ...memoryUpdate, nextScheduled: scheduledUpdate };
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
    if (!dmEventIds.length) return;
    setTasks((prev) =>
      prev.map((task) => {
        if (task.boardId !== messagesBoardId) return task;
        const dmId = task.inboxItem?.dmEventId?.trim();
        if (!dmId || !dmEventIds.includes(dmId)) return task;
        const status = task.inboxItem?.status;
        if (status === "accepted" || status === "declined" || status === "tentative" || status === "deleted" || status === "read") return task;
        return {
          ...task,
          inboxItem: task.inboxItem ? { ...task.inboxItem, status: "read" } : task.inboxItem,
        };
      }),
    );
  };

  function deleteTask(
    id: string,
    options?: { skipPrompt?: boolean; scope?: "single" | "future" }
  ) {
    const t = tasks.find(x => x.id === id);
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
      const seriesId = t.seriesId || t.id;
      const seriesSeed = t.seriesId ? t : { ...t, seriesId };
      const cutoffDate = startOfDay(new Date(t.dueISO));
      if (Number.isNaN(cutoffDate.getTime())) return;
      const cutoffTime = cutoffDate.getTime();
      const deletedAtISO = new Date().toISOString();
      const nextUntil = new Date(cutoffTime - MS_PER_DAY).toISOString();
      const toPublish: Task[] = [];
      const toDelete: Task[] = [];
      setTasks(prev => {
        let changed = false;
        const next: Task[] = [];
        for (const task of prev) {
          if (!task.recurrence || !sameSeries(task, seriesSeed)) {
            next.push(task);
            continue;
          }
          const dueTime = startOfDay(new Date(task.dueISO)).getTime();
          if (Number.isNaN(dueTime)) {
            next.push(task);
            continue;
          }
          if (dueTime >= cutoffTime) {
            if (task.bounty) {
              const archived = markRecoverableBountyDelete(task, deletedAtISO);
              next.push(archived);
              toPublish.push(archived);
            } else {
              toDelete.push(task);
            }
            changed = true;
            continue;
          }
          const untilTime = task.recurrence.untilISO
            ? startOfDay(new Date(task.recurrence.untilISO)).getTime()
            : null;
          if (!untilTime || untilTime > cutoffTime - MS_PER_DAY) {
            const updated: Task = {
              ...task,
              seriesId: task.seriesId || seriesId,
              recurrence: { ...task.recurrence, untilISO: nextUntil },
            };
            next.push(updated);
            toPublish.push(updated);
            changed = true;
            continue;
          }
          next.push(task);
        }
        return changed ? next : prev;
      });
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
    if (undoTask) { setTasks(prev => [...prev, undoTask]); setUndoTask(null); }
  }



  function restoreTask(id: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const toPublish: Task[] = [];
    const recurringStreak =
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
        const upd: Task = {
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
      const redeemedAmount = res.proofs.reduce((sum, proof) => sum + (proof?.amount || 0), 0);
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

  function saveEdit(updated: Task) {
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
        maybePublishTask(normalizedNext).catch(() => {});
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
        maybePublishTask(normalizedNext).catch(() => {});
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
            toDelete.push(event);
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
    if (activeEventRsvpCoord === canonicalAddr) {
      const next: CalendarRsvpEnvelope = {
        eventId,
        authorPubkey: nostrPK,
        createdAt,
        status,
        ...(options?.fb ? { fb: options.fb } : {}),
        inviteToken,
      };
      const existing = activeEventRsvpMapRef.current.get(next.authorPubkey);
      if (!existing || next.createdAt >= existing.createdAt) {
        activeEventRsvpMapRef.current.set(next.authorPubkey, next);
        setActiveEventRsvps(
          Array.from(activeEventRsvpMapRef.current.values()).sort((a, b) => b.createdAt - a.createdAt),
        );
      }
    }
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
              boardNostrId = board.nostr.boardId;
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
      setCalendarEvents((prev) => prev.filter((event) => event.id !== eventId));
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
      const idx = prev.findIndex((existing) => existing.id === nextEvent.id);
      const existing = idx >= 0 ? prev[idx] : null;
      let merged: CalendarEvent = {
        ...nextEvent,
        ...(existing?.createdBy && !nextEvent.createdBy ? { createdBy: existing.createdBy } : {}),
        ...(existing?.lastEditedBy && !nextEvent.lastEditedBy ? { lastEditedBy: existing.lastEditedBy } : {}),
        ...(Array.isArray(existing?.reminders) && existing.reminders.length ? { reminders: existing.reminders } : {}),
        ...(existing?.reminderTime ? { reminderTime: existing.reminderTime } : {}),
        ...(existing?.recurrence ? { recurrence: existing.recurrence } : {}),
        ...(existing?.seriesId ? { seriesId: existing.seriesId } : {}),
        ...(existing?.hiddenUntilISO ? { hiddenUntilISO: existing.hiddenUntilISO } : {}),
        ...(typeof existing?.order === "number" && typeof nextEvent.order !== "number" ? { order: existing.order } : {}),
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
  }, [setCalendarEvents, settings.weekStart, tagValue]);

  /* ---------- Drag & Drop: move or reorder ---------- */
  function moveTask(
    id: string,
    target:
      | { type: "day"; day: Weekday }
      | { type: "list"; columnId: string },
    beforeId?: string
  ) {
    setTasks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(t => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];
      if (beforeId && beforeId === task.id) return prev;
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
      publishSet.add(updated);

      try {
        publishSet.forEach((t) => { maybePublishTask(t).catch(() => {}); });
      } catch {}

      return arr;
    });
  }

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
      publishSet.add(updated);

      try {
        publishSet.forEach((t) => { maybePublishTask(t).catch(() => {}); });
      } catch {}

      return arr;
    });
  }

  // Subscribe to Nostr for all shared boards
  const nostrBoardsKey = useMemo(() => {
    const items = boards
      .filter(b => b.nostr?.boardId)
      .map(b => ({ id: boardTag(b.nostr!.boardId), relays: getBoardRelays(b).join(",") }))
      .sort((a,b) => (a.id + a.relays).localeCompare(b.id + b.relays));
    return JSON.stringify(items);
  }, [boards, getBoardRelays]);

  useEffect(() => {
    if (!currentBoard?.nostr?.boardId) return;
    setNostrRefresh((n) => n + 1);
  }, [currentBoard?.nostr?.boardId]);

  useEffect(() => {
    let parsed: Array<{id:string; relays:string}> = [];
    try { parsed = JSON.parse(nostrBoardsKey || "[]"); } catch {}
    const unsubs: Array<() => void> = [];
    const syncTimeoutByBoard = new Map<string, number>();
    const clearSyncTimeout = (bTag: string) => {
      const timeoutId = syncTimeoutByBoard.get(bTag);
      if (timeoutId == null) return;
      window.clearTimeout(timeoutId);
      syncTimeoutByBoard.delete(bTag);
    };
    // Mark all boards as syncing (non-blocking — IDB tasks render immediately).
    setPendingNostrInitialSyncByBoardTag((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const item of parsed) {
        if (next[item.id]) continue;
        next[item.id] = true;
        changed = true;
      }
      return changed ? next : prev;
    });

    // Clock-protected merge: apply a relay's batch into current task state.
    // Only updates tasks where the relay has newer data than what's already in state.
    const flushRelayBatch = (bTag: string, relayBatch: Map<string, RelayBatchEntry>) => {
      if (!relayBatch.size) return;
      const bTagClock = nostrIdxRef.current.taskClock.get(bTag);
      setTasks(prev => {
        const merged = new Map(prev.map(t => [`${t.boardId}::${t.id}`, t]));
        for (const [key, entry] of relayBatch) {
          const taskId = key.split('::')[1];
          const incomingNostrAt = '_deleted' in entry ? entry._nostrAt : (entry as Task)._nostrAt ?? bTagClock?.get(taskId) ?? 0;
          const existingNostrAt = (merged.get(key) as Task | undefined)?._nostrAt ?? 0;
          if (incomingNostrAt < existingNostrAt) continue; // IDB/prior relay has newer data
          if ('_deleted' in entry) merged.delete(key);
          else merged.set(key, entry as Task);
        }
        return dedupeRecurringInstances(Array.from(merged.values()));
      });
    };

    for (const it of parsed) {
      const rls = it.relays.split(",").filter(Boolean);
      if (!rls.length) continue;

      // Register this board's pending relays. applyTaskEvent reads this ref to route
      // events into per-relay batches instead of the live path.
      pendingRelaysByBoardRef.current.set(it.id, new Set(rls));

      // Absolute timeout: flush all remaining relay batches for stuck relays.
      const timeoutId = window.setTimeout(() => {
        clearSyncTimeout(it.id);
        const boardBatch = relayBatchRef.current.get(it.id);
        if (boardBatch?.size) {
          const combined = new Map<string, RelayBatchEntry>();
          for (const relayBatch of boardBatch.values()) {
            for (const [key, entry] of relayBatch) {
              const existing = combined.get(key);
              const inAt = '_deleted' in entry ? entry._nostrAt : (entry as Task)._nostrAt ?? 0;
              const exAt = existing ? ('_deleted' in existing ? existing._nostrAt : (existing as Task)._nostrAt ?? 0) : -1;
              if (inAt >= exAt) combined.set(key, entry);
            }
          }
          flushRelayBatch(it.id, combined);
          relayBatchRef.current.delete(it.id);
        }
        pendingRelaysByBoardRef.current.delete(it.id);
        completedNostrInitialSyncRef.current.add(it.id);
        markNostrBoardInitialSyncComplete(it.id);
        try { idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS, JSON.stringify(boardSyncCursorsRef.current)); } catch { /* non-fatal */ }
        setTimeout(() => migrateBoardRef.current(it.id), NOSTR_MIGRATION_BUFFER_MS);
      }, NOSTR_INITIAL_SYNC_TIMEOUT_MS);
      syncTimeoutByBoard.set(it.id, timeoutId);

      pool.setRelays(rls);
      ensureMigrationState(it.id);

      const INITIAL_SYNC_FALLBACK_DAYS = 30;
      const cursor = boardSyncCursorsRef.current[it.id];
      const sinceFilter = cursor
        ? { since: Math.max(0, cursor - NOSTR_CURSOR_LOOKBACK_SECS) }
        : { since: Math.floor(Date.now() / 1000) - INITIAL_SYNC_FALLBACK_DAYS * 24 * 3600 };
      const filters = [
        { kinds: [30300, 30301], "#b": [it.id], ...sinceFilter },
        { kinds: [30300], "#d": [it.id], limit: 1 },
        { kinds: [TASKIFY_CALENDAR_EVENT_KIND], "#b": [it.id], ...sinceFilter },
      ];

      const unsub = pool.subscribe(rls, filters, (ev, evRelay) => {
        // Tag the event with the relay URL so applyTaskEvent can route it to the
        // correct per-relay batch without changing the function signature.
        (ev as any).__relay = evRelay;
        if (ev.kind === 30300) enqueueForBoard(it.id, () => applyBoardEvent(ev)).catch(() => {});
        else if (ev.kind === 30301) enqueueForBoard(it.id, () => applyTaskEvent(ev)).catch(() => {});
        else if (ev.kind === TASKIFY_CALENDAR_EVENT_KIND) enqueueForBoard(it.id, () => applyCalendarEvent(ev)).catch(() => {});
      }, (eoseRelay) => {
        // NDK fires a single subscription-level EOSE (not per-relay), so eoseRelay
        // is typically undefined. When undefined, treat it as "all relays done" and
        // flush every pending relay batch for this board.
        if (!eoseRelay) {
          const boardBatch = relayBatchRef.current.get(it.id);
          if (boardBatch?.size) {
            const combined = new Map<string, RelayBatchEntry>();
            for (const [, relayBatch] of boardBatch) {
              for (const [key, entry] of relayBatch) {
                const existing = combined.get(key);
                const inAt = '_deleted' in entry ? (entry as { _nostrAt?: number })._nostrAt ?? 0 : (entry as Task)._nostrAt ?? 0;
                const exAt = existing ? ('_deleted' in existing ? (existing as { _nostrAt?: number })._nostrAt ?? 0 : (existing as Task)._nostrAt ?? 0) : -1;
                if (!existing || inAt > exAt) combined.set(key, entry);
              }
            }
            relayBatchRef.current.delete(it.id);
            (boardEventQueuesRef.current.get(it.id)?.promise ?? Promise.resolve()).catch(() => {}).then(() => {
              if (combined.size) flushRelayBatch(it.id, combined);
            });
          }
          clearSyncTimeout(it.id);
          pendingRelaysByBoardRef.current.delete(it.id);
          completedNostrInitialSyncRef.current.add(it.id);
          markNostrBoardInitialSyncComplete(it.id);
          try { idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS, JSON.stringify(boardSyncCursorsRef.current)); } catch { /* non-fatal */ }
          setTimeout(() => migrateBoardRef.current(it.id), NOSTR_MIGRATION_BUFFER_MS);
          return;
        }

        // Per-relay EOSE (if NDK ever provides relay URL): merge just that relay's batch.
        const relayUrl = eoseRelay;
        pendingRelaysByBoardRef.current.get(it.id)?.delete(relayUrl);

        const boardBatch = relayBatchRef.current.get(it.id);
        const relayBatch = boardBatch?.get(relayUrl);
        if (relayBatch?.size) {
          boardBatch!.delete(relayUrl);
          (boardEventQueuesRef.current.get(it.id)?.promise ?? Promise.resolve()).catch(() => {}).then(() => {
            flushRelayBatch(it.id, relayBatch!);
          });
        }

        // If all relays done: clear spinner, persist cursor, trigger migration.
        const pendingRelays = pendingRelaysByBoardRef.current.get(it.id);
        if (!pendingRelays?.size) {
          clearSyncTimeout(it.id);
          pendingRelaysByBoardRef.current.delete(it.id);
          completedNostrInitialSyncRef.current.add(it.id);
          markNostrBoardInitialSyncComplete(it.id);
          try { idbKeyValue.setItem(TASKIFY_STORE_TASKS, LS_BOARD_SYNC_CURSORS, JSON.stringify(boardSyncCursorsRef.current)); } catch { /* non-fatal */ }
          setTimeout(() => migrateBoardRef.current(it.id), NOSTR_MIGRATION_BUFFER_MS);
        }
      });
      unsubs.push(unsub);
    }
    return () => {
      unsubs.forEach((u) => u());
      syncTimeoutByBoard.forEach((timeoutId) => window.clearTimeout(timeoutId));
      for (const it of parsed) pendingRelaysByBoardRef.current.delete(it.id);
    };
  }, [
    nostrBoardsKey,
    pool,
    applyBoardEvent,
    applyTaskEvent,
    applyCalendarEvent,
    nostrRefresh,
    ensureMigrationState,
    migrateBoardRef,
    enqueueNostrApply,
    enqueueForBoard,
    markNostrBoardInitialSyncComplete,
  ]);

  // horizontal scroller ref to enable iOS momentum scrolling
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bibleScrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const autoCenteredSet = autoCenteredWeekRef.current;
    const prevActive = activeWeekBoardRef.current;

    if (activePage !== "boards" || view !== "board") {
      if (prevActive) {
        autoCenteredSet.delete(prevActive);
        activeWeekBoardRef.current = null;
      }
      return;
    }

    if (!currentBoardId || currentBoard?.kind !== "week") {
      if (prevActive) {
        autoCenteredSet.delete(prevActive);
        activeWeekBoardRef.current = null;
      }
      return;
    }

    if (prevActive && prevActive !== currentBoardId) {
      autoCenteredSet.delete(prevActive);
    }

    activeWeekBoardRef.current = currentBoardId;
  }, [activePage, currentBoardId, currentBoard?.kind, view]);

  // reset dayChoice when board/view changes and center current day for week boards
  useEffect(() => {
    if (!currentBoard || view !== "board" || activePage !== "boards") return;
    if (currentBoard.kind === "bible") {
      return;
    }
    if (isListLikeBoard(currentBoard)) {
      const valid = typeof dayChoice === "string" && listColumnSources.has(dayChoice);
      if (valid) {
        lastListViewRef.current.set(currentBoard.id, dayChoice);
        return;
      }

      const stored = lastListViewRef.current.get(currentBoard.id);
      const storedValid = stored ? listColumnSources.has(stored) : false;
      const nextChoice =
        (storedValid && stored) ||
        listColumns[0]?.id ||
        (typeof dayChoice === "string" ? dayChoice : undefined);

      if (nextChoice && nextChoice !== dayChoice) {
        setDayChoice(nextChoice);
        lastListViewRef.current.set(currentBoard.id, nextChoice);
      }
    } else {
      const today = new Date().getDay() as Weekday;
      const boardId = currentBoard.id;
      const autoCenteredSet = autoCenteredWeekRef.current;
      const hasCentered = autoCenteredSet.has(boardId);
      const isValidDayChoice = typeof dayChoice === "number" && dayChoice >= 0 && dayChoice <= 6;

      if ((!hasCentered || !isValidDayChoice) && dayChoice !== today) {
        setDayChoice(today);
      }

      if (!hasCentered) {
        requestAnimationFrame(() => {
          const scroller = scrollerRef.current;
          if (!scroller) return;
          const el = scroller.querySelector(`[data-day='${today}']`) as HTMLElement | null;
          if (!el) return;
          const offset = el.offsetLeft - scroller.clientWidth / 2 + el.clientWidth / 2;
          scroller.scrollTo({ left: offset, behavior: "smooth" });
          autoCenteredSet.add(boardId);
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage, currentBoardId, currentBoard?.id, currentBoard?.kind, dayChoice, listColumnSources, listColumns, view]);

  useEffect(() => {
    const board = currentBoard;
    if (view !== "board") return;
    if (!isListLikeBoard(board)) return;
    if (typeof dayChoice !== "string") return;
    if (!listColumnSources.has(dayChoice)) return;
    const prev = lastListViewRef.current.get(board.id);
    if (prev !== dayChoice) {
      lastListViewRef.current.set(board.id, dayChoice);
    }
  }, [currentBoard, dayChoice, listColumnSources, view]);

  useLayoutEffect(() => {
    const board = currentBoard;
    if (view !== "board") return;
    if (!isListLikeBoard(board)) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const boardId = board.id;
    const scrollStore = lastBoardScrollRef.current;
    const stored = scrollStore.has(boardId) ? scrollStore.get(boardId)! : null;
    const shouldCenterIndex = !!board.indexCardEnabled;
    const autoCenteredIndexSet = autoCenteredIndexRef.current;

    const applyInitialScroll = () => {
      const latest = scrollerRef.current;
      if (!latest) return;
      const maxScroll = Math.max(0, latest.scrollWidth - latest.clientWidth);
      if (shouldCenterIndex && !autoCenteredIndexSet.has(boardId)) {
        scrollColumnIntoView("list-index", "auto");
        autoCenteredIndexSet.add(boardId);
        requestAnimationFrame(() => {
          const latest = scrollerRef.current;
          if (!latest) return;
          const maxScroll = Math.max(0, latest.scrollWidth - latest.clientWidth);
          const clamped = Math.min(Math.max(latest.scrollLeft, 0), maxScroll);
          scrollStore.set(boardId, clamped);
        });
        nudgeHorizontalScroller(latest);
        return;
      }
      const target = stored == null ? 0 : Math.min(Math.max(stored, 0), maxScroll);
      if (Math.abs(latest.scrollLeft - target) > 1) {
        latest.scrollTo({ left: target, behavior: "auto" });
      } else {
        latest.scrollLeft = target;
      }
      nudgeHorizontalScroller(latest);
    };

    applyInitialScroll();
    const raf = requestAnimationFrame(applyInitialScroll);
    let timeout: number | undefined;
    if (typeof window !== "undefined") {
      timeout = window.setTimeout(applyInitialScroll, 150);
    }
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        applyInitialScroll();
      });
      resizeObserver.observe(scroller);
    }

    const handleScroll = () => {
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      if (typeof timeout === "number") {
        window.clearTimeout(timeout);
      }
      resizeObserver?.disconnect();
      cancelAnimationFrame(raf);
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
      if (!board.indexCardEnabled) {
        autoCenteredIndexSet.delete(boardId);
      }
      scroller.removeEventListener("scroll", handleScroll);
    };
  }, [currentBoard, scrollColumnIntoView, view]);

  useLayoutEffect(() => {
    if (currentBoard?.kind !== "bible") return;
    if (view === "completed") return;
    const scroller = bibleScrollerRef.current;
    if (!scroller) return;

    const boardId = currentBoard.id;
    const scrollStore = lastBoardScrollRef.current;
    const stored = scrollStore.get(boardId) ?? 0;

    const applyStoredScroll = () => {
      const latest = bibleScrollerRef.current;
      if (!latest) return;
      const maxScroll = Math.max(0, latest.scrollWidth - latest.clientWidth);
      const target = Math.min(Math.max(stored, 0), maxScroll);
      if (Math.abs(latest.scrollLeft - target) > 1) {
        latest.scrollTo({ left: target, behavior: "auto" });
      } else {
        latest.scrollLeft = target;
      }
    };

    applyStoredScroll();
    const raf = requestAnimationFrame(applyStoredScroll);
    let timeout: number | undefined;
    if (typeof window !== "undefined") {
      timeout = window.setTimeout(applyStoredScroll, 150);
    }

    const handleScroll = () => {
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      if (typeof timeout === "number") {
        window.clearTimeout(timeout);
      }
      cancelAnimationFrame(raf);
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
      scroller.removeEventListener("scroll", handleScroll);
    };
  }, [currentBoard?.id, currentBoard?.kind, view]);

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

  return (
    <div className="min-h-screen text-primary">
      <div className="app-shell mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {(activePage === "boards" || activePage === "upcoming" || activePage === "wallet-bounties" || activePage === "settings") && (
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
                                      moveTaskToBoard(draggingTaskId, b.id);
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
            {activePage === "settings" && <div className="app-header__title">Settings</div>}
          </header>
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
                className="flex-1 min-h-0 overflow-x-auto pb-0 w-full"
                style={{ WebkitOverflowScrolling: "touch" }} // fluid momentum scroll on iOS
              >
                <div className="flex gap-4 min-w-max h-full items-stretch">
                  {Array.from({ length: 7 }, (_, i) => i as Weekday).map((day) => (
                    <DroppableColumn
                      ref={el => setColumnRef(`week-day-${day}`, el)}
                      key={day}
                      title={WD_SHORT[day]}
                    onTitleClick={() => setDayChoice(day)}
                    onDropCard={(payload) => moveTask(payload.id, { type: "day", day }, payload.beforeId)}
                    onDropEnd={handleDragEnd}
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
		                            showDate={false}
		                            onOpenDocument={(_event, doc) => handleOpenEventDocument(doc)}
		                            onEdit={() => setEditing({ type: "event", originalType: "event", originalId: ev.id, event: ev })}
		                            onDragStart={(id) => setDraggingEventId(id)}
		                            onDragEnd={handleDragEnd}
		                          />
	                        ))}
	                        {(byDay.get(day) || []).map((t) => (
	                        <Card
	                          key={t.id}
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
                className="flex-1 min-h-0 overflow-x-auto pb-0 w-full"
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
                      onDropCard={(payload) => moveTask(payload.id, { type: "list", columnId: col.id }, payload.beforeId)}
                      onDropEnd={handleDragEnd}
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
		                          showDate
		                          onOpenDocument={(_event, doc) => handleOpenEventDocument(doc)}
		                          onEdit={() => setEditing({ type: "event", originalType: "event", originalId: ev.id, event: ev })}
		                          onDragStart={(id) => setDraggingEventId(id)}
		                          onDragEnd={handleDragEnd}
		                        />
	                      ))}
	                      {(itemsByColumn.get(col.id) || []).map((t) => (
	                        <Card
	                          key={t.id}
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
          <div className="surface-panel board-column p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="text-lg font-semibold">Upcoming</div>
            </div>
            {boardUpcomingCount === 0 ? (
              <div className="text-secondary text-sm">No upcoming items on this board.</div>
            ) : (
              <div className="upcoming-list space-y-4">
                {boardUpcomingGroups.map((group) => (
                  <div key={group.dateKey} className="upcoming-day" data-upcoming-date={group.dateKey}>
                    <div className="upcoming-day__label">{group.label}</div>
                    <div className="space-y-2">
                      {group.events.map((ev) => renderUpcomingEventCard(ev))}
                      {group.tasks.map((task) => renderUpcomingTaskCard(task))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          // Completed view
          <div className="surface-panel board-column p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="text-lg font-semibold">Completed</div>
              {currentBoard?.kind !== "bible" && !currentBoard?.clearCompletedDisabled && (
                <div className="ml-auto">
                  <button
                    className="ghost-button button-sm pressable text-rose-400"
                    onClick={clearCompleted}
                  >
                    Clear completed
                  </button>
                </div>
              )}
            </div>
            {currentBoard?.kind === "bible" ? (
              completedBibleBooks.length === 0 ? (
                <div className="text-secondary text-sm">No completed books yet.</div>
              ) : (
                <ul className="space-y-1.5">
                  {completedBibleBooks.map((book) => (
                    <li
                      key={book.id}
                      className="task-card space-y-2"
                      data-state="completed"
                      data-form="pill"
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <div className="text-sm font-medium leading-[1.15]">{book.name}</div>
                          <div className="text-xs text-secondary">
                            {book.completedAtISO
                              ? `Completed ${new Date(book.completedAtISO).toLocaleString()}`
                              : "Completed book"}
                          </div>
                        </div>
                        <IconButton label="Restore" onClick={() => handleRestoreBibleBook(book.id)} intent="success">
                          ↩︎
                        </IconButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : completed.length === 0 ? (
              <div className="text-secondary text-sm">No completed tasks yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {completed.map((t) => {
                  const recoverableBounty = isRecoverableBountyTask(t);
                  const hasDetail =
                    !!t.note?.trim() ||
                    (t.images && t.images.length > 0) ||
                    (t.documents && t.documents.length > 0) ||
                    (t.subtasks && t.subtasks.length > 0) ||
                    !!t.bounty;
                  const scheduledWeekday = taskWeekday(t) ?? (new Date().getDay() as Weekday);
                  const scheduledDayLabel = WD_SHORT[scheduledWeekday];
                  const scheduledTimeLabel = t.dueTimeEnabled
                    ? ` at ${formatTimeLabel(t.dueISO, t.dueTimeZone)}`
                    : "";
                  const bountyLabel = t.bounty ? bountyStateLabel(t.bounty) : "";
                  return (
                    <li key={t.id} className="task-card space-y-2" data-state="completed" data-form={hasDetail ? 'stacked' : 'pill'}>
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <div className="text-sm font-medium leading-[1.15]">
                            <TaskTitle key={`${t.id}:${t.priority ?? "none"}`} task={t} />
                          </div>
                          <div className="text-xs text-secondary">
                            {currentBoard?.kind === "week"
                              ? `Scheduled ${scheduledDayLabel}${scheduledTimeLabel}`
                              : "Completed item"}
                            {t.completedAt ? ` • Completed ${new Date(t.completedAt).toLocaleString()}` : ""}
                            {settings.streaksEnabled &&
                              t.recurrence &&
                              isFrequentRecurrence(t.recurrence) &&
                              typeof t.streak === "number" && t.streak > 0
                                ? ` • 🔥 ${t.streak}`
                                : ""}
                            {recoverableBounty ? " • Recoverable bounty task" : ""}
                          </div>
                          <TaskMedia task={t} onOpenDocument={handleOpenDocument} />
                          {t.inboxItem && (
                            <div className="mt-1 text-xs text-secondary">
                              Shared {t.inboxItem.type === "board" ? "board" : t.inboxItem.type === "contact" ? "contact" : "task"} •{" "}
                              {t.inboxItem.status === "accepted"
                                ? "Added"
                                : t.inboxItem.status === "tentative"
                                  ? "Maybe"
                                  : t.inboxItem.status === "declined"
                                    ? "Declined"
                                    : t.inboxItem.status === "deleted"
                                      ? "Dismissed"
                                      : "Pending"}
                            </div>
                          )}
                          {t.subtasks?.length ? (
                            <ul className="mt-1 space-y-1 text-xs">
                              {t.subtasks.map(st => (
                                <li key={st.id} className="subtask-row">
                                  <input type="checkbox" checked={!!st.completed} disabled className="subtask-row__checkbox" />
                                  <span className={`subtask-row__text ${st.completed ? 'line-through text-secondary' : ''}`}>{st.title}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {t.bounty && (
                            <div className="mt-1">
                              <span className={`text-[0.6875rem] px-2 py-0.5 rounded-full border ${t.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : t.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : t.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-surface-muted border-surface'}`}>
                                Bounty {typeof t.bounty.amount==='number' ? `• ${t.bounty.amount} sats` : ''} • {bountyLabel}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <IconButton label={recoverableBounty ? "Recover" : "Restore"} onClick={() => restoreTask(t.id)} intent="success">↩︎</IconButton>
                          {!recoverableBounty && (
                            <IconButton label="Delete" onClick={() => deleteTask(t.id)} intent="danger">✕</IconButton>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        </div>
      )}
      {activePage === "upcoming" && (
        <>
          {showUpcomingSearch && (
            <div className="upcoming-search">
              <div className="upcoming-search__field">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="upcoming-search__icon"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" />
                  <line x1="16.65" y1="16.65" x2="21" y2="21" />
                </svg>
                <input
                  ref={upcomingSearchInputRef}
                  type="search"
                  className="upcoming-search__input"
                  placeholder="Search title or notes"
                  value={upcomingSearch}
                  onChange={(event) => setUpcomingSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeUpcomingSearch();
                    }
                  }}
                  aria-label="Search tasks by title or notes"
                />
                <button
                  type="button"
                  className="upcoming-search__clear pressable"
                  onClick={closeUpcomingSearch}
                  aria-label={upcomingSearch ? "Clear search" : "Close search"}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
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
	          <div className="upcoming-list space-y-4" ref={upcomingListRef}>
	            {upcomingGroups.map((group) => (
	              <div key={group.dateKey} className="upcoming-day" data-upcoming-date={group.dateKey}>
	                <div className="upcoming-day__label">{group.label}</div>
	                <div className="space-y-2">
	                  {group.events.map((ev) => renderUpcomingEventCard(ev))}
	                  {group.tasks.map((task) => renderUpcomingTaskCard(task))}
	                </div>
	              </div>
	            ))}
	          </div>
	        )}
        </>
      )}
      {activePage === "wallet-bounties" && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="wallet-section space-y-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={walletBountiesTab === "pinned" ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
                onClick={() => setWalletBountiesTab("pinned")}
              >
                Pinned
              </button>
              <button
                type="button"
                className={walletBountiesTab === "funded" ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
                onClick={() => setWalletBountiesTab("funded")}
              >
                Funded
              </button>
              <button
                type="button"
                className={walletBountiesTab === "open" ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
                onClick={() => setWalletBountiesTab("open")}
              >
                Open
              </button>
            </div>
            <div className="text-xs text-secondary">
              {walletBountiesTab === "open"
                ? "All tasks with an active bounty."
                : walletBountiesTab === "funded"
                  ? "Tasks where you funded the bounty."
                  : "Tasks you pinned for quick access."}
            </div>
          </div>
          <div className="surface-panel board-column p-4">
            {walletBountiesVisibleTasks.length === 0 ? (
              <div className="text-sm text-secondary">
                No {walletBountiesTab === "open" ? "open bounties" : walletBountiesTab === "funded" ? "funded bounties" : "pinned tasks"} yet.
              </div>
            ) : (
              <ul className="space-y-2">
                {walletBountiesVisibleTasks.map((task) => {
                  const boardName = boardMap.get(task.boardId)?.name || "Board";
                  const bounty = task.bounty;
                  const creatorNpub = toNpub(task.createdBy || "");
                  const lastEditorNpub = toNpub(task.lastEditedBy || task.completedBy || task.createdBy || "");
                  const parsedDue = new Date(task.dueISO);
                  const dueLabel = Number.isNaN(parsedDue.getTime())
                    ? ""
                    : parsedDue.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
                  const amountLabel =
                    bounty && typeof bounty.amount === "number"
                      ? `${bounty.amount} sats`
                      : "Amount unknown";
                  return (
                    <li
                      key={task.id}
                      className="task-card space-y-2"
                      data-form="stacked"
                      data-agent-entity="task"
                      data-agent-creator-npub={creatorNpub || undefined}
                      data-agent-last-editor-npub={lastEditorNpub || undefined}
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium leading-[1.2]">
                            <TaskTitle key={`${task.id}:${task.priority ?? "none"}`} task={task} />
                          </div>
                          <div className="text-xs text-secondary">
                            {boardName}
                            {dueLabel ? ` • ${dueLabel}` : ""}
                          </div>
                          {bounty ? (
                            <div className="mt-1 text-xs text-secondary">
                              {amountLabel} • {bountyStateLabel(bounty)}
                            </div>
                          ) : (
                            <div className="mt-1 text-xs text-secondary">No bounty attached yet.</div>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1 justify-end">
                          <button
                            type="button"
                            className="ghost-button button-sm pressable"
                            onClick={() => setEditing({ type: "task", originalType: "task", originalId: task.id, task })}
                          >
                            Open task
                          </button>
                          <button
                            type="button"
                            className="ghost-button button-sm pressable"
                            onClick={() => {
                              if (taskHasBountyList(task, PINNED_BOUNTY_LIST_KEY)) {
                                removeTaskFromBountyList(task.id);
                              } else {
                                addTaskToBountyList(task.id);
                              }
                            }}
                          >
                            {taskHasBountyList(task, PINNED_BOUNTY_LIST_KEY) ? "Unpin" : "Pin"}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
      {activePage === "settings" && (
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
          onClose={closeSettings}
          gcalStatus={gcalStatus}
          gcalCalendars={gcalCalendars}
          gcalLoading={gcalLoading}
          onGcalConnect={gcalConnect}
          onGcalDisconnect={gcalDisconnect}
          onGcalToggleCalendar={gcalToggleCalendar}
          onGcalSync={gcalSync}
        />
      )}
      </div>

      {activePage === "upcoming" && (
        <div className="upcoming-controls">
          <div className="upcoming-controls__left">
            <button
              type="button"
              className="upcoming-controls__today pressable"
              onClick={handleUpcomingToday}
              disabled={upcomingView === "details" && upcomingGroups.length === 0}
              title="Jump to today"
              aria-label="Jump to today"
            >
              Today
            </button>
          </div>
          <div className="upcoming-controls__right">
            <button
              type="button"
              className="app-header__icon-btn pressable"
              onClick={() => setUpcomingFilterOpen(true)}
              title={`Filter upcoming tasks (${upcomingFilterLabel})`}
              aria-label={`Filter upcoming tasks (${upcomingFilterLabel})`}
              data-active={upcomingFilter !== null || upcomingFilterOpen}
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
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
                <circle cx="9" cy="6" r="2" />
                <circle cx="15" cy="12" r="2" />
                <circle cx="11" cy="18" r="2" />
              </svg>
            </button>
            <button
              type="button"
              className="app-header__icon-btn pressable"
              onClick={() => setInboxOpen(true)}
              title="Inbox"
              aria-label={`Inbox${inboxPendingCount ? ` (${inboxPendingCount})` : ""}`}
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
                <path d="M4 4h16v12H4z" />
                <path d="M4 12l4 4h8l4-4" />
              </svg>
              {inboxPendingCount > 0 && (
                <span className="app-header__badge">{inboxPendingCount}</span>
              )}
            </button>
          </div>
        </div>
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
            <div className="app-tab-switcher__icon app-tab-switcher__icon--badge">
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
              {inboxPendingCount > 0 && (
                <span className="app-tab-switcher__badge">{inboxPendingCount}</span>
              )}
            </div>
            <div className="app-tab-switcher__label">Upcoming</div>
          </button>
          <button
            ref={walletButtonRef}
            type="button"
            className={`app-tab-switcher__btn pressable${activePage === "wallet" || activePage === "wallet-bounties" ? " app-tab-switcher__btn--active" : ""}`}
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
            className={`app-tab-switcher__btn pressable${activePage === "contacts" ? " app-tab-switcher__btn--active" : ""}`}
            onClick={openContactsPage}
            aria-label="Contacts"
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
                <path d="M16 14c2.2 0 4 1.8 4 4v2H4v-2c0-2.2 1.8-4 4-4" />
                <circle cx="12" cy="8" r="4" />
              </svg>
            </div>
            <div className="app-tab-switcher__label">Contacts</div>
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

      <ActionSheet
        open={boardSortSheetOpen}
        onClose={() => setBoardSortSheetOpen(false)}
        title="Filter and sort"
      >
        <div className="wallet-section space-y-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-secondary">Sort tasks by</div>
          <div className="flex flex-wrap gap-2">
            {boardSortOptions.map((option) => {
              const active = boardSort.mode === option.id;
              const cls = active ? "accent-button button-sm pressable" : "ghost-button button-sm pressable";
              const showArrow = active && option.supportsDirection;
              const invertArrow = option.id === "due" || option.id === "alpha";
              const arrow =
                boardSort.direction === "asc"
                  ? (invertArrow ? "↓" : "↑")
                  : (invertArrow ? "↑" : "↓");
              return (
                <button
                  key={option.id}
                  type="button"
                  className={cls}
                  onClick={() => handleBoardSortSelect(option.id)}
                >
                  <span>{option.label}</span>
                  {showArrow && <span className="ml-1 text-xs">{arrow}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </ActionSheet>

      <ActionSheet
        open={upcomingSortSheetOpen}
        onClose={() => setUpcomingSortSheetOpen(false)}
        title="Sort"
      >
        <div className="wallet-section space-y-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-secondary">Sort tasks by</div>
          <div className="flex flex-wrap gap-2">
            {boardSortOptions.map((option) => {
              const active = upcomingSort.mode === option.id;
              const cls = active ? "accent-button button-sm pressable" : "ghost-button button-sm pressable";
              const showArrow = active && option.supportsDirection;
              const invertArrow = option.id === "due" || option.id === "alpha";
              const arrow =
                upcomingSort.direction === "asc"
                  ? (invertArrow ? "↓" : "↑")
                  : (invertArrow ? "↑" : "↓");
              return (
                <button
                  key={option.id}
                  type="button"
                  className={cls}
                  onClick={() => handleUpcomingSortSelect(option.id)}
                  aria-pressed={active}
                >
                  <span>{option.label}</span>
                  {showArrow && <span className="ml-1 text-xs">{arrow}</span>}
                </button>
              );
            })}
          </div>
          <div className="text-xs uppercase tracking-wide text-secondary">Boards</div>
          <div className="flex flex-wrap gap-2">
            {upcomingBoardGroupingOptions.map((option) => {
              const active = upcomingBoardGrouping === option.id;
              const cls = active ? "accent-button button-sm pressable" : "ghost-button button-sm pressable";
              return (
                <button
                  key={option.id}
                  type="button"
                  className={cls}
                  onClick={() => setUpcomingBoardGrouping(option.id)}
                  aria-pressed={active}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </ActionSheet>

      <ActionSheet
        open={upcomingViewSheetOpen}
        onClose={() => setUpcomingViewSheetOpen(false)}
        title="View"
      >
        <div className="overflow-hidden rounded-2xl border border-border bg-elevated">
          {[
            { id: "details", label: "Details" },
            { id: "list", label: "List" },
          ].map((option) => {
            const active = upcomingView === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface"
	                onClick={() => {
	                  handleUpcomingViewChange(option.id as "details" | "list");
	                }}
	                aria-pressed={active}
	              >
                <div className="flex-1">
                  <div className="text-sm font-medium text-primary">{option.label}</div>
                </div>
                {active && <span className="text-accent text-sm font-semibold">✓</span>}
              </button>
            );
          })}
        </div>
      </ActionSheet>

      <ActionSheet
        open={upcomingFilterOpen}
        onClose={() => setUpcomingFilterOpen(false)}
        title="Calendars"
        panelClassName="sheet-panel--tall"
      >
        <div className="upcoming-filter">
          <div className="upcoming-filter__controls">
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                setUpcomingFilter(null);
                setUpcomingUsHolidaysEnabled(true);
              }}
            >
              Select all
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                setUpcomingFilter([]);
                setUpcomingUsHolidaysEnabled(false);
              }}
            >
              Clear all
            </button>
            {upcomingFilterPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="ghost-button button-sm pressable"
                onClick={(e) => {
                  if (upcomingPresetHoldTriggeredRef.current) {
                    upcomingPresetHoldTriggeredRef.current = false;
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                  }
                  applyUpcomingFilterPreset(preset);
                }}
                onPointerDown={(e) => startUpcomingPresetHold(preset, e)}
                onPointerUp={cancelUpcomingPresetHold}
                onPointerCancel={cancelUpcomingPresetHold}
                onPointerLeave={cancelUpcomingPresetHold}
                onPointerMove={maybeCancelUpcomingPresetHold}
                onContextMenu={(e) => e.preventDefault()}
                title="Press and hold to delete"
              >
                {preset.name}
              </button>
            ))}
          </div>
          <div className="upcoming-filter__list">
            {upcomingFilterGroups.length === 0 ? (
              <div className="text-sm text-secondary">No boards yet.</div>
            ) : (
              upcomingFilterGroups.map((group) => (
                <div key={group.id} className="upcoming-filter__group">
                  <button
                    type="button"
                    className="upcoming-filter__row pressable"
                    onClick={() => toggleUpcomingFilter(group.boardOption.id)}
                    role="checkbox"
                    aria-checked={upcomingFilterSelection.has(group.boardOption.id)}
                  >
                    <span
                      className={`upcoming-filter__check${upcomingFilterSelection.has(group.boardOption.id) ? " is-checked" : ""}`}
                      aria-hidden="true"
                    >
                      {upcomingFilterSelection.has(group.boardOption.id) && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12l4 4 10-10" />
                        </svg>
                      )}
                    </span>
                    <span className="upcoming-filter__label">{group.label}</span>
                  </button>
                  {group.listOptions.length > 0 && (
                    <div className="upcoming-filter__sublist">
                      {group.listOptions.map((option) => {
                        const checked = upcomingFilterSelection.has(option.id);
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className="upcoming-filter__row upcoming-filter__row--child pressable"
                            onClick={() => toggleUpcomingFilter(option.id)}
                            role="checkbox"
                            aria-checked={checked}
                          >
                            <span
                              className={`upcoming-filter__check${checked ? " is-checked" : ""}`}
                              aria-hidden="true"
                            >
                              {checked && (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M5 12l4 4 10-10" />
                                </svg>
                              )}
                            </span>
                            <span className="upcoming-filter__label">{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
            <div className="upcoming-filter__group">
              <button
                type="button"
                className="upcoming-filter__row pressable"
                onClick={() => setUpcomingUsHolidaysEnabled((prev) => !prev)}
                role="checkbox"
                aria-checked={upcomingUsHolidaysEnabled}
              >
                <span
                  className={`upcoming-filter__check${upcomingUsHolidaysEnabled ? " is-checked" : ""}`}
                  aria-hidden="true"
                >
                  {upcomingUsHolidaysEnabled && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12l4 4 10-10" />
                    </svg>
                  )}
                </span>
                <span className="upcoming-filter__label">{SPECIAL_CALENDAR_US_HOLIDAYS_LABEL}</span>
              </button>
            </div>
            {gcalStatus.connected && gcalCalendars.map((cal) => {
              const boardId = `gcal:${cal.id}`;
              const isSelected = upcomingFilter === null || upcomingFilter.includes(boardId);
              return (
                <div key={cal.id} className="upcoming-filter__group">
                  <button
                    type="button"
                    className="upcoming-filter__row pressable"
                    onClick={() => {
                      if (upcomingFilter === null) {
                        // Deselect just this calendar
                        const allIds = upcomingFilterOptions.map((o) => o.id);
                        setUpcomingFilter(allIds.filter((id) => id !== boardId));
                      } else if (isSelected) {
                        setUpcomingFilter(upcomingFilter.filter((id) => id !== boardId));
                      } else {
                        setUpcomingFilter([...upcomingFilter, boardId]);
                      }
                    }}
                    role="checkbox"
                    aria-checked={isSelected}
                  >
                    <span
                      className={`upcoming-filter__check${isSelected ? " is-checked" : ""}`}
                      aria-hidden="true"
                    >
                      {isSelected && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12l4 4 10-10" />
                        </svg>
                      )}
                    </span>
                    <span className="upcoming-filter__label">
                      {cal.color && (
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-1.5"
                          style={{ backgroundColor: cal.color, verticalAlign: "middle" }}
                        />
                      )}
                      {cal.name}
                    </span>
                  </button>
                </div>
              );
            })}
            <div>
              <button
                type="button"
                className="ghost-button button-sm pressable"
                onClick={saveUpcomingFilterPreset}
              >
                Save as preset
              </button>
            </div>
          </div>
        </div>
      </ActionSheet>

      <ActionSheet open={inboxOpen} onClose={() => setInboxOpen(false)} title="Inbox">
        {inboxPendingItems.length === 0 && pendingCalendarInvites.length === 0 ? (
          <div className="text-sm text-secondary">No shared items.</div>
        ) : (
          <div className="space-y-4">
            {pendingCalendarInvites.length > 0 && (
              <div>
                <div className="text-xs text-secondary mb-2">Event invites</div>
                <ul className="space-y-2">
                  {pendingCalendarInvites.map((invite) => {
                    const senderName =
                      invite.sender?.name ||
                      invite.sender?.npub ||
                      (invite.sender?.pubkey ? shortenNpub(toNpub(invite.sender.pubkey)) : "Someone");
                    const whenLabel = formatCalendarInviteWhen(invite);
                    return (
                      <li key={invite.id} className="task-card space-y-2" data-form="stacked">
                        <div className="flex items-start gap-2">
                          <div className="flex-1">
                            <div className="text-sm font-medium leading-[1.15]">{invite.title || "Event invite"}</div>
                            <div className="text-xs text-secondary">
                              {whenLabel ? `${whenLabel} • ` : ""}From {senderName}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="accent-button button-sm pressable"
                            onClick={() => void handleCalendarInviteRsvp(invite, "accepted")}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            className="ghost-button button-sm pressable"
                            onClick={() => void handleCalendarInviteRsvp(invite, "tentative")}
                          >
                            Tentative
                          </button>
                          <button
                            type="button"
                            className="ghost-button button-sm pressable text-rose-400"
                            onClick={() => void handleCalendarInviteRsvp(invite, "declined")}
                          >
                            Decline
                          </button>
                          <button
                            type="button"
                            className="ghost-button button-sm pressable"
                            onClick={() => dismissCalendarInvite(invite)}
                          >
                            Dismiss
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {inboxPendingItems.length > 0 && (
              <div>
                <div className="text-xs text-secondary mb-2">Shared items</div>
                <ul className="space-y-2">
                  {inboxPendingItems.map((item) => {
                    const senderName = item.sender?.name || item.sender?.npub || "Someone";
                    const isTaskAssignment = item.type === "task" && isAssignedSharedTask(item.task);
                    const typeLabel =
                      item.type === "board"
                        ? `Board • ${item.boardName || "Shared board"}`
                        : item.type === "contact"
                          ? "Contact"
                          : isTaskAssignment
                            ? "Task assignment"
                            : "Task";
                    return (
                      <li key={item.id} className="task-card space-y-2" data-form="stacked">
                        <div className="flex items-start gap-2">
                          <div className="flex-1">
                            <div className="text-sm font-medium leading-[1.15]">{item.title}</div>
                            <div className="text-xs text-secondary">
                              {typeLabel} • From {senderName}
                            </div>
                            {item.note && (
                              <div className="text-xs text-secondary whitespace-pre-wrap">{item.note}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {isTaskAssignment ? (
                            <>
                              <button
                                type="button"
                                className="accent-button button-sm pressable"
                                onClick={() => acceptInboxMessage(item.id)}
                              >
                                Accept
                              </button>
                              <button
                                type="button"
                                className="ghost-button button-sm pressable"
                                onClick={() => maybeInboxMessage(item.id)}
                              >
                                Maybe
                              </button>
                              <button
                                type="button"
                                className="ghost-button button-sm pressable text-rose-400"
                                onClick={() => declineInboxMessage(item.id)}
                              >
                                Decline
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="accent-button button-sm pressable"
                                onClick={() => acceptInboxMessage(item.id)}
                              >
                                Add
                              </button>
                              <button
                                type="button"
                                className="ghost-button button-sm pressable text-rose-400"
                                onClick={() => dismissInboxMessage(item.id)}
                              >
                                Dismiss
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </ActionSheet>

      {/* Drag trash can */}
      {(draggingTaskId || draggingEventId) && (
        <div
          className="fixed bottom-4 left-4 z-50"
          onDragOver={(e) => {
            e.preventDefault();
            setTrashHover(true);
          }}
          onDragLeave={() => setTrashHover(false)}
          onDrop={(e) => {
            e.preventDefault();
            const taskId = getDraggedTaskId(e.dataTransfer);
            if (taskId) {
              deleteTask(taskId);
            } else {
              const eventId = getDraggedEventId(e.dataTransfer);
              if (eventId) deleteCalendarEvent(eventId);
            }
            handleDragEnd();
          }}
        >
          <div
            className={`w-14 h-14 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-secondary transition-transform ${trashHover ? 'scale-110' : ''}`}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="pointer-events-none"
            >
              <path d="M9 3h6l1 1h5v2H3V4h5l1-1z" />
              <path d="M5 7h14l-1.5 13h-11L5 7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Undo Snackbar */}
      {undoTask && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bg-surface-muted border border-surface text-sm px-4 py-2 rounded-xl shadow-lg flex items-center gap-3 z-[9999]"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--app-tab-pill-offset) + 0.75rem)" }}
        >
          Task deleted
          <button onClick={undoDelete} className="accent-button button-sm pressable">Undo</button>
        </div>
      )}

      {recurringDeleteTask && (
        <Modal onClose={() => setRecurringDeleteTask(null)} title="Delete recurring task">
          <div className="space-y-4">
            <div className="text-sm text-secondary">
              This task repeats. Do you want to delete just this event or all future events in the series?
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="ghost-button button-sm pressable"
                onClick={() => {
                  deleteTask(recurringDeleteTask.id, { skipPrompt: true });
                  setRecurringDeleteTask(null);
                }}
              >
                Delete this event
              </button>
              <button
                className="ghost-button button-sm pressable text-rose-400"
                onClick={() => {
                  deleteTask(recurringDeleteTask.id, { skipPrompt: true, scope: "future" });
                  setRecurringDeleteTask(null);
                }}
              >
                Delete all future
              </button>
            </div>
          </div>
        </Modal>
      )}

      {recurringDeleteEvent && (
        <Modal onClose={() => setRecurringDeleteEvent(null)} title="Delete recurring event">
          <div className="space-y-4">
            <div className="text-sm text-secondary">
              This event repeats. Do you want to delete just this event or all future events in the series?
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="ghost-button button-sm pressable"
                onClick={() => {
                  deleteCalendarEvent(recurringDeleteEvent.id, { skipPrompt: true });
                  setRecurringDeleteEvent(null);
                }}
              >
                Delete this event
              </button>
              <button
                className="ghost-button button-sm pressable text-rose-400"
                onClick={() => {
                  deleteCalendarEvent(recurringDeleteEvent.id, { skipPrompt: true, scope: "future" });
                  setRecurringDeleteEvent(null);
                }}
              >
                Delete all future
              </button>
            </div>
          </div>
        </Modal>
      )}

      {updateToastVisible && (
        <div className="fixed bottom-4 left-1/2 z-[10001] w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
          <div className="rounded-xl border border-neutral-700 bg-neutral-900/95 p-4 text-sm text-white shadow-lg">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="text-base font-semibold">Update available</div>
                <div className="text-xs text-neutral-300">
                  Reload to get the latest Taskify features.
                </div>
              </div>
              <div className="flex gap-2 sm:shrink-0">
                <button
                  className="ghost-button button-sm pressable"
                  onClick={handleReloadLater}
                >
                  Later
                </button>
                <button
                  className="accent-button button-sm pressable"
                  onClick={handleReloadNow}
                >
                  Reload
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modals */}
      {editing?.type === "task" && (
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
        />
      )}

      {editing?.type === "event" && (
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
	          onPreviewDocument={(_event, doc) => handleOpenEventDocument(doc)}
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
      )}

      {previewDocument && (
        <DocumentPreviewModal
          document={previewDocument}
          onClose={() => setPreviewDocument(null)}
          onDownloadDocument={handleDownloadDocument}
          onOpenExternal={openDocumentExternally}
        />
      )}

      {biblePrintPortal && biblePrintOpen && biblePrintMeta &&
        createPortal(
          <BibleTrackerPrintPreview
            state={bibleTracker}
            meta={biblePrintMeta}
            paperSize={biblePrintPaperSize}
            onPaperSizeChange={handleBiblePaperSizeChange}
          />,
          biblePrintPortal
        )}

      {biblePrintOpen && biblePrintMeta && (
        <Modal
          onClose={() => setBiblePrintOpen(false)}
          title="Print Bible tracker"
          actions={(
            <>
              <button
                className="accent-button button-sm pressable"
                onClick={handleExportBiblePdf}
                disabled={biblePrintPdfBusy}
              >
                {biblePrintPdfBusy ? "Preparing PDF..." : "Export PDF"}
              </button>
              <button
                className="ghost-button button-sm pressable"
                onClick={handlePrintBibleWindow}
              >
                Print
              </button>
            </>
          )}
        >
          <BibleTrackerPrintPreview
            state={bibleTracker}
            meta={biblePrintMeta}
            paperSize={biblePrintPaperSize}
            onPaperSizeChange={handleBiblePaperSizeChange}
          />
        </Modal>
      )}

      {bibleScanOpen && (
        <Modal onClose={() => setBibleScanOpen(false)} title="Scan Bible tracker">
          <BibleTrackerScanPanel
            state={bibleTracker}
            onApply={handleApplyBibleScan}
            paperSize={biblePrintPaperSize}
            onPaperSizeChange={handleBiblePaperSizeChange}
          />
        </Modal>
      )}

      {boardPrintPortal && boardPrintOpen && boardPrintJob &&
        createPortal(
          <BoardPrintPreview
            job={boardPrintJob}
            paperSize={boardPrintJob.paperSize}
            onPaperSizeChange={handleBoardPaperSizeChange}
          />,
          boardPrintPortal
        )}

      {boardPrintOpen && boardPrintJob && (
        <Modal
          onClose={() => setBoardPrintOpen(false)}
          title={`Print ${boardPrintJob.boardName || "board"}`}
          actions={(
            <>
              <button
                className="accent-button button-sm pressable"
                onClick={handleExportBoardPdf}
                disabled={boardPrintPdfBusy}
              >
                {boardPrintPdfBusy ? "Preparing PDF..." : "Export PDF"}
              </button>
              <button
                className="ghost-button button-sm pressable"
                onClick={handlePrintBoardWindow}
              >
                Print
              </button>
            </>
          )}
        >
          <BoardPrintPreview
            job={boardPrintJob}
            paperSize={boardPrintJob.paperSize}
            onPaperSizeChange={handleBoardPaperSizeChange}
          />
        </Modal>
      )}

      {boardScanOpen && boardPrintJob && (
        <Modal onClose={() => setBoardScanOpen(false)} title={`Scan ${boardPrintJob.boardName || "board"}`}>
          <BoardScanPanel job={boardPrintJob} onApply={handleApplyBoardScan} />
        </Modal>
      )}

      {showFirstRunOnboarding && (
        <Modal onClose={() => {}} title="Welcome to Taskify" showClose={false}>
          <FirstRunOnboarding
            pushSupported={onboardingPushSupported}
            pushConfigured={onboardingPushConfigured}
            cloudRestoreAvailable={!!workerBaseUrl}
            onUseExistingKey={handleOnboardingUseExistingKey}
            onGenerateNewKey={handleOnboardingGenerateNewKey}
            onRestoreFromBackupFile={handleOnboardingRestoreFromBackupFile}
            onRestoreFromCloud={handleOnboardingRestoreFromCloud}
            onEnableNotifications={handleOnboardingEnableNotifications}
            onComplete={completeFirstRunOnboarding}
          />
        </Modal>
      )}

      {addBoardOpen && (
        <AddBoardModal
          onClose={closeAddBoard}
          onCreateBoard={createBoardFromName}
          onJoinBoard={joinSharedBoard}
        />
      )}

      {shareBoardModalOpen && (
        <Modal onClose={closeShareBoard} title={`Share ${shareBoardDisplayName}`}>
          {shareBoardTarget ? (
            shareBoardTarget.nostr?.boardId ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="share-mode-header">
                    <div className="text-xs uppercase tracking-wide text-secondary">Share mode</div>
                    <button
                      type="button"
                      className="share-mode-info-button pressable"
                      aria-label="About share modes"
                      aria-expanded={shareModeInfoOpen}
                      aria-controls="share-mode-info"
                      onClick={() => setShareModeInfoOpen((prev) => !prev)}
                      ref={shareModeInfoButtonRef}
                    >
                      <span className="share-mode-info-button__icon" aria-hidden="true">i</span>
                    </button>
                    {shareModeInfoOpen && (
                      <div
                        className="share-mode-info"
                        role="tooltip"
                        id="share-mode-info"
                        ref={shareModeInfoRef}
                      >
                        <div className="share-mode-info__row">
                          <div className="share-mode-info__label">Board</div>
                          <div className="share-mode-info__text">
                            Shares the live board ID and keeps changes in sync.
                          </div>
                        </div>
                        <div className="share-mode-info__row">
                          <div className="share-mode-info__label">Template</div>
                          <div className="share-mode-info__text">
                            Creates a new board ID and publishes a snapshot that won't sync future changes.
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="share-mode-toggle" role="group" aria-label="Share mode">
                    <button
                      type="button"
                      className="pill-select share-mode-toggle__button pressable"
                      data-active={shareBoardMode === "board"}
                      aria-pressed={shareBoardMode === "board"}
                      onClick={() => {
                        setShareBoardMode("board");
                        setShareTemplateStatus(null);
                        setShareModeInfoOpen(false);
                      }}
                    >
                      Board
                    </button>
                    <button
                      type="button"
                      className="pill-select share-mode-toggle__button pressable"
                      data-active={shareBoardMode === "template"}
                      aria-pressed={shareBoardMode === "template"}
                      onClick={() => {
                        setShareBoardMode("template");
                        setShareTemplateStatus(null);
                        setShareModeInfoOpen(false);
                      }}
                    >
                      Template
                    </button>
                  </div>
                </div>
                {shareTemplateStatus && (
                  <div className="text-sm text-rose-400">{shareTemplateStatus}</div>
                )}
                <div className="space-y-1">
                  <div className="wallet-qr-card wallet-qr-card--flat wallet-qr-card--centered">
                    <div className="wallet-qr-card__code">
                      {shareBoardId ? (
                        <button
                          type="button"
                          className="wallet-qr-card__canvas wallet-qr-card__canvas--pressable pressable"
                          style={{ maxWidth: "16rem" }}
                          aria-label="Copy board ID"
                          onClick={async () => {
                            if (!shareBoardId) return;
                            try {
                              await navigator.clipboard?.writeText(shareBoardId);
                            } catch {}
                          }}
                        >
                          <QRCodeCanvas
                            value={shareBoardQrPayload ?? shareBoardId}
                            size={256}
                            includeMargin={true}
                            className="wallet-qr-card__qr"
                          />
                        </button>
                      ) : (
                        <div className="contact-qr-placeholder text-secondary">
                          {shareTemplateBusy ? "Generating template share..." : "No QR to share yet."}
                        </div>
                      )}
                    </div>
                  </div>
                  {shareBoardId && (
                    <div className="wallet-qr-card__helper">Tap to copy</div>
                  )}
                  <div className="flex gap-2">
                    <button
                      className="ghost-button button-sm pressable flex-1 justify-center"
                      onClick={() => {
                        setShareContactStatus(null);
                        setShareContactPickerOpen(true);
                      }}
                      disabled={!shareBoardId || (shareBoardMode === "template" && shareTemplateBusy)}
                    >
                      Contacts
                    </button>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      className="ghost-button button-sm pressable flex-1 justify-center"
                      onClick={handleOpenBoardPrint}
                    >
                      Print
                    </button>
                    <button
                      className="ghost-button button-sm pressable flex-1 justify-center"
                      onClick={handleOpenBoardScan}
                    >
                      Scan
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  className="accent-button button-sm pressable w-full justify-center"
                  onClick={() => enableBoardSharing(shareBoardTarget.id)}
                >
                  Enable sharing
                </button>
              </div>
            )
          ) : (
            <div className="text-sm text-secondary">Select a board to share first.</div>
          )}
        </Modal>
      )}
      <ActionSheet
        open={shareContactPickerOpen}
        onClose={() => {
          if (shareContactBusy) return;
          setShareContactPickerOpen(false);
          setShareContactStatus(null);
        }}
        title="Send board ID"
        stackLevel={75}
      >
        {shareBoardTarget ? (
          <div className="text-sm text-secondary mb-2">
            Choose a contact to send <span className="font-semibold">{shareBoardDisplayName}</span>.
          </div>
        ) : (
          <div className="text-sm text-secondary mb-2">Select a board to share first.</div>
        )}
        {shareContactStatus && (
          <div className="text-sm text-rose-400 mb-2">{shareContactStatus}</div>
        )}
        {shareableContacts.length ? (
          <div className="space-y-2">
            {shareableContacts.map((contact) => {
              const label = contactPrimaryName(contact);
              const subtitle = formatContactNpub(contact.npub);
              return (
                <button
                  key={contact.id}
                  type="button"
                  className="contact-row pressable"
                  disabled={shareContactBusy || !shareBoardId}
                  onClick={() => handleShareBoardToContact(contact)}
                >
                  <div className="contact-avatar">{contactInitials(label)}</div>
                  <div className="contact-row__text">
                    <div className="contact-row__name">{label}</div>
                    {subtitle ? (
                      <div className="contact-row__meta">
                        <span className="contact-row__meta-text">{subtitle}</span>
                      </div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-secondary">Add a contact with an npub to share.</div>
        )}
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            className="ghost-button button-sm pressable flex-1 justify-center"
            onClick={() => {
              if (shareContactBusy) return;
              setShareContactPickerOpen(false);
              setShareContactStatus(null);
            }}
            disabled={shareContactBusy}
          >
            Cancel
          </button>
        </div>
      </ActionSheet>

      {/* Cashu Wallet */}
      <Suspense fallback={null}>
        {showWalletShell && (
          <CashuWalletModal
            open={showWalletShell}
            onClose={closeWallet}
            onOpenBounties={openWalletBounties}
            page={showContacts ? "contacts" : "wallet"}
            showTabSwitcher={false}
            showBottomNav
            walletConversionEnabled={settings.walletConversionEnabled}
            walletPrimaryCurrency={settings.walletPrimaryCurrency}
            setWalletPrimaryCurrency={(currency) => setSettings({ walletPrimaryCurrency: currency })}
            npubCashLightningAddressEnabled={settings.npubCashLightningAddressEnabled}
            npubCashAutoClaim={settings.npubCashLightningAddressEnabled && settings.npubCashAutoClaim}
            sentTokenStateChecksEnabled={settings.walletSentStateChecksEnabled}
            paymentRequestsEnabled={settings.walletPaymentRequestsEnabled}
            paymentRequestsBackgroundChecksEnabled={
              settings.walletPaymentRequestsEnabled && settings.walletPaymentRequestsBackgroundChecksEnabled
            }
            tokenStateResetNonce={walletTokenStateResetNonce}
            mintBackupEnabled={settings.walletMintBackupEnabled}
            contactsSyncEnabled={settings.walletContactsSyncEnabled}
            fileStorageServer={settings.fileStorageServer}
            messageItems={walletMessageItems}
            messagesUnreadCount={messagesUnreadCount}
            onAcceptMessage={acceptInboxMessage}
            onMaybeMessage={maybeInboxMessage}
            onDeclineMessage={declineInboxMessage}
            onDismissMessage={dismissInboxMessage}
            onMarkMessagesRead={markInboxMessagesRead}
          />
        )}
      </Suspense>


      {/* ── Add task menu: New Task / Dictate ─────────────────────────────── */}
      <ActionSheet
        open={addMenuKey !== null && voiceDictationKey === null}
        onClose={() => setAddMenuKey(null)}
        title="Add Task"
      >
        <div className="space-y-1 pb-1">
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-[var(--color-surface-hover)] transition-colors pressable"
            onClick={() => {
              const key = addMenuKey!;
              setAddMenuKey(null);
              openInlineTaskEditorDirect(key);
            }}
          >
            <span className="text-lg leading-none">＋</span>
            <span className="text-sm font-medium">New Task</span>
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-[var(--color-surface-hover)] transition-colors pressable"
            onClick={() => {
              setVoiceDictationKey(addMenuKey);
            }}
          >
            <span className="text-lg leading-none">🎙</span>
            <span className="text-sm font-medium">Dictate</span>
          </button>
        </div>
      </ActionSheet>

      {/* ── Voice dictation modal ──────────────────────────────────────────── */}
      {voiceDictationKey !== null && (
        <VoiceDictationModal
          isOpen={true}
          onClose={() => {
            setVoiceDictationKey(null);
            setAddMenuKey(null);
          }}
          onSave={(tasks) => {
            if (voiceDictationKey !== null) {
              handleVoiceSave(voiceDictationKey, tasks);
            }
          }}
          workerBaseUrl={workerBaseUrl}
          npub={nostrPK ? ((() => {
            try {
              return typeof (nip19 as any).npubEncode === "function"
                ? (nip19 as any).npubEncode(nostrPK)
                : nostrPK;
            } catch { return nostrPK; }
          })()) : ""}
          testingMode={kvStorage.getItem("taskify.voice.testInput.enabled") === "true"}
          defaultBoardId={currentBoard?.id}
        />
      )}

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


/* ================= Retained Subcomponents ================= */

/* Small circular icon button */
function IconButton({
  children, onClick, label, intent, buttonRef
}: React.PropsWithChildren<{ onClick: ()=>void; label: string; intent?: "danger"|"success"; buttonRef?: React.Ref<HTMLButtonElement> }>) {
  const cls = `icon-button pressable ${intent === 'danger' ? 'icon-button--danger' : intent === 'success' ? 'icon-button--success' : ''}`;
  const style = { '--icon-size': '2.35rem' } as React.CSSProperties;
  return (
    <button
      ref={buttonRef}
      aria-label={label}
      title={label}
      className={cls}
      style={style}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
