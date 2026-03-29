// @ts-nocheck
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { nip19 } from "nostr-tools";
import { normalizeTaskAssignmentStatus } from "taskify-core";

// Sub-sheet components
import { CustomReminderSheet } from "../reminders/CustomReminderSheet";
import { TimeZoneSheet } from "../reminders/TimeZoneSheet";
import { LockToNpubSheet } from "../bounty/LockToNpubSheet";
import { BountyAttachSheet } from "../bounty/BountyAttachSheet";
import { RecurrenceModal, RepeatPickerSheet, RepeatCustomSheet, EndRepeatSheet } from "../recurrence/RecurrencePicker";

// Domain types
import type { Task, TaskAssignee, Board, TaskPriority, Recurrence, Subtask, ReminderPreset, Weekday } from "../../domains/tasks/taskTypes";
import { HOURS_12, MINUTES, MERIDIEMS, type Meridiem } from "../../domains/appTypes";
import { TASK_PRIORITY_MARKS } from "../../domains/tasks/taskTypes";

// Task utilities
import {
  normalizeTaskPriority,
  normalizeTaskBounty,
  taskHasBountyList,
  normalizeBounty,
  bountyStateLabel,
  ensureXOnlyHex,
  pubkeysEqual,
} from "../../domains/tasks/taskUtils";

// Board utilities
import {
  isFrequentRecurrence,
  hiddenUntilForBoard,
} from "../../domains/tasks/boardUtils";

// Contact utilities
import {
  compressedToRawHex,
  contactVerifiedNip05,
  contactInitials,
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
  getWheelNearestIndex,
  scrollWheelColumnToIndex,
  scheduleWheelSnap,
  parseTimePickerValue,
  formatTimePickerValue,
  currentTimeValue,
} from "../../domains/dateTime/dateUtils";

// Timezone utilities
import {
  formatTimeZoneDisplay,
  getTimeZoneOptions,
} from "../../domains/dateTime/timezoneUtils";

