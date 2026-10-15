export declare const TASKIFY_LINK_SCHEME = "taskify";
export type TaskifyLink = {
    kind: "upcoming";
} | {
    kind: "boards";
} | {
    kind: "task";
    id: string;
    boardId: string;
} | {
    kind: "event";
    id: string;
    boardId: string;
} | {
    kind: "quick-add";
    boardId?: string;
    columnId?: string;
};
/** Formats the custom-scheme URL used by Taskify widgets and native app entry points. */
export declare function formatTaskifyAppLink(link: TaskifyLink): string;
/** Parses the custom-scheme URL used by every Taskify client. */
export declare function parseTaskifyAppLink(raw: string | URL): TaskifyLink | null;
/**
 * Formats the equivalent path for the PWA and future Universal Links. Entity links are top-level
 * because their optional board is context, not identity; a client can still locate an item when
 * the sender does not know its board.
 */
export declare function formatTaskifyWebPath(link: TaskifyLink): string;
/** Parses a Taskify web path. The origin is deliberately irrelevant so local and hosted PWAs agree. */
export declare function parseTaskifyWebPath(raw: string | URL): TaskifyLink | null;
