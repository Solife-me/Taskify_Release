import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { sanitizeRemote, stripControlCharacters } from "../src/shared/displaySafe.ts";
import { verifiedRawEvents } from "../src/shared/verifiedEvents.ts";

test("terminal control sequences are removed from other people's text", () => {
  assert.equal(stripControlCharacters("Buy milk\u001b[2K\r\u001b[32m✓ trusted"), "Buy milk[2K[32m✓ trusted");
  assert.equal(stripControlCharacters("clip\u001b]52;c;ZXZpbA==\u0007"), "clip]52;c;ZXZpbA==");
  assert.equal(stripControlCharacters("abc‮dcba"), "abcdcba");
  assert.equal(stripControlCharacters("line one\nline\ttwo"), "line one\nline\ttwo");
});

test("records are cleaned at every depth", () => {
  const cleaned = sanitizeRemote({
    title: "x\u001b[8m",
    subtasks: [{ title: "y\u009b" }],
    count: 3,
    done: false,
  });
  assert.deepEqual(cleaned, { title: "x[8m", subtasks: [{ title: "y" }], count: 3, done: false });
});

test("only events with valid signatures are kept", () => {
  const signed = finalizeEvent({ kind: 0, created_at: 1, tags: [], content: "{}" }, generateSecretKey());
  const forged = { ...signed, content: '{"lud16":"attacker@example.com"}' };
  const asNdk = (event: object) => ({ rawEvent: () => event }) as any;
  assert.deepEqual(verifiedRawEvents([asNdk(signed), asNdk(forged)]).map((e) => e.content), ["{}"]);
});
