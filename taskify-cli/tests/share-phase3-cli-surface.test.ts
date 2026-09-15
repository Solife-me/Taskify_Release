import { commandSource } from "./helpers/commandSource.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI_SOURCE = commandSource();
const RENDER_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/render.ts"), "utf8");

test("event rsvp uses canonical event-rsvp-response envelope", () => {
  assert.match(CLI_SOURCE, /buildEventRsvpResponseEnvelope\(/);
  assert.doesNotMatch(CLI_SOURCE, /taskId:\s*`event:\$\{eventId\}`/);
});

test("share inbox apply tracks processed rumor ids for idempotency", () => {
  assert.match(CLI_SOURCE, /processedInboxRumorIds/);
  assert.match(CLI_SOURCE, /if \(processed\.has\(item\.rumorId\)\) continue/);
});

test("task and event show include collaboration response state fields", () => {
  assert.match(RENDER_SOURCE, /Assignment states:/);
  assert.match(CLI_SOURCE, /rsvp status:/);
});
