# Native board view performance — 2026-09-12

## Changes

`SnapshotLookupCache` now lives in TaskifyCore so the native app's cache behavior is covered by
package tests. AppModel calls `invalidate(from:to:)` on every snapshot write. The cache compares
source collections once per write and only clears dependent projections:

| Source change | Invalidated data |
| --- | --- |
| Tasks | Task index, column grouping/custom sorting, Upcoming, Completed |
| Boards | Board lookup/visibility, column grouping/custom sorting, Upcoming/Completed scope |
| Taskify events | Accepted events/IDs, per-board event index, column event slices, Upcoming |
| Contacts | Contact lookup |
| Group conversations | Group lookup and message threads |
| Direct messages | Per-peer messages and message threads |
| Read, mute, archive, or shared-inbox data used by thread projection | Message threads |
| Selected board | No data caches; keys already distinguish boards |

The messaging invalidation dependencies follow `directMessages(with:)` and
`activeDirectMessageThreads()`; task/board writes no longer discard those unrelated results.
This does not remove SwiftUI's snapshot observation: a snapshot write can still cause view
reevaluation, but board reads then reuse unaffected projections.

Upcoming and Completed build their projections from indexed board-scoped inputs, including
compound children. Nonempty and empty results are cached. Views read the resulting arrays once
per body evaluation. Upcoming has a flat, cached sequence of date headers, event rows, and task
rows inside a LazyVStack. Event row identity includes both date and event ID, so multiday events
can appear on multiple dates without collisions. Headers and tasks use distinct identity cases.

Week, list, and compound columns share cached event slices and custom task ordering. Event
slices are indexed by board and column/weekday. Sort keys include completion visibility, column,
mode, and direction. Date-sensitive caches retain only their current time context: Upcoming and
events use local day/calendar, event columns include week start, and tasks preserve their prior
minute granularity for hidden-until visibility while also tracking calendar and week start.
Changing a calendar/timezone/date refreshes those projections on the next read; no polling timer
was added. Rendering and task/event ordering semantics remain owned by the existing organizers.

## Regression coverage

`SnapshotLookupCacheTests` checks:

- Unrelated messaging and selection writes preserve the task index and secondary projections.
- Task completion, movement, compound membership, and event removal invalidate the right results.
- Cached slices/orderings match existing organizers across modes, visibility settings, week starts,
  midnight/week changes, and timezones.
- Flat timeline order and unique identities, including 500 tasks in one date and a repeated event.
- 5,000 additional tasks and 400 events across boards, with 50 messaging updates: task indexing,
  Upcoming grouping, Completed sorting, column-event projection, and custom task sorting each
  build once.

The initial uncached implementation failed the reuse checks (repeated reads built three times,
and a messaging write rebuilt the task index). The fixes passed the targeted tests.

`ScrollPerformanceUITests` adds a fixture with 500 future tasks on one date and 500 completed
tasks, then checks that the last Upcoming card remains unmaterialized, measures scrolling in
both secondary views, and measures switching between board/Upcoming/Completed. It also retains
the existing populated-board horizontal paging test. The large fixture is opt-in through
`TASKIFY_UI_TEST_BOARD_SECONDARY_FIXTURE=1` alongside the existing performance fixture flag.

## Validation

- iOS Simulator app build: passed.
- Targeted package run: 21 tests passed (13 cache/row tests plus 8 existing organizer tests).
- Simulator UI: dense Completed scrolling and existing horizontal paging passed on the first
  run. The two Upcoming-dependent tests initially failed because older fixture tasks sorted
  before their sentinel card. Anchoring the dense fixture at tomorrow's start made ordering
  deterministic; Upcoming lazy-row/scroll and secondary-view switching tests then both passed.
- Broader package run: 669 XCTest tests executed, 9 skipped, 1 failure; 10 Swift Testing tests
  passed. The failure is
  `ShareMessageReconciliationTests.testOldReceiptEvictedByHistoryLimitDoesNotTriggerAnotherRefresh`.
  A separate clean build of unchanged commit `697fa2d7` reproduces that same failure. Two further
  cache regressions (minute rollover and message-cache freshness) were subsequently included in
  the passing 21-test targeted run.
- `git diff --check`: passed.

The UI result bundles are `/tmp/taskify-board-ui-tests.xcresult` (Completed/paging passes and
initial fixture failures) and `/tmp/taskify-board-ui-retest.xcresult` (both corrected Upcoming
checks pass). These runs used a dedicated iPhone 18 Pro simulator on iOS 27.

Simulator metrics are regression baselines, not evidence of physical-device frame-rate or thermal improvements.
Use `TASKIFY_PERF=1` on a device to correlate hitches, snapshot writes, and card body evaluations
while scrolling a populated board with live relay traffic.
