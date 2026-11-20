import { kvStorage } from "../storage/kvStorage";

const LS_BLOSSOM_ATTACHMENT_INDEX = "taskify_blossom_attachment_index_v1";

type IndexedAttachment = {
  sha256: string;
  serverUrl: string;
  seenAt: number;
};

type AttachmentIndex = Record<string, IndexedAttachment>;

function loadIndex(): AttachmentIndex {
  try {
    const parsed = JSON.parse(kvStorage.getItem(LS_BLOSSOM_ATTACHMENT_INDEX) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Records the ciphertext hash observed while fetching/decrypting a local attachment. */
export function rememberAttachmentCiphertextHash(url: string, sha256: string, serverUrl?: string): void {
  const cleanURL = url.trim();
  const hash = sha256.trim().toLowerCase();
  if (!cleanURL || !/^[0-9a-f]{64}$/.test(hash)) return;
  let resolvedServer = serverUrl?.trim() || "";
  if (!resolvedServer) {
    try { resolvedServer = new URL(cleanURL).origin; } catch { return; }
  }
  const index = loadIndex();
  index[cleanURL] = { sha256: hash, serverUrl: resolvedServer, seenAt: Date.now() };
  // Keep the local join index bounded; recently opened attachments are the useful ones.
  const bounded = Object.entries(index)
    .sort(([, a], [, b]) => b.seenAt - a.seenAt)
    .slice(0, 1000);
  kvStorage.setItem(LS_BLOSSOM_ATTACHMENT_INDEX, JSON.stringify(Object.fromEntries(bounded)));
}

export function lookupAttachmentCiphertextHash(url: string): IndexedAttachment | null {
  const entry = loadIndex()[url.trim()];
  if (!entry || !/^[0-9a-f]{64}$/.test(entry.sha256)) return null;
  return entry;
}
