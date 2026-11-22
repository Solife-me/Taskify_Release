// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSummary: vi.fn(),
  listBlobs: vi.fn(),
  protectBlob: vi.fn(),
  deleteBlob: vi.fn(),
  createOrder: vi.fn(),
  getOrder: vi.fn(),
  listOrders: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ show: mocks.showToast }),
}));

vi.mock("../../lib/blossomStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blossomStorage")>();
  return {
    ...actual,
    getBlossomStorageSummary: mocks.getSummary,
    listBlossomStorageBlobs: mocks.listBlobs,
    protectBlossomStorageBlob: mocks.protectBlob,
    deleteBlossomStorageBlob: mocks.deleteBlob,
    createBlossomStorageOrder: mocks.createOrder,
    getBlossomStorageOrder: mocks.getOrder,
    listBlossomStorageOrders: mocks.listOrders,
  };
});

import { StorageSection } from "./StorageSection";
import type { Task } from "taskify-core";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MATCHED_HASH = "a".repeat(64);
const UNMATCHED_HASH = "b".repeat(64);

const summary = {
  protected: { usedBytes: 25_000_000, limitBytes: 100_000_000 },
  total: { usedBytes: 200_000_000, limitBytes: 500_000_000 },
  permanentExtraBytes: 0,
  paidStorage: [],
  protectionSeconds: 365 * 86400,
  standardRules: [{ type: "inactivity", expiration: 30 * 86400 }],
  offers: [
    { planId: "plan-500", planName: "500 MB", interval: "month", priceUsdCents: 500, bytes: 500_000_000, durationSeconds: 30 * 86400 },
    { planId: "plan-500", planName: "500 MB", interval: "year", priceUsdCents: 5000, bytes: 500_000_000, durationSeconds: 365 * 86400 },
  ],
};

const blobs = [
  {
    url: `https://blossom.band/${MATCHED_HASH}.bin`,
    sha256: MATCHED_HASH,
    size: 48_000,
    type: "application/octet-stream",
    uploaded: 1_790_000_000,
    lastAccessed: 1_790_000_000,
    standardInactivitySeconds: 30 * 86400,
    tier: "protected",
    protectedUntil: 1_900_000_000,
  },
  {
    url: `https://blossom.band/${UNMATCHED_HASH}.bin`,
    sha256: UNMATCHED_HASH,
    size: 12_000,
    type: "application/octet-stream",
    uploaded: 1_790_000_000,
    lastAccessed: 1_790_000_000,
    standardInactivitySeconds: 30 * 86400,
    tier: "standard",
    protectedUntil: null,
  },
];

const task = {
  id: "task-1",
  boardId: "board-1",
  title: "Sign the lease",
  dueISO: "2026-11-20",
  documents: [{
    id: "doc-1",
    name: "Lease.pdf",
    mimeType: "application/pdf",
    kind: "pdf",
    dataUrl: "",
    preview: { type: "image", data: "data:image/png;base64,AA==" },
    createdAt: "2026-11-20T00:00:00.000Z",
    remoteUrl: `https://blossom.band/${MATCHED_HASH}.bin`,
    encrypted: true,
    ciphertextSha256: MATCHED_HASH,
    storageServer: "https://blossom.band",
    retention: "protected",
  }],
} as Task;

test("shows usage, resumable external-wallet checkout, matched filenames, and unmatched blobs", async () => {
  vi.clearAllMocks();
  mocks.getSummary.mockResolvedValue(summary);
  mocks.listBlobs.mockResolvedValue({ blobs, nextCursor: null });
  const order = {
    id: "order-1",
    planId: "plan-500",
    planName: "500 MB",
    interval: "month",
    priceUsdCents: 500,
    bytes: 500_000_000,
    amountSats: 99,
    paymentHash: "c".repeat(64),
    invoice: "lnbc1000n1qqqq",
    invoiceExpiresAt: Math.floor(Date.now() / 1000) + 900,
    paidThrough: null,
  };
  mocks.listOrders.mockResolvedValue([order]);
  mocks.createOrder.mockResolvedValue(null);
  mocks.getOrder.mockResolvedValue(order);
  mocks.protectBlob.mockResolvedValue({ tier: "protected", protectedUntil: 1_900_000_000 });
  mocks.deleteBlob.mockResolvedValue(undefined);

  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(
    <StorageSection
      settings={{
        fileStorageServer: "https://blossom.band",
        encryptedFileStorageServer: "https://blossom.band",
        managedBlossomServer: "https://blossom.band",
        fileServers: JSON.stringify([{ url: "https://blossom.band", type: "blossom" }]),
        encryptedFileServers: JSON.stringify([{ url: "https://blossom.band", type: "blossom" }]),
      } as any}
      setSettings={vi.fn()}
      pubkeyHex={"d".repeat(64)}
      signerKey={"1".repeat(64)}
      tasks={[task]}
    />,
  ));

  const expandButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-accordion__header")]
    .find((button) => button.textContent?.includes("Blossom account storage"));
  if (!expandButton) throw new Error("Storage accordion not found");
  await act(async () => expandButton.click());

  expect(container.textContent).toContain("Protected");
  expect(container.textContent).toContain("25 MB of 100 MB");
  expect(container.textContent).toContain("200 MB of 500 MB");
  expect(container.textContent).toContain("$5.00");
  expect(container.textContent).toContain("100 sat");
  expect(container.textContent).toContain("Lease.pdf");
  expect(container.textContent).toContain("Sign the lease");
  expect(container.textContent).toContain("Unmatched blob");
  expect(container.textContent).toContain("Copy BOLT11 invoice");
  expect(container.textContent).not.toContain("Upcoming protection expiries");
  expect(mocks.getOrder).toHaveBeenCalledTimes(1);

  mocks.getOrder.mockResolvedValue({ ...order, paidThrough: Math.floor(Date.now() / 1000) + 2_592_000 });
  mocks.getSummary.mockResolvedValue({
    ...summary,
    total: { usedBytes: 200_000_000, limitBytes: 1_000_000_000 },
  });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));

  expect(container.textContent).toContain("Payment settled");
  expect(container.textContent).toContain("200 MB of 1.00 GB");
  expect(container.textContent).not.toContain("Copy BOLT11 invoice");

  await act(async () => root.unmount());
}, 15000);
