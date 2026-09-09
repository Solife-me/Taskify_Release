import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey, nip19 } from "nostr-tools";
import { parseBotCommands, parsePubkey, validateBotCommandsDraft } from "../src/shared/botCommands.ts";

test("bot command publication validates and normalizes the draft", () => {
  assert.deepEqual(validateBotCommandsDraft([{ name: " HELP ", description: " Get\nhelp " }]),
    [{ name: "help", description: "Get help" }]);
  for (const input of [[], [{ name: "/help", description: "Help" }],
    [{ name: "help", description: "" }],
    [{ name: "help", description: "One" }, { name: "HELP", description: "Two" }]]) {
    assert.throws(() => validateBotCommandsDraft(input));
  }
});

test("signed bot lists round-trip and unrelated lists are ignored", () => {
  const commands = validateBotCommandsDraft([{ name: "help", description: "Get help" }]);
  const event = finalizeEvent({ kind: 30078, created_at: 1000, content: "",
    tags: [["d", "taskify-bot-commands"], ...commands.map(c => ["command", c.name, c.description])] },
    generateSecretKey());
  assert.deepEqual(parseBotCommands(event), commands);
  assert.equal(parseBotCommands({ ...event, kind: 0 }), null);
  assert.equal(parseBotCommands({ ...event, tags: [["d", "Chat-Friends"]] }), null);
  assert.equal(parsePubkey(nip19.npubEncode(event.pubkey)), event.pubkey);
});
