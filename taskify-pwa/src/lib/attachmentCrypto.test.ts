// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
}));

vi.mock("../nostr/Nip96Client", () => ({
  uploadFile: mocks.uploadFile,
}));

import { encryptAndUploadAttachment } from "./attachmentCrypto";

describe("encrypted task attachment uploads", () => {
  beforeEach(() => {
    mocks.uploadFile.mockReset();
    mocks.uploadFile.mockResolvedValue({ url: "https://files.example/opaque.bin" });
  });

  test("never sends the original filename to the file host", async () => {
    const remote = await encryptAndUploadAttachment({
      boardId: "board-private",
      data: new TextEncoder().encode("confidential screenshot"),
      mimeType: "image/png",
      filename: "Board acquisition - final.png",
      serverEntry: { url: "https://originless.example", type: "originless" },
      nostrSkHex: "1".repeat(64),
    });

    expect(remote).toBe("https://files.example/opaque.bin");
    const upload = mocks.uploadFile.mock.calls[0]?.[0];
    expect(upload).toBeDefined();
    expect(upload.filename).toMatch(/^[0-9a-f]{64}\.bin$/);
    expect(upload.filename).not.toContain("Board");
    expect(upload.filename).not.toContain(".png");
    expect(upload.contentType).toBe("application/octet-stream");
    expect(upload.debugMeta.uploadFilename).toBe(upload.filename);
  });
});
