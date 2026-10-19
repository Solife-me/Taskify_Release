// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { SupportSection } from "./SupportSection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("support works without the Taskify wallet: a lightning link and a copy button", async () => {
  const writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<SupportSection />));
  try {
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("lightning:dev@solife.me");
    expect(container.querySelector("button[disabled]")).toBeNull();
    expect(container.textContent).not.toMatch(/internal wallet/i);
    await act(async () => { container.querySelector("button")!.click(); });
    expect(writeText).toHaveBeenCalledWith("dev@solife.me");
  } finally {
    await act(async () => root.unmount());
  }
});
