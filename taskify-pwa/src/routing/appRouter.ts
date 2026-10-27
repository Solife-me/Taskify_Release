import { useRef, useSyncExternalStore } from "react";
import {
  formatAppRoute,
  isAppRoute,
  parseAppRoute,
  routesEqual,
  type AppOverlayRoute,
  type AppRoute,
} from "./appRoute";

const ROUTER_STATE_KEY = "taskifyRoute";
const ROUTER_STATE_VERSION = 1;

type StoredRoute = {
  version: typeof ROUTER_STATE_VERSION;
  entryId: number;
  parentEntryId?: number;
  route: AppRoute;
};

type RouteState = Record<string, unknown> & {
  [ROUTER_STATE_KEY]?: StoredRoute;
};

function storedRoute(value: unknown): StoredRoute | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as RouteState)[ROUTER_STATE_KEY];
  if (!candidate || candidate.version !== ROUTER_STATE_VERSION) return null;
  if (!Number.isSafeInteger(candidate.entryId) || candidate.entryId < 1) return null;
  if (!isAppRoute(candidate.route)) return null;
  return candidate;
}

function nextState(current: unknown, stored: StoredRoute): RouteState {
  const base = current && typeof current === "object" ? current as Record<string, unknown> : {};
  return { ...base, [ROUTER_STATE_KEY]: stored };
}

export class AppHistoryRouter {
  readonly initialRouteWasExplicit: boolean;

  private current: AppRoute;
  private entryId: number;
  private parentEntryId?: number;
  private listeners = new Set<() => void>();
  private listening = false;
  /** Each history entry this router has seen, and the in-app entry it was pushed from (if any). */
  private entryParents = new Map<number, number | undefined>();
  /** The lowest overlay entry asked to close this tick; closes are coalesced into one step. */
  private pendingClose: number | null = null;
  /** An overlay opened from a link is closed by replacing it with its page once Back reaches it. */
  private replaceOverlayAt: number | null = null;
  /** Overlay entries with UI bound to them (see `useOverlayHistory`). */
  private claimed = new Set<number>();
  /** An overlay that takes the place of closed ones once Back reaches `entry` (see `openOverlay`). */
  private swapAt: { entry: number; overlay: AppOverlayRoute } | null = null;

  constructor(private readonly browserWindow: Window) {
    const existing = storedRoute(browserWindow.history.state);
    const parsed = parseAppRoute(browserWindow.location.href);
    this.current = existing?.route ?? parsed ?? { page: "boards" };
    this.entryId = existing?.entryId ?? 1;
    this.parentEntryId = existing?.parentEntryId;
    this.entryParents.set(this.entryId, this.parentEntryId);
    this.initialRouteWasExplicit = browserWindow.location.pathname !== "/"
      || Boolean(browserWindow.location.search);

    if (!existing) {
      this.write("replace", this.current, this.entryId, undefined, browserWindow.location.href);
    }
  }

  getSnapshot = (): AppRoute => this.current;

