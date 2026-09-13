# CLI ↔ Core Integration Plan (runtime-nostr slice1)

## Scope and boundaries

- **CLI owns:** command parsing, prompts, profile/config loading, stdout/stderr rendering, exit codes.
- **Core owns:** shared contracts, payload normalization, board/contact/event/task mutation semantics, backup schema transforms.
- **Runtime (`taskify-runtime-nostr`) owns:** Nostr transport/session/publish/subscribe and relay mechanics.

## Command matrix

| Domain command | CLI surface status | Core/runtime integration status | Notes |
|---|---|---|---|
| `task` (list/show/add/update/done/reopen/delete/subtask/remind/search/assign/unassign) | Present | Uses runtime; normalization/contracts in core for task/event payloads | Keep CLI output/table logic local |
| `event` (list/add/show/update/delete) | Present | Uses runtime + core calendar payload/mutation normalization | CRUD path already core-backed |
| `board` (list/join/sync/leave/columns/children/create) | Present | Uses runtime + core board contract helpers | This slice unifies board id/name resolution via core |
| `contact` | Not present in current CLI | N/A in this slice | Core contact contracts remain reusable for future command surface |
| `comment` | No direct command; used via agent/activity flows | Core-backed (`createCommentEntry`) | Covered by contract tests |
| `activity` | No direct command; used via agent/activity flows | Core-backed (`createActivityEntry`) | Covered by contract tests |
| `backup` (`export`/`import` task-file workflows) | Present as task data import/export | Partially core-backed; backup schema transforms in core package | Current CLI import/export remains CLI-format specific |

## Slice checklist

### Slice A — Plan + baseline validation
- [x] Create this plan doc and map command boundaries.
- [x] Run baseline validations across core/runtime/cli/pwa.
- [x] Record blockers (runtime local dependency resolution).

### Slice B — Board contract rewiring (core-first)
- [x] Add `resolveBoardReference` to `taskify-core` board contracts.
- [x] Add/adjust core tests for id/name board reference resolution.
- [x] Rewire CLI board resolution call-sites to use core helper.
- [x] Rewire runtime board resolver to use the same core helper.

### Slice C — Validation + release hygiene
- [ ] Run full validation suite after rewiring.
- [ ] Commit incremental slice commits.
- [ ] Push `feat/runtime-nostr-slice1` to `ink`.
- [ ] Update PR notes with summary.

## Risk notes

- Runtime package may fail typecheck/tests if local peer deps are not installed in its workspace.
- Task import/export formats are CLI-facing and intentionally remain local unless backup schema migration is explicitly requested.