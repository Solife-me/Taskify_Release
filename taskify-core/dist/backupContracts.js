function normalizeColumns(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.filter((column) => !!column && typeof column.id === "string" && typeof column.name === "string").map((column) => ({ id: column.id, name: column.name }));
}
function normalizeChildren(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.filter((child) => typeof child === "string" && !!child.trim());
}
function normalizeOrder(raw) {
    return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}
export function sanitizeSettingsForNostrBackup(raw, defaultPushPreferences) {
    const clone = { ...raw };
    delete clone.backgroundImage;
    delete clone.backgroundAccent;
    delete clone.backgroundAccents;
    delete clone.backgroundAccentIndex;
    delete clone.accent;
    if (clone.pushNotifications && typeof clone.pushNotifications === "object") {
        const pushNotifications = { ...clone.pushNotifications };
        delete pushNotifications.deviceId;
        delete pushNotifications.subscriptionId;
        clone.pushNotifications = { ...defaultPushPreferences, ...pushNotifications };
    }
    return clone;
}
export function buildNostrBackupSnapshot(options) {
    const { boards, settings, includeMetadata, defaultRelays, fallbackRelays, normalizeRelayList, sanitizeSettingsForBackup, walletSeed } = options;
    const relayFallback = defaultRelays.length ? defaultRelays : fallbackRelays;
    const defaultRelayList = includeMetadata ? normalizeRelayList(relayFallback) : [];
    const boardsPayload = includeMetadata
        ? boards.filter((board) => !!board.nostr?.boardId).map((board, index) => {
            const nostrId = board.nostr?.boardId?.trim();
            if (!nostrId)
                return null;
            const relays = normalizeRelayList(board.nostr?.relays?.length ? board.nostr.relays : relayFallback);
            return {
                id: board.id, nostrId, relays, name: board.name, kind: board.kind, archived: !!board.archived, hidden: !!board.hidden, order: normalizeOrder(board.order) ?? index,
                columns: board.kind === "lists" ? (board.columns ?? []).map((column) => ({ id: column.id, name: column.name })) : undefined,
                children: board.kind === "compound" ? (board.children ?? []).slice() : undefined,
                clearCompletedDisabled: !!board.clearCompletedDisabled,
                indexCardEnabled: board.kind === "lists" || board.kind === "compound" ? !!board.indexCardEnabled : undefined,
                hideChildBoardNames: board.kind === "compound" ? !!board.hideChildBoardNames : undefined,
            };
        }).filter((board) => !!board).sort((a, b) => (normalizeOrder(a.order) ?? 0) - (normalizeOrder(b.order) ?? 0) || a.id.localeCompare(b.id))
        : [];
    const settingsPayload = includeMetadata ? sanitizeSettingsForBackup(settings) : {};
    return { boards: boardsPayload, settings: settingsPayload, walletSeed, defaultRelays: defaultRelayList };
}
export function mergeBackupBoards(options) {
    const { currentBoards, incomingBoards, baseRelays, normalizeRelayList, createId } = options;
    let next = currentBoards.slice();
    let changed = false;
    let hasIncomingOrder = false;
    const normalizeForBoard = (relays) => {
        const normalized = normalizeRelayList(relays);
        return normalized.length ? normalized : baseRelays;
    };
    incomingBoards.forEach((entry) => {
        if (!entry || typeof entry !== "object")
            return;
        const incomingOrder = normalizeOrder(entry.order);
        if (incomingOrder !== undefined)
            hasIncomingOrder = true;
        const entryId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
        const nostrIdRaw = entry.nostrId || entry?.nostr?.boardId;
        const nostrId = typeof nostrIdRaw === "string" && nostrIdRaw.trim() ? nostrIdRaw.trim() : undefined;
        if (!nostrId)
            return;
        const relays = normalizeForBoard(entry.relays);
        const existingIndex = next.findIndex((board) => (board.nostr?.boardId && board.nostr.boardId === nostrId) || board.id === entryId);
        const currentRelays = normalizeRelayList(existingIndex >= 0 ? next[existingIndex].nostr?.relays : []);
        if (existingIndex >= 0) {
            const existing = next[existingIndex];
            const relaysChanged = relays.join("|") !== currentRelays.join("|");
            const patched = { ...existing, id: existing.id || entryId || nostrId || existing.nostr?.boardId || existing.id, nostr: { boardId: existing.nostr?.boardId || nostrId, relays } };
            if (incomingOrder !== undefined)
                patched.order = incomingOrder;
            if (typeof entry.archived === "boolean")
                patched.archived = entry.archived;
            if (typeof entry.hidden === "boolean")
                patched.hidden = entry.hidden;
            const name = typeof entry.name === "string" ? entry.name.trim() : "";
            if (name && existing.name === "Shared Board")
                patched.name = name;
            if (Array.isArray(entry.columns) && patched.kind === "lists") {
                const columns = normalizeColumns(entry.columns);
                if (columns.length)
                    patched.columns = columns;
            }
            if (Array.isArray(entry.children) && patched.kind === "compound")
                patched.children = normalizeChildren(entry.children);
            if (typeof entry.clearCompletedDisabled === "boolean")
                patched.clearCompletedDisabled = !!entry.clearCompletedDisabled;
            if (typeof entry.indexCardEnabled === "boolean" && (patched.kind === "lists" || patched.kind === "compound"))
                patched.indexCardEnabled = !!entry.indexCardEnabled;
            if (typeof entry.hideChildBoardNames === "boolean" && patched.kind === "compound")
                patched.hideChildBoardNames = !!entry.hideChildBoardNames;
            if (!existing.nostr || relaysChanged || patched.name !== existing.name || patched.archived !== existing.archived || patched.hidden !== existing.hidden || patched.order !== existing.order) {
                next[existingIndex] = patched;
                changed = true;
            }
            return;
        }
        const kindRaw = entry.kind;
        const kind = (kindRaw === "week" || kindRaw === "compound" || kindRaw === "bible" ? kindRaw : "lists");
        const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "Shared Board";
        const boardId = entryId || nostrId || createId();
        const orderPatch = incomingOrder !== undefined ? { order: incomingOrder } : {};
        const base = kind === "week" ? { id: boardId, name, kind: "week", nostr: { boardId: nostrId, relays }, archived: !!entry.archived, hidden: !!entry.hidden, clearCompletedDisabled: !!entry.clearCompletedDisabled, ...orderPatch }
            : kind === "compound" ? { id: boardId, name, kind: "compound", children: normalizeChildren(entry.children), nostr: { boardId: nostrId, relays }, archived: !!entry.archived, hidden: !!entry.hidden, clearCompletedDisabled: !!entry.clearCompletedDisabled, indexCardEnabled: typeof entry.indexCardEnabled === "boolean" ? !!entry.indexCardEnabled : false, hideChildBoardNames: typeof entry.hideChildBoardNames === "boolean" ? !!entry.hideChildBoardNames : false, ...orderPatch }
                : { id: boardId, name, kind: "lists", columns: (() => { const columns = normalizeColumns(entry.columns); return columns.length ? columns : [{ id: createId(), name: "Items" }]; })(), nostr: { boardId: nostrId, relays }, archived: !!entry.archived, hidden: !!entry.hidden, clearCompletedDisabled: !!entry.clearCompletedDisabled, indexCardEnabled: typeof entry.indexCardEnabled === "boolean" ? !!entry.indexCardEnabled : false, ...orderPatch };
        next = [...next, base];
        changed = true;
    });
    if (hasIncomingOrder) {
        const currentIndex = new Map(next.map((board, index) => [board.id, index]));
        const sorted = next.slice().sort((left, right) => {
            const leftOrder = normalizeOrder(left.order) ?? currentIndex.get(left.id) ?? 0;
            const rightOrder = normalizeOrder(right.order) ?? currentIndex.get(right.id) ?? 0;
            return leftOrder - rightOrder || (currentIndex.get(left.id) ?? 0) - (currentIndex.get(right.id) ?? 0);
        });
        if (sorted.some((board, index) => board !== next[index])) {
            next = sorted;
            changed = true;
        }
    }
    return changed ? next : currentBoards;
}
