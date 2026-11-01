import { createHash } from "node:crypto";
import { opaqueUploadFilename } from "taskify-core";

/** Opaque file-host name for already-encrypted attachment bytes. */
export function attachmentUploadFilename(ciphertext: Uint8Array): string {
  const sha256 = createHash("sha256").update(Buffer.from(ciphertext)).digest("hex");
  return opaqueUploadFilename(sha256);
}
