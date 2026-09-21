# Bot Command Lists (NIP-51)

Taskify chat supports Telegram-style bot commands. A bot (any automated peer — typically your AI agent running [taskify-cli](../../taskify-cli/README.md) with its own Nostr key) publishes a NIP-51 list advertising the commands it accepts. Taskify clients (PWA and iOS) fetch this list, mark the peer as a bot, and show the commands in a filterable menu when the user types `/` in the composer — exactly like Telegram.

The list itself is the bot signal: there is no separate registration or profile flag. If a peer has published a valid commands list, it is a bot.

## Wire contract

A parameterized replaceable Nostr event:

| Field       | Value |
| ----------- | ----- |
| `kind`      | `30078` |
| `d` tag     | `taskify-bot-commands` (exact match) |
| `pubkey`    | the bot's own key (signs the event) |
| `content`   | empty string — all data lives in tags |
| `created_at`| unix seconds; newest wins (replaceable) |

One tag per command:

```
["command", "<name>", "<description>"]
```

- `name`: **bare, no leading slash**, `^[a-z0-9_]{1,32}$` (1–32 lowercase letters, digits, underscores). The client renders and inserts it as `/name`.
- `description`: one line, ≤ 100 characters (longer values are truncated by readers).
- At most **100** commands; duplicate names are dropped on read (first occurrence wins).
- Include an `alt` tag for display in generic Nostr clients: `["alt", "Taskify bot commands (N)"]`.
- A `client` tag is optional and ignored on read: `["client", "your-bot-name"]`.

### Example event

```json
{
  "kind": 30078,
  "content": "",
  "tags": [
    ["d", "taskify-bot-commands"],
    ["command", "start", "Begin setup and link this chat to your agent"],
    ["command", "help", "Show what I can do"],
    ["command", "new_task", "Create a task: /new_task <title> | <notes>"],
    ["command", "today", "List today's tasks"],
    ["alt", "Taskify bot commands (4)"],
    ["client", "taskify-cli"]
  ]
}
```

## Where to publish

Publish to **both** of these relay sets so every client finds the list:

1. your **NIP-17 inbox relays** (kind 10050 event with `relay` tags) — Taskify fetches a peer's commands from wherever its DMs arrive;
2. the common discovery relays: `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.solife.me`.

## Updating and removing

- **Update**: republish with the same d-tag and a newer `created_at`. Replaceable semantics apply; readers keep the newest event they find.
- **Remove**: publish a kind 5 deletion with `["a", "30078:<your-pubkey>:taskify-bot-commands"]` (and `["e", "<event-id>"]` for the known event).

## Privacy rules (mandatory)

The commands list is a **public** Nostr event. It must contain only command names and short descriptions:

- **Never** include user data: no npubs of other people, no relays belonging to your user, no chat content, no task data, no identifiers tied to a specific human.
- **Never** include secrets of any kind: no nsec, no API keys, no tokens, no passwords.
- Keep `content` empty and descriptions generic ("Create a task: /new_task <title>") rather than personal ("Create a task for Nathan").

## How clients discover the list

When a 1:1 conversation opens, the client:

1. reads its local cache (commands appear instantly, even offline);
2. fetches `{kinds: [30078], authors: <peer>, "#d": ["taskify-bot-commands"]}` from the peer's kind-10050 inbox relays and the discovery relays in the background;
3. recognizes the peer as a bot only if the event is kind 30078, has the exact d-tag, is signed by the peer, and contains at least one valid `command` tag. Any other NIP-51 list (`Chat-Friends`, app backups, etc.) is never mistaken for a commands list.

Typing `/` at the start of the composer then shows the menu, filtered as you type; tapping a command inserts `/name ` into the draft.

The native iOS client revalidates the list whenever the conversation opens or returns to the foreground, even if its persisted cache is fresh. Cached commands stay available while the request runs or if the relays cannot be reached. Passive contact lookups retain a 24-hour cache interval.

## Shortcut: taskify CLI

If your agent runs [taskify-cli](../../taskify-cli/README.md), publishing is one command:

```sh
taskify bot publish-commands commands.json
```

where `commands.json` is:

```json
[
  { "name": "start", "description": "Begin setup and link this chat to your agent" },
  { "name": "help", "description": "Show what I can do" }
]
```

The CLI validates the format (and rejects fields containing keys or identifiers), publishes to your configured relays plus your inbox relays, and prints the event id. Verify with:

```sh
taskify bot show-commands            # your own list
taskify bot show-commands npub1...   # any peer's list
```

## Hand this block to your AI agent

```
TASKIFY BOT COMMANDS LIST — PUBLISH CONTRACT

Publish a signed Nostr event so Taskify chat users can discover your
commands via a Telegram-style "/" menu.

EVENT:
  kind: 30078
  content: "" (must be empty)
  tags:
    ["d", "taskify-bot-commands"]
    ["command", "<name>", "<description>"]   (one per command, see rules)
    ["alt", "Taskify bot commands (<count>)"]
    ["client", "<your-bot-name>"]            (optional)

COMMAND RULES:
  name: 1-32 chars, only [a-z0-9_], NO leading slash (clients add "/").
  description: one line, max 100 chars.
  max 100 commands; unique names.

PRIVACY (mandatory — this event is public):
  Only command names and descriptions. No user data, no npubs of humans,
  no secrets, no keys, no personal identifiers. Keep content empty.

PUBLISH TO:
  - Your NIP-17 inbox relays (the same relays as your kind-10050 event).
  - wss://relay.damus.io, wss://nos.lol, wss://relay.solife.me

UPDATE: republish the same d-tag with a newer created_at (replaceable).
REMOVE: kind 5 deletion with ["a", "30078:<your-pubkey>:taskify-bot-commands"].

EASIEST PATH: if you run taskify-cli, create commands.json (array of
{"name","description"} objects) and run:
  taskify bot publish-commands commands.json

MANUAL PATH (nostr-tools):
  const { finalizeEvent, generateSecretKey, getPublicKey } = require("nostr-tools");
  const sk = <your secret key bytes>;
  const template = {
    kind: 30078,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", "taskify-bot-commands"],
      ["command", "start", "Begin setup"],
      ["alt", "Taskify bot commands (1)"],
    ],
  };
  const signed = finalizeEvent(template, sk);
  // publish `signed` to the relays listed under PUBLISH TO
```
