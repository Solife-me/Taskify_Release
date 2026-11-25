// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

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
import { BlossomStorageApiError, type BlossomStorageOrder, type BlossomPrepaidStorageSummary } from "../../lib/blossomStorage";
import type { Task } from "taskify-core";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER = "https://blossom.solife.me";
const MATCHED_HASH = "a".repeat(64);
const UNMATCHED_HASH = "b".repeat(64);

const summary = {
  protected: { usedBytes: 25_000_000, limitBytes: 100_000_000 },
  total: { usedBytes: 200_000_000, limitBytes: 500_000_000 },
  permanentExtraBytes: 0,
  paidStorage: [],
  protectionSeconds: 365 * 86400,
  renewalWindowSeconds: 90 * 86400,
  standardRules: [{ type: "inactivity", expiration: 30 * 86400 }],
  offers: [
    { planId: "plan-500", planName: "500 MB", interval: "month", priceUsdCents: 500, bytes: 500_000_000, durationSeconds: 30 * 86400 },
    { planId: "plan-500", planName: "500 MB", interval: "year", priceUsdCents: 5000, bytes: 500_000_000, durationSeconds: 365 * 86400 },
  ],
};

const blobs = [
  {
    url: `${SERVER}/${MATCHED_HASH}.bin`,
    sha256: MATCHED_HASH,
    size: 48_000,
    type: "application/octet-stream",
    uploaded: 1_790_000_000,
    lastAccessed: 1_790_000_000,
    standardInactivitySeconds: 30 * 86400,
    tier: "protected",
    protectedUntil: Math.floor(Date.now() / 1000) + 60 * 86_400,
  },
  {
    url: `${SERVER}/${UNMATCHED_HASH}.bin`,
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
    remoteUrl: `${SERVER}/${MATCHED_HASH}.bin`,
    encrypted: true,
    ciphertextSha256: MATCHED_HASH,
    storageServer: SERVER,
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
        fileStorageServer: SERVER,
        encryptedFileStorageServer: SERVER,
        managedBlossomServer: SERVER,
        fileServers: JSON.stringify([{ url: SERVER, type: "blossom" }]),
        encryptedFileServers: JSON.stringify([{ url: SERVER, type: "blossom" }]),
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
  expect(container.textContent).toContain("Upcoming protection expiries");
  const fallbackSwitch = container.querySelector<HTMLButtonElement>('button[role="switch"]');
  expect(fallbackSwitch?.getAttribute("aria-checked")).toBe("true");
  expect(fallbackSwitch?.textContent).toBe("On");
  const renewal = [...container.querySelectorAll("button")].find((button) => button.textContent === "Renew");
  expect(renewal?.disabled).toBe(false);
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

const DAY = 86_400;
const SERVER_TIME = 1_900_000_000;
const plan = { planId: "plan-500", planName: "Everyday", bytes: 500_000_000, legacyOrderId: null };
const monthly = { ...summary.offers[0], planName: plan.planName, interval: "month" as const, maxQuantity: 12 };
const yearly = { ...summary.offers[1], planName: plan.planName, interval: "year" as const, maxQuantity: 5 };
const prepaidSummary: BlossomPrepaidStorageSummary = {
  ...summary,
  checkoutVersion: 2,
  serverTime: SERVER_TIME,
  paidPlans: [],
  offers: [monthly, yearly],
};
const prepaidOrder: BlossomStorageOrder = {
  id: "prepaid-order",
  planId: plan.planId,
  planName: plan.planName,
  interval: "month",
  priceUsdCents: monthly.priceUsdCents,
  bytes: plan.bytes,
  quantity: 3,
  totalPriceUsdCents: 1500,
  durationSeconds: 90 * DAY,
  amountSats: 100,
  paymentHash: "c".repeat(64),
  invoice: "lnbc1000n1qqqq",
  invoiceExpiresAt: SERVER_TIME + 900,
  paidThrough: null,
};

const prepaidRoots: { root: ReturnType<typeof createRoot>; container: HTMLDivElement }[] = [];

afterEach(async () => {
  await act(async () => {
    for (const { root, container } of prepaidRoots.splice(0)) {
      root.unmount();
      container.remove();
    }
  });
  localStorage.clear();
  vi.useRealTimers();
});

async function renderPrepaid(overrides: Partial<BlossomPrepaidStorageSummary> = {}) {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval"] });
  // The browser clock differs from Blossom by more than one invoice lifetime.
  vi.setSystemTime((SERVER_TIME + 4 * DAY) * 1000);
  mocks.getSummary.mockResolvedValue({ ...prepaidSummary, ...overrides });
  mocks.listBlobs.mockResolvedValue({
    blobs: [{ ...blobs[0], protectedUntil: SERVER_TIME + 40 * DAY }, blobs[1]],
    nextCursor: null,
  });
  mocks.listOrders.mockResolvedValue([]);
  mocks.createOrder.mockResolvedValue(prepaidOrder);
  mocks.getOrder.mockResolvedValue(prepaidOrder);
  mocks.protectBlob.mockResolvedValue({ tier: "protected", protectedUntil: SERVER_TIME + 50 * DAY });
  return mountPrepaid();
}

async function mountPrepaid() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  prepaidRoots.push({ root, container });
  await act(async () => root.render(
    <StorageSection
      settings={{ managedBlossomServer: SERVER } as any}
      setSettings={vi.fn()}
      pubkeyHex={"d".repeat(64)}
      signerKey={"1".repeat(64)}
      tasks={[task]}
      initialServer={SERVER}
    />,
  ));
  return container;
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function click(container: ParentNode, label: string) {
  await act(async () => button(container, label).click());
}

async function chooseQuantity(container: ParentNode, quantity: number) {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Quantity"]');
  if (!select) throw new Error("Missing quantity picker");
  await act(async () => {
    select.value = String(quantity);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function hasTime(container: ParentNode, seconds: number): boolean {
  return container.querySelector(`time[datetime="${iso(seconds)}"]`) !== null;
}

test("reviews and buys three months, then uses current plan expiry after settlement", async () => {
  const container = await renderPrepaid();
  await click(container, "Choose time");
  await chooseQuantity(container, 3);
  expect(container.textContent).toContain("3 months (90 days)");
  expect(container.textContent).toContain("$15.00");
  expect(hasTime(container, SERVER_TIME + 90 * DAY)).toBe(true);
  expect(mocks.createOrder).not.toHaveBeenCalled();

  await click(container, "Create Lightning invoice");
  expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({
    requestId: expect.any(String),
    offer: expect.objectContaining({ planId: plan.planId, priceUsdCents: 500, interval: "month", bytes: plan.bytes }),
    quantity: 3,
  }));
  const invoice = container.querySelector('[aria-label="Checkout"]')!;
  expect(invoice.textContent).toContain("3 months (90 days)");
  expect(invoice.textContent).toContain("$15.00");
  expect(invoice.textContent).toContain("Copy BOLT11 invoice");

  mocks.getOrder.mockResolvedValue({ ...prepaidOrder, paidThrough: SERVER_TIME + 90 * DAY });
  mocks.getSummary.mockResolvedValue({
    ...prepaidSummary,
    paidPlans: [{ ...plan, paidThrough: SERVER_TIME + 120 * DAY }],
  });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));

  expect(invoice.textContent).toContain("Payment settled");
  expect(hasTime(invoice, SERVER_TIME + 120 * DAY)).toBe(true);
  expect(hasTime(invoice, SERVER_TIME + 90 * DAY)).toBe(false);
  expect(button(container, "Add time")).toBeDefined();
  expect(button(container, "Renew").disabled).toBe(false);
  await click(container, "Renew");
  expect(mocks.protectBlob).toHaveBeenCalledWith(expect.objectContaining({ sha256: MATCHED_HASH }));
});

test("adds one month on top of 15 days remaining and excludes independently expiring capacity", async () => {
  const container = await renderPrepaid({
    paidPlans: [
      { ...plan, paidThrough: SERVER_TIME + 15 * DAY },
      { ...plan, legacyOrderId: "legacy-stacked", paidThrough: SERVER_TIME + 70 * DAY },
    ],
  });
  expect(container.textContent).toContain("15 days left");
  expect(container.textContent).toContain("Earlier storage purchases");
  expect(hasTime(container, SERVER_TIME + 70 * DAY)).toBe(true);
  await click(container, "Add time");
  expect(hasTime(container, SERVER_TIME + 45 * DAY)).toBe(true);
  expect(container.textContent).toContain("1 month (30 days)");
  await click(container, "Create Lightning invoice");
  expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
});

test("restarts expired capacity from server time and requires an exact capacity match", async () => {
  const container = await renderPrepaid({
    paidPlans: [
      { ...plan, paidThrough: SERVER_TIME - DAY },
      { ...plan, bytes: 400_000_000, paidThrough: SERVER_TIME - 2 * DAY },
    ],
  });
  expect(container.textContent).toContain("Expired");
  expect(hasTime(container, SERVER_TIME - DAY)).toBe(true);
  expect([...container.querySelectorAll("button")].filter((item) => item.textContent === "Restart plan")).toHaveLength(1);
  await click(container, "Restart plan");
  expect(hasTime(container, SERVER_TIME + 30 * DAY)).toBe(true);
  await click(container, "Create Lightning invoice");
  expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({
    quantity: 1,
    offer: expect.objectContaining({ bytes: plan.bytes }),
  }));
});

test("changes the plan action when the server-based countdown runs out", async () => {
  const container = await renderPrepaid({ paidPlans: [{ ...plan, paidThrough: SERVER_TIME + 5 }] });
  expect(button(container, "Add time")).toBeDefined();
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  expect(button(container, "Restart plan")).toBeDefined();
  await click(container, "Restart plan");
  expect(hasTime(container, SERVER_TIME + 6 + 30 * DAY)).toBe(true);
});

test("switches between months and years for the same plan and applies each quantity limit", async () => {
  const container = await renderPrepaid();
  await click(container, "Choose time");
  await chooseQuantity(container, 12);
  await click(container, "Years");
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Quantity"]')!;
  expect(select.options).toHaveLength(5);
  expect(select.value).toBe("5");
  await chooseQuantity(container, 2);
  expect(container.textContent).toContain("2 years (730 days)");
  expect(container.textContent).toContain("$100.00");
  expect(hasTime(container, SERVER_TIME + 730 * DAY)).toBe(true);
  await click(container, "Months");
  expect(select.options).toHaveLength(12);
  expect(container.textContent).toContain("2 months (60 days)");
  await click(container, "Years");
  await click(container, "Create Lightning invoice");
  expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ offer: yearly, quantity: 2 }));
});

