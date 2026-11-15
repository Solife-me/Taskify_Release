// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { parseHermesModelListing, parseHermesSessionListing } from "taskify-core";
import { HermesModelPicker } from "./HermesModelPicker";
import { HermesSessionPicker } from "./HermesSessionPicker";
import type { HermesMenuProjection } from "./hermesModelPickerState";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const LISTING_TEXT = `Current: \`deepseek-v4.1-flash:cloud\` on custom:local

**local** \`--provider custom:local\` (current):
  \`lfm3-audio:latest\`, \`deepseek-v4.1-flash:cloud\` (+11 more)

**Nous Portal** \`--provider nous\`:
  \`anthropic/claude-opus-5.5\`, \`anthropic/claude-sonnet-5.5\` (+67 more)`;
const LISTING_ID = "c".repeat(64);
const PEER = "b".repeat(64);

function projection(): HermesMenuProjection {
  const listing = parseHermesModelListing(LISTING_TEXT);
  if (!listing) throw new Error("fixture did not parse");
  return {
    listingEventId: LISTING_ID,
    menuId: LISTING_ID,
    listing,
    catalogs: new Map(),
    selectedModel: null,
    pendingAction: null,
    failure: null,
  };
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return button;
}

test("an old catalog in the transcript does not add choices to the stock reply and a listed model sends the exact command", async () => {
  const menu = projection();
  menu.catalogs.set("custom:local", {
    providerName: "local",
    providerSlug: "custom:local",
    models: ["lfm3-audio:latest", "deepseek-v4.1-flash:cloud", "gemma4:26b-mlx"],
  });
  const sendBotUiCommand = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement("div");
  const root = createRoot(container);

  await act(async () => root.render(
    <HermesModelPicker peerPubkey={PEER} projection={menu} sendBotUiCommand={sendBotUiCommand} />,
  ));
  await act(async () => buttonWithText(container, "local").click());

  expect(sendBotUiCommand).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("gemma4:26b-mlx");

  await act(async () => buttonWithText(container, "lfm3-audio:latest").click());

  expect(sendBotUiCommand).toHaveBeenCalledWith(
    PEER,
    "/model lfm3-audio:latest --provider custom:local",
    {
      kind: "model-select",
      menuId: LISTING_ID,
      providerSlug: "custom:local",
      modelId: "lfm3-audio:latest",
    },
  );

  await act(async () => root.unmount());
});

test("a stock provider preview opens locally and shows the partial list", async () => {
  const sendBotUiCommand = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement("div");
  const root = createRoot(container);

  await act(async () => root.render(
    <HermesModelPicker peerPubkey={PEER} projection={projection()} sendBotUiCommand={sendBotUiCommand} />,
  ));
  await act(async () => buttonWithText(container, "Nous Portal").click());

  expect(sendBotUiCommand).not.toHaveBeenCalled();
  expect(container.textContent).toContain("anthropic/claude-opus-5.5");
  expect(container.textContent).toContain("Hermes listed 2 of 69 models.");
  expect(container.textContent).not.toContain("Loading");

  await act(async () => root.unmount());
});

test("a model switch can be retried if Hermes does not confirm it", async () => {
  vi.useFakeTimers();
  const menu = projection();
  const sendBotUiCommand = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <HermesModelPicker peerPubkey={PEER} projection={menu} sendBotUiCommand={sendBotUiCommand} />,
    ));
    await act(async () => buttonWithText(container, "Nous Portal").click());
    const model = buttonWithText(container, "anthropic/claude-opus-5.5");
    await act(async () => model.click());
    expect(model.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(model.disabled).toBe(false);
    expect(container.textContent).toContain("Hermes hasn’t confirmed the switch.");
    await act(async () => model.click());
    expect(sendBotUiCommand).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

test("a named-session button sends the exact resume command", async () => {
  const listing = parseHermesSessionListing(`📋 **Named Sessions**

1. **Give MCP access to Nextcloud server** (current) — \`20261109_020143_82e5b835\` — _nextcloud_
2. **Write comprehensive audit plan paper** — \`20261109_013330_790ece03\` — _audit_`);
  if (!listing) throw new Error("session fixture did not parse");
  const sendDirectTextMessage = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement("div");
  const root = createRoot(container);

  await act(async () => root.render(
    <HermesSessionPicker
      peerPubkey={PEER}
      listing={listing}
      sendDirectTextMessage={sendDirectTextMessage}
    />,
  ));
  expect(container.textContent).toContain("Current");
  expect(container.querySelectorAll("button")).toHaveLength(2);

  await act(async () => buttonWithText(container, "Write comprehensive audit plan paper").click());

  expect(sendDirectTextMessage).toHaveBeenCalledWith(PEER, "/resume 20261109_013330_790ece03");
  expect(container.textContent).toContain("Sent ✓");

  await act(async () => root.unmount());
});