// Reminder utilities
import {
  buildReminderOptions,
  reminderPresetToMinutes,
  reminderPresetIdForMode,
  formatReminderLabel,
  normalizeReminderTime,
  DEFAULT_DATE_REMINDER_TIME,
  type ReminderPresetMode,
  type ReminderOption,
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
import {
  buildTaskShareEnvelope,
  sendShareMessage,
  type SharedTaskPayload,
} from "../../lib/shareInbox";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";

// Nostr crypto
import { encryptEcashTokenForRecipient, hexToBytes } from "../../domains/nostr/nostrCrypto";

// Backup utils
import { appendWalletHistoryEntry } from "../../domains/backup/backupUtils";

// Context hooks
import { useCashu } from "../../context/CashuContext";
import { useToast } from "../../context/ToastContext";

// UI components
import { Modal } from "../Modal";
import { EcashGlyph } from "../../components/EcashGlyph";
import { ActionSheet } from "../../components/ActionSheet";

// Local Storage Keys
import {
  LS_LIGHTNING_CONTACTS,
  LS_CONTACT_NIP05_CACHE,
} from "../../localStorageKeys";

// ---- Local types ----

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


function labelOf(r: Recurrence): string {
  if (!r || r.type === "none") return "Never";
  if (r.type === "daily") return "Daily";
  if (r.type === "weekly") {
    const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
    if (!r.days?.length) return "Weekly";
    if (r.days.length === 7) return "Every day";
    const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];
    if (
      r.days.length === 5 &&
      WEEKDAYS.every((d) => r.days.includes(d)) &&
      !r.days.includes(0) &&
      !r.days.includes(6)
    ) {
      return "Weekdays";
    }
    return r.days.map((d) => WD_SHORT[d]).join(", ");
  }
  if (r.type === "every") {
    const unitLabel = r.n === 1 ? r.unit : `${r.n} ${r.unit}s`;
    return `Every ${unitLabel}`;
  }
  if (r.type === "monthlyDay") {
    return r.interval && r.interval > 1 ? `Every ${r.interval} months` : "Monthly";
  }
  return "Custom";
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
function EditModal({ task, onCancel, onDelete, onSave, onSwitchToEvent, weekStart, boardKind, boards, onRedeemCoins, onRevealBounty, onTransferBounty, onPreviewDocument, walletConversionEnabled, walletPrimaryCurrency, bountyListEnabled, bountyListKey, onAddToBountyList, onRemoveFromBountyList, defaultRelays, nostrPK, nostrSkHex }: {
  task: Task;
  onCancel: ()=>void;
  onDelete: ()=>void;
  onSave: (t: Task)=>void;
  onSwitchToEvent?: (t: Task)=>void;
  weekStart: Weekday;
  boardKind: Board["kind"];
  boards: Board[];
  onRedeemCoins?: (from: DOMRect)=>void;
  onRevealBounty?: (taskId: string)=>Promise<void>;
  onTransferBounty?: (taskId: string, recipientHex: string)=>Promise<void>;
  onPreviewDocument?: (task: Task, doc: TaskDocument) => void;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  bountyListEnabled: boolean;
  bountyListKey?: string | null;
  onAddToBountyList?: (taskId: string) => void;
  onRemoveFromBountyList?: (taskId: string) => void;
  defaultRelays: string[];
  nostrPK: string;
  nostrSkHex: string;
}) {
  const [title, setTitle] = useState(task.title);
  const [priority, setPriority] = useState<TaskPriority | 0>(() => normalizeTaskPriority(task.priority) ?? 0);
  const [prioritySheetOpen, setPrioritySheetOpen] = useState(false);
  const [note, setNote] = useState(task.note || "");
  const [images, setImages] = useState<string[]>(task.images || []);
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [documents, setDocuments] = useState<TaskDocument[]>(task.documents || []);
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks || []);
  const [newSubtask, setNewSubtask] = useState("");
  const [selectedBoardId, setSelectedBoardId] = useState(task.boardId);
  const [selectedColumnId, setSelectedColumnId] = useState(task.columnId || "");
  const newSubtaskRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const dragSubtaskIdRef = useRef<string | null>(null);
  const [rule, setRule] = useState<Recurrence>(task.recurrence ?? R_NONE);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [repeatSheetOpen, setRepeatSheetOpen] = useState(false);
  const [repeatCustomSheetOpen, setRepeatCustomSheetOpen] = useState(false);
  const [endRepeatSheetOpen, setEndRepeatSheetOpen] = useState(false);
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
  const timePickerHourColumnRef = useRef<HTMLDivElement | null>(null);
  const timePickerMinuteColumnRef = useRef<HTMLDivElement | null>(null);
  const timePickerMeridiemColumnRef = useRef<HTMLDivElement | null>(null);
  const timePickerHourScrollFrame = useRef<number | null>(null);
  const timePickerMinuteScrollFrame = useRef<number | null>(null);
  const timePickerMeridiemScrollFrame = useRef<number | null>(null);
  const timePickerHourSnapTimeout = useRef<number | null>(null);
  const timePickerMinuteSnapTimeout = useRef<number | null>(null);
  const timePickerMeridiemSnapTimeout = useRef<number | null>(null);
  const timePickerHourValueRef = useRef(0);
  const timePickerMinuteValueRef = useRef(0);
  const timePickerMeridiemValueRef = useRef<Meridiem>("AM");
  const [reminderPickerExpanded, setReminderPickerExpanded] = useState(false);
  const [customReminderSheetOpen, setCustomReminderSheetOpen] = useState(false);
  const [subtasksExpanded, setSubtasksExpanded] = useState(false);
  const [locationExpanded, setLocationExpanded] = useState(false);
  const [assigneesExpanded, setAssigneesExpanded] = useState(false);
  const [timeDetailsOpen, setTimeDetailsOpen] = useState(false);
  const [reminderTimeDetailsOpen, setReminderTimeDetailsOpen] = useState(false);
  const [, setBountyState] = useState<Task["bounty"]["state"]>(task.bounty?.state || "locked");
  const { createSendToken, receiveToken, mintUrl } = useCashu();
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const [signOverSheetOpen, setSignOverSheetOpen] = useState(false);
  const [lockToSelf, setLockToSelf] = useState(true);
  const [bountyExpanded, setBountyExpanded] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>(() => loadContactsFromStorage());
  const prefetchedContactPhotos = useRef<Set<string>>(new Set());
  const [nip05Cache, setNip05Cache] = useState<Record<string, Nip05CheckState>>(() =>
    typeof window !== "undefined" ? loadNip05Cache() : {},
  );
  const [lockNpubSheetOpen, setLockNpubSheetOpen] = useState(false);
  const [lockRecipientSelection, setLockRecipientSelection] = useState<LockRecipientSelection | null>(null);
  const [signingBounty, setSigningBounty] = useState(false);
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
  const bountyButtonActive = bountyListEnabled && !!bountyListKey;
  const taskInBountyList = bountyButtonActive && bountyListKey ? taskHasBountyList(task, bountyListKey) : false;
  const contactsByHex = useMemo(() => {
    const map = new Map<string, Contact>();
    contacts.forEach((contact) => {
      const hex = normalizeNostrPubkey(contact.npub);
      if (hex) map.set(hex, contact);
    });
    return map;
  }, [contacts]);
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

  const lockLabelForContact = useCallback(
    (contact: Contact | null | undefined, fallback: string) => {
      const verifiedNip05 = contact ? contactVerifiedNip05(contact, nip05Cache) : null;
      if (verifiedNip05) return verifiedNip05;
      const primaryName = contact ? contactPrimaryName(contact) : "";
      if (primaryName && primaryName !== "Contact" && primaryName !== contact?.npub?.trim()) {
        return primaryName;
      }
      return fallback;
    },
    [nip05Cache],
  );
  const quickLockOptions = useMemo<QuickLockOption[]>(() => {
    const options: QuickLockOption[] = [];
    const ownerHex = normalizeNostrPubkey(task.createdBy || "");
    if (ownerHex) {
      const contact = contactsByHex.get(ownerHex);
      const sourceValue = contact?.npub?.trim() || (task.createdBy ? toNpubKey(task.createdBy) : ownerHex);
      const label = lockLabelForContact(contact, shortenPubkey(sourceValue));
      options.push({
        id: "creator",
        title: "Task creator",
        value: sourceValue,
        label,
        contactId: contact?.id,
      });
    }
    const completerHex = normalizeNostrPubkey(task.completedBy || "");
    if (completerHex) {
      const contact = contactsByHex.get(completerHex);
      const sourceValue = contact?.npub?.trim() || (task.completedBy ? toNpubKey(task.completedBy) : completerHex);
      const label = lockLabelForContact(contact, shortenPubkey(sourceValue));
      options.push({
        id: "completer",
        title: "Task fulfiller",
        value: sourceValue,
        label,
        contactId: contact?.id,
      });
    }
    return options;
  }, [contactsByHex, lockLabelForContact, task.completedBy, task.createdBy]);
  const handleLockRecipientSelect = useCallback((selection: LockRecipientSelection) => {
    setLockRecipientSelection(selection);
    setLockToSelf(false);
    setLockNpubSheetOpen(false);
  }, []);
  const handleToggleLockToSelf = useCallback(() => {
    setLockToSelf((prev) => {
      const next = !prev;
      if (next) {
        setLockRecipientSelection(null);
      }
      return next;
    });
  }, []);
  const handleClearLockRecipient = useCallback(() => {
    setLockRecipientSelection(null);
  }, []);
  const handleOpenAttachSheet = useCallback(() => {
    setLockToSelf(true);
    setLockRecipientSelection(null);
    setAttachSheetOpen(true);
  }, []);
  async function handleAttachBounty(amountSat: number, overrideMint?: string) {
    if (!amountSat || amountSat <= 0) {
      throw new Error("Enter an amount greater than zero.");
    }
    const recipientPubkey = lockRecipientSelection
      ? normalizeNostrPubkey(lockRecipientSelection.value)
      : null;
    const recipientHex = ensureXOnlyHex(recipientPubkey);
    if (lockRecipientSelection && (!recipientPubkey || !recipientHex)) {
      throw new Error("Selected npub is invalid.");
    }
    const sendOptions: { p2pk?: { pubkey: string }; mintUrl?: string } = {};
    if (recipientPubkey) {
      sendOptions.p2pk = { pubkey: recipientPubkey };
    }
    if (overrideMint?.trim()) {
      sendOptions.mintUrl = overrideMint.trim();
    }
    const { token: tok, lockInfo, mintUrl: sendMintUrl } = await createSendToken(amountSat, sendOptions);
    const bountyMint = sendMintUrl || overrideMint || mintUrl;
    const lockType: Task["bounty"]["lock"] =
      lockInfo?.type === "p2pk" ? "p2pk" : lockToSelf ? "unknown" : "none";
    const selfPubkey = (window as any).nostrPK as string | undefined;
    const selfHex = ensureXOnlyHex(selfPubkey);
    const bounty: Task["bounty"] = {
      id: crypto.randomUUID(),
      token: lockToSelf || recipientHex ? "" : tok,
      amount: amountSat,
      mint: bountyMint,
      state: lockToSelf || recipientHex ? "locked" : "unlocked",
      owner: task.createdBy || (window as any).nostrPK || "",
      sender: (window as any).nostrPK || "",
      receiver: recipientHex || (lockToSelf ? selfHex : undefined) || undefined,
      updatedAt: new Date().toISOString(),
      lock: lockType,
    };
    if (recipientHex) {
      const enc = await encryptEcashTokenForRecipient(recipientHex, tok);
      bounty.enc = enc;
    } else if (lockToSelf) {
      const funderHex = selfHex || "";
      if (!funderHex) {
        throw new Error("Locking to yourself requires a connected Nostr key.");
      }
      const enc = await encryptEcashTokenForRecipient(funderHex, tok);
      bounty.enc = enc;
    }
    save({ bounty });
    const summaryPrefix = recipientHex
      ? "Locked bounty"
      : lockToSelf
        ? "Hidden bounty"
        : "Attached bounty";
    appendWalletHistoryEntry({
      id: `attach-bounty-${bounty.id}`,
      summary: `${summaryPrefix} • ${amountSat} sats`,
      detail: tok,
      detailKind: "token",
      type: "ecash",
      direction: "out",
      amountSat,
      entryKind: "bounty-attachment",
      relatedTaskTitle: task.title || undefined,
      mintUrl: bountyMint ?? undefined,
    });
    setAttachSheetOpen(false);
    setLockToSelf(true);
    setLockRecipientSelection(null);
  }
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
  const reminderOptions = useMemo(
    () => buildReminderOptions(reminderSelection, reminderPresetMode),
    [reminderPresetMode, reminderSelection],
  );
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
      .join(', ');
  }, [reminderPresetMap, reminderSelection]);
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
          scheduledDate || isoDatePart(new Date().toISOString()),
          reminderTime || DEFAULT_DATE_REMINDER_TIME,
          systemTimeZone,
        ),
        systemTimeZone,
      ),
    [reminderTime, scheduledDate, systemTimeZone],
  );
  const endRepeatSummary = useMemo(() => {
    if (!rule.untilISO) return "Never";
    const parsed = new Date(rule.untilISO);
    if (Number.isNaN(parsed.getTime())) return "Custom date";
    return parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }, [rule]);
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
  const editingReminderTime = !hasDueTime && reminderTimeDetailsOpen;
  const timePickerParts = useMemo(
    () =>
      parseTimePickerValue(
        editingReminderTime ? reminderTime : scheduledTime,
        editingReminderTime ? DEFAULT_DATE_REMINDER_TIME : defaultTimeValue,
      ),
    [defaultTimeValue, editingReminderTime, reminderTime, scheduledTime],
  );
  const timePickerHour = timePickerParts.hour;
  const timePickerMinute = timePickerParts.minute;
  const timePickerMeridiem = timePickerParts.meridiem;
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
    const todayISO = isoDatePart(new Date().toISOString());
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
      setCustomReminderSheetOpen(false);
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
    if ((hasDueTime && !timeDetailsOpen) || (!hasDueTime && !reminderTimeDetailsOpen)) return;
    const hourIndex = HOURS_12.indexOf(timePickerHour);
    if (hourIndex >= 0) {
      // Use "instant" to avoid firing scroll events mid-animation, which would
      // cause the snap handler to read a stale position and re-snap to the wrong item.
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
  }, [timeDetailsOpen, hasDueTime, reminderTimeDetailsOpen, timePickerHour, timePickerMinute, timePickerMeridiem]);

  useEffect(() => {
    setSigningBounty(false);
  }, [task.id]);
  useEffect(() => {
    if (hasDueTime && scheduledTime) {
      lastTimeRef.current = scheduledTime;
    }
  }, [hasDueTime, scheduledTime]);

  const me = (window as any).nostrPK as string | undefined;
  const meHex = ensureXOnlyHex(me);

  function toNpubKey(value: string): string {
    const raw = compressedToRawHex(value);
    try {
      if (typeof (nip19 as any)?.npubEncode === "function") {
        return (nip19 as any).npubEncode(raw);
      }
      return raw;
    } catch {
      return raw;
    }
  }

  function shortenPubkey(value: string): string {
    if (value.length <= 18) return value;
    return `${value.slice(0, 10)}…${value.slice(-6)}`;
  }

  const currentReceiverDisplay = useMemo(() => {
    const receiver = task.bounty?.receiver;
    if (!receiver) return null;
    return shortenPubkey(toNpubKey(receiver));
  }, [task.bounty?.receiver]);

  const bountyReceiverIsViewer = useMemo(() => {
    const receiver = task.bounty?.receiver;
    if (!receiver) return false;
    return pubkeysEqual(receiver, (window as any).nostrPK);
  }, [task.bounty?.receiver]);

  const bountySenderIsViewer = useMemo(() => {
    if (!task.bounty?.sender || !meHex) return false;
    return pubkeysEqual(task.bounty.sender, meHex);
  }, [meHex, task.bounty?.sender]);

  const canRemoveBounty = useMemo(() => {
    if (!task.bounty) return false;
    return task.bounty.state === "unlocked" || bountySenderIsViewer;
  }, [bountySenderIsViewer, task.bounty]);

  const bountyOwnerIsViewer = useMemo(() => {
    if (!task.bounty?.owner || !meHex) return false;
    return pubkeysEqual(task.bounty.owner, meHex);
  }, [meHex, task.bounty?.owner]);

  const hasTransferableBounty = !!(task.bounty && (task.bounty.token || task.bounty.enc));

  const bountyHasReceiver = !!task.bounty?.receiver;
  const bountyReceiverGate = bountyHasReceiver ? bountyReceiverIsViewer : true;

  const bountySignerHasKey = useMemo(() => {
    if (!task.bounty || !meHex) return false;
    const tokenAvailable = !!task.bounty.token?.trim();
    if (tokenAvailable) {
      return bountySenderIsViewer || bountyOwnerIsViewer || bountyReceiverIsViewer;
    }
    const enc = task.bounty.enc as any;
    if (!enc) return false;
    if (enc.alg === "aes-gcm-256") return bountySenderIsViewer || bountyOwnerIsViewer;
    if (enc.alg === "nip04") return bountyReceiverIsViewer;
    return false;
  }, [bountyOwnerIsViewer, bountyReceiverIsViewer, bountySenderIsViewer, meHex, task.bounty]);

  const bountyTokenReady = !!task.bounty?.token?.trim();

  const canSignOverBounty = useMemo(() => {
    if (!hasTransferableBounty || !bountySignerHasKey || !onTransferBounty) return false;
    if (!task.bounty) return false;
    return task.bounty.state !== "revoked" && task.bounty.state !== "claimed";
  }, [bountySignerHasKey, hasTransferableBounty, onTransferBounty, task.bounty]);

  const canRedeemBounty = useMemo(() => {
    if (!task.bounty || !bountyReceiverGate) return false;
    return task.bounty.state === "unlocked" && bountyTokenReady;
  }, [bountyReceiverGate, bountyTokenReady, task.bounty]);

  const canRevealBounty = useMemo(() => {
    if (!task.bounty?.enc) return false;
    const alg = (task.bounty.enc as any).alg;
    return bountyReceiverIsViewer || alg === "aes-gcm-256";
  }, [bountyReceiverIsViewer, task.bounty?.enc]);

  useEffect(() => {
    if (!task.bounty) {
      setBountyExpanded(false);
    }
  }, [task.bounty]);

  async function handleSignOver(recipientHex: string, displayHint?: string) {
    if (!onTransferBounty || signingBounty) return;
    setSigningBounty(true);
    try {
      await onTransferBounty(task.id, recipientHex);
      setBountyState("locked");
      const label = displayHint || shortenPubkey(toNpubKey(recipientHex));
      if (label) {
        showToast(`Bounty locked to ${label}`, 2500);
      } else {
        showToast("Bounty locked to recipient", 2500);
      }
    } catch (error) {
      const message = (error as Error)?.message || String(error) || "Unknown error";
      alert(`Unable to sign bounty: ${message}`);
    } finally {
      setSigningBounty(false);
    }
  }

  function handleSignOverSelection(selection: LockRecipientSelection) {
    const trimmed = selection.value.trim();
    if (!trimmed) return;
    const normalized = normalizeNostrPubkey(trimmed);
    if (!normalized) {
      alert("Enter a valid recipient npub or hex.");
      return;
    }
    if (task.bounty?.receiver && pubkeysEqual(task.bounty.receiver, normalized)) {
      alert("Bounty is already locked to that recipient.");
      return;
    }
    handleSignOver(normalized, selection.label);
    setSignOverSheetOpen(false);
  }

  const handleCopyBountyToken = useCallback(async () => {
    const token = task.bounty?.token?.trim();
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      showToast("Bounty token copied", 1800);
    } catch (error) {
      console.error("Failed to copy bounty token", error);
      alert("Unable to copy bounty token.");
    }
  }, [showToast, task.bounty?.token]);

  function handleMarkBountyClaimed() {
    if (!task.bounty) return;
    const next = normalizeBounty({
      ...task.bounty,
      token: "",
      state: "claimed",
      updatedAt: new Date().toISOString(),
    });
    if (!next) return;
    setBountyState("claimed");
    save({ bounty: next });
  }

  async function redeemCurrentBounty(fromRect?: DOMRect) {
    if (!task.bounty?.token) return;
    try {
      const bountyToken = task.bounty.token;
      const res = await receiveToken(bountyToken);
      if (res.savedForLater) {
        alert("Token saved for later redemption. We'll redeem it when your connection returns.");
        return;
      }
      if (res.crossMint) {
        alert(`Redeemed to a different mint: ${res.usedMintUrl}. Switch to that mint to view the balance.`);
      }
      const amt = res.proofs.reduce((a, p) => a + (p?.amount || 0), 0);
      appendWalletHistoryEntry({
        id: `redeem-bounty-${Date.now()}`,
        summary: `Redeemed bounty • ${amt} sats${res.crossMint ? ` at ${res.usedMintUrl}` : ''}`,
        detail: bountyToken,
        detailKind: "token",
        type: "ecash",
        direction: "in",
        amountSat: amt,
        mintUrl: res.usedMintUrl ?? task.bounty?.mint ?? undefined,
      });
      onRedeemCoins?.(fromRect);
      save({ bounty: undefined });
    } catch (error) {
      console.error(error);
      alert("Unable to redeem bounty token right now.");
    }
  }

  function handleRemoveBounty() {
    if (!task.bounty || !canRemoveBounty) return;
    save({ bounty: undefined });
  }

  const handleToggleBountyList = useCallback(() => {
    if (!bountyButtonActive) return;
    if (taskInBountyList) {
      onRemoveFromBountyList?.(task.id);
    } else {
      onAddToBountyList?.(task.id);
    }
  }, [bountyButtonActive, onAddToBountyList, onRemoveFromBountyList, task.id, taskInBountyList]);


  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs = Array.from(items).filter(it => it.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      const datas: string[] = [];
      for (const it of imgs) {
        const file = it.getAsFile();
        if (file) datas.push(await fileToDataURL(file));
      }
      setImages(prev => [...prev, ...datas]);
    }
  }

  async function handleDocumentAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || !files.length) return;
    try {
      const docs = await readDocumentsFromFiles(files);
      setDocuments((prev) => [...prev, ...docs]);
    } catch (err) {
      console.error("Failed to attach document", err);
      alert("Failed to attach document. Please use PDF, DOC/DOCX, or XLS/XLSX files.");
    } finally {
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

  function toggleReminder(id: ReminderPreset) {
    if (!dateEnabled) return;
    setReminderSelection((prev) => {
      const exists = prev.includes(id);
      const targetMinutes = reminderPresetToMinutes(id);
      const next = exists
        ? prev.filter((item) => item !== id)
        : [...prev.filter((item) => reminderPresetToMinutes(item) !== targetMinutes), id];
      return [...next].sort((a, b) =>
        reminderPresetMode === "date"
          ? reminderPresetToMinutes(b) - reminderPresetToMinutes(a)
          : reminderPresetToMinutes(a) - reminderPresetToMinutes(b),
      );
    });
  }

  const handleAddCustomReminder = useCallback(() => {
    if (!dateEnabled) return;
    setCustomReminderSheetOpen(true);
  }, [dateEnabled]);

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
    setShowAdvanced(true);
  }, []);
  function toggleDateSwitch() {
    if (selectedBoardKind === "week") {
      if (!dateEnabled) {
        const todayISO = isoDatePart(new Date().toISOString());
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
          const todayISO = isoDatePart(new Date().toISOString());
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
  const setTimePickerFromParts = useCallback((hour: number, minute: number, meridiem: Meridiem) => {
    const nextValue = formatTimePickerValue(hour, minute, meridiem);
    if (editingReminderTime) {
      setReminderTime((prev) => (prev === nextValue ? prev : nextValue));
    } else {
      setScheduledTime((prev) => (prev === nextValue ? prev : nextValue));
    }
  }, [editingReminderTime, setReminderTime, setScheduledTime]);
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
      if (typeof nextHour === "number") {
        // Update ref immediately for cross-column coordination; defer state commit to avoid
        // re-rendering the whole modal during active scroll (which disrupts scroll physics).
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
      if (typeof nextMinute === "number") {
        timePickerMinuteValueRef.current = nextMinute;
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
      const todayISO = scheduledDate || isoDatePart(new Date().toISOString());
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
        ? selectedColumnId || selectedBoard?.columns[0]?.id
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

  function save(overrides: Partial<Task> = {}) {
    onSave(normalizeTaskBounty(buildTask(overrides)));
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
      .filter((subtask): subtask is { title: string; completed?: boolean } => !!subtask);
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
            onClick={() => save()}
            aria-label="Save task"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M5 12l4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

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
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onPaste={handlePaste}
                className="edit-field-textarea"
                rows={3}
                placeholder="Notes (optional)"
              />
              <div className="edit-detail-actions">
                <input
                  ref={documentInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
                        onClick={() => onPreviewDocument?.(task, doc)}
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        className="ghost-button button-sm pressable text-rose-500"
                        onClick={() => setDocuments((prev) => prev.filter((item) => item.id !== doc.id))}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
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
                      key={hour}
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
                      key={minute}
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
                      key={label}
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

          <button
            type="button"
            className="edit-row edit-row--interactive"
            onClick={() => setRepeatSheetOpen(true)}
          >
            <span className="edit-row__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <path d="M4 12h16M7 7l-3 5 3 5M17 17l3-5-3-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="edit-row__content">
              <div className="edit-row__label">Repeat</div>
            </div>
            <div className="edit-row__value">{labelOf(rule)}</div>
            <span className="edit-row__chevron" aria-hidden="true">›</span>
          </button>

          {rule.type !== "none" && (
            <button
              type="button"
              className="edit-row edit-row--interactive"
              onClick={() => setEndRepeatSheetOpen(true)}
            >
              <span className="edit-row__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                  <path d="M6 6h12v12H6z" opacity="0.35" />
                  <path d="M6 12h12" />
                </svg>
              </span>
              <div className="edit-row__content">
                <div className="edit-row__label">End Repeat</div>
              </div>
              <div className="edit-row__value">{endRepeatSummary}</div>
              <span className="edit-row__chevron" aria-hidden="true">›</span>
            </button>
          )}

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
                          disabled={!dateEnabled}
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
                      disabled={!dateEnabled}
                      title="Add a custom reminder"
                    >
                      Custom…
                    </button>
                  </div>
                  {!hasDueTime && (
                    <div className="space-y-2">
                      <div className="text-xs text-secondary">Reminder time (current timezone)</div>
                      <button
                        type="button"
                        className={`pressable rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium ${
                          reminderTimeDetailsOpen ? "text-primary" : "text-secondary"
                        }`}
                        onClick={() => setReminderTimeDetailsOpen((prev) => !prev)}
                        aria-pressed={reminderTimeDetailsOpen}
                        disabled={!dateEnabled}
                      >
                        {reminderTimeSummary}
                      </button>
                      {reminderTimeDetailsOpen && (
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
                                key={`task-reminder-hour-${hour}`}
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
                                key={`task-reminder-minute-${minute}`}
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
                                key={`task-reminder-meridiem-${label}`}
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

        {task.bounty ? (
          <section className="edit-card space-y-2">
            <div className="edit-card__title">Bounty (ecash)</div>
            <div className={`wallet-history__item bounty-card${bountyExpanded ? " wallet-history__item--open" : ""}`}>
              <button
                type="button"
                className="wallet-history__summary bounty-card__summary"
                onClick={() => setBountyExpanded((prev) => !prev)}
                aria-expanded={bountyExpanded}
              >
                <div className="wallet-history__icon" aria-hidden="true">
                  <EcashGlyph className="wallet-history__glyph" />
                </div>
                <div className="wallet-history__body">
                  <div className="wallet-history__title-row">
                    <span className="wallet-history__type">Ecash bounty</span>
                    <span className="wallet-history__time">{bountyStateLabel(task.bounty)}</span>
                  </div>
                </div>
                <div className="wallet-history__value">
                  {typeof task.bounty.amount === "number" && (
                    <span className="wallet-history__amount wallet-history__amount--in">+{task.bounty.amount} sats</span>
                  )}
                </div>
              </button>

              {!bountyExpanded && (
                <div className="bounty-card__actions px-4 pb-3">
                  {task.bounty.state === "locked" && canRevealBounty && bountySignerHasKey && (
                    <button
                      className="accent-button button-sm pressable"
                      onClick={async () => {
                        try {
                          await onRevealBounty?.(task.id);
                          setBountyState("unlocked");
                        } catch (error) {
                          alert((error as Error)?.message || "Unable to reveal bounty token.");
                        }
                      }}
                      disabled={!canRevealBounty}
                    >
                      {bountyReceiverIsViewer ? "Unlock" : "Reveal"}
                    </button>
                  )}

                  {canSignOverBounty && (
                    <button
                      className="ghost-button button-sm pressable"
                      onClick={() => setSignOverSheetOpen(true)}
                      disabled={signingBounty}
                    >
                      {signingBounty ? "Signing…" : "Sign over"}
                    </button>
                  )}

                  {canRedeemBounty && (
                    <>
                      <button
                        className="accent-button button-sm pressable"
                        onClick={(e) => redeemCurrentBounty((e.currentTarget as HTMLElement).getBoundingClientRect())}
                        disabled={!bountyTokenReady}
                      >
                        Redeem
                      </button>
                      <button
                        className="ghost-button button-sm pressable"
                        onClick={handleCopyBountyToken}
                        disabled={!bountyTokenReady}
                      >
                        Copy
                      </button>
                    </>
                  )}
                </div>
              )}

              {bountyExpanded && (
                <div className="bounty-card__details">
                  <div className="bounty-card__meta">
                    <div>
                      <div className="bounty-card__label">Status</div>
                      <div className="bounty-card__value">{bountyStateLabel(task.bounty)}</div>
                    </div>
                    <div>
                      <div className="bounty-card__label">Amount</div>
                      <div className="bounty-card__value font-semibold">
                        {typeof task.bounty.amount === "number" ? `${task.bounty.amount} sats` : "Unknown"}
                      </div>
                    </div>
                    {task.bounty.receiver && (
                      <div>
                        <div className="bounty-card__label">Locked to</div>
                        <div className="bounty-card__value">{currentReceiverDisplay || "recipient"}</div>
                      </div>
                    )}
                    {task.bounty.mint && (
                      <div>
                        <div className="bounty-card__label">Mint</div>
                        <div className="bounty-card__value break-all">{task.bounty.mint}</div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="bounty-card__label">Token</div>
                    {task.bounty.enc && !task.bounty.token ? (
                      <div className="bounty-card__token-note">
                        {((task.bounty.enc as any).alg === "aes-gcm-256")
                          ? "Hidden (encrypted by funder). Only the funder can reveal."
                          : "Locked to recipient's Nostr key (nip04). Only the recipient can decrypt."}
                      </div>
                    ) : (
                      <textarea
                        readOnly
                        value={task.bounty.token || ""}
                        className="pill-textarea w-full"
                        rows={3}
                      />
                    )}
                  </div>

                  <div className="bounty-card__actions">
                    {task.bounty.state === "locked" && task.bounty.enc && bountySignerHasKey && (
                      <button
                        className="accent-button button-sm pressable"
                        onClick={async () => {
                          try {
                            await onRevealBounty?.(task.id);
                            setBountyState("unlocked");
                          } catch (error) {
                            alert((error as Error)?.message || "Unable to reveal bounty token.");
                          }
                        }}
                        disabled={!canRevealBounty}
                      >
                        {bountyReceiverIsViewer ? "Unlock" : "Reveal"}
                      </button>
                    )}

                    {canSignOverBounty && (
                      <button
                        className="ghost-button button-sm pressable"
                        onClick={() => setSignOverSheetOpen(true)}
                        disabled={signingBounty}
                      >
                        {signingBounty ? "Signing…" : "Sign over"}
                      </button>
                    )}

                    {canRedeemBounty && (
                      <>
                        <button
                          className="accent-button button-sm pressable"
                          onClick={(e) => redeemCurrentBounty((e.currentTarget as HTMLElement).getBoundingClientRect())}
                          disabled={!bountyTokenReady}
                        >
                          Redeem
                        </button>
                        <button
                          className="ghost-button button-sm pressable"
                          onClick={handleCopyBountyToken}
                          disabled={!bountyTokenReady}
                        >
                          Copy
                        </button>
                        <button
                          className="ghost-button button-sm pressable"
                          onClick={handleMarkBountyClaimed}
                          disabled={!bountyTokenReady}
                        >
                          Mark as claimed
                        </button>
                      </>
                    )}

                    {task.bounty && canRemoveBounty && (
                      <button
                        className="ghost-button button-sm pressable text-rose-500"
                        onClick={handleRemoveBounty}
                      >
                        Remove bounty
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        ) : (
          <button
            type="button"
            className="accent-button accent-button--tall pressable w-full text-lg font-semibold"
            onClick={handleOpenAttachSheet}
          >
            Attach bounty
          </button>
        )}

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
            {bountyButtonActive && (
              <button type="button" className="ghost-button button-sm pressable" onClick={handleToggleBountyList}>
                {taskInBountyList ? "Unpin task" : "Pin task"}
              </button>
            )}
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

      {showAdvanced && (
        <RecurrenceModal
          initial={rule}
          onClose={() => setShowAdvanced(false)}
          onApply={(r) => {
            setRule(r);
            setShowAdvanced(false);
          }}
        />
      )}
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
              const label = contactPrimaryName(contact);
              const subtitle = formatContactNpub(contact.npub);
              const selected = assignedPubkeys.has(pubkey);
              return (
                <button
                  key={contact.id}
                  type="button"
                  className="contact-row pressable"
                  onClick={() => toggleAssigneeContact(contact)}
                  aria-pressed={selected}
                >
                  <div className="contact-avatar">{contactInitials(label)}</div>
                  <div className="contact-row__text">
                    <div className="contact-row__name flex items-center gap-2">
                      <span className="min-w-0 truncate">{label}</span>
                      {selected ? (
                        <span className="text-xs text-secondary" aria-label="Assigned">
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

    <ActionSheet
      open={shareTaskPickerOpen}
      onClose={() => {
        if (shareTaskBusy) return;
        setShareTaskPickerOpen(false);
        setShareTaskStatus(null);
      }}
      title="Send task"
      stackLevel={85}
    >
      <div className="text-sm text-secondary mb-2">
        Choose a contact to send <span className="font-semibold">{title.trim() || "this task"}</span>.
      </div>
      {shareTaskStatus && (
        <div className="text-sm text-rose-400 mb-2">{shareTaskStatus}</div>
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
                disabled={shareTaskBusy}
                onClick={() => handleShareTaskToContact(contact)}
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
            if (shareTaskBusy) return;
            setShareTaskPickerOpen(false);
            setShareTaskStatus(null);
          }}
          disabled={shareTaskBusy}
        >
          Cancel
        </button>
      </div>
    </ActionSheet>

    <CustomReminderSheet
      open={customReminderSheetOpen}
      onClose={() => setCustomReminderSheetOpen(false)}
      anchorISO={reminderAnchorISO}
      anchorTimeZone={hasDueTime ? safeScheduledTimeZone : systemTimeZone}
      anchorLabel={hasDueTime ? "due time" : "reminder time"}
      onApply={handleApplyCustomReminder}
    />

    <RepeatPickerSheet
      open={repeatSheetOpen}
      onClose={() => setRepeatSheetOpen(false)}
      rule={rule}
      scheduledDate={scheduledDate}
      onSelect={handleRepeatSelect}
      onOpenCustom={handleOpenCustomRepeat}
      onOpenAdvanced={handleOpenAdvancedRepeat}
    />
    <RepeatCustomSheet
      open={repeatCustomSheetOpen}
      onClose={() => setRepeatCustomSheetOpen(false)}
      scheduledDate={scheduledDate}
      rule={rule}
      onApply={handleRepeatSelect}
      onOpenAdvanced={handleOpenAdvancedRepeat}
    />
    <EndRepeatSheet
      open={endRepeatSheetOpen}
      onClose={() => setEndRepeatSheetOpen(false)}
      rule={rule}
      scheduledDate={scheduledDate}
      timeZone={safeScheduledTimeZone}
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

    <LockToNpubSheet
      open={lockNpubSheetOpen}
      onClose={() => setLockNpubSheetOpen(false)}
      contacts={contacts}
      quickOptions={quickLockOptions}
      nip05Cache={nip05Cache}
      onSelect={handleLockRecipientSelect}
      selected={lockRecipientSelection}
    />
    <LockToNpubSheet
      open={signOverSheetOpen}
      onClose={() => setSignOverSheetOpen(false)}
      contacts={contacts}
      quickOptions={quickLockOptions}
      nip05Cache={nip05Cache}
      onSelect={handleSignOverSelection}
      selected={null}
    />
    <BountyAttachSheet
      open={attachSheetOpen}
      onClose={() => setAttachSheetOpen(false)}
      onAttach={handleAttachBounty}
      lockToSelf={lockToSelf}
      onToggleLockToSelf={handleToggleLockToSelf}
      onOpenLockContacts={() => setLockNpubSheetOpen(true)}
      lockRecipient={lockRecipientSelection}
      onClearRecipient={handleClearLockRecipient}
      walletConversionEnabled={walletConversionEnabled}
      walletPrimaryCurrency={walletPrimaryCurrency}
      mintUrl={mintUrl}
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
export type { LockRecipientSelection, QuickLockOption, Nip05CheckState };
