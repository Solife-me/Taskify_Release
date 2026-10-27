// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Task } from "../../domains/tasks/taskTypes";
import { TaskBountyToken } from "./TaskBountyToken";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toast = vi.fn();
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ show: toast }) }));
vi.mock("../../identity/identity", () => ({ currentPubkey: () => "a".repeat(64) }));

const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  toast.mockReset();
});

async function render(bounty: Task["bounty"], onReveal?: (id: string) => Promise<void>) {
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  const task = { id: "t1", title: "Fix the gate", bounty } as Task;
  await act(async () => root.render(<TaskBountyToken task={task} onReveal={onReveal} />));
  return host;
}

const base = { id: "b1", token: "", amount: 21, state: "unlocked" as const, updatedAt: "2026-10-18T12:00:00.000Z" };

test("an unlocked bounty shows its token and copies it, with no wallet", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  const host = await render({ ...base, token: "cashuBexampletoken" });
  expect(host.textContent).toContain("21 sats");
  expect(host.querySelector('[data-testid="bounty-token"]')?.textContent).toBe("cashuBexampletoken");
  const copy = [...host.querySelectorAll("button")].find((button) => button.textContent === "Copy token")!;
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith("cashuBexampletoken");
  expect(toast).toHaveBeenCalledWith("Bounty token copied", 1800);
});

test("a bounty locked to this user can be revealed", async () => {
  const onReveal = vi.fn().mockResolvedValue(undefined);
  const host = await render(
    { ...base, state: "locked", receiver: "a".repeat(64), enc: { alg: "nip04", data: "x" } },
    onReveal,
  );
  const reveal = [...host.querySelectorAll("button")].find((button) => button.textContent === "Reveal token")!;
  await act(async () => reveal.click());
  expect(onReveal).toHaveBeenCalledWith("t1");
});

test("a bounty locked to someone else, or already redeemed, offers nothing to do", async () => {
  const otherHost = await render({ ...base, state: "locked", receiver: "b".repeat(64), enc: { alg: "nip04", data: "x" } }, vi.fn());
  expect(otherHost.querySelectorAll("button")).toHaveLength(0);
  const claimedHost = await render({ ...base, state: "claimed" });
  expect(claimedHost.textContent).toContain("Redeemed");
  expect(claimedHost.querySelectorAll("button")).toHaveLength(0);
});
