// @vitest-environment jsdom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useDmThreadUtils, type UseDmThreadUtilsOptions } from "./useDmThreadUtils";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderTray() {
  const blur = vi.fn();
  const input = document.createElement("input");
  input.blur = blur;
  const chatComposeInputRef = { current: input };
  let toggle: () => void;
  let close: () => void;
  function Harness() {
    const [attachTrayOpen, setAttachTrayOpen] = useState(false);
    // This harness exercises only the tray callbacks; other thread services are never called.
    const options = {
      attachTrayOpen, setAttachTrayOpen, chatComposeInputRef,
      profileForm: { displayName: "", username: "" },
      setShareContactPickerOpen: vi.fn(), setShareContactPickerMode: vi.fn(),
      setShareContactSource: vi.fn(), setShareContactStatus: vi.fn(),
    } as unknown as UseDmThreadUtilsOptions;
    const utils = useDmThreadUtils(options);
    toggle = utils.handleToggleAttachTray;
    close = utils.closeAttachTray;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
  return { root, blur, toggle: () => toggle(), close: () => close() };
}

test("opening the attachment tray blurs once under StrictMode", async () => {
  vi.useFakeTimers();
  const view = await renderTray();
  try {
    await act(async () => view.toggle());
    await act(async () => vi.runAllTimers());
    expect(view.blur).toHaveBeenCalledOnce();
  } finally {
    await act(async () => view.root.unmount());
    vi.useRealTimers();
  }
});

test.each(["close", "unmount"] as const)("%s cancels a pending tray blur", async (action) => {
  vi.useFakeTimers();
  const view = await renderTray();
  let unmounted = false;
  try {
    await act(async () => view.toggle());
    if (action === "close") {
      await act(async () => view.close());
    } else {
      await act(async () => view.root.unmount());
      unmounted = true;
    }
    await act(async () => vi.runAllTimers());
    expect(view.blur).not.toHaveBeenCalled();
  } finally {
    if (!unmounted) await act(async () => view.root.unmount());
    vi.useRealTimers();
  }
});
