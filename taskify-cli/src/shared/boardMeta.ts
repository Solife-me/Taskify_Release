export type BoardMeta = {
  name?: string;
  kind?: string;
  columns?: { id: string; name: string }[];
  children?: string[];
  archived?: boolean;
  hidden?: boolean;
  indexCardEnabled?: boolean;
  clearCompletedDisabled?: boolean;
  hideChildBoardNames?: boolean;
  shareSettings?: Record<string, unknown>;
  sortMode?: "manual" | "due" | "priority" | "created" | "alpha";
  sortDirection?: "asc" | "desc";
};

const SORT_MODES = new Set(["manual", "due", "priority", "created", "alpha"]);

function sortMode(value: unknown): BoardMeta["sortMode"] {
  return typeof value === "string" && SORT_MODES.has(value) ? (value as BoardMeta["sortMode"]) : undefined;
}

function sortDirection(value: unknown): BoardMeta["sortDirection"] {
  return value === "asc" || value === "desc" ? value : undefined;
}

type EventLike = {
  tags?: string[][];
  content?: string;
  created_at?: number;
};

function tagValue(tags: string[][], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const match = tags.find((t) => t[0] === key && typeof t[1] === "string" && t[1].trim().length > 0);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

export function extractBoardMetaFromEventLike(event: EventLike, _boardId: string): BoardMeta {
  const tags = event.tags ?? [];

  const name = tagValue(tags, "name", "title", "n");
  const kind = tagValue(tags, "k");

  const tagColumns = tags
    .filter((t) => t[0] === "col" && t[1] && t[2])
    .map((t) => ({ id: String(t[1]), name: String(t[2]) }));

  const tagChildren = tags.filter((t) => t[0] === "ch" && t[1]).map((t) => String(t[1]));

  let contentName: string | undefined;
  let contentKind: string | undefined;
  let contentColumns: { id: string; name: string }[] = [];
  let contentChildren: string[] = [];
  let archived: boolean | undefined;
  let hidden: boolean | undefined;
  let indexCardEnabled: boolean | undefined;
  let clearCompletedDisabled: boolean | undefined;
  let hideChildBoardNames: boolean | undefined;
  let shareSettings: Record<string, unknown> | undefined;
  const sortTag = tags.find((t) => t[0] === "sort");
  let definedSortMode = sortMode(sortTag?.[1]);
  let definedSortDirection = definedSortMode ? sortDirection(sortTag?.[2]) : undefined;

  if (event.content) {
    try {
      const parsed = JSON.parse(event.content);
      if (typeof parsed?.name === "string" && parsed.name.trim()) contentName = parsed.name.trim();
      if (typeof parsed?.kind === "string" && parsed.kind.trim()) contentKind = parsed.kind.trim();

      if (Array.isArray(parsed?.columns)) {
        contentColumns = parsed.columns
          .filter((c: unknown) => c && typeof c === "object" && "id" in (c as object) && "name" in (c as object))
          .map((c: { id: string; name: string }) => ({ id: String(c.id), name: String(c.name) }));
      }

      if (Array.isArray(parsed?.children)) {
        contentChildren = parsed.children.filter((c: unknown): c is string => typeof c === "string");
      }
      if (typeof parsed?.archived === "boolean") archived = parsed.archived;
      if (typeof parsed?.hidden === "boolean") hidden = parsed.hidden;
      if (typeof parsed?.listIndex === "boolean") indexCardEnabled = parsed.listIndex;
      if (typeof parsed?.clearCompletedDisabled === "boolean") clearCompletedDisabled = parsed.clearCompletedDisabled;
      if (typeof parsed?.hideBoardNames === "boolean") hideChildBoardNames = parsed.hideBoardNames;
      if (parsed?.shareSettings && typeof parsed.shareSettings === "object") {
        shareSettings = parsed.shareSettings as Record<string, unknown>;
      }
      if (!definedSortMode && sortMode(parsed?.sortMode)) {
        definedSortMode = sortMode(parsed.sortMode);
        definedSortDirection = sortDirection(parsed?.sortDirection);
      }
    } catch {
      // content may be encrypted/non-JSON
    }
  }

  const mergedColumns = [...tagColumns];
  for (const cc of contentColumns) {
    if (!mergedColumns.find((m) => m.id === cc.id)) mergedColumns.push(cc);
  }

  const mergedChildren = [...tagChildren];
  for (const child of contentChildren) {
    if (!mergedChildren.includes(child)) mergedChildren.push(child);
  }

  return {
    name: contentName ?? name,
    kind: kind ?? contentKind,
    columns: mergedColumns.length ? mergedColumns : undefined,
    children: mergedChildren.length ? mergedChildren : undefined,
    archived,
    hidden,
    indexCardEnabled,
    clearCompletedDisabled,
    hideChildBoardNames,
    shareSettings,
    sortMode: definedSortMode,
    sortDirection: definedSortDirection,
  };
}

export function pickBestBoardMeta(events: EventLike[], boardId: string): BoardMeta {
  const sorted = [...events].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  for (const event of sorted) {
    const meta = extractBoardMetaFromEventLike(event, boardId);
    if (
      meta.name ||
      meta.kind ||
      (meta.columns?.length ?? 0) > 0 ||
      (meta.children?.length ?? 0) > 0 ||
      meta.archived !== undefined ||
      meta.hidden !== undefined ||
      meta.indexCardEnabled !== undefined ||
      meta.clearCompletedDisabled !== undefined ||
      meta.hideChildBoardNames !== undefined ||
      meta.shareSettings !== undefined ||
      meta.sortMode !== undefined
    ) {
      return meta;
    }
  }
  return {};
}
