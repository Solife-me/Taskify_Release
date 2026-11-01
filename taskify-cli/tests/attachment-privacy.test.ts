import test from "node:test";
import assert from "node:assert/strict";
import { attachmentUploadFilename } from "../src/attachmentUploadNaming.ts";

test("CLI encrypted attachments use a content-addressed filename with no source metadata", () => {
  const ciphertext = new TextEncoder().encode("opaque ciphertext for a private tax return");
  const filename = attachmentUploadFilename(ciphertext);
  assert.match(filename, /^[0-9a-f]{64}\.bin$/);
  assert.doesNotMatch(filename, /tax|return|\.pdf/i);
  assert.equal(filename, attachmentUploadFilename(ciphertext));
  assert.notEqual(filename, attachmentUploadFilename(new TextEncoder().encode("different")));
});
