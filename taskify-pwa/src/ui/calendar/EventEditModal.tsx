// @ts-nocheck
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import { normalizeCalendarEventPayload, normalizeDelimitedValues, normalizeLocationList } from "taskify-core";

// Sub-sheet components
import { CustomReminderSheet } from "../reminders/CustomReminderSheet";
import { TimeZoneSheet } from "../reminders/TimeZoneSheet";
import { RecurrenceModal, RepeatPickerSheet, RepeatCustomSheet, EndRepeatSheet } from "../recurrence/RecurrencePicker";

// Domain types
import type {
  CalendarEvent,
  CalendarEventBase,
  CalendarEventParticipant,
  Board,
  Recurrence,
} from "../../domains/tasks/taskTypes";
import { isListLikeBoard } from "../../domains/tasks/taskTypes";
import type { TaskDocument } from "../../lib/documents";
import type { Contact } from "../../lib/contacts";
import type { CalendarRsvpStatus, CalendarRsvpFb } from "../../lib/privateCalendar";

// Reminder utilities (from domains)
import {
  DEFAULT_DATE_REMINDER_TIME,
  buildReminderOptions,
  reminderPresetToMinutes,
  reminderPresetIdForMode,
  formatReminderLabel,
  normalizeReminderTime,
  type ReminderPreset,
  type ReminderPresetMode,
  type ReminderOption,
} from "../../domains/dateTime/reminderUtils";

// Date utilities (from domains)
import {
  isoDatePart,
  isoTimePart,
  isoFromDateTime,
  parseDateKey,
  scrollWheelColumnToIndex,
  getWheelNearestIndex,
  scheduleWheelSnap,
  resolveSystemTimeZone,
  normalizeTimeZone,
  formatTimeLabel,
  parseTimePickerValue,
  formatTimePickerValue,
  currentTimeValue,
} from "../../domains/dateTime/dateUtils";

// Timezone utilities (from domains)
import {
  getTimeZoneOptions,
  formatTimeZoneDisplay,
} from "../../domains/dateTime/timezoneUtils";

// Calendar utilities (from domains)
import {
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
  calendarAddress,
} from "../../lib/privateCalendar";

// Contact utilities
import {
  contactPrimaryName,
  formatContactNpub,
  contactHasNpub,
} from "../../lib/contacts";
import {
  normalizeNostrPubkeyHex,
  contactInitials,
} from "../../domains/tasks/contactUtils";

// Nostr key utilities
import { deriveBoardNostrKeys } from "../../domains/nostr/nostrKeyUtils";
import { hexToBytes } from "../../domains/nostr/nostrCrypto";
import { normalizeNostrPubkey } from "../../lib/nostr";

// Share / inbox utilities
import {
  buildCalendarEventInviteEnvelope,
  sendShareMessage,
} from "../../lib/shareInbox";

// Document utilities
import { ensureDocumentPreview } from "../../lib/documents";

// Relay defaults
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";

// Toast context
import { useToast } from "../../context/ToastContext";

// UI components
import { Modal } from "../Modal";
import { ActionSheet } from "../../components/ActionSheet";
import { DatePickerCalendar } from "../../domains/dateTime/calendarPickerHook";
import { readDocumentsFromFiles } from "../../lib/documents";

// Shared primitive constants (appTypes)
import {
  ISO_DATE_PATTERN,
  HOURS_12,
  MINUTES,
  MERIDIEMS,
  type Meridiem,
} from "../../domains/appTypes";

// Local type and helpers originally co-located in App.tsx
type CalendarRsvpEnvelope = {
  eventId: string;
  authorPubkey: string;
  createdAt: number;
  status: CalendarRsvpStatus;
  fb?: CalendarRsvpFb;
  inviteToken?: string;
};

const R_NONE: Recurrence = { type: "none" };

function labelOf(r: Recurrence): string {
  if (r.type === "daily") return "Every day";
  if (r.type === "weekly") return "Weekly";
  if (r.type === "every") return `Every ${r.n} ${r.unit}${r.n > 1 ? "s" : ""}`;
  if (r.type === "monthlyDay") return `Monthly (day ${r.day})`;
  return "None";
}

