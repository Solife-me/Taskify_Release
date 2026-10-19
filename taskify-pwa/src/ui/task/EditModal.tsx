import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { NoteMarkdownView } from "./NoteMarkdown";
import { NoteEditorModal } from "./NoteModals";
import { nip19 } from "nostr-tools";
import { normalizeTaskAssignmentStatus, todayDateKey } from "taskify-core";

// Sub-sheet components
import { TimeZoneSheet } from "../reminders/TimeZoneSheet";

// Domain types
import type { Task, TaskAssignee, Board, TaskPriority, Recurrence, Subtask, ReminderPreset, Weekday } from "../../domains/tasks/taskTypes";
import { TASK_PRIORITY_MARKS } from "../../domains/tasks/taskTypes";

// Task utilities
import {
  normalizeTaskPriority,
  normalizeTaskBounty,
} from "../../domains/tasks/taskUtils";

// Board utilities
import {
  isFrequentRecurrence,
  hiddenUntilForBoard,
} from "../../domains/tasks/boardUtils";

// Contact utilities
import {
  compressedToRawHex,
  loadNip05Cache,
  type Nip05CheckState,
} from "../../domains/tasks/contactUtils";

// Date/time utilities
import {
  isoDatePart,
  isoTimePart,
  isoFromDateTime,
  formatTimeLabel,
  resolveSystemTimeZone,
  normalizeTimeZone,
  currentTimeValue,
} from "../../domains/dateTime/dateUtils";

// Timezone utilities
import {
  formatTimeZoneDisplay,
  getTimeZoneOptions,
} from "../../domains/dateTime/timezoneUtils";

// Reminder utilities
import {
  normalizeReminderTime,
  DEFAULT_DATE_REMINDER_TIME,
  type ReminderPresetMode,
} from "../../domains/dateTime/reminderUtils";

// Calendar picker
import { DatePickerCalendar } from "../../domains/dateTime/calendarPickerHook";

// Lib
import { normalizeNostrPubkey } from "../../lib/nostr";
import type { Contact } from "../../lib/contacts";
import {
  contactPrimaryName,
  formatContactNpub,
  loadContactsFromStorage,
  contactHasNpub,
} from "../../lib/contacts";
import {
  readDocumentsFromFiles,
  type TaskDocument,
} from "../../lib/documents";
import { encryptAndUploadAttachment } from "../../lib/attachmentCrypto";
import { createUploadingDocumentRow, markStaleUploadingRowsIndeterminate, removeUploadingDocumentRow, setUploadingDocumentRowPhase, updateUploadingDocumentRowProgress, type UploadingDocumentRow } from "./uploadProgress";
import { findServerEntry, parseFileServers, type FileServerEntry } from "../../lib/fileStorage";
import {
  buildTaskShareEnvelope,
  sendShareMessage,
  type SharedTaskPayload,
} from "../../lib/shareInbox";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";

// Nostr crypto
import { hexToBytes } from "../../domains/nostr/nostrCrypto";

// Backup utils

// Context hooks
import { useToast } from "../../context/ToastContext";

// UI components
import { Modal } from "../Modal";
import { ActionSheet } from "../../components/ActionSheet";

// Local Storage Keys
import {
  LS_LIGHTNING_CONTACTS,
  LS_CONTACT_NIP05_CACHE,
} from "../../localStorageKeys";
import { shortenPubkey, toNpubKey } from "./pubkeyLabels";
import { TaskBountyToken } from "./TaskBountyToken";
import { WheelTimePicker } from "../editor/fields/WheelTimePicker";
import { ReminderChips } from "../editor/fields/ReminderChips";
import { RepeatField } from "../editor/fields/RepeatField";
import { AttachmentList } from "../editor/fields/AttachmentList";
import { ContactRow } from "../editor/fields/ContactRow";
import { ContactShareSheet } from "../editor/fields/ContactShareSheet";
import { reminderSelectionSummary } from "../../domains/dateTime/reminderSelection";
import type { TaskBountyExtension } from "./taskBountyExtension";

// ---- Local types ----

// ---- Local constants ----

const R_NONE: Recurrence = { type: "none" };

// ---- Local utility functions ----

async function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


