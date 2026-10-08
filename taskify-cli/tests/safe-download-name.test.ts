import assert from "node:assert/strict";
import test from "node:test";
import { safeDownloadName } from "../src/shared/safeDownloadName.ts";

test("attachment names cannot leave the current directory", () => {
  assert.equal(safeDownloadName("../../.zshrc", "document-1"), "zshrc");
  assert.equal(safeDownloadName("/Users/me/.ssh/authorized_keys", "document-1"), "authorized_keys");
  assert.equal(safeDownloadName("..\\..\\boot.ini", "document-1"), "boot.ini");
  assert.equal(safeDownloadName("..", "document-2"), "document-2");
  assert.equal(safeDownloadName("dir/", "document-3"), "document-3");
  assert.equal(safeDownloadName("a\u001b[2Kb.pdf", "document-4"), "a[2Kb.pdf");
  assert.equal(safeDownloadName(undefined, "document-5"), "document-5");
});

test("ordinary names are kept", () => {
  assert.equal(safeDownloadName("Quarterly report.pdf", "document-1"), "Quarterly report.pdf");
});
