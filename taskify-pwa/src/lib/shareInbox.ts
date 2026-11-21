import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19, type Event as NostrEvent } from "nostr-tools";

import {
  buildBoardShareEnvelope as buildBoardShareEnvelopeCore,
  buildContactShareEnvelope as buildContactShareEnvelopeCore,
  buildTaskShareEnvelope as buildTaskShareEnvelopeCore,
  buildTaskAssignmentResponseEnvelope as buildTaskAssignmentResponseEnvelopeCore,
  buildCalendarEventInviteEnvelope as buildCalendarEventInviteEnvelopeCore,
  parseShareEnvelope as parseShareEnvelopeCore,
  type ShareEnvelope,
  type SharedContactPayload,
  type SharedTaskPayload,
  type SharedCalendarEventInvitePayload,
  type SharedTaskAssignmentResponsePayload,
  normalizeRelayList,
  createNip17Rumor,
} from "taskify-core";
import { nip17Crypto } from "taskify-runtime-nostr";
import { LocalKeySigner } from "../identity/signer";
import { giftWrapNip17Rumor, nip17TimestampSource, recipientInboxRelays } from "./nip17Messages";
import { NostrSession } from "../nostr/NostrSession";
import { kvStorage } from "../storage/kvStorage";
import type { GroupChat } from "./groupChatState";

export type {
  ShareEnvelope,
  SharedBoardPayload,
  SharedContactPayload,
  SharedTaskPayload,
  SharedCalendarEventInvitePayload,
  SharedTaskAssignmentResponsePayload,
} from "taskify-core";

