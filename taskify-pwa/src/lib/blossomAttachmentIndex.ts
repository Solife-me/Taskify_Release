import { kvStorage } from "../storage/kvStorage";

const LS_BLOSSOM_ATTACHMENT_INDEX = "taskify_blossom_attachment_index_v1";

type IndexedAttachment = {
  sha256: string;
  serverUrl: string;
  seenAt: number;
  retention?: "protected" | "standard";
};

type AttachmentIndex = Record<string, IndexedAttachment>;

export function readAttachmentCiphertextIndex(): AttachmentIndex {
  try {
    const parsed = JSON.parse(kvStorage.getItem(LS_BLOSSOM_ATTACHMENT_INDEX) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Records the ciphertext hash observed while fetching/decrypting a local attachment. */
export function rememberAttachmentCiphertextHash(
  url: string,
  sha256: string,
  upload?: Pick<IndexedAttachment, "serverUrl" | "retention">,
): void {
  const cleanURL = url.trim();
  const hash = sha256.trim().toLowerCase();
  if (!cleanURL || !/^[0-9a-f]{64}$/.test(hash)) return;
  const index = readAttachmentCiphertextIndex();
  const existing = index[cleanURL];
  const prior = existing?.sha256 === hash ? existing : undefined;
  let resolvedServer = upload?.serverUrl.trim() || prior?.serverUrl || "";
  if (!resolvedServer) {
    try { resolvedServer = new URL(cleanURL).origin; } catch { return; }
  }
  index[cleanURL] = {
    sha256: hash,
    serverUrl: resolvedServer,
    seenAt: Date.now(),
    retention: upload?.retention ?? prior?.retention,
  };
  // Keep the local join index bounded; recently opened attachments are the useful ones.
  const bounded = Object.entries(index)
    .sort(([, a], [, b]) => b.seenAt - a.seenAt)
    .slice(0, 1000);
  kvStorage.setItem(LS_BLOSSOM_ATTACHMENT_INDEX, JSON.stringify(Object.fromEntries(bounded)));
}

export function lookupAttachmentCiphertextHash(url: string): IndexedAttachment | null {
  const entry = readAttachmentCiphertextIndex()[url.trim()];
  if (!entry || !/^[0-9a-f]{64}$/.test(entry.sha256)) return null;
  return entry;
}