function EventEditModal({
  event,
  onCancel,
  onDelete,
  onSave,
  onSwitchToTask,
  boards,
  contacts,
  rsvps,
  nostrPK,
  nostrSkHex,
  defaultRelays,
  onPreviewDocument,
  onRsvp,
}: {
  event: CalendarEvent;
  onCancel: () => void;
  onDelete: () => void;
  onSave: (ev: CalendarEvent) => void;
  onSwitchToTask?: (ev: CalendarEvent) => void;
  boards: Board[];
  contacts: Contact[];
  rsvps: CalendarRsvpEnvelope[];
  nostrPK: string;
  nostrSkHex: string;
  defaultRelays: string[];
  onPreviewDocument?: (event: CalendarEvent, doc: TaskDocument) => void;
  onRsvp?: (status: CalendarRsvpStatus, options?: { fb?: CalendarRsvpFb }) => Promise<void>;
}) {
  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description || "");
  const [documents, setDocuments] = useState<TaskDocument[]>(event.documents || []);
  const [image, setImage] = useState(event.image || "");
  const [locations, setLocations] = useState<string[]>(() => (event.locations?.length ? [...event.locations] : [""]));
  const [geohash, setGeohash] = useState(event.geohash || "");
  const [participants, setParticipants] = useState<CalendarEventParticipant[]>(() => (event.participants ? [...event.participants] : []));
  const [hashtagsText, setHashtagsText] = useState(() => (event.hashtags?.length ? event.hashtags.join(", ") : ""));
  const [referencesText, setReferencesText] = useState(() => (event.references?.length ? event.references.join("\n") : ""));
  const [showAdvanced, setShowAdvanced] = useState(false);
  type EventWhenPicker = null | "startDate" | "startTime" | "endDate" | "endTime" | "reminderTime";
  const [whenPicker, setWhenPicker] = useState<EventWhenPicker>(null);
  const [timeZoneSheetOpen, setTimeZoneSheetOpen] = useState(false);
  const [boardLocationExpanded, setBoardLocationExpanded] = useState(false);
  const [repeatSheetOpen, setRepeatSheetOpen] = useState(false);
  const [repeatCustomSheetOpen, setRepeatCustomSheetOpen] = useState(false);
  const [endRepeatSheetOpen, setEndRepeatSheetOpen] = useState(false);
  const [recurrenceModalOpen, setRecurrenceModalOpen] = useState(false);
  const documentInputRef = useRef<HTMLInputElement>(null);

  const participantValidation = useMemo(() => {
    const normalized: CalendarEventParticipant[] = [];
    const seen = new Set<string>();
    let invalidCount = 0;

    participants.forEach((participant) => {
      const pubkeyInput = (participant.pubkey || "").trim();
      if (!pubkeyInput) return;
      const pubkey = normalizeNostrPubkeyHex(pubkeyInput);
      if (!pubkey) {
        invalidCount += 1;
        return;
      }
      if (seen.has(pubkey)) return;
      seen.add(pubkey);
      normalized.push({
        pubkey,
        relay: (participant.relay || "").trim() || undefined,
        role: (participant.role || "").trim() || undefined,
      });
    });

    return { normalized, invalidCount };
  }, [participants]);

  const [invitePickerOpen, setInvitePickerOpen] = useState(false);
  const [inviteSearch, setInviteSearch] = useState("");
  const [manualInviteNpub, setManualInviteNpub] = useState("");
  const invitedPubkeys = useMemo(
    () => new Set(participantValidation.normalized.map((participant) => participant.pubkey)),
    [participantValidation.normalized],
  );
  const contactByPubkey = useMemo(() => {
    const map = new Map<string, Contact>();
    (contacts || []).forEach((contact) => {
      // Use normalizeNostrPubkey first to handle bech32 (npub1...) format
      const compressed = normalizeNostrPubkey(contact?.npub ?? "");
      const pubkey = compressed ? normalizeNostrPubkeyHex(compressed) : normalizeNostrPubkeyHex(contact?.npub ?? "");
      if (pubkey) map.set(pubkey, contact);
    });
    return map;
  }, [contacts]);
  const filteredInviteContacts = useMemo(() => {
    const q = inviteSearch.trim().toLowerCase();
    if (!q) return contacts;
    return (contacts || []).filter((contact) => {
      const label = contactPrimaryName(contact).toLowerCase();
      const npub = (contact.npub || "").trim().toLowerCase();
      const username = (contact.username || "").trim().toLowerCase();
      const displayName = (contact.displayName || "").trim().toLowerCase();
      const nip05 = (contact.nip05 || "").trim().toLowerCase();
      return (
        label.includes(q) ||
        npub.includes(q) ||
        username.includes(q) ||
        displayName.includes(q) ||
        nip05.includes(q)
      );
    });
  }, [contacts, inviteSearch]);
  const shareableContacts = useMemo(
    () => (contacts || []).filter((contact) => contactHasNpub(contact)),
    [contacts],
  );
  const [shareEventPickerOpen, setShareEventPickerOpen] = useState(false);
  const [shareEventStatus, setShareEventStatus] = useState<string | null>(null);
  const [shareEventBusy, setShareEventBusy] = useState(false);
  const { show: showToast } = useToast();
  const isReadOnly = !!event.readOnly;

  const shortenPubkey = useCallback((value: string): string => {
    const trimmed = (value || "").trim();
    if (!trimmed) return "";
    return trimmed.length > 18 ? `${trimmed.slice(0, 10)}…${trimmed.slice(-6)}` : trimmed;
  }, []);

  const [rsvpBusy, setRsvpBusy] = useState(false);
  const rsvpList = useMemo(() => rsvps ?? [], [rsvps]);
  const showRsvpSection = !!onRsvp || rsvpList.length > 0;
	  const myRsvpStatus = useMemo(() => {
	    const match = rsvpList.find((rsvp) => rsvp.authorPubkey === nostrPK);
	    return match?.status ?? null;
	  }, [nostrPK, rsvpList]);
	  const rsvpCounts = useMemo(() => {
	    const counts = { accepted: 0, tentative: 0, declined: 0 };
	    rsvpList.forEach((rsvp) => {
	      if (rsvp.status === "accepted") counts.accepted += 1;
      else if (rsvp.status === "tentative") counts.tentative += 1;
      else if (rsvp.status === "declined") counts.declined += 1;
    });
	    return counts;
	  }, [rsvpList]);

  const editableBoards = useMemo(() => {
    const base = boards.filter(
      (b) => !b.archived && !b.hidden && b.kind !== "bible" && b.kind !== "compound",
    );
    if (!base.some((b) => b.id === event.boardId)) {
      const fallback = boards.find((b) => b.id === event.boardId);
      if (fallback) return [fallback, ...base];
    }
    return base;
  }, [boards, event.boardId]);

  const [selectedBoardId, setSelectedBoardId] = useState(event.boardId);
  const selectedBoard = useMemo(
    () => editableBoards.find((b) => b.id === selectedBoardId) ?? null,
    [editableBoards, selectedBoardId],
  );
  useEffect(() => {
    if (!editableBoards.length) return;
    if (!editableBoards.some((board) => board.id === selectedBoardId)) {
      setSelectedBoardId(editableBoards[0].id);
    }
  }, [editableBoards, selectedBoardId]);

  const initialAllDay = event.kind === "date";
  const [allDay, setAllDay] = useState(initialAllDay);
  const hasEventTime = !allDay;
  const initialReminderTime = normalizeReminderTime(event.reminderTime) ?? DEFAULT_DATE_REMINDER_TIME;

  const [reminderSelection, setReminderSelection] = useState<ReminderPreset[]>(() => {
    return Array.isArray(event.reminders) ? event.reminders : [];
  });
  const [reminderTime, setReminderTime] = useState(initialReminderTime);
  const [reminderPickerExpanded, setReminderPickerExpanded] = useState(false);
  const [customReminderSheetOpen, setCustomReminderSheetOpen] = useState(false);

  const systemTimeZone = useMemo(() => resolveSystemTimeZone(), []);
  const initialStartTzid = event.kind === "time" ? (normalizeTimeZone(event.startTzid) ?? systemTimeZone) : systemTimeZone;
  const initialEndTzid = event.kind === "time" ? (normalizeTimeZone(event.endTzid) ?? normalizeTimeZone(event.startTzid) ?? systemTimeZone) : systemTimeZone;
  const [startTzid, setStartTzid] = useState(initialStartTzid);
  const [endTzid, setEndTzid] = useState(initialEndTzid);

  const initialStartDate = event.kind === "date" ? event.startDate : isoDatePart(event.startISO, initialStartTzid);
  const initialEndDate = event.kind === "date"
    ? (event.endDate || event.startDate)
    : (() => {
        if (!event.endISO) {
          const startMs = Date.parse(event.startISO);
          if (Number.isNaN(startMs)) return initialStartDate;
          return isoDatePart(new Date(startMs + 60 * 60 * 1000).toISOString(), initialEndTzid);
        }
        return isoDatePart(event.endISO, initialEndTzid);
      })();
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);

  const initialStartTime = event.kind === "time" ? isoTimePart(event.startISO, initialStartTzid) : currentTimeValue(0, initialStartTzid);
  const initialEndTime = event.kind === "time"
    ? (() => {
        if (event.endISO) return isoTimePart(event.endISO, initialEndTzid);
        const startMs = Date.parse(event.startISO);
        if (Number.isNaN(startMs)) return currentTimeValue(60, initialStartTzid);
        return isoTimePart(new Date(startMs + 60 * 60 * 1000).toISOString(), initialEndTzid);
      })()
    : currentTimeValue(60, initialStartTzid);
  const [startTime, setStartTime] = useState(initialStartTime);
  const [endTime, setEndTime] = useState(initialEndTime);
  const timePickerHourColumnRef = useRef<HTMLDivElement | null>(null);
  const timePickerMinuteColumnRef = useRef<HTMLDivElement | null>(null);
  const timePickerMeridiemColumnRef = useRef<HTMLDivElement | null>(null);
  const timePickerHourScrollFrame = useRef<number | null>(null);
  const timePickerMinuteScrollFrame = useRef<number | null>(null);
  const timePickerMeridiemScrollFrame = useRef<number | null>(null);
  const timePickerHourSnapTimeout = useRef<number | null>(null);
  const timePickerMinuteSnapTimeout = useRef<number | null>(null);
  const timePickerMeridiemSnapTimeout = useRef<number | null>(null);
  const [timePickerHour, setTimePickerHour] = useState(() => parseTimePickerValue(startTime, "09:00").hour);
  const [timePickerMinute, setTimePickerMinute] = useState(() => parseTimePickerValue(startTime, "09:00").minute);
  const [timePickerMeridiem, setTimePickerMeridiem] = useState<Meridiem>(() => parseTimePickerValue(startTime, "09:00").meridiem);
  const timePickerHourValueRef = useRef(0);
  const timePickerMinuteValueRef = useRef(0);
  const timePickerMeridiemValueRef = useRef<Meridiem>("AM");

  const [selectedColumnId, setSelectedColumnId] = useState<string>(() => {
    if (!selectedBoard || !isListLikeBoard(selectedBoard)) return "";
    const columns = selectedBoard.kind === "lists" ? selectedBoard.columns : [];
    const fallback = columns[0]?.id || "";
    return event.columnId && columns.some((c) => c.id === event.columnId) ? event.columnId : fallback;
  });

  useEffect(() => {
    if (!selectedBoard || !isListLikeBoard(selectedBoard)) {
      setSelectedColumnId("");
      return;
    }
    const columns = selectedBoard.kind === "lists" ? selectedBoard.columns : [];
    if (!columns.length) {
      setSelectedColumnId("");
      return;
    }
    if (!selectedColumnId || !columns.some((col) => col.id === selectedColumnId)) {
      setSelectedColumnId(columns[0].id);
    }
  }, [selectedBoard, selectedColumnId]);

  const [rule, setRule] = useState<Recurrence>(event.recurrence ?? R_NONE);
  const repeatLabel = useMemo(() => (rule.type === "none" ? "Never" : labelOf(rule)), [rule]);
  const endRepeatSummary = useMemo(() => {
    if (!rule.untilISO) return "Never";
    const timeZone = allDay ? "UTC" : (normalizeTimeZone(startTzid) ?? systemTimeZone);
    const dateKey = isoDatePart(rule.untilISO, timeZone);
    if (!ISO_DATE_PATTERN.test(dateKey)) return "Custom date";
    const parsed = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return "Custom date";
    return parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }, [allDay, rule.untilISO, startTzid, systemTimeZone]);

  const { options: timeZoneOptions, map: timeZoneOptionMap } = useMemo(() => getTimeZoneOptions(), []);
  const safeStartTzid = useMemo(
    () => normalizeTimeZone(startTzid) ?? systemTimeZone,
    [startTzid, systemTimeZone],
  );
  const safeEndTzid = useMemo(() => normalizeTimeZone(endTzid) ?? safeStartTzid, [endTzid, safeStartTzid]);
  const timeZoneLabel = useMemo(
    () => formatTimeZoneDisplay(safeStartTzid, timeZoneOptionMap),
    [safeStartTzid, timeZoneOptionMap],
  );

  const formatDatePill = useCallback((dateKey: string): string => {
    const parts = parseDateKey(dateKey);
    if (!parts) return dateKey;
    const date = new Date(parts.year, parts.month - 1, parts.day);
    if (Number.isNaN(date.getTime())) return dateKey;
    return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }, []);

  const startDateLabel = useMemo(() => formatDatePill(startDate), [formatDatePill, startDate]);
  const endDateLabel = useMemo(() => formatDatePill(endDate), [formatDatePill, endDate]);

  const startTimeLabel = useMemo(
    () => formatTimeLabel(isoFromDateTime(startDate, startTime || "09:00", safeStartTzid), safeStartTzid),
    [safeStartTzid, startDate, startTime],
  );
  const endTimeLabel = useMemo(
    () => formatTimeLabel(isoFromDateTime(endDate || startDate, endTime || "10:00", safeEndTzid), safeEndTzid),
    [endDate, endTime, safeEndTzid, startDate],
  );
  const reminderTimeLabel = useMemo(
    () =>
      formatTimeLabel(
        isoFromDateTime(startDate || isoDatePart(new Date().toISOString()), reminderTime || DEFAULT_DATE_REMINDER_TIME, systemTimeZone),
        systemTimeZone,
      ),
    [reminderTime, startDate, systemTimeZone],
  );

  const boardLocationSummary = useMemo(() => {
    if (!selectedBoard) return "Select board";
    const boardLabel = selectedBoard.name || "Board";
    if (selectedBoard.kind === "lists") {
      const match = selectedBoard.columns.find((column) => column.id === selectedColumnId);
      if (match) return `${boardLabel} • ${match.name}`;
      if (selectedBoard.columns.length === 0) return `${boardLabel} • No lists`;
      return `${boardLabel} • Choose list`;
    }
    return boardLabel;
  }, [selectedBoard, selectedColumnId]);

  const inviteesLabel = useMemo(() => {
    const count = participantValidation.normalized.length;
    if (!count) return "None";
    return `${count} invited`;
  }, [participantValidation.normalized.length]);

  const reminderPresetMode: ReminderPresetMode = hasEventTime ? "timed" : "date";
  const reminderOptions = useMemo(
    () => buildReminderOptions(reminderSelection, reminderPresetMode),
    [reminderPresetMode, reminderSelection],
  );
  const reminderPresetMap = useMemo(() => {
    const map = new Map<ReminderPreset, ReminderOption>();
    for (const opt of reminderOptions) map.set(opt.id, opt);
    return map;
  }, [reminderOptions]);
  const reminderSummary = useMemo(() => {
    if (!reminderSelection.length) return "";
    return reminderSelection
      .map((id) => {
        const preset = reminderPresetMap.get(id);
        if (preset) return preset.badge;
        const minutes = reminderPresetToMinutes(id);
        if (!Number.isFinite(minutes)) return String(id);
        return formatReminderLabel(minutes).badge;
      })
      .join(", ");
  }, [reminderPresetMap, reminderSelection]);
  const reminderRowSummary = useMemo(() => {
    if (!reminderSelection.length) return "None";
    return reminderSummary;
  }, [reminderSelection.length, reminderSummary]);
  const reminderAnchorISO = useMemo(() => {
    if (!startDate) return null;
    if (hasEventTime) {
      const iso = isoFromDateTime(startDate, startTime || "09:00", safeStartTzid);
      return Number.isNaN(Date.parse(iso)) ? null : iso;
    }
    const reminderClock = normalizeReminderTime(reminderTime) ?? DEFAULT_DATE_REMINDER_TIME;
    const iso = isoFromDateTime(startDate, reminderClock, systemTimeZone);
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }, [hasEventTime, reminderTime, safeStartTzid, startDate, startTime, systemTimeZone]);

  function toggleReminder(id: ReminderPreset) {
    if (isReadOnly) return;
    setReminderSelection((prev) => {
      const exists = prev.includes(id);
      const targetMinutes = reminderPresetToMinutes(id);
      const next = exists
        ? prev.filter((item) => item !== id)
        : [...prev.filter((item) => reminderPresetToMinutes(item) !== targetMinutes), id];
      return next.sort((a, b) =>
        reminderPresetMode === "date"
          ? reminderPresetToMinutes(b) - reminderPresetToMinutes(a)
          : reminderPresetToMinutes(a) - reminderPresetToMinutes(b),
      );
    });
  }

  const handleAddCustomReminder = useCallback(() => {
    if (isReadOnly) return;
    setCustomReminderSheetOpen(true);
  }, [isReadOnly]);

  const handleApplyCustomReminder = useCallback((minutesBefore: number) => {
    const id = reminderPresetIdForMode(minutesBefore, reminderPresetMode);
    setReminderSelection((prev) => {
      const targetMinutes = reminderPresetToMinutes(id);
      const nextBase = prev.filter((item) => reminderPresetToMinutes(item) !== targetMinutes || item === id);
      if (nextBase.includes(id)) {
        return nextBase.sort((a, b) =>
          reminderPresetMode === "date"
            ? reminderPresetToMinutes(b) - reminderPresetToMinutes(a)
            : reminderPresetToMinutes(a) - reminderPresetToMinutes(b),
        );
      }
      const next = [...nextBase, id];
      return next.sort((a, b) =>
        reminderPresetMode === "date"
          ? reminderPresetToMinutes(b) - reminderPresetToMinutes(a)
          : reminderPresetToMinutes(a) - reminderPresetToMinutes(b),
      );
    });
  }, [reminderPresetMode]);

  const urlValue = useMemo(() => {
    const lines = (referencesText || "")
      .split(/\n+/g)
      .map((value) => value.trim())
      .filter(Boolean);
    return lines[0] || "";
  }, [referencesText]);

  const handleUrlValueChange = useCallback((next: string) => {
    const trimmed = next.trim();
    setReferencesText((prev) => {
      const lines = (prev || "")
        .split(/\n+/g)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!trimmed) {
        return lines.slice(1).join("\n");
      }
      if (!lines.length) return trimmed;
      return [trimmed, ...lines.slice(1)].join("\n");
    });
  }, []);

  async function handleDocumentAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || !files.length) return;
    if (isReadOnly) {
      e.target.value = "";
      return;
    }
    try {
      const docs = await readDocumentsFromFiles(files);
      setDocuments((prev) => [...prev, ...docs]);
    } catch (err) {
      console.error("Failed to attach event document", err);
      alert("Failed to attach document. Please use PDF, DOC/DOCX, or XLS/XLSX files.");
    } finally {
      e.target.value = "";
    }
  }

  const toggleWhenPicker = useCallback((next: Exclude<EventWhenPicker, null>) => {
    if (isReadOnly) return;
    setWhenPicker((prev) => (prev === next ? null : next));
  }, [isReadOnly]);

  const handleSelectStartDate = useCallback((iso: string) => {
    if (isReadOnly) return;
    setStartDate(iso);
    setEndDate((prev) => (prev && prev >= iso ? prev : iso));
  }, [isReadOnly]);

  const handleSelectEndDate = useCallback((iso: string) => {
    if (isReadOnly) return;
    setEndDate(iso);
    setStartDate((prev) => (prev && prev <= iso ? prev : iso));
  }, [isReadOnly]);

  useEffect(() => {
    if (!allDay) return;
    setWhenPicker((prev) => (prev === "startTime" || prev === "endTime" ? null : prev));
  }, [allDay]);

  useEffect(() => {
    if (!reminderPickerExpanded) {
      setCustomReminderSheetOpen(false);
    }
  }, [reminderPickerExpanded]);

  useEffect(() => {
    if (whenPicker !== "startTime" && whenPicker !== "endTime" && whenPicker !== "reminderTime") return;
    const source = whenPicker === "endTime" ? endTime : whenPicker === "reminderTime" ? reminderTime : startTime;
    const fallback = whenPicker === "endTime" ? "10:00" : "09:00";
    const parsed = parseTimePickerValue(source, fallback);
    setTimePickerHour(parsed.hour);
    setTimePickerMinute(parsed.minute);
    setTimePickerMeridiem(parsed.meridiem);
  }, [endTime, reminderTime, startTime, whenPicker]);

  useEffect(() => {
    timePickerHourValueRef.current = timePickerHour;
  }, [timePickerHour]);
  useEffect(() => {
    timePickerMinuteValueRef.current = timePickerMinute;
  }, [timePickerMinute]);
  useEffect(() => {
    timePickerMeridiemValueRef.current = timePickerMeridiem;
  }, [timePickerMeridiem]);

  useEffect(
    () => () => {
      if (timePickerHourScrollFrame.current != null) {
        cancelAnimationFrame(timePickerHourScrollFrame.current);
      }
      if (timePickerMinuteScrollFrame.current != null) {
        cancelAnimationFrame(timePickerMinuteScrollFrame.current);
      }
      if (timePickerMeridiemScrollFrame.current != null) {
        cancelAnimationFrame(timePickerMeridiemScrollFrame.current);
      }
      const snapRefs = [timePickerHourSnapTimeout, timePickerMinuteSnapTimeout, timePickerMeridiemSnapTimeout];
      for (const ref of snapRefs) {
        if (ref.current != null) {
          window.clearTimeout(ref.current);
          ref.current = null;
        }
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (whenPicker !== "startTime" && whenPicker !== "endTime" && whenPicker !== "reminderTime") return;
    const hourIndex = HOURS_12.indexOf(timePickerHour);
    if (hourIndex >= 0) {
      scrollWheelColumnToIndex(timePickerHourColumnRef.current, hourIndex, "instant");
    }
    const minuteIndex = MINUTES.indexOf(timePickerMinute);
    if (minuteIndex >= 0) {
      scrollWheelColumnToIndex(timePickerMinuteColumnRef.current, minuteIndex, "instant");
    }
    const meridiemIndex = MERIDIEMS.indexOf(timePickerMeridiem);
    if (meridiemIndex >= 0) {
      scrollWheelColumnToIndex(timePickerMeridiemColumnRef.current, meridiemIndex, "instant");
    }
  }, [whenPicker, timePickerHour, timePickerMinute, timePickerMeridiem]);

  const setTimePickerFromParts = useCallback(
    (hour: number, minute: number, meridiem: Meridiem) => {
      const nextValue = formatTimePickerValue(hour, minute, meridiem);
      setTimePickerHour(hour);
      setTimePickerMinute(minute);
      setTimePickerMeridiem(meridiem);
      if (whenPicker === "endTime") {
        setEndTime(nextValue);
      } else if (whenPicker === "reminderTime") {
        setReminderTime(nextValue);
      } else {
        setStartTime(nextValue);
      }
    },
    [whenPicker],
  );

  const handleTimePickerHourScroll = useCallback(() => {
    const column = timePickerHourColumnRef.current;
    if (!column) return;
    if (timePickerHourScrollFrame.current != null) {
      cancelAnimationFrame(timePickerHourScrollFrame.current);
    }
    timePickerHourScrollFrame.current = requestAnimationFrame(() => {
      const clampedIndex = getWheelNearestIndex(column, HOURS_12.length);
      if (clampedIndex == null) return;
      const nextHour = HOURS_12[clampedIndex];
      if (nextHour) {
        timePickerHourValueRef.current = nextHour;
        scheduleWheelSnap(timePickerHourColumnRef, timePickerHourSnapTimeout, clampedIndex, () => {
          setTimePickerFromParts(timePickerHourValueRef.current, timePickerMinuteValueRef.current, timePickerMeridiemValueRef.current);
        });
      }
    });
  }, [setTimePickerFromParts]);

  const handleTimePickerMinuteScroll = useCallback(() => {
    const column = timePickerMinuteColumnRef.current;
    if (!column) return;
    if (timePickerMinuteScrollFrame.current != null) {
      cancelAnimationFrame(timePickerMinuteScrollFrame.current);
    }
    timePickerMinuteScrollFrame.current = requestAnimationFrame(() => {
      const clampedIndex = getWheelNearestIndex(column, MINUTES.length);
      if (clampedIndex == null) return;
      const nextMinute = MINUTES[clampedIndex];
      if (Number.isFinite(nextMinute)) {
        timePickerMinuteValueRef.current = nextMinute as number;
        scheduleWheelSnap(timePickerMinuteColumnRef, timePickerMinuteSnapTimeout, clampedIndex, () => {
          setTimePickerFromParts(timePickerHourValueRef.current, timePickerMinuteValueRef.current, timePickerMeridiemValueRef.current);
        });
      }
    });
  }, [setTimePickerFromParts]);

  const handleTimePickerMeridiemScroll = useCallback(() => {
    const column = timePickerMeridiemColumnRef.current;
    if (!column) return;
    if (timePickerMeridiemScrollFrame.current != null) {
      cancelAnimationFrame(timePickerMeridiemScrollFrame.current);
    }
    timePickerMeridiemScrollFrame.current = requestAnimationFrame(() => {
      const clampedIndex = getWheelNearestIndex(column, MERIDIEMS.length);
      if (clampedIndex == null) return;
      const nextMeridiem = MERIDIEMS[clampedIndex];
      if (nextMeridiem) {
        timePickerMeridiemValueRef.current = nextMeridiem;
        scheduleWheelSnap(timePickerMeridiemColumnRef, timePickerMeridiemSnapTimeout, clampedIndex, () => {
          setTimePickerFromParts(timePickerHourValueRef.current, timePickerMinuteValueRef.current, timePickerMeridiemValueRef.current);
        });
      }
    });
  }, [setTimePickerFromParts]);

  useEffect(() => {
    if (endDate < startDate) setEndDate(startDate);
  }, [endDate, startDate]);

  useEffect(() => {
    if (allDay) return;
    const startISO = isoFromDateTime(startDate, startTime || "09:00", safeStartTzid);
    const endISO = isoFromDateTime(endDate || startDate, endTime || "10:00", safeEndTzid);
    const startMs = Date.parse(startISO);
    const endMs = Date.parse(endISO);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return;
    if (endMs > startMs) return;
    const nextEnd = new Date(startMs + 60 * 60 * 1000).toISOString();
    setEndDate(isoDatePart(nextEnd, safeEndTzid));
    setEndTime(isoTimePart(nextEnd, safeEndTzid));
  }, [allDay, endDate, endTime, safeEndTzid, safeStartTzid, startDate, startTime]);

  const normalizeHashtags = (raw: string): string[] | undefined =>
    normalizeDelimitedValues(raw, /[,\n]+/g, { stripPrefix: "#" });

  const normalizeReferences = (raw: string): string[] | undefined =>
    normalizeDelimitedValues(raw, /\n+/g);

  const normalizeLocations = (list: string[]): string[] | undefined => normalizeLocationList(list);

  const buildDraft = (): CalendarEvent => {
    const boardId = selectedBoardId;
    const columnId = selectedBoard && isListLikeBoard(selectedBoard) ? (selectedColumnId || undefined) : undefined;
    const normalizedTitle = title.trim() || "Untitled";
    const normalizedDescription = description.trim();
    const derivedSummary = (normalizedDescription || (event.summary || "").trim()).trim();
    const normalizedDocuments = documents.map(ensureDocumentPreview);
    const normalizedImage = image.trim();
    const normalizedGeohash = geohash.trim();
    const normalizedParticipants = participantValidation.normalized;

    const base: CalendarEventBase = {
      id: event.id,
      boardId,
      columnId,
      order: event.order,
      title: normalizedTitle,
      ...(derivedSummary ? { summary: derivedSummary } : {}),
      ...(normalizedDescription ? { description: normalizedDescription } : {}),
      ...(normalizedDocuments.length ? { documents: normalizedDocuments } : {}),
      ...(normalizedImage ? { image: normalizedImage } : {}),
      ...(normalizeLocations(locations) ? { locations: normalizeLocations(locations) } : {}),
      ...(normalizedGeohash ? { geohash: normalizedGeohash } : {}),
      ...(normalizedParticipants.length ? { participants: normalizedParticipants } : {}),
      ...(normalizeHashtags(hashtagsText) ? { hashtags: normalizeHashtags(hashtagsText) } : {}),
      ...(normalizeReferences(referencesText) ? { references: normalizeReferences(referencesText) } : {}),
      ...(reminderSelection.length ? { reminders: reminderSelection.slice() } : {}),
      ...(allDay ? { reminderTime: normalizeReminderTime(reminderTime) ?? DEFAULT_DATE_REMINDER_TIME } : {}),
      ...(rule && rule.type !== "none" ? { recurrence: rule, seriesId: event.seriesId || event.id } : {}),
      ...(event.readOnly ? { readOnly: true } : {}),
      ...(event.originBoardId ? { originBoardId: event.originBoardId } : {}),
      ...(event.eventKey ? { eventKey: event.eventKey } : {}),
      ...(event.inviteTokens ? { inviteTokens: event.inviteTokens } : {}),
      ...(event.canonicalAddress ? { canonicalAddress: event.canonicalAddress } : {}),
      ...(event.viewAddress ? { viewAddress: event.viewAddress } : {}),
      ...(event.inviteToken ? { inviteToken: event.inviteToken } : {}),
      ...(event.inviteRelays ? { inviteRelays: event.inviteRelays } : {}),
    };

    if (allDay) {
      const core = normalizeCalendarEventPayload({
        kind: "date",
        title: normalizedTitle,
        startDate,
        endDate,
      });
      if (!core) return { ...base, kind: "date", startDate } as CalendarEvent;
      return {
        ...base,
        kind: "date",
        startDate: core.startDate || startDate,
        ...(core.endDate ? { endDate: core.endDate } : {}),
      };
    }

    const normalizedStartTz = normalizeTimeZone(startTzid) ?? systemTimeZone;
    const normalizedEndTz = normalizeTimeZone(endTzid) ?? normalizedStartTz;
    const startISO = isoFromDateTime(startDate, startTime || "09:00", normalizedStartTz);
    const endISO = isoFromDateTime(endDate || startDate, endTime || "10:00", normalizedEndTz);

    const core = normalizeCalendarEventPayload({
      kind: "time",
      title: normalizedTitle,
      startISO,
      endISO,
      startTzid: normalizedStartTz,
      endTzid: normalizedEndTz,
    });
    if (!core) {
      return {
        ...base,
        kind: "time",
        startISO,
        ...(normalizedStartTz ? { startTzid: normalizedStartTz } : {}),
        ...(normalizedEndTz ? { endTzid: normalizedEndTz } : {}),
      } as CalendarEvent;
    }

    return {
      ...base,
      kind: "time",
      startISO: core.startISO || startISO,
      ...(core.endISO ? { endISO: core.endISO } : {}),
      ...(core.startTzid ? { startTzid: core.startTzid } : {}),
      ...(core.endTzid ? { endTzid: core.endTzid } : {}),
    };
  };

  const handleSave = () => {
    if (isReadOnly) return;
    if (participantValidation.invalidCount > 0) return;
    onSave(buildDraft());
  };

  const handleSwitchToTask = () => {
    if (isReadOnly) return;
    if (!onSwitchToTask) return;
    onSwitchToTask(buildDraft());
  };

  async function copyCurrent() {
    const base = buildDraft();
    try { await navigator.clipboard?.writeText(JSON.stringify(base)); } catch {}
  }

  async function handleShareEventToContact(contact: Contact) {
    if (shareEventBusy) return;
    const draft = buildDraft();
    const board = boards.find((b) => b.id === draft.boardId) ?? selectedBoard;
    if (!board?.nostr?.boardId) {
      setShareEventStatus("Enable sharing on this board to share events.");
      return;
    }
    const recipientHex = normalizeNostrPubkeyHex(contact.npub);
    if (!recipientHex) {
      setShareEventStatus("Contact is missing a valid npub.");
      return;
    }
    if (!nostrSkHex) {
      setShareEventStatus("Connect a Nostr key to share events.");
      return;
    }
    const boardRelays = Array.from(
      new Set(
        (board.nostr?.relays?.length ? board.nostr.relays : [])
          .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
          .filter(Boolean),
      ),
    );
    const defaultRelayList = Array.from(
      new Set(
        (defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS))
          .map((relay) => relay.trim())
          .filter(Boolean),
      ),
    );
    const relayList = boardRelays.length ? boardRelays : defaultRelayList;
    if (!relayList.length) {
      setShareEventStatus("No relays configured for sharing.");
      return;
    }
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
    setShareEventBusy(true);
    setShareEventStatus(null);
    try {
      const boardKeys = await deriveBoardNostrKeys(board.nostr.boardId);
      const eventKey = draft.eventKey || event.eventKey;
      if (!eventKey) {
        setShareEventStatus("Save the event to generate a share key first.");
        return;
      }
      const inviteToken =
        (draft.inviteTokens ?? event.inviteTokens ?? {})[recipientHex] || "";
      if (!inviteToken) {
        setShareEventStatus("Add this contact as an invitee before sharing.");
        return;
      }
      const canonical = calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, draft.id);
      const view = calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, boardKeys.pk, draft.id);
      const envelope = buildCalendarEventInviteEnvelope({
        eventId: draft.id,
        canonical,
        view,
        eventKey,
        inviteToken,
        title: draft.title,
        start: draft.kind === "date" ? draft.startDate : draft.startISO,
        end: draft.kind === "date" ? draft.endDate : draft.endISO,
        relays: relayList,
      }, senderNpub ? { npub: senderNpub } : undefined);
      const sendRelays = Array.from(new Set([...relayList, ...defaultRelayList])).filter(Boolean);
      await sendShareMessage(envelope, recipientHex, nostrSkHex, sendRelays);
      setShareEventPickerOpen(false);
      showToast(`Event sent to ${contactPrimaryName(contact)}`);
    } catch (err: any) {
      setShareEventStatus(err?.message || "Unable to share event.");
    } finally {
      setShareEventBusy(false);
    }
  }

  const handleChangeLocation = (idx: number, value: string) => {
    if (isReadOnly) return;
    setLocations((prev) => prev.map((loc, i) => (i === idx ? value : loc)));
  };

  const handleAddLocation = () => {
    if (isReadOnly) return;
    setLocations((prev) => [...prev, ""]);
  };

  const handleRemoveLocation = (idx: number) => {
    if (isReadOnly) return;
    setLocations((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleChangeParticipant = (idx: number, patch: Partial<CalendarEventParticipant>) => {
    if (isReadOnly) return;
    setParticipants((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const handleAddParticipant = () => {
    if (isReadOnly) return;
    setParticipants((prev) => [...prev, { pubkey: "", relay: "", role: "attendee" }]);
  };

  const handleRemoveParticipant = (idx: number) => {
    if (isReadOnly) return;
    setParticipants((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleOpenInvitePicker = () => {
    if (isReadOnly) return;
    setInviteSearch("");
    setManualInviteNpub("");
    setInvitePickerOpen(true);
  };

  // Resolves npub1 bech32, nostr: URIs, and raw hex to a 64-char hex pubkey.
  const resolveInviteInput = (input: string): string | null => {
    const trimmed = input.trim();
    if (!trimmed) return null;
    // Try bech32 / nostr: URI first (normalizeNostrPubkey handles these)
    const compressed = normalizeNostrPubkey(trimmed);
    if (compressed) return normalizeNostrPubkeyHex(compressed);
    // Fall back to straight hex
    return normalizeNostrPubkeyHex(trimmed);
  };

  const handleAddManualInvitee = () => {
    if (isReadOnly) return;
    const raw = manualInviteNpub.trim();
    if (!raw) return;
    const pubkey = resolveInviteInput(raw);
    if (!pubkey) return;
    setParticipants((prev) => {
      if (prev.some((p) => normalizeNostrPubkeyHex(p.pubkey) === pubkey)) return prev;
      return [...prev, { pubkey, relay: "", role: "attendee" }];
    });
    setManualInviteNpub("");
  };

  const handleToggleInviteContact = (contact: Contact) => {
    if (isReadOnly) return;
    const pubkey = resolveInviteInput(contact?.npub ?? "");
    if (!pubkey) return;
    setParticipants((prev) => {
      const existing = prev.some((participant) => normalizeNostrPubkeyHex(participant.pubkey) === pubkey);
      if (existing) {
        return prev.filter((participant) => normalizeNostrPubkeyHex(participant.pubkey) !== pubkey);
      }
      const relay = Array.isArray(contact?.relays)
        ? contact.relays.map((entry) => (typeof entry === "string" ? entry.trim() : "")).find(Boolean) || ""
        : "";
      return [...prev, { pubkey, relay, role: "attendee" }];
    });
  };

	  const handleRsvpSelection = async (status: CalendarRsvpStatus) => {
	    if (!onRsvp || rsvpBusy) return;
	    if (myRsvpStatus === status) return;
	    try {
	      setRsvpBusy(true);
	      await onRsvp(status);
	    } finally {
	      setRsvpBusy(false);
	    }
	  };

	  const handleRepeatSelect = useCallback((next: Recurrence) => {
	    setRule((prev) => {
	      if (prev.untilISO) {
	        return { ...next, untilISO: prev.untilISO };
	      }
	      return next;
	    });
	    setRepeatSheetOpen(false);
	    setRepeatCustomSheetOpen(false);
	  }, []);

	  const handleOpenCustomRepeat = useCallback(() => {
	    setRepeatSheetOpen(false);
	    setRepeatCustomSheetOpen(true);
	  }, []);

	  const handleOpenAdvancedRepeat = useCallback(() => {
	    setRepeatSheetOpen(false);
	    setRepeatCustomSheetOpen(false);
	    setRecurrenceModalOpen(true);
	  }, []);

	  return (
	    <>
	      <Modal onClose={onCancel} showClose={false} variant="fullscreen">
        <div className="edit-modal">
        <div className="edit-sheet__header">
          <button
            type="button"
            className="edit-sheet__action"
            onClick={onCancel}
            aria-label="Close editor"
          >
            <span aria-hidden="true">×</span>
          </button>
          <div className="edit-sheet__title">Details</div>
          <button
            type="button"
            className="edit-sheet__action edit-sheet__action--accent"
            onClick={handleSave}
            aria-label="Save event"
            disabled={participantValidation.invalidCount > 0 || isReadOnly}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M5 12l4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {onSwitchToTask && (
          <div className="mt-[-1rem] mb-[-1rem] w-full pb-[0.1rem]">
            <div className="w-full">
              <div className="flex w-full rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  type="button"
                  className="flex-1 rounded-full border border-white/10 bg-white/10 px-3 py-0.5 text-sm font-medium leading-none text-primary shadow-sm"
                  aria-pressed="true"
                >
                  Event
                </button>
                <button
                  type="button"
                  className="pressable flex-1 rounded-full px-3 py-0.5 text-sm leading-none text-secondary"
                  onClick={handleSwitchToTask}
                  disabled={isReadOnly}
                >
                  Task
                </button>
              </div>
            </div>
          </div>
        )}

        {participantValidation.invalidCount > 0 && (
          <div className="px-4 pt-3 text-sm text-rose-400">
            Fix {participantValidation.invalidCount} invalid invitee {participantValidation.invalidCount === 1 ? "pubkey" : "pubkeys"} to save.
          </div>
        )}
        {isReadOnly && (
          <div className="px-4 pt-2 text-xs text-secondary">
            View only • You don&apos;t have edit access to this event.
          </div>
        )}

		        <section className="edit-card">
		          <div className="space-y-3">
		            <div className="edit-card__detail edit-card__detail--field">
		              <input
		                value={title}
		                onChange={(e) => setTitle(e.target.value)}
		                className="edit-field-input"
		                placeholder="Title"
		                readOnly={isReadOnly}
		              />
		            </div>
		            <div className="edit-card__detail edit-card__detail--field">
		              <input
		                value={locations[0] ?? ""}
		                onChange={(e) => handleChangeLocation(0, e.target.value)}
		                className="edit-field-input"
		                placeholder="Location or video call"
		                readOnly={isReadOnly}
		              />
		            </div>
		            <div className="edit-card__detail edit-card__detail--field">
		              <input
		                value={urlValue}
		                onChange={(e) => handleUrlValueChange(e.target.value)}
		                className="edit-field-input"
		                placeholder="URL"
		                readOnly={isReadOnly}
		              />
		            </div>
			            <div className="edit-card__detail edit-card__detail--field">
			              <textarea
			                value={description}
			                onChange={(e) => setDescription(e.target.value)}
			                className="edit-field-textarea"
			                rows={4}
			                placeholder="Notes"
			                readOnly={isReadOnly}
			              />
			            </div>
			            <div className="edit-card__detail">
			              <input
			                ref={documentInputRef}
			                type="file"
			                accept=".pdf,.doc,.docx,.xlsx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
			                className="hidden"
			                multiple
			                onChange={handleDocumentAttach}
			              />
			              <button
			                type="button"
			                className="ghost-button button-sm pressable"
			                onClick={() => documentInputRef.current?.click()}
			                disabled={isReadOnly}
			              >
			                Attach
			              </button>
			            </div>
			            {documents.length > 0 && (
			              <ul className="space-y-1">
			                {documents.map((doc) => (
			                  <li key={doc.id} className="doc-edit-row">
			                    <div className="doc-edit-row__info">
			                      <div className="doc-edit-row__name" title={doc.name}>{doc.name}</div>
			                      <div className="doc-edit-row__meta">{doc.kind.toUpperCase()}</div>
			                    </div>
			                    <div className="doc-edit-row__actions">
			                      <button
			                        type="button"
			                        className="ghost-button button-sm pressable"
			                        onClick={() => onPreviewDocument?.(event, doc)}
			                      >
			                        Preview
			                      </button>
			                      <button
			                        type="button"
			                        className="ghost-button button-sm pressable text-rose-500"
			                        onClick={() => setDocuments((prev) => prev.filter((item) => item.id !== doc.id))}
			                        disabled={isReadOnly}
			                      >
			                        Remove
			                      </button>
			                    </div>
			                  </li>
			                ))}
			              </ul>
			            )}
			          </div>
			        </section>

	        <section className="edit-card">
	          <div className="edit-row">
	            <div className="edit-row__content">
	              <div className="edit-row__label">All-day</div>
	            </div>
            <button
              type="button"
              className={`edit-toggle ${allDay ? "is-on" : ""}`}
              role="switch"
              aria-checked={allDay}
              aria-label="Toggle all-day"
              onClick={() => setAllDay((prev) => !prev)}
              disabled={isReadOnly}
            >
	              <span className="edit-toggle__thumb" />
	            </button>
	          </div>
	          <div className="edit-row">
	            <div className="edit-row__content">
	              <div className="edit-row__label">Starts</div>
	            </div>
	            <div className="flex items-center gap-2">
	              <button
	                type="button"
	                className={`pressable rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium ${
	                  whenPicker === "startDate" ? "text-primary" : "text-secondary"
	                }`}
	                onClick={() => toggleWhenPicker("startDate")}
	                aria-pressed={whenPicker === "startDate"}
	                disabled={isReadOnly}
	              >
	                {startDateLabel}
	              </button>
	              {!allDay && (
	                <button
	                  type="button"
	                  className={`pressable rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium ${
	                    whenPicker === "startTime" ? "text-primary" : "text-secondary"
	                  }`}
	                  onClick={() => toggleWhenPicker("startTime")}
	                  aria-pressed={whenPicker === "startTime"}
	                  disabled={isReadOnly}
	                >
	                  {startTimeLabel}
	                </button>
	              )}
	            </div>
	          </div>
	          {whenPicker === "startDate" && (
	            <div className="edit-card__detail space-y-3">
	              <DatePickerCalendar baseDate={startDate} selectedDate={startDate} onSelectDate={handleSelectStartDate} />
	            </div>
	          )}
	          {!allDay && whenPicker === "startTime" && (
	            <div className="edit-card__detail space-y-2">
	              <div className="edit-time-picker" role="group" aria-label="Select time">
	                <div
	                  className="edit-time-picker__column"
	                  ref={timePickerHourColumnRef}
	                  onScroll={handleTimePickerHourScroll}
	                  role="listbox"
	                  aria-label="Select hour"
	                >
	                  {HOURS_12.map((hour, idx) => (
	                    <div
	                      key={`start-hour-${hour}`}
	                      className={`edit-time-picker__option ${timePickerHour === hour ? "is-active" : ""}`}
	                      data-picker-index={idx}
	                      role="option"
	                      aria-selected={timePickerHour === hour}
	                    >
	                      {String(hour).padStart(2, "0")}
	                    </div>
	                  ))}
	                </div>
	                <div className="edit-time-picker__separator" aria-hidden="true">
	                  :
	                </div>
	                <div
	                  className="edit-time-picker__column"
	                  ref={timePickerMinuteColumnRef}
	                  onScroll={handleTimePickerMinuteScroll}
	                  role="listbox"
	                  aria-label="Select minute"
	                >
	                  {MINUTES.map((minute, idx) => (
	                    <div
	                      key={`start-minute-${minute}`}
	                      className={`edit-time-picker__option ${timePickerMinute === minute ? "is-active" : ""}`}
	                      data-picker-index={idx}
	                      role="option"
	                      aria-selected={timePickerMinute === minute}
	                    >
	                      {String(minute).padStart(2, "0")}
	                    </div>
	                  ))}
	                </div>
	                <div
	                  className="edit-time-picker__column edit-time-picker__column--meridiem"
	                  ref={timePickerMeridiemColumnRef}
	                  onScroll={handleTimePickerMeridiemScroll}
	                  role="listbox"
	                  aria-label="Select AM or PM"
	                >
	                  {MERIDIEMS.map((label, idx) => (
	                    <div
	                      key={`start-meridiem-${label}`}
	                      className={`edit-time-picker__option ${timePickerMeridiem === label ? "is-active" : ""}`}
	                      data-picker-index={idx}
	                      role="option"
	                      aria-selected={timePickerMeridiem === label}
	                    >
	                      {label}
	                    </div>
	                  ))}
	                </div>
	              </div>
	              <button
	                type="button"
	                className="edit-row edit-row--interactive w-full text-left"
	                onClick={() => setTimeZoneSheetOpen(true)}
	                disabled={isReadOnly}
	              >
	                <div className="edit-row__content">
	                  <div className="edit-row__label">Time Zone</div>
	                </div>
	                <div className="edit-row__value">{timeZoneLabel}</div>
	                <span className="edit-row__chevron" aria-hidden="true">›</span>
	              </button>
	            </div>
	          )}

	          <div className="edit-row">
	            <div className="edit-row__content">
	              <div className="edit-row__label">Ends</div>
	            </div>
	            <div className="flex items-center gap-2">
	              <button
	                type="button"
	                className={`pressable rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium ${
	                  whenPicker === "endDate" ? "text-primary" : "text-secondary"
	                }`}
	                onClick={() => toggleWhenPicker("endDate")}
	                aria-pressed={whenPicker === "endDate"}
	                disabled={isReadOnly}
	              >
	                {endDateLabel}
	              </button>
	              {!allDay && (
	                <button
	                  type="button"
	                  className={`pressable rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium ${
	                    whenPicker === "endTime" ? "text-primary" : "text-secondary"
	                  }`}
	                  onClick={() => toggleWhenPicker("endTime")}
	                  aria-pressed={whenPicker === "endTime"}
	                  disabled={isReadOnly}
	                >
	                  {endTimeLabel}
	                </button>
	              )}
	            </div>
	          </div>
	          {whenPicker === "endDate" && (
	            <div className="edit-card__detail space-y-3">
	              <DatePickerCalendar baseDate={endDate} selectedDate={endDate} onSelectDate={handleSelectEndDate} />
	            </div>
	          )}
	          {!allDay && whenPicker === "endTime" && (
	            <div className="edit-card__detail space-y-2">
	              <div className="edit-time-picker" role="group" aria-label="Select time">
	                <div
	                  className="edit-time-picker__column"
	                  ref={timePickerHourColumnRef}
	                  onScroll={handleTimePickerHourScroll}
	                  role="listbox"
	                  aria-label="Select hour"
	                >
	                  {HOURS_12.map((hour, idx) => (
	                    <div
	                      key={`end-hour-${hour}`}
	                      className={`edit-time-picker__option ${timePickerHour === hour ? "is-active" : ""}`}
	                      data-picker-index={idx}
	                      role="option"
	                      aria-selected={timePickerHour === hour}
	                    >
	                      {String(hour).padStart(2, "0")}
	                    </div>
	                  ))}
	                </div>
	                <div className="edit-time-picker__separator" aria-hidden="true">
	                  :
	                </div>
	                <div
	                  className="edit-time-picker__column"
	                  ref={timePickerMinuteColumnRef}
	                  onScroll={handleTimePickerMinuteScroll}
	                  role="listbox"
	                  aria-label="Select minute"
	                >
	                  {MINUTES.map((minute, idx) => (
	                    <div
	                      key={`end-minute-${minute}`}
	                      className={`edit-time-picker__option ${timePickerMinute === minute ? "is-active" : ""}`}
	                      data-picker-index={idx}
	                      role="option"
	                      aria-selected={timePickerMinute === minute}
	                    >
	                      {String(minute).padStart(2, "0")}
	                    </div>
	                  ))}
	                </div>
	                <div
	                  className="edit-time-picker__column edit-time-picker__column--meridiem"
	                  ref={timePickerMeridiemColumnRef}
	                  onScroll={handleTimePickerMeridiemScroll}
	                  role="listbox"
	                  aria-label="Select AM or PM"
	                >
	                  {MERIDIEMS.map((label, idx) => (
	                    <div
	                      key={`end-meridiem-${label}`}
	                      className={`edit-time-picker__option ${timePickerMeridiem === label ? "is-active" : ""}`}
	                      data-picker-index={idx}
	                      role="option"
	                      aria-selected={timePickerMeridiem === label}
	                    >
	                      {label}
	                    </div>
	                  ))}
	                </div>
	              </div>
	              <button
	                type="button"
	                className="edit-row edit-row--interactive w-full text-left"
	                onClick={() => setTimeZoneSheetOpen(true)}
	                disabled={isReadOnly}
	              >
	                <div className="edit-row__content">
	                  <div className="edit-row__label">Time Zone</div>
	                </div>
	                <div className="edit-row__value">{timeZoneLabel}</div>
	                <span className="edit-row__chevron" aria-hidden="true">›</span>
	              </button>
	            </div>
	          )}

		        </section>

		        <section className="edit-card">
		          <button
		            type="button"
		            className="edit-row edit-row--interactive w-full text-left"
		            onClick={() => setRepeatSheetOpen(true)}
		            disabled={isReadOnly}
		          >
	            <div className="edit-row__content">
	              <div className="edit-row__label">Repeat</div>
	            </div>
		            <div className="edit-row__value">{repeatLabel}</div>
		            <span className="edit-row__chevron" aria-hidden="true">›</span>
		          </button>
              {rule.type !== "none" && (
                <button
                  type="button"
                  className="edit-row edit-row--interactive w-full text-left"
                  onClick={() => setEndRepeatSheetOpen(true)}
                  disabled={isReadOnly}
                >
                  <div className="edit-row__content">
                    <div className="edit-row__label">End Repeat</div>
                  </div>
                  <div className="edit-row__value">{endRepeatSummary}</div>
                  <span className="edit-row__chevron" aria-hidden="true">›</span>
                </button>
              )}
		        </section>

		        <section className="edit-card">
		          <button
		            type="button"
		            className="edit-row edit-row--interactive edit-row--inline"
		            onClick={() => setBoardLocationExpanded((prev) => !prev)}
		            aria-expanded={boardLocationExpanded}
		            disabled={isReadOnly}
		          >
		            <div className="edit-row__content">
		              <div className="edit-row__label">Board</div>
		            </div>
		            <div className="edit-row__value truncate max-w-[10rem]" title={boardLocationSummary}>
		              {boardLocationSummary}
		            </div>
		            <span className="edit-row__chevron" aria-hidden="true">›</span>
		          </button>
		          {boardLocationExpanded && (
		            <div className="edit-card__detail edit-location">
		              {editableBoards.length === 0 ? (
		                <div className="text-sm text-secondary">No boards available.</div>
		              ) : (
		                <div className="edit-location__controls">
		                  <select
		                    className="pill-select pill-select--compact w-full"
		                    value={selectedBoardId}
		                    onChange={(evt) => setSelectedBoardId(evt.target.value)}
		                    title="Select board"
		                    aria-label="Select board"
		                    disabled={isReadOnly}
		                  >
		                    {editableBoards.map((board) => (
		                      <option key={board.id} value={board.id}>
		                        {board.name}
		                      </option>
		                    ))}
		                  </select>
		                  {selectedBoard?.kind === "lists" && (
		                    <select
		                      className="pill-select pill-select--compact w-full"
		                      value={selectedColumnId}
		                      onChange={(evt) => setSelectedColumnId(evt.target.value)}
		                      title="Select list"
		                      aria-label="Select list"
		                      disabled={isReadOnly || selectedBoard.columns.length === 0}
		                    >
		                      {selectedBoard.columns.length === 0 ? (
		                        <option value="">No lists</option>
		                      ) : (
		                        selectedBoard.columns.map((column) => (
		                          <option key={column.id} value={column.id}>
		                            {column.name}
		                          </option>
		                        ))
		                      )}
		                    </select>
		                  )}
		                </div>
		              )}
		            </div>
		          )}
          <button
            type="button"
            className="edit-row edit-row--interactive w-full text-left"
            onClick={handleOpenInvitePicker}
            disabled={isReadOnly}
          >
            <div className="edit-row__content">
              <div className="edit-row__label">Invitees</div>
            </div>
            <div className="edit-row__value">{inviteesLabel}</div>
            <span className="edit-row__chevron" aria-hidden="true">›</span>
          </button>
          <div className="edit-card__detail">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="ghost-button button-sm pressable"
                onClick={handleOpenInvitePicker}
                disabled={isReadOnly}
              >
                Invite contact
              </button>
              <button
                type="button"
                className="ghost-button button-sm pressable"
                onClick={handleOpenInvitePicker}
                disabled={isReadOnly}
              >
                Add invitee
              </button>
            </div>
          </div>
        </section>

		        <section className="edit-card">
		          <button
		            type="button"
		            className="edit-row edit-row--interactive w-full text-left"
		            onClick={() => setReminderPickerExpanded((prev) => !prev)}
		            disabled={isReadOnly}
		          >
		            <div className="edit-row__content">
		              <div className="edit-row__label">Reminders</div>
		            </div>
		            <div className="edit-row__value">{reminderRowSummary}</div>
		            <span className="edit-row__chevron" aria-hidden="true">›</span>
		          </button>
		          {reminderPickerExpanded && (
		            <div className="edit-card__detail space-y-2">
		              <div className="flex flex-wrap gap-1.5">
		                {reminderOptions.map((opt) => {
		                  const active = reminderSelection.includes(opt.id);
		                  const cls = active ? "accent-button button-sm pressable" : "ghost-button button-sm pressable";
		                  return (
			                    <button
			                      key={opt.id}
			                      type="button"
			                      className={cls}
			                      onClick={() => toggleReminder(opt.id)}
			                      disabled={isReadOnly}
			                      title={opt.label}
			                    >
			                      {opt.badge}
			                    </button>
			                  );
		                })}
			                <button
			                  type="button"
			                  className="ghost-button button-sm pressable"
			                  onClick={handleAddCustomReminder}
			                  disabled={isReadOnly}
			                  title="Add a custom reminder"
			                >
			                  Custom…
			                </button>
			              </div>
                    {allDay && (
                      <div className="space-y-2">
                        <div className="text-xs text-secondary">Reminder time (current timezone)</div>
                        <button
                          type="button"
                          className={`pressable rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium ${
                            whenPicker === "reminderTime" ? "text-primary" : "text-secondary"
                          }`}
                          onClick={() => toggleWhenPicker("reminderTime")}
                          aria-pressed={whenPicker === "reminderTime"}
                          disabled={isReadOnly}
                        >
                          {reminderTimeLabel}
                        </button>
                        {whenPicker === "reminderTime" && (
                          <div className="edit-time-picker" role="group" aria-label="Select reminder time">
                            <div
                              className="edit-time-picker__column"
                              ref={timePickerHourColumnRef}
                              onScroll={handleTimePickerHourScroll}
                              role="listbox"
                              aria-label="Select hour"
                            >
                              {HOURS_12.map((hour, idx) => (
                                <div
                                  key={`reminder-hour-${hour}`}
                                  className={`edit-time-picker__option ${timePickerHour === hour ? "is-active" : ""}`}
                                  data-picker-index={idx}
                                  role="option"
                                  aria-selected={timePickerHour === hour}
                                >
                                  {String(hour).padStart(2, "0")}
                                </div>
                              ))}
                            </div>
                            <div className="edit-time-picker__separator" aria-hidden="true">
                              :
                            </div>
                            <div
                              className="edit-time-picker__column"
                              ref={timePickerMinuteColumnRef}
                              onScroll={handleTimePickerMinuteScroll}
                              role="listbox"
                              aria-label="Select minute"
                            >
                              {MINUTES.map((minute, idx) => (
                                <div
                                  key={`reminder-minute-${minute}`}
                                  className={`edit-time-picker__option ${timePickerMinute === minute ? "is-active" : ""}`}
                                  data-picker-index={idx}
                                  role="option"
                                  aria-selected={timePickerMinute === minute}
                                >
                                  {String(minute).padStart(2, "0")}
                                </div>
                              ))}
                            </div>
                            <div
                              className="edit-time-picker__column edit-time-picker__column--meridiem"
                              ref={timePickerMeridiemColumnRef}
                              onScroll={handleTimePickerMeridiemScroll}
                              role="listbox"
                              aria-label="Select AM or PM"
                            >
                              {MERIDIEMS.map((label, idx) => (
                                <div
                                  key={`reminder-meridiem-${label}`}
                                  className={`edit-time-picker__option ${timePickerMeridiem === label ? "is-active" : ""}`}
                                  data-picker-index={idx}
                                  role="option"
                                  aria-selected={timePickerMeridiem === label}
                                >
                                  {label}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
			            </div>
			          )}
			        </section>

	        {showRsvpSection && (
	          <section className="edit-card">
	            <div className="edit-card__title">Responses</div>
	            <div className="space-y-3">
              {onRsvp && (
                <div className="space-y-2">
                  <div className="text-xs text-secondary">Your RSVP</div>
                  <div className="mx-auto w-full max-w-md">
                    <div className="flex rounded-full border border-white/10 bg-white/5 p-1">
                      <button
                        type="button"
                        className={
                          myRsvpStatus === "accepted"
                            ? "pressable flex-1 rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-primary shadow-sm"
                            : "pressable flex-1 rounded-full px-3 py-2 text-sm text-secondary"
                        }
                        disabled={rsvpBusy}
                        onClick={() => void handleRsvpSelection("accepted")}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className={
                          myRsvpStatus === "tentative"
                            ? "pressable flex-1 rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-primary shadow-sm"
                            : "pressable flex-1 rounded-full px-3 py-2 text-sm text-secondary"
                        }
                        disabled={rsvpBusy}
                        onClick={() => void handleRsvpSelection("tentative")}
                      >
                        Tentative
                      </button>
                      <button
                        type="button"
                        className={
                          myRsvpStatus === "declined"
                            ? "pressable flex-1 rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-primary shadow-sm"
                            : "pressable flex-1 rounded-full px-3 py-2 text-sm text-secondary"
                        }
                        disabled={rsvpBusy}
                        onClick={() => void handleRsvpSelection("declined")}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="text-xs text-secondary">
                Accepted {rsvpCounts.accepted} • Tentative {rsvpCounts.tentative} • Declined {rsvpCounts.declined}
              </div>

              {rsvpList.length === 0 ? (
                <div className="text-xs text-secondary">No responses yet.</div>
              ) : (
                <div className="space-y-2">
                  {rsvpList.map((rsvp) => {
                    const contact = contactByPubkey.get(rsvp.authorPubkey);
                    const label = contact ? contactPrimaryName(contact) : shortenPubkey(rsvp.authorPubkey);
                    const isSelf = rsvp.authorPubkey === nostrPK;
                    const statusLabel =
                      rsvp.status === "accepted" ? "Accepted" : rsvp.status === "tentative" ? "Tentative" : "Declined";
                    const statusClass =
                      rsvp.status === "accepted"
                        ? "text-emerald-400"
                        : rsvp.status === "tentative"
                          ? "text-amber-400"
                          : "text-rose-400";
                    return (
                      <div
                        key={rsvp.authorPubkey}
                        className="flex items-center justify-between rounded-xl border border-surface bg-surface-muted px-3 py-2"
                      >
                        <div className="min-w-0 truncate text-sm font-medium">
                          {label}
                          {isSelf ? " (You)" : ""}
                        </div>
                        <div className={`text-xs font-medium ${statusClass}`}>{statusLabel}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
	        )}

	        <div className="edit-actions">
          <button
            type="button"
            className="pressable rounded-full bg-rose-600/80 px-4 py-2 text-sm font-semibold hover:bg-rose-600"
            onClick={onDelete}
          >
            Delete
          </button>
          <div className="edit-actions__secondary">
            <button type="button" className="ghost-button button-sm pressable" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "Hide details" : "More"}
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                setShareEventStatus(null);
                setShareEventPickerOpen(true);
              }}
              disabled={shareEventBusy || isReadOnly}
            >
              Share
            </button>
            <button type="button" className="ghost-button button-sm pressable" onClick={copyCurrent}>
              Copy Event
            </button>
          </div>
        </div>

	        {showAdvanced && (
	          <>
	            <section className="edit-card">
	              <div className="edit-card__title">Details</div>
	              <div className="space-y-3">
	                <div className="edit-card__detail edit-card__detail--field">
	                  <input
	                    value={image}
	                    onChange={(e) => setImage(e.target.value)}
	                    className="edit-field-input"
	                    placeholder="Image URL"
	                    readOnly={isReadOnly}
	                  />
	                </div>
                <div className="edit-card__detail edit-card__detail--field">
                  <input
                    value={geohash}
                    onChange={(e) => setGeohash(e.target.value)}
                    className="edit-field-input"
                    placeholder="Geohash (optional)"
                    readOnly={isReadOnly}
                  />
                </div>
                {!allDay && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <div className="text-xs text-secondary">Start TZID</div>
                      <input
                        value={startTzid}
                        onChange={(e) => setStartTzid(e.target.value)}
                        className="edit-field-input"
                        placeholder={systemTimeZone}
                        readOnly={isReadOnly}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-secondary">End TZID</div>
                      <input
                        value={endTzid}
                        onChange={(e) => setEndTzid(e.target.value)}
                        className="edit-field-input"
                        placeholder={startTzid || systemTimeZone}
                        readOnly={isReadOnly}
                      />
                    </div>
                  </div>
                )}
                <div className="edit-card__detail edit-card__detail--field">
                  <input
                    value={hashtagsText}
                    onChange={(e) => setHashtagsText(e.target.value)}
                    className="edit-field-input"
                    placeholder="Hashtags (comma-separated)"
                    readOnly={isReadOnly}
                  />
                </div>
	                <div className="edit-card__detail edit-card__detail--field">
	                  <textarea
	                    value={referencesText}
	                    onChange={(e) => setReferencesText(e.target.value)}
	                    className="edit-field-textarea"
	                    rows={3}
	                    placeholder="References / links (one per line)"
	                    readOnly={isReadOnly}
	                  />
	                </div>
	              </div>
	            </section>
	            <section className="edit-card">
	              <div className="edit-card__title">Additional Locations</div>
	              <div className="space-y-2">
	                {locations.slice(1).length === 0 ? (
	                  <div className="text-xs text-secondary">No additional locations.</div>
	                ) : (
	                  locations.slice(1).map((loc, extraIdx) => {
	                    const idx = extraIdx + 1;
	                    return (
	                      <div key={idx} className="edit-card__detail edit-card__detail--field flex items-center gap-2">
	                        <input
	                          value={loc}
	                          onChange={(e) => handleChangeLocation(idx, e.target.value)}
	                          className="edit-field-input flex-1"
	                          placeholder="Additional location"
	                          readOnly={isReadOnly}
	                        />
	                        <button
	                          type="button"
	                          className="ghost-button button-sm pressable text-rose-400"
	                          onClick={() => handleRemoveLocation(idx)}
	                          aria-label="Remove location"
	                          disabled={isReadOnly}
	                        >
	                          ×
	                        </button>
	                      </div>
	                    );
	                  })
	                )}
	                <div className="edit-card__detail">
	                  <button
	                    type="button"
	                    className="ghost-button button-sm pressable"
	                    onClick={handleAddLocation}
	                    disabled={isReadOnly}
	                  >
	                    Add location
	                  </button>
	                </div>
	              </div>
	            </section>

	            <section className="edit-card">
	              <div className="edit-card__title">Invitees (advanced)</div>
	              <div className="space-y-2">
	                {participants.length === 0 ? (
	                  <div className="text-xs text-secondary">No invitees yet.</div>
	                ) : (
	                  participants.map((participant, idx) => {
	                    const normalizedPubkey = normalizeNostrPubkeyHex(participant.pubkey);
	                    const contact = normalizedPubkey ? contactByPubkey.get(normalizedPubkey) : undefined;
	                    const contactLabel = contact ? contactPrimaryName(contact) : "";
	                    const invalidPubkey = !!(participant.pubkey || "").trim() && !normalizedPubkey;
	                    return (
	                      <div key={idx} className="space-y-2 rounded-2xl border border-surface bg-surface-muted p-3">
	                        {contactLabel ? <div className="text-xs text-secondary">{contactLabel}</div> : null}
	                        <div className="flex items-center gap-2">
	                          <input
	                            value={participant.pubkey}
	                            onChange={(e) => handleChangeParticipant(idx, { pubkey: e.target.value })}
	                            className="edit-field-input flex-1"
	                            placeholder="npub or hex pubkey"
	                            readOnly={isReadOnly}
	                          />
	                          <button
	                            type="button"
	                            className="ghost-button button-sm pressable text-rose-400"
	                            onClick={() => handleRemoveParticipant(idx)}
	                            aria-label="Remove invitee"
	                            disabled={isReadOnly}
	                          >
	                            Delete
	                          </button>
	                        </div>
	                        {invalidPubkey ? <div className="text-xs text-rose-400">Invalid pubkey</div> : null}
	                        <div className="grid grid-cols-2 gap-2">
	                          <input
	                            value={participant.role || ""}
	                            onChange={(e) => handleChangeParticipant(idx, { role: e.target.value })}
	                            className="edit-field-input"
	                            placeholder="Role (optional)"
	                            readOnly={isReadOnly}
	                          />
	                          <input
	                            value={participant.relay || ""}
	                            onChange={(e) => handleChangeParticipant(idx, { relay: e.target.value })}
	                            className="edit-field-input"
	                            placeholder="Relay hint (optional)"
	                            readOnly={isReadOnly}
	                          />
	                        </div>
	                      </div>
	                    );
	                  })
	                )}
              </div>
            </section>
          </>
        )}
	        </div>
	      </Modal>

	      <ActionSheet
	        open={invitePickerOpen}
	        onClose={() => {
	          setInvitePickerOpen(false);
	          setInviteSearch("");
        }}
        title="Invitees"
        stackLevel={90}
      >
        <div className="space-y-3">
          <div className="edit-card__detail edit-card__detail--field">
            <input
              value={inviteSearch}
              onChange={(e) => setInviteSearch(e.target.value)}
              className="edit-field-input"
              placeholder="Search contacts"
              readOnly={isReadOnly}
            />
          </div>
          {filteredInviteContacts.length ? (
            <div className="space-y-2">
              {filteredInviteContacts.map((contact) => {
                const pubkey = resolveInviteInput(contact?.npub ?? "");
                if (!pubkey) return null;
                const label = contactPrimaryName(contact);
                const subtitle = formatContactNpub(contact.npub);
                const selected = invitedPubkeys.has(pubkey);
                return (
                  <button
                    key={contact.id}
                    type="button"
                    className="contact-row pressable"
                    onClick={() => handleToggleInviteContact(contact)}
                    aria-pressed={selected}
                    disabled={isReadOnly}
                  >
                    <div className="contact-avatar">{contactInitials(label)}</div>
                    <div className="contact-row__text">
                      <div className="contact-row__name flex items-center gap-2">
                        <span className="min-w-0 truncate">{label}</span>
                        {selected ? (
                          <span className="text-xs text-secondary" aria-label="Invited">
                            ✓
                          </span>
                        ) : null}
                      </div>
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
            <div className="text-sm text-secondary">No contacts found.</div>
          )}
          {/* Manual npub entry for contacts not in the list */}
          <div className="space-y-1">
            <div className="text-xs text-secondary">Or invite by npub / hex pubkey</div>
            <div className="flex gap-2">
              <input
                value={manualInviteNpub}
                onChange={(e) => setManualInviteNpub(e.target.value)}
                className="edit-field-input flex-1"
                placeholder="npub1... or hex pubkey"
                readOnly={isReadOnly}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddManualInvitee(); }}
              />
              <button
                type="button"
                className="ghost-button button-sm pressable"
                onClick={handleAddManualInvitee}
                disabled={isReadOnly || !resolveInviteInput(manualInviteNpub)}
              >
                Add
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="ghost-button button-sm pressable flex-1 justify-center"
              onClick={() => {
                setInvitePickerOpen(false);
                setInviteSearch("");
                setManualInviteNpub("");
              }}
            >
              Done
            </button>
          </div>
        </div>
      </ActionSheet>

      <ActionSheet
        open={shareEventPickerOpen}
        onClose={() => {
          if (shareEventBusy) return;
          setShareEventPickerOpen(false);
          setShareEventStatus(null);
        }}
        title="Send event"
        stackLevel={85}
      >
        <div className="text-sm text-secondary mb-2">
          Choose a contact to send <span className="font-semibold">{title.trim() || "this event"}</span>.
        </div>
        {shareEventStatus && (
          <div className="text-sm text-rose-400 mb-2">{shareEventStatus}</div>
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
                  disabled={shareEventBusy}
                  onClick={() => handleShareEventToContact(contact)}
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
              if (shareEventBusy) return;
              setShareEventPickerOpen(false);
              setShareEventStatus(null);
            }}
            disabled={shareEventBusy}
          >
            Cancel
          </button>
        </div>
      </ActionSheet>

      <CustomReminderSheet
        open={customReminderSheetOpen}
        onClose={() => setCustomReminderSheetOpen(false)}
        anchorISO={reminderAnchorISO}
        anchorTimeZone={hasEventTime ? safeStartTzid : systemTimeZone}
        anchorLabel={hasEventTime ? "event start" : "reminder time"}
        onApply={handleApplyCustomReminder}
      />

      <TimeZoneSheet
        open={timeZoneSheetOpen}
        onClose={() => setTimeZoneSheetOpen(false)}
        options={timeZoneOptions}
		        selectedTimeZone={safeStartTzid}
	        onSelect={(timeZone) => {
	          setStartTzid(timeZone);
		          setEndTzid(timeZone);
		        }}
		      />

		      <RepeatPickerSheet
		        open={repeatSheetOpen}
		        onClose={() => setRepeatSheetOpen(false)}
		        rule={rule}
	        scheduledDate={startDate}
	        onSelect={handleRepeatSelect}
	        onOpenCustom={handleOpenCustomRepeat}
	        onOpenAdvanced={handleOpenAdvancedRepeat}
	      />
	      <RepeatCustomSheet
	        open={repeatCustomSheetOpen}
	        onClose={() => setRepeatCustomSheetOpen(false)}
	        scheduledDate={startDate}
	        rule={rule}
	        onApply={handleRepeatSelect}
	        onOpenAdvanced={handleOpenAdvancedRepeat}
	      />
        <EndRepeatSheet
          open={endRepeatSheetOpen}
          onClose={() => setEndRepeatSheetOpen(false)}
          rule={rule}
          scheduledDate={startDate}
          timeZone={allDay ? "UTC" : safeStartTzid}
          onSelect={(untilISO) =>
            setRule((prev) => {
              const next: Recurrence = { ...prev };
              if (untilISO) {
                next.untilISO = untilISO;
              } else {
                delete next.untilISO;
              }
              return next;
            })
          }
        />
	      {recurrenceModalOpen && (
	        <RecurrenceModal
	          initial={rule}
	          onClose={() => setRecurrenceModalOpen(false)}
	          onApply={(next) => {
	            setRule(next);
	            setRecurrenceModalOpen(false);
	          }}
	        />
	      )}
	    </>
	  );
}

export default EventEditModal;
