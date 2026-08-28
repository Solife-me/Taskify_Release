export type TaskifyLocationList = {
    id: string;
    name: string;
};
export type TaskifyLocationBoard = {
    id: string;
    name: string;
    kind?: "week" | "lists" | "compound" | "bible";
    lists?: TaskifyLocationList[];
    archived?: boolean;
    hidden?: boolean;
};
export type TaskifyDefaultLocation = {
    boardId: string;
    listId?: string;
};
export type ResolvedTaskLocation = {
    boardId: string;
    boardName: string;
    listId?: string;
    listName?: string;
};
export type TaskLocationErrorCode = "INVALID_LOCATION" | "BOARD_NOT_FOUND" | "AMBIGUOUS_BOARD" | "READ_ONLY_BOARD" | "LIST_NOT_FOUND" | "AMBIGUOUS_LIST";
export type TaskLocationCandidate = {
    id: string;
    name: string;
    path: string;
};
export type TaskLocationResolution = {
    ok: true;
    location: ResolvedTaskLocation;
    source: "explicit" | "default" | "sole-writable-board";
} | {
    ok: false;
    code: TaskLocationErrorCode;
    message: string;
    candidates: TaskLocationCandidate[];
};
export declare function parseTaskLocation(raw: string): {
    boardRef: string;
    listRef?: string;
} | null;
export declare function resolveTaskLocation(options: {
    boards: TaskifyLocationBoard[];
    location?: string;
    boardRef?: string;
    listRef?: string;
    defaultLocation?: TaskifyDefaultLocation;
    intent?: "read" | "write";
}): TaskLocationResolution;