  /** The current history entry; entries count up as the user moves forward in the app. */
  getEntryId = (): number => this.entryId;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.listening) {
      this.browserWindow.addEventListener("popstate", this.handlePopState);
      this.listening = true;
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.listening) {
        this.browserWindow.removeEventListener("popstate", this.handlePopState);
        this.listening = false;
      }
    };
  };

  navigate(route: AppRoute, options?: { replace?: boolean }): void {
    const replace = options?.replace === true;
    const nextUrl = formatAppRoute(route);
    const currentUrl = `${this.browserWindow.location.pathname}${this.browserWindow.location.search}`;
    if (routesEqual(route, this.current) && nextUrl === currentUrl) return;

    const nextEntryId = replace ? this.entryId : this.entryId + 1;
    const parentEntryId = route.overlay
      ? (replace ? this.parentEntryId : this.entryId)
      : undefined;
    this.write(replace ? "replace" : "push", route, nextEntryId, parentEntryId, nextUrl);
    this.commit(route, nextEntryId, parentEntryId);
  }

  /** Marks an overlay entry as shown by some UI, so route-driven opening leaves it alone. */
  claimEntry(entryId: number): void {
    this.claimed.add(entryId);
  }

  releaseEntry(entryId: number): void {
    this.claimed.delete(entryId);
  }

  isEntryClaimed(entryId: number): boolean {
    return this.claimed.has(entryId);
  }

  /**
   * Opens an overlay over the current page as a new history entry; returns that entry. When
   * overlays were asked to close in this same tick (one sheet hands over to another), the new
   * overlay takes the place of the lowest closed one instead of stacking on entries that are
   * about to go, so Back from it returns to what was beneath them.
   */
  openOverlay(overlay: AppOverlayRoute, options?: { replace?: boolean }): number {
    const closing = this.pendingClose;
    if (!options?.replace && closing !== null && closing <= this.entryId && this.current.overlay) {
      this.pendingClose = null;
      if (closing === this.entryId) {
        this.navigate({ ...this.current, overlay } as AppRoute, { replace: true });
      } else {
        this.swapAt = { entry: closing, overlay };
        this.browserWindow.history.go(closing - this.entryId);
      }
      return closing;
    }
    this.navigate({ ...this.current, overlay } as AppRoute, options);
    return this.entryId;
  }

  /**
   * Closes the overlay at `entryId` and any opened on top of it. Closes made in the same tick
   * (an editor and the sheet over it) become one history step, so Back never overshoots. An
   * overlay opened from a link has no in-app entry beneath it, so its URL is replaced with its
   * page instead of leaving Taskify.
   */
  closeOverlayEntry(entryId: number): void {
    if (entryId > this.entryId) return;
    this.pendingClose = this.pendingClose === null ? entryId : Math.min(this.pendingClose, entryId);
    queueMicrotask(this.flushClose);
  }

  closeOverlay(): void {
    if (!this.current.overlay) return;
    if (this.parentEntryId !== undefined) {
      this.browserWindow.history.back();
      return;
    }
    this.replaceWithPage();
  }

  private flushClose = (): void => {
    const target = this.pendingClose;
    this.pendingClose = null;
    if (target === null || target > this.entryId || !this.current.overlay) return;
    const pushedFromApp = this.entryParents.get(target) !== undefined;
    const steps = pushedFromApp ? this.entryId - target + 1 : this.entryId - target;
    if (!pushedFromApp) {
      if (steps === 0) {
        this.replaceWithPage();
        return;
      }
      this.replaceOverlayAt = target;
    }
    this.browserWindow.history.go(-steps);
  };

  private replaceWithPage(): void {
    const { overlay: _overlay, ...page } = this.current;
    this.navigate(page as AppRoute, { replace: true });
  }

  private handlePopState = (): void => {
    const existing = storedRoute(this.browserWindow.history.state);
    const route = existing?.route ?? parseAppRoute(this.browserWindow.location.href) ?? { page: "boards" };
    const entryId = existing?.entryId ?? this.entryId + 1;
    const parentEntryId = existing?.parentEntryId;
    if (!existing) {
      this.write("replace", route, entryId, parentEntryId, this.browserWindow.location.href);
    }
    this.commit(route, entryId, parentEntryId);
    if (this.swapAt !== null) {
      const swap = this.swapAt;
      this.swapAt = null;
      if (entryId === swap.entry && this.current.overlay) {
        this.navigate({ ...this.current, overlay: swap.overlay } as AppRoute, { replace: true });
        return;
      }
    }
    if (this.replaceOverlayAt !== null && entryId <= this.replaceOverlayAt) {
      this.replaceOverlayAt = null;
      if (this.current.overlay) this.replaceWithPage();
    }
  };

  private write(
    mode: "push" | "replace",
    route: AppRoute,
    entryId: number,
    parentEntryId: number | undefined,
    url: string,
  ): void {
    const stored: StoredRoute = {
      version: ROUTER_STATE_VERSION,
      entryId,
      ...(parentEntryId !== undefined ? { parentEntryId } : {}),
      route,
    };
    const state = nextState(this.browserWindow.history.state, stored);
    if (mode === "push") this.browserWindow.history.pushState(state, "", url);
    else this.browserWindow.history.replaceState(state, "", url);
  }

  private commit(route: AppRoute, entryId: number, parentEntryId: number | undefined): void {
    this.entryParents.set(entryId, parentEntryId);
    this.current = route;
    this.entryId = entryId;
    this.parentEntryId = parentEntryId;
    this.listeners.forEach((listener) => listener());
  }
}

export function useAppRouter(): { route: AppRoute; router: AppHistoryRouter } {
  const routerRef = useRef<AppHistoryRouter | null>(null);
  if (!routerRef.current) routerRef.current = new AppHistoryRouter(window);
  const router = routerRef.current;
  const route = useSyncExternalStore(router.subscribe, router.getSnapshot, router.getSnapshot);
  return { route, router };
}
