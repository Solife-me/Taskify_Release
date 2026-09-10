// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { SessionPool } from "../nostr/SessionPool";
import { LS_BOT_COMMANDS_CACHE } from "../localStorageKeys";
import {
  fetchBotCommands, parseBotCommands, loadCachedBotCommands,
  saveCachedBotCommands, shouldRefreshCachedBotCommands,
} from "./botCommands";

function signedCommands(tags = [["command", "HELP", "Help\nme"], ["command", "help", "duplicate"]]) {
  return finalizeEvent({ kind: 30078, created_at: 1000, content: "",
    tags: [["d", "taskify-bot-commands"], ...tags] }, generateSecretKey());
}

describe("bot commands", () => {
  beforeEach(() => window.localStorage.clear());

  it("normalizes commands and ignores unrelated lists", () => {
    const event = signedCommands();
    expect(parseBotCommands(event)).toEqual([{ name: "help", description: "Help me" }]);
    expect(parseBotCommands({ ...event, tags: [["d", "Chat-Friends"]] })).toBeNull();
    expect(parseBotCommands(signedCommands([["command", "/invalid", "bad"]]))).toBeNull();
  });

  it("accepts only a verified list belonging to the requested peer", async () => {
    const event = signedCommands();
    const get = vi.fn().mockResolvedValue(event);
    const pool = { get } as unknown as SessionPool;
    expect((await fetchBotCommands(pool, ["wss://example.com"], event.pubkey)).commands).toHaveLength(1);
    expect((await fetchBotCommands(pool, [], "0".repeat(64))).event).toBeNull();
    // Serialize to remove nostr-tools' cached verification symbol.
    get.mockResolvedValue({ ...JSON.parse(JSON.stringify(event)), content: "tampered" });
    expect((await fetchBotCommands(pool, [], event.pubkey)).event).toBeNull();
  });

  it("reuses cached commands and rejects corrupt command entries", () => {
    const peer = "a".repeat(64);
    const commands = [{ name: "help", description: "Help" }];
    expect(shouldRefreshCachedBotCommands(peer)).toBe(true);
    saveCachedBotCommands(peer, commands);
    expect(loadCachedBotCommands(peer.toUpperCase())).toEqual(commands);
    expect(shouldRefreshCachedBotCommands(peer)).toBe(false);
    window.localStorage.setItem(LS_BOT_COMMANDS_CACHE, JSON.stringify({
      [peer]: { commands: [null], fetchedAt: Date.now() },
    }));
    expect(loadCachedBotCommands(peer)).toBeNull();
  });
});
