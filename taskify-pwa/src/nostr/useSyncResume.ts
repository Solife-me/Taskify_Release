import { useEffect, useState } from 'react';

/** Reconcile after suspension/reconnection; coalesce overlapping browser events. */
export function useSyncResume(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let lastResume = 0;
    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastResume < 1000) return;
      lastResume = now;
      setEpoch(value => value + 1);
    };
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  return epoch;
}
