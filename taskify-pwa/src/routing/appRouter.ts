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

  constructor(private readonly browserWindow: Window) {
    const existing = storedRoute(browserWindow.history.state);
    const parsed = parseAppRoute(browserWindow.location.href);
    this.current = existing?.route ?? parsed ?? { page: "boards" };
    this.entryId = existing?.entryId ?? 1;
    this.parentEntryId = existing?.parentEntryId;
    this.initialRouteWasExplicit = browserWindow.location.pathname !== "/"
      || Boolean(browserWindow.location.search);

    if (!existing) {
      this.write("replace", this.current, this.entryId, undefined, browserWindow.location.href);
    }
  }

  getSnapshot = (): AppRoute => this.current;

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

  openOverlay(overlay: AppOverlayRoute, options?: { replace?: boolean }): void {
    this.navigate({ ...this.current, overlay } as AppRoute, options);
  }

  closeOverlay(): void {
    if (!this.current.overlay) return;
    if (this.parentEntryId !== undefined) {
      this.browserWindow.history.back();
      return;
    }
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
