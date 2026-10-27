/**
 * A minimal synchronous state container, read in React through `useSyncExternalStore`.
 *
 * Why not `useState` for app data: React may run a `setState` updater later, during render, and
 * runs it twice in StrictMode. Code that published from inside an updater, or read values the
 * updater assigned, behaved differently depending on whether React ran it eagerly. A store
 * applies each update immediately and exactly once, so `set` followed by `get` always sees the
 * result, and side effects can be planned from the state they change.
 */
export type StateUpdater<T> = T | ((prev: T) => T);

export type StateStore<T> = {
  get: () => T;
  /** Applies the update now; listeners run only when the value changes (by reference). */
  set: (update: StateUpdater<T>) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStateStore<T>(initial: T): StateStore<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (update) => {
      const next = typeof update === "function" ? (update as (prev: T) => T)(state) : update;
      if (Object.is(next, state)) return;
      state = next;
      // Copy so a listener that unsubscribes (or subscribes) during notification is safe.
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
