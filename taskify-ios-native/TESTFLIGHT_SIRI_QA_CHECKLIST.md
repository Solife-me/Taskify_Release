# TestFlight Siri QA Checklist (Taskify iOS Voice Quick Add)

## Scope
Validate iOS-intent-gated voice task creation for Taskify webwrapped app.

## Preconditions
- Internal TestFlight build installed
- Siri enabled on test device
- Taskify account signed in
- At least one active board exists

## Primary Voice Flows
1. "Hey Siri, add task in Taskify"
   - Enter title when prompted
   - Expected: Task is created in default board

2. "Hey Siri, add to Taskify" with due date
   - Provide title + due date in Shortcut/Siri dialog
   - Expected: Task created with due date set

3. Board routing
   - Provide Board parameter (e.g. `Work`)
   - Expected: Task lands in exact board title/id match
   - Fallback expected: week-default, then first active board

## Validation Checks
- Task appears exactly once (no duplicate creation)
- Success toast appears in app
- URL query parameters are removed after processing
- Non-iOS launches do not auto-create tasks

## Negative Cases
- Empty title
  - Expected: no task created, user receives error toast

- Unknown board name
  - Expected: fallback board routing; task still created

- Invalid due date payload
  - Expected: task created without due date, no crash

## Regression Checks
- Manual in-app task creation unchanged
- Existing sync behavior unchanged
- App startup unaffected when no quick-add params

## Release Notes Snippet
Added Siri voice quick add for Taskify iOS wrapper. Users can create tasks by voice, optionally set due date and board, with processing gated to `source=ios-intent` launches.
