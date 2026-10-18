import { expect, test } from "vitest";
import { isWalletDmAttachment } from "./useDmState";

test.each([
  "board",
  "contact",
  "task",
  "event",
  "payment",
  "file",
  "text",
])("accepts the %s attachment type", (type) => {
  expect(isWalletDmAttachment({ type })).toBe(true);
});

test("rejects malformed attachment types", () => {
  expect(isWalletDmAttachment({ type: "nonsense" })).toBe(false);
  expect(isWalletDmAttachment(null)).toBe(false);
  expect(isWalletDmAttachment(42)).toBe(false);
});
