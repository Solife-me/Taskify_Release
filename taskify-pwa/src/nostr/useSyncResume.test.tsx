// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { useSyncResume } from './useSyncResume';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('foreground and reconnect restart recovery once, with listener cleanup', async () => {
  vi.useFakeTimers();
  let epoch = -1;
  function Harness() { epoch = useSyncResume(); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
  try {
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(epoch).toBe(1);
    await vi.advanceTimersByTimeAsync(1100);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(epoch).toBe(2);
    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(1100);
    window.dispatchEvent(new Event('online'));
    expect(epoch).toBe(2);
  } finally { vi.useRealTimers(); }
});
