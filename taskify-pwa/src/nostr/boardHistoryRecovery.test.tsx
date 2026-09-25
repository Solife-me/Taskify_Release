// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, test, vi } from 'vitest';
import { boardTag } from '../boardCrypto';

const recoverCalls: Array<{ relay: string; since?: number }> = [];
vi.mock('taskify-runtime-nostr', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recoverRelayHistory: vi.fn(async (_session: unknown, filter: { since?: number }, relay: string) => {
    recoverCalls.push({ relay, since: filter.since });
  }),
}));
vi.mock('./NostrSession', () => ({ NostrSession: { init: async () => ({}) } }));
vi.mock('../storage/idbKeyValue', () => ({ idbKeyValue: { setItem: vi.fn() } }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(async () => {
  recoverCalls.length = 0;
  localStorage.clear();
  (await import('./historyWatermarks')).resetHistoryWatermarksCache();
});

async function renderBoardSync(overrides: Record<string, unknown> = {}) {
  const { useBoardSync } = await import('./useBoardSync');
  const board = { id: 'local', nostr: { boardId: 'board-secret', relays: ['wss://a', 'wss://b'] } };
  const base: any = {
    boards: [board], boardsRef: { current: [board] }, tasksRef: { current: [] }, setTasks: () => {},
    pool: { setRelays() {}, subscribe() { return () => {}; } },
    getBoardRelays: () => ['wss://a', 'wss://b'],
    nostrIdxRef: { current: { taskClock: new Map(), boardMeta: new Map(), calendarClock: new Map() } },
    boardSyncCursorsRef: { current: {} }, relayBatchRef: { current: new Map() }, pendingRelaysByBoardRef: { current: new Map() },
    seenBoardTasksRef: { current: new Map() }, pendingNostrTasksRef: { current: new Set() },
    completedNostrInitialSyncRef: { current: new Set() }, setPendingNostrInitialSyncByBoardTag() {},
    markNostrBoardInitialSyncComplete() {}, tagValue: () => 'task',
    applyBoardEvent: async () => {}, applyCalendarEvent: async () => {}, applyTaskEvent: async () => {},
  };
  let props = { ...base, ...overrides };
  function Harness(p: any) { useBoardSync(p); return null; }
  const root = createRoot(document.createElement('div'));
  const render = async (next: Record<string, unknown> = {}) => {
    props = { ...props, ...next };
    await act(async () => root.render(<Harness {...props} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await render();
  return { render, unmount: () => act(async () => root.unmount()) };
}

test('board history is walked fully once, then only from the last complete recovery', async () => {
  const sync = await renderBoardSync();
  try {
    expect(recoverCalls).toEqual([{ relay: 'wss://a', since: undefined }, { relay: 'wss://b', since: undefined }]);
    recoverCalls.length = 0;
    // Any re-run of the sync effect (resume, a callback changing identity) recovers the delta.
    await sync.render({ tagValue: () => 'task' });
    expect(recoverCalls.map((call) => call.relay)).toEqual(['wss://a', 'wss://b']);
    const now = Math.floor(Date.now() / 1000);
    for (const call of recoverCalls) {
      expect(call.since).toBeGreaterThan(now - 400);
      expect(call.since).toBeLessThanOrEqual(now);
    }
  } finally { await sync.unmount(); }
});

test('a requested full resync walks all history again', async () => {
  const sync = await renderBoardSync();
  try {
    recoverCalls.length = 0;
    await sync.render({ fullHistorySyncNonce: 1 });
    expect(recoverCalls).toEqual([{ relay: 'wss://a', since: undefined }, { relay: 'wss://b', since: undefined }]);
  } finally { await sync.unmount(); }
});

test('the watermark is per board', async () => {
  expect(boardTag('board-secret')).toBeTruthy();
  const sync = await renderBoardSync();
  try {
    const { getHistoryWatermark } = await import('./historyWatermarks');
    expect(getHistoryWatermark(`board:${boardTag('board-secret')}:wss://a`)).not.toBeNull();
    expect(getHistoryWatermark(`board:${boardTag('other')}:wss://a`)).toBeNull();
  } finally { await sync.unmount(); }
});
