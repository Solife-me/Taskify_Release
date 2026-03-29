# Taskify iOS Expansion Roadmap (v1)

## P0 — Highest Priority (Start Now)

### 1) Dictate-to-Add Tasks (Siri/App Intents)
**Goal:** user can say “Add <task> to Taskify” and task lands in Inbox/default board.

**Scope (v1):**
- `AddTaskIntent` with title + optional due date
- Siri phrases + Shortcuts support
- Default routing to Inbox board
- Confirmation response + failure handling

**Acceptance:**
- Voice command creates task successfully
- Works from Siri + Shortcuts app
- Unit tests for parsing/routing/error paths

### 2) iOS Performance Baseline + Fixes
**Goal:** reduce cold start + initial sync latency.

**Scope (v1):**
- Add launch/sync timing instrumentation
- Identify top 3 startup bottlenecks
- Implement first-pass optimizations

**Acceptance:**
- Baseline metrics checked in
- Measurable improvement on startup and first data render

### 3) WidgetKit v1 (Quick Add + Today)
**Goal:** capture/view tasks from Home/Lock screen quickly.

**Scope (v1):**
- Small/Medium widgets
- Today + Inbox summaries
- Tap-through deep links

**Acceptance:**
- Widget timeline refreshes reliably
- Deep links open relevant app views

---

## P1 — Next Wave

### 4) Apple Watch Companion v1
- Quick add (voice/tap)
- Today list
- Complete task action

### 5) iMessage Share Extension v1
- Share to Taskify from Messages/Share Sheet
- Convert shared text into prefilled task draft

### 6) Siri v2 Intelligence
- Better natural language parsing
- Board/list disambiguation prompts

---

## P2 — Polish + Expansion

### 7) Interactive Widgets v2
- Complete/reschedule from widget

### 8) Watch v2
- Complications + richer navigation

### 9) Advanced Perf + Reliability
- Background task scheduling polish
- Sync/queue resilience improvements

---

## Execution Order (Recommended)
1. Dictation (P0.1)
2. Performance baseline/fixes (P0.2)
3. Widgets v1 (P0.3)
4. Watch v1 (P1.4)
5. iMessage extension (P1.5)

## Immediate Next Build (Now)
- Implement `AddTaskIntent` + inbox routing
- Add tests first for intent input/routing and failure cases
- Ship internal TestFlight build with voice capture enabled
