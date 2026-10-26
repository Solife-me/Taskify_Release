import test from "node:test";
import assert from "node:assert/strict";
import { nip19 } from "nostr-tools";
import { runCli } from "../dist/cli.js";
import { captureConsole, harnessDependencies, recordingRuntime } from "./helpers/cliHarness.ts";

/**
 * C12-2 stage 7: the rich task and event flags reach the runtime parsed, and `show` presents
 * attachments, assignment states, invitees and RSVP state.
 */

const hex = "ab".repeat(32);
const npub = nip19.npubEncode(hex);
const task = { id: "task-1", boardId: "board-1", title: "Write spec", completed: false, column: "todo" };
const event = { id: "event-1", boardId: "board-1", boardName: "Harness Board 7f06", title: "Launch", kind: "date", startDate: "2026-11-01", eventKey: "k" };

function run(argv: string[], handlers: Record<string, (...args: unknown[]) => unknown>) {
  const { runtime, calls } = recordingRuntime(handlers);
  const { dependencies } = harnessDependencies(runtime, { randomUUID: () => "uuid-x" });
  return captureConsole(() => runCli(["node", "taskify", ...argv], dependencies)).then((result) => ({ ...result, calls }));
}

test("task add and update pass recurrence, documents and assignees parsed", async () => {
  const added = await run([
    "add", "Write spec", "--in", "Harness Board 7f06/Todo",
    "--recurrence-json", '{"type":"daily"}',
    "--documents-json", '[{"name":"Spec.pdf","url":"https://files.example/spec","kind":"pdf"}]',
    "--assignee", npub,
  ], { createTaskFull: async (input) => ({ ...task, ...(input as object) }) });
  assert.equal(added.status, 0);
  const input = added.calls[0][1] as Record<string, unknown>;
  assert.deepEqual(input.recurrence, { type: "daily" });
  assert.deepEqual(input.documents, [{ name: "Spec.pdf", url: "https://files.example/spec", kind: "pdf" }]);
  assert.deepEqual(input.assignees, [{ pubkey: hex }]);

  const updated = await run([
    "update", "task-1", "--board", "board-1",
    "--recurrence-json", '{"type":"weekly","days":[1]}', "--assignee", npub, "--documents-json", "[]",
  ], {
    getTask: async () => task,
    updateTask: async (_id, _board, patch) => ({ ...task, ...(patch as object) }),
  });
  assert.equal(updated.status, 0);
  assert.deepEqual(updated.calls[1], ["updateTask", "task-1", "board-1", {
    recurrence: { type: "weekly", days: [1] }, documents: null, assignees: [{ pubkey: hex }],
  }]);

  const badJson = await run(["add", "X", "--in", "Harness Board 7f06/Todo", "--recurrence-json", "{nope"], {
    createTaskFull: async () => task,
  });
  assert.notEqual(badJson.status, 0);
  assert.ok(!badJson.calls.some((call) => call[0] === "createTaskFull"));
});

test("event add and update pass list placement, recurrence, reminders and invitees", async () => {
  const added = await run([
    "event", "add", "Launch", "--board", "board-1", "--date", "2026-11-01",
    "--column", "Later", "--recurrence-json", '{"type":"daily"}', "--reminders", "15m,1h", "--invitee", npub,
  ], { createEvent: async (input) => ({ ...event, ...(input as object) }) });
  assert.equal(added.status, 0);
  const input = added.calls[0][1] as Record<string, unknown>;
  assert.equal(input.columnId, "later");
  assert.deepEqual(input.recurrence, { type: "daily" });
  assert.deepEqual(input.reminders, ["15m", "1h"]);
  assert.deepEqual((input.participants as Array<{ pubkey: string }>).map((p) => p.pubkey), [hex]);

  const updated = await run([
    "event", "update", "event-1", "--board", "board-1", "--column", "Later", "--reminders", "1d", "--invitee", npub,
  ], { updateEvent: async (_id, _board, patch) => ({ ...event, ...(patch as object) }) });
  assert.equal(updated.status, 0);
  const [name, id, board, patch] = updated.calls[0] as [string, string, string, Record<string, unknown>];
  assert.deepEqual([name, id, board], ["updateEvent", "event-1", "board-1"]);
  assert.equal(patch.columnId, "later");
  assert.deepEqual(patch.reminders, ["1d"]);
  assert.deepEqual((patch.participants as Array<{ pubkey: string }>).map((p) => p.pubkey), [hex]);
});

test("show --human lists a task's documents and each assignee's state", async () => {
  const result = await run(["show", "task-1", "--human"], {
    getTask: async () => ({
      ...task,
      documents: [
        { name: "Spec.pdf", kind: "pdf", encrypted: true, remoteUrl: "https://files.example/spec" },
        { url: "https://files.example/raw" },
      ],
      assignees: [{ pubkey: hex, status: "accepted" }, { pubkey: "cd".repeat(32) }],
    }),
    getLocalReminders: () => [],
  });
  assert.equal(result.status, 0);
  const text = result.stdout.join("\n");
  assert.match(text, /Documents:\s+2/);
  assert.match(text, /- Spec\.pdf \[encrypted, pdf\] \(https:\/\/files\.example\/spec\)/);
  assert.match(text, /- document-2 \(https:\/\/files\.example\/raw\)/);
  assert.match(text, /Assignment states:/);
  assert.match(text, /: accepted/);
  assert.match(text, /: pending/);
});

test("event show lists invitees with their roles and the answers they published", async () => {
  const other = "cd".repeat(32);
  const rsvps = [
    { eventId: "event-1", attendeePubkey: hex, createdAt: 100, status: "accepted", inviteToken: "t1", fb: "busy", note: "Bringing dessert" },
    { eventId: "event-1", attendeePubkey: other, createdAt: 90, status: "declined", inviteToken: "t2" },
  ];
  const handlers = {
    getEvent: async () => ({
      ...event,
      participants: [{ pubkey: hex, role: "attendee" }, { pubkey: other }],
    }),
    listEventRsvps: async () => rsvps,
  };
  const result = await run(["event", "show", "event-1"], handlers);
  assert.equal(result.status, 0);
  const text = result.stdout.join("\n");
  assert.match(text, /invitees: 2/);
  assert.match(text, new RegExp(`- ${hex} \\(attendee\\)`));
  assert.match(text, /responses: 2/);
  assert.match(text, new RegExp(`- ${hex}: accepted, busy — Bringing dessert`));
  assert.match(text, new RegExp(`- ${other}: declined`));
  assert.ok(result.calls.some((call) => call[0] === "listEventRsvps" && call[1] === "event-1"));

  const json = await run(["event", "show", "event-1", "--json"], handlers);
  assert.deepEqual(JSON.parse(json.stdout.join("\n")).rsvps, rsvps);
});
