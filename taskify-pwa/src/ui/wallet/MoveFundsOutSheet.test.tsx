// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { MoveFundsOutSheet } from "./MoveFundsOutSheet";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function render(overrides: Partial<Parameters<typeof MoveFundsOutSheet>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    removalDateLabel: "December 1, 2026",
    mints: [
      { mintUrl: "https://mint.a.example", sat: 2100 },
      { mintUrl: "https://mint.b.example", sat: 0 },
    ],
    formatSatAmount: (n: number) => `${n} sats`,
    busyMint: null,
    error: "",
    onSendLightning: vi.fn(),
    onExportMint: vi.fn(),
    nwcAvailable: false,
    onSendNwc: vi.fn(),
    npubCashAvailable: true,
    onClaimNpubCash: vi.fn(),
    revealSeed: vi.fn(() => "abandon ability able"),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    props,
    mount: () => act(async () => root.render(<MoveFundsOutSheet {...props} />)),
    unmount: () => act(async () => root.unmount()),
    button: (label: string) =>
      [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined,
  };
}

test("every way out is offered, with the date and the total", async () => {
  const view = render();
  await view.mount();
  try {
    expect(document.body.textContent).toContain("closes on December 1, 2026");
    expect(document.body.textContent).toContain("2100 sats to move");
    await act(async () => view.button("Send with Lightning")!.click());
    expect(view.props.onSendLightning).toHaveBeenCalled();
    // One token per funded mint; an empty mint offers none.
    expect([...document.querySelectorAll("button")].filter((b) => b.textContent === "Make token")).toHaveLength(1);
    await act(async () => view.button("Make token")!.click());
    expect(view.props.onExportMint).toHaveBeenCalledWith("https://mint.a.example");
    await act(async () => view.button("Claim funds waiting at npub.cash")!.click());
    expect(view.props.onClaimNpubCash).toHaveBeenCalled();
    expect(view.button("Send to your connected wallet (NWC)")).toBeUndefined();
    // The 12 words only on request, with the mints to restore from.
    expect(document.body.textContent).not.toContain("abandon ability able");
    await act(async () => view.button("Show my 12 words")!.click());
    expect(document.body.textContent).toContain("abandon ability able");
    expect(document.body.textContent).toContain("https://mint.b.example");
  } finally {
    await view.unmount();
  }
});

test("an empty wallet has nothing to send", async () => {
  const view = render({ mints: [] });
  await view.mount();
  try {
    expect(document.body.textContent).toContain("Nothing left to move.");
    expect(view.button("Send with Lightning")!.disabled).toBe(true);
  } finally {
    await view.unmount();
  }
});
