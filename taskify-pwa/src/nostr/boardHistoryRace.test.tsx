// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { useBoardSync } from './useBoardSync';
import { boardTag } from '../boardCrypto';

vi.mock('./NostrSession', () => ({ NostrSession: { init: () => new Promise(() => {}) } }));
vi.mock('../storage/idbKeyValue', () => ({ idbKeyValue: { setItem: vi.fn() } }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test.each(['relay', 'aggregate', 'timeout'])('%s completion waits for decrypted tasks before flushing history', async mode => {
  vi.useFakeTimers();
  const relay = 'wss://relay.test';
  const tag = boardTag('board-secret');
  const board = { id: 'local', nostr: { boardId: 'board-secret' } };
  const batches = { current: new Map() };
  const pending = { current: new Map() };
  let onEvent: any;
  let onEose: any;
  let finishDecrypt!: () => void;
  const decrypt = new Promise<void>(resolve => { finishDecrypt = resolve; });
  let tasks: any[] = [];
  const complete = vi.fn();
  const props: any = {
    boards: [board], boardsRef: { current: [board] }, tasksRef: { current: [] },
    setTasks: (update: any) => { tasks = update(tasks); },
    pool: { setRelays() {}, subscribe(_r: any, _f: any, event: any, eose: any) { onEvent = event; onEose = eose; return () => {}; } },
    getBoardRelays: () => [relay],
    nostrIdxRef: { current: { taskClock: new Map(), boardMeta: new Map(), calendarClock: new Map() } },
    boardSyncCursorsRef: { current: {} }, relayBatchRef: batches, pendingRelaysByBoardRef: pending,
    seenBoardTasksRef: { current: new Map() }, pendingNostrTasksRef: { current: new Set() },
    completedNostrInitialSyncRef: { current: new Set() }, setPendingNostrInitialSyncByBoardTag() {},
    markNostrBoardInitialSyncComplete: complete, tagValue: () => 'task',
    applyBoardEvent: async () => {}, applyCalendarEvent: async () => {},
    applyTaskEvent: async () => {
      // Event has entered the asynchronous history path before EOSE arrives.
      await decrypt;
      batches.current.set(tag, new Map([[relay, new Map([['local::task', { id: 'task', boardId: 'local', title: 'Recovered', _nostrAt: 100 }]])]]));
    },
  };
  function Harness() { useBoardSync(props); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Harness />));
    // Boards share REQs now, so events reach their board by the b tag every task event carries.
    onEvent({ id: 'event', kind: 30301, created_at: 100, tags: [['d', 'task'], ['b', tag]] }, relay);
    await Promise.resolve();
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(25000);
    else onEose(mode === 'relay' ? relay : undefined);
    expect(complete).not.toHaveBeenCalled();
    finishDecrypt();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(tasks.map(t => t.id)).toEqual(['task']);
    expect(batches.current.has(tag)).toBe(false);
    expect(complete).toHaveBeenCalledWith(tag);
  } finally {
    finishDecrypt();
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
