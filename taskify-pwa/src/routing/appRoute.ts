import {
  formatTaskifyWebPath,
  parseTaskifyWebPath,
  type TaskifyLink,
} from "taskify-core";

export type ActivePage =
  | "boards"
  | "upcoming"
  | "wallet"
  | "wallet-bounties"
  | "wallet-move-out"
  | "chat"
  | "settings";

export type AppSheetRoute =
  | "add-board"
  | "share-board"
  | "selection-move"
  | "board-sort"
  | "upcoming-sort"
  | "upcoming-view"
  | "upcoming-filter"
  | "bible-print"
  | "board-print"
  | "bible-scan"
  | "board-scan"
  | "document-preview"
  | "recurring-task-delete"
  | "recurring-event-delete"
  | "shared-task-destination"
  | "shared-task-copy";

export type AppOverlayRoute =
  | { kind: "task"; id: string; boardId?: string }
  | { kind: "event"; id: string; boardId?: string }
  | { kind: "note"; taskId: string; boardId?: string }
  | { kind: "quick-add"; boardId?: string; columnId?: string }
  | { kind: "sheet"; sheet: AppSheetRoute };

type OverlayField = { overlay?: AppOverlayRoute };

export type AppRoute = (
  | { page: "boards"; boardId?: string }
  | { page: "upcoming" }
  | { page: "chat"; conversationId?: string }
  | { page: "settings"; section?: string }
  | { page: "wallet" }
  | { page: "wallet-bounties" }
  | { page: "wallet-move-out" }
) & OverlayField;

const ACTIVE_PAGES = new Set<ActivePage>([
  "boards",
  "upcoming",
  "wallet",
  "wallet-bounties",
  "wallet-move-out",
  "chat",
  "settings",
]);

const SHEET_ROUTES = new Set<AppSheetRoute>([
  "add-board",
  "share-board",
  "selection-move",
  "board-sort",
  "upcoming-sort",
  "upcoming-view",
  "upcoming-filter",
  "bible-print",
  "board-print",
  "bible-scan",
  "board-scan",
  "document-preview",
  "recurring-task-delete",
  "recurring-event-delete",
  "shared-task-destination",
  "shared-task-copy",
]);

