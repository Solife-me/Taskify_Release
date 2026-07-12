import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBoardShareEnvelope,
  parseShareEnvelope,
  buildTaskAssignmentResponseEnvelope,
  normalizeTaskPriority,
  normalizeTaskAssignees,
  normalizeTaskRecurrence,
} from "../dist/shareContracts.js";

test("buildBoardShareEnvelope + parseShareEnvelope round-trip", () => {
  const envelope = buildBoardShareEnvelope("board-1", "Board", ["wss://relay"]);
  const parsed = parseShareEnvelope(JSON.stringify(envelope));
  assert.equal(parsed?.item.type, "board");
  assert.equal((parsed?.item as any).boardId, "board-1");
});

test("normalizeTaskRecurrence rejects non-progressing intervals", () => {
  assert.equal(normalizeTaskRecurrence({ type: "every", n: 0, unit: "day" }), undefined);
  assert.equal(normalizeTaskRecurrence({ type: "every", n: -1, unit: "week" }), undefined);
  assert.deepEqual(normalizeTaskRecurrence({ type: "every", n: 2, unit: "day" }), {
    type: "every",
    n: 2,
    unit: "day",
  });
});

test("parseShareEnvelope returns null for invalid payload", () => {
  assert.equal(parseShareEnvelope("{}"), null);
});

test("buildTaskAssignmentResponseEnvelope normalizes maybe => tentative", () => {
  const envelope = buildTaskAssignmentResponseEnvelope({ taskId: "t1", status: "tentative" });
  assert.equal(envelope.item.type, "task-assignment-response");
});

test("normalizeTaskPriority supports bang shorthand", () => {
  assert.equal(normalizeTaskPriority("!!!"), 3);
  assert.equal(normalizeTaskPriority("!"), 1);
  assert.equal(normalizeTaskPriority("0"), undefined);
});

test("normalizeTaskAssignees trims, dedupes, and maps maybe => tentative", () => {
  const assignees = normalizeTaskAssignees([
    { pubkey: " 02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ", relay: " wss://relay.one ", status: "maybe" },
    { pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "accepted" },
  ]);
  assert.equal(assignees?.length, 1);
  assert.deepEqual(assignees?.[0], {
    pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    relay: "wss://relay.one",
    status: "tentative",
  });
});
