import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nip19 } from "nostr-tools";
import { runCli } from "../dist/cli.js";
import type { TaskifyConfig } from "../src/config.ts";
import { captureConsole, harnessConfig, harnessDependencies, recordingRuntime } from "./helpers/cliHarness.ts";

/** C12-2 stage 6: sharing, assignment, event invite/RSVP and backup relay merges. */

const relays = ["wss://relay.example"];
const recipientHex = "ab".repeat(32);
const recipientNpub = nip19.npubEncode(recipientHex);
const senderSecretHex = "01".repeat(32);
const now = () => new Date("2026-10-25T12:00:00.000Z");

function sharingConfig(changes: Partial<TaskifyConfig> = {}): TaskifyConfig {
  const config = structuredClone(harnessConfig);
  config.relays = relays;
  config.profiles.test.relays = relays;
  return Object.assign(config, changes);
}

type Sent = { envelope: { item: Record<string, unknown>; sender?: { npub?: string } }; senderSecretHex: string; recipientPubkeyHex: string; relays: string[] };

function run(argv: string[], handlers: Record<string, (...args: unknown[]) => unknown> = {}, options: {
  config?: TaskifyConfig;
  inbox?: unknown[];
  sendError?: Error;
} = {}) {
  const sent: Sent[] = [];
  const fetched: unknown[] = [];
  const { runtime, calls } = recordingRuntime(handlers);
  const harness = harnessDependencies(runtime, {
    now,
    shareTransport: {
      send: async (input) => {
        if (options.sendError) throw options.sendError;
        sent.push(input as unknown as Sent);
        return { eventId: "wrap-1", relays: [] } as never;
      },
      fetchInbox: async (input) => {
        fetched.push(input);
        return (options.inbox ?? []) as never;
      },
    },
  }, options.config ?? sharingConfig());
  return captureConsole(() => runCli(["node", "taskify", ...argv], harness.dependencies))
    .then((result) => ({ ...result, calls, sent, fetched, saved: harness.saved }));
}

test("share board sends the board's envelope to the recipient over the profile's relays", async () => {
  const result = await run(["share", "board", "harness board 7f06", recipientNpub]);
  assert.equal(result.status, 0);
  assert.equal(result.sent.length, 1);
  const [sent] = result.sent;
  assert.equal(sent.senderSecretHex, senderSecretHex);
  assert.equal(sent.recipientPubkeyHex, recipientHex);
  assert.deepEqual(sent.relays, relays);
  assert.deepEqual(sent.envelope.item, { type: "board", boardId: "board-1", boardName: "Harness Board 7f06", relays });
  assert.ok(sent.envelope.sender?.npub?.startsWith("npub1"));

  const missing = await run(["share", "board", "Nowhere", recipientNpub]);
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.sent, []);
});

test("share task sends the task, as an assignment request when asked, and disconnects", async () => {
  const handlers = {
    getTask: async () => ({ id: "task-1", boardId: "board-1", title: "Plan trip", note: "Book trains", priority: 2, completed: false }),
  };
  const shared = await run(["share", "task", "task-1", recipientHex, "--board", "Harness Board 7f06", "--assignment"], handlers);
  assert.equal(shared.status, 0);
  assert.deepEqual(shared.calls, [["getTask", "task-1", "board-1"], ["disconnect"]]);
  const item = shared.sent[0].envelope.item;
  assert.equal(item.type, "task");
  assert.equal(item.title, "Plan trip");
  assert.equal(item.note, "Book trains");
  assert.equal(item.sourceTaskId, "task-1");
  assert.equal(item.assignment, true);

  const missing = await run(["share", "task", "nope", recipientHex], { getTask: async () => null });
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.sent, []);
  assert.deepEqual(missing.calls.at(-1), ["disconnect"]);
});

test("assignment and RSVP responses carry the status and the command's time", async () => {
  const assignment = await run(["share", "respond-assignment", "task-1", "accepted", recipientNpub]);
  assert.equal(assignment.status, 0);
  assert.deepEqual(assignment.sent[0].envelope.item, {
    type: "task-assignment-response", taskId: "task-1", status: "accepted", respondedAt: now().toISOString(),
  });

  const rsvp = await run(["event", "rsvp", "event-1", "tentative", "--to", recipientNpub]);
  assert.equal(rsvp.status, 0);
  assert.equal(rsvp.sent[0].recipientPubkeyHex, recipientHex);
  assert.deepEqual(rsvp.sent[0].envelope.item, {
    type: "event-rsvp-response", eventId: "event-1", status: "tentative", respondedAt: now().toISOString(),
  });

  const noRecipient = await run(["event", "rsvp", "event-1", "accepted"]);
  assert.equal(noRecipient.status, 1);
  assert.match(noRecipient.stderr.join("\n"), /--to <npubOrHex> is required/);
});

