// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { whenWindowLoaded } from "./whenWindowLoaded";

test("runs at once when the page has already loaded, as after an async bootstrap", () => {
  const callback = vi.fn();
  whenWindowLoaded(callback, { readyState: "complete" } as Document, window);
  expect(callback).toHaveBeenCalledTimes(1);
});

test("waits for the load event while the page is still loading, and runs once", () => {
  const callback = vi.fn();
  const target = new EventTarget() as Window;
  whenWindowLoaded(callback, { readyState: "interactive" } as Document, target);
  expect(callback).not.toHaveBeenCalled();
  target.dispatchEvent(new Event("load"));
  target.dispatchEvent(new Event("load"));
  expect(callback).toHaveBeenCalledTimes(1);
});