test("resumes the original invoice and terms when a different quantity conflicts", async () => {
  const container = await renderPrepaid();
  mocks.createOrder.mockRejectedValue(new BlossomStorageApiError(409, "checkout_conflict", "Invoice open", {
    openOrderId: prepaidOrder.id,
  }));
  mocks.getOrder.mockResolvedValue({ ...prepaidOrder, totalPriceUsdCents: 1275 });
  await click(container, "Choose time");
  await click(container, "Create Lightning invoice");
  expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
  expect(mocks.getOrder).toHaveBeenCalledWith(expect.objectContaining({ id: prepaidOrder.id }));
  const invoice = container.querySelector('[aria-label="Checkout"]')!;
  expect(invoice.textContent).toContain("3 months (90 days)");
  expect(invoice.textContent).toContain("$12.75");
  expect(invoice.textContent).not.toContain("$5.00");
  expect(invoice.textContent).toContain("Copy BOLT11 invoice");
});

test("reuses persisted request IDs for identical retries and refreshes changed offers", async () => {
  const container = await renderPrepaid();
  const retryable = new BlossomStorageApiError(503, "billing_unavailable", "Lightning checkout unavailable");
  mocks.createOrder.mockRejectedValue(retryable);
  await click(container, "Choose time");
  await click(container, "Create Lightning invoice");
  await chooseQuantity(container, 2);
  await click(container, "Create Lightning invoice");
  const firstView = prepaidRoots.pop()!;
  await act(async () => firstView.root.unmount());
  firstView.container.remove();
  const reopened = await mountPrepaid();
  await click(reopened, "Choose time");
  await click(reopened, "Create Lightning invoice");
  const [firstAttempt, differentQuantity, retry] = mocks.createOrder.mock.calls.map(([order]) => order.requestId);
  expect(firstAttempt).not.toBe(differentQuantity);
  expect(firstAttempt).toBe(retry);

  mocks.createOrder.mockRejectedValue(new BlossomStorageApiError(409, "checkout_conflict", "This offer changed"));
  mocks.getSummary.mockResolvedValue({ ...prepaidSummary, offers: [{ ...monthly, priceUsdCents: 600 }] });
  await click(reopened, "Create Lightning invoice");
  expect(mocks.getSummary).toHaveBeenCalledTimes(3);
  expect(reopened.textContent).toContain("$6.00");
  expect(reopened.textContent).not.toContain("Copy BOLT11 invoice");
});
