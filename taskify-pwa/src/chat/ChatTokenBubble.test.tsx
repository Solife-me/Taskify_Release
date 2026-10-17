// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { ChatTokenBubble } from "./ChatTokenBubble";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("a received Cashu token is copy-only and copies the complete token", async () => {
  const onCopy = vi.fn();
  const token = `cashuA${"x".repeat(80)}`;
  const container = document.createElement("div");
  const root = createRoot(container);

  await act(async () => root.render(<ChatTokenBubble token={`  ${token}  `} onCopy={onCopy} />));
  try {
    expect(container.textContent).toContain("Cashu token");
    expect(container.textContent).toContain("Paste it into a Cashu wallet to receive it.");
    expect(container.textContent).not.toMatch(/redeem|claim/i);

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Copy token");
    await act(async () => button?.click());
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledWith(token);
  } finally {
    await act(async () => root.unmount());
  }
});
