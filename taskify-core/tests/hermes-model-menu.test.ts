import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HERMES_MODEL_PAGE_SIZE,
  HERMES_PROVIDER_PAGE_SIZE,
  buildTaskifyBotUiActionTag,
  isValidHermesModelId,
  isValidHermesProviderSlug,
  parseTaskifyBotUiAction,
  parseHermesModelListing,
  parseHermesModelSwitchConfirmation,
  parseHermesProviderCatalog,
  type HermesModelListing,
  type HermesProviderCatalog,
  type HermesModelSwitchConfirmation,
} from "../dist/index.js";

type VectorFile = {
  modelListings: Array<{ name: string; text: string; expected: HermesModelListing }>;
  providerCatalogs: Array<{
    name: string;
    text: string;
    expectedProviderSlug: string;
    expected: HermesProviderCatalog;
  }>;
  confirmations: Array<{ name: string; text: string; expected: HermesModelSwitchConfirmation }>;
  invalidModelListings: string[];
  invalidProviderCatalogs: string[];
};

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/hermes-bot-menu-vectors.json", import.meta.url), "utf8"),
) as VectorFile;

for (const vector of fixture.modelListings) {
  test(`Hermes model listing: ${vector.name}`, () => {
    assert.deepEqual(parseHermesModelListing(vector.text), vector.expected);
  });
}

for (const vector of fixture.providerCatalogs) {
  test(`Hermes provider catalog: ${vector.name}`, () => {
    assert.deepEqual(parseHermesProviderCatalog(vector.text, vector.expectedProviderSlug), vector.expected);
  });
}

for (const vector of fixture.confirmations) {
  test(`Hermes model confirmation: ${vector.name}`, () => {
    assert.deepEqual(parseHermesModelSwitchConfirmation(vector.text), vector.expected);
  });
}

test("Hermes parsers reject unrecognized or mismatched shapes", () => {
  for (const text of fixture.invalidModelListings) assert.equal(parseHermesModelListing(text), null);
  for (const text of fixture.invalidProviderCatalogs) assert.equal(parseHermesProviderCatalog(text, "custom:local"), null);
  assert.equal(parseHermesModelSwitchConfirmation("Model not changed."), null);
});

test("Hermes menu identifiers are strict and page sizes match the adapter contract", () => {
  assert.equal(HERMES_PROVIDER_PAGE_SIZE, 10);
  assert.equal(HERMES_MODEL_PAGE_SIZE, 8);
  assert.equal(isValidHermesProviderSlug("custom:local"), true);
  assert.equal(isValidHermesProviderSlug("bad provider"), false);
  assert.equal(isValidHermesModelId("openai/gpt-6-astra"), true);
  assert.equal(isValidHermesModelId("model with spaces"), false);
});


test("Taskify bot UI action tags round-trip and reject malformed values", () => {
  const catalog = { kind: "catalog-request" as const, menuId: "menu-1", providerSlug: "custom:local" };
  const model = { kind: "model-select" as const, menuId: "menu-1", providerSlug: "custom:local", modelId: "deepseek-v4.1-flash:cloud" };
  assert.deepEqual(parseTaskifyBotUiAction([buildTaskifyBotUiActionTag(catalog)]), catalog);
  assert.deepEqual(parseTaskifyBotUiAction([buildTaskifyBotUiActionTag(model)]), model);
  assert.equal(parseTaskifyBotUiAction([["taskify-bot-ui", "v1", "model-select", "bad menu", "nous", "model"]]), null);
  assert.equal(parseTaskifyBotUiAction([["taskify-bot-ui", "v2", "catalog-request", "menu", "nous"]]), null);
});
