import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

function bytesToBase64(bytes: Uint8Array): string {
  const Buf = (globalThis as any).Buffer;
  if (Buf) {
    return Buf.from(bytes).toString('base64');
  }
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const Buf = (globalThis as any).Buffer;
  if (Buf) {
    return new Uint8Array(Buf.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(boardId: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(boardId));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToBoard(boardId: string, plaintext: string): Promise<string> {
  const key = await deriveKey(boardId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const combined = new Uint8Array(iv.length + ctBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ctBuf), iv.length);
  return bytesToBase64(combined);
}

export async function decryptFromBoard(boardId: string, data: string): Promise<string> {
  const key = await deriveKey(boardId);
  const bytes = base64ToBytes(data);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  const dec = new TextDecoder();
  return dec.decode(ptBuf);
}

export function boardTag(boardId: string): string {
  return bytesToHex(sha256(boardId));
}