function normalizeAssigneePubkey(value: string | null | undefined): string | null {
  const normalized = normalizeNostrPubkey(value);
  const raw = compressedToRawHex(normalized ?? (value || "")).toLowerCase();
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

function normalizeAssigneeList(value: Task["assignees"] | undefined): TaskAssignee[] {
  if (!Array.isArray(value)) return [];
  const normalized: TaskAssignee[] = [];
  const seen = new Set<string>();
  value.forEach((assignee) => {
    const pubkey = normalizeAssigneePubkey(assignee?.pubkey);
    if (!pubkey || seen.has(pubkey)) return;
    seen.add(pubkey);
    const relay = typeof assignee?.relay === "string" ? assignee.relay.trim() : "";
    const status = normalizeTaskAssignmentStatus(assignee?.status) as TaskAssignee["status"] | undefined;
    const respondedAtRaw = Number(assignee?.respondedAt);
    const respondedAt = Number.isFinite(respondedAtRaw) && respondedAtRaw > 0 ? Math.round(respondedAtRaw) : undefined;
    normalized.push({
      pubkey,
      ...(relay ? { relay } : {}),
      ...(status ? { status } : {}),
      ...(respondedAt ? { respondedAt } : {}),
    });
  });
  return normalized;
}

// ---- Sub-components are imported from App.tsx until extracted ----
// These are forward declarations for components still in App.tsx.
// They will be properly extracted in subsequent refactor steps.

/* Edit modal with Advanced recurrence */
function EditModal({ task, onCancel, onDelete, onSave, onSwitchToEvent, weekStart, boardKind, boards, onRevealBounty, onPreviewDocument, bountyExtension, defaultRelays, nostrPK, nostrSkHex, fileServers, fileStorageServer }: {
  task: Task;
  onCancel: ()=>void;
  onDelete: ()=>void;
  onSave: (t: Task)=>void | Promise<void>;
  onSwitchToEvent?: (t: Task)=>void;
  weekStart: Weekday;
  boardKind: Board["kind"];
  boards: Board[];
  /** Decrypts a bounty locked to this user (Nostr keys only; no wallet needed). */
  onRevealBounty?: (taskId: string)=>Promise<void>;
  onPreviewDocument?: (task: Task, doc: TaskDocument) => void;
  /** Bounty editing, provided by the wallet where it is enabled; otherwise bounties are copy-only. */
  bountyExtension?: TaskBountyExtension;
  defaultRelays: string[];
  nostrPK: string;
  nostrSkHex: string;
  fileServers: string;
  fileStorageServer: string;
}) {
  const [title, setTitle] = useState(task.title);
  const [priority, setPriority] = useState<TaskPriority | 0>(() => normalizeTaskPriority(task.priority) ?? 0);
  const [prioritySheetOpen, setPrioritySheetOpen] = useState(false);
  const [note, setNote] = useState(task.note || "");
  const [noteEditorOpen, setNoteEditorOpen] = useState(false);
  const [images, setImages] = useState<string[]>(task.images || []);
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [documents, setDocuments] = useState<TaskDocument[]>(task.documents || []);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadingLabel, setUploadingLabel] = useState<string | null>(null);
  const [uploadingDocumentRows, setUploadingDocumentRows] = useState<UploadingDocumentRow[]>([]);
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks || []);
  const [newSubtask, setNewSubtask] = useState("");
  const [selectedBoardId, setSelectedBoardId] = useState(task.boardId);
  const [selectedColumnId, setSelectedColumnId] = useState(task.columnId || "");
  const newSubtaskRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const dragSubtaskIdRef = useRef<string | null>(null);
  const [rule, setRule] = useState<Recurrence>(task.recurrence ?? R_NONE);
  const initialDateEnabled = task.dueDateEnabled !== false;
  const systemTimeZone = useMemo(() => resolveSystemTimeZone(), []);
  const initialTimeZone = useMemo(
    () => normalizeTimeZone(task.dueTimeEnabled ? task.dueTimeZone : undefined) ?? systemTimeZone,
    [systemTimeZone, task.dueTimeEnabled, task.dueTimeZone],
  );
  const initialDate = initialDateEnabled ? isoDatePart(task.dueISO, initialTimeZone) : "";
  const initialTime = initialDateEnabled ? isoTimePart(task.dueISO, initialTimeZone) : "";
  const defaultHasTime = initialDateEnabled && (task.dueTimeEnabled ?? false);
  // Only use the task's stored time as the default if time was actually enabled.
  // Otherwise (time disabled / new task) default to current time rounded to next hour,
  // so the picker opens at "now" instead of a stale or midnight time from dueISO.
  const defaultTimeValue = defaultHasTime ? initialTime : currentTimeValue(0, initialTimeZone);
  const [scheduledDate, setScheduledDate] = useState(initialDate);
  const [scheduledTime, setScheduledTime] = useState<string>(defaultHasTime ? initialTime : "");
  const [scheduledTimeZone, setScheduledTimeZone] = useState(initialTimeZone);
  const [timeZoneSheetOpen, setTimeZoneSheetOpen] = useState(false);
  const initialReminderTime = normalizeReminderTime(task.reminderTime) ?? DEFAULT_DATE_REMINDER_TIME;
  const [reminderSelection, setReminderSelection] = useState<ReminderPreset[]>(task.reminders ?? []);
  const [reminderTime, setReminderTime] = useState<string>(initialReminderTime);
  const lastTimeRef = useRef<string>(defaultTimeValue);
  const [dateEnabled, setDateEnabled] = useState(() => initialDateEnabled && !!initialDate);
  const hasDueTime = dateEnabled && scheduledTime.trim().length > 0;
  const [dateDetailsOpen, setDateDetailsOpen] = useState(false);
  const [calendarBaseDate, setCalendarBaseDate] = useState(initialDate);
  const [reminderPickerExpanded, setReminderPickerExpanded] = useState(false);
  const [subtasksExpanded, setSubtasksExpanded] = useState(false);
  const [locationExpanded, setLocationExpanded] = useState(false);
  const [assigneesExpanded, setAssigneesExpanded] = useState(false);
  const [timeDetailsOpen, setTimeDetailsOpen] = useState(false);
  const [reminderTimeDetailsOpen, setReminderTimeDetailsOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>(() => loadContactsFromStorage());
  const prefetchedContactPhotos = useRef<Set<string>>(new Set());
  const [nip05Cache, setNip05Cache] = useState<Record<string, Nip05CheckState>>(() =>
    typeof window !== "undefined" ? loadNip05Cache() : {},
  );
  const [shareTaskPickerOpen, setShareTaskPickerOpen] = useState(false);
  const [shareTaskStatus, setShareTaskStatus] = useState<string | null>(null);
  const [shareTaskBusy, setShareTaskBusy] = useState(false);
  const [assignees, setAssignees] = useState<TaskAssignee[]>(() => normalizeAssigneeList(task.assignees));
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [assigneeInput, setAssigneeInput] = useState("");
  const [assigneeInputError, setAssigneeInputError] = useState<string | null>(null);
  const { show: showToast } = useToast();
  const availableBoards = useMemo(() => {
    const base = boards.filter(
      (board) => !board.archived && !board.hidden && board.kind !== "bible" && board.kind !== "compound",
    );
    if (!base.some((board) => board.id === task.boardId)) {
      const fallback = boards.find((board) => board.id === task.boardId);
      if (fallback) return [fallback, ...base];
    }
    return base;
  }, [boards, task.boardId]);
  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedBoardId) || null,
    [boards, selectedBoardId],
  );
  const selectedBoardKind = selectedBoard?.kind ?? boardKind;
  const selectedServerEntry = useMemo<FileServerEntry>(() => {
    const servers = parseFileServers(fileServers);
    return findServerEntry(servers, fileStorageServer) || { url: fileStorageServer, type: "nip96" };
  }, [fileServers, fileStorageServer]);
  const isSharedBoard = !!selectedBoard?.nostr;
  const locationSummary = useMemo(() => {
    if (!selectedBoard) return "Select board";
    const boardLabel = selectedBoard.name || "Board";
    if (selectedBoard.kind === "lists") {
      const list = selectedBoard.columns.find((column) => column.id === selectedColumnId);
      if (list) return `${boardLabel} • ${list.name}`;
      if (selectedBoard.columns.length === 0) return `${boardLabel} • No lists`;
      return `${boardLabel} • Choose list`;
    }
    return boardLabel;
  }, [selectedBoard, selectedColumnId]);
  useEffect(() => {
    setSelectedBoardId(task.boardId);
    setSelectedColumnId(task.columnId || "");
  }, [task.boardId, task.columnId, task.id]);
  useEffect(() => {
    setAssignees(normalizeAssigneeList(task.assignees));
    setAssigneeSearch("");
    setAssigneeInput("");
    setAssigneeInputError(null);
    setAssigneesExpanded(false);
  }, [task.assignees, task.id]);
  useEffect(() => {
    if (!availableBoards.length) return;
    if (!availableBoards.some((board) => board.id === selectedBoardId)) {
      setSelectedBoardId(availableBoards[0].id);
    }
  }, [availableBoards, selectedBoardId]);
  useEffect(() => {
    if (!selectedBoard || selectedBoard.kind !== "lists") {
      if (selectedColumnId) setSelectedColumnId("");
      return;
    }
    const hasColumn = selectedBoard.columns.some((column) => column.id === selectedColumnId);
    if (!hasColumn) {
      setSelectedColumnId(selectedBoard.columns[0]?.id || "");
    }
  }, [selectedBoard, selectedColumnId]);
  const streakEligible = isFrequentRecurrence(rule);
  const currentStreak = typeof task.streak === "number" ? task.streak : 0;
  const bestStreak = Math.max(
    currentStreak,
    typeof task.longestStreak === "number" ? task.longestStreak : currentStreak,
  );
  const shareableContacts = useMemo(
    () => contacts.filter((contact) => contactHasNpub(contact)),
    [contacts],
  );
  const assigneeContactByPubkey = useMemo(() => {
    const map = new Map<string, Contact>();
    contacts.forEach((contact) => {
      const pubkey = normalizeAssigneePubkey(contact?.npub);
      if (pubkey) map.set(pubkey, contact);
    });
    return map;
  }, [contacts]);
  const assignedPubkeys = useMemo(() => new Set(assignees.map((assignee) => assignee.pubkey)), [assignees]);
  const filteredAssigneeContacts = useMemo(() => {
    const q = assigneeSearch.trim().toLowerCase();
    if (!q) return shareableContacts;
    return shareableContacts.filter((contact) => {
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
  }, [assigneeSearch, shareableContacts]);
  const assigneesLabel = useMemo(() => {
    const count = assignees.length;
    if (!count) return "None";
    return `${count} assigned`;
  }, [assignees.length]);
  const assigneeIdentity = useCallback((assignee: TaskAssignee): { label: string; subtitle: string } => {
    const contact = assigneeContactByPubkey.get(assignee.pubkey);
    if (contact) {
      return {
        label: contactPrimaryName(contact),
        subtitle: formatContactNpub(contact.npub),
      };
    }
    const npub = toNpubKey(assignee.pubkey);
    return {
      label: shortenPubkey(npub),
      subtitle: npub,
    };
  }, [assigneeContactByPubkey]);
  const assigneesPreview = useMemo(() => {
    if (!assignees.length) return "No assignees";
    const labels = assignees.slice(0, 2).map((assignee) => assigneeIdentity(assignee).label);
    const remainder = assignees.length - labels.length;
    return remainder > 0 ? `${labels.join(", ")} +${remainder}` : labels.join(", ");
  }, [assigneeIdentity, assignees]);

  const upsertAssignee = useCallback((pubkey: string, relay?: string) => {
    setAssignees((prev) => {
      const normalizedPubkey = normalizeAssigneePubkey(pubkey);
      if (!normalizedPubkey) return prev;
      const relayHint = typeof relay === "string" ? relay.trim() : "";
      const next = prev.slice();
      const existingIndex = next.findIndex((assignee) => assignee.pubkey === normalizedPubkey);
      if (existingIndex >= 0) {
        const existing = next[existingIndex];
        next[existingIndex] = {
          ...existing,
          ...(relayHint ? { relay: relayHint } : {}),
          status: "pending",
          respondedAt: undefined,
        };
        return next;
      }
      return [...next, { pubkey: normalizedPubkey, ...(relayHint ? { relay: relayHint } : {}), status: "pending" }];
    });
  }, []);

  const toggleAssigneeContact = useCallback((contact: Contact) => {
    const pubkey = normalizeAssigneePubkey(contact?.npub);
    if (!pubkey) return;
    const relayHint = Array.isArray(contact?.relays)
      ? contact.relays.map((entry) => (typeof entry === "string" ? entry.trim() : "")).find(Boolean) || ""
      : "";
    setAssignees((prev) => {
      const exists = prev.some((assignee) => assignee.pubkey === pubkey);
      if (exists) {
        return prev.filter((assignee) => assignee.pubkey !== pubkey);
      }
      return [...prev, { pubkey, ...(relayHint ? { relay: relayHint } : {}), status: "pending" }];
    });
  }, []);

  const removeAssignee = useCallback((pubkey: string) => {
    setAssignees((prev) => prev.filter((assignee) => assignee.pubkey !== pubkey));
  }, []);

  const addAssigneeFromInput = useCallback(() => {
    const trimmed = assigneeInput.trim();
    if (!trimmed) return;
    const pubkey = normalizeAssigneePubkey(trimmed);
    if (!pubkey) {
      setAssigneeInputError("Enter a valid npub or hex pubkey.");
      return;
    }
    upsertAssignee(pubkey);
    setAssigneeInput("");
    setAssigneeInputError(null);
  }, [assigneeInput, upsertAssignee]);

  const assigneeStatusLabel = useCallback((assignee: TaskAssignee): string => {
    const status = assignee.status ?? "pending";
    if (status === "accepted") return "Accepted";
    if (status === "declined") return "Declined";
    if (status === "tentative") return "Maybe";
    return "Pending";
  }, []);

  const assigneeStatusChipClass = useCallback((assignee: TaskAssignee): string => {
    const status = assignee.status ?? "pending";
    if (status === "accepted") return "chip-accent";
    if (status === "declined") return "chip-danger";
    if (status === "tentative") return "chip-warn";
    return "";
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const urls = new Set<string>();
    contacts.forEach((contact) => {
      const url = (contact.picture || "").trim();
      if (url) urls.add(url);
    });
    const newUrls = Array.from(urls).filter((url) => !prefetchedContactPhotos.current.has(url));
    if (!newUrls.length) return;
    const images: HTMLImageElement[] = [];
    newUrls.forEach((url) => {
      try {
        const img = new Image();
        img.src = url;
        images.push(img);
        prefetchedContactPhotos.current.add(url);
      } catch {}
    });
    return () => {
      images.forEach((img) => {
        try {
          img.src = "";
        } catch {}
      });
    };
  }, [contacts]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleContactsUpdated = () => {
      setContacts(loadContactsFromStorage());
    };
    const handleNip05CacheUpdated = () => {
      setNip05Cache(loadNip05Cache());
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LS_LIGHTNING_CONTACTS) {
        handleContactsUpdated();
      } else if (event.key === LS_CONTACT_NIP05_CACHE) {
        handleNip05CacheUpdated();
      }
    };
    window.addEventListener("taskify:contacts-updated", handleContactsUpdated);
    window.addEventListener("taskify:nip05-cache-updated", handleNip05CacheUpdated);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("taskify:contacts-updated", handleContactsUpdated);
      window.removeEventListener("taskify:nip05-cache-updated", handleNip05CacheUpdated);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const { options: timeZoneOptions, map: timeZoneOptionMap } = useMemo(() => getTimeZoneOptions(), []);
  const safeScheduledTimeZone = useMemo(
    () => normalizeTimeZone(scheduledTimeZone) ?? systemTimeZone,
    [scheduledTimeZone, systemTimeZone],
  );
  const timeZoneLabel = useMemo(
    () => formatTimeZoneDisplay(safeScheduledTimeZone, timeZoneOptionMap),
    [safeScheduledTimeZone, timeZoneOptionMap],
  );

  const reminderPresetMode: ReminderPresetMode = hasDueTime ? "timed" : "date";
  const priorityOptions = useMemo(
    () => [
      { value: 0, label: "None" },
      { value: 1, label: "Low", marks: TASK_PRIORITY_MARKS[1] },
      { value: 2, label: "Medium", marks: TASK_PRIORITY_MARKS[2] },
      { value: 3, label: "High", marks: TASK_PRIORITY_MARKS[3] },
    ],
    [],
  );
  const prioritySelection = useMemo(
    () => priorityOptions.find((option) => option.value === priority) ?? priorityOptions[0],
    [priority, priorityOptions],
  );

  const reminderSummary = useMemo(
    () => reminderSelectionSummary(reminderSelection, reminderPresetMode),
    [reminderPresetMode, reminderSelection],
  );
  const dateSummary = useMemo(() => {
    if (!scheduledDate) return "Not set";
    const parsed = new Date(`${scheduledDate}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return scheduledDate;
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diffDays = Math.round((parsed.getTime() - startOfToday.getTime()) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays === -1) return "Yesterday";
    return parsed.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }, [scheduledDate]);
  const timeSummary = useMemo(() => {
    if (!hasDueTime) return "Off";
    return formatTimeLabel(
      isoFromDateTime(scheduledDate, scheduledTime, safeScheduledTimeZone),
      safeScheduledTimeZone,
    );
  }, [hasDueTime, safeScheduledTimeZone, scheduledDate, scheduledTime]);
  const reminderTimeSummary = useMemo(
    () =>
      formatTimeLabel(
        isoFromDateTime(
          scheduledDate || todayDateKey(),
          reminderTime || DEFAULT_DATE_REMINDER_TIME,
          systemTimeZone,
        ),
        systemTimeZone,
      ),
    [reminderTime, scheduledDate, systemTimeZone],
  );
  const reminderRowSummary = useMemo(() => {
    if (!dateEnabled) return "Enable date";
    if (!reminderSelection.length) return "None";
    return reminderSummary;
  }, [dateEnabled, reminderSelection.length, reminderSummary]);
  const reminderAnchorISO = useMemo(() => {
    if (!dateEnabled || !scheduledDate) return null;
    if (hasDueTime) {
      const iso = isoFromDateTime(scheduledDate, scheduledTime || defaultTimeValue, safeScheduledTimeZone);
      return Number.isNaN(Date.parse(iso)) ? null : iso;
    }
    const reminderClock = normalizeReminderTime(reminderTime) ?? DEFAULT_DATE_REMINDER_TIME;
    const iso = isoFromDateTime(scheduledDate, reminderClock, systemTimeZone);
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }, [dateEnabled, defaultTimeValue, hasDueTime, reminderTime, safeScheduledTimeZone, scheduledDate, scheduledTime, systemTimeZone]);
  useEffect(() => {
    if (scheduledDate) {
      setCalendarBaseDate(scheduledDate);
    }
  }, [scheduledDate]);

  useEffect(() => {
    if (!dateEnabled && reminderSelection.length) {
      setReminderSelection([]);
    }
  }, [dateEnabled, reminderSelection.length]);
  useEffect(() => {
    if (!dateEnabled) {
      setDateDetailsOpen(false);
      setReminderPickerExpanded(false);
      setReminderTimeDetailsOpen(false);
    }
  }, [dateEnabled]);
  useEffect(() => {
    if (selectedBoardKind !== "week" || dateEnabled) return;
    const todayISO = todayDateKey();
    setScheduledDate((prev) => prev || todayISO);
    setCalendarBaseDate((prev) => prev || todayISO);
    setDateEnabled(true);
  }, [dateEnabled, selectedBoardKind]);
  useEffect(() => {
    if (!hasDueTime) {
      setTimeDetailsOpen(false);
    } else {
      setReminderTimeDetailsOpen(false);
    }
  }, [hasDueTime]);
  useEffect(() => {
    if (!reminderPickerExpanded) {
      setReminderTimeDetailsOpen(false);
    }
  }, [reminderPickerExpanded]);
  useEffect(() => {
    setCalendarBaseDate(initialDate);
  }, [task.id, initialDate]);
  useEffect(() => {
    setScheduledTimeZone(initialTimeZone);
  }, [initialTimeZone, task.id]);
  useEffect(() => {
    setReminderTime(initialReminderTime);
  }, [initialReminderTime, task.id]);

  useEffect(() => {
    if (hasDueTime && scheduledTime) {
      lastTimeRef.current = scheduledTime;
    }
  }, [hasDueTime, scheduledTime]);



  async function uploadSharedImage(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return encryptAndUploadAttachment({
      boardId: selectedBoard!.nostr!.boardId,
      data: bytes,
      mimeType: file.type || "application/octet-stream",
      filename: file.name || "image",
      serverEntry: selectedServerEntry,
      nostrSkHex,
    });
  }

  async function uploadSharedDocument(file: File, doc: TaskDocument, handlers?: { onProgress?: (progress: number) => void; onPhaseChange?: (phase: "uploading" | "processing") => void }): Promise<TaskDocument> {
    console.info("[attachment-debug] shared-document:start", {
      filename: file.name,
      fileType: file.type,
      fileBytes: file.size,
      docKind: doc.kind,
      docMimeType: doc.mimeType,
      boardId: selectedBoard?.nostr?.boardId,
      serverUrl: selectedServerEntry?.url,
      serverType: selectedServerEntry?.type,
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const remoteUrl = await encryptAndUploadAttachment({
      boardId: selectedBoard!.nostr!.boardId,
      data: bytes,
      mimeType: doc.mimeType || file.type || "application/octet-stream",
      filename: doc.name || file.name || "document",
      serverEntry: selectedServerEntry,
      nostrSkHex,
      onProgress: (progress) => handlers?.onProgress?.(progress),
      onPhaseChange: (phase) => handlers?.onPhaseChange?.(phase),
    });
    const { dataUrl, preview, full, ...rest } = doc as any;
    return { ...rest, remoteUrl, encrypted: true, encryptionBoardId: selectedBoard!.nostr!.boardId };
  }

  async function attachSingleDocument(file: File, fallbackLabel: string): Promise<TaskDocument> {
    const label = file.name || fallbackLabel;
    setUploadingLabel(`Preparing ${label}…`);
    const docs = await readDocumentsFromFiles([file] as File[]);
    const doc = docs[0];
    if (!doc) {
      throw new Error(`Could not read ${label}. The selected file may not be supported.`);
    }
    if (!isSharedBoard) return doc;

    setUploadingLabel(`Uploading ${label}…`);
    const row = createUploadingDocumentRow(doc, label);
    const rowId = row.id;
    setUploadingDocumentRows((prev) => [...prev, row]);
    try {
      const uploaded = await uploadSharedDocument(file, doc, {
        onProgress: (progress) =>
          setUploadingDocumentRows((prev) => updateUploadingDocumentRowProgress(prev, rowId, progress)),
        onPhaseChange: (phase) =>
          setUploadingDocumentRows((prev) => setUploadingDocumentRowPhase(prev, rowId, phase)),
      });
      setUploadingDocumentRows((prev) => updateUploadingDocumentRowProgress(prev, rowId, 1));
      return uploaded;
    } finally {
      setUploadingDocumentRows((prev) => removeUploadingDocumentRow(prev, rowId));
    }
  }

  async function attachDocumentsSequentially(files: File[], fallbackLabel: string): Promise<TaskDocument[]> {
    const attached: TaskDocument[] = [];
    for (const file of files) {
      const doc = await attachSingleDocument(file, fallbackLabel);
      attached.push(doc);
      setDocuments((prev) => [...prev, doc]);
      setUploadingCount((prev) => Math.max(0, prev - 1));
    }
    return attached;
  }

  useEffect(() => {
    if (!uploadingDocumentRows.length) return;
    const interval = window.setInterval(() => {
      setUploadingDocumentRows((prev) => markStaleUploadingRowsIndeterminate(prev));
    }, 300);
    return () => window.clearInterval(interval);
  }, [uploadingDocumentRows]);

  async function handlePaste(e: React.ClipboardEvent<HTMLElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs = Array.from(items).filter((it) => it.type.startsWith("image/"));
    if (!imgs.length) return;
    e.preventDefault();
    const fileList = imgs
      .map((it, index) => {
        const file = it.getAsFile();
        if (!file) return null;
        if (file.name) return file;
        const extension = (file.type || "image/png").split("/")[1] || "png";
        return new File([file], `pasted-image-${Date.now()}-${index}.${extension}`, { type: file.type || "image/png" });
      })
      .filter(Boolean) as File[];
    if (!fileList.length) return;
    try {
      setSaveError(null);
      setUploadingCount(fileList.length);
      await attachDocumentsSequentially(fileList, "pasted image");
    } catch (err: any) {
      console.error("Failed to attach pasted image", err);
      setSaveError(err?.message || "Failed to upload pasted image attachment.");
    } finally {
      setUploadingCount(0);
      setUploadingLabel(null);
    }
  }

  async function handleDocumentAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || !files.length) return;
    const fileList = Array.from(files);
    try {
      setSaveError(null);
      setUploadingCount(fileList.length);
      await attachDocumentsSequentially(fileList, "attachment");
    } catch (err: any) {
      console.error("Failed to attach document", err);
      setSaveError(err?.message || "Failed to attach document. Please use PDF, DOC/DOCX, or XLS/XLSX files.");
    } finally {
      setUploadingCount(0);
      setUploadingLabel(null);
      e.target.value = "";
    }
  }


  function addSubtask(keepKeyboard = false) {
    const title = newSubtask.trim();
    if (!title) return;
    setSubtasks(prev => [...prev, { id: crypto.randomUUID(), title, completed: false }]);
    setNewSubtask("");
    if (keepKeyboard) newSubtaskRef.current?.focus();
    else newSubtaskRef.current?.blur();
  }

  const reorderSubtasks = useCallback((sourceId: string, targetId: string | null, position: 'before' | 'after' = 'before') => {
    if (!sourceId || sourceId === targetId) return;
    setSubtasks(prev => {
      const sourceIndex = prev.findIndex(s => s.id === sourceId);
      if (sourceIndex === -1) return prev;
      const sourceItem = prev[sourceIndex];
      const remaining = prev.filter(s => s.id !== sourceId);
      if (!targetId) {
        return [...remaining, sourceItem];
      }
      const rawTargetIndex = prev.findIndex(s => s.id === targetId);
      if (rawTargetIndex === -1) return prev;
      let insertIndex = rawTargetIndex;
      if (sourceIndex < rawTargetIndex) insertIndex -= 1;
      if (position === 'after') insertIndex += 1;
      if (insertIndex < 0) insertIndex = 0;
      if (insertIndex > remaining.length) insertIndex = remaining.length;
      const next = [...remaining];
      next.splice(insertIndex, 0, sourceItem);
      return next;
    });
  }, [setSubtasks]);

  const handleSubtaskDragStart = useCallback((id: string) => (e: React.DragEvent<HTMLElement>) => {
    dragSubtaskIdRef.current = id;
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/subtask-id', id);
    } catch {}
  }, []);

  const handleSubtaskDragEnd = useCallback(() => {
    dragSubtaskIdRef.current = null;
  }, []);

  const handleSubtaskDragOver = useCallback((id: string | null) => (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragSubtaskIdRef.current) return;
    void id;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleSubtaskDrop = useCallback((id: string | null) => (e: React.DragEvent<HTMLDivElement>) => {
    const sourceHint = dragSubtaskIdRef.current || e.dataTransfer.getData('text/subtask-id');
    if (!sourceHint) return;
    e.preventDefault();
    e.stopPropagation();
    dragSubtaskIdRef.current = null;
    let position: 'before' | 'after' = 'before';
    if (id) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) position = 'after';
    } else {
      position = 'after';
    }
    reorderSubtasks(sourceHint, id, position);
  }, [reorderSubtasks]);

  function toggleDateSwitch() {
    if (selectedBoardKind === "week") {
      if (!dateEnabled) {
        const todayISO = todayDateKey();
        setScheduledDate((prev) => prev || todayISO);
        setCalendarBaseDate((prev) => prev || todayISO);
        setDateEnabled(true);
      }
      return;
    }
    setDateEnabled((prev) => {
      const next = !prev;
      if (next) {
        if (!scheduledDate) {
          const todayISO = todayDateKey();
          setScheduledDate(todayISO);
          setCalendarBaseDate(todayISO);
        } else {
          setCalendarBaseDate(scheduledDate);
        }
        setDateDetailsOpen(true);
        setTimeDetailsOpen(false);
      } else {
        setDateDetailsOpen(false);
      }
      return next;
    });
  }

  function handleDateRowToggle() {
    if (!dateEnabled) return;
    setDateDetailsOpen((prev) => {
      const next = !prev;
      if (next) {
        setTimeDetailsOpen(false);
      }
      return next;
    });
  }

  function handleToggleTime() {
    if (hasDueTime) {
      setScheduledTime("");
      setTimeDetailsOpen(false);
      setReminderTimeDetailsOpen(false);
      return;
    }
    if (!normalizeTimeZone(scheduledTimeZone)) {
      setScheduledTimeZone(systemTimeZone);
    }
    const fallback = lastTimeRef.current || defaultTimeValue;
    setScheduledTime(fallback);
    setTimeDetailsOpen(true);
    setReminderTimeDetailsOpen(false);
    setDateDetailsOpen(false);
    if (!dateEnabled) {
      const todayISO = scheduledDate || todayDateKey();
      setScheduledDate(todayISO);
      setCalendarBaseDate(todayISO);
      setDateEnabled(true);
    }
  }

  function handleTimeRowToggle() {
    if (!hasDueTime) return;
    setTimeDetailsOpen((prev) => {
      const next = !prev;
      if (next) {
        setDateDetailsOpen(false);
        setReminderTimeDetailsOpen(false);
      }
      return next;
    });
  }

  function buildTask(overrides: Partial<Task> = {}): Task {
    const targetBoardKind = selectedBoardKind;
    const effectiveDateEnabled = targetBoardKind === "week" ? true : dateEnabled;
    const baseDate = scheduledDate || initialDate || isoDatePart(task.dueISO, initialTimeZone);
    const hasTime = effectiveDateEnabled && scheduledTime.trim().length > 0;
    const dateUnchanged = baseDate === (initialDate || "");
    const timeUnchanged = hasTime === defaultHasTime && (!hasTime || scheduledTime === initialTime);
    const timeZoneUnchanged = !hasTime || safeScheduledTimeZone === initialTimeZone;
    const dueISO = effectiveDateEnabled
      ? (dateUnchanged && timeUnchanged && timeZoneUnchanged
        ? task.dueISO
        : isoFromDateTime(baseDate, hasTime ? scheduledTime : undefined, hasTime ? safeScheduledTimeZone : undefined))
      : task.dueISO;
    const targetColumnId =
      targetBoardKind === "lists"
        ? selectedColumnId || (selectedBoard?.kind === "lists" ? selectedBoard.columns[0]?.id : undefined)
        : undefined;
    const targetColumn =
      targetBoardKind === "week"
        ? "day"
        : undefined;
    const hiddenUntilISO = effectiveDateEnabled ? hiddenUntilForBoard(dueISO, targetBoardKind, weekStart) : undefined;
    const reminderValues = effectiveDateEnabled ? [...reminderSelection] : [];
    const normalizedReminderTime = normalizeReminderTime(reminderTime) ?? DEFAULT_DATE_REMINDER_TIME;
    return {
      ...task,
      boardId: selectedBoardId,
      columnId: targetBoardKind === "lists" ? targetColumnId : undefined,
      column: targetBoardKind === "week" ? targetColumn : undefined,
      title,
      priority: priority === 0 ? undefined : priority,
      note: note || undefined,
      images: images.length ? images : undefined,
      documents: documents.length ? documents : undefined,
      subtasks: subtasks.length ? subtasks : undefined,
      assignees: assignees.length ? normalizeAssigneeList(assignees) : undefined,
      recurrence: rule.type === "none" ? undefined : rule,
      dueISO,
      dueDateEnabled: effectiveDateEnabled ? true : false,
      hiddenUntilISO,
      dueTimeEnabled: hasTime ? true : undefined,
      dueTimeZone: hasTime ? safeScheduledTimeZone : undefined,
      reminders: reminderValues,
      reminderTime: effectiveDateEnabled && !hasTime ? normalizedReminderTime : undefined,
      ...overrides,
    };
  }

  async function save(overrides: Partial<Task> = {}) {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(normalizeTaskBounty(buildTask(overrides)));
    } catch (err: any) {
      console.error("Failed to save task", err);
      setSaveError(err?.message || "Failed to save task.");
      setSaving(false);
    }
  }

  async function copyCurrent() {
    const base = buildTask();
    try { await navigator.clipboard?.writeText(JSON.stringify(base)); } catch {}
  }

  function buildTaskSharePayload(): SharedTaskPayload | null {
    const base = buildTask();
    const title = base.title.trim();
    if (!title) return null;
    const subtasks = (base.subtasks || [])
      .map((subtask) => {
        const subtaskTitle = subtask.title?.trim() || "";
        if (!subtaskTitle) return null;
        return {
          title: subtaskTitle,
          completed: !!subtask.completed,
        };
      })
      .filter((subtask): subtask is { title: string; completed: boolean } => !!subtask);
    return {
      type: "task",
      title,
      note: base.note?.trim() || undefined,
      priority: base.priority,
      dueISO: base.dueISO,
      dueDateEnabled: base.dueDateEnabled,
      dueTimeEnabled: base.dueTimeEnabled,
      dueTimeZone: base.dueTimeZone,
      reminders: base.dueTimeEnabled ? (base.reminders?.length ? base.reminders : undefined) : undefined,
      subtasks: subtasks.length ? subtasks : undefined,
      recurrence: base.recurrence,
    };
  }

  async function handleShareTaskToContact(contact: Contact) {
    if (shareTaskBusy) return;
    const payload = buildTaskSharePayload();
    if (!payload) {
      setShareTaskStatus("Add a title to share this task.");
      return;
    }
    const recipient = normalizeNostrPubkey(contact.npub);
    if (!recipient) {
      setShareTaskStatus("Contact is missing a valid npub.");
      return;
    }
    if (!nostrSkHex) {
      setShareTaskStatus("Connect a Nostr key to share tasks.");
      return;
    }
    const relayList = Array.from(
      new Set(
        (defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS))
          .map((relay) => relay.trim())
          .filter(Boolean),
      ),
    );
    if (!relayList.length) {
      setShareTaskStatus("No relays configured for sharing.");
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
    setShareTaskBusy(true);
    setShareTaskStatus(null);
    try {
      const envelope = buildTaskShareEnvelope(payload, senderNpub ? { npub: senderNpub } : undefined);
      await sendShareMessage(envelope, recipient, nostrSkHex, relayList);
      setShareTaskPickerOpen(false);
      showToast(`Task sent to ${contactPrimaryName(contact)}`);
    } catch (err: any) {
      setShareTaskStatus(err?.message || "Unable to share task.");
    } finally {
      setShareTaskBusy(false);
    }
  }

  const buildTaskDraftForTypeSwitch = (): Task => {
    const updated: Task = { ...task };
    updated.title = title;
    updated.note = note;
    updated.priority = (priority ? priority : undefined) as TaskPriority | undefined;
    updated.images = images;
    updated.documents = documents;
    updated.subtasks = subtasks;

    updated.boardId = selectedBoardId;
    updated.columnId = selectedColumnId || undefined;

    if (!dateEnabled) {
      updated.dueDateEnabled = false;
      updated.dueTimeEnabled = undefined;
      updated.dueTimeZone = undefined;
      updated.reminders = undefined;
      updated.reminderTime = undefined;
    } else {
      const tz = normalizeTimeZone(scheduledTimeZone) ?? systemTimeZone;
      const datePart = scheduledDate || isoDatePart(updated.dueISO, tz);
      const timePart = scheduledTime?.trim() || "";
      updated.dueISO = isoFromDateTime(datePart, timePart || undefined, tz);
      updated.dueDateEnabled = true;
      updated.dueTimeEnabled = !!timePart;
      updated.dueTimeZone = updated.dueTimeEnabled ? tz : undefined;
      updated.reminders = reminderSelection.length ? [...reminderSelection] : undefined;
      updated.reminderTime = updated.dueTimeEnabled
        ? undefined
        : (normalizeReminderTime(reminderTime) ?? DEFAULT_DATE_REMINDER_TIME);
    }

    updated.recurrence = rule && rule.type !== "none" ? rule : undefined;
    updated.seriesId = updated.recurrence ? (updated.seriesId || updated.id) : undefined;

    return normalizeTaskBounty(updated);
  };

  const handleSwitchToEventType = () => {
    if (!onSwitchToEvent) return;
    if (task.bounty) {
      alert("Remove the ecash bounty before converting this task into a calendar event.");
      return;
    }
    onSwitchToEvent(buildTaskDraftForTypeSwitch());
  };

  return (
    <>
      <Modal onClose={() => { if (!saving && uploadingCount === 0) onCancel(); }} showClose={false} variant="fullscreen" desktop="pane">
      <div className="edit-modal">
        <div className="edit-sheet__header">
          <button
            type="button"
            className="edit-sheet__action"
            onClick={() => { if (!saving && uploadingCount === 0) onCancel(); }}
            aria-label="Close editor"
          >
            <span aria-hidden="true">×</span>
          </button>
          <div className="edit-sheet__title">Details</div>
          <button
            type="button"
            className="edit-sheet__action edit-sheet__action--accent"
            onClick={() => save()}
            aria-label="Save task"
            disabled={saving || uploadingCount > 0}
          >
            {saving || uploadingCount > 0 ? (
              <span className="text-xs px-1">…</span>
            ) : (
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M5 12l4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>

        {saveError && (
          <div className="px-4 pt-2 text-xs" style={{ color: "var(--color-rose, #f43f5e)" }}>
            {saveError}
          </div>
        )}


        {onSwitchToEvent && (
          <div className="mt-[-1rem] mb-[-1rem] w-full pb-[0.1rem]">
            <div className="w-full">
              <div className="flex w-full rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  type="button"
                  className="pressable flex-1 rounded-full px-3 py-0.5 text-sm leading-none text-secondary"
                  onClick={handleSwitchToEventType}
                >
                  Event
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-full border border-white/10 bg-white/10 px-3 py-0.5 text-sm font-medium leading-none text-primary shadow-sm"
                  aria-pressed="true"
                >
                  Task
                </button>
              </div>
            </div>
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
              />
            </div>
            <div className="edit-card__detail edit-card__detail--field space-y-2">
              <div
                role="button"
                tabIndex={0}
                className="note-field-preview"
                aria-label={note.trim() ? "Edit notes" : "Add notes"}
                onClick={(event) => {
                  // A link in the note opens the link, not the editor.
                  if ((event.target as HTMLElement).closest("a")) return;
                  setNoteEditorOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setNoteEditorOpen(true);
                  }
                }}
              >
                {note.trim() ? (
                  <NoteMarkdownView note={note} blockLimit={8} />
                ) : (
                  <span className="note-field-preview__placeholder">Notes (optional)</span>
                )}
              </div>
              {noteEditorOpen && (
                <NoteEditorModal
                  initialNote={note}
                  onPaste={handlePaste}
                  onCancel={() => setNoteEditorOpen(false)}
                  onSave={(updatedNote, convertedSubtasks) => {
                    setNote(updatedNote);
                    if (convertedSubtasks.length) {
                      setSubtasks((prev) => [...prev, ...convertedSubtasks]);
                      setSubtasksExpanded(true);
                    }
                    setNoteEditorOpen(false);
                  }}
                />
              )}
              <div className="edit-detail-actions">
                <input
                  ref={documentInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.xlsx,.txt,.md,.json,.csv,.png,.jpg,.jpeg,.webp,.gif,.mp3,.aac,.m4a,.wav,.mp4,.mov,.webm,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/markdown,application/json,text/csv,image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/aac,audio/mp4,audio/wav,video/mp4,video/quicktime,video/webm"
                  className="hidden"
                  multiple
                  onChange={handleDocumentAttach}
                />
                <button
                  type="button"
                  className="ghost-button button-sm pressable"
                  onClick={() => documentInputRef.current?.click()}
                >
                  Attach
                </button>
              </div>
            </div>
            {previewImageSrc && (
              <ImagePreviewModal src={previewImageSrc} onClose={() => setPreviewImageSrc(null)} />
            )}
            {images.length > 0 && (
              <div className="edit-media-grid">
                {images.map((img, i) => (
                  <div key={i} className="relative">
                    <img
                      src={img}
                      className="max-h-40 rounded-lg cursor-zoom-in"
                      alt="Attachment"
                      onClick={() => setPreviewImageSrc(img)}
                      role="button"
                      aria-label="View full image"
                    />
                    <button
                      type="button"
                      className="absolute top-1 right-1 rounded-full bg-black/70 px-1 text-xs"
                      onClick={() => setImages(images.filter((_, j) => j !== i))}
                      aria-label="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <AttachmentList
              documents={documents}
              uploading={uploadingDocumentRows}
              onPreview={(doc) => onPreviewDocument?.(task, doc)}
              onRemove={(id) => setDocuments((prev) => prev.filter((item) => item.id !== id))}
            />
            <div className="edit-card__detail edit-card__detail--field">
              <button
                type="button"
                className="edit-row edit-row--interactive edit-row--inline"
                onClick={() => setSubtasksExpanded((prev) => !prev)}
              >
                <span className="edit-row__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                    <path d="M6 7h12M6 12h12M6 17h12" />
                    <circle cx="4" cy="7" r="1" />
                    <circle cx="4" cy="12" r="1" />
                    <circle cx="4" cy="17" r="1" />
                  </svg>
                </span>
                <div className="edit-row__content">{subtasksExpanded ? "Hide subtasks" : "Show subtasks"}</div>
                <div className="edit-row__value">{subtasks.length}</div>
                <span className="edit-row__chevron" aria-hidden="true">›</span>
              </button>
              {subtasksExpanded && (
                <div className="space-y-2 pt-2">
                  {subtasks.map((st) => (
                    <div
                      key={st.id}
                      className="flex items-center gap-2"
                      style={{ touchAction: "auto" }}
                      draggable
                      onDragStart={handleSubtaskDragStart(st.id)}
                      onDragEnd={handleSubtaskDragEnd}
                      onDragOver={handleSubtaskDragOver(st.id)}
                      onDrop={handleSubtaskDrop(st.id)}
                    >
                      <input
                        type="checkbox"
                        checked={!!st.completed}
                        onChange={() => setSubtasks((prev) => prev.map((s) => (s.id === st.id ? { ...s, completed: !s.completed } : s)))}
                      />
                      <input
                        className="edit-field-input flex-1"
                        value={st.title}
                        onChange={(e) => setSubtasks((prev) => prev.map((s) => (s.id === st.id ? { ...s, title: e.target.value } : s)))}
                        placeholder="Subtask"
                      />
                      <button
                        type="button"
                        className="text-sm text-rose-500"
                        onClick={() => setSubtasks((prev) => prev.filter((s) => s.id !== st.id))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <input
                      ref={newSubtaskRef}
                      value={newSubtask}
                      onChange={(e) => setNewSubtask(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addSubtask(true);
                        }
                      }}
                      placeholder="New subtask…"
                      className="edit-field-input flex-1"
                    />
                    <button
                      type="button"
                      className="ghost-button button-sm pressable"
                      onClick={() => addSubtask()}
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="edit-card__detail edit-card__detail--field">
              <button
                type="button"
                className="edit-row edit-row--interactive edit-row--inline"
                onClick={() => setPrioritySheetOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={prioritySheetOpen}
              >
                <span className="edit-row__icon" aria-hidden="true">
                  <span className="font-semibold">{TASK_PRIORITY_MARKS[3]}</span>
                </span>
                <div className="edit-row__content">
                  <div className="edit-row__label">Priority</div>
                </div>
                <div className="edit-row__value">{prioritySelection.label}</div>
                <span className="edit-row__chevron" aria-hidden="true">›</span>
              </button>
            </div>
          </div>
        </section>

        <section className="edit-card">
          <div className="edit-card__title">Date &amp; Time</div>
          <div className="edit-row">
            <span className="edit-row__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <rect x="3" y="5" width="18" height="16" rx="3" ry="3" />
                <path d="M8 3v4M16 3v4M3 11h18" />
              </svg>
            </span>
            <div
              className={`edit-row__content ${dateEnabled ? "edit-row__content--tappable" : ""}`}
              onClick={handleDateRowToggle}
              role={dateEnabled ? "button" : undefined}
              tabIndex={dateEnabled ? 0 : -1}
              onKeyDown={(e) => {
                if (!dateEnabled) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleDateRowToggle();
                }
              }}
            >
              <div className="edit-row__label">Date</div>
              {dateEnabled && <div className="edit-row__meta">{dateSummary}</div>}
            </div>
            <button
              type="button"
              className={`edit-toggle ${dateEnabled ? "is-on" : ""}`}
              role="switch"
              aria-checked={dateEnabled}
              aria-label="Toggle date"
              onClick={toggleDateSwitch}
            >
              <span className="edit-toggle__thumb" />
            </button>
          </div>
          {dateEnabled && dateDetailsOpen && (
            <div className="edit-card__detail space-y-3">
              <DatePickerCalendar
                baseDate={calendarBaseDate}
                selectedDate={scheduledDate}
                onSelectDate={(iso) => setScheduledDate(iso)}
              />
            </div>
          )}

          <div className="edit-row">
            <span className="edit-row__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <circle cx="12" cy="12" r="8.5" />
                <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div
              className={`edit-row__content ${hasDueTime ? "edit-row__content--tappable" : ""}`}
              onClick={handleTimeRowToggle}
              role={hasDueTime ? "button" : undefined}
              tabIndex={hasDueTime ? 0 : -1}
              onKeyDown={(e) => {
                if (!hasDueTime) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleTimeRowToggle();
                }
              }}
            >
              <div className="edit-row__label">Time</div>
              {hasDueTime && <div className="edit-row__meta">{timeSummary}</div>}
            </div>
            <button
              type="button"
              className={`edit-toggle ${hasDueTime ? "is-on" : ""}`}
              role="switch"
              aria-checked={hasDueTime}
              aria-label="Toggle due time"
              onClick={handleToggleTime}
            >
              <span className="edit-toggle__thumb" />
            </button>
          </div>
          {hasDueTime && timeDetailsOpen && (
            <div className="edit-card__detail space-y-2">
              <WheelTimePicker value={scheduledTime} fallback={defaultTimeValue} onChange={setScheduledTime} />
            </div>
          )}

          {hasDueTime && timeDetailsOpen && (
            <button
              type="button"
              className="edit-row edit-row--interactive"
              onClick={() => setTimeZoneSheetOpen(true)}
            >
              <span className="edit-row__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18" />
                  <path d="M12 3a15 15 0 0 1 0 18" />
                  <path d="M12 3a15 15 0 0 0 0 18" />
                </svg>
              </span>
              <div className="edit-row__content">
                <div className="edit-row__label">Time Zone</div>
              </div>
              <div className="edit-row__value">{timeZoneLabel}</div>
              <span className="edit-row__chevron" aria-hidden="true">›</span>
            </button>
          )}

          <RepeatField
            rule={rule}
            onChange={setRule}
            anchorDate={scheduledDate}
            timeZone={safeScheduledTimeZone}
            showIcons
          />

        {dateEnabled && (
            <>
              <button
                type="button"
                className="edit-row edit-row--interactive"
                onClick={() => setReminderPickerExpanded((prev) => !prev)}
              >
                <span className="edit-row__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                    <path d="M12 5a5 5 0 0 1 5 5v3.25l1.25 2.5H5.75L7 13.25V10a5 5 0 0 1 5-5z" />
                    <path d="M10 19a2 2 0 0 0 4 0" strokeLinecap="round" />
                  </svg>
                </span>
                <div className="edit-row__content">
                  <div className="edit-row__label">Reminders</div>
                </div>
                <div className="edit-row__value">{reminderRowSummary}</div>
                <span className="edit-row__chevron" aria-hidden="true">›</span>
              </button>
              {reminderPickerExpanded && (
                <div className="edit-card__detail space-y-2">
                  <ReminderChips
                    selection={reminderSelection}
                    mode={reminderPresetMode}
                    onChange={setReminderSelection}
                    disabled={!dateEnabled}
                    anchorISO={reminderAnchorISO}
                    anchorTimeZone={hasDueTime ? safeScheduledTimeZone : systemTimeZone}
                    anchorLabel={hasDueTime ? "due time" : "reminder time"}
                    timeOfDay={hasDueTime ? undefined : {
                      label: reminderTimeSummary,
                      open: reminderTimeDetailsOpen,
                      onToggle: () => setReminderTimeDetailsOpen((prev) => !prev),
                      value: reminderTime,
                      fallback: DEFAULT_DATE_REMINDER_TIME,
                      onChange: setReminderTime,
                    }}
                  />
                </div>
              )}
            </>
          )}
        </section>

        <section className="edit-card">
          <button
            type="button"
            className="edit-row edit-row--interactive edit-row--inline"
            onClick={() => setLocationExpanded((prev) => !prev)}
            aria-expanded={locationExpanded}
          >
            <span className="edit-row__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 21s6-6 6-10a6 6 0 1 0-12 0c0 4 6 10 6 10z" />
                <circle cx="12" cy="11" r="2.5" />
              </svg>
            </span>
            <div className="edit-row__content">
              <div className="edit-row__label">Location</div>
            </div>
            <div className="edit-row__value truncate max-w-[10rem]" title={locationSummary}>
              {locationSummary}
            </div>
            <span className="edit-row__chevron" aria-hidden="true">›</span>
          </button>
          {locationExpanded && (
            <div className="edit-card__detail edit-location">
              {availableBoards.length === 0 ? (
                <div className="text-sm text-secondary">No boards available.</div>
              ) : (
                <div className="edit-location__controls">
                  <select
                    className="pill-select pill-select--compact w-full"
                    value={selectedBoardId}
                    onChange={(event) => setSelectedBoardId(event.target.value)}
                    title="Select board"
                    aria-label="Select board"
                  >
                    {availableBoards.map((board) => (
                      <option key={board.id} value={board.id}>
                        {board.name}
                      </option>
                    ))}
                  </select>
                  {selectedBoard?.kind === "lists" && (
                    <select
                      className="pill-select pill-select--compact w-full"
                      value={selectedColumnId}
                      onChange={(event) => setSelectedColumnId(event.target.value)}
                      title="Select list"
                      aria-label="Select list"
                      disabled={selectedBoard.columns.length === 0}
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
        </section>

        <section className="edit-card">
          <button
            type="button"
            className="edit-row edit-row--interactive edit-row--inline w-full text-left"
            onClick={() => setAssigneesExpanded((prev) => !prev)}
            aria-expanded={assigneesExpanded}
          >
            <span className="edit-row__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
                <circle cx="10" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </span>
            <div className="edit-row__content">
              <div className="edit-row__label">Assignees</div>
              <div className="edit-row__meta truncate">{assigneesPreview}</div>
            </div>
            <div className="edit-row__value">{assigneesLabel}</div>
            <span className="edit-row__chevron" aria-hidden="true">›</span>
          </button>
          {assigneesExpanded && (
            <div className="edit-card__detail edit-assignees">
              <div className="edit-assignees__toolbar">
                <button
                  type="button"
                  className="ghost-button button-xs pressable"
                  onClick={() => {
                    setAssigneeSearch("");
                    setAssigneePickerOpen(true);
                  }}
                >
                  Assign contact
                </button>
              </div>
              <div className="edit-assignees__input-row">
                <input
                  type="text"
                  className="edit-field-input edit-assignees__input"
                  placeholder="npub or hex pubkey"
                  value={assigneeInput}
                  onChange={(event) => {
                    setAssigneeInput(event.target.value);
                    if (assigneeInputError) setAssigneeInputError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addAssigneeFromInput();
                    }
                  }}
                />
                <button
                  type="button"
                  className="ghost-button button-xs pressable"
                  onClick={addAssigneeFromInput}
                >
                  Add
                </button>
              </div>
              {assigneeInputError ? <div className="text-xs text-rose-400">{assigneeInputError}</div> : null}
              {assignees.length === 0 ? (
                <div className="edit-assignees__empty">No assignees yet.</div>
              ) : (
                <div className="edit-assignees__list">
                  {assignees.map((assignee) => {
                    const { label, subtitle } = assigneeIdentity(assignee);
                    return (
                      <div key={assignee.pubkey} className="edit-assignee">
                        <div className="edit-assignee__identity">
                          <div className="edit-assignee__name">{label}</div>
                          <div className="edit-assignee__subtitle">{subtitle}</div>
                        </div>
                        <div className="edit-assignee__actions">
                          <span className={`chip edit-assignee__status ${assigneeStatusChipClass(assignee)}`}>
                            {assigneeStatusLabel(assignee)}
                          </span>
                          <button
                            type="button"
                            className="ghost-button button-xs pressable edit-assignee__remove"
                            onClick={() => removeAssignee(assignee.pubkey)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>

        {bountyExtension
          ? bountyExtension.renderSection({ task, saveWith: save, contacts, nip05Cache })
          : task.bounty
            ? <TaskBountyToken task={task} onReveal={onRevealBounty} />
            : null}

        {streakEligible && (
          <section className="edit-card space-y-2">
            <div className="edit-card__title">Streaks</div>
            <div className="text-xs text-secondary flex flex-wrap items-center gap-3">
              <span>
                Current streak: <span className="font-semibold text-primary">{currentStreak}</span>
              </span>
              <span>
                Longest streak: <span className="font-semibold text-primary">{bestStreak}</span>
              </span>
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
            {bountyExtension?.renderActions?.({ task })}
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                setShareTaskStatus(null);
                setShareTaskPickerOpen(true);
              }}
              disabled={shareTaskBusy}
            >
              Share
            </button>
            <button type="button" className="ghost-button button-sm pressable" onClick={copyCurrent}>Copy Task</button>
          </div>
        </div>
      </div>

    </Modal>

    <ActionSheet
      open={prioritySheetOpen}
      onClose={() => setPrioritySheetOpen(false)}
      title="Priority"
      panelClassName="sheet-panel--compact"
    >
      <div className="overflow-hidden rounded-2xl border border-border bg-elevated">
        {priorityOptions.map((option, index) => {
          const active = priority === option.value;
          return (
            <React.Fragment key={option.value}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface"
                onClick={() => {
                  setPriority(option.value as TaskPriority | 0);
                  setPrioritySheetOpen(false);
                }}
                aria-pressed={active}
              >
                <span
                  className={`text-accent text-sm font-semibold ${active ? "" : "opacity-0"}`}
                  aria-hidden="true"
                >
                  ✓
                </span>
                <div className="flex-1">
                  <div className="text-sm font-medium text-primary">{option.label}</div>
                </div>
                {option.marks && <span className="text-rose-500 font-semibold">{option.marks}</span>}
              </button>
              {index === 0 && <div className="h-px bg-border mx-4" />}
            </React.Fragment>
          );
        })}
      </div>
    </ActionSheet>

    <ActionSheet
      open={assigneePickerOpen}
      onClose={() => {
        setAssigneePickerOpen(false);
        setAssigneeSearch("");
      }}
      title="Assignees"
      stackLevel={90}
    >
      <div className="space-y-3">
        <div className="edit-card__detail edit-card__detail--field">
          <input
            value={assigneeSearch}
            onChange={(event) => setAssigneeSearch(event.target.value)}
            className="edit-field-input"
            placeholder="Search contacts"
          />
        </div>
        {filteredAssigneeContacts.length ? (
          <div className="space-y-2">
            {filteredAssigneeContacts.map((contact) => {
              const pubkey = normalizeAssigneePubkey(contact?.npub);
              if (!pubkey) return null;
              return (
                <ContactRow
                  key={contact.id}
                  contact={contact}
                  selected={assignedPubkeys.has(pubkey)}
                  selectedLabel="Assigned"
                  onClick={() => toggleAssigneeContact(contact)}
                />
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-secondary">No contacts found.</div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="ghost-button button-sm pressable flex-1 justify-center"
            onClick={() => {
              setAssigneePickerOpen(false);
              setAssigneeSearch("");
            }}
          >
            Done
          </button>
        </div>
      </div>
    </ActionSheet>

    <ContactShareSheet
      open={shareTaskPickerOpen}
      title="Send task"
      itemLabel={title.trim() || "this task"}
      contacts={shareableContacts}
      busy={shareTaskBusy}
      status={shareTaskStatus}
      onPick={handleShareTaskToContact}
      onClose={() => {
        setShareTaskPickerOpen(false);
        setShareTaskStatus(null);
      }}
    />



    <TimeZoneSheet
      open={timeZoneSheetOpen}
      onClose={() => setTimeZoneSheetOpen(false)}
      options={timeZoneOptions}
      selectedTimeZone={safeScheduledTimeZone}
      onSelect={(timeZone) => setScheduledTimeZone(timeZone)}
    />
    </>
  );

}

export { EditModal };