function nonEmpty(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function decoded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return nonEmpty(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function urlFrom(raw: string | URL): URL | null {
  try {
    return raw instanceof URL ? raw : new URL(raw, "https://taskify.invalid");
  } catch {
    return null;
  }
}

function routeForSharedLink(link: TaskifyLink): AppRoute {
  switch (link.kind) {
    case "upcoming":
      return { page: "upcoming" };
    case "boards":
      return { page: "boards" };
    case "task":
      return {
        page: "boards",
        ...(nonEmpty(link.boardId) ? { boardId: link.boardId.trim() } : {}),
        overlay: {
          kind: "task",
          id: link.id,
          ...(nonEmpty(link.boardId) ? { boardId: link.boardId.trim() } : {}),
        },
      };
    case "event":
      return {
        page: "boards",
        ...(nonEmpty(link.boardId) ? { boardId: link.boardId.trim() } : {}),
        overlay: {
          kind: "event",
          id: link.id,
          ...(nonEmpty(link.boardId) ? { boardId: link.boardId.trim() } : {}),
        },
      };
    case "quick-add":
      return {
        page: "boards",
        ...(link.boardId ? { boardId: link.boardId } : {}),
        overlay: {
          kind: "quick-add",
          ...(link.boardId ? { boardId: link.boardId } : {}),
          ...(link.columnId ? { columnId: link.columnId } : {}),
        },
      };
  }
}

function parsePageRoute(url: URL): AppRoute | null {
  const parts = url.pathname.split("/").filter(Boolean);
  let route: AppRoute | null = null;

  if (parts.length === 0) {
    route = { page: "boards" };
  } else if (parts[0] === "boards" && parts.length <= 2) {
    const boardId = decoded(parts[1]);
    if (parts.length === 2 && !boardId) return null;
    route = {
      page: "boards",
      ...(boardId ? { boardId } : {}),
    };
  } else if (parts[0] === "upcoming" && parts.length === 1) {
    route = { page: "upcoming" };
  } else if (parts[0] === "chat" && parts.length <= 2) {
    const conversationId = decoded(parts[1]);
    if (parts.length === 2 && !conversationId) return null;
    route = { page: "chat", ...(conversationId ? { conversationId } : {}) };
  } else if (parts[0] === "settings" && parts.length <= 2) {
    const section = decoded(parts[1]);
    if (parts.length === 2 && !section) return null;
    route = { page: "settings", ...(section ? { section } : {}) };
  } else if (parts[0] === "wallet" && parts.length === 1) {
    route = { page: "wallet" };
  } else if (parts[0] === "wallet" && parts[1] === "bounties" && parts.length === 2) {
    route = { page: "wallet-bounties" };
  } else if (parts[0] === "wallet" && parts[1] === "move-out" && parts.length === 2) {
    route = { page: "wallet-move-out" };
  } else if (parts[0] === "wallet" && parts[1] === "address" && parts.length === 2) {
    // The receive address page was retired with the withdraw-only wallet (C6-1).
    route = { page: "wallet" };
  }

  if (!route) return null;

  const legacyReminderId = nonEmpty(url.searchParams.get("task"));
  if (legacyReminderId) {
    if (legacyReminderId.startsWith("event:") && nonEmpty(legacyReminderId.slice("event:".length))) {
      return {
        ...route,
        overlay: { kind: "event", id: legacyReminderId.slice("event:".length).trim() },
      };
    }
    return { ...route, overlay: { kind: "task", id: legacyReminderId } };
  }

  const sheet = nonEmpty(url.searchParams.get("sheet"));
  if (sheet && SHEET_ROUTES.has(sheet as AppSheetRoute)) {
    return { ...route, overlay: { kind: "sheet", sheet: sheet as AppSheetRoute } };
  }
  return route;
}

export function parseAppRoute(raw: string | URL): AppRoute | null {
  const url = urlFrom(raw);
  if (!url) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (["task", "event", "quick-add"].includes(parts[0] ?? "")) {
    const shared = parseTaskifyWebPath(`${url.pathname}${url.search}`);
    return shared ? routeForSharedLink(shared) : null;
  }
  if (parts[0] === "note" && parts.length === 2) {
    const taskId = decoded(parts[1]);
    if (!taskId) return null;
    const boardId = nonEmpty(url.searchParams.get("board"));
    return {
      page: "boards",
      ...(boardId ? { boardId } : {}),
      overlay: {
        kind: "note",
        taskId,
        ...(boardId ? { boardId } : {}),
      },
    };
  }
  return parsePageRoute(url);
}

function formatPage(route: AppRoute): string {
  switch (route.page) {
    case "boards": {
      const path = route.boardId ? `/boards/${encoded(route.boardId)}` : "/boards";
      return path;
    }
    case "upcoming":
      return "/upcoming";
    case "chat":
      return route.conversationId ? `/chat/${encoded(route.conversationId)}` : "/chat";
    case "settings":
      return route.section ? `/settings/${encoded(route.section)}` : "/settings";
    case "wallet":
      return "/wallet";
    case "wallet-bounties":
      return "/wallet/bounties";
    case "wallet-move-out":
      return "/wallet/move-out";
  }
}

export function formatAppRoute(route: AppRoute): string {
  const overlay = route.overlay;
  if (!overlay) return formatPage(route);
  switch (overlay.kind) {
    case "task":
      return formatTaskifyWebPath({
        kind: "task",
        id: overlay.id,
        boardId: overlay.boardId ?? (route.page === "boards" ? route.boardId ?? "" : ""),
      });
    case "event":
      return formatTaskifyWebPath({
        kind: "event",
        id: overlay.id,
        boardId: overlay.boardId ?? (route.page === "boards" ? route.boardId ?? "" : ""),
      });
    case "quick-add":
      return formatTaskifyWebPath({
        kind: "quick-add",
        boardId: overlay.boardId ?? (route.page === "boards" ? route.boardId : undefined),
        columnId: overlay.columnId,
      });
    case "note": {
      const boardId = overlay.boardId ?? (route.page === "boards" ? route.boardId : undefined);
      return `/note/${encoded(overlay.taskId)}${boardId ? `?board=${encoded(boardId)}` : ""}`;
    }
    case "sheet": {
      const page = formatPage(route);
      const separator = page.includes("?") ? "&" : "?";
      return `${page}${separator}sheet=${encoded(overlay.sheet)}`;
    }
  }
}

export function routeForPage(page: ActivePage, boardId?: string): AppRoute {
  switch (page) {
    case "boards":
      return { page, ...(nonEmpty(boardId) ? { boardId: boardId!.trim() } : {}) };
    default:
      return { page };
  }
}

function validOverlay(value: unknown): value is AppOverlayRoute {
  if (!value || typeof value !== "object") return false;
  const overlay = value as Record<string, unknown>;
  switch (overlay.kind) {
    case "task":
    case "event":
      return typeof overlay.id === "string" && Boolean(nonEmpty(overlay.id));
    case "note":
      return typeof overlay.taskId === "string" && Boolean(nonEmpty(overlay.taskId));
    case "quick-add":
      return true;
    case "sheet":
      return typeof overlay.sheet === "string" && SHEET_ROUTES.has(overlay.sheet as AppSheetRoute);
    default:
      return false;
  }
}

export function isAppRoute(value: unknown): value is AppRoute {
  if (!value || typeof value !== "object") return false;
  const route = value as Record<string, unknown>;
  if (typeof route.page !== "string" || !ACTIVE_PAGES.has(route.page as ActivePage)) return false;
  if (route.overlay !== undefined && !validOverlay(route.overlay)) return false;
  if (route.page === "boards" && route.boardId !== undefined && typeof route.boardId !== "string") return false;
  if (route.page === "chat" && route.conversationId !== undefined && typeof route.conversationId !== "string") return false;
  if (route.page === "settings" && route.section !== undefined && typeof route.section !== "string") return false;
  return true;
}

export function routesEqual(left: AppRoute, right: AppRoute): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
