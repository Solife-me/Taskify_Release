import { expect, test, vi } from "vitest";
import { EventEmitter } from "./eventEmitterShim";
import { EventEmitter as ResolvedTseep } from "tseep";

test("the build resolves tseep to this shim", () => {
  expect(ResolvedTseep).toBe(EventEmitter);
});

test("a listener that removes itself during emit does not break later listeners", () => {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  const first = () => {
    calls.push("first");
    emitter.off("connect", first);
  };
  emitter.on("connect", first);
  emitter.on("connect", () => calls.push("second"));
  expect(() => emitter.emit("connect")).not.toThrow();
  emitter.emit("connect");
  expect(calls).toEqual(["first", "second", "second"]);
});

test("once listeners fire once", () => {
  const emitter = new EventEmitter();
  const listener = vi.fn();
  emitter.once("ready", listener);
  emitter.emit("ready", 1);
  emitter.emit("ready", 2);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(1);
});

test("an error event with no listener is dropped, as tseep does", () => {
  const emitter = new EventEmitter();
  expect(emitter.emit("error", new Error("x"))).toBe(false);
});

test("many listeners raise no warning", () => {
  const warn = vi.spyOn((globalThis as any).process, "emitWarning").mockImplementation(() => {});
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const emitter = new EventEmitter();
  for (let i = 0; i < 50; i += 1) emitter.on("notice", () => {});
  expect(warn).not.toHaveBeenCalled();
  expect(consoleWarn).not.toHaveBeenCalled();
  warn.mockRestore();
  consoleWarn.mockRestore();
});
