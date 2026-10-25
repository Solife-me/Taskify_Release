import { commandSource } from "./helpers/commandSource.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLI_SOURCE = commandSource();
const RENDER_SOURCE = readFileSync(path.resolve(import.meta.dirname, "../src/render.ts"), "utf8");

test("task and event show include collaboration response state fields", () => {
  assert.match(RENDER_SOURCE, /Assignment states:/);
  assert.match(CLI_SOURCE, /rsvp status:/);
});
