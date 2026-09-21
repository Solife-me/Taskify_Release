import { afterEach, expect, test, vi } from "vitest";
import { kvStorage } from "./kvStorage";
import { loadBoardPrintJob, persistBoardPrintJob } from "./boardPrintJobs";

const key = "taskify_board_print_jobs_v1";
afterEach(() => vi.restoreAllMocks());

test("recovers legacy print jobs with defaults and filters malformed tasks", () => {
  vi.spyOn(kvStorage, "getItem").mockReturnValue(JSON.stringify({ board: {
    id: "print", boardId: "board", paperSize: "invalid",
    tasks: [null, { id: "empty" }, { id: "task", title: "Print me", label: "Monday" }],
  } }));
  const job = loadBoardPrintJob("board");
  expect(job).toMatchObject({ id: "print", boardName: "Board", layoutVersion: "v1", paperSize: "letter",
    tasks: [{ id: "task", title: "Print me", label: "Monday" }] });
  expect(Number.isFinite(Date.parse(job!.printedAtISO))).toBe(true);
});

test("updates one saved print job while preserving the other boards", () => {
  let saved = JSON.stringify({ other: { id: "other-print", boardId: "other", tasks: [] } });
  vi.spyOn(kvStorage, "getItem").mockImplementation(() => saved);
  const write = vi.spyOn(kvStorage, "setItem").mockImplementation((_key, value) => { saved = value; });
  const job = { id: "print", boardId: "board", boardName: "Work", printedAtISO: "2026-09-13T12:00:00Z", layoutVersion: "v2", paperSize: "letter" as const, tasks: [{ id: "task", title: "Print me" }] };
  persistBoardPrintJob(job);
  expect(write).toHaveBeenCalledWith(key, expect.any(String));
  expect(loadBoardPrintJob("board")).toEqual(job);
  expect(loadBoardPrintJob("other")?.id).toBe("other-print");
});

test("unusable saved data does not prevent the app from opening", () => {
  const read = vi.spyOn(kvStorage, "getItem");
  for (const raw of [null, "{bad json", "null", '"string"', '{}', '{"board":{"id":"print"}}']) {
    read.mockReturnValue(raw);
    expect(loadBoardPrintJob("board")).toBeNull();
  }
  read.mockImplementation(() => { throw new Error("Storage unavailable"); });
  expect(loadBoardPrintJob("board")).toBeNull();
  expect(loadBoardPrintJob("")).toBeNull();
});

test("storage write failures remain non-fatal", () => {
  vi.spyOn(kvStorage, "getItem").mockReturnValue(null);
  vi.spyOn(kvStorage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
  expect(() => persistBoardPrintJob({ id: "print", boardId: "board", boardName: "Work", printedAtISO: "2026-09-13T12:00:00Z", layoutVersion: "v2", paperSize: "letter", tasks: [] })).not.toThrow();
});
