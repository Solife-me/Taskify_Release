import { describe, expect, it, vi } from "vitest";
import { TaskPublishVersionTracker } from "../domains/tasks/taskMovePersistence";
import type { Board, Task } from "../domains/tasks/taskTypes";
import { BoardPublisher, type BoardPublisherDeps, type EventTemplate } from "./boardPublisher";
import { BoardSyncLedger } from "./boardSyncLedger";
import { boardMetadataEvent, taskEventBody, taskEventTags } from "./boardWire";
import { calendarEventPayload } from "./calendarWire";
import type { CalendarEvent } from "../domains/tasks/taskTypes";

const shared: Board = { id: "local-1", name: "Team", kind: "lists", columns: [{ id: "c1", name: "Todo" }], nostr: { boardId: "nb1", relays: ["wss://r"] } } as Board;
const ACTOR = "a".repeat(64);

function setup(overrides: Partial<BoardPublisherDeps> = {}) {
  const sent: Array<{ relays: string[]; template: EventTemplate }> = [];
  const ledger = new BoardSyncLedger({ load: () => null, save: () => {} });
  const fingerprints = new Map<string, string>();
  const deps: BoardPublisherDeps = {
    ledger,
    versions: new TaskPublishVersionTracker(),
    boards: () => [shared],
    relaysFor: (board) => board.nostr?.relays ?? [],
    actorPubkey: () => ACTOR,
    boardTag: (id) => `tag:${id}`,
    deriveBoardKeys: async () => ({ sk: "sk", skHex: "skhex", pk: "b".repeat(64) }),
    encrypt: async (_id, plaintext) => `enc(${plaintext})`,
    encryptCalendarForBoard: async (payload) => `board(${JSON.stringify(payload)})`,
    encryptCalendarForInvitees: async (payload, eventKey) => `view:${eventKey}(${JSON.stringify(payload)})`,
    publish: async (relays, template) => {
      sent.push({ relays, template });
      return { createdAt: template.created_at, id: `id-${sent.length}` };
    },
    prepareAttachments: async () => ({ images: null, image: null, documents: null }),
    storedTaskAt: () => 0,
    recordTaskVersion: vi.fn(),
    metadataFingerprints: {
      isUnchanged: (key, value) => fingerprints.get(key) === JSON.stringify(value),
      record: (key, value) => fingerprints.set(key, JSON.stringify(value)),
    },
    onTaskPending: vi.fn(),
    onTaskSettled: vi.fn(),
    onAttachmentsUploaded: vi.fn(),
    onEventPending: vi.fn(),
    onEventSettled: vi.fn(),
    onEventSecretsMerged: vi.fn(),
    onEventAttachmentsUploaded: vi.fn(),
    now: () => 1_000_000,
    ...overrides,
  };
  return { publisher: new BoardPublisher(deps), deps, sent, ledger };
}

const task = (overrides: Partial<Task> = {}): Task =>
  ({ id: "t1", boardId: "local-1", title: "Ship", dueISO: "2026-10-15T05:00:00.000Z", columnId: "c1", ...overrides }) as Task;

describe("board wire format", () => {
  it("names compound children by their shared id and tags metadata with the board tag", () => {
    const child: Board = { ...shared, id: "local-2", nostr: { boardId: "nb2", relays: [] } } as Board;
    const compound = { id: "cmp", name: "All", kind: "compound", children: ["local-2", "unknown"], hideChildBoardNames: true } as Board;
    expect(boardMetadataEvent(compound, [child], "tag")).toEqual({
      tags: [["d", "tag"], ["b", "tag"], ["k", "compound"], ["name", "All"]],
      payload: { clearCompletedDisabled: false, children: ["nb2", "unknown"], listIndex: false, hideBoardNames: true },
    });
  });

  it("files week-board tasks under the day column and sends explicit nulls for cleared fields", () => {
    expect(taskEventTags({ id: "t", columnId: "c9" }, { kind: "week" }, "tag", "done")).toEqual([
      ["d", "t"], ["b", "tag"], ["col", "day"], ["status", "done"],
    ]);
    const body = taskEventBody(task({ reminders: ["15m"] } as Partial<Task>), {
      actorPubkey: ACTOR,
      attachments: { images: null, documents: null },
    });
    expect(body).toMatchObject({ title: "Ship", priority: null, bounty: null, subtasks: null, assignees: null, inboxItem: null, lastEditedBy: ACTOR });
    expect(body).not.toHaveProperty("reminders");
  });
});

