import { useState, useSyncExternalStore } from "react";
import { getLatestIndexedDbFailure, subscribeToIndexedDbFailures } from "./idbKeyValue";

export function StorageFailureBanner() {
  const failure = useSyncExternalStore(
    subscribeToIndexedDbFailures,
    getLatestIndexedDbFailure,
    getLatestIndexedDbFailure,
  );
  const [dismissedThrough, setDismissedThrough] = useState(0);
  if (!failure || failure.id <= dismissedThrough) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-3 top-3 z-[10001] mx-auto flex max-w-xl items-start gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-950 shadow-xl dark:border-red-800 dark:bg-red-950 dark:text-red-100"
    >
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Taskify could not save local data</div>
        <div className="mt-0.5 opacity-90">
          Your latest edits may be lost. Free device storage or export a backup, then reload Taskify.
        </div>
      </div>
      <button
        type="button"
        className="rounded px-2 py-1 font-medium hover:bg-red-100 dark:hover:bg-red-900"
        onClick={() => setDismissedThrough(failure.id)}
        aria-label="Dismiss storage warning"
      >
        Dismiss
      </button>
    </div>
  );
}
