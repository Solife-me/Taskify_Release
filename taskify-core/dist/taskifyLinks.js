export const TASKIFY_LINK_SCHEME = "taskify";
function trimmed(value) {
    if (value === null)
        return null;
    const normalized = value.trim();
    return normalized || null;
}
function queryValue(url, name) {
    return trimmed(url.searchParams.get(name));
}
function encoded(value) {
    return encodeURIComponent(value);
}
function query(entries) {
    const fields = entries
        .filter((entry) => entry[1] !== undefined)
        .map(([name, value]) => `${encoded(name)}=${encoded(value)}`);
    return fields.length ? `?${fields.join("&")}` : "";
}
/** Formats the custom-scheme URL used by Taskify widgets and native app entry points. */
export function formatTaskifyAppLink(link) {
    switch (link.kind) {
        case "upcoming":
            return `${TASKIFY_LINK_SCHEME}://upcoming`;
        case "boards":
            return `${TASKIFY_LINK_SCHEME}://boards`;
        case "task":
            return `${TASKIFY_LINK_SCHEME}://task${query([
                ["id", link.id],
                ["board", link.boardId],
            ])}`;
        case "event":
            return `${TASKIFY_LINK_SCHEME}://event${query([
                ["id", link.id],
                ["board", link.boardId],
            ])}`;
        case "quick-add":
            return `${TASKIFY_LINK_SCHEME}://quick-add${query([
                ["board", trimmed(link.boardId ?? null) ?? undefined],
                ["column", trimmed(link.columnId ?? null) ?? undefined],
            ])}`;
    }
}
/** Parses the custom-scheme URL used by every Taskify client. */
export function parseTaskifyAppLink(raw) {
    let url;
    try {
        url = raw instanceof URL ? raw : new URL(raw);
    }
    catch {
        return null;
    }
    if (url.protocol.toLowerCase() !== `${TASKIFY_LINK_SCHEME}:`)
        return null;
    switch (url.hostname.toLowerCase()) {
        case "upcoming":
            return { kind: "upcoming" };
        case "boards":
            return { kind: "boards" };
        case "task": {
            const id = queryValue(url, "id");
            if (!id)
                return null;
            return { kind: "task", id, boardId: queryValue(url, "board") ?? "" };
        }
        case "event": {
            const id = queryValue(url, "id");
            if (!id)
                return null;
            return { kind: "event", id, boardId: queryValue(url, "board") ?? "" };
        }
        case "quick-add": {
            const boardId = queryValue(url, "board");
            const columnId = queryValue(url, "column");
            return {
                kind: "quick-add",
                ...(boardId ? { boardId } : {}),
                ...(columnId ? { columnId } : {}),
            };
        }
        default:
            return null;
    }
}
/**
 * Formats the equivalent path for the PWA and future Universal Links. Entity links are top-level
 * because their optional board is context, not identity; a client can still locate an item when
 * the sender does not know its board.
 */
export function formatTaskifyWebPath(link) {
    switch (link.kind) {
        case "upcoming":
            return "/upcoming";
        case "boards":
            return "/boards";
        case "task":
            return `/task/${encoded(link.id)}${query([["board", trimmed(link.boardId) ?? undefined]])}`;
        case "event":
            return `/event/${encoded(link.id)}${query([["board", trimmed(link.boardId) ?? undefined]])}`;
        case "quick-add":
            return `/quick-add${query([
                ["board", trimmed(link.boardId ?? null) ?? undefined],
                ["column", trimmed(link.columnId ?? null) ?? undefined],
            ])}`;
    }
}
/** Parses a Taskify web path. The origin is deliberately irrelevant so local and hosted PWAs agree. */
export function parseTaskifyWebPath(raw) {
    let url;
    try {
        url = raw instanceof URL ? raw : new URL(raw, "https://taskify.invalid");
    }
    catch {
        return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && parts[0] === "upcoming")
        return { kind: "upcoming" };
    if (parts.length === 1 && parts[0] === "boards")
        return { kind: "boards" };
    if (parts.length === 1 && parts[0] === "quick-add") {
        const boardId = queryValue(url, "board");
        const columnId = queryValue(url, "column");
        return {
            kind: "quick-add",
            ...(boardId ? { boardId } : {}),
            ...(columnId ? { columnId } : {}),
        };
    }
    if (parts.length !== 2)
        return null;
    if (parts[0] !== "task" && parts[0] !== "event")
        return null;
    let id;
    try {
        id = decodeURIComponent(parts[1]).trim();
    }
    catch {
        return null;
    }
    if (!id)
        return null;
    return {
        kind: parts[0],
        id,
        boardId: queryValue(url, "board") ?? "",
    };
}
