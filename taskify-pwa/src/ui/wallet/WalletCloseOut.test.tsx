// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

const stuck = { id: "t1", mint: "https://gone.example", token: "cashuBstuck", addedAt: 1, attempts: 9, amount: 50 };
let saved = [stuck];
let blockers = ["1 saved ecash token is waiting to be redeemed or moved"];

vi.mock("../../wallet/walletAvailability", () => ({
  checkWalletCloseOut: () => ({ blockers: [...blockers], unclaimedSentSat: 0 }),
  closeOutWallet: vi.fn(),
}));
vi.mock("../../wallet/storage", () => ({ listPendingTokens: () => saved }));
const removeSavedTokenKeepingCopy = vi.fn(() => {
  saved = [];
  blockers = [];
});
vi.mock("../../wallet/savedTokenCheckLive", () => ({
  // The mint is gone, so the check cannot say whether the token was claimed.
  settleSavedTokensNow: async () => saved.map((entry) => ({ entry, status: "unknown" })),
  removeSavedTokenKeepingCopy: (...args: unknown[]) => removeSavedTokenKeepingCopy(...(args as [])),
}));
vi.mock("../settings/WalletSection", () => ({ WalletSection: () => null }));

import { WalletCloseOutSection } from "./WalletSettingsSheet";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

test("a saved token that can't be redeemed can be removed, and then the wallet can be closed out", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<WalletCloseOutSection onClosed={() => {}} />));
  try {
    expect(button("Close out wallet")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("couldn't confirm whether it was claimed");
    await act(async () => button("Remove")!.click());
    expect(document.body.textContent).toContain("A copy stays in History");
    await act(async () => button("Remove token")!.click());
    expect(removeSavedTokenKeepingCopy).toHaveBeenCalledWith(stuck);
    expect(button("Close out wallet")!.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
