import { expect, test } from 'vitest';
import {
  BOARDS_PER_SUBSCRIPTION,
  MAX_CONCURRENT_HISTORY_RECOVERIES_PER_RELAY,
  boardTagForSyncEvent,
  groupBoardsForSubscription,
  withHistoryRecoverySlot,
} from './useBoardSync';

test('boards on the same relays share REQs of up to ten; different relay lists never share', () => {
  const same = Array.from({ length: 25 }, (_, i) => ({ id: `tag-${String(i).padStart(2, '0')}`, relays: 'wss://a,wss://b' }));
  const other = [{ id: 'solo', relays: 'wss://c' }];
  const chunks = groupBoardsForSubscription([...same, ...other]);
  expect(chunks.map((chunk) => chunk.length).sort((a, b) => a - b)).toEqual([1, 5, 10, 10]);
  expect(chunks.every((chunk) => chunk.length <= BOARDS_PER_SUBSCRIPTION)).toBe(true);
  expect(chunks.every((chunk) => new Set(chunk.map((item) => item.relays)).size === 1)).toBe(true);
  expect(chunks.flat().map((item) => item.id).sort()).toEqual([...same, ...other].map((item) => item.id).sort());
});

test('grouping is stable regardless of input order', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, relays: 'wss://a' }));
  const ids = (chunks: typeof items[]) => chunks.map((chunk) => chunk.map((item) => item.id));
  expect(ids(groupBoardsForSubscription(items))).toEqual(ids(groupBoardsForSubscription([...items].reverse())));
});

test('events are routed to their board by b tag, or d tag for board events', () => {
  expect(boardTagForSyncEvent({ kind: 30301, tags: [['d', 'task'], ['b', 'board-1']] })).toBe('board-1');
  expect(boardTagForSyncEvent({ kind: 30300, tags: [['d', 'board-2']] })).toBe('board-2');
  expect(boardTagForSyncEvent({ kind: 30301, tags: [['d', 'orphan']] })).toBeNull();
});

test('history recovery keeps only a few REQs in flight per relay', async () => {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const runs = Array.from({ length: 12 }, () => withHistoryRecoverySlot('wss://limited', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  }));
  const other = withHistoryRecoverySlot('wss://other', async () => 'independent');
  await expect(other).resolves.toBe('independent');
  while (releases.length || active) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases.shift()?.();
  }
  await Promise.all(runs);
  expect(peak).toBe(MAX_CONCURRENT_HISTORY_RECOVERIES_PER_RELAY);
});
