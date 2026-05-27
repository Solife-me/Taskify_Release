/**
 * nip96Upload.ts — NIP-96 file upload for Taskify CLI.
 * Ported from taskify-pwa/src/nostr/Nip96Client.ts
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";

const NIP96_DISCOVERY_PATH = "/.well-known/nostr/nip96.json";

type Nip96Info = {
  baseUrl: string;
  apiUrl: string;
};

async function discoverNip96Server(serverUrl: string, depth = 0): Promise<Nip96Info> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  if (depth > 3) throw new Error("NIP-96 discovery redirected too many times.");
  const res = await fetch(`${baseUrl}${NIP96_DISCOVERY_PATH}`);
  if (!res.ok) throw new Error(`Failed to load NIP-96 info (${res.status})`);
  const data = await res.json() as Record<string, unknown>;
  if (!data || typeof data !== "object") throw new Error("Invalid NIP-96 discovery response");
  const apiUrl = typeof data.api_url === "string" ? data.api_url.trim() : "";
  if (!apiUrl) throw new Error("NIP-96 api_url missing from discovery response");
  // Handle relative api_url
  const resolved = apiUrl.startsWith("http") ? apiUrl : `${baseUrl}${apiUrl}`;
  return { baseUrl, apiUrl: resolved };
}

function buildNip98AuthHeader(
  url: string,
  method: string,
  payloadHash: string,
  nsec: string,
): string {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error("Invalid nsec for NIP-98 auth.");
  const sk = decoded.data as Uint8Array;

  // Build a NIP-98 auth event (kind 27235) and base64-encode it
  const { getPublicKey, finalizeEvent } = require("nostr-tools") as typeof import("nostr-tools");
  const pubkey = getPublicKey(sk);
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", method],
        ["payload", payloadHash],
      ],
      content: "",
    },
    sk,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

function mimeTypeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Upload a local image file to a NIP-96 server. Returns the public URL. */
export async function uploadImageToNip96(opts: {
  serverUrl: string;
  filePath: string;
  nsec: string;
  timeoutMs?: number;
}): Promise<string> {
  const info = await discoverNip96Server(opts.serverUrl);
  const bytes = await readFile(opts.filePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const contentType = mimeTypeFromPath(opts.filePath);
  const filename = opts.filePath.split("/").pop() ?? "avatar";

  const authHeader = buildNip98AuthHeader(info.apiUrl, "POST", hash, opts.nsec);

  const form = new FormData();
  const blob = new Blob([bytes], { type: contentType });
  form.append("file", blob, filename);
  form.append("media_type", "avatar");
  form.append("content_type", contentType);
  form.append("size", String(bytes.length));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  let res: Response;
  try {
    res = await fetch(info.apiUrl, {
      method: "POST",
      headers: { Authorization: authHeader },
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  let data: Record<string, unknown> = {};
  try { data = await res.json() as Record<string, unknown>; } catch {}

  // Handle async processing (202 + processing_url)
  if (res.status === 202 && typeof data.processing_url === "string") {
    const processingUrl = new URL(data.processing_url, info.apiUrl).toString();
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_500));
      const poll = await fetch(processingUrl, { headers: { Authorization: authHeader } });
      let pollData: Record<string, unknown> = {};
      try { pollData = await poll.json() as Record<string, unknown>; } catch {}
      if (poll.status === 200 || poll.status === 201) {
        data = pollData;
        break;
      }
    }
  } else if (!res.ok) {
    throw new Error((data.message as string) ?? `Upload failed (${res.status})`);
  }

  // Extract URL from response
  const url =
    (data.url as string | undefined) ??
    ((data.nip94_event as any)?.tags?.find((t: string[]) => t[0] === "url")?.[1] as string | undefined) ??
    ((data.nip94 as any)?.tags?.find((t: string[]) => t[0] === "url")?.[1] as string | undefined);

  if (!url) throw new Error("NIP-96 upload response did not include a file URL.");
  return url;
}
