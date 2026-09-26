// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { useBoardSync } from './useBoardSync';
import { boardTag } from '../boardCrypto';

vi.mock('./NostrSession', () => ({ NostrSession: { init: () => new Promise(() => {}) } }));
vi.mock('../storage/idbKeyValue', () => ({ idbKeyValue: { setItem: vi.fn() } }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// After a board's initial sync, tasks this device holds but the relays did not return are
// re-requested by id. Those verify events must reach applyTaskEvent while the board is still
// subscribed, and be ignored once it is torn down.
async function renderAndStartVerify(extraTasks: any[] = []) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  const relay = 'wss://relay.test';
  const tag = boardTag('board-secret');
  const board = { id: 'local', nostr: { boardId: 'board-secret' } };
  const subscriptions: Array<{ filters: any[]; onEvent: any; onEose: any }> = [];
  const applyTaskEvent = vi.fn(async () => {});
  const oldTask = { id: 'missing-task', boardId: 'local', title: 'Old', _nostrAt: Math.floor(Date.now() / 1000) - 3600 };
  const props: any = {
    boards: [board], boardsRef: { current: [board] }, tasksRef: { current: [oldTask, ...extraTasks] },
    setTasks: () => {},
    pool: { setRelays() {}, subscribe(_r: any, filters: any[], onEvent: any, onEose: any) { subscriptions.push({ filters, onEvent, onEose }); return () => {}; } },
    getBoardRelays: () => [relay],
    nostrIdxRef: { current: { taskClock: new Map(), boardMeta: new Map(), calendarClock: new Map() } },
    boardSyncCursorsRef: { current: {} }, relayBatchRef: { current: new Map() }, pendingRelaysByBoardRef: { current: new Map() },
    seenBoardTasksRef: { current: new Map() }, pendingNostrTasksRef: { current: new Set() },
    completedNostrInitialSyncRef: { current: new Set() }, setPendingNostrInitialSyncByBoardTag() {},
    markNostrBoardInitialSyncComplete: vi.fn(), tagValue: () => 'task',
    applyBoardEvent: async () => {}, applyCalendarEvent: async () => {}, applyTaskEvent,
  };
  function Harness() { useBoardSync(props); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
  subscriptions[0].onEose(relay);
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  const verify = subscriptions.find((sub) => sub.filters[0]?.['#d']?.includes('missing-task'));
  const verifies = subscriptions.filter((sub) => sub.filters[0]?.['#d']);
  return { root, verify, verifies, applyTaskEvent, tag, relay };
}

test('a verify event for a task missing from the initial sync is applied', async () => {
  const { root, verify, applyTaskEvent, relay } = await renderAndStartVerify();
  try {
    expect(verify).toBeDefined();
    expect(() => verify!.onEvent({ id: 'ev', kind: 30301, created_at: 1 }, relay)).not.toThrow();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(applyTaskEvent).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

test('a verify event arriving after the board unsubscribes is ignored', async () => {
  const { root, verify, applyTaskEvent, relay } = await renderAndStartVerify();
  try {
    await act(async () => root.unmount());
    expect(() => verify!.onEvent({ id: 'late', kind: 30301, created_at: 1 }, relay)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(applyTaskEvent).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('only open tasks are verified, a hundred ids per request', async () => {
  const at = Math.floor(new Date('2026-09-24T12:00:00Z').getTime() / 1000) - 3600;
  const open = Array.from({ length: 150 }, (_, i) => ({ id: `open-${i}`, boardId: 'local', title: 'Open', _nostrAt: at }));
  const done = { id: 'done-task', boardId: 'local', title: 'Done', completed: true, _nostrAt: at };
  const { root, verifies } = await renderAndStartVerify([...open, done]);
  try {
    const ids = verifies.flatMap((sub) => sub.filters[0]['#d'] as string[]);
    expect(verifies.length).toBe(2);
    expect(verifies.every((sub) => sub.filters[0]['#d'].length <= 100)).toBe(true);
    expect(ids).toHaveLength(151);
    expect(ids).not.toContain('done-task');
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
