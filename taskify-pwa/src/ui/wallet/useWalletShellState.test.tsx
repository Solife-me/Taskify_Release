// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useWalletShellState } from "./useWalletShellState";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function render(activePage: string) {
  const loadWalletModal = vi.fn(async () => ({}));
  let state: ReturnType<typeof useWalletShellState>;
  function Harness() {
    state = useWalletShellState({ activePage, loadWalletModal, showToast: vi.fn() });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return { loadWalletModal, root, state: () => state! };
}

test("Chat is not a wallet shell and never prefetches the wallet", async () => {
  vi.useFakeTimers();
  const view = await render("chat");
  try {
    expect(view.state().showWalletShell).toBe(false);
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(view.loadWalletModal).not.toHaveBeenCalled();
  } finally {
    await act(async () => view.root.unmount());
    vi.useRealTimers();
  }
});

test("the wallet modal loads only through an explicit prefetch", async () => {
  vi.useFakeTimers();
  const view = await render("boards");
  try {
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(view.loadWalletModal).not.toHaveBeenCalled();
    await act(async () => view.state().prefetchWalletModal());
    expect(view.loadWalletModal).toHaveBeenCalledOnce();
  } finally {
    await act(async () => view.root.unmount());
    vi.useRealTimers();
  }
});
