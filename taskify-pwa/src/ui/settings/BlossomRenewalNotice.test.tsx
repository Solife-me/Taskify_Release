// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { getBlossomStorageSummary, listBlossomStorageBlobs } from "../../lib/blossomStorage";
import BlossomRenewalNotice from "./BlossomRenewalNotice";

vi.mock("../../lib/blossomStorage", () => ({
  getBlossomStorageSummary: vi.fn(),
  listBlossomStorageBlobs: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("groups renewals using each server's advertised window and opens the earliest server", async () => {
  const managed = "https://managed.example";
  const custom = "https://custom.example";
  const now = Math.floor(Date.now() / 1000);
  function blob(sha256: string, days: number) {
    return {
      sha256,
      protectedUntil: now + days * 86_400,
      tier: "protected" as const,
      url: `${managed}/${sha256}`,
      type: "application/octet-stream",
      size: 1,
      uploaded: now,
      lastAccessed: now,
      standardInactivitySeconds: null,
    };
  }
  vi.mocked(getBlossomStorageSummary).mockImplementation(async (url) => ({
    protected: { usedBytes: 1, limitBytes: 100 },
    total: { usedBytes: 1, limitBytes: 500 },
    protectionSeconds: 365 * 86_400,
    renewalWindowSeconds: url === managed ? 90 * 86_400 : undefined,
    permanentExtraBytes: 0,
    paidStorage: [],
    offers: [],
    standardRules: [],
  }));
  vi.mocked(listBlossomStorageBlobs).mockImplementation(async ({ serverUrl, cursor }) => {
    if (serverUrl === custom) return { blobs: [blob("older-server", 60)], nextCursor: null };
    return cursor
      ? { blobs: [blob("expiring-first", 2)], nextCursor: null }
      : { blobs: [blob("expiring-later", 60), blob("not-yet", 91)], nextCursor: "next" };
  });

  const container = document.createElement("div");
  const root = createRoot(container);
  const onReview = vi.fn();
  try {
    await act(async () => root.render(
      <BlossomRenewalNotice
        settings={{
          managedBlossomServer: managed,
          fileStorageServer: "https://nostr.build",
          encryptedFileStorageServer: custom,
          fileServers: "[]",
          encryptedFileServers: JSON.stringify([{ url: custom, type: "blossom" }]),
        }}
        signerKey="test"
        onReview={onReview}
      />,
    ));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.textContent).toContain("2 attachments can be renewed");
    expect(listBlossomStorageBlobs).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: managed, cursor: "next" }));
    await act(async () => container.querySelector("button")?.click());
    expect(onReview).toHaveBeenCalledWith(managed);
  } finally {
    await act(async () => root.unmount());
  }
});
