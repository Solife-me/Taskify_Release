import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { nip44 } from "nostr-tools";
export {
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
  TASKIFY_CALENDAR_RSVP_KIND,
  calendarAddress,
  parseCalendarAddress,
  parseCalendarCanonicalPayload,
  parseCalendarViewPayload,
  parseCalendarRsvpPayload,
} from "taskify-core";

export type {
  CalendarRsvpStatus,
  CalendarRsvpFb,
  CalendarParticipant,
  CalendarCanonicalPayload,
  CalendarViewPayload,
  CalendarRsvpPayload,
} from "taskify-core";

function ensureNip44V2() {
  if (!nip44?.v2) {
    throw new Error("NIP-44 v2 encryption is unavailable.");
  }
  return nip44.v2;
}

function bytesToBase64(bytes: Uint8Array): string {
  const Buf = (globalThis as any).Buffer;
  if (Buf) {
    return Buf.from(bytes).toString("base64");
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const BOARD_RSVP_TOKEN_LABEL = new TextEncoder().encode("taskify-board-rsvp-token-v1");

export function deriveBoardRsvpToken(boardId: string, attendeePubkey: string): string {
  const normalizedBoardId = (boardId || "").trim();
  const normalizedPubkey = (attendeePubkey || "").trim().toLowerCase();
  const material = concatBytes(
    BOARD_RSVP_TOKEN_LABEL,
    new TextEncoder().encode(`${normalizedBoardId}:${normalizedPubkey}`),
  );
  const digest = sha256(material);
  return bytesToBase64(digest);
}

function base64ToBytes(base64: string): Uint8Array {
  const Buf = (globalThis as any).Buffer;
  if (Buf) {
    return new Uint8Array(Buf.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateEventKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(bytes);
}

export function generateInviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToBase64(bytes);
}

function eventKeyToBytes(eventKey: string): Uint8Array | null {
  const trimmed = eventKey.trim();
  if (!trimmed) return null;
  try {
    const bytes = base64ToBytes(trimmed);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export async function encryptCalendarPayloadForBoard(
  payload: unknown,
  boardSkHex: string,
  boardPk: string,
): Promise<string> {
  const nip44v2 = ensureNip44V2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(boardSkHex), boardPk);
  return nip44v2.encrypt(JSON.stringify(payload), conversationKey);
}

export async function decryptCalendarPayloadForBoard(
  content: string,
  boardSkHex: string,
  boardPk: string,
): Promise<unknown> {
  const nip44v2 = ensureNip44V2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(boardSkHex), boardPk);
  const plaintext = await nip44v2.decrypt(content, conversationKey);
  return JSON.parse(plaintext);
}

export async function encryptCalendarPayloadWithEventKey(payload: unknown, eventKey: string): Promise<string> {
  const nip44v2 = ensureNip44V2();
  const keyBytes = eventKeyToBytes(eventKey);
  if (!keyBytes) throw new Error("Invalid event key.");
  return nip44v2.encrypt(JSON.stringify(payload), keyBytes);
}

export async function decryptCalendarPayloadWithEventKey(content: string, eventKey: string): Promise<unknown> {
  const nip44v2 = ensureNip44V2();
  const keyBytes = eventKeyToBytes(eventKey);
  if (!keyBytes) throw new Error("Invalid event key.");
  const plaintext = await nip44v2.decrypt(content, keyBytes);
  return JSON.parse(plaintext);
}

export async function encryptCalendarRsvpPayload(
  payload: unknown,
  attendeeSkHex: string,
  boardPubkey: string,
): Promise<string> {
  const nip44v2 = ensureNip44V2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(attendeeSkHex), boardPubkey);
  return nip44v2.encrypt(JSON.stringify(payload), conversationKey);
}

export async function decryptCalendarRsvpPayload(
  content: string,
  boardSkHex: string,
  attendeePubkey: string,
): Promise<unknown> {
  const nip44v2 = ensureNip44V2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(boardSkHex), attendeePubkey);
  const plaintext = await nip44v2.decrypt(content, conversationKey);
  return JSON.parse(plaintext);
}

export async function decryptCalendarRsvpPayloadForAttendee(
  content: string,
  attendeeSkHex: string,
  boardPubkey: string,
): Promise<unknown> {
  const nip44v2 = ensureNip44V2();
  const conversationKey = nip44v2.utils.getConversationKey(hexToBytes(attendeeSkHex), boardPubkey);
  const plaintext = await nip44v2.decrypt(content, conversationKey);
  return JSON.parse(plaintext);
}
