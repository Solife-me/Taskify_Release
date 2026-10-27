/**
 * NIP-51 bot commands list: the wire contract in docs/reference/bot-command-lists.md.
 *
 * A bot (an AI agent with its own Nostr key) publishes a parameterized replaceable kind-30078
 * event advertising the chat commands it accepts. Clients treat the presence of this exact list
 * as the signal that the peer is a bot and offer a "/" command menu. Fetching, publishing and
 * caching stay in each client; parsing and validation live here so every client agrees.
 */
export const BOT_COMMANDS_KIND = 30078;
export const BOT_COMMANDS_D_TAG = "taskify-bot-commands";
export const BOT_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
export const BOT_COMMAND_DESCRIPTION_MAX_LENGTH = 100;
export const BOT_COMMANDS_MAX_COUNT = 100;
function firstTagValue(tags, name) {
    for (const tag of tags) {
        if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string")
            return tag[1];
    }
    return null;
}
function normalizeDescription(value) {
    if (typeof value !== "string")
        return "";
    return value.replace(/[\r\n]+/g, " ").trim().slice(0, BOT_COMMAND_DESCRIPTION_MAX_LENGTH);
}
/**
 * Strict recognition: an event is a bot commands list only when it is kind 30078 with the exact
 * `taskify-bot-commands` d-tag and carries at least one valid `command` tag. Invalid names are
 * skipped, duplicates keep the first, and at most 100 commands are read. Returns null otherwise.
 */
export function parseBotCommands(event) {
    if (!event || typeof event !== "object" || event.kind !== BOT_COMMANDS_KIND)
        return null;
    const tags = Array.isArray(event.tags) ? event.tags : [];
    if (firstTagValue(tags, "d") !== BOT_COMMANDS_D_TAG)
        return null;
    const commands = [];
    const seen = new Set();
    for (const tag of tags) {
        if (!Array.isArray(tag) || tag[0] !== "command")
            continue;
        const name = typeof tag[1] === "string" ? tag[1].trim().toLowerCase() : "";
        if (!BOT_COMMAND_NAME_PATTERN.test(name) || seen.has(name))
            continue;
        seen.add(name);
        commands.push({ name, description: normalizeDescription(tag[2]) });
        if (commands.length >= BOT_COMMANDS_MAX_COUNT)
            break;
    }
    return commands.length ? commands : null;
}
export class BotCommandsValidationError extends Error {
}
/**
 * Validates commands before publishing. Beyond the wire format this enforces the contract's
 * privacy rule: the list holds only command names and short descriptions, never keys or user
 * identifiers.
 */
export function validateBotCommandsDraft(commands) {
    if (!Array.isArray(commands))
        throw new BotCommandsValidationError("Commands must be a JSON array.");
    if (!commands.length)
        throw new BotCommandsValidationError("At least one command is required.");
    if (commands.length > BOT_COMMANDS_MAX_COUNT) {
        throw new BotCommandsValidationError(`At most ${BOT_COMMANDS_MAX_COUNT} commands are allowed.`);
    }
    const seen = new Set();
    return commands.map((raw) => {
        if (!raw || typeof raw !== "object") {
            throw new BotCommandsValidationError("Each command must be an object with name and description.");
        }
        const entry = raw;
        const name = typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
        if (!BOT_COMMAND_NAME_PATTERN.test(name)) {
            throw new BotCommandsValidationError(`Invalid command name '${name || "(missing)"}': use 1-32 lowercase letters, digits, or underscores (no leading slash).`);
        }
        if (seen.has(name))
            throw new BotCommandsValidationError(`Duplicate command name: ${name}`);
        seen.add(name);
        const description = normalizeDescription(entry.description);
        if (!description)
            throw new BotCommandsValidationError(`Command "${name}" needs a short description.`);
        for (const value of [name, description]) {
            if (/nsec1|npub1|hex\.|nprofile1|naddr1/i.test(value)) {
                throw new BotCommandsValidationError(`Command "${name}" contains a Nostr key or identifier — the published list must not contain user data (see docs/reference/bot-command-lists.md).`);
            }
        }
        return { name, description };
    });
}
/** Tags for a bot commands event; `client` is optional and ignored by readers. */
export function buildBotCommandsTags(commands, client) {
    return [
        ["d", BOT_COMMANDS_D_TAG],
        ...commands.map((command) => ["command", command.name, command.description]),
        ["alt", `Taskify bot commands (${commands.length})`],
        ...(client ? [["client", client]] : []),
    ];
}
