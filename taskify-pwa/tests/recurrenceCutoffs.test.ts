import { describe, expect, test } from "vitest";

import type { Task } from "../src/domains/tasks/taskTypes";
import {
  applyRecurringSeriesCutoff,
  capRecurringTaskAt,
  detachCancelledRecurringTask,
  parseRecurringSeriesCutoffs,
  recurringSeriesCutoffBefore,
  serializeRecurringSeriesCutoffs,
  updateRecurringSeriesCutoff,
  type RecurringSeriesCutoffs,
} from "../src/domains/tasks/recurrenceCutoffs";

const seed: Task = {
  id: "series-root",
  boardId: "board-1",
  title: "Old daily task",
  dueISO: "2026-07-01T12:00:00.000Z",
  dueTimeZone: "America/Chicago",
  recurrence: { type: "daily" },
};

describe("recurring series cutoffs", () => {
  test("computes the previous day in the task timezone", () => {
    const aucklandTask: Task = {
      ...seed,
      dueISO: "2026-07-12T01:00:00.000Z",
      dueTimeZone: "Pacific/Auckland",
    };

    expect(recurringSeriesCutoffBefore(aucklandTask)).toBe("2026-07-10T12:00:00.000Z");
  });

  test("computes the previous task day across a daylight-saving transition", () => {
    const losAngelesTask: Task = {
      ...seed,
      dueISO: "2026-11-01T17:00:00.000Z",
      dueTimeZone: "America/Los_Angeles",
    };

    expect(recurringSeriesCutoffBefore(losAngelesTask)).toBe("2026-10-31T07:00:00.000Z");
  });

  test("caps a stale unbounded seed after delete-all-future", () => {
    const cutoffs = updateRecurringSeriesCutoff(
      {},
      seed,
      "2026-07-11T05:00:00.000Z",
    );

    expect(applyRecurringSeriesCutoff(seed, cutoffs)).toMatchObject({
      recurrence: { type: "daily", untilISO: "2026-07-11T05:00:00.000Z" },
    });
  });

  test("suppresses a stale generated instance after the cutoff", () => {
    const cutoffs = updateRecurringSeriesCutoff(
      {},
      seed,
      "2026-07-11T05:00:00.000Z",
    );
    const staleInstance: Task = {
      ...seed,
      id: "recurrence:series-root:2026-07-12",
      seriesId: undefined,
      dueISO: "2026-07-12T12:00:00.000Z",
    };

    expect(applyRecurringSeriesCutoff(staleInstance, cutoffs)).toBeNull();
  });

  test("keeps an occurrence later on the cutoff calendar day", () => {
    const cutoffs = updateRecurringSeriesCutoff(
      {},
      seed,
      "2026-07-11T05:00:00.000Z",
    );
    const sameDayInstance: Task = {
      ...seed,
      id: "recurrence:series-root:2026-07-11",
      seriesId: "series-root",
      dueISO: "2026-07-11T23:00:00.000Z",
    };

    expect(applyRecurringSeriesCutoff(sameDayInstance, cutoffs)).not.toBeNull();
  });

  test("keeps a recoverable bounty archived after the cutoff without letting it recur", () => {
    const cutoffs = updateRecurringSeriesCutoff(
      {},
      seed,
      "2026-07-11T05:00:00.000Z",
    );
    const archivedBounty: Task = {
      ...seed,
      id: "recurrence:series-root:2026-07-12",
      seriesId: "series-root",
      dueISO: "2026-07-12T12:00:00.000Z",
      completed: true,
      bountyDeletedAt: "2026-07-11T15:00:00.000Z",
      bounty: {
        id: "bounty-1",
        token: "",
        state: "locked",
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
    };

    expect(applyRecurringSeriesCutoff(archivedBounty, cutoffs)).toMatchObject({
      id: archivedBounty.id,
      completed: true,
      recurrence: { type: "daily", untilISO: "2026-07-11T05:00:00.000Z" },
    });
  });

  test("restoring a bounty after the cutoff detaches it as a one-off task", () => {
    const cutoffs = updateRecurringSeriesCutoff(
      {},
      seed,
      "2026-07-11T05:00:00.000Z",
    );
    const restoredBounty: Task = {
      ...seed,
      id: "recurrence:series-root:2026-07-12",
      seriesId: "series-root",
      dueISO: "2026-07-12T12:00:00.000Z",
      completed: false,
      bounty: {
        id: "bounty-1",
        token: "",
        state: "locked",
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
    };

    expect(detachCancelledRecurringTask(restoredBounty, cutoffs)).toMatchObject({
      id: restoredBounty.id,
      completed: false,
      recurrence: undefined,
      seriesId: undefined,
    });
  });

  test("a later stale cutoff cannot reopen a cancelled series", () => {
    const initial = updateRecurringSeriesCutoff(
      {},
      seed,
      "2026-07-11T05:00:00.000Z",
    );
    const next = updateRecurringSeriesCutoff(
      initial,
      seed,
      "2026-07-20T05:00:00.000Z",
    );

    expect(next).toEqual(initial);
  });

  test("survives a persisted reload and still blocks a stale instance", () => {
    const stored = serializeRecurringSeriesCutoffs(
      updateRecurringSeriesCutoff({}, seed, "2026-07-11T05:00:00.000Z"),
    );
    const reloaded = parseRecurringSeriesCutoffs(stored);
    const staleInstance: Task = {
      ...seed,
      id: "recurrence:series-root:2026-07-12",
      seriesId: undefined,
      dueISO: "2026-07-12T12:00:00.000Z",
    };

    expect(applyRecurringSeriesCutoff(staleInstance, reloaded)).toBeNull();
  });

  test("deleted instances carry the durable series end", () => {
    expect(
      capRecurringTaskAt(
        {
          ...seed,
          id: "recurrence:series-root:2026-07-12",
          seriesId: "series-root",
          dueISO: "2026-07-12T12:00:00.000Z",
        },
        "2026-07-11T05:00:00.000Z",
      ),
    ).toMatchObject({
      seriesId: "series-root",
      recurrence: { type: "daily", untilISO: "2026-07-11T05:00:00.000Z" },
    });
  });

  test("malformed persisted data is ignored", () => {
    const malformed = { "board-1": { "series-root": "not-a-date" } } as RecurringSeriesCutoffs;
    expect(applyRecurringSeriesCutoff(seed, malformed)).toBe(seed);
  });
});
