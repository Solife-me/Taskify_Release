// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";
import { parseHermesModelListing } from "taskify-core";
import { HermesModelPicker } from "./HermesModelPicker";
import { saveHermesCatalogCache, type HermesMenuProjection } from "./hermesModelPickerState";

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

beforeEach(() => window.localStorage.clear());

test("a fresh cached catalog opens without sending a request and a model button sends the exact command", async () => {
  const menu = projection();
  saveHermesCatalogCache(PEER, LISTING_ID, {
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
  expect(container.textContent).toContain("gemma4:26b-mlx");

  await act(async () => buttonWithText(container, "gemma4:26b-mlx").click());

  expect(sendBotUiCommand).toHaveBeenCalledWith(
    PEER,
    "/model gemma4:26b-mlx --provider custom:local",
    {
      kind: "model-select",
      menuId: LISTING_ID,
      providerSlug: "custom:local",
      modelId: "gemma4:26b-mlx",
    },
  );

  await act(async () => root.unmount());
});

test("opening an uncached provider requests only that provider's complete catalog", async () => {
  const sendBotUiCommand = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement("div");
  const root = createRoot(container);

  await act(async () => root.render(
    <HermesModelPicker peerPubkey={PEER} projection={projection()} sendBotUiCommand={sendBotUiCommand} />,
  ));
  await act(async () => buttonWithText(container, "Nous Portal").click());

  expect(sendBotUiCommand).toHaveBeenCalledTimes(1);
  const [peer, prompt, action] = sendBotUiCommand.mock.calls[0];
  expect(peer).toBe(PEER);
  expect(prompt).toContain('provider slug `nous`');
  expect(prompt).toContain('{"provider":"nous","models":["model-id"]}');
  expect(action).toEqual({ kind: "catalog-request", menuId: LISTING_ID, providerSlug: "nous" });
  expect(container.textContent).toContain("Loading Nous Portal models…");

  await act(async () => root.unmount());
});
