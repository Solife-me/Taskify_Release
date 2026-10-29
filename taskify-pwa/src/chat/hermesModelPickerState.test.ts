// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import type { TaskifyBotUiAction } from "taskify-core";
import type { WalletDmMessage } from "./hooks/useDmState";
import {
  HERMES_CATALOG_CACHE_TTL_MS,
  buildHermesModelSwitchCommand,
  buildHermesProviderCatalogPrompt,
  isHermesCatalogCacheFresh,
  loadHermesCatalogCache,
  pageSlice,
  projectHermesBotUi,
  saveHermesCatalogCache,
} from "./hermesModelPickerState";

const LISTING = `Current: \`deepseek-v4.1-flash:cloud\` on custom:local

**local** \`--provider custom:local\` (current):
  \`lfm3-audio:latest\`, \`lfm3-omni:latest\`, \`phonon:40m-multilingual\`, \`phonon:latest\`, \`bonsai-2:27b\` (+8 more)

**Nous Portal** \`--provider nous\`:
  \`anthropic/claude-fable-5.1\`, \`anthropic/claude-fable-5\`, \`anthropic/claude-opus-5.5\`, \`anthropic/claude-opus-5\`, \`anthropic/claude-opus-4.8\` (+64 more)`;

const CATALOG = '{"provider":"custom:local","models":["lfm3-audio:latest","deepseek-v4.1-flash:cloud"]}';
const CONFIRMATION = "Model switched to `deepseek-v4.1-flash:cloud`\nProvider: local\nContext: 1,048,576 tokens\n_(session only — add --global to persist)_";

const menuId = "a".repeat(64);
let sequence = 0;

function message(overrides: Partial<WalletDmMessage>): WalletDmMessage {
  sequence += 1;
  return {
    id: `message-${sequence}`,
    eventId: sequence.toString(16).padStart(64, "0"),
    peerPubkey: "b".repeat(64),
    isIncoming: true,
    createdAt: sequence,
    content: "",
    preview: "",
    attachment: { type: "text" },
    ...overrides,
  };
}

function hiddenCommand(action: TaskifyBotUiAction, content: string): WalletDmMessage {
  return message({ isIncoming: false, content, preview: content, botUiAction: action });
}

describe("Hermes model picker projection", () => {
  test("reconstructs a provider catalog and hides its internal request and JSON response", () => {
    const listing = message({ eventId: menuId, content: LISTING, preview: LISTING });
    const action = { kind: "catalog-request" as const, menuId, providerSlug: "custom:local" };
    const request = hiddenCommand(action, buildHermesProviderCatalogPrompt("custom:local"));
    const response = message({ content: CATALOG, preview: CATALOG });

    const projection = projectHermesBotUi([listing, request, response]);
    const menu = projection.menusByListingEventId.get(listing.eventId);

    expect(projection.hiddenEventIds.has(request.eventId)).toBe(true);
    expect(projection.hiddenEventIds.has(response.eventId)).toBe(true);
    expect(menu?.catalogs.get("custom:local")?.models).toEqual(["lfm3-audio:latest", "deepseek-v4.1-flash:cloud"]);
    expect(menu?.pendingAction).toBeNull();
  });

  test("reconstructs a completed model switch from encrypted history", () => {
    const listing = message({ eventId: menuId, content: LISTING, preview: LISTING });
    const action = {
      kind: "model-select" as const,
      menuId,
      providerSlug: "custom:local",
      modelId: "deepseek-v4.1-flash:cloud",
    };
    const request = hiddenCommand(action, buildHermesModelSwitchCommand(action.providerSlug, action.modelId));
    const response = message({ content: CONFIRMATION, preview: CONFIRMATION });

    const projection = projectHermesBotUi([listing, request, response]);
    const menu = projection.menusByListingEventId.get(listing.eventId);

    expect(projection.hiddenEventIds.has(response.eventId)).toBe(true);
    expect(menu?.selectedModel).toMatchObject({
      modelId: action.modelId,
      providerSlug: "custom:local",
      providerName: "local",
    });
  });

  test("keeps an unrecognized response visible and exposes an inline failure", () => {
    const listing = message({ eventId: menuId, content: LISTING, preview: LISTING });
    const action = { kind: "catalog-request" as const, menuId, providerSlug: "nous" };
    const request = hiddenCommand(action, buildHermesProviderCatalogPrompt("nous"));
    const response = message({ content: "I could not list those models.", preview: "I could not list those models." });

    const projection = projectHermesBotUi([listing, request, response]);
    const menu = projection.menusByListingEventId.get(listing.eventId);

    expect(projection.hiddenEventIds.has(request.eventId)).toBe(true);
    expect(projection.hiddenEventIds.has(response.eventId)).toBe(false);
    expect(menu?.failure?.responseEventId).toBe(response.eventId);
  });

  test("does nothing outside an explicitly verified bot conversation", () => {
    const listing = message({ content: LISTING, preview: LISTING });
    const projection = projectHermesBotUi([listing], false);
    expect(projection.menusByListingEventId.size).toBe(0);
  });
});

describe("Hermes model picker helpers", () => {
  beforeEach(() => window.localStorage.clear());

  test("builds the tested one-provider catalog prompt and exact switch command", () => {
    expect(buildHermesProviderCatalogPrompt("custom:local")).toContain('provider slug `custom:local`');
    expect(buildHermesProviderCatalogPrompt("custom:local")).toContain('{"provider":"custom:local","models":["model-id"]}');
    expect(buildHermesModelSwitchCommand("custom:local", "deepseek-v4.1-flash:cloud"))
      .toBe("/model deepseek-v4.1-flash:cloud --provider custom:local");
  });

  test("scopes cached catalogs to the menu listing and expires them after ten minutes", () => {
    const catalog = {
      providerName: "local",
      providerSlug: "custom:local",
      models: ["lfm3-audio:latest", "deepseek-v4.1-flash:cloud"],
    };
    const saved = saveHermesCatalogCache("bot", "listing-1", catalog, 1_000);
    expect(loadHermesCatalogCache("bot", "listing-1", "custom:local")).toEqual(saved);
    expect(loadHermesCatalogCache("bot", "listing-2", "custom:local")).toEqual(saved);
    expect(isHermesCatalogCacheFresh(saved, 1_001, "listing-2")).toBe(false);
    expect(isHermesCatalogCacheFresh(saved, 1_000 + HERMES_CATALOG_CACHE_TTL_MS - 1)).toBe(true);
    expect(isHermesCatalogCacheFresh(saved, 1_000 + HERMES_CATALOG_CACHE_TTL_MS)).toBe(false);
  });

  test("paginates models at eight per page", () => {
    expect(pageSlice(Array.from({ length: 13 }, (_, index) => index), 1, 8)).toEqual([8, 9, 10, 11, 12]);
  });
});
