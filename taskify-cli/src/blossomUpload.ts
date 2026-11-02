/**
 * blossomUpload.ts — Blossom (BUD-01/BUD-02) blob upload for Taskify CLI.
 * Mirrors uploadFileToBlossom in taskify-pwa/src/nostr/Nip96Client.ts.
 */

import { createHash } from "node:crypto";
import { finalizeEvent, nip19 } from "nostr-tools";
import { fixedFileUploadURL } from "taskify-core";

/** A kind-24242 event, base64url-encoded per the spec, unlike NIP-98's standard base64. */
function buildBlossomAuthHeader(sha256Hex: string, nsec: string, now: number): string {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error("Invalid nsec for Blossom auth.");
  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      tags: [
        ["t", "upload"],
        ["x", sha256Hex],
        ["expiration", String(now + 3600)],
      ],
      content: "Upload Blob",
    },
    decoded.data as Uint8Array,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`;
}

/** Uploads bytes exactly as given, so callers encrypt first. Returns the blob's described URL. */
export async function uploadBlobToBlossom(opts: {
  serverUrl: string;
  bytes: Uint8Array;
  nsec: string;
}): Promise<string> {
  const sha256Hex = createHash("sha256").update(opts.bytes).digest("hex");
  const res = await fetch(fixedFileUploadURL(opts.serverUrl, "blossom"), {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: buildBlossomAuthHeader(sha256Hex, opts.nsec, Math.floor(Date.now() / 1000)),
    },
    body: Buffer.from(opts.bytes),
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) throw new Error(data?.message || `Blossom upload failed (${res.status})`);
  const url = typeof data?.url === "string" ? data.url.trim() : "";
  if (!url) throw new Error("Blossom upload response did not include a url.");
  return url;
}
