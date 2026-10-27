import { describe, expect, test } from "vitest";
import { settleScroll } from "./settleScroll";

/** A scroll container whose content grows as rows are measured, with manual animation frames. */
function harness(targets: Array<number | null>) {
  let frame = 0;
  let top = 0;
  const queue: Array<() => void> = [];
  const writes: number[] = [];
  const results: boolean[] = [];
  let interrupted = false;
  const cancel = settleScroll({
    target: () => targets[Math.min(frame, targets.length - 1)],
    current: () => top,
    scrollTo: (value) => {
      writes.push(value);
      top = value;
    },
    requestFrame: (callback) => {
      queue.push(callback);
      return queue.length;
    },
    cancelFrame: () => {
      queue.length = 0;
    },
    maxFrames: 20,
    userInterrupted: () => interrupted,
    onDone: (settled) => results.push(settled),
  });
  const step = (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      const next = queue.shift();
      if (!next) return;
      frame += 1;
      next();
    }
  };
  return {
    step,
    cancel,
    writes,
    results,
    userScroll: (value: number) => {
      interrupted = true;
      top = value;
    },
    move: (value: number) => {
      top = value;
    },
  };
}

describe("settleScroll", () => {
  test("follows the target as rows are measured, then reports it settled", () => {
    // Estimated sizes put the row at 5,160; once measured it is at 2,300.
    const run = harness([5160, 5160, 2300, 2300, 2300, 2300]);
    run.step(8);
    expect(run.writes).toEqual([5160, 2300]);
    expect(run.results).toEqual([true]);
  });

  test("waits while the target is not known yet", () => {
    const run = harness([null, null, 400, 400, 400, 400]);
    run.step(8);
    expect(run.writes).toEqual([400]);
    expect(run.results).toEqual([true]);
  });

  test("leaves a smooth scroll alone while it moves, then corrects where it stopped", () => {
    const run = harness([1000]);
    run.step(1); // jumps to 1000
    run.move(700); // something animates the container
    run.step(1);
    expect(run.writes).toEqual([1000]);
    run.move(800);
    run.step(1);
    expect(run.writes).toEqual([1000]);
    run.step(1); // stopped at 800, off target
    expect(run.writes).toEqual([1000, 1000]);
  });

  test("stops correcting once the user scrolls away", () => {
    const run = harness([1000, 1000, 1000, 1000, 1000]);
    run.step(1);
    run.userScroll(300);
    run.step(10);
    expect(run.writes).toEqual([1000]);
    expect(run.results).toEqual([false]);
  });

  test("gives up after the frame limit and says so", () => {
    const targets = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 200));
    const run = harness(targets);
    run.step(40);
    expect(run.results).toEqual([false]);
  });

  test("cancelling stops it without reporting", () => {
    const run = harness([500, 500, 500]);
    run.cancel();
    run.step(5);
    expect(run.writes).toEqual([]);
    expect(run.results).toEqual([]);
  });
});
