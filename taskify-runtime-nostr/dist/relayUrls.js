export function normalizeRelayUrls(relays) {
    const set = new Set();
    for (const relay of relays) {
        const raw = typeof relay === "string" ? relay.trim() : "";
        if (!raw)
            continue;
        try {
            const url = new URL(raw);
            if ((url.protocol !== "wss:" && url.protocol !== "ws:") || url.username || url.password) {
                continue;
            }
            url.hash = "";
            let normalized = url.toString();
            if (url.pathname === "/")
                normalized = normalized.replace(/\/(?=[?#]|$)/, "");
            set.add(normalized);
        }
        catch {
            // Invalid relay URLs are not useful to callers and should not reach NDK.
        }
    }
    return Array.from(set).sort();
}
