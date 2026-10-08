import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const V2_LABEL = "taskify-request-v2";

/**
 * The text a version-2 signature covers: label, method, host, path with query, timestamp, and
 * the body's SHA-256 in hex, one per line. Must match `taskifyAuthV2Message` in
 * worker/src/nostr-auth.ts and the iOS and Watch signers.
 */
export function taskifyRequestMessage(method: string, url: URL, timestamp: number, body: string): string {
  return [
    V2_LABEL,
    method.toUpperCase(),
    url.host.toLowerCase(),
    `${url.pathname}${url.search}`,
    String(timestamp),
    bytesToHex(sha256(new TextEncoder().encode(body))),
  ].join("\n");
}

/**
 * Sign a Worker request with the user's Nostr account key. The signature covers the method,
 * host, route, and exact body, is valid for a minute, and the Worker accepts it once.
 */
export async function signTaskifyRequestHeaders(
  privateKeyHex: string,
  request: { method: string; url: string; body?: string },
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const base = typeof window !== "undefined" ? window.location.href : undefined;
  const message = taskifyRequestMessage(request.method, new URL(request.url, base), timestamp, request.body ?? "");
  const privateKey = hexToBytes(privateKeyHex);
  return {
    "X-Taskify-Auth": "v2",
    "X-Taskify-Npub": bytesToHex(schnorr.getPublicKey(privateKey)),
    "X-Taskify-Timestamp": String(timestamp),
    "X-Taskify-Sig": bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(message)), privateKey)),
  };
}
