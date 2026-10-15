import test from "node:test";
import assert from "node:assert/strict";
import {
  BOT_COMMANDS_D_TAG,
  BOT_COMMANDS_KIND,
  BotCommandsValidationError,
  buildBotCommandsTags,
  buildNip51PrivateItems,
  extractNip51PrivateContacts,
  normalizeNip51PrivateItems,
  parseBotCommands,
  validateBotCommandsDraft,
} from "../dist/index.js";

const PK = "a".repeat(64);

test("bot commands round-trip through the published tags", () => {
  const commands = [{ name: "status", description: "Show status" }, { name: "help", description: "List commands" }];
  const tags = buildBotCommandsTags(commands, "taskify-cli");
  assert.deepEqual(tags[0], ["d", BOT_COMMANDS_D_TAG]);
  assert.deepEqual(tags.at(-2), ["alt", "Taskify bot commands (2)"]);
  assert.deepEqual(tags.at(-1), ["client", "taskify-cli"]);
  assert.deepEqual(parseBotCommands({ kind: BOT_COMMANDS_KIND, tags }), commands);
});

test("bot command parsing is strict about kind, d-tag, names and duplicates", () => {
  const tags = [["d", BOT_COMMANDS_D_TAG], ["command", "Ok", "line\nbreak"], ["command", "/bad"], ["command", "ok", "dup"]];
  assert.deepEqual(parseBotCommands({ kind: BOT_COMMANDS_KIND, tags }), [{ name: "ok", description: "line break" }]);
  assert.equal(parseBotCommands({ kind: 1, tags }), null);
  assert.equal(parseBotCommands({ kind: BOT_COMMANDS_KIND, tags: [["d", "Chat-Friends"], ["command", "ok"]] }), null);
  assert.equal(parseBotCommands({ kind: BOT_COMMANDS_KIND, tags: [["d", BOT_COMMANDS_D_TAG]] }), null);
  assert.equal(parseBotCommands(null), null);
});

test("bot command drafts reject identifiers and missing descriptions", () => {
  assert.throws(() => validateBotCommandsDraft([{ name: "x", description: "send to npub1abc" }]), BotCommandsValidationError);
  assert.throws(() => validateBotCommandsDraft([{ name: "x" }]), /needs a short description/);
  assert.throws(() => validateBotCommandsDraft([{ name: "x", description: "a" }, { name: "X", description: "b" }]), /Duplicate/);
  assert.deepEqual(validateBotCommandsDraft([{ name: " Go ", description: "Run" }]), [{ name: "go", description: "Run" }]);
});

test("NIP-51 items put the petname at index 3 and read the late form earlier PWA builds wrote", () => {
  assert.deepEqual(buildNip51PrivateItems([{ npub: PK, name: "Alice" }]), [["p", PK, "", "Alice"]]);
  assert.deepEqual(buildNip51PrivateItems([{ pubkey: PK, relays: [" wss://r "], displayName: "Al" }, { npub: PK }]), [
    ["p", PK, "wss://r", "Al"],
  ]);
  assert.deepEqual(extractNip51PrivateContacts([["p", PK, "", "", "Alice"], ["e", PK], ["p", "bad"]]), [
    { pubkey: PK, relayHint: undefined, petname: "Alice" },
  ]);
  assert.deepEqual(normalizeNip51PrivateItems([["p", PK, 3], "x"]), [["p", PK, ""]]);
  assert.throws(() => normalizeNip51PrivateItems({}), /Invalid NIP-51/);
});
