import { useEffect, useState } from 'react';

/**
 * How long the page must have been hidden before coming back resyncs. Every resume tears down
 * and reopens subscriptions on every relay, so it should follow a real suspension (the browser
 * throttles or freezes hidden tabs), not a quick tab or window switch.
 */
export const SYNC_RESUME_MIN_HIDDEN_MS = 60_000;

/**
 * Reconcile after suspension or reconnection: when the network comes back, or when the page
 * returns after being hidden long enough to have been suspended. Window focus alone (e.g.
 * switching back from another app while the page stayed visible) does not count.
 */
export function useSyncResume(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let lastResume = 0;
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
    const resume = () => {
      const now = Date.now();
      if (now - lastResume < 1000) return;
      lastResume = now;
      setEpoch(value => value + 1);
    };
    const onOnline = () => {
      if (document.visibilityState === 'hidden') return;
      resume();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt ??= Date.now();
        return;
      }
      const wasHiddenFor = hiddenAt == null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (wasHiddenFor >= SYNC_RESUME_MIN_HIDDEN_MS) resume();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
  return epoch;
}
