/**
 * NIP-44 calendar encryption/decryption for CLI-side calendar interop with PWA.
 * Ported from taskify-pwa/src/lib/privateCalendar.ts.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { nip44 } from "nostr-tools";

function ensureNip44V2() {
  if (!nip44?.v2) {
    throw new Error("NIP-44 v2 encryption is unavailable.");
  }
  return nip44.v2;
}

function bytesToBase64(bytes: Uint8Array): string {
  const Buf = (globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (Buf) {
    return Buf.from(bytes).toString("base64");
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const Buf = (globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (Buf) {
    return new Uint8Array(Buf.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

export function generateEventKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(bytes);
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
  const plaintext = nip44v2.decrypt(content, conversationKey);
  return JSON.parse(plaintext);
}

export async function encryptCalendarPayloadWithEventKey(
  payload: unknown,
  eventKey: string,
): Promise<string> {
  const nip44v2 = ensureNip44V2();
  const keyBytes = eventKeyToBytes(eventKey);
  if (!keyBytes) throw new Error("Invalid event key.");
  return nip44v2.encrypt(JSON.stringify(payload), keyBytes);
}

export async function decryptCalendarPayloadWithEventKey(
  content: string,
  eventKey: string,
): Promise<unknown> {
  const nip44v2 = ensureNip44V2();
  const keyBytes = eventKeyToBytes(eventKey);
  if (!keyBytes) throw new Error("Invalid event key.");
  const plaintext = nip44v2.decrypt(content, keyBytes);
  return JSON.parse(plaintext);
}
