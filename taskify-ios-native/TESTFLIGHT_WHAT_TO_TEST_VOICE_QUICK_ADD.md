# TestFlight "What to Test" — Voice Quick Add (Build Draft)

This build adds Siri voice quick add for the iOS Taskify app wrapper.

## What to test
- Use Siri/Shortcuts to create a task in Taskify.
- Optional fields:
  - Due date
  - Board name
- Confirm task appears once and in the expected board.

## Suggested scenarios
1. Add task with title only
2. Add task with title + due date
3. Add task with title + board
4. Add task with unknown board (should safely fall back)

## Expected behavior
- Task is created successfully and only once.
- Voice quick add runs only for iOS intent launches.
- Invalid/missing optional values do not crash the app.
