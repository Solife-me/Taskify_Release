# Native iOS ↔ PWA Shell Parity Map (Pre-Slice 8)

Purpose: lock UI/interaction parity targets before additional native implementation.

Repo context:
- PWA source of truth: `taskify-pwa/src/App.tsx`
- Native iOS source (active migration workspace): `taskify-ios-native/Sources/TaskifyApp/TaskifyApp.swift`
- Legacy webwrapper app (kept stable during migration): `taskify-ios/`

---

## 1) Global app navigation parity

### PWA behavior (source anchors)
- Bottom app switcher with page-level navigation exists in PWA:
  - `App.tsx` around `app-tab-switcher` and `app-tab-switcher__pill` (~19160+)
- Boards is a first-class page in that switcher.
- Upcoming is a first-class page in that switcher.
- Settings is reachable from primary app flow and treated as a top-level page context.

### Native status
- Implemented shell tabs: `Boards / Upcoming / Settings`.
- This replaced prior `Boards / Home` placeholder.

### Parity assessment
- **Closer to parity** than prior scaffold.
- Still placeholder visuals; not yet style/interaction equivalent.

---

## 2) Boards page entry and board selection parity

### PWA behavior (source anchors)
- Boards page header includes current board selector (pill/select):
  - `App.tsx` board selector area (`value={currentBoardId}`, `onChange={handleBoardSelect}`) (~17840+)
- Selector options come from visible board options; switching board updates whole board content.

### Native status
- Boards page now uses single-pane board flow with a board picker controlling selected board.
- Prior split-view master/detail has been removed.

### Parity assessment
- **Directionally aligned** (board-first, selector-driven).
- Needs fidelity work:
  - header-level placement parity
  - same option filtering semantics (`visibleBoards` equivalent)
  - board switch side-effects parity (sync/loading badges, subview resets)

---

## 3) Boards page content mode parity

### PWA behavior (source anchors)
Boards page has multiple content modes, not just one list:
- `board` mode (primary board columns/tasks)
- `board-upcoming` mode (board-scoped upcoming)
- `completed` mode (board-scoped completed)
Seen in conditional rendering around active board view (~18380+ to ~18660+ and surrounding view toggles near header controls ~17840+).

### Native status
- Native currently renders a single board detail/task pane scaffold.
- No board-local mode toggles yet.

### Parity assessment
- **Gap**: missing board-mode switcher parity (`board` / `board-upcoming` / `completed`).

---

## 4) List/column board layout parity

### PWA behavior (source anchors)
For list-like boards, PWA renders horizontal columns with task cards:
- `listColumns.map(...)` column rendering and per-column inline add forms (~18380+)
- Optional index-card lane (`currentBoard.indexCardEnabled`) (~18380+)
- Add-list lane for list boards (~18380+)

### Native status
- Not yet implemented (current native task pane is simplified).

### Parity assessment
- **Major gap** for true board UX parity.

---

## 5) Header actions parity (board page)

### PWA behavior (source anchors)
Board header includes interaction controls:
- share board action
- completed toggle / clear completed behavior
- board-upcoming toggle
- filter/sort action
All located in board header right controls (~17840+)

### Native status
- Not yet implemented (placeholder-only).

### Parity assessment
- **Gap**: action parity not started.

---

## 6) Drag/drop and quick-add parity

### PWA behavior (source anchors)
- Drag/drop across lists and boards
- quick inline add task per list
- board drop target behavior
Visible in list rendering and drag handlers (~18380+ and header board-drop handlers ~17840+).

### Native status
- Not yet implemented.

### Parity assessment
- **Gap**: high-complexity interaction layer pending.

---

## Decisions locked from this parity pass

1. Do **not** reintroduce split-view as the primary boards UX.
2. Continue with a **board-selector-first** boards page.
3. Slice planning from here must follow PWA board modes and list-column structure before visual polish.

---

## Slice sequence update (post-pass)

### Slice 8 (redefined)
Implement board mode state model parity:
- `board` / `board-upcoming` / `completed`
- deterministic transitions
- tests for mode toggles and empty/loading states per mode

### Slice 9
Implement list-column domain model parity scaffold:
- columns + itemsByColumn mapping
- empty column state + add-list/add-task entry points
- fixture-driven tests for list board and compound board basics

### Slice 10
Implement board header parity controls scaffold:
- completed toggle behavior
- board-upcoming toggle behavior
- filter/sort action entry point
- share-board action entry point

---

## Verification rule going forward

For every new native shell/UI slice:
- include explicit PWA source anchors in PR description
- include parity checklist section: "Matched / Deferred / Not in scope"
- tests must encode behavior, not just render scaffolding
- keep file placement in PWA-style domains (`App/`, `Features/Boards`, `Features/Upcoming`, `Features/Settings`, `Features/Auth`); avoid returning to monolithic app files

## Architecture parity baseline (now enforced)

Active native codebase `taskify-ios-native/Sources/TaskifyApp` is organized as:
- `App/` — entrypoint, root routing, auth orchestration
- `Features/Auth/` — sign-in UI flow
- `Features/Boards/` — board shell, board mode pane, board detail pane
- `Features/Upcoming/` — upcoming page shell
- `Features/Settings/` — settings page shell
- `Legacy/` — temporary webwrapper compatibility components
