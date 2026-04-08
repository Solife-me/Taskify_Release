import { describe, expect, it } from "vitest";
import { isCardDragEnabled } from "./task/Card";
import { isEventCardDragEnabled } from "./calendar/EventCard";

describe("selection mode board card behavior", () => {
  it("disables task dragging while selection mode is active", () => {
    expect(isCardDragEnabled(true)).toBe(false);
    expect(isCardDragEnabled(false)).toBe(true);
    expect(isCardDragEnabled()).toBe(true);
  });

  it("disables event dragging while selection mode is active", () => {
    expect(isEventCardDragEnabled(true, true)).toBe(false);
    expect(isEventCardDragEnabled(false, true)).toBe(true);
    expect(isEventCardDragEnabled(false, false)).toBe(false);
    expect(isEventCardDragEnabled(true, false)).toBe(false);
  });
});
