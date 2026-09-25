import { describe, expect, it } from "vitest";
import { DEFAULT_NOSTR_RELAYS, relaysOrDefaults } from "./relays";

describe("relaysOrDefaults", () => {
  it("uses the given relays, de-duplicated, without adding the built-in ones", () => {
    expect(relaysOrDefaults(["wss://a.example", " wss://b.example "], ["wss://a.example"])).toEqual([
      "wss://a.example",
      "wss://b.example",
    ]);
  });
  it("falls back to the built-in relays only when nothing is configured", () => {
    expect(relaysOrDefaults([], undefined, ["  "])).toEqual(Array.from(DEFAULT_NOSTR_RELAYS));
  });
});
