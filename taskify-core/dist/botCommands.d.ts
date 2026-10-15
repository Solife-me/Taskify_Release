/**
 * NIP-51 bot commands list: the wire contract in docs/reference/bot-command-lists.md.
 *
 * A bot (an AI agent with its own Nostr key) publishes a parameterized replaceable kind-30078
 * event advertising the chat commands it accepts. Clients treat the presence of this exact list
 * as the signal that the peer is a bot and offer a "/" command menu. Fetching, publishing and
 * caching stay in each client; parsing and validation live here so every client agrees.
 */
export declare const BOT_COMMANDS_KIND = 30078;
export declare const BOT_COMMANDS_D_TAG = "taskify-bot-commands";
export declare const BOT_COMMAND_NAME_PATTERN: RegExp;
export declare const BOT_COMMAND_DESCRIPTION_MAX_LENGTH = 100;
export declare const BOT_COMMANDS_MAX_COUNT = 100;
export type BotCommand = {
    name: string;
    description: string;
};
/** The fields of a Nostr event the parser reads. */
export type BotCommandsEventLike = {
    kind: number;
    tags: unknown[];
};
/**
 * Strict recognition: an event is a bot commands list only when it is kind 30078 with the exact
 * `taskify-bot-commands` d-tag and carries at least one valid `command` tag. Invalid names are
 * skipped, duplicates keep the first, and at most 100 commands are read. Returns null otherwise.
 */
export declare function parseBotCommands(event: BotCommandsEventLike | null | undefined): BotCommand[] | null;
export declare class BotCommandsValidationError extends Error {
}
/**
 * Validates commands before publishing. Beyond the wire format this enforces the contract's
 * privacy rule: the list holds only command names and short descriptions, never keys or user
 * identifiers.
 */
export declare function validateBotCommandsDraft(commands: unknown): BotCommand[];
/** Tags for a bot commands event; `client` is optional and ignored by readers. */
export declare function buildBotCommandsTags(commands: BotCommand[], client?: string): string[][];