describe("BoardPublisher", () => {
  it("publishes metadata ahead of a task, once, then the task at its reserved time", async () => {
    const { publisher, sent, ledger, deps } = setup();
    const t = task();
    await publisher.publishTask(t);
    await publisher.publishTask(task({ title: "Ship it" }));
    expect(sent.map((entry) => entry.template.kind)).toEqual([30300, 30301, 30301]);
    expect(sent[1].template.tags).toEqual([["d", "t1"], ["b", "tag:nb1"], ["col", "c1"], ["status", "open"]]);
    expect(deps.recordTaskVersion).toHaveBeenCalledWith(t, sent[1].template.created_at);
    // Once signed, the version is stored with its event id (C7-3).
    expect(deps.recordTaskVersion).toHaveBeenCalledWith(t, sent[1].template.created_at, "id-2");
    expect(t._nostrAt).toBeUndefined(); // the object in the store is not mutated
    expect(ledger.taskAt("tag:nb1", "t1")).toBe(sent[2].template.created_at);
    expect(ledger.taskVersion("tag:nb1", "t1")).toEqual({ createdAt: sent[2].template.created_at, id: "id-3" });
    expect(ledger.isTaskPending("tag:nb1", "t1")).toBe(false);
    expect(deps.onTaskSettled).toHaveBeenCalledWith("t1");
  });

  it("publishes each board definition after the newest one known, even in the same second", async () => {
    const { publisher, sent, ledger } = setup();
    await publisher.publishBoardMetadata(shared);
    await publisher.publishBoardMetadata({ ...shared, name: "Team A" } as Board);
    expect(sent.map((entry) => entry.template.created_at)).toEqual([1000, 1001]);

    // Another member's definition from a clock ahead of this one.
    ledger.acceptBoardMeta("tag:nb1", 1500);
    await publisher.publishBoardMetadata({ ...shared, name: "Team B" } as Board);
    expect(sent[sent.length - 1].template.created_at).toBe(1501);
    expect(ledger.boardMetaAt("tag:nb1")).toBe(1501);
  });

  it("drops a publish superseded by a newer edit of the same task", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { publisher, sent } = setup({
      encrypt: async (_id, plaintext) => {
        if (plaintext.includes('"title":"Old"')) await gate;
        return plaintext;
      },
    });
    const first = publisher.publishTask(task({ title: "Old" }), undefined, { skipBoardMetadata: true });
    await publisher.publishTask(task({ title: "New" }), undefined, { skipBoardMetadata: true });
    release();
    await first;
    expect(sent.map((entry) => JSON.parse(entry.template.content).title)).toEqual(["New"]);
  });

  it("records a deletion before sending it and keeps it after the relays confirm", async () => {
    const { publisher, ledger, sent } = setup({
      deriveBoardKeys: async () => {
        expect(ledger.isTombstoned("tag:nb1", "t1")).toBe(true);
        return { sk: "sk", skHex: "skhex", pk: "b".repeat(64) };
      },
    });
    await publisher.publishTaskDeleted(task());
    expect(sent[sent.length - 1]?.template.tags).toContainEqual(["status", "deleted"]);
    expect(ledger.isTombstoned("tag:nb1", "t1")).toBe(true);
  });

  it("settles the task even when preparing the publish fails", async () => {
    const { publisher, ledger, deps } = setup({
      prepareAttachments: async () => {
        throw new Error("upload failed");
      },
    });
    await expect(publisher.publishTask(task())).rejects.toThrow("upload failed");
    expect(ledger.isTaskPending("tag:nb1", "t1")).toBe(false);
    expect(deps.onTaskSettled).toHaveBeenCalledWith("t1");
  });

  it("ignores tasks on local-only boards", async () => {
    const { publisher, sent } = setup({ boards: () => [{ ...shared, nostr: undefined } as Board] });
    await publisher.publishTask(task());
    await publisher.publishTaskDeleted(task());
    expect(sent).toEqual([]);
  });
});

describe("calendar publishing", () => {
  const invitee = "c".repeat(64);
  // A real event key: 32 bytes of base64 (any other key is replaced before publishing).
  const KEY = btoa("k".repeat(32));
  const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent =>
    ({
      id: "e1",
      boardId: "local-1",
      title: "Review",
      kind: "date",
      startDate: "2026-10-20",
      eventKey: KEY,
      participants: [{ pubkey: invitee }],
      inviteTokens: { [invitee]: "tok" },
      ...overrides,
    }) as CalendarEvent;

  it("keeps the event key, participants and invite tokens out of the invitees' copy", () => {
    const board = calendarEventPayload(event(), { audience: "board", actorPubkey: ACTOR });
    const invitees = calendarEventPayload(event(), { audience: "invitees", actorPubkey: ACTOR });
    expect(board).toMatchObject({ v: 1, eventId: "e1", eventKey: KEY, participants: [{ pubkey: invitee }], inviteTokens: { [invitee]: "tok" } });
    expect(invitees).toMatchObject({ v: 1, eventId: "e1", title: "Review", startDate: "2026-10-20" });
    for (const secret of ["eventKey", "participants", "inviteTokens"]) expect(invitees).not.toHaveProperty(secret);
    expect(calendarEventPayload(event(), { audience: "board", deleted: true })).not.toHaveProperty("title");
  });

  it("publishes the board copy then the view copy, and records the board copy's time", async () => {
    const { publisher, sent, ledger, deps } = setup();
    await publisher.publishCalendarEvent(event(), undefined, { skipBoardMetadata: true });
    expect(sent.map((entry) => entry.template.kind)).toEqual([30310, 30311]);
    expect(sent[0].template.tags).toEqual([["d", "e1"], ["b", "tag:nb1"]]);
    expect(sent[1].template.content.startsWith(`view:${KEY}(`)).toBe(true);
    expect(ledger.eventAt("tag:nb1", "e1")).toBe(sent[0].template.created_at);
    expect(deps.onEventSecretsMerged).not.toHaveBeenCalled();
    expect(deps.onEventSettled).toHaveBeenCalledWith("e1");
  });

  it("stores a newly made event key before publishing with it", async () => {
    const { publisher, sent, deps } = setup();
    await publisher.publishCalendarEvent(event({ eventKey: undefined }), undefined, { skipBoardMetadata: true });
    const stored = (deps.onEventSecretsMerged as ReturnType<typeof vi.fn>).mock.calls[0][0] as CalendarEvent;
    expect(stored.eventKey).toBeTruthy();
    expect(sent[1].template.content.startsWith(`view:${stored.eventKey}(`)).toBe(true);
  });

  it("never publishes generated occurrences or read-only events", async () => {
    const { publisher, sent } = setup();
    await publisher.publishCalendarEvent(event({ generated: true }));
    await publisher.publishCalendarEventDeleted(event({ readOnly: true }));
    expect(sent).toEqual([]);
  });
});