test("a delivery failure is reported with status 1 and still disconnects", async () => {
  const result = await run(["share", "task", "task-1", recipientHex], {
    getTask: async () => ({ id: "task-1", boardId: "board-1", title: "Plan trip", completed: false }),
  }, { sendError: new Error("no relay accepted the message") });
  assert.equal(result.status, 1);
  assert.match(result.stderr.join("\n"), /no relay accepted the message/);
  assert.deepEqual(result.calls.at(-1), ["disconnect"]);
});

test("share inbox lists messages; --apply acts on each new one once and saves progress", async () => {
  // An `event-rsvp-response` comes only from an older CLI: other clients answer with their own
  // kind 30312 event, which the organizer reads live. It is listed and marked seen, never applied.
  const sender = "cd".repeat(32);
  const inbox = [
    { rumorId: "seen", senderPubkey: sender, envelope: { item: { type: "task", title: "Already done" } } },
    { rumorId: "r1", senderPubkey: sender, envelope: { item: { type: "board", boardId: "new-board", boardName: "Shared", relays: ["wss://shared.example"] } } },
    { rumorId: "r2", senderPubkey: sender, envelope: { item: { type: "board", boardId: "board-1", boardName: "Again" } } },
    { rumorId: "r3", senderPubkey: sender, envelope: { item: { type: "task", title: "Water plants", note: "Twice", assignees: [{ pubkey: recipientHex }] } } },
    { rumorId: "r4", senderPubkey: sender, envelope: { item: { type: "task-assignment-response", taskId: "task-1", status: "declined", respondedAt: "2026-10-24T00:00:00.000Z" } } },
    { rumorId: "r5", senderPubkey: sender, envelope: { item: { type: "event-rsvp-response", eventId: "event-1", status: "accepted", respondedAt: "2026-10-24T01:00:00.000Z" } } },
  ];

  const listed = await run(["share", "inbox", "--json"], {}, { inbox });
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.fetched, [{ recipientSecretHex: senderSecretHex, relays, limit: 100 }]);
  assert.equal(JSON.parse(listed.stdout.join("\n")).length, inbox.length);
  assert.deepEqual(listed.saved, []);

  const handlers = {
    getDefaultBoardId: () => "board-1",
    createTaskFull: async () => ({ id: "t", boardId: "board-1", title: "Water plants", completed: false }),
    applyTaskAssignmentResponse: async () => undefined,
  };
  const applied = await run(["share", "inbox", "--apply"], handlers, {
    inbox,
    config: sharingConfig({ processedInboxRumorIds: ["seen"] }),
  });
  assert.equal(applied.status, 0);
  assert.deepEqual(applied.calls.filter((call) => call[0] !== "getDefaultBoardId"), [
    ["createTaskFull", {
      boardId: "board-1", title: "Water plants", note: "Twice", inboxItem: true, assignees: [{ pubkey: recipientHex }],
    }],
    ["applyTaskAssignmentResponse", "task-1", sender, "declined", "2026-10-24T00:00:00.000Z"],
    ["disconnect"],
  ]);
  const savedConfig = applied.saved.at(-1)!;
  assert.deepEqual(savedConfig.processedInboxRumorIds, ["seen", "r1", "r2", "r3", "r4", "r5"]);
  assert.deepEqual(savedConfig.boards.map((b) => b.id), ["board-1", "new-board"]);
  assert.deepEqual(savedConfig.boards[1], { id: "new-board", name: "Shared", relays: ["wss://shared.example"] });
});

test("assign adds the assignee once and can notify them; unassign removes them", async () => {
  const task = { id: "task-1", boardId: "board-1", title: "Plan trip", completed: false, assignees: [{ pubkey: "ef".repeat(32) }] };
  const handlers = {
    getTask: async () => task,
    updateTask: async (_id: unknown, _board: unknown, patch: unknown) => ({ ...task, ...(patch as object) }),
  };

  const assigned = await run(["assign", "task-1", recipientNpub, "--board", "board-1", "--notify"], handlers);
  assert.equal(assigned.status, 0);
  assert.deepEqual(assigned.calls, [
    ["getTask", "task-1", "board-1"],
    ["updateTask", "task-1", "board-1", { assignees: [{ pubkey: "ef".repeat(32) }, { pubkey: recipientHex }] }],
    ["disconnect"],
  ]);
  assert.equal(assigned.sent[0].recipientPubkeyHex, recipientHex);
  assert.equal(assigned.sent[0].envelope.item.assignment, true);

  const again = await run(["assign", "task-1", "ef".repeat(32), "--board", "board-1"], handlers);
  assert.equal(again.status, 0);
  assert.ok(!again.calls.some((call) => call[0] === "updateTask"));
  assert.match(again.stdout.join("\n"), /Already assigned/);

  const unassigned = await run(["unassign", "task-1", "ef".repeat(32), "--board", "board-1"], handlers);
  assert.equal(unassigned.status, 0);
  assert.deepEqual(unassigned.calls[1], ["updateTask", "task-1", "board-1", { assignees: [] }]);
  assert.deepEqual(unassigned.sent, []);
});

