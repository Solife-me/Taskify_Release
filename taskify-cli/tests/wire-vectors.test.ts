import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NostrEvent } from "nostr-tools";
import { compareReplaceableEvents } from "../src/shared/latestEvent.ts";
import type { TaskifyConfig } from "../src/config.ts";
import { boardEvents, runtimeHarness, taskPayload } from "./helpers/runtimeHarness.ts";

/**
 * C12-5: the CLI as a third consumer of the cross-client wire vectors in taskify-core/fixtures.
 * The PWA and iOS write them; each event is put on the loopback relay and read, and edited, by
 * the CLI's own runtime, so what is checked is what the CLI really does with another client's data.
 */

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../taskify-core/fixtures/${name}`, import.meta.url), "utf8"));

type VectorBoard = { id: string; name: string; kind: "lists" | "week"; columns?: { id: string; name: string }[]; nostr: { boardId: string } };
type Vector<E> = { name: string; board: "lists" | "week"; event: NostrEvent; expected: E };

/** The vector boards, as the CLI knows a board: by its shared id. */
function vectorBoards(boards: Record<string, VectorBoard>): TaskifyConfig["boards"] {
  return Object.values(boards).map((board) => ({
    id: board.nostr.boardId,
    name: board.name,
    kind: board.kind,
    ...(board.columns ? { columns: board.columns } : {}),
  }));
}

const seconds = (iso: string | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

test("event versions are ordered as every client orders them", () => {
  const { vectors } = fixture("event-version-vectors.json") as {
    vectors: Array<{ name: string; a: { createdAt: number; id: string | null }; b: { createdAt: number; id: string | null }; expected: number }>;
  };
  assert.ok(vectors.length > 0);
  for (const { name, a, b, expected } of vectors) {
    const compared = compareReplaceableEvents(
      { created_at: a.createdAt, ...(a.id ? { id: a.id } : {}) },
      { created_at: b.createdAt, ...(b.id ? { id: b.id } : {}) },
    );
    assert.equal(Math.sign(compared), expected, name);
  }
});

type TaskExpected = {
  id: string;
  title: string;
  note: string;
  dueAt: number | null;
  status: "open" | "done" | "deleted";
  columnId: string | null;
  priority: number | null;
  recurrence: unknown;
  seriesId: string | null;
  scriptureMemoryId: string | null;
  scriptureMemoryStage: number | null;
  documents: Array<Record<string, unknown>> | null;
  republishKeeps: Record<string, unknown>;
};

for (const source of ["pwa", "ios"]) {
  test(`the CLI reads and edits the ${source}'s task events as every client must`, async () => {
    const { boards, vectors } = fixture(`task-event-vectors-${source}.json`) as { boards: Record<string, VectorBoard>; vectors: Vector<TaskExpected>[] };
    assert.ok(vectors.length > 0);
    const h = await runtimeHarness({ boards: vectorBoards(boards) });
    try {
      for (const { name, board, event, expected } of vectors) {
        const boardId = boards[board].nostr.boardId;
        h.relay.events.push(event);
        const task = await h.runtime.getTask(expected.id, boardId);
        assert.ok(task, `${name}: decoded`);
        const status = task.deleted ? "deleted" : task.completed ? "done" : "open";
        assert.deepEqual({
          id: task.id,
          title: task.title,
          note: task.note ?? "",
          dueAt: seconds(task.dueISO),
          status,
          columnId: boards[board].kind === "lists" ? task.column ?? null : null,
          priority: task.priority ?? null,
          recurrence: task.recurrence ?? null,
          seriesId: task.seriesId ?? null,
          documents: task.documents?.length
            ? task.documents.map((doc) => ({ id: doc.id, name: doc.name, mimeType: doc.mimeType, kind: doc.kind, remoteUrl: doc.remoteUrl ?? null, encrypted: doc.encrypted === true }))
            : null,
        }, {
          id: expected.id, title: expected.title, note: expected.note, dueAt: expected.dueAt, status: expected.status,
          columnId: expected.columnId, priority: expected.priority, recurrence: expected.recurrence, seriesId: expected.seriesId,
          documents: expected.documents,
        }, name);
        if (status === "deleted") continue;

        // An edit from the CLI keeps what other clients wrote, including what it doesn't model.
        h.advance(60_000);
        await h.runtime.updateTask(expected.id, boardId, { title: `${expected.title} (edited)` });
        const republished = boardEvents(h.relay, boardId, 30301).find((candidate) => candidate.tags.some((t) => t[0] === "d" && t[1] === expected.id))!;
        const payload = await taskPayload(republished, boardId);
        assert.equal(payload.title, `${expected.title} (edited)`, name);
        assert.equal(payload.scriptureMemoryId ?? null, expected.scriptureMemoryId, `${name}: scripture memory link kept`);
        assert.equal(payload.scriptureMemoryStage ?? null, expected.scriptureMemoryStage, `${name}: scripture memory stage kept`);
        for (const [key, value] of Object.entries(expected.republishKeeps)) {
          assert.deepEqual(payload[key], value, `${name}: ${key} kept on republish`);
        }
      }
    } finally {
      await h.close();
    }
  });
}

type CalendarExpected = { id: string; title: string; start: string; image: string | null; documents: Array<Record<string, unknown>> | null };

for (const source of ["pwa", "ios"]) {
  test(`the CLI reads the ${source}'s calendar events as every client must`, async () => {
    const { boards, vectors } = fixture(`calendar-event-vectors-${source}.json`) as { boards: Record<string, VectorBoard>; vectors: Vector<CalendarExpected>[] };
    assert.ok(vectors.length > 0);
    const h = await runtimeHarness({ boards: vectorBoards(boards) });
    try {
      for (const { name, board, event, expected } of vectors) {
        h.relay.events.push(event);
        const decoded = await h.runtime.getEvent(expected.id, boards[board].nostr.boardId);
        assert.ok(decoded, `${name}: decoded`);
        assert.deepEqual({
          id: decoded.id,
          title: decoded.title,
          start: decoded.kind === "date" ? decoded.startDate : String(seconds(decoded.startISO)),
          image: decoded.image ?? null,
          documents: decoded.documents?.length
            ? decoded.documents.map((doc) => ({ id: doc.id, name: doc.name, mimeType: doc.mimeType, kind: doc.kind, remoteUrl: doc.remoteUrl ?? null, encrypted: doc.encrypted === true }))
            : null,
        }, expected, name);
      }
    } finally {
      await h.close();
    }
  });
}
