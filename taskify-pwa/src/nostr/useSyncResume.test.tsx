// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useSyncResume } from './useSyncResume';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

async function renderResume() {
  let epoch = -1;
  function Harness() { epoch = useSyncResume(); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
  return { epoch: () => epoch, unmount: () => act(async () => root.unmount()) };
}

async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
}

test('reconnecting resumes sync, once per burst of events', async () => {
  const hook = await renderResume();
  try {
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });
    expect(hook.epoch()).toBe(1);
  } finally { await hook.unmount(); }
});

test('switching back to a window that never hid does not resync', async () => {
  const hook = await renderResume();
  try {
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(hook.epoch()).toBe(0);
  } finally { await hook.unmount(); }
});

test('a brief hide does not resync; returning after a long one does', async () => {
  const hook = await renderResume();
  try {
    await setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(20_000);
    await setVisibility('visible');
    expect(hook.epoch()).toBe(0);

    await setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(61_000);
    await setVisibility('visible');
    expect(hook.epoch()).toBe(1);
  } finally { await hook.unmount(); }
});

test('listeners are removed on unmount', async () => {
  const hook = await renderResume();
  await hook.unmount();
  window.dispatchEvent(new Event('online'));
  expect(hook.epoch()).toBe(0);
});
