export function parseTaskLocation(raw) {
    const value = raw.trim();
    if (!value)
        return null;
    const separator = value.indexOf("/");
    if (separator < 0)
        return { boardRef: value };
    const boardRef = value.slice(0, separator).trim();
    const listRef = value.slice(separator + 1).trim();
    if (!boardRef || !listRef)
        return null;
    return { boardRef, listRef };
}
function matchesReference(value, reference) {
    const ref = reference.trim();
    return value.id === ref || value.name.toLocaleLowerCase() === ref.toLocaleLowerCase();
}
function boardCandidates(boards) {
    return boards.map((board) => ({ id: board.id, name: board.name, path: board.name }));
}
function listCandidates(board) {
    return (board.lists ?? []).map((list) => ({
        id: list.id,
        name: list.name,
        path: `${board.name}/${list.name}`,
    }));
}
function error(code, message, candidates = []) {
    return { ok: false, code, message, candidates };
}
function resolveBoard(boards, reference) {
    const matches = boards.filter((board) => matchesReference(board, reference));
    if (matches.length === 1)
        return matches[0];
    if (matches.length > 1) {
        return error("AMBIGUOUS_BOARD", `Board reference is ambiguous: "${reference}".`, boardCandidates(matches));
    }
    return error("BOARD_NOT_FOUND", `Board not found: "${reference}".`, boardCandidates(boards));
}
function resolveOnBoard(board, listRef, source) {
    if (board.kind === "compound") {
        return error("READ_ONLY_BOARD", `Compound board "${board.name}" is an aggregate and cannot receive tasks.`);
    }
    const lists = board.lists ?? [];
    if (board.kind !== "lists" && !listRef) {
        return {
            ok: true,
            location: { boardId: board.id, boardName: board.name },
            source,
        };
    }
    if (!listRef && lists.length === 0) {
        return error("LIST_NOT_FOUND", `Board "${board.name}" has no lists.`, []);
    }
    if (!listRef && lists.length === 1) {
        return {
            ok: true,
            location: {
                boardId: board.id,
                boardName: board.name,
                listId: lists[0].id,
                listName: lists[0].name,
            },
            source,
        };
    }
    if (!listRef) {
        return error("AMBIGUOUS_LIST", `Board "${board.name}" has multiple lists; specify Board/List.`, listCandidates(board));
    }
    const matches = lists.filter((list) => matchesReference(list, listRef));
    if (matches.length === 0) {
        return error("LIST_NOT_FOUND", `List not found: "${listRef}" on board "${board.name}".`, listCandidates(board));
    }
    if (matches.length > 1) {
        return error("AMBIGUOUS_LIST", `List reference is ambiguous: "${listRef}" on board "${board.name}".`, listCandidates(board));
    }
    return {
        ok: true,
        location: {
            boardId: board.id,
            boardName: board.name,
            listId: matches[0].id,
            listName: matches[0].name,
        },
        source,
    };
}
export function resolveTaskLocation(options) {
    const visibleBoards = options.boards.filter((board) => !board.archived && !board.hidden);
    const explicit = options.location
        ? parseTaskLocation(options.location)
        : options.boardRef
            ? { boardRef: options.boardRef, listRef: options.listRef }
            : null;
    if (options.location && !explicit) {
        return error("INVALID_LOCATION", `Invalid location "${options.location}". Expected Board or Board/List.`, boardCandidates(visibleBoards));
    }
    const intent = options.intent ?? "write";
    if (explicit) {
        const board = resolveBoard(visibleBoards, explicit.boardRef);
        if ("ok" in board)
            return board;
        if (intent === "read" && !explicit.listRef) {
            return {
                ok: true,
                location: { boardId: board.id, boardName: board.name },
                source: "explicit",
            };
        }
        return resolveOnBoard(board, explicit.listRef, "explicit");
    }
    if (options.defaultLocation) {
        const board = resolveBoard(visibleBoards, options.defaultLocation.boardId);
        if ("ok" in board)
            return board;
        if (intent === "read" && !options.defaultLocation.listId) {
            return {
                ok: true,
                location: { boardId: board.id, boardName: board.name },
                source: "default",
            };
        }
        return resolveOnBoard(board, options.defaultLocation.listId, "default");
    }
    const candidates = intent === "write"
        ? visibleBoards.filter((board) => board.kind !== "compound")
        : visibleBoards;
    if (candidates.length === 0) {
        return error("BOARD_NOT_FOUND", `No ${intent === "write" ? "writable " : ""}boards are configured.`, []);
    }
    if (candidates.length > 1) {
        return error("AMBIGUOUS_BOARD", `Multiple ${intent === "write" ? "writable " : ""}boards are configured; specify Board/List or set a default.`, boardCandidates(candidates));
    }
    if (intent === "read") {
        return {
            ok: true,
            location: { boardId: candidates[0].id, boardName: candidates[0].name },
            source: "sole-writable-board",
        };
    }
    return resolveOnBoard(candidates[0], undefined, "sole-writable-board");
}
