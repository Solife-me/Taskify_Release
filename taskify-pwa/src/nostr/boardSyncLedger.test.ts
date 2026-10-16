import { describe, expect, it, vi } from "vitest";
import { BoardSyncLedger, type TombstoneStorage } from "./boardSyncLedger";

function memoryStorage(initial: string | null = null): TombstoneStorage & { saved: string | null } {
  const storage = {
    saved: initial,
    load: () => storage.saved,
    save: (value: string) => {
      storage.saved = value;
    },
  };
  return storage;
}

describe("BoardSyncLedger", () => {
  it("accepts newer task events, and equal ones only while nothing local is pending", () => {
    const ledger = new BoardSyncLedger(memoryStorage());
    expect(ledger.acceptTaskEvent("b", "t", 100)).toBe(true);
    expect(ledger.acceptTaskEvent("b", "t", 99)).toBe(false);
    expect(ledger.acceptTaskEvent("b", "t", 100)).toBe(true);

    const reserved = ledger.reserveTaskPublish("b", "t", 0, 100);
    expect(reserved).toBeGreaterThan(100);
    expect(ledger.isTaskPending("b", "t")).toBe(true);
    expect(ledger.acceptTaskEvent("b", "t", reserved)).toBe(false);
    ledger.settleTask("b", "t");
    expect(ledger.acceptTaskEvent("b", "t", reserved)).toBe(true);
  });

  it("reserves past both the known clock and the version stored with the task", () => {
    const ledger = new BoardSyncLedger(memoryStorage());
    ledger.noteTask("b", "t", 50);
    expect(ledger.reserveTaskPublish("b", "t", 500, 10)).toBeGreaterThan(500);
  });

  it("never moves a clock back", () => {
    const ledger = new BoardSyncLedger(memoryStorage());
    ledger.noteTask("b", "t", 200);
    expect(ledger.noteTask("b", "t", 100)).toBe(200);
    ledger.noteEvent("b", "e", 300);
    expect(ledger.noteEvent("b", "e", 1)).toBe(300);
  });

  it("applies the same rule to calendar events and keeps board metadata replaceable", () => {
    const ledger = new BoardSyncLedger(memoryStorage());
    expect(ledger.acceptCalendarEvent("b", "e", 10)).toBe(true);
    ledger.markEventPending("b", "e");
    expect(ledger.acceptCalendarEvent("b", "e", 10)).toBe(false);
    expect(ledger.acceptCalendarEvent("b", "e", 11)).toBe(true);
    expect(ledger.acceptBoardMeta("b", 5)).toBe(true);
    expect(ledger.acceptBoardMeta("b", 5)).toBe(true);
    expect(ledger.acceptBoardMeta("b", 4)).toBe(false);
  });

  it("keeps deletions across reloads and rejects older versions of a deleted task", async () => {
    const storage = memoryStorage();
    const ledger = new BoardSyncLedger(storage);
    ledger.recordTombstone("b", "t", 100);
    ledger.recordTombstone("b", "t", 90);
    await Promise.resolve();
    expect(JSON.parse(storage.saved!)).toEqual({ b: { t: 100 } });

    const reloaded = new BoardSyncLedger(storage);
    expect(reloaded.isTombstoned("b", "t")).toBe(true);
    expect(reloaded.acceptTaskEvent("b", "t", 99)).toBe(false);
    reloaded.clearTombstone("b", "t");
    expect(storage.saved).toBe("{}");
  });

  it("coalesces a burst of deletions into one save and trims old ones", async () => {
    const storage = memoryStorage();
    const save = vi.spyOn(storage, "save");
    const ledger = new BoardSyncLedger(storage, 2);
    for (let i = 1; i <= 105; i++) ledger.recordTombstone("b", `t${i}`, i);
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(storage.saved!).b).length).toBeLessThanOrEqual(102);
    expect(ledger.isTombstoned("b", "t105")).toBe(true);
    expect(ledger.isTombstoned("b", "t1")).toBe(false);
  });

  it("survives unreadable stored tombstones", () => {
    expect(() => new BoardSyncLedger(memoryStorage("not json"))).not.toThrow();
  });
});
