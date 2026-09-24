import { describe, expect, it } from "vitest";
import { EventTimestampClock } from "./eventTimestamps";

describe("EventTimestampClock", () => {
  const now = 1_790_000_000;
  const task = (d: string) => ({ kind: 30301, tags: [["d", d]] });

  it("does not push unrelated events ahead of real time during a burst", () => {
    const clock = new EventTimestampClock();
    const stamps = Array.from({ length: 200 }, (_, i) => clock.next("signer", task(`t${i}`), now, now));
    expect(Math.max(...stamps)).toBe(now);
  });

  it("keeps successive versions of one address strictly increasing", () => {
    const clock = new EventTimestampClock();
    expect(clock.next("signer", task("a"), now, now)).toBe(now);
    expect(clock.next("signer", task("a"), now, now)).toBe(now + 1);
    expect(clock.next("signer", task("b"), now, now)).toBe(now);
    expect(clock.next("other", task("a"), now, now)).toBe(now);
  });

  it("never runs more than a minute ahead of the clock", () => {
    const clock = new EventTimestampClock();
    let last = 0;
    for (let i = 0; i < 500; i += 1) last = clock.next("signer", task("a"), now, now);
    expect(last).toBe(now + 60);
    // A requested future time is clamped too.
    expect(clock.next("signer", task("z"), now + 3600, now)).toBe(now + 60);
  });

  it("leaves non-replaceable events at their requested time", () => {
    const clock = new EventTimestampClock();
    expect(clock.next("signer", { kind: 1, tags: [] }, now, now)).toBe(now);
    expect(clock.next("signer", { kind: 1, tags: [] }, now, now)).toBe(now);
  });
});
