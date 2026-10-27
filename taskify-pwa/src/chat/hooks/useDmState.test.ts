import { expect, test } from "vitest";
import { isWalletDmAttachment, normalizeCachedContactProfile } from "./useDmState";

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

test("cached profile relays are trimmed before deduplication and empty entries are discarded", () => {
  const cached = normalizeCachedContactProfile({
    updatedAt: 123,
    profile: {
      relays: [" wss://relay.example ", "wss://relay.example", "\twss://second.example\n", " ", 42, null],
    },
  });
  expect(cached?.profile.relays).toEqual(["wss://relay.example", "wss://second.example"]);
  expect(cached?.updatedAt).toBe(123);
});

test("a cached profile containing only empty or non-string relays has no usable data", () => {
  expect(normalizeCachedContactProfile({ profile: { relays: [" ", null, 42] } })).toBeNull();
});
