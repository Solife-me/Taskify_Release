# Taskify Agent Mode

Taskify Agent Mode is enabled by opening the app with `?agent=1`. Browser agents send one strict JSON command object at a time through the Agent Mode panel or through `window.taskifyAgent.exec(...)`.

Once the app loads with `?agent=1`, agent commands are fully available. Agent security controls which tasks are visible and what operations are permitted based on trusted npubs and a configurable security mode.

The dispatcher accepts any positive integer protocol version in `v` (`version` is also accepted as an alias). Compatible commands are routed through the same operation set regardless of version number.

---

## Command Envelope

```json
{
  "v": 1,
  "id": "agent-chosen-id",
  "op": "meta.help",
  "params": {}
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `v` | positive integer | yes | Protocol version. Any positive int accepted. |
| `id` | string | yes | Caller-chosen ID echoed in response. Use for request/response correlation. |
| `op` | string | yes | Operation name (see Op Reference below). |
| `params` | object | yes | Op-specific parameters. Must be an object (not null/array). |

## Response Envelope

```json
{
  "v": 1,
  "id": "agent-chosen-id",
  "ok": true,
  "result": {},
  "error": null
}
```

| Field | Type | Notes |
|---|---|---|
| `v` | integer | Mirrors the request `v`. |
| `id` | string \| null | Mirrors the request `id`. |
| `ok` | boolean | `true` on success, `false` on any error. |
| `result` | object \| null | Op-specific result payload. Null on error. |
| `error` | object \| null | Present only when `ok: false`. Contains `code`, `message`, and optional `details`. |

## Error Codes

| Code | When |
|---|---|
| `PARSE_JSON` | Command string is not valid JSON. |
| `VALIDATION` | Required fields missing or wrong type. |
| `NOT_FOUND` | Task or resource not found. |
| `CONFLICT` | Idempotent create collision with mismatched content. |
| `FORBIDDEN` | Operation blocked by security mode (e.g. `strict` filtering). |
| `INTERNAL` | Unexpected runtime error. |

---

## Op Reference

### `meta.help`

Returns the list of supported ops, their param schemas, and current security configuration.

**Params:** none

```json
{ "v": 1, "id": "h1", "op": "meta.help", "params": {} }
```

**Result shape:**
```json
{
  "ops": ["meta.help", "task.create", "task.update", "task.setStatus",
          "task.list", "task.get", "agent.security.get", "agent.security.set",
          "agent.trust.add", "agent.trust.remove", "agent.trust.list", "agent.trust.clear"],
  "security": { "enabled": true, "mode": "moderate", "trustedNpubs": [] }
}
```

---

### `task.create`

Creates a new task. Idempotency key is strongly recommended for agent callers to prevent duplicate creates on retry.

**Params:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Task title. |
| `note` | string | no | Body/description text. |
| `boardId` | string | no | Target board. Defaults to the current default board. |
| `dueISO` | string | no | ISO 8601 due datetime (e.g. `"2026-03-10T09:00:00.000Z"`). |
| `priority` | 1 \| 2 \| 3 | no | 1 = low, 2 = medium, 3 = high. |
| `idempotencyKey` | string | no | Deduplication key scoped to this client session. Same key + same title = returns cached result without duplicate create. |

```json
{
  "v": 1,
  "id": "create-1",
  "op": "task.create",
  "params": {
    "title": "Review PR",
    "note": "Check test coverage before approving",
    "dueISO": "2026-03-10T09:00:00.000Z",
    "priority": 2,
    "boardId": "board-abc",
    "idempotencyKey": "review-pr-2026-03-10"
  }
}
```

**Result shape:**
```json
{ "task": { "id": "task-xyz", "title": "Review PR", "boardId": "board-abc", ... } }
```

---

### `task.update`

Patches an existing task by ID. Only the fields present in `patch` are changed; omitted fields are left as-is. To clear an optional field, pass `null`.

**Params:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `taskId` | string | yes | ID of the task to update. |
| `patch.title` | string | no | New title. |
| `patch.note` | string | no | New note. |
| `patch.dueISO` | string \| null | no | New due date or `null` to clear. |
| `patch.priority` | 1 \| 2 \| 3 \| null | no | New priority or `null` to clear. |

```json
{
  "v": 1,
  "id": "update-1",
  "op": "task.update",
  "params": {
    "taskId": "task-xyz",
    "patch": {
      "title": "Review PR (updated)",
      "dueISO": null,
      "priority": 3
    }
  }
}
```

**Result shape:**
```json
{ "task": { "id": "task-xyz", "title": "Review PR (updated)", ... } }
```

---

### `task.setStatus`

Marks a task as done or re-opens it.

**Params:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `taskId` | string | yes | ID of the task. |
| `status` | `"done"` \| `"open"` | yes | Target status. |

```json
{
  "v": 1,
  "id": "done-1",
  "op": "task.setStatus",
  "params": {
    "taskId": "task-xyz",
    "status": "done"
  }
}
```

**Result shape:**
```json
{ "task": { "id": "task-xyz", "completed": true, ... } }
```

---

### `task.list`

Returns a filtered, paginated list of tasks. In `strict` security mode, only tasks where `lastEditedBy` is a trusted npub are returned.

**Params:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `boardId` | string | no | Filter to a specific board. |
| `status` | `"open"` \| `"done"` \| `"any"` | no | Default: `"open"`. |
| `query` | string | no | Free-text search against task title and note. |
| `limit` | integer | no | Max results to return. Default: `25`. |
| `cursor` | string | no | Pagination cursor from previous response. |

```json
{
  "v": 1,
  "id": "list-1",
  "op": "task.list",
  "params": {
    "status": "open",
    "limit": 25,
    "boardId": "board-abc",
    "query": "PR"
  }
}
```

**Result shape:**
```json
{
  "tasks": [
    {
      "id": "task-xyz",
      "title": "Review PR",
      "boardId": "board-abc",
      "status": "open",
      "dueISO": "2026-03-10T09:00:00.000Z",
      "priority": 2,
      "provenance": "trusted",
      "trusted": true,
      "agentSafe": true,
      ...
    }
  ],
  "cursor": null,
  "trustCounts": { "trusted": 1, "untrusted": 0, "unknown": 0, "returned": 1 }
}
```

---

### `task.get`

Returns a single task by ID. In `strict` mode, returns `FORBIDDEN` if the task's `lastEditedBy` is not a trusted npub.

**Params:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `taskId` | string | yes | Task ID. |

```json
{
  "v": 1,
  "id": "get-1",
  "op": "task.get",
  "params": { "taskId": "task-xyz" }
}
```

**Result shape:**
```json
{ "task": { "id": "task-xyz", "title": "Review PR", "provenance": "trusted", ... } }
```

---

### `agent.security.get`

Returns the current agent security configuration.

**Params:** none

```json
{ "v": 1, "id": "sec-get-1", "op": "agent.security.get", "params": {} }
```

**Result shape:**
```json
{
  "security": {
    "enabled": true,
    "mode": "moderate",
    "trustedNpubs": ["npub1abc..."],
    "updatedISO": "2026-03-08T12:00:00.000Z"
  }
}
```

---

### `agent.security.set`

Updates the security enabled flag and/or mode. Does not affect the trusted npub list (use `agent.trust.*` ops for that).

**Params:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | no | Enable/disable agent security enforcement. |
| `mode` | `"off"` \| `"moderate"` \| `"strict"` | no | Security mode. |

```json
{
  "v": 1,
  "id": "sec-set-1",
  "op": "agent.security.set",
  "params": { "enabled": true, "mode": "strict" }
}
```

**Result shape:**
```json
{ "security": { "enabled": true, "mode": "strict", "trustedNpubs": [...], "updatedISO": "..." } }
```

---

### `agent.trust.add`

Adds an npub to the trusted npub list. The npub must be a valid bech32 `npub1...` string.

**Params:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `npub` | string | yes | Bech32 npub (e.g. `"npub1abc..."`). |

```json
{
  "v": 1,
  "id": "trust-add-1",
  "op": "agent.trust.add",
  "params": { "npub": "npub1f4t6089m5zhljvrurfuc8ceymlr6yzrdljxz9yaskyj8r8s536ns6rv35g" }
}
```

**Result shape:**
```json
{ "security": { "enabled": true, "mode": "moderate", "trustedNpubs": ["npub1f4t..."], ... } }
```

---

### `agent.trust.remove`

Removes an npub from the trusted npub list. No-ops silently if the npub is not present.

**Params:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `npub` | string | yes | Bech32 npub to remove. |

```json
{
  "v": 1,
  "id": "trust-rm-1",
  "op": "agent.trust.remove",
  "params": { "npub": "npub1f4t6089m5zhljvrurfuc8ceymlr6yzrdljxz9yaskyj8r8s536ns6rv35g" }
}
```

**Result shape:**
```json
{ "security": { "trustedNpubs": [], ... } }
```

---

### `agent.trust.list`

Returns the current trusted npub list.

**Params:** none

```json
{ "v": 1, "id": "trust-list-1", "op": "agent.trust.list", "params": {} }
```

**Result shape:**
```json
{ "trustedNpubs": ["npub1abc...", "npub1def..."] }
```

---

### `agent.trust.clear`

Removes all npubs from the trusted npub list.

**Params:** none

```json
{ "v": 1, "id": "trust-clear-1", "op": "agent.trust.clear", "params": {} }
```

**Result shape:**
```json
{ "security": { "trustedNpubs": [], ... } }
```

---

## Security Mode Matrix

Security mode controls how `task.list` and `task.get` filter results and how trust annotation fields are populated.

| Mode | `task.list` behavior | `task.get` behavior | `agentSafe` field |
|---|---|---|---|
| **`off`** | Returns all tasks (no filtering). Each task annotated with `provenance`, `trusted`, `agentSafe`. | Returns task regardless of `lastEditedBy`. | Always `false` (security disabled). |
| **`moderate`** | Returns all tasks. Each task annotated with trust provenance. | Returns any task. | `true` if `lastEditedBy` is in trusted npub list. |
| **`strict`** | Returns **only** tasks where `lastEditedBy` is a trusted npub. Other tasks are silently omitted. | Returns `FORBIDDEN` if `lastEditedBy` is not trusted. | `true` if `lastEditedBy` is in trusted npub list. |

### Trust Provenance Classification

Each returned task includes a `provenance` field:

| `provenance` | Condition |
|---|---|
| `"trusted"` | `lastEditedBy` is in the `trustedNpubs` list. |
| `"untrusted"` | `lastEditedBy` is set but **not** in `trustedNpubs`. |
| `"unknown"` | Neither `lastEditedBy` nor `createdBy` is set on the task. |

### `trustCounts` (on `task.list` responses)

`task.list` always includes a `trustCounts` summary covering the **full result set** before any strict-mode filtering:

```json
{
  "trusted": 3,
  "untrusted": 1,
  "unknown": 2,
  "returned": 3
}
```

`returned` reflects how many tasks were actually returned after filtering. The other counts are totals across all matched tasks pre-filter.

---

## Idempotency

`task.create` supports an optional `idempotencyKey` string. If the same key is submitted again within the same browser session:

- If the stored result was a success, it is returned immediately without re-creating.
- If the stored result was an error, the command is re-executed.

This is designed to handle network-timeout retry scenarios. Use unique keys scoped to each distinct create attempt.

Idempotency state is stored in IndexedDB and does not survive a page reload.

---

## Task Shape Reference

Full shape of a task returned in agent responses:

```typescript
{
  id: string;                         // UUID
  boardId: string;                    // Board ID
  title: string;
  note: string;                       // Empty string if not set
  status: "open" | "done";
  dueISO: string | null;              // ISO 8601 or null
  priority: 1 | 2 | 3 | null;        // 1=low, 2=medium, 3=high
  updatedISO: string;                 // ISO 8601 last-modified
  createdByNpub: string | null;       // npub of creator
  lastEditedByNpub: string | null;    // npub of last editor
  provenance: "trusted" | "untrusted" | "unknown";
  trusted: boolean;                   // true if provenance === "trusted"
  agentSafe: boolean;                 // alias for trusted
}
```

