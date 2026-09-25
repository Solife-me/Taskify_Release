import { expect, test } from 'vitest';
import { fastingReminderTargetBoard } from './holidayUtils';

const SERIES = 'fasting-reminder';
const week = (id: string, nostrId?: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'week', ...(nostrId ? { nostr: { boardId: nostrId } } : {}), ...extra });

test('reminders follow the shared board that already holds them, not this device\'s week-default', () => {
  const boards = [week('week-default', 'local-random'), week('account-week', 'shared-id')];
  const tasks = [{ boardId: 'account-week', seriesId: SERIES }, { boardId: 'account-week', seriesId: SERIES }];
  expect(fastingReminderTargetBoard(boards, tasks, SERIES)?.id).toBe('account-week');
});

test('devices agree when reminders are split: most reminders, then the lower shared board id', () => {
  const boards = [week('board-a', 'zzz'), week('board-b', 'aaa')];
  const split = [{ boardId: 'board-a', seriesId: SERIES }, { boardId: 'board-b', seriesId: SERIES }];
  expect(fastingReminderTargetBoard(boards, split, SERIES)?.id).toBe('board-b');
  expect(fastingReminderTargetBoard([...boards].reverse(), split, SERIES)?.id).toBe('board-b');
  expect(fastingReminderTargetBoard(boards, [...split, { boardId: 'board-a', seriesId: SERIES }], SERIES)?.id).toBe('board-a');
});

test('with no reminders anywhere, the default week board is used; archived boards never hold them', () => {
  expect(fastingReminderTargetBoard([week('other'), week('week-default')], [], SERIES)?.id).toBe('week-default');
  const archived = [week('week-default'), week('old', 'x', { archived: true })];
  expect(fastingReminderTargetBoard(archived, [{ boardId: 'old', seriesId: SERIES }], SERIES)?.id).toBe('week-default');
});
