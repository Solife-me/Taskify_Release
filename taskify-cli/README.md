# Taskify CLI

Taskify CLI is the agent-facing client for Taskify. The iOS and PWA apps give humans a visual workspace; this CLI gives AI agents the same Nostr-backed boards, lists, tasks, assignments, and completion workflow through deterministic commands and stable JSON.

Core commands are non-interactive and emit one JSON envelope by default. Add `--human` when a person wants readable tables and prompts.

## Install

Requirements: Node.js 22.12 or newer.

```bash
cd taskify-cli
npm install
npm link
taskify --help
```

## One-time setup

Use the same Nostr identity as the Taskify iOS/PWA account whose boards should be available:

```bash
taskify config set nsec nsec1...
# Or provide the key without storing it:
export TASKIFY_NSEC=nsec1...
```

Then discover the account catalog and verify connectivity:

```bash
taskify sync
taskify context
taskify doctor
```

`sync` reads Taskify's encrypted account backup (kind `30078`, `d=taskify-app-backup`), imports its canonical Nostr board IDs and relay settings, and refreshes board/list metadata. If no backup exists, it also checks the identity's encrypted NIP-17 board-share inbox. It does not import wallet seed material or expose the private key.

If sync connects but reports `"ready": false`, publish account sync once from Taskify PWA and rerun it, receive a Taskify board share, or join a known board directly with `taskify board join <board-id> --name <name>`.

If the account has multiple writable destinations, set a home list once:

```bash
taskify config set default-list "Product Launch" "Agent Queue"
```

## The minimal agent workflow

```bash
# 1. Discover identity, boards, lists, and the current default
taskify context

# 2. Add work at an explicit location
taskify add "Draft release notes" \
  --in "Product Launch/Agent Queue" \
  --assign-me \
  --idempotency-key "release-notes-2026-08-26"

# 3. Find work assigned to this identity
taskify list --in "Product Launch/Agent Queue" --mine

# 4. Finish it using the returned task ID
taskify done <task-id> --in "Product Launch"
```

An agent should begin with `taskify context`, use the returned `Board/List` path, and retain task IDs returned by mutations. It does not need to inspect configuration files or infer board IDs.

## Location model

The hierarchy is:

```text
profile > board > list > task
```

Locations use a single `Board/List` path:

```bash
taskify list --in "Client Work/Needs Review"
taskify add "Check the proposal" --in "Client Work/Needs Review"
```

Names are case-insensitive, while IDs are accepted for exact targeting. Resolution follows a predictable order:

1. Explicit `--in "Board/List"` (or legacy `--board` plus `--column`)
2. The profile's structured default location
3. The only visible writable board, and its only list when unambiguous
4. A structured error containing valid candidates

The CLI never silently picks among multiple boards or lists. Compound boards can aggregate tasks for reads but are read-only destinations; choose one of their child boards when writing.

## Core commands

| Command | Purpose | Useful options |
|---|---|---|
| `context` | Return identity, hierarchy, defaults, board/list paths, and capabilities | `--human` |
| `sync` | Discover the encrypted account catalog and refresh board/list metadata | `--catalog-only`, `--human` |
| `doctor` | Check identity, catalog, default resolution, relays, and queued writes | `--human` |
| `list` | List tasks at a deterministic location | `--in`, `--status open\|done\|any`, `--mine`, `--all`, `--refresh` |
| `add <title>` | Create a task | `--in`, `--due`, `--priority`, `--note`, `--assign-me`, `--assignee`, `--idempotency-key` |
| `show <taskId>` | Fetch one task; scans configured boards if no location is supplied | `--in`, `--human` |
| `search <query>` | Search title/note across boards or within one location | `--in`, `--mine`, `--human` |
| `update <taskId>` | Update fields or move a task | `--in`, `--title`, `--due`, `--priority`, `--note`, `--column` |
| `done <taskId>` | Mark a task complete | `--in`, `--title`, `--due` |
| `reopen <taskId>` | Reopen a task | `--in`, `--title`, `--due` |
| `delete <taskId>` | Delete a task | `--in`, `--force` |

