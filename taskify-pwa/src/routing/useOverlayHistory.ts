import { useEffect, useRef } from "react";
import type { AppOverlayRoute, AppRoute } from "./appRoute";
import type { AppHistoryRouter } from "./appRouter";

/** What makes two overlays the same one: kind and subject, not incidental fields like boardId. */
export function overlayIdentity(overlay: AppOverlayRoute): string {
  switch (overlay.kind) {
    case "task":
    case "event":
      return `${overlay.kind}:${overlay.id}`;
    case "note":
      return `note:${overlay.taskId}`;
    case "quick-add":
      return "quick-add";
    case "sheet":
      return `sheet:${overlay.sheet}`;
  }
}

/**
 * Binds one piece of overlay UI (an editor, a sheet) to a history entry so the system Back
 * gesture and the browser's Back button close it:
 * - opening it pushes an entry, or adopts the current one when the URL already names it (a link,
 *   or Forward);
 * - closing it in the UI removes its entry (and any opened over it);
 * - leaving its entry by Back, or navigating to another page, calls `close`.
 * Overlays stack: a sheet over an editor leaves the editor open when the sheet is backed out.
 *
 * `overlay` is null while the UI is closed. `close` must close the UI without touching history.
 */
export function useOverlayHistory(
  router: AppHistoryRouter,
  route: AppRoute,
  overlay: AppOverlayRoute | null,
  close: () => void,
): void {
  const entryRef = useRef<number | null>(null);
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  const closeRef = useRef(close);
  closeRef.current = close;
  const identity = overlay ? overlayIdentity(overlay) : null;

  useEffect(() => {
    const current = overlayRef.current;
    if (identity && current) {
      const routed = router.getSnapshot().overlay;
      const routedIdentity = routed ? overlayIdentity(routed) : null;
      if (entryRef.current === null) {
        entryRef.current = routedIdentity === identity ? router.getEntryId() : router.openOverlay(current);
        router.claimEntry(entryRef.current);
      } else if (router.getEntryId() === entryRef.current && routedIdentity !== identity) {
        // Something else opened in the same place (the editor switched tasks): no new entry.
        router.openOverlay(current, { replace: true });
      }
      return;
    }
    if (entryRef.current !== null) {
      const entry = entryRef.current;
      entryRef.current = null;
      router.releaseEntry(entry);
      router.closeOverlayEntry(entry);
    }
  }, [identity, router]);

  useEffect(() => {
    const entry = entryRef.current;
    if (entry === null) return;
    // Read the router, not `route`: an overlay opened earlier in this commit is not in `route` yet.
    if (!router.getSnapshot().overlay || router.getEntryId() < entry) {
      router.releaseEntry(entry);
      entryRef.current = null;
      closeRef.current();
    }
  }, [route, router]);
}

/**
 * Opens what the URL names when no UI is showing it: a link to a task, event or note, or Back
 * and Forward onto such an entry. It waits until the item exists locally (it may still be
 * syncing). Sheets and quick-add cannot be rebuilt from a URL, so their entry is dismissed.
 * Reacts to route changes only, so closing an editor never reopens it while its entry unwinds.
 */
export function useRouteOverlayOpener(
  router: AppHistoryRouter,
  route: AppRoute,
  open: (overlay: AppOverlayRoute) => boolean,
  dataVersion: unknown,
): void {
  const pendingRef = useRef<{ entry: number; overlay: AppOverlayRoute } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const tryOpen = () => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (router.getEntryId() !== pending.entry || router.isEntryClaimed(pending.entry)) {
      pendingRef.current = null;
      return;
    }
    if (pending.overlay.kind === "sheet" || pending.overlay.kind === "quick-add") {
      pendingRef.current = null;
      router.closeOverlay();
      return;
    }
    if (openRef.current(pending.overlay)) pendingRef.current = null;
  };

  useEffect(() => {
    const live = router.getSnapshot().overlay;
    const entry = router.getEntryId();
    pendingRef.current = live && !router.isEntryClaimed(entry) ? { entry, overlay: live } : null;
    tryOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to route changes only
  }, [route, router]);

  useEffect(() => {
    tryOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retried when the awaited data changes
  }, [dataVersion]);
}
