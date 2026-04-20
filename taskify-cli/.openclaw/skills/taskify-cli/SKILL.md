---
name: taskify-cli
description: Manage tasks, boards, and calendar events via the Taskify CLI (`taskify` command). Use when: (1) listing, searching, creating, updating, or deleting tasks, (2) marking tasks done or reopening them, (3) managing boards and columns, (4) assigning tasks to users, (5) checking upcoming or overdue tasks, (6) exporting or importing tasks, (7) triage or AI-powered task creation. Taskify stores tasks on Nostr relays — the CLI is the primary interface for agents working with Taskify data.
---

# Taskify CLI

`taskify` manages tasks and boards stored on Nostr relays. Tasks are identified by 8-char prefix or full UUID.

## Installation

Requires **Node.js 22+**.

**Package:** [`taskify-nostr`](https://www.npmjs.com/package/taskify-nostr)  
**Source:** [github.com/Solife-me/Taskify_Release](https://github.com/Solife-me/Taskify_Release)  
**Maintainer:** Ink-North ([@Ink-North](https://github.com/Ink-North))

```bash
npm install -g taskify-nostr
```

Verify the install:

```bash
taskify --version
```

If the global install fails due to permissions, use a local prefix:

```bash
npm install --prefix ~/.local -g taskify-nostr
# add ~/.local/bin to PATH if not already there
```

> Before installing, verify the package on [npmjs.com/package/taskify-nostr](https://www.npmjs.com/package/taskify-nostr) and review the source at the GitHub link above. Prefer user-local install (`--prefix ~/.local`) over global on shared systems.

### First-time setup

Run the onboarding wizard — it generates or imports a Nostr keypair and stores it securely in the local CLI config:

```bash
taskify setup
```

Join a board by its UUID:

```bash
taskify board join <board-uuid> --name "My Board"
```

> **Private key handling:** The CLI manages your Nostr private key internally via `taskify setup`. This skill does not instruct agents to read, expose, or handle private keys. Do not supply private keys via environment variables on shared or multi-user systems.

## Profile Defaults (per-profile home board + list)

Each profile stores its own defaults (no cross-agent interference):

```bash
# Set home board (where new tasks go by default)
taskify board default <boardNameOrId>
taskify board default <boardNameOrId> --clear

# Set home list (column on the board where new tasks go by default)
taskify board column-default <boardNameOrId> <columnIdOrName>

# Set both at once via config
taskify config set default-list <board> <list>

# View all defaults
taskify board defaults --json
```

When `defaultList` is set, agents can use simplified commands without `--board`/`--column`:

```bash
taskify add "Task title"    # → goes to profile's default board + default list
taskify list                 # → shows only the default list
```

> **Multi-agent safety:** Defaults are stored **per-profile** in `~/.taskify-cli/config.json` under `profiles.<name>.defaultList`. Each agent's profile is isolated — no cross-contamination.

## Quick reference

```
taskify list [--a|--all] [--board <name|id>] [--status open|done|any] [--column <name>] [--json]
taskify add <title> [--board <name>] [--due YYYY-MM-DD] [--priority 1|2|3] [--note <text>] [--column <name>]
taskify show <taskId> [--board <name>] [--json]
taskify update <taskId> --board <name> [--title <t>] [--due <d>] [--priority <p>] [--note <n>] [--column <name>]
taskify done <taskId> [--board <name>]
taskify reopen <taskId> [--board <name>]
taskify delete <taskId> --board <name>
taskify search <query> [--board <name>]
taskify upcoming [--days <n>] [--board <name>]
taskify board list
taskify board columns [<board>]
taskify board overview [<board>]             # NEW: per-column task counts
taskify board overview --json [<board>]       # NEW: JSON output
taskify config set default-list <board> <list>  # NEW: set home list per profile
taskify agent add <natural-language description>   # forwards text to configured AI backend
```

## Key behaviours

- **taskId**: accepts 8-char prefix or full UUID.
- **`--board` flag**: required for `add`, `delete`, `update` when multiple boards exist. Optional for `list`, `done`, `show` (scans all if omitted).
- **`-a` / `--all` flag** on `list`: show ALL columns on the board (default: only the profile's default list).
- **Incremental sync**: `list` always fetches relay events since the last cursor before returning. Pass `--refresh` to force a full 30-day re-fetch.
- **`--json` flag**: available on `list`, `show`, `add`, `update` — output machine-readable JSON.
- **Priority**: 1 = low, 2 = medium, 3 = high.

## Board overview

The `board overview` command shows per-column task counts without loading task details:

```bash
# Non-JSON (table format)
taskify board overview                       # uses profile's default board
taskify board overview Openclaw              # specific board (name or ID)

# JSON output (machine-parseable)
taskify board overview --json
taskify board overview Openclaw --json
```

Non-JSON output:
```
Board: Openclaw
  Open                    2 open    2 total
  To Review               0 open    1 total
  Backlog                 3 open    3 total
```

JSON output:
```json
{
  "boardName": "Openclaw",
  "overview": {
    "Open": { "open": 2, "total": 2 },
    "To Review": { "open": 0, "total": 1 },
    "Backlog": { "open": 3, "total": 3 }
  }
}
```

## Reading tasks (new behavior)

When profile has `defaultList` set:

```bash
taskify list               # shows only default list (auto-resolved to board+column)
taskify list -a            # shows entire board (all columns)
taskify upcam  --days 7    # due within 7 days on default board
```

When no default list is set, `taskify list` shows an interactive column selector (numbered columns with counts).

To see all agents' tasks on a shared board:

```bash
taskify list -a --board "Openclaw"
```

### Reading tasks (overriding defaults)

```bash
taskify list --board "Personal"        # override default board
taskify list --column "Done"           # override default column
taskify list --board "Openclaw" -a     # all columns on Openclaw
taskify list --status done             # completed tasks
taskify upcoming --days 7              # due within 7 days
taskify search "keyword"               # full-text search
taskify show abc12345 --json           # full task details
```

## Common agent workflows

### Creating tasks

```bash
# Auto-resolves to profile's default board + default list
taskify add "Write release notes"

# Override defaults
taskify add "Write release notes" --board "Work" --due 2026-03-20 --priority 2
taskify add "Task title" --board "Openclaw" --column "Backlog" --priority 3
taskify agent add "high priority bug fix due Friday"   # AI-parsed (sends text to AI backend)
```

### Updating tasks

```bash
taskify update abc12345 --board "Work" --due 2026-03-25 --priority 3
taskify update abc12345 --board "Work" --column "In Progress"
taskify done abc12345
taskify reopen abc12345
```

### Board management

```bash
taskify board list                            # show configured boards and IDs
taskify board columns                         # show all columns
taskify board overview                        # NEW: per-column task counts
taskify board column-add "Work" "Review"
taskify board column-rename "Work" "Review" "QA"
taskify board sync                            # fetch latest board metadata from Nostr
```

### Assigning tasks

```bash
taskify assign abc12345 npub1...              # assign to npub (public key — not a secret)
taskify unassign abc12345 npub1...
```

## Output parsing

Use `--json` whenever the output will be parsed programmatically:

```bash
taskify list --json | jq '.[] | {id, title, due: .dueISO, priority}'
taskify show abc12345 --json | jq '{title, note, column}'
taskify board overview --json | jq '.overview'
```

## Diagnostics

```bash
taskify board list         # boards with IDs
taskify relay status       # check relay connectivity
taskify cache clear        # wipe local cache (forces cold re-fetch on next list)
taskify board defaults --json  # verify your profile's default board+list
```

## Reference

- Full command flags: see [references/commands.md](references/commands.md)
- Board and column operations: see [references/boards.md](references/boards.md)