const SHARE_ENVELOPE_EMBED_MARKER = "Taskify-Share:";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function encodeBase64UrlUtf8(value: string): string {
  const base64 = bytesToBase64(new TextEncoder().encode(value));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function formatTaskAssignmentPriority(priority: number | undefined): string | null {
  if (priority === 3) return "High";
  if (priority === 2) return "Medium";
  if (priority === 1) return "Low";
  return null;
}

function formatTaskAssignmentDue(task: SharedTaskPayload): string {
  if (task.dueDateEnabled === false) return "No due date";
  if (!task.dueISO) return "Not specified";
  const parsed = new Date(task.dueISO);
  if (Number.isNaN(parsed.getTime())) {
    return task.dueISO;
  }
  try {
    const options: Intl.DateTimeFormatOptions = task.dueTimeEnabled
      ? { dateStyle: "medium", timeStyle: "short", ...(task.dueTimeZone ? { timeZone: task.dueTimeZone } : {}) }
      : { dateStyle: "medium", ...(task.dueTimeZone ? { timeZone: task.dueTimeZone } : {}) };
    const formatted = new Intl.DateTimeFormat(undefined, options).format(parsed);
    return task.dueTimeZone ? `${formatted} (${task.dueTimeZone})` : formatted;
  } catch {
    return parsed.toISOString();
  }
}

function serializeTaskAssignmentShareEnvelope(payload: ShareEnvelope): string {
  const json = JSON.stringify(payload);
  if (payload.item.type !== "task" || payload.item.assignment !== true) {
    return json;
  }
  const task = payload.item;
  const lines: string[] = [
    "Task Assignment",
    "",
    `Title: ${task.title}`,
  ];
  const priority = formatTaskAssignmentPriority(task.priority);
  if (priority) {
    lines.push(`Priority: ${priority}`);
  }
  lines.push(`Due: ${formatTaskAssignmentDue(task)}`);
  const note = task.note?.trim();
  if (note) {
    lines.push("", "Details:", note);
  }
  const subtasks = (task.subtasks || [])
    .map((entry) => (typeof entry.title === "string" ? entry.title.trim().replace(/\s+/g, " ") : ""))
    .filter((title) => !!title);
  if (subtasks.length) {
    lines.push("", "Checklist:");
    subtasks.slice(0, 5).forEach((title) => {
      lines.push(`- ${title}`);
    });
    if (subtasks.length > 5) {
      lines.push(`- ...and ${subtasks.length - 5} more`);
    }
  }
  lines.push(
    "",
    "Open this in Taskify to accept, decline, or maybe.",
    "",
    `${SHARE_ENVELOPE_EMBED_MARKER} ${encodeBase64UrlUtf8(json)}`,
  );
  return lines.join("\n");
}

export function buildBoardShareEnvelope(
  boardId: string,
  boardName?: string,
  relays?: string[],
  sender?: { npub?: string; name?: string },
): ShareEnvelope {
  return buildBoardShareEnvelopeCore(boardId, boardName, relays, sender);
}

export function buildContactShareEnvelope(payload: SharedContactPayload): ShareEnvelope {
  return buildContactShareEnvelopeCore(payload);
}

export function buildTaskShareEnvelope(
  payload: SharedTaskPayload,
  sender?: { npub?: string; name?: string },
): ShareEnvelope {
  return buildTaskShareEnvelopeCore(payload, sender);
}

export function buildTaskAssignmentResponseEnvelope(
  payload: Omit<SharedTaskAssignmentResponsePayload, "type">,
  sender?: { npub?: string; name?: string },
): ShareEnvelope {
  return buildTaskAssignmentResponseEnvelopeCore(payload, sender);
}

export function buildCalendarEventInviteEnvelope(
  payload: Omit<SharedCalendarEventInvitePayload, "type">,
  sender?: { npub?: string; name?: string },
): ShareEnvelope {
  return buildCalendarEventInviteEnvelopeCore(payload, sender);
}

export function parseShareEnvelope(raw: string): ShareEnvelope | null {
  return parseShareEnvelopeCore(raw);
}

function toRawHexPubkey(value: string): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (/^(02|03)[0-9a-f]{64}$/.test(lower)) {
    return lower.slice(-64);
  }
  if (/^[0-9a-f]{64}$/.test(lower)) {
    return lower;
  }
  try {
    const decoded = nip19.decode(lower);
    if (decoded.type === "npub" && decoded.data) {
      const decodedData: unknown = decoded.data;
      if (typeof decodedData === "string" && /^[0-9a-f]{64}$/.test(decodedData)) {
        return decodedData.toLowerCase();
      }
      if (decodedData instanceof Uint8Array) {
        return bytesToHex(decodedData).toLowerCase();
      }
      if (Array.isArray(decodedData)) {
        return bytesToHex(new Uint8Array(decodedData as number[])).toLowerCase();
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/** "taskify.nip17.timestamp" = "now" turns off NIP-59's randomized seal and wrap timestamps. */
function shareTimestampMode(): "now" | "random" {
  try {
    return (kvStorage.getItem("taskify.nip17.timestamp") || "").trim().toLowerCase() === "now" ? "now" : "random";
  } catch {
    return "random";
  }
}

export async function sendShareMessage(
  payload: ShareEnvelope,
  recipient: string | Pick<GroupChat, "members" | "name">,
  senderSecretHex: string,
  relays: string[] | string,
  senderFallbackRelays?: string[],
): Promise<NostrEvent | undefined> {
  const account = new LocalKeySigner(senderSecretHex);
  const group = typeof recipient === "string" ? null : recipient;
  const directRecipient = typeof recipient === "string" ? toRawHexPubkey(recipient) : null;
  const groupMembers = [...new Set(group?.members.map(toRawHexPubkey) ?? [])];
  if (group && (groupMembers.includes(null) || groupMembers.length < 3 || !groupMembers.includes(account.pubkey))) {
    throw new Error("This group is unavailable for the sending account.");
  }
  if (!group && !directRecipient) {
    throw new Error("Recipient npub is invalid.");
  }
  const relayList = toRelayList(relays);
  if (!relayList.length) {
    throw new Error("No relays configured for sending.");
  }
  const recipients = group ? groupMembers.filter((key): key is string => key !== null) : [directRecipient!];
  const rumor = createNip17Rumor(
    {
      sender: account.pubkey,
      recipients,
      group: group !== null,
      extraTags: group?.name ? [["subject", group.name]] : undefined,
      content: serializeTaskAssignmentShareEnvelope(payload),
      createdAt: Math.floor(Date.now() / 1000),
    },
    nip17Crypto,
  );
  const wraps = await giftWrapNip17Rumor(rumor, account, nip17TimestampSource(shareTimestampMode()));
  const senderCopy = wraps.find(({ recipient }) => recipient === account.pubkey)?.wrap as NostrEvent | undefined;
  const senderRelays = toRelayList(senderFallbackRelays);
  const resolveInboxRelays = (pubkey: string) => recipientInboxRelays(
    pubkey,
    pubkey === account.pubkey && senderRelays.length ? senderRelays : relayList,
  );
  const publishWrap = async ({ wrap, signer }: typeof wraps[number], publishRelays: string[]) => {
    const session = await NostrSession.init(publishRelays);
    await session.publishRaw(wrap as NostrEvent, { relayUrls: publishRelays, returnEvent: false, proofOfWorkSigner: signer });
  };
  if (directRecipient) {
    const recipientRelays = await resolveInboxRelays(directRecipient);
    for (const wrap of wraps) {
      const publishRelays = payload.item.type === "board" && wrap.recipient !== directRecipient
        ? await resolveInboxRelays(wrap.recipient)
        : recipientRelays;
      await publishWrap(wrap, publishRelays);
    }
    return senderCopy;
  }
  const results = await Promise.allSettled(wraps.map(async (wrap) => {
    const publishRelays = await resolveInboxRelays(wrap.recipient);
    await publishWrap(wrap, publishRelays);
  }));
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("The board could not be sent to everyone in the group.");
  }
  return senderCopy;
}

function toRelayList(input: unknown): string[] {
  let candidates: unknown[] = [];
  if (Array.isArray(input)) {
    candidates = input;
  } else if (typeof input === "string") {
    candidates = input.split(",");
  } else if (input && typeof input === "object" && (input as any)[Symbol.iterator]) {
    candidates = Array.from(input as Iterable<unknown>);
  }
  return normalizeRelayList(candidates) ?? [];
}
