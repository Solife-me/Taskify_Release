import { nip04 } from "nostr-tools";
import { getSkSync as nostrSkSync } from "../../lib/nostrSkStore";
import {
  sha256,
  bytesHexToBytes as hexToBytes,
  bytesToHexString as bytesToHex,
  concatBytes,
  b64encode,
  b64decode,
  CLOUD_BACKUP_KEY_LABEL,
  deriveBackupAesKey,
  encryptBackupWithSecretKey,
  decryptBackupWithSecretKey,
} from "taskify-core";

export {
  sha256,
  hexToBytes,
  bytesToHex,
  concatBytes,
  b64encode,
  b64decode,
  CLOUD_BACKUP_KEY_LABEL,
  deriveBackupAesKey,
  encryptBackupWithSecretKey,
  decryptBackupWithSecretKey,
};

async function deriveAesKeyFromLocalSk(): Promise<CryptoKey> {
  const skHex = nostrSkSync();
  if (!skHex || !/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  const label = new TextEncoder().encode("taskify-ecash-v1");
  const raw = concatBytes(hexToBytes(skHex), label);
  const digest = await sha256(raw);
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
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

export async function encryptEcashTokenForRecipient(recipientHex: string, plain: string): Promise<{ alg: "nip04"; data: string }> {
  const skHex = nostrSkSync();
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  if (!/^[0-9a-fA-F]{64}$/.test(recipientHex)) throw new Error("Invalid recipient pubkey");
  const data = await nip04.encrypt(skHex, recipientHex, plain);
  return { alg: "nip04", data };
}

export async function decryptEcashTokenForRecipient(senderHex: string, enc: { alg: "nip04"; data: string }): Promise<string> {
  const skHex = nostrSkSync();
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  if (!/^[0-9a-fA-F]{64}$/.test(senderHex)) throw new Error("Invalid sender pubkey");
  return await nip04.decrypt(skHex, senderHex, enc.data);
}
