import { describe, expect, it } from "vitest";
import { boardSyncRelays, TASKIFY_SYNC_RELAY } from "./relays";

describe("boardSyncRelays", () => {
  it("adds Taskify's relay to a board's own relays, so every device shares one", () => {
    expect(boardSyncRelays(["wss://relay.damus.io", "wss://nos.lol"])).toEqual([
      "wss://relay.damus.io",
      "wss://nos.lol",
      TASKIFY_SYNC_RELAY,
    ]);
  });

  it("leaves a list that already has it, however it's written", () => {
    expect(boardSyncRelays(["wss://Relay.Solife.me/", "wss://nos.lol"])).toEqual(["wss://Relay.Solife.me/", "wss://nos.lol"]);
  });
});