Task creation and updates retain the richer Taskify fields used by the apps, including subtasks, recurrence, reminders, assignees, encrypted attachments, due time/time zone, and hidden-until time. Run `taskify <command> --help` for the complete option list.

## JSON contract

Successful core commands write exactly one JSON object to stdout:

```json
{"version":1,"ok":true,"command":"task.create","data":{"task":{"id":"...","title":"Draft release notes"},"location":{"boardId":"...","boardName":"Product Launch","listId":"...","listName":"Agent Queue"},"idempotentReplay":false},"meta":{"profile":"default"}}
```

Failures use the same envelope and include a stable code:

```json
{"version":1,"ok":false,"command":"task.create","error":{"code":"AMBIGUOUS_LIST","message":"Board \"Product Launch\" has multiple lists; specify Board/List.","details":{"candidates":[{"id":"...","name":"Agent Queue","path":"Product Launch/Agent Queue"}]},"retryable":false}}
```

Common codes include `AMBIGUOUS_BOARD`, `AMBIGUOUS_LIST`, `BOARD_NOT_FOUND`, `LIST_NOT_FOUND`, `READ_ONLY_BOARD`, `VALIDATION_ERROR`, `CONFIG_INVALID`, `NOT_FOUND`, `CONFIRMATION_REQUIRED`, `TEMPORARY_CONNECTIVITY`, and `WRITE_QUEUED`.

Exit codes:

- `0`: command completed
- `1`: deterministic configuration, validation, ambiguity, or not-found failure
- `75`: temporary transport failure; retry is appropriate

Diagnostics are written to stderr only when requested with `--verbose` or when using human output.

## Reliable retries and connectivity

Use `--idempotency-key` whenever an agent might retry task creation. Keys are persisted locally and scoped to the active profile and board. The task ID is reserved before publication, so concurrent retries and retries after a relay timeout converge on the same replaceable task event instead of creating duplicates.

Writes are persisted to `~/.taskify-cli/nostr-outbox.json` before publication. A write succeeds only after at least one target relay acknowledges it. If no relay acknowledges the event, the CLI returns `WRITE_QUEUED` with exit code `75`; the signed event remains in the outbox and is retried on a later connection. `taskify doctor` reports pending writes.

The transport uses the union of account relays and per-board relays, supports authenticated NIP-42 relays, applies relay health/backoff, and closes connections cleanly after each invocation.

## Agent assignment patterns

Assign a task to the active CLI identity:

```bash
taskify add "Review pull request" --in "Engineering/Agent Queue" --assign-me
taskify list --in "Engineering/Agent Queue" --mine
```

Assign another Taskify identity:

```bash
taskify add "Approve copy" --in "Marketing/Review" --assignee npub1...
```

Existing collaboration commands such as `assign`, `unassign`, `share`, task-assignment responses, event invitations, and RSVPs remain available for advanced workflows.

## Human use

Add `--human` globally or to a core command:

```bash
taskify --human context
taskify list --in "Product Launch/Agent Queue" --human
taskify delete <task-id> --in "Product Launch" --human
```

Human mode renders readable output and may ask for confirmation where appropriate. Machine mode never prompts; destructive commands require `--force`.

## Profiles and security

Each profile has its own identity, relay catalog, boards, defaults, idempotency namespace, and trust settings:

```bash
taskify profile list
taskify profile add work
taskify profile use work
taskify --profile work context
```

Configuration is stored in `~/.taskify-cli/config.json`. Writes are atomic; the directory is mode `0700` and files are mode `0600` on POSIX systems. Ordinary reads do not change permissions or rewrite legacy configuration. `taskify config show` recursively redacts private keys and API secrets.

## Advanced and compatibility commands

The broader CLI surface remains available for board administration, calendar events, contacts, shares, inbox triage, import/export, reminders, comments/activity, relay management, and shell completions. The `taskify agent` group is the legacy LLM-assisted natural-language helper; external AI agents should call the root core commands directly because they already provide the deterministic agent interface.

```bash
taskify board --help
taskify event --help
taskify share --help
taskify export --help
taskify completions --shell zsh
```
