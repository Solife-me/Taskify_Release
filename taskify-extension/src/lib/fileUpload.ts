/**
 * Uploading an encrypted attachment to a file server.
 *
 * Taskify supports three kinds of file server, and the panel uses the same set the PWA offers:
 *   - NIP-96   (`nostr.build`): a POST to the server's discovered API URL, signed with NIP-98
 *   - Blossom  (`blossom.solife.me` by default): a PUT to `/upload` signed with BUD-11
 *   - Originless (`originless.solife.me`): a POST to `/up`; it answers with a CID, and the file
 *     is then read back through a public IPFS gateway
 *
 * The server only ever receives ciphertext: the file is encrypted before it is uploaded.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, getEventHash, type EventTemplate } from "nostr-tools";

export type FileServerType = "nip96" | "blossom" | "originless";

export type FileServer = {
  url: string;
  type: FileServerType;
  label?: string;
};

/** Keep in sync with taskify-core's DEFAULT_MEDIA_STORAGE_SERVER. */
const MANAGED_BLOSSOM_SERVER = "https://blossom.solife.me";

export const DEFAULT_FILE_SERVERS: FileServer[] = [
  { url: MANAGED_BLOSSOM_SERVER, type: "blossom", label: "blossom.solife.me" },
  { url: "https://nostr.build", type: "nip96", label: "nostr.build" },
  { url: "https://originless.solife.me", type: "originless", label: "originless.solife.me" },
];

/** The gateway Originless-served files are read back through. */
export const IPFS_GATEWAY_BASE = "https://dweb.link";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** NIP-98: an `Authorization: Nostr <base64url event>` header proving who uploaded the file. */
async function nip98AuthHeader(options: {
  url: string;
  method: string;
  payloadHash: string;
  secretKeyHex: string;
}): Promise<string> {
  const tags: string[][] = [
    ["u", options.url],
    ["method", options.method],
  ];
  // The payload hash lets the server check the body it received is the one that was signed.
  if (options.payloadHash) tags.push(["payload", options.payloadHash]);
  const event: EventTemplate = {
    kind: 27235,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags,
  };
  const signed = finalizeEvent(event, hexToBytes(options.secretKeyHex));
  return `Nostr ${base64Url(new TextEncoder().encode(JSON.stringify(signed)))}`;
}

function blossomServerHost(serverUrl: string): string {
  try {
    return new URL(trimSlash(serverUrl)).host.toLowerCase();
  } catch {
    return serverUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  }
}

/** BUD-11 authorization for Blossom's standard upload endpoint. */
function bud11UploadAuthHeader(options: {
  serverUrl: string;
  payloadHash: string;
  secretKeyHex: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const event: EventTemplate = {
    kind: 24242,
    content: "Upload Blob",
    created_at: now,
    tags: [
      ["t", "upload"],
      ["x", options.payloadHash],
      ["expiration", String(now + 3600)],
      ["server", blossomServerHost(options.serverUrl)],
    ],
  };
  const signed = finalizeEvent(event, hexToBytes(options.secretKeyHex));
  return `Nostr ${base64Url(new TextEncoder().encode(JSON.stringify(signed)))}`;
}

/** A NIP-96 server's upload endpoint, from its `/.well-known/nostr/nip96.json`. */
async function discoverNip96(serverUrl: string): Promise<string> {
  const base = trimSlash(serverUrl);
  try {
    const response = await fetch(`${base}/.well-known/nostr/nip96.json`);
    if (response.ok) {
      const info = (await response.json()) as { api_url?: string };
      if (info?.api_url) return info.api_url;
    }
  } catch {
    // The well-known file is optional; the base URL is the usual upload path.
  }
  return `${base}/upload`;
}

/** The URL a file uploaded to Originless can be read back from. */
function resolveOriginlessUrl(payload: unknown, serverUrl: string): string {
  const data = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  for (const key of ["url", "cidUrl", "gatewayUrl", "fileUrl", "ipfs"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const cid = typeof data.cid === "string" ? data.cid.trim() : "";
  if (cid && (cid.length >= 46 || cid.startsWith("b")) && /^[A-Za-z0-9]+$/.test(cid)) {
    return `${IPFS_GATEWAY_BASE}/ipfs/${cid}`;
  }
  const path = typeof data.path === "string" ? data.path.trim() : "";
  if (path.startsWith("http")) return path;
  const base = trimSlash(serverUrl);
  return path ? `${base}/${path.replace(/^\/+/, "")}` : base;
}

export type UploadOptions = {
  server: FileServer;
  data: Uint8Array;
  filename: string;
  mimeType: string;
  secretKeyHex: string;
  onProgress?: (progress: number) => void;
};

/**
 * Uploads a file and returns the URL it can be read back from. Throws when the server refuses,
 * so the caller can offer the next server in the list.
 */
export async function uploadEncryptedFile(options: UploadOptions): Promise<string> {
  const { server, data, filename, secretKeyHex } = options;
  const base = trimSlash(server.url);

  if (server.type === "blossom") {
    const url = `${base}/upload`;
    const hash = bytesToHex(sha256(data));
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-SHA-256": hash,
      Authorization: bud11UploadAuthHeader({ serverUrl: base, payloadHash: hash, secretKeyHex }),
    };
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: data as unknown as BodyInit,
    });
    if (!response.ok) throw new Error(`${server.label ?? base} refused the upload (${response.status}).`);
    const payload = (await response.json().catch(() => ({}))) as { url?: string };
    if (payload?.url) return payload.url;
    return `${base}/${hash}`;
  }

  if (server.type === "originless") {
    const url = `${base}/up`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: data as unknown as BodyInit,
    });
    if (!response.ok) throw new Error(`${server.label ?? base} refused the upload (${response.status}).`);
    const payload = await response.json().catch(() => ({}));
    return resolveOriginlessUrl(payload, base);
  }

  // NIP-96
  const apiUrl = await discoverNip96(base);
  const payloadHash = bytesToHex(sha256(data));
  const form = new FormData();
  // The server receives ciphertext even though the encrypted rumor separately records the
  // plaintext MIME type for the recipient.
  form.append("file", new Blob([data as unknown as BlobPart], { type: "application/octet-stream" }), filename);
  form.append("filename", filename);
  form.append("content_type", "application/octet-stream");
  form.append("size", String(data.byteLength));

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: await nip98AuthHeader({ url: apiUrl, method: "POST", payloadHash, secretKeyHex }),
    },
    body: form,
  });
  if (!response.ok) throw new Error(`${server.label ?? base} refused the upload (${response.status}).`);
  const payload = (await response.json().catch(() => ({}))) as { url?: string; nip94?: { tags?: string[][] } };
  if (payload?.url) return payload.url;
  const nip94Url = payload?.nip94?.tags?.find((tag) => tag[0] === "url")?.[1];
  if (typeof nip94Url === "string" && nip94Url) return nip94Url;
  throw new Error(`${server.label ?? base} did not return a URL for the upload.`);
}

/** Downloads a file the server holds. */
export async function downloadFile(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the file (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

export { getEventHash };