test("backup merge-relays saves the backup's relays, previews with --dry-run, and keeps ours when it has none", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "taskify-backup-"));
  try {
    const withRelays = path.join(directory, "backup.json");
    writeFileSync(withRelays, JSON.stringify({ defaultRelays: ["wss://a.example", "wss://b.example"] }));
    const noRelays = path.join(directory, "empty.json");
    writeFileSync(noRelays, JSON.stringify({ defaultRelays: [] }));

    const merged = await run(["backup", "merge-relays", withRelays]);
    assert.equal(merged.status, 0);
    assert.deepEqual(merged.saved.at(-1)?.relays, ["wss://a.example", "wss://b.example"]);

    const preview = await run(["backup", "merge-relays", withRelays, "--dry-run"]);
    assert.equal(preview.status, 0);
    assert.deepEqual(preview.saved, []);
    assert.match(preview.stdout.join("\n"), /merged relays:\s+2/);

    const unchanged = await run(["backup", "merge-relays", noRelays]);
    assert.equal(unchanged.status, 0);
    assert.deepEqual(unchanged.saved, []);
    assert.match(unchanged.stdout.join("\n"), /No relay changes to apply/);

    const unreadable = await run(["backup", "merge-relays", path.join(directory, "missing.json")]);
    assert.equal(unreadable.status, 1);
    assert.deepEqual(unreadable.saved, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("share inbox --apply keeps the messages it applied when a later one fails", async () => {
  const sender = "cd".repeat(32);
  const inbox = [
    { rumorId: "r1", senderPubkey: sender, envelope: { item: { type: "task", title: "First" } } },
    { rumorId: "r2", senderPubkey: sender, envelope: { item: { type: "task", title: "Second" } } },
  ];
  const result = await run(["share", "inbox", "--apply"], {
    getDefaultBoardId: () => "board-1",
    createTaskFull: async (input) => {
      if ((input as { title: string }).title === "Second") throw new Error("relay unavailable");
      return { id: "t1", boardId: "board-1", title: "First", completed: false };
    },
  }, { inbox });

  assert.equal(result.status, 1);
  // Applying again must not create "First" a second time.
  assert.deepEqual(result.saved.at(-1)?.processedInboxRumorIds, ["r1"]);
  assert.deepEqual(result.calls.at(-1), ["disconnect"]);
});

test("event invite sends the event's key, the recipient's token and Taskify's calendar addresses", async () => {
  const key = btoa("k".repeat(32));
  const boardPubkey = "e".repeat(64);
  const invitation = {
    event: {
      id: "event-1", boardId: "board-1", title: "Launch", kind: "date", startDate: "2026-11-01", endDate: "2026-11-01",
      eventKey: key, participants: [{ pubkey: recipientHex }], inviteTokens: { [recipientHex]: "token-r" },
    },
    canonical: `30310:${boardPubkey}:event-1`,
    view: `30311:${boardPubkey}:event-1`,
    inviteToken: "token-r",
    relays: ["wss://board.example"],
  };
  for (const argv of [
    ["event", "invite", "event-1", recipientNpub, "--board", "Harness Board 7f06"],
    ["share", "event", "event-1", recipientNpub, "--board", "Harness Board 7f06"],
  ]) {
    const result = await run(argv, { inviteToEvent: async () => invitation });
    assert.equal(result.status, 0, `${argv.join(" ")}: ${result.stderr.join("\n")}`);
    assert.deepEqual(result.calls, [["inviteToEvent", "event-1", "board-1", recipientHex], ["disconnect"]], argv.join(" "));
    assert.equal(result.sent.length, 1, argv.join(" "));
    assert.equal(result.sent[0].recipientPubkeyHex, recipientHex);
    assert.deepEqual(result.sent[0].relays, ["wss://board.example", ...relays]);
    assert.deepEqual(result.sent[0].envelope.item, {
      type: "event", eventId: "event-1",
      canonical: invitation.canonical, view: invitation.view,
      eventKey: key, inviteToken: "token-r",
      title: "Launch", start: "2026-11-01", end: "2026-11-01",
      relays: ["wss://board.example"],
    }, argv.join(" "));
  }

  const missing = await run(["event", "invite", "nope", recipientNpub], { inviteToEvent: async () => null });
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.sent, []);
  assert.match(missing.stderr.join("\n"), /Event not found: nope/);
});
