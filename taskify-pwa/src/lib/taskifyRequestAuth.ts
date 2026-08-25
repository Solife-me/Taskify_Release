import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Sign the exact request body with the user's existing Nostr account key. */
export async function signTaskifyRequestHeaders(
  privateKeyHex: string,
  body = "",
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const hash = sha256(new TextEncoder().encode(`${timestamp}.${body}`));
  const privateKey = hexToBytes(privateKeyHex);
  return {
    "X-Taskify-Npub": bytesToHex(schnorr.getPublicKey(privateKey)),
    "X-Taskify-Timestamp": timestamp,
    "X-Taskify-Sig": bytesToHex(schnorr.sign(hash, privateKey)),
  };
}
